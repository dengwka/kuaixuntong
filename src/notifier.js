const crypto = require('crypto');
const logger = require('./logger');
const stockQuoteManager = require('./stockQuote');
const cryptoPriceManager = require('./cryptoPrice');

let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class NotifierService {
  constructor() {
    this.lastPushTimeMap = new Map(); // 用于简易频控排重
    this.wxTokenCache = { token: '', expireTime: 0 };
  }

  /**
   * 解析 AI 多空研判列表 (兼容 Object 键值对与 Array 数组形态)
   */
  parseImpactsList(rawImpacts) {
    if (!rawImpacts) return [];
    if (Array.isArray(rawImpacts)) {
      return rawImpacts.map(it => ({
        asset: it.target || it.name || it.asset || '',
        dir: it.direction || it.bias || it.dir || '中性'
      })).filter(it => it.asset);
    }
    if (typeof rawImpacts === 'object') {
      return Object.entries(rawImpacts).map(([asset, val]) => {
        let dir = '中性';
        if (typeof val === 'string') {
          dir = val;
        } else if (val && typeof val === 'object') {
          dir = val.direction || val.dir || '中性';
        }
        return { asset, dir };
      }).filter(it => it.asset);
    }
    return [];
  }

  /**
   * 获取实时或缓存中的自选股票与虚拟币行情
   */
  async getLiveTickerPayload(fullConfig) {
    try {
      const watchStocks = fullConfig?.watchlist?.stocks || [];
      const coins = fullConfig?.crypto_prices?.selected_coins || [];

      // 优先从内存极速缓存获取 (0ms)
      let stockText = stockQuoteManager.getCachedSummary(watchStocks);
      let cryptoText = cryptoPriceManager.getCachedSummary(coins);

      // 若缓存尚未预热，发起快速异步刷新 (1.2s 超时防阻塞)
      if (!stockText && fullConfig?.watchlist?.enabled !== false && watchStocks.length > 0) {
        try {
          stockText = await Promise.race([
            stockQuoteManager.getFormattedSummary(watchStocks),
            new Promise(r => setTimeout(() => r(''), 1200))
          ]);
        } catch (e) {}
      }

      if (!cryptoText && fullConfig?.crypto_prices?.enabled !== false && coins.length > 0) {
        try {
          cryptoText = await Promise.race([
            cryptoPriceManager.getFormattedSummary(coins),
            new Promise(r => setTimeout(() => r(''), 1200))
          ]);
        } catch (e) {}
      }

      return {
        stockPrices: (stockText || '').trim(),
        cryptoPrices: (cryptoText || '').trim()
      };
    } catch (e) {
      return { stockPrices: '', cryptoPrices: '' };
    }
  }

  /**
   * 判断当前快讯是否符合手机端推送策略
   */
  shouldPushToMobile(alertData, mobileConfig, fullConfig) {
    if (!mobileConfig || mobileConfig.enabled !== true) return false;
    const hasWeCom = (mobileConfig.wecom_enabled !== false) && !!(mobileConfig.wecom_webhook_url || '').trim();
    const hasFeishu = (mobileConfig.feishu_enabled !== false) && (
      (mobileConfig.feishu_mode === 'agent' && !!(mobileConfig.feishu_app_id || '').trim() && !!(mobileConfig.feishu_app_secret || '').trim() && !!(mobileConfig.feishu_receive_id || '').trim()) ||
      (mobileConfig.feishu_mode !== 'agent' && !!(mobileConfig.feishu_webhook_url || '').trim())
    );
    const hasServerChan = (mobileConfig.serverchan_enabled === true) && !!(mobileConfig.serverchan_sendkey || '').trim();
    const hasWxOfficial = (mobileConfig.wx_official_enabled === true) && !!(mobileConfig.wx_official_app_id || '').trim();
    if (!hasWeCom && !hasFeishu && !hasServerChan && !hasWxOfficial) {
      return false;
    }

    // 1. 如果用户选择推送所有快讯
    if (mobileConfig.trigger_on_all === true) return true;

    // 2. 命中 VIP 特大黑天鹅特报
    if (mobileConfig.trigger_on_vip !== false && alertData.is_vip) return true;

    // 3. 关注的 X (Twitter) 大V博主发推
    if (mobileConfig.trigger_on_x !== false && alertData.source_key === 'x_twitter') return true;

    // 4. 命中自选股票 / 加密货币持仓
    if (mobileConfig.trigger_on_watchlist !== false) {
      if (alertData.watchlist_impact && alertData.watchlist_impact.target) return true;

      const fullText = `${alertData.title || ''} ${alertData.content || ''}`.toLowerCase();

      // 自选股票匹配
      const stocks = fullConfig?.watchlist?.stocks || [];
      for (const s of stocks) {
        const code = String(s.code || '').toLowerCase().trim();
        const name = String(s.name || '').toLowerCase().trim();
        if (code && fullText.includes(code)) return true;
        if (name && fullText.includes(name)) return true;
        if (name.length > 2) {
          const short = name.replace(/(控股|股份|科技|集团|软件|通信|医药)/g, '');
          if (short.length >= 2 && fullText.includes(short)) return true;
        }
      }

      // 关注币种匹配
      const coins = fullConfig?.crypto_prices?.selected_coins || [];
      for (const c of coins) {
        const pair = String(c || '').toLowerCase().trim();
        const sym = pair.split('/')[0] || '';
        if (sym && fullText.includes(sym)) return true;
        if (sym === 'btc' && (fullText.includes('比特币') || fullText.includes('大饼'))) return true;
        if (sym === 'eth' && (fullText.includes('以太坊') || fullText.includes('以太'))) return true;
        if (sym === 'sol' && fullText.includes('solana')) return true;
      }
    }

    return false;
  }

  /**
   * 格式化企业微信 Markdown 卡片 (富文本排版、多空利好利空色彩渲染、自选股与币价)
   */
  formatWeComMarkdown(alertData, tickerPayload) {
    const isVip = alertData.is_vip || false;
    let sourceTag = '⚡ 金十快讯';
    if (isVip) {
      sourceTag = '👑 VIP重大特报';
    } else if (alertData.source_key === 'x_twitter') {
      const handle = alertData.author_handle || alertData.author || '';
      sourceTag = `X 动态播报${handle ? ` · @${handle}` : ''}`;
    } else if (alertData.source_key === 'xueqiu') {
      sourceTag = '❄️ 雪球快讯';
    } else if (alertData.source_key === 'maimai') {
      sourceTag = '💼 脉脉职言';
    } else if (alertData.source_key === 'jin10_topic') {
      sourceTag = '🔥 重要事件';
    }

    const title = (alertData.title || alertData.content || '').trim().replace(/[\r\n]+/g, ' ');
    let cleanTitle = title.length > 100 ? title.substring(0, 100) + '...' : title;
    // 替换特殊双线数学符号 𝕏 为标准字符 X，彻底杜绝企业微信客户端出现 □ 方块乱码
    cleanTitle = cleanTitle.replace(/\u{1D54F}/gu, 'X').replace(/𝕏/g, 'X');

    let lines = [];
    if (isVip) {
      lines.push(`### 🔴 👑 【VIP重大特报】 ${cleanTitle}`);
    } else {
      lines.push(`### <font color="info">${sourceTag}</font> ${cleanTitle}`);
    }

    // 正文内容摘要
    if (alertData.content && alertData.content.trim() !== cleanTitle) {
      const briefContent = alertData.content.trim().substring(0, 320).replace(/[\r\n]+/g, '\n> ');
      lines.push(`> ${briefContent}${alertData.content.length > 320 ? '...' : ''}`);
      lines.push(`>`);
    }

    // AI 观点与利多利空分析 (利空严禁使用 warning 橙色，采用鲜明 🔴 红圈配合加粗纯正展示)
    if (alertData.ai_analysis) {
      const ai = alertData.ai_analysis;
      if (ai.summary) {
        lines.push(`> 💡 **AI研判**：<font color="comment">${ai.summary}</font>`);
      }
      const rawImpacts = this.parseImpactsList(ai.impacts);
      const activeImpacts = rawImpacts.filter(it => it.dir.includes('利好') || it.dir.includes('利空'));
      const impactsList = activeImpacts.length > 0 ? activeImpacts : [];
      const rawScore = (alertData.impact_score !== undefined && alertData.impact_score !== null)
        ? alertData.impact_score
        : (ai && ai.impact_score !== undefined && ai.impact_score !== null ? ai.impact_score : null);
      const scorePrefix = (rawScore !== null && !isNaN(Number(rawScore))) ? `【行情影响 ${Number(rawScore)}分】` : '';

      if (impactsList.length > 0) {
        const impactStrs = impactsList.map(it => {
          const isBearish = it.dir.includes('利空');
          const isBullish = it.dir.includes('利好');
          if (isBearish) {
            return `🔴 **${it.asset} ${it.dir}**`;
          } else if (isBullish) {
            return `🟢 <font color="info">${it.asset} ${it.dir}</font>`;
          }
          return `⚪ <font color="comment">${it.asset} ${it.dir}</font>`;
        }).join(' · ');
        lines.push(`> 📊 **多空研判**：${scorePrefix}${impactStrs}`);
      } else if (scorePrefix) {
        lines.push(`> 📊 **多空研判**：${scorePrefix}多空情绪平稳`);
      }
      lines.push(`>`);
    }

    // 持仓关联提醒
    if (alertData.watchlist_impact && alertData.watchlist_impact.target) {
      const wl = alertData.watchlist_impact;
      const isNegative = (wl.direction || '').includes('利空');
      const icon = isNegative ? '🔴' : '🎯';
      lines.push(`> ${icon} **持仓关联**：**${wl.target}** (${wl.direction || '相关'}) - ${wl.reason || ''}`);
      lines.push(`>`);
    }

    // 宏观经济指标数据
    if (alertData.is_economic_data && alertData.economic_data) {
      const ec = alertData.economic_data;
      lines.push(`> 📈 **宏观数据**：前值 ${ec.previous || '--'} | 预测 ${ec.consensus || '--'} | <font color="info">公布 ${ec.actual || '--'}</font>`);
      lines.push(`>`);
    }

    // 自选股票实时行情价格 (严禁使用 warning 橙色，上涨使用 🔴 配合加粗红标，下跌使用 🟢 info 绿标)
    const stockText = (tickerPayload && tickerPayload.stockPrices) ? tickerPayload.stockPrices.trim() : '';
    if (stockText) {
      const items = stockText.split(/\s{2,}/).filter(Boolean);
      const coloredStocks = items.map(item => {
        // item 格式如: "腾讯控股 HK$387.60 +0.31%" 或 "京东 $25.24 -0.47%"
        const m = item.match(/^(.+?)\s+([A-Za-z$¥€£HK$]+[\d,.]+)\s+([+\-]?\d+(?:\.\d+)?%?)$/);
        if (m) {
          const name = m[1];
          const price = m[2];
          const change = m[3];
          const isUp = change.startsWith('+') || (parseFloat(change) > 0);
          const isDown = change.startsWith('-') || (parseFloat(change) < 0);
          if (isUp) {
            return `🔴 ${name} **${price} ${change}**`;
          } else if (isDown) {
            return `🟢 ${name} <font color="info">${price} ${change}</font>`;
          }
          return `⚪ ${name} <font color="comment">${price} ${change}</font>`;
        }
        if (item.includes('+')) {
          return `🔴 **${item}**`;
        } else if (item.includes('-')) {
          return `🟢 <font color="info">${item}</font>`;
        }
        return item;
      }).join(' | ');
      lines.push(`> 💼 **自选持仓**：${coloredStocks}`);
    }

    // 关注加密货币实时行情
    const cryptoText = (tickerPayload && tickerPayload.cryptoPrices) ? tickerPayload.cryptoPrices.trim() : '';
    if (cryptoText) {
      const cleanCrypto = cryptoText.split(/\s{2,}/).filter(Boolean).join(' | ');
      lines.push(`> 💰 **加密行情**：${cleanCrypto}`);
    }

    if (stockText || cryptoText) {
      lines.push(`>`);
    }

    // 时间与原文链接
    const pubTime = alertData.pub_time || alertData.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });
    let footerLine = `> ⏱ **时间**：${pubTime}`;
    if (alertData.url && alertData.url.startsWith('http')) {
      footerLine += `  |  [🔗 网页详情](${alertData.url})`;
    }
    lines.push(footerLine);

    return lines.join('\n');
  }

  /**
   * 格式化 Server酱 (方糖) 消息 Payload
   */
  formatServerChanPayload(alertData, tickerPayload) {
    const isVip = alertData.is_vip || false;
    let sourcePrefix = '⚡快讯';
    if (isVip) {
      sourcePrefix = '👑VIP特报';
    } else if (alertData.source_key === 'x_twitter') {
      const handle = alertData.author_handle || alertData.author || '';
      sourcePrefix = `𝕏推特${handle ? `@${handle}` : ''}`;
    } else if (alertData.source_key === 'xueqiu') {
      sourcePrefix = '❄️雪球';
    } else if (alertData.source_key === 'maimai') {
      sourcePrefix = '💼脉脉';
    } else if (alertData.source_key === 'jin10_topic') {
      sourcePrefix = '🔥重要事件';
    }

    const rawTitle = (alertData.title || alertData.content || '').trim().replace(/[\r\n]+/g, ' ');
    // Server酱标题限制 32 个字
    let title = `${sourcePrefix}: ${rawTitle}`;
    if (title.length > 32) {
      title = title.substring(0, 31) + '…';
    }

    let despLines = [];
    if (isVip) {
      despLines.push(`### 👑 【VIP重大特报】 ${rawTitle}`);
    } else {
      despLines.push(`### ${sourcePrefix} · ${rawTitle}`);
    }

    if (alertData.content && alertData.content.trim() !== rawTitle) {
      const brief = alertData.content.trim().substring(0, 360).replace(/[\r\n]+/g, '\n> ');
      despLines.push(`> ${brief}${alertData.content.length > 360 ? '...' : ''}`);
      despLines.push('');
    }

    if (alertData.ai_analysis) {
      const ai = alertData.ai_analysis;
      if (ai.summary) {
        despLines.push(`- 💡 **AI研判**：${ai.summary}`);
      }
      const rawImpacts = this.parseImpactsList(ai.impacts);
      const activeImpacts = rawImpacts.filter(it => it.dir.includes('利好') || it.dir.includes('利空'));
      const impactsList = activeImpacts.length > 0 ? activeImpacts : [];
      const rawScore = (alertData.impact_score !== undefined && alertData.impact_score !== null)
        ? alertData.impact_score
        : (ai && ai.impact_score !== undefined && ai.impact_score !== null ? ai.impact_score : null);
      const scorePrefix = (rawScore !== null && !isNaN(Number(rawScore))) ? `【行情影响 ${Number(rawScore)}分】` : '';

      if (impactsList.length > 0) {
        const impactStrs = impactsList.map(it => {
          const icon = it.dir.includes('利好') ? '🟢' : (it.dir.includes('利空') ? '🔴' : '⚪');
          return `${icon} ${it.asset} ${it.dir}`;
        }).join('  ');
        despLines.push(`- 📊 **多空研判**：${scorePrefix}${impactStrs}`);
      } else if (scorePrefix) {
        despLines.push(`- 📊 **多空研判**：${scorePrefix}多空情绪平稳`);
      }
    }

    if (alertData.watchlist_impact && alertData.watchlist_impact.target) {
      const wl = alertData.watchlist_impact;
      despLines.push(`- 🎯 **持仓关联**：**${wl.target}** (${wl.direction || '相关'}) ${wl.reason ? ` - ${wl.reason}` : ''}`);
    }

    if (alertData.is_economic_data && alertData.economic_data) {
      const ec = alertData.economic_data;
      despLines.push(`- 📈 **宏观数据**：前值 ${ec.previous || '--'} | 预测 ${ec.consensus || '--'} | **公布 ${ec.actual || '--'}**`);
    }

    // 股票自选持仓价格
    const stockText = (tickerPayload && tickerPayload.stockPrices) ? tickerPayload.stockPrices.trim() : '';
    if (stockText) {
      const cleanStocks = stockText.split(/\s{2,}/).filter(Boolean).join(' | ');
      despLines.push(`- 💼 **自选持仓**：${cleanStocks}`);
    }

    // 加密货币行情价格
    const cryptoText = (tickerPayload && tickerPayload.cryptoPrices) ? tickerPayload.cryptoPrices.trim() : '';
    if (cryptoText) {
      const cleanCrypto = cryptoText.split(/\s{2,}/).filter(Boolean).join(' | ');
      despLines.push(`- 💰 **加密行情**：${cleanCrypto}`);
    }

    const pubTime = alertData.pub_time || alertData.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });
    despLines.push(`- ⏱ **发布时间**：${pubTime}`);

    if (alertData.url && alertData.url.startsWith('http')) {
      despLines.push(``);
      despLines.push(`🔗 [点击在浏览器中查看详情](${alertData.url})`);
    }

    return {
      title,
      desp: despLines.join('\n')
    };
  }

  /**
   * 发送 Markdown 消息到企业微信 Webhook
   */
  async sendWeComMessage(webhookUrl, markdownContent) {
    const url = (webhookUrl || '').trim();
    if (!url || !url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send')) {
      throw new Error('企业微信 Webhook URL 格式不正确，必须以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send 开头');
    }

    const payload = {
      msgtype: 'markdown',
      markdown: {
        content: markdownContent
      }
    };

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`企微接口返回 HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json && json.errcode !== 0) {
        throw new Error(`企微接口报错 [${json.errcode}]: ${json.errmsg}`);
      }

      return { success: true };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * 格式化飞书富交互卡片 (Lark Interactive Card 2.0 结构化卡片排版)
   */
  formatFeishuCard(alertData, tickerPayload) {
    const isVip = alertData.is_vip || false;
    const titlePrefix = isVip ? '👑【VIP重大特报】' : '⚡【突发快讯】';
    const cardTemplate = isVip ? 'red' : (alertData.source_key === 'x_twitter' ? 'turquoise' : 'blue');

    let cleanTitle = (alertData.title || alertData.content || '').trim().replace(/[\r\n]+/g, ' ');
    cleanTitle = cleanTitle.replace(/\u{1D54F}/gu, 'X').replace(/𝕏/g, 'X');
    let sourceTag = (alertData.source || '快讯通').replace(/\u{1D54F}/gu, 'X').replace(/𝕏/g, 'X');
    const pubTime = alertData.pub_time || alertData.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });

    // AI 研判与多空情绪
    const aiSummary = alertData.ai_analysis?.summary || '无特殊AI研判';
    const rawImpacts = this.parseImpactsList(alertData.ai_analysis?.impacts);
    const activeImpacts = rawImpacts.filter(it => it.dir.includes('利好') || it.dir.includes('利空'));
    const impactsList = activeImpacts.length > 0 ? activeImpacts : [];
    const rawScore = (alertData.impact_score !== undefined && alertData.impact_score !== null)
      ? alertData.impact_score
      : (alertData.ai_analysis?.impact_score !== undefined && alertData.ai_analysis?.impact_score !== null ? alertData.ai_analysis.impact_score : null);
    const scorePrefix = (rawScore !== null && !isNaN(Number(rawScore))) ? `【行情影响 ${Number(rawScore)}分】` : '';

    let impactStr = '';
    if (impactsList.length > 0) {
      impactStr = impactsList.map(it => {
        const isBearish = it.dir.includes('利空');
        const isBullish = it.dir.includes('利好');
        const icon = isBearish ? '🔴' : (isBullish ? '🟢' : '⚪');
        const color = isBullish ? 'green' : (isBearish ? 'red' : 'grey');
        return `${icon} **${it.asset}** <font color='${color}'>${it.dir}</font>`;
      }).join(' · ');
    } else {
      impactStr = '多空情绪平稳';
    }

    let stockText = '无';
    if (tickerPayload?.stockPrices) {
      const sItems = tickerPayload.stockPrices.split(/\s{2,}/).filter(Boolean);
      stockText = sItems.map(item => {
        const m = item.match(/^(.+?)\s+([A-Za-z$¥€£HK$]+[\d,.]+)\s+([+\-]?\d+(?:\.\d+)?%?)$/);
        if (m) {
          const isUp = m[3].startsWith('+') || (parseFloat(m[3]) > 0);
          const isDown = m[3].startsWith('-') || (parseFloat(m[3]) < 0);
          const icon = isUp ? '🔴' : (isDown ? '🟢' : '⚪');
          const color = isUp ? 'red' : (isDown ? 'green' : 'grey');
          return `${icon} ${m[1]} <font color='${color}'>${m[2]} ${m[3]}</font>`;
        }
        return item;
      }).join(' | ');
    }
    const cryptoText = tickerPayload?.cryptoPrices?.split(/\s{2,}/).filter(Boolean).join(' | ') || '无';

    const hasTickers = (stockText !== '无') || (cryptoText !== '无');
    const cardElements = [
      // 1. 快讯核心要点（直接置顶，免除干扰，秒级阅读）
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${alertData.content || cleanTitle}`
        }
      },
      // 2. 细分割线（AI研判上方横线，与下方分割线对称呼应）
      { tag: 'hr' },
      // 3. AI 宏观情绪与多空资产研判
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `💡 **AI研判**：${aiSummary}\n\n📊 **多空研判**：${scorePrefix}${impactStr}`
        }
      },
      // 3. 行情分割线与实时自选报价 (仅在有自选数据时呈现)
      hasTickers ? { tag: 'hr' } : null,
      hasTickers ? {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${stockText !== '无' ? `💼 **自选持仓**：${stockText}\n\n` : ''}${cryptoText !== '无' ? `💰 **加密行情**：${cryptoText}` : ''}`.trim()
        }
      } : null,
      // 4. 底部弱化信息：来源、时间与轻量原文链接（收纳于脚注灰色区，绝不耽误阅读）
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'lark_md',
            content: `📡 ${sourceTag}  |  ⏱ ${pubTime}${alertData.url && alertData.url.startsWith('http') ? `  |  [🔗 查看原文](${alertData.url})` : ''}`
          }
        ]
      }
    ].filter(Boolean);

    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `${titlePrefix} ${cleanTitle.substring(0, 40)}` },
          template: cardTemplate
        },
        elements: cardElements
      }
    };
  }

  /**
   * 发送卡片到飞书群机器人 Webhook (支持可选签名校验)
   */
  async sendFeishuMessage(webhookUrl, cardPayload, secret) {
    const url = (webhookUrl || '').trim();
    if (!url || !url.startsWith('http')) {
      throw new Error('飞书 Webhook 地址无效，请填写正确的飞书自定义机器人 Webhook URL');
    }

    let body = { ...cardPayload };
    if (secret && secret.trim()) {
      const timestamp = Math.floor(Date.now() / 1000);
      const stringToSign = `${timestamp}\n${secret.trim()}`;
      const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
      body.timestamp = `${timestamp}`;
      body.sign = sign;
    }

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`飞书接口网络返回异常: HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json && json.code && json.code !== 0) {
        throw new Error(`飞书接口错误 [${json.code}]: ${json.msg || '发送失败'}`);
      }

      return { success: true };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * 获取飞书开放平台 Tenant Access Token (带本地内存缓存，有效期 2 小时)
   */
  async getFeishuTenantToken(appId, appSecret) {
    const cleanAppId = (appId || '').trim();
    const cleanAppSecret = (appSecret || '').trim();
    const cacheKey = `${cleanAppId}:${cleanAppSecret}`;
    const now = Date.now();

    if (this._feishuTokenCache && this._feishuTokenCache[cacheKey]) {
      const cached = this._feishuTokenCache[cacheKey];
      if (cached.expireTime > now + 60000) {
        return cached.token;
      }
    }

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetchFn('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          app_id: cleanAppId,
          app_secret: cleanAppSecret
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`飞书鉴权网络返回异常: HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json && json.code !== 0) {
        throw new Error(`飞书凭据获取失败 [${json.code}]: ${json.msg || '请检查 App ID 与 Secret'}`);
      }

      if (!this._feishuTokenCache) this._feishuTokenCache = {};
      this._feishuTokenCache[cacheKey] = {
        token: json.tenant_access_token,
        expireTime: now + (json.expire || 7140) * 1000
      };

      return json.tenant_access_token;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * 通过飞书开放平台自建应用 / 智能体 API 发送富交互卡片 (支持单聊直推 / 任意群聊)
   */
  async sendFeishuAppMessage(appId, appSecret, receiveId, cardPayload) {
    const cleanAppId = (appId || '').trim();
    const cleanAppSecret = (appSecret || '').trim();
    const cleanReceiveId = (receiveId || '').trim();

    if (!cleanAppId || !cleanAppSecret || !cleanReceiveId) {
      throw new Error('请完整填写飞书 App ID、App Secret 和 接收目标 ID');
    }

    const token = await this.getFeishuTenantToken(cleanAppId, cleanAppSecret);

    let receiveIdType = 'user_id';
    if (cleanReceiveId.startsWith('oc_')) {
      receiveIdType = 'chat_id';
    } else if (cleanReceiveId.startsWith('ou_')) {
      receiveIdType = 'open_id';
    } else if (cleanReceiveId.includes('@')) {
      receiveIdType = 'email';
    } else if (cleanReceiveId.startsWith('on_')) {
      receiveIdType = 'union_id';
    }

    const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const cardContent = cardPayload.card ? JSON.stringify(cardPayload.card) : JSON.stringify(cardPayload);

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          receive_id: cleanReceiveId,
          msg_type: 'interactive',
          content: cardContent
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      let json = null;
      try {
        json = await res.json();
      } catch (je) {}

      if (!res.ok) {
        const errorDetail = json?.msg || json?.error || (json ? JSON.stringify(json) : `HTTP ${res.status}`);
        throw new Error(`飞书 API 报错 [${res.status}]: ${errorDetail}`);
      }

      if (json && json.code !== 0) {
        throw new Error(`飞书智能体发送失败 [${json.code}]: ${json.msg || '未知错误'}`);
      }

      return { success: true };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * 发送测试验证消息到飞书 (支持 Webhook 与 智能体模式)
   */
  async sendFeishuTestMessage(testParams, fullConfig) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const tickers = await this.getLiveTickerPayload(fullConfig);
    const mode = (testParams && testParams.mode) || 'webhook';

    const testAlert = {
      title: mode === 'agent' ? '快讯通飞书智能体自检' : '快讯通飞书群机器人自检',
      content: mode === 'agent'
        ? '恭喜！快讯通已成功连接您的飞书自建应用/智能体！突发快讯与自选标的异动已支持直接单聊/群聊秒级推送。'
        : '恭喜！快讯通客户端已成功连接您的飞书群自定义机器人，突发快讯与自选标的异动将以彩色交互卡片秒级推送到飞书！',
      source: '自检测试',
      source_key: 'jin10',
      pub_time: now,
      url: 'https://github.com/dengwka/kuaixuntong',
      impact_score: 88,
      ai_analysis: {
        impact_score: 88,
        summary: '网络连接正常，AI多空情绪引擎与行情实时推送管道对接成功。',
        impacts: { 'A股': '利好', '虚拟币': '利好', '黄金': '中性', '美元': '利空', '原油': '中性' }
      }
    };
    const card = this.formatFeishuCard(testAlert, tickers);

    try {
      if (mode === 'agent') {
        await this.sendFeishuAppMessage(testParams.appId, testParams.appSecret, testParams.receiveId, card);
        return { success: true, message: '测试消息已成功送达飞书智能体！请在飞书查收。' };
      } else {
        const webhookUrl = testParams.webhookUrl || testParams;
        await this.sendFeishuMessage(webhookUrl, card, testParams.secret);
        return { success: true, message: '测试消息已成功发送！请打开飞书客户端查收卡片。' };
      }
    } catch (err) {
      return { success: false, message: `飞书推送失败: ${err.message}` };
    }
  }

  /**
   * 发送 Markdown 消息到 Server酱 (方糖 Turbo)
   */
  async sendServerChanMessage(sendKey, title, markdownDesp) {
    const key = (sendKey || '').trim();
    if (!key) {
      throw new Error('Server酱 SendKey 不能为空');
    }

    // 官方 API 地址: https://sctapi.ftqq.com/<SENDKEY>.send
    const url = `https://sctapi.ftqq.com/${key}.send`;
    const params = new URLSearchParams();
    params.append('title', (title || '快讯通提醒').trim().substring(0, 32));
    params.append('desp', markdownDesp || '');

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString(),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`Server酱接口返回 HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json) {
        if (json.code !== 0 && json.errno !== 0) {
          throw new Error(`Server酱返回错误 [${json.code || json.errno}]: ${json.message || json.errmsg || '推送失败'}`);
        }
      }
      return { success: true };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * 发送快讯报警到手机 (企业微信与 Server酱多通道，自动整合行情与研判)
   */
  async sendAlert(alertData, mobileConfig, fullConfig, tickerPayload) {
    if (!mobileConfig || !mobileConfig.enabled) return;

    let tickers = tickerPayload ? { ...tickerPayload } : {};
    const stockEnabled = fullConfig?.watchlist?.enabled !== false && (fullConfig?.watchlist?.stocks || []).length > 0;
    const cryptoEnabled = fullConfig?.crypto_prices?.enabled !== false && (fullConfig?.crypto_prices?.selected_coins || []).length > 0;

    const needStock = stockEnabled && (!tickers.stockPrices || !tickers.stockPrices.trim());
    const needCrypto = cryptoEnabled && (!tickers.cryptoPrices || !tickers.cryptoPrices.trim());

    if (needStock || needCrypto) {
      const live = await this.getLiveTickerPayload(fullConfig);
      if (needStock && live.stockPrices) {
        tickers.stockPrices = live.stockPrices;
      }
      if (needCrypto && live.cryptoPrices) {
        tickers.cryptoPrices = live.cryptoPrices;
      }
    }

    // 1. 企业微信群机器人推送
    if (mobileConfig.wecom_enabled !== false && mobileConfig.wecom_webhook_url) {
      try {
        const markdown = this.formatWeComMarkdown(alertData, tickers);
        await this.sendWeComMessage(mobileConfig.wecom_webhook_url, markdown);
        logger.info(`[MobilePush] 成功推送快讯到企业微信: [${alertData.source || '快讯'}] ${alertData.title || alertData.content}`);
      } catch (err) {
        logger.warn('[MobilePush] 推送快讯到企业微信异常:', err.message);
      }
    }

    // 2. 飞书推送 (支持 Webhook 群机器人 与 智能体/自建应用 双模式)
    if (mobileConfig.feishu_enabled !== false) {
      const mode = mobileConfig.feishu_mode || 'webhook';
      if (mode === 'agent' && mobileConfig.feishu_app_id && mobileConfig.feishu_app_secret && mobileConfig.feishu_receive_id) {
        try {
          const card = this.formatFeishuCard(alertData, tickers);
          await this.sendFeishuAppMessage(
            mobileConfig.feishu_app_id,
            mobileConfig.feishu_app_secret,
            mobileConfig.feishu_receive_id,
            card
          );
          logger.info(`[MobilePush] 成功通过飞书智能体推送快讯: [${alertData.source || '快讯'}] ${alertData.title || alertData.content}`);
        } catch (err) {
          logger.warn('[MobilePush] 飞书智能体推送快讯异常:', err.message);
        }
      } else if (mode !== 'agent' && mobileConfig.feishu_webhook_url) {
        try {
          const card = this.formatFeishuCard(alertData, tickers);
          await this.sendFeishuMessage(mobileConfig.feishu_webhook_url, card, mobileConfig.feishu_secret);
          logger.info(`[MobilePush] 成功推送快讯到飞书群机器人: [${alertData.source || '快讯'}] ${alertData.title || alertData.content}`);
        } catch (err) {
          logger.warn('[MobilePush] 推送快讯到飞书群机器人异常:', err.message);
        }
      }
    }

    // 2. Server酱 (方糖) 个人微信直推
    if (mobileConfig.serverchan_enabled === true && mobileConfig.serverchan_sendkey) {
      try {
        const { title, desp } = this.formatServerChanPayload(alertData, tickers);
        await this.sendServerChanMessage(mobileConfig.serverchan_sendkey, title, desp);
        logger.info(`[MobilePush] 成功推送快讯到 Server酱 (方糖): [${alertData.source || '快讯'}] ${title}`);
      } catch (err) {
        logger.warn('[MobilePush] 推送快讯到 Server酱 (方糖) 异常:', err.message);
      }
    }

    // 3. 微信公众号 / 微信测试号官方直推 (10万条/天，直连腾讯官方)
    if (mobileConfig.wx_official_enabled === true && mobileConfig.wx_official_app_id) {
      try {
        await this.sendWxTemplateMessage(mobileConfig, alertData, tickers);
        logger.info(`[MobilePush] 成功推送快讯到微信公众号: [${alertData.source || '快讯'}] ${alertData.title || alertData.content}`);
      } catch (err) {
        logger.warn('[MobilePush] 推送快讯到微信公众号异常:', err.message);
      }
    }
  }

  /**
   * 获取微信公众号 AccessToken (支持 2小时内存缓存复用)
   */
  async getWxAccessToken(appId, appSecret) {
    const now = Date.now();
    if (this.wxTokenCache.token && this.wxTokenCache.expireTime > now + 300000) {
      return this.wxTokenCache.token;
    }

    const cleanAppId = (appId || '').trim();
    const cleanSecret = (appSecret || '').trim();
    if (!cleanAppId || !cleanSecret) {
      throw new Error('微信公众号 AppID 或 AppSecret 不能为空');
    }

    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cleanAppId)}&secret=${encodeURIComponent(cleanSecret)}`;
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`获取微信 AccessToken HTTP 异常: ${res.status}`);

    const json = await res.json();
    if (json.errcode && json.errcode !== 0) {
      throw new Error(`微信接口错误 [${json.errcode}]: ${json.errmsg}`);
    }

    this.wxTokenCache = {
      token: json.access_token,
      expireTime: now + ((json.expires_in || 7200) * 1000)
    };
    return json.access_token;
  }

  /**
   * 发送微信公众号 / 测试号模板消息 (支持各类自定义变量名称)
   */
  async sendWxTemplateMessage(cfg, alertData, tickerPayload) {
    const appId = (cfg.wx_official_app_id || '').trim();
    const appSecret = (cfg.wx_official_app_secret || '').trim();
    const templateId = (cfg.wx_official_template_id || '').trim();
    const openId = (cfg.wx_official_openid || '').trim();

    if (!appId || !appSecret || !templateId || !openId) {
      throw new Error('微信公众号配置不完整，请确认 AppID、AppSecret、模板ID 与 OpenID 均已填写');
    }

    const token = await this.getWxAccessToken(appId, appSecret);
    const openIds = openId.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);

    const cleanTitle = (alertData.title || alertData.content || '').trim().replace(/[\r\n]+/g, ' ').substring(0, 80);
    const isVip = alertData.is_vip || false;
    const prefix = isVip ? '👑【VIP重大特报】' : '⚡【快讯】';

    const aiSummary = alertData.ai_analysis?.summary || '无特殊AI研判';
    const rawImpacts = this.parseImpactsList(alertData.ai_analysis?.impacts);
    const activeImpacts = rawImpacts.filter(it => it.dir.includes('利好') || it.dir.includes('利空'));
    const impactsList = activeImpacts.length > 0 ? activeImpacts : [];
    const rawScore = (alertData.impact_score !== undefined && alertData.impact_score !== null)
      ? alertData.impact_score
      : (alertData.ai_analysis?.impact_score !== undefined && alertData.ai_analysis?.impact_score !== null ? alertData.ai_analysis.impact_score : null);
    const scorePrefix = (rawScore !== null && !isNaN(Number(rawScore))) ? `【行情影响 ${Number(rawScore)}分】` : '';

    const impactStrs = impactsList.length > 0 
      ? `${scorePrefix}${impactsList.map(it => `${it.asset} ${it.dir}`).join(' · ')}`
      : (scorePrefix ? `${scorePrefix}多空情绪平稳` : '多空情绪平稳');

    const stockText = tickerPayload?.stockPrices?.split(/\s{2,}/).filter(Boolean).join(' | ') || '无';
    const cryptoText = tickerPayload?.cryptoPrices?.split(/\s{2,}/).filter(Boolean).join(' | ') || '无';
    const pubTime = alertData.pub_time || alertData.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });

    // 组合同时兼容传统关键字 (first/keyword/remark) 与语义变量 (title/content/ai/stocks) 的全量数据包
    const dataObj = {
      first: { value: `${prefix} ${cleanTitle}`, color: isVip ? '#DC2626' : '#2563EB' },
      keyword1: { value: cleanTitle, color: '#0F172A' },
      keyword2: { value: aiSummary, color: '#334155' },
      keyword3: { value: impactStrs, color: '#059669' },
      keyword4: { value: `自选: ${stockText}`, color: '#2563EB' },
      keyword5: { value: `币价: ${cryptoText}`, color: '#D97706' },
      remark: { value: `⏱ ${pubTime}  |  点击查看网页详情`, color: '#64748B' },

      title: { value: `${prefix} ${cleanTitle}`, color: isVip ? '#DC2626' : '#2563EB' },
      content: { value: (alertData.content || cleanTitle).substring(0, 200), color: '#334155' },
      ai: { value: aiSummary, color: '#334155' },
      summary: { value: aiSummary, color: '#334155' },
      impacts: { value: impactStrs, color: '#059669' },
      stocks: { value: stockText, color: '#2563EB' },
      crypto: { value: cryptoText, color: '#D97706' },
      time: { value: pubTime, color: '#64748B' }
    };

    const sendUrl = `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`;
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    for (const oid of openIds) {
      const body = {
        touser: oid,
        template_id: templateId,
        url: alertData.url && alertData.url.startsWith('http') ? alertData.url : undefined,
        data: dataObj
      };

      const res = await fetchFn(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const json = await res.json();
      if (json.errcode && json.errcode !== 0) {
        throw new Error(`微信模板消息发送失败 [${json.errcode}]: ${json.errmsg}`);
      }
    }

    return { success: true };
  }

  /**
   * 发送测试验证消息到微信公众号 / 微信测试号
   */
  async sendWxOfficialTestMessage(cfg, fullConfig) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const tickers = await this.getLiveTickerPayload(fullConfig);
    const testAlert = {
      title: '快讯通微信公众号直推自检成功',
      content: '恭喜！快讯通桌面客户端已成功连通您的微信公众号/测试号，日额度 10 万条官方直连管道已就绪！',
      source: '自检测试',
      source_key: 'jin10',
      pub_time: now,
      url: 'https://github.com/dengwka/kuaixuntong',
      impact_score: 88,
      ai_analysis: {
        impact_score: 88,
        summary: '网络连接顺畅，AI多空情绪引擎与股票、虚拟币行情管道已打通。',
        impacts: { 'A股': '利好', '虚拟币': '利好', '黄金': '中性', '美元': '利空', '原油': '中性' }
      }
    };

    try {
      await this.sendWxTemplateMessage(cfg, testAlert, tickers);
      return { success: true, message: '测试模板消息已成功发送！请打开手机微信查收公众号卡片。' };
    } catch (err) {
      return { success: false, message: `微信发送失败: ${err.message}` };
    }
  }

  /**
   * 发送测试验证消息到企业微信
   */
  async sendTestMessage(webhookUrl, fullConfig) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const tickers = await this.getLiveTickerPayload(fullConfig);
    const testAlert = {
      title: '快讯通企业微信群机器人推送自检',
      content: '恭喜！快讯通桌面客户端已成功连通您的企业微信群机器人，多空研判与自选资产实时行情管道已同步对接完成。',
      source: '自检测试',
      source_key: 'jin10',
      pub_time: now,
      url: 'https://github.com/dengwka/kuaixuntong',
      impact_score: 88,
      ai_analysis: {
        impact_score: 88,
        summary: '网络连接畅通，AI多空情绪引擎与股票、加密货币行情管道工作正常。',
        impacts: { 'A股': '利好', '虚拟币': '利好', '黄金': '中性', '美元': '利空', '原油': '中性' }
      }
    };
    const content = this.formatWeComMarkdown(testAlert, tickers);

    try {
      await this.sendWeComMessage(webhookUrl, content);
      return { success: true, message: '测试消息已成功发送！请打开手机企业微信查收。' };
    } catch (err) {
      return { success: false, message: `推送失败: ${err.message}` };
    }
  }

  /**
   * 发送测试验证消息到 Server酱 (方糖) 微信
   */
  async sendServerChanTestMessage(sendKey, fullConfig) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const tickers = await this.getLiveTickerPayload(fullConfig);
    const testAlert = {
      title: '快讯通微信推送自检成功',
      content: '恭喜！快讯通桌面客户端已成功连接 Server酱 微信推送服务，AI多空研判与自选持仓实时行情已打通。',
      source: '自检测试',
      source_key: 'jin10',
      pub_time: now,
      url: 'https://github.com/dengwka/kuaixuntong',
      impact_score: 88,
      ai_analysis: {
        impact_score: 88,
        summary: '微信推送管道工作正常，后续自选标的与重要事件将以精美卡片形式直推。',
        impacts: { 'A股': '利好', '虚拟币': '利好', '黄金': '中性', '美元': '利空', '原油': '中性' }
      }
    };
    const { title, desp } = this.formatServerChanPayload(testAlert, tickers);

    try {
      await this.sendServerChanMessage(sendKey, title, desp);
      return { success: true, message: '测试消息已成功发送！请打开手机微信查看「方糖」公众号服务卡片。' };
    } catch (err) {
      return { success: false, message: `Server酱推送失败: ${err.message}` };
    }
  }
}

module.exports = new NotifierService();
