const logger = require('./logger');

let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class NotifierService {
  constructor() {
    this.lastPushTimeMap = new Map(); // 用于简易频控排重
  }

  /**
   * 判断当前快讯是否符合手机端推送策略
   */
  shouldPushToMobile(alertData, mobileConfig, fullConfig) {
    if (!mobileConfig || mobileConfig.enabled !== true) return false;
    const webhook = (mobileConfig.wecom_webhook_url || '').trim();
    if (!webhook || !webhook.startsWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send')) {
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
   * 格式化企业微信 Markdown 卡片
   */
  formatWeComMarkdown(alertData) {
    const isVip = alertData.is_vip || false;
    let sourceTag = '⚡ 金十快讯';
    if (isVip) {
      sourceTag = '👑 VIP重大特报';
    } else if (alertData.source_key === 'x_twitter') {
      const handle = alertData.author_handle || alertData.author || '';
      sourceTag = `𝕏 动态播报${handle ? ` · @${handle}` : ''}`;
    } else if (alertData.source_key === 'xueqiu') {
      sourceTag = '❄️ 雪球快讯';
    } else if (alertData.source_key === 'maimai') {
      sourceTag = '💼 脉脉职言';
    } else if (alertData.source_key === 'jin10_topic') {
      sourceTag = '🔥 重要事件';
    }

    const title = (alertData.title || alertData.content || '').trim().replace(/[\r\n]+/g, ' ');
    const cleanTitle = title.length > 100 ? title.substring(0, 100) + '...' : title;

    let lines = [];
    if (isVip) {
      lines.push(`### <font color="warning">👑 【VIP重大特报】</font> ${cleanTitle}`);
    } else {
      lines.push(`### <font color="info">${sourceTag}</font> ${cleanTitle}`);
    }

    // 详细内容或推文原意
    if (alertData.content && alertData.content.trim() !== cleanTitle) {
      const briefContent = alertData.content.trim().substring(0, 260).replace(/[\r\n]+/g, '\n> ');
      lines.push(`> ${briefContent}${alertData.content.length > 260 ? '...' : ''}`);
    }

    // AI 观点与利多利空分析
    if (alertData.ai_analysis) {
      const ai = alertData.ai_analysis;
      if (ai.summary) {
        lines.push(`> 💡 **AI研判**：<font color="comment">${ai.summary}</font>`);
      }
      if (Array.isArray(ai.impacts) && ai.impacts.length > 0) {
        const impactStrs = ai.impacts.map(it => {
          const asset = it.target || it.name || it.asset || '';
          const dir = it.direction || it.bias || it.dir || '中性';
          const color = dir.includes('利好') ? 'info' : (dir.includes('利空') ? 'warning' : 'comment');
          return `<font color="${color}">${asset} ${dir}</font>`;
        }).join(' | ');
        lines.push(`> 📊 **标的影响**：${impactStrs}`);
      }
    }

    // 持仓关联提醒
    if (alertData.watchlist_impact && alertData.watchlist_impact.target) {
      const wl = alertData.watchlist_impact;
      lines.push(`> 🎯 <font color="warning">**持仓关注**：${wl.target} (${wl.direction || '相关'}) - ${wl.reason || ''}</font>`);
    }

    // 宏观经济指标数据
    if (alertData.is_economic_data && alertData.economic_data) {
      const ec = alertData.economic_data;
      lines.push(`> 📈 **宏观数据**：前值 ${ec.previous || '--'} | 预测 ${ec.consensus || '--'} | <font color="info">公布 ${ec.actual || '--'}</font>`);
    }

    // 时间与原文链接
    const pubTime = alertData.pub_time || alertData.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });
    lines.push(`> ⏱ **发布时间**：${pubTime}`);
    if (alertData.url && alertData.url.startsWith('http')) {
      lines.push(`> 🔗 [点击在浏览器中查看详情](${alertData.url})`);
    }

    return lines.join('\n');
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
   * 发送快讯报警到手机
   */
  async sendAlert(alertData, mobileConfig) {
    if (!mobileConfig || !mobileConfig.enabled || !mobileConfig.wecom_webhook_url) return;
    try {
      const markdown = this.formatWeComMarkdown(alertData);
      await this.sendWeComMessage(mobileConfig.wecom_webhook_url, markdown);
      logger.info(`[MobilePush] 成功推送快讯到企业微信: [${alertData.source || '快讯'}] ${alertData.title || alertData.content}`);
    } catch (err) {
      logger.warn('[MobilePush] 推送快讯到企业微信异常:', err.message);
    }
  }

  /**
   * 发送测试验证消息到手机
   */
  async sendTestMessage(webhookUrl) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const content = [
      `### <font color="info">📱【快讯通】企业微信推送自检成功</font>`,
      `> 恭喜！快讯通桌面客户端已成功连通您的企业微信群机器人。`,
      `>`,
      `> ⏱ **验证时间**：${now}`,
      `> 💡 **小贴士**：若希望在普通个人微信中直接收到此提醒，请在企业微信中打开【设置】->【微信插件】扫码关注，微信聊天列表即可实时收到推送卡片！`
    ].join('\n');

    try {
      await this.sendWeComMessage(webhookUrl, content);
      return { success: true, message: '测试消息已成功发送！请打开手机企业微信或微信查收。' };
    } catch (err) {
      return { success: false, message: `推送失败: ${err.message}` };
    }
  }
}

module.exports = new NotifierService();
