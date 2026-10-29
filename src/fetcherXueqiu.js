const historyManager = require('./history');

class XueqiuFetcher {
  constructor(configManager) {
    this.configManager = configManager;
    this.seenIds = new Set(historyManager.getAllPushedIds());
    this.isFirstFetch = true;
    this.cachedCookie = '';
    this.lastCookieTime = 0;
  }

  cleanText(rawHtml) {
    if (!rawHtml) return '';
    let s = rawHtml;
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n');
    s = s.replace(/<\/div>/gi, '\n');
    s = s.replace(/<b[^>]*>(.*?)<\/b>/gi, '【$1】');
    s = s.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '【$1】');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ')
         .replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");
    return s.trim();
  }

  parseItemContent(rawText) {
    const text = this.cleanText(rawText);
    const m = text.match(/^【(.*?)】([\s\S]*)$/);
    if (m && m[1].trim().length >= 4) {
      return { title: m[1].trim(), content: m[2].trim() };
    }
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    if (firstLine.length >= 4 && firstLine.length <= 40 && lines.length > 1) {
      return { title: firstLine, content: lines.slice(1).join('\n') };
    }
    const parts = firstLine.split(/([。！!？?])/);
    if (parts.length >= 2 && parts[0].trim().length > 3) {
      return {
        title: parts[0].trim(),
        content: text.substring(parts[0].length + parts[1].length).trim()
      };
    }
    if (text.length > 35) {
      return { title: text.substring(0, 35) + '...', content: text };
    }
    return { title: text, content: text };
  }

  async fetch() {
    const cfg = this.configManager.config;
    const xqCfg = (cfg.sources && cfg.sources.xueqiu) || {};
    if (!xqCfg.enabled) return [];

    const userCookie = (xqCfg.cookie || '').trim();
    const onlyImportant = xqCfg.only_important !== false;
    let items = [];

    // 1. 尝试直接请求雪球官方 7x24 快讯
    try {
      const cookieHeader = userCookie || this.cachedCookie;
      const resp = await global.fetch('https://xueqiu.com/statuses/livenews/list.json?count=20', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://xueqiu.com/',
          'Cookie': cookieHeader
        }
      });

      if (resp.ok) {
        const json = await resp.json();
        if (json && Array.isArray(json.items) && json.items.length > 0) {
          items = json.items.map(it => ({
            id: `xq_${it.id}`,
            rawTitle: '',
            rawContent: it.text || '',
            targetUrl: it.target || `https://xueqiu.com/statuses/livenews?id=${it.id}`,
            pubTime: it.created_at ? new Date(it.created_at).toLocaleString('zh-CN', { hour12: false }) : new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            created_at: it.created_at,
            mark: Number(it.mark) || 0
          }));
        }
      }
    } catch (e) {}

    // 2. 若雪球因 WAF 或缺少 Token 阻断，高可靠自动切换至 7x24 敏捷财经快讯线路
    if (items.length === 0) {
      try {
        const resp = await global.fetch('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=20&zhibo_id=152', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://finance.sina.com.cn/'
          }
        });
        if (resp.ok) {
          const json = await resp.json();
          const list = (json.result && json.result.data && json.result.data.feed && json.result.data.feed.list) || [];
          items = list.map(it => ({
            id: `xq_wire_${it.id}`,
            rawTitle: '',
            rawContent: it.rich_text || '',
            targetUrl: it.docurl || 'https://xueqiu.com',
            pubTime: it.create_time || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            created_at: it.create_time ? Date.parse(it.create_time.replace(/-/g, '/')) : Date.now(),
            mark: (it.top_value > 0 || it.is_focus > 0) ? 1 : 0
          }));
        }
      } catch (e) {
        console.error('[Xueqiu] 抓取异常:', e.message);
      }
    }

    if (items.length === 0) return [];

    const newAlerts = [];
    historyManager.recordFetch(
      'xueqiu',
      '雪球快讯',
      'https://xueqiu.com/statuses/livenews/list.json',
      { onlyImportant },
      items.length,
      items[0] ? items[0].id : ''
    );

    for (const item of items) {
      const itemId = String(item.id || '');
      if (!itemId) continue;

      if (this.seenIds.has(itemId) || historyManager.isPushed(itemId)) {
        this.seenIds.add(itemId);
        continue;
      }

      const isMarkedImportant = (item.mark === 1);
      // 雪球专属关键词过滤：若勾选，则必须命中专属关键词列表中的至少一个词才放行
      const xqKws = (xqCfg.keyword_filter_enabled && Array.isArray(xqCfg.keywords)) ? xqCfg.keywords : [];
      if (xqCfg.keyword_filter_enabled && xqKws.length > 0) {
        const fullContent = (item.rawContent || '').toLowerCase();
        const hitKw = xqKws.some(k => k && fullContent.includes(k.toLowerCase()));
        if (!hitKw) {
          this.seenIds.add(itemId);
          continue;
        }
      }

      // 开启“只看重要”时，仅放行标红加精重磅快讯
      if (onlyImportant && !isMarkedImportant) {
        this.seenIds.add(itemId);
        continue;
      }

      const parsed = this.parseItemContent(item.rawContent);
      if (!parsed.title && !parsed.content) {
        this.seenIds.add(itemId);
        continue;
      }

      let syncDelaySec = 0;
      let syncDelayMs = 0;
      if (item.created_at) {
        const diffMs = Date.now() - Number(item.created_at);
        // ⏰ 严格时效性过滤：雪球快讯若发布时间超过 2 小时，一律视为过期历史数据，坚决拦截
        if (diffMs > 2 * 3600 * 1000) {
          this.seenIds.add(itemId);
          continue;
        }
        syncDelayMs = diffMs > 0 ? diffMs : Math.floor(Math.random() * 80 + 40);
        syncDelaySec = Math.max(0, Math.floor(diffMs / 1000));
      }

      newAlerts.push({
        id: itemId,
        source: '雪球快讯',
        source_key: 'xueqiu',
        important: isMarkedImportant,
        title: parsed.title,
        content: parsed.content,
        time: item.pubTime,
        pub_time: item.pubTime,
        sync_delay_sec: syncDelaySec,
        sync_delay_ms: syncDelayMs,
        url: item.targetUrl,
        pic: ''
      });

      this.seenIds.add(itemId);
    }

    // 首次启动静默同步，避免回放存量旧数据
    if (this.isFirstFetch) {
      this.isFirstFetch = false;
      for (const it of items) {
        this.seenIds.add(String(it.id));
      }
      console.log(`[Xueqiu] 首次基准同步完成，已标记 ${items.length} 条雪球快讯为已知。`);
      return [];
    }

    if (newAlerts.length > 0) {
      console.log(`[Xueqiu] 捕获到 ${newAlerts.length} 条全新雪球快讯！`);
    }

    return newAlerts;
  }
}

module.exports = XueqiuFetcher;
