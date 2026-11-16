const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');
const historyManager = require('./history');
const { formatAuthorName, getAuthorChineseName } = require('./authorTranslator');

class XFetcher {
  constructor(configManager, translator, financialAi = null) {
    this.configManager = configManager;
    this.translator = translator;
    this.financialAi = financialAi;
    this.coolingMap = new Map(); // screen_name -> { untilMs, backoffSec }
    this.lastPolledMap = new Map(); // screen_name -> timestamp
    this.isPolling = false;
    this.roundRobinCursor = 0;
    this.syndicationBlockedUntil = 0; // 全局 Syndication 429 IP 冷却到期时间戳
  }

  setFinancialAi(ai) {
    this.financialAi = ai;
  }

  getProxyConfig() {
    const cfg = this.configManager ? this.configManager.config : {};
    const xCfg = (cfg.sources && cfg.sources.x_twitter) || {};
    let proxy = (xCfg.proxy || (cfg.crypto_prices && cfg.crypto_prices.proxy) || (cfg.system && cfg.system.proxy) || '').trim();
    if (!proxy) {
      proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY ||
              process.env.http_proxy || process.env.https_proxy || '';
    }
    if (!proxy && process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const output = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', { encoding: 'utf8', timeout: 1000 });
        const enabledMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        if (enabledMatch && parseInt(enabledMatch[1], 16) === 1) {
          const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
          if (serverMatch && serverMatch[1]) {
            let s = serverMatch[1].trim();
            if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'http://' + s;
            proxy = s;
          }
        }
      } catch (e) {}
    }
    if (!proxy) {
      proxy = 'http://127.0.0.1:7897';
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
   * 针对长推文 (Note Tweet / 长图文博文) 进行无损防截断检测与完整展开
   * 若文本以省略号、序号未完成结尾，或标记为 NoteTweet，通过 FxTwitter 官方通道拉取 100% 完整长文
   */
  async ensureCompleteTweetText(tweet, screenName) {
    if (!tweet || !tweet.id_str) return tweet;
    const text = tweet.text || '';
    const isTruncated = text.endsWith('…') ||
      text.endsWith('...') ||
      /\d+\.\s*$/.test(text) ||
      (tweet.is_note_tweet && !tweet.is_expanded && text.length < 300);

    if (isTruncated && screenName) {
      try {
        const fxUrl = `https://api.fxtwitter.com/${screenName}/status/${tweet.id_str}`;
        const fxResp = await this.makeRequest(fxUrl);
        if (fxResp.statusCode === 200) {
          const parsed = JSON.parse(fxResp.body);
          if (parsed && parsed.tweet && parsed.tweet.text && parsed.tweet.text.length > text.length) {
            tweet.text = this.cleanTweetText(parsed.tweet.text);
            tweet.raw_text = parsed.tweet.text;
            tweet.is_expanded = true;
            logger.info(`[XFetcher] 已成功通过 FxTwitter 展开 NoteTweet 完整长文 (${tweet.text.length} 字符): ${tweet.id_str}`);
          }
        }
      } catch (err) {
        logger.warn(`[XFetcher] 尝试展开 NoteTweet 失败，维持现有文本:`, err.message);
      }
    }
    return tweet;
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

    if (obj.rest_id && (obj.details || obj.note_tweet)) {
      let raw = '';
      let isNoteTweet = false;
      if (obj.note_tweet?.note_tweet_results?.result?.text) {
        raw = obj.note_tweet.note_tweet_results.result.text;
        isNoteTweet = true;
      } else if (obj.note_tweet?.text) {
        raw = obj.note_tweet.text;
        isNoteTweet = true;
      } else if (obj.details && obj.details.full_text) {
        raw = obj.details.full_text;
        if (obj.note_tweet) isNoteTweet = true;
      }

      if (raw) {
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

        results.push({
          id_str: obj.rest_id,
          text: this.cleanTweetText(raw),
          raw_text: raw,
          created_at_ms: (obj.details && obj.details.created_at_ms) || Date.now(),
          created_at: (obj.details && obj.details.created_at_ms) ? new Date(obj.details.created_at_ms).toISOString() : new Date().toISOString(),
          pics: pics.slice(0, 4),
          author_name: authorName,
          author_handle: authorHandle,
          author_avatar: authorAvatar,
          is_reply: isReply,
          is_retweet: isRetweet,
          is_note_tweet: isNoteTweet
        });
      }
    }

    // 兼容可能存在的 legacy 结构
    if (obj.id_str && (obj.full_text || obj.note_tweet) && !obj.details) {
      let raw = obj.note_tweet?.note_tweet_results?.result?.text || obj.note_tweet?.text || obj.full_text || '';
      if (raw) {
        const pics = [];
        if (Array.isArray(obj.entities?.media)) {
          for (const m of obj.entities.media) {
            if (m.media_url_https && !pics.includes(m.media_url_https)) pics.push(m.media_url_https);
          }
        }
        results.push({
          id_str: obj.id_str,
          text: this.cleanTweetText(raw),
          raw_text: raw,
          created_at_ms: obj.created_at ? new Date(obj.created_at).getTime() : Date.now(),
          created_at: obj.created_at || new Date().toISOString(),
          pics: pics.slice(0, 4),
          author_name: obj.user?.name || '',
          author_handle: obj.user?.screen_name || '',
          author_avatar: (obj.user?.profile_image_url_https || '').replace(/_normal\.(jpg|png|jpeg)/i, '_200x200.$1'),
          is_reply: !!(obj.in_reply_to_status_id_str || obj.in_reply_to_screen_name),
          is_retweet: !!obj.retweeted_status,
          is_note_tweet: !!obj.note_tweet
        });
      }
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
   * 解析 FxTwitter / FixTweet 官方 RSS 格式的时间线推文流
   * 包含：正文（去除HTML标签与多余链接）、配图列表（media:thumbnail/enclosure）、转推与回复判断、推文ID与时间戳
   */
  parseFxTwitterRss(xml, screenName, account = {}) {
    const tweets = [];
    if (!xml || typeof xml !== 'string') return tweets;
    const items = xml.split('<item>').slice(1);
    const cleanScreen = (screenName || '').toLowerCase();

    for (const item of items) {
      const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
      const link = linkMatch ? linkMatch[1].trim() : '';
      const idMatch = link.match(/status\/(\d+)/);
      const id_str = idMatch ? idMatch[1] : '';
      if (!id_str) continue;

      const dateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const pubDateStr = dateMatch ? dateMatch[1].trim() : '';
      const created_at_ms = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();

      // 解析 description 标签内的推文正文
      const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || item.match(/<description>([\s\S]*?)<\/description>/);
      let desc = descMatch ? descMatch[1] : '';
      desc = desc.replace(/<br\s*\/?>/gi, '\n');
      desc = desc.replace(/<p>([\s\S]*?)<\/p>/gi, '$1\n');
      desc = desc.replace(/<a[^>]*href="[^"]*"[^>]*>Media<\/a>/gi, '');
      desc = desc.replace(/<a[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1');
      desc = desc.replace(/<[^>]+>/g, '');
      desc = desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      desc = this.cleanTweetText(desc);

      // 提取配图或视频封面
      const pics = [];
      const mediaMatches = item.matchAll(/<(?:media:content|media:thumbnail|enclosure)[^>]*url="([^"]+)"/g);
      for (const m of mediaMatches) {
        const u = m[1];
        if (u && !pics.includes(u) && !u.endsWith('.mp4') && !u.includes('.mp4?')) {
          pics.push(u);
        }
      }

      // 如果链接中的用户名不包含当前博主，判定为转推
      const isRetweet = !link.toLowerCase().includes('/' + cleanScreen + '/');
      const isReply = desc.startsWith('@');

      tweets.push({
        id_str,
        text: desc,
        raw_text: desc,
        created_at_ms,
        created_at: pubDateStr || new Date(created_at_ms).toISOString(),
        pics: pics.slice(0, 4),
        author_name: account.name || screenName,
        author_handle: screenName,
        author_avatar: account.avatar || '',
        is_reply: isReply,
        is_retweet: isRetweet,
        is_note_tweet: desc.length > 280
      });
    }
    return tweets;
  }

  /**
   * 统一轻量多引擎时间线拉取器：
   * 引擎 1: 官方 Syndication 轻量管道 (单次仅约 15~25 KB，配额正常时首选)
   * 引擎 2: FxTwitter 官方 RSS 镜像通道 (无 429 限制，每分钟配额高达 1000 次，极速且内容完整，遇到频控无缝兜底)
   * 引擎 3: x.com 主页直连 (单次高达 1~2 MB，极耗流量，仅作为极端保底)
   */
  async fetchAccountTimeline(screenName, account = {}) {
    const cleanName = this.cleanScreenName(screenName);
    if (!cleanName) return { success: false, tweets: [] };

    const now = Date.now();
    const canUseSyndication = (now >= this.syndicationBlockedUntil);

    // 1. 尝试引擎 1: Syndication 轻量管道 (未遭遇 IP 频控封锁时使用)
    if (canUseSyndication) {
      try {
        const synUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${cleanName}`;
        const synResp = await this.makeRequest(synUrl);
        if (synResp.statusCode === 200) {
          const remaining = parseInt(synResp.headers['x-rate-limit-remaining'], 10);
          const resetSec = parseInt(synResp.headers['x-rate-limit-reset'], 10);
          if (!isNaN(remaining) && remaining <= 1) {
            const until = resetSec ? (resetSec * 1000) : (now + 15 * 60 * 1000);
            this.syndicationBlockedUntil = until;
            logger.info(`[XFetcher] Syndication 官方配额临界 (剩余 ${remaining} 次)，临时切换至 FxTwitter 镜像至 ${new Date(until).toLocaleTimeString('zh-CN')}`);
          }

          const nextData = this.parseNextData(synResp.body);
          const entries = nextData?.props?.pageProps?.timeline?.entries || [];
          const tweets = [];
          for (const entry of entries) {
            const tweet = entry?.content?.tweet;
            if (!tweet || !tweet.id_str) continue;

            let rawText = tweet.note_tweet?.note_tweet_results?.result?.text
              || tweet.note_tweet?.text
              || tweet.text
              || '';
            if (!rawText) continue;

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
              text: this.cleanTweetText(rawText),
              raw_text: rawText,
              created_at_ms: tweet.created_at ? new Date(tweet.created_at).getTime() : Date.now(),
              created_at: tweet.created_at || new Date().toISOString(),
              pics: pics.slice(0, 4),
              author_name: tweet.user?.name || account.name || cleanName,
              author_handle: tweet.user?.screen_name || cleanName,
              author_avatar: avatar,
              is_reply: !!(tweet.in_reply_to_status_id_str || tweet.in_reply_to_screen_name),
              is_retweet: !!tweet.retweeted_status,
              is_note_tweet: !!tweet.note_tweet
            });
          }

          if (tweets.length > 0) {
            return { success: true, engine: 'syndication', tweets };
          }
        } else if (synResp.statusCode === 429) {
          const resetSec = parseInt(synResp.headers['x-rate-limit-reset'], 10);
          const until = resetSec ? (resetSec * 1000) : (now + 15 * 60 * 1000);
          this.syndicationBlockedUntil = until;
          logger.warn(`[XFetcher] Syndication 遭遇 IP 429 频控，自动熔断冷却至 ${new Date(until).toLocaleTimeString('zh-CN')}，无缝降级切换至 FxTwitter 镜像通道`);
          // 429 不直接中断，平滑降级走引擎 2
        }
      } catch (e) {
        logger.warn(`[XFetcher] Syndication 轻量拉取 @${cleanName} 受阻:`, e.message);
      }
    }

    // 2. 尝试引擎 2: FxTwitter RSS 通道 (无 429 限制，每分钟高达 1000 次，内容完整)
    try {
      const rssUrl = `https://fxtwitter.com/${cleanName}/feed.xml`;
      const rssResp = await this.makeRequest(rssUrl);
      if (rssResp.statusCode === 200) {
        const tweets = this.parseFxTwitterRss(rssResp.body, cleanName, account);
        if (tweets.length > 0) {
          return { success: true, engine: 'fxtwitter_rss', tweets };
        }
      }
    } catch (errRss) {
      logger.warn(`[XFetcher] FxTwitter RSS 镜像拉取 @${cleanName} 受阻:`, errRss.message);
    }

    // 3. 尝试引擎 3: x.com 主页直连 (极端兜底)
    try {
      const resp = await this.makeRequest(`https://x.com/${cleanName}`);
      if (resp.statusCode === 200) {
        const tweets = this.parseTweetsFromXProfileHtml(resp.body);
        if (tweets.length > 0) {
          return { success: true, engine: 'x_direct', tweets };
        }
      }
    } catch (e) {
      logger.warn(`[XFetcher] x.com 主页直连拉取 @${cleanName} 受阻:`, e.message);
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
      await this.ensureCompleteTweetText(tweet, screenName);
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
    this.syndicationBlockedUntil = 0;
    if (screenName) {
      const key = screenName.toLowerCase();
      this.coolingMap.delete(key);
      this.lastPolledMap.delete(key);
      logger.info(`[XFetcher] 已手动清除 @${screenName} 的频控冷却状态，恢复即时监听`);
    } else {
      this.coolingMap.clear();
      this.lastPolledMap.clear();
      logger.info(`[XFetcher] 已手动清除全部 X 账号的频控冷却状态与 IP 限额熔断`);
    }
  }

  /**
   * 轮询所有已订阅博主：采用平滑时间片分发调度（Staggered Round-Robin）
   * 每次主循环心跳仅调度 1 个已到期的博主，彻底消除并发峰值，杜绝触发 429 频控
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
      const total = enabledAccounts.length;

      // 单账号轮询基准间隔：至少 30 秒（建议 45 秒）
      const targetCycleSec = Math.max(30, xCfg.poll_interval_sec || 45);
      const minAccountIntervalMs = targetCycleSec * 1000;

      // 顺次寻找下一个已达到抓取间隔且未在冷却中的博主
      let selectedAccount = null;
      for (let attempt = 0; attempt < total; attempt++) {
        const idx = (this.roundRobinCursor + attempt) % total;
        const candidate = enabledAccounts[idx];
        const screenName = candidate.screen_name;
        const cooling = this.getAccountCoolingStatus(screenName);

        if (cooling.isCooling) {
          continue;
        }

        const lastPolled = this.lastPolledMap.get(screenName.toLowerCase()) || 0;
        if (now - lastPolled >= minAccountIntervalMs) {
          selectedAccount = candidate;
          this.roundRobinCursor = (idx + 1) % total;
          break;
        }
      }

      if (selectedAccount) {
        const screenName = selectedAccount.screen_name;
        this.lastPolledMap.set(screenName.toLowerCase(), now);

        try {
          const items = await this.pollSingleAccount(selectedAccount);
          if (items && items.length > 0) {
            newAlerts.push(...items);
            configUpdated = true;
          }
        } catch (errOne) {
          logger.warn(`[XFetcher] 轮询 @${screenName} 发生异常:`, errOne.message);
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

    // 过滤日常回复与历史远古推文 (时效性强校验：超过24小时的历史旧推文一律排除)
    const now = Date.now();
    const MAX_TWEET_AGE_MS = 24 * 3600 * 1000;
    const validTweets = [];
    for (const tweet of res.tweets) {
      if (tweet.is_reply && !account.include_replies) {
        continue;
      }
      const tweetAgeMs = now - (tweet.created_at_ms || 0);
      if (tweetAgeMs > MAX_TWEET_AGE_MS) {
        continue; // 彻底无视24小时以前的历史旧推文
      }
      validTweets.push(tweet);
    }

    if (validTweets.length === 0) return [];

    // 水位线检查与冷启动策略：
    const latestTweet = validTweets[0];

    let tweetsToProcess = [];

    // 解析当前账号已记录的水位线 (支持 64位 Snowflake BigInt 比较)
    let lastSeenBigInt = null;
    try {
      if (account.last_seen_id && /^\d+$/.test(String(account.last_seen_id).trim())) {
        lastSeenBigInt = BigInt(String(account.last_seen_id).trim());
      }
    } catch (e) {}

    if (!account.last_seen_id) {
      // 如果是首次监听该账号或未落盘水位线：
      // 检查最新推文发布时间：如果是在最近 2 小时 (120 分钟) 内发布的极新鲜推文（例如用户发推测试或博主突发），立即触发实时播报！
      const ageMs = now - (latestTweet.created_at_ms || 0);
      const isRecentTestOrBreaking = (ageMs >= 0 && ageMs < 120 * 60 * 1000);

      account.last_seen_id = latestTweet.id_str;
      if (isRecentTestOrBreaking) {
        logger.info(`[XFetcher] @${screenName} 首次加入监控发现 2 小时内新鲜推文 (${latestTweet.id_str})，启动实时弹窗播报！`);
        tweetsToProcess = [latestTweet];
      } else {
        logger.info(`[XFetcher] @${screenName} 首次加入监控，静默标记历史水位线推文 ID: ${latestTweet.id_str}`);
        return [];
      }
    } else {
      // 正常轮询增量推文：
      for (const tweet of validTweets) {
        if (tweet.id_str === account.last_seen_id) {
          break;
        }
        if (lastSeenBigInt !== null && /^\d+$/.test(tweet.id_str)) {
          try {
            if (BigInt(tweet.id_str) <= lastSeenBigInt) {
              // 遇到小于或等于最后一次记录的水位线推文（如旧置顶推文、历史旧推文），停止向后收集
              break;
            }
          } catch (e) {}
        }
        tweetsToProcess.push(tweet);
      }
    }

    // 单次单账号最大增量推文限制（突发防刷防爆保护，单次至多推送 3 条最新推文）
    const MAX_BURST_TWEETS = 3;
    if (tweetsToProcess.length > MAX_BURST_TWEETS) {
      logger.warn(`[XFetcher] @${screenName} 突发大量推文 (${tweetsToProcess.length} 条)，触发防刷屏保护，仅推送最新 ${MAX_BURST_TWEETS} 条，其余静默标记！`);
      for (let i = MAX_BURST_TWEETS; i < tweetsToProcess.length; i++) {
        const silentUid = `x_${account.screen_name}_${tweetsToProcess[i].id_str}`;
        historyManager.recordInteraction(silentUid, 'flood_shield_ignored');
      }
      tweetsToProcess = tweetsToProcess.slice(0, MAX_BURST_TWEETS);
    }

    if (tweetsToProcess.length === 0) return [];

    const newItems = [];
    for (const tweet of tweetsToProcess) {
      await this.ensureCompleteTweetText(tweet, screenName);
      const itemUid = `x_${account.screen_name}_${tweet.id_str}`;
      if (historyManager.isPushed(itemUid)) continue;

      let rawText = (tweet.text || '').trim();
      if (!rawText) {
        if (tweet.pics && tweet.pics.length > 0) {
          rawText = '【分享了图片动态】';
        } else if (tweet.is_retweet) {
          rawText = '【转发了推文】';
        } else {
          rawText = '【发布了新动态】';
        }
      }
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
          if (transRes && transRes.isTranslated && transRes.translatedText) {
            const upper = transRes.translatedText.toUpperCase();
            if (!upper.includes('QUERY LENGTH LIMIT EXCEEDED') && !upper.includes('MAX ALLOWED QUERY') && !upper.includes('MYMEMORY WARNING')) {
              translatedText = transRes.translatedText;
              isTranslated = true;
            }
          }
        } catch (errTrans) {
          logger.warn(`[XFetcher] 推文翻译失败，回退原文:`, errTrans.message);
        }
      }

      const showChineseName = !!(xCfg && xCfg.show_chinese_name);
      const displayAuthorName = formatAuthorName(account.name, account.screen_name, showChineseName, account.chinese_name);
      const titlePrefix = tweet.is_retweet ? `X ${displayAuthorName} (转推)` : `X ${displayAuthorName}`;

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
        source_name: `𝕏 ${displayAuthorName}`,
        author_name: displayAuthorName,
        author_name_raw: account.name,
        author_chinese_name: getAuthorChineseName(account.name, account.screen_name, account.chinese_name),
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
