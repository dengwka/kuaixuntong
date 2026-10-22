const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');
const historyManager = require('./history');

class XFetcher {
  constructor(configManager, translator, financialAi = null) {
    this.configManager = configManager;
    this.translator = translator;
    this.financialAi = financialAi;
    this.coolingMap = new Map(); // screen_name -> { untilMs, backoffSec }
    this.lastPolledMap = new Map(); // screen_name -> timestamp
    this.isPolling = false;
  }

  setFinancialAi(ai) {
    this.financialAi = ai;
  }

  getProxyConfig() {
    const cfg = this.configManager ? this.configManager.config : {};
    const xCfg = (cfg.sources && cfg.sources.x_twitter) || {};
    let proxy = (xCfg.proxy || '').trim();
    if (!proxy) {
      proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:7892';
    }
    return proxy;
  }

  async makeRequest(targetUrl, options = {}) {
    const proxyUrl = this.getProxyConfig();
    const urlObj = new URL(targetUrl);

    return new Promise((resolve, reject) => {
      let parsedProxy = null;
      if (proxyUrl && proxyUrl.startsWith('http')) {
        try {
          parsedProxy = new URL(proxyUrl);
        } catch (e) {}
      }

      const timer = setTimeout(() => {
        reject(new Error('Request timeout (10s)'));
      }, 10000);

      const requestHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...(options.headers || {})
      };

      const cfg = this.configManager ? this.configManager.config : {};
      const xCfg = (cfg.sources && cfg.sources.x_twitter) || {};
      const userCookie = (xCfg.cookie || '').trim();
      if (userCookie && !requestHeaders['Cookie']) {
        requestHeaders['Cookie'] = userCookie.includes('=') ? userCookie : `auth_token=${userCookie}`;
      }

      const onResponse = (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          clearTimeout(timer);
          resolve({
            statusCode: resp.statusCode,
            headers: resp.headers,
            body
          });
        });
      };

      const reqOptions = {
        headers: requestHeaders,
        method: options.method || 'GET'
      };

      if (parsedProxy) {
        const req = http.request({
          host: parsedProxy.hostname,
          port: parsedProxy.port || 80,
          method: 'CONNECT',
          path: `${urlObj.hostname}:${urlObj.port || 443}`
        });

        req.on('connect', (res, socket) => {
          const agent = new https.Agent({ socket });
          const httpsReq = https.request(targetUrl, { ...reqOptions, agent }, onResponse);
          httpsReq.on('error', (err) => { clearTimeout(timer); reject(err); });
          if (options.body) httpsReq.write(options.body);
          httpsReq.end();
        });

        req.on('error', (err) => {
          clearTimeout(timer);
          // 若代理 CONNECT 失败，尝试直接请求
          const directReq = https.request(targetUrl, reqOptions, onResponse);
          directReq.on('error', (directErr) => reject(directErr));
          if (options.body) directReq.write(options.body);
          directReq.end();
        });
        req.end();
      } else {
        const httpsReq = https.request(targetUrl, reqOptions, onResponse);
        httpsReq.on('error', (err) => { clearTimeout(timer); reject(err); });
        if (options.body) httpsReq.write(options.body);
        httpsReq.end();
      }
    });
  }

  cleanScreenName(rawInput) {
    if (!rawInput) return '';
    let clean = String(rawInput).trim();
    clean = clean.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, '');
    clean = clean.replace(/^@+/, '');
    clean = clean.split(/[?#/]/)[0].trim();
    return clean;
  }

  cleanTweetText(rawText) {
    if (!rawText) return '';
    // 去除末尾携带的图片/视频等 t.co 外链
    return rawText.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').trim();
  }

  /**
   * 解析 x.com 官方主页 SSR 注入的实时推文流
   */
  parseTweetsFromXProfileHtml(html) {
    const tweets = [];
    if (!html) return tweets;

    // 引擎 1：提取由 React SSR 流注入的所有 JSON 数据包 (value:"{\"data\":...}")
    const valuePrefix = 'value:"';
    let searchIdx = 0;

    while ((searchIdx = html.indexOf(valuePrefix, searchIdx)) !== -1) {
      const contentStart = searchIdx + valuePrefix.length;
      let end = contentStart;
      while (end < html.length) {
        if (html[end] === '"' && html[end - 1] !== '\\') {
          break;
        }
        end++;
      }

      const rawVal = html.substring(contentStart, end);
      searchIdx = end + 1;

      try {
        const unescaped = JSON.parse('"' + rawVal + '"');
        const payload = JSON.parse(unescaped);
        this.extractTweetsRecursive(payload, tweets);
      } catch (e) {
        // 忽略非 JSON 数据包
      }
    }

    // 引擎 2：正则兜底提取推文条目
    if (tweets.length === 0) {
      const entryRegex = /"rest_id":"(\d+)"[\s\S]*?"created_at_ms":(\d+)[\s\S]*?"full_text":"([^"]+)"/g;
      let m;
      while ((m = entryRegex.exec(html)) !== null) {
        const tweetId = m[1];
        const createdMs = parseInt(m[2], 10);
        let text = m[3];
        try { text = JSON.parse('"' + text + '"'); } catch (e) {}

        const windowStr = html.substring(m.index, m.index + 2500);
        const pics = [];
        const mediaRegex = /"media_url_https":"(https:[^"]+)"/g;
        let mm;
        while ((mm = mediaRegex.exec(windowStr)) !== null) {
          if (!pics.includes(mm[1])) pics.push(mm[1]);
        }

        tweets.push({
          id_str: tweetId,
          text: this.cleanTweetText(text),
          raw_text: text,
          created_at_ms: createdMs,
          created_at: new Date(createdMs).toISOString(),
          pics: pics.slice(0, 4),
          is_reply: false,
          is_retweet: false
        });
      }
    }

    // 去重与排序
    const seen = new Set();
    const deduped = [];
    for (const t of tweets) {
      if (!t.id_str || seen.has(t.id_str)) continue;
      seen.add(t.id_str);
      deduped.push(t);
    }

    deduped.sort((a, b) => (b.created_at_ms || 0) - (a.created_at_ms || 0));
    return deduped;
  }

  extractTweetsRecursive(obj, results, visited = new Set()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);

    if (obj.rest_id && obj.details && obj.details.full_text) {
      const pics = [];
      if (Array.isArray(obj.media_entities2)) {
        for (const m of obj.media_entities2) {
          if (m && m.media_url_https && !pics.includes(m.media_url_https)) {
            pics.push(m.media_url_https);
          }
        }
      }
      const userRes = obj.core?.user_results?.result;
      const authorName = userRes?.core?.name || '';
      const authorHandle = userRes?.core?.screen_name || '';
      let authorAvatar = userRes?.avatar?.image_url || '';
      if (authorAvatar) authorAvatar = authorAvatar.replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1');

      const isReply = !!(obj.legacy && (obj.legacy.in_reply_to_status_id_str || obj.legacy.in_reply_to_screen_name));
      const isRetweet = !!(obj.legacy && (obj.legacy.retweeted_status_result || obj.retweeted_status));

      const raw = obj.details.full_text;
      results.push({
        id_str: obj.rest_id,
        text: this.cleanTweetText(raw),
        raw_text: raw,
        created_at_ms: obj.details.created_at_ms || Date.now(),
        created_at: obj.details.created_at_ms ? new Date(obj.details.created_at_ms).toISOString() : new Date().toISOString(),
        pics: pics.slice(0, 4),
        author_name: authorName,
        author_handle: authorHandle,
        author_avatar: authorAvatar,
        is_reply: isReply,
        is_retweet: isRetweet
      });
    }

    // 兼容可能存在的 legacy 结构
    if (obj.id_str && obj.full_text && !obj.details) {
      const pics = [];
      if (Array.isArray(obj.entities?.media)) {
        for (const m of obj.entities.media) {
          if (m.media_url_https && !pics.includes(m.media_url_https)) pics.push(m.media_url_https);
        }
      }
      results.push({
        id_str: obj.id_str,
        text: this.cleanTweetText(obj.full_text),
        raw_text: obj.full_text,
        created_at_ms: obj.created_at ? new Date(obj.created_at).getTime() : Date.now(),
        created_at: obj.created_at || new Date().toISOString(),
        pics: pics.slice(0, 4),
        author_name: obj.user?.name || '',
        author_handle: obj.user?.screen_name || '',
        author_avatar: (obj.user?.profile_image_url_https || '').replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1'),
        is_reply: !!(obj.in_reply_to_status_id_str || obj.in_reply_to_screen_name),
        is_retweet: !!obj.retweeted_status
      });
    }

    for (const k of Object.keys(obj)) {
      this.extractTweetsRecursive(obj[k], results, visited);
    }
  }

  /**
   * 从主页 HTML 解析博主基础资料
   */
  extractProfileFromXHtml(html, screenName) {
    const profile = {
      screen_name: screenName,
      name: screenName,
      avatar: '',
      bio: '',
      followers_count: 0
    };

    if (!html) return profile;

    // 1. Meta 标签优先提取
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (ogTitleMatch) {
      const rawTitle = ogTitleMatch[1];
      const m = rawTitle.match(/^(.+?)\s*\(@([^)]+)\)/);
      if (m) {
        profile.name = m[1].trim();
        profile.screen_name = m[2].trim();
      }
    }
    const ogDescMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
    if (ogDescMatch) {
      profile.bio = ogDescMatch[1].trim();
    }
    const ogImgMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (ogImgMatch) {
      profile.avatar = ogImgMatch[1].replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1');
    }

    // 2. 扫描 JSON payload
    const valuePrefix = 'value:"';
    let searchIdx = 0;
    while ((searchIdx = html.indexOf(valuePrefix, searchIdx)) !== -1) {
      const contentStart = searchIdx + valuePrefix.length;
      let end = contentStart;
      while (end < html.length) {
        if (html[end] === '"' && html[end - 1] !== '\\') break;
        end++;
      }
      const rawVal = html.substring(contentStart, end);
      searchIdx = end + 1;

      try {
        const unescaped = JSON.parse('"' + rawVal + '"');
        const payload = JSON.parse(unescaped);
        this.findUserInObject(payload, profile, screenName);
      } catch (e) {}
    }

    return profile;
  }

  findUserInObject(obj, profile, screenName, visited = new Set()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);

    if (obj.__typename === 'User' && obj.core && obj.core.screen_name) {
      if (screenName && obj.core.screen_name.toLowerCase() === screenName.toLowerCase()) {
        profile.name = obj.core.name || obj.core.screen_name;
        profile.screen_name = obj.core.screen_name;
        if (obj.avatar?.image_url) {
          profile.avatar = obj.avatar.image_url.replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1');
        }
        if (obj.profile_bio?.description) {
          profile.bio = obj.profile_bio.description;
        }
        if (obj.relationship_counts?.followers !== undefined) {
          profile.followers_count = obj.relationship_counts.followers;
        }
        return;
      }
    }

    for (const k of Object.keys(obj)) {
      this.findUserInObject(obj[k], profile, screenName, visited);
    }
  }

  parseNextData(html) {
    if (!html) return null;
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      return null;
    }
  }

  /**
   * 统一双引擎时间线拉取器：
   * 引擎 1: 官方 x.com/${screenName} SSR 直连 (支持所有人包括小号/普通账号/新号)
   * 引擎 2: 官方 Syndication 管道兜底 (适用于特朗普/马斯克等超级大号)
   */
  async fetchAccountTimeline(screenName, account = {}) {
    const cleanName = this.cleanScreenName(screenName);
    if (!cleanName) return { success: false, tweets: [] };

    // 1. 尝试引擎 1: x.com 直连
    try {
      const resp = await this.makeRequest(`https://x.com/${cleanName}`);
      if (resp.statusCode === 200) {
        const tweets = this.parseTweetsFromXProfileHtml(resp.body);
        if (tweets.length > 0) {
          return { success: true, engine: 'x_direct', tweets };
        }
      } else if (resp.statusCode === 429) {
        return { success: false, statusCode: 429, msg: 'X 平台主页临时频控' };
      }
    } catch (e) {
      logger.warn(`[XFetcher] x.com 直连拉取 @${cleanName} 受阻:`, e.message);
    }

    // 2. 尝试引擎 2: Syndication 管道兜底
    try {
      const synUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${cleanName}`;
      const synResp = await this.makeRequest(synUrl);
      if (synResp.statusCode === 200) {
        const nextData = this.parseNextData(synResp.body);
        const entries = nextData?.props?.pageProps?.timeline?.entries || [];
        const tweets = [];
        for (const entry of entries) {
          const tweet = entry?.content?.tweet;
          if (!tweet || !tweet.id_str || !tweet.text) continue;

          const pics = [];
          if (Array.isArray(tweet.entities?.media)) {
            for (const m of tweet.entities.media) {
              if (m.media_url_https && !pics.includes(m.media_url_https)) pics.push(m.media_url_https);
            }
          }
          if (Array.isArray(tweet.photos)) {
            for (const p of tweet.photos) {
              if (p.url && !pics.includes(p.url)) pics.push(p.url);
            }
          }
          let avatar = tweet.user?.profile_image_url_https || account.avatar || '';
          avatar = avatar.replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1');

          tweets.push({
            id_str: tweet.id_str,
            text: this.cleanTweetText(tweet.text),
            raw_text: tweet.text,
            created_at_ms: tweet.created_at ? new Date(tweet.created_at).getTime() : Date.now(),
            created_at: tweet.created_at || new Date().toISOString(),
            pics: pics.slice(0, 4),
            author_name: tweet.user?.name || account.name || cleanName,
            author_handle: tweet.user?.screen_name || cleanName,
            author_avatar: avatar,
            is_reply: !!(tweet.in_reply_to_status_id_str || tweet.in_reply_to_screen_name),
            is_retweet: !!tweet.retweeted_status
          });
        }

        if (tweets.length > 0) {
          return { success: true, engine: 'syndication', tweets };
        }
      } else if (synResp.statusCode === 429) {
        return { success: false, statusCode: 429, msg: 'X 平台 Syndication 临时频控' };
      }
    } catch (e) {
      logger.warn(`[XFetcher] Syndication 拉取 @${cleanName} 受阻:`, e.message);
    }

    return { success: false, tweets: [] };
  }

  /**
   * 账号预检与档案解析 (用于设置页面搜索验证)
   */
  async lookupAccount(rawInput) {
    const screenName = this.cleanScreenName(rawInput);
    if (!screenName) {
      return { success: false, msg: '请输入有效的 X 用户名 (如 elonmusk)' };
    }

    logger.info(`[XFetcher] 正在解析 X 博主档案: @${screenName}...`);

    let profile = null;

    // 1. 优先调用 FxTwitter 官方档案专属接口 (100% 精准匹配目标博主，绝不混淆转推)
    try {
      const fxUrl = `https://api.fxtwitter.com/${screenName}`;
      const fxResp = await this.makeRequest(fxUrl);
      if (fxResp.statusCode === 200) {
        const parsed = JSON.parse(fxResp.body);
        if (parsed && parsed.code === 200 && parsed.user) {
          const u = parsed.user;
          let avatar = (u.avatar_url || '').replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1');
          profile = {
            id: u.screen_name.toLowerCase(),
            screen_name: u.screen_name,
            name: u.name || u.screen_name,
            avatar: avatar,
            bio: u.description || '',
            followers_count: u.followers || 0
          };
        }
      } else if (fxResp.statusCode === 404) {
        return { success: false, msg: `未找到账号 @${screenName}，可能已被封禁或不存在` };
      }
    } catch (errFx) {
      logger.warn(`[XFetcher] FxTwitter 档案解析通道受阻，切换至 x.com 主页解析:`, errFx.message);
    }

    // 2. 备用通道：从 x.com 主页精确提取目标用户档案
    if (!profile) {
      try {
        const resp = await this.makeRequest(`https://x.com/${screenName}`);
        if (resp.statusCode === 200) {
          const p = this.extractProfileFromXHtml(resp.body, screenName);
          profile = {
            id: p.screen_name.toLowerCase(),
            screen_name: p.screen_name,
            name: p.name || p.screen_name,
            avatar: p.avatar,
            bio: p.bio,
            followers_count: p.followers_count
          };
        } else if (resp.statusCode === 404) {
          return { success: false, msg: `未找到账号 @${screenName}，可能已被封禁或不存在` };
        }
      } catch (errX) {
        logger.warn(`[XFetcher] x.com 主页解析通道受阻:`, errX.message);
      }
    }

    // 3. 兜底通道：Syndication 官方管道
    if (!profile) {
      try {
        const targetUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${screenName}`;
        const resp = await this.makeRequest(targetUrl);
        if (resp.statusCode === 200) {
          const nextData = this.parseNextData(resp.body);
          const entries = nextData?.props?.pageProps?.timeline?.entries || [];
          if (entries.length > 0) {
            const firstTweet = entries[0]?.content?.tweet;
            const user = firstTweet?.user;
            if (user && user.screen_name && user.screen_name.toLowerCase() === screenName.toLowerCase()) {
              let avatar = (user.profile_image_url_https || '').replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1');
              profile = {
                id: user.screen_name.toLowerCase(),
                screen_name: user.screen_name,
                name: user.name || user.screen_name,
                avatar: avatar,
                bio: user.description || '',
                followers_count: user.followers_count || 0
              };
            }
          }
        }
      } catch (e) {}
    }

    if (!profile) {
      return { success: false, msg: `网络连接异常或未找到账号 @${screenName}` };
    }

    // 4. 异步并发拉取该博主真实时间线的第一条推文与配图
    let latestTweetText = profile.bio ? `个人简介: ${profile.bio}` : '已成功接入该博主实时推文监控';
    let latestTweetId = '';
    let latestTweetTime = '';
    let pics = [];

    try {
      const res = await this.fetchAccountTimeline(screenName);
      if (res.success && res.tweets.length > 0) {
        const t = res.tweets[0];
        latestTweetText = t.text;
        latestTweetId = t.id_str;
        latestTweetTime = t.created_at;
        pics = t.pics || [];
      }
    } catch (e) {}

    return {
      success: true,
      account: {
        ...profile,
        latest_tweet: latestTweetText,
        latest_tweet_id: latestTweetId,
        latest_tweet_time: latestTweetTime,
        pics: pics
      }
    };
  }

  /**
   * 获取指定账号的最新一篇推文 (点击设置中“测试”按钮时调用)
   */
  async fetchLatestTweetForAccount(account) {
    if (!account) return null;
    const screenName = this.cleanScreenName(account.screen_name || account.id);
    if (!screenName) return null;

    logger.info(`[XFetcher] 正在拉取 @${screenName} 最新推文...`);

    // 1. 调用双引擎时间线拉取真实最新推文
    const res = await this.fetchAccountTimeline(screenName, account);
    if (res.success && res.tweets.length > 0) {
      const tweet = res.tweets[0];
      return {
        id: tweet.id_str,
        text: tweet.text,
        created_at: tweet.created_at,
        author_name: tweet.author_name || account.name || screenName,
        author_handle: tweet.author_handle || screenName,
        author_avatar: tweet.author_avatar || account.avatar || '',
        pics: tweet.pics || [],
        url: `https://x.com/${screenName}/status/${tweet.id_str}`
      };
    }

    // 2. 若当前未发推，回退为账号基本资料展示
    let fallbackText = (account.latest_tweet || '').trim();
    if (!fallbackText) {
      fallbackText = `已成功接入 @${screenName} 实时推文监控，持续监听该博主最新发布。`;
    }

    return {
      id: `fallback_${Date.now()}`,
      text: fallbackText,
      created_at: new Date().toISOString(),
      author_name: account.name || screenName,
      author_handle: screenName,
      author_avatar: account.avatar || '',
      pics: Array.isArray(account.pics) ? account.pics.slice(0, 4) : [],
      url: `https://x.com/${screenName}`
    };
  }

  getAccountCoolingStatus(screenName) {
    const key = screenName.toLowerCase();
    const info = this.coolingMap.get(key);
    if (!info) return { isCooling: false, remainingSec: 0 };
    const now = Date.now();
    if (info.untilMs > now) {
      return {
        isCooling: true,
        remainingSec: Math.ceil((info.untilMs - now) / 1000)
      };
    }
    this.coolingMap.delete(key);
    return { isCooling: false, remainingSec: 0 };
  }

  clearAccountCooling(screenName = null) {
    if (screenName) {
      const key = screenName.toLowerCase();
      this.coolingMap.delete(key);
      this.lastPolledMap.delete(key);
      logger.info(`[XFetcher] 已手动清除 @${screenName} 的频控冷却状态，恢复即时监听`);
    } else {
      this.coolingMap.clear();
      this.lastPolledMap.clear();
      logger.info(`[XFetcher] 已手动清除全部 X 账号的频控冷却状态`);
    }
  }

  /**
   * 轮询所有已订阅账号
   */
  async fetch() {
    if (this.isPolling) return [];
    this.isPolling = true;

    const cfg = this.configManager ? this.configManager.config : {};
    const xCfg = (cfg.sources && cfg.sources.x_twitter) || {};
    if (!xCfg.enabled) {
      this.isPolling = false;
      return [];
    }

    const accounts = Array.isArray(xCfg.accounts) ? xCfg.accounts : [];
    const enabledAccounts = accounts.filter(a => a && a.enabled !== false && a.screen_name);
    if (enabledAccounts.length === 0) {
      this.isPolling = false;
      return [];
    }

    const newAlerts = [];
    let configUpdated = false;

    try {
      const now = Date.now();
      for (let i = 0; i < enabledAccounts.length; i++) {
        const account = enabledAccounts[i];
        const screenName = account.screen_name;
        const cooling = this.getAccountCoolingStatus(screenName);

        if (cooling.isCooling) {
          logger.info(`[XFetcher] @${screenName} 处于频控冷却中 (剩余 ${cooling.remainingSec}s)，已隔离跳过`);
          continue;
        }

        // 单账号轮询间隔保护：避免单个博主 15 秒内高频重复发起主页抓取
        const lastPolled = this.lastPolledMap.get(screenName.toLowerCase()) || 0;
        if (now - lastPolled < 15000) {
          continue;
        }

        this.lastPolledMap.set(screenName.toLowerCase(), now);

        try {
          const items = await this.pollSingleAccount(account);
          if (items && items.length > 0) {
            newAlerts.push(...items);
            configUpdated = true;
          }
        } catch (errOne) {
          logger.warn(`[XFetcher] 轮询 @${screenName} 发生异常:`, errOne.message);
        }

        // 多账号之间错开 1.5~2.5 秒
        if (i < enabledAccounts.length - 1) {
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        }
      }

      if (configUpdated && this.configManager) {
        this.configManager.saveConfig(this.configManager.config);
      }
    } finally {
      this.isPolling = false;
    }

    return newAlerts;
  }

  async pollSingleAccount(account) {
    const screenName = account.screen_name;
    const res = await this.fetchAccountTimeline(screenName, account);

    // 1. 处理频控 429
    if (res.statusCode === 429) {
      let resetSec = 60;
      const prev = this.coolingMap.get(screenName.toLowerCase());
      const backoff = prev ? Math.min(prev.backoffSec * 2, 600) : 60;
      resetSec = backoff;

      this.coolingMap.set(screenName.toLowerCase(), {
        untilMs: Date.now() + resetSec * 1000,
        backoffSec: resetSec
      });
      logger.warn(`[XFetcher] @${screenName} 遭遇 X 平台 429 频控，启动精确退避熔断 (休眠 ${resetSec} 秒)`);
      return [];
    }

    if (!res.success || !res.tweets || res.tweets.length === 0) {
      return [];
    }

    // 恢复健康状态
    if (this.coolingMap.has(screenName.toLowerCase())) {
      this.coolingMap.delete(screenName.toLowerCase());
    }

    // 过滤日常回复 (除非用户显式开启)
    const validTweets = [];
    for (const tweet of res.tweets) {
      if (tweet.is_reply && !account.include_replies) {
        continue;
      }
      validTweets.push(tweet);
    }

    if (validTweets.length === 0) return [];

    // 水位线检查与冷启动策略：
    const latestTweet = validTweets[0];

    let tweetsToProcess = [];

    if (!account.last_seen_id) {
      // 如果是首次监听该账号或未落盘水位线：
      // 检查最新推文发布时间：如果是在最近 2 小时 (120 分钟) 内发布的极新鲜推文（例如用户发推测试或博主突发），立即触发实时播报！
      const ageMs = Date.now() - (latestTweet.created_at_ms || 0);
      const isRecentTestOrBreaking = (ageMs >= 0 && ageMs < 120 * 60 * 1000);

      account.last_seen_id = latestTweet.id_str;
      if (isRecentTestOrBreaking) {
        logger.info(`[XFetcher] @${screenName} 首次加入监控发现 2 小时内极新鲜推文 (${latestTweet.id_str})，启动实时弹窗播报！`);
        tweetsToProcess = [latestTweet];
      } else {
        logger.info(`[XFetcher] @${screenName} 首次加入监控，静默标记历史水位线推文 ID: ${latestTweet.id_str}`);
        return [];
      }
    } else {
      // 正常轮询增量推文
      for (const tweet of validTweets) {
        if (tweet.id_str === account.last_seen_id) {
          break;
        }
        tweetsToProcess.push(tweet);
      }
    }

    if (tweetsToProcess.length === 0) return [];

    const newItems = [];
    for (const tweet of tweetsToProcess) {
      const itemUid = `x_${account.screen_name}_${tweet.id_str}`;
      if (historyManager.isPushed(itemUid)) continue;

      const rawText = tweet.text;
      const pubDate = new Date(tweet.created_at_ms || tweet.created_at || Date.now());
      const timeStr = pubDate.toLocaleTimeString('zh-CN', { hour12: false });
      const pubTimeStr = pubDate.toLocaleString('zh-CN', { hour12: false });

      // 翻译处理
      let translatedText = rawText;
      let isTranslated = false;
      const isChinese = this.translator ? this.translator.isMostlyChinese(rawText) : false;

      if (!isChinese && this.translator) {
        try {
          const transRes = await this.translator.translate(rawText);
          if (transRes && transRes.isTranslated) {
            translatedText = transRes.translatedText;
            isTranslated = true;
          }
        } catch (errTrans) {
          logger.warn(`[XFetcher] 推文翻译失败，回退原文:`, errTrans.message);
        }
      }

      const titlePrefix = tweet.is_retweet ? `𝕏 ${account.name} (转推)` : `𝕏 ${account.name}`;

      // 针对指定开启了 AI 分析的博主（如特朗普），调用 AI/金十宏观研判与利多利空分析
      let aiAnalysis = null;
      if (account.ai_analysis_enabled && this.financialAi) {
        try {
          const textForAi = translatedText || rawText;
          aiAnalysis = await this.financialAi.analyze(textForAi);
        } catch (errAi) {
          logger.warn(`[XFetcher] @${account.screen_name} 推文 AI 研判异常:`, errAi.message);
        }
      }

      const alertItem = {
        id: itemUid,
        source: '𝕏 监控',
        source_key: 'x_twitter',
        source_name: `𝕏 ${account.name}`,
        author_name: account.name,
        author_handle: account.screen_name,
        author_avatar: account.avatar || tweet.author_avatar,
        time: timeStr,
        pub_time: pubTimeStr,
        title: `${titlePrefix} (@${account.screen_name})`,
        content: translatedText,
        original_text: isTranslated ? rawText : null,
        is_translated: isTranslated,
        pics: tweet.pics || [],
        pic: (tweet.pics && tweet.pics.length > 0) ? tweet.pics[0] : null,
        url: `https://x.com/${account.screen_name}/status/${tweet.id_str}`,
        important: true,
        score: 85,
        ai_analysis: aiAnalysis
      };

      newItems.push(alertItem);
    }

    // 更新水位线为最新一条推文 ID
    account.last_seen_id = latestTweet.id_str;
    return newItems;
  }
}

module.exports = XFetcher;
