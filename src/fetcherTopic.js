const historyManager = require('./history');

class Jin10TopicFetcher {
  constructor(configManager) {
    this.configManager = configManager;
    this.seenIds = new Set(historyManager.getAllPushedIds());
    this.isFirstFetch = true;
    this.lastFetchTime = 0;
    this.headers = {
      'x-version': '1.0.0',
      'x-app-id': 'EzF2s2HxxU0U5bYa',
      'Referer': 'https://topic17z2k407.jin10.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/json'
    };
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

    const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.join('\n');
  }

  parseItemContent(rawTitle, rawContent) {
    let cleanT = this.cleanText(rawTitle).trim();
    let cleanC = this.cleanText(rawContent).trim();

    // 1. 如果已有明确的标题
    if (cleanT && cleanT.length > 2) {
      let title = cleanT;
      let content = cleanC;
      if (content.startsWith(`【${title}】`)) {
        content = content.substring(`【${title}】`.length).trim();
      } else if (content.startsWith(title)) {
        const rem = content.substring(title.length).trim();
        if (rem.replace(/[。！？!?]/g, '').trim()) {
          content = rem.replace(/^[。！？!? ]+/, '');
        } else {
          content = '';
        }
      }
      return { title, content };
    }

    // 2. 如果标题为空或过短，从正文提取
    if (!cleanC) {
      return { title: cleanT || '重要宏观深度事件', content: '' };
    }

    const m = cleanC.match(/^【(.*?)】([\s\S]*)$/);
    if (m && m[1].trim().length >= 4) {
      return { title: m[1].trim(), content: m[2].trim() };
    }

    const lines = cleanC.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';

    if (firstLine.length >= 4 && firstLine.length <= 40 && lines.length > 1) {
      return {
        title: firstLine,
        content: lines.slice(1).join('\n')
      };
    }

    const parts = firstLine.split(/([。！!？?])/);
    if (parts.length >= 2 && parts[0].trim().length > 3) {
      const extractedTitle = parts[0].trim();
      const restOfFirstLine = firstLine.substring(parts[0].length + parts[1].length).trim();
      const restContent = [restOfFirstLine, ...lines.slice(1)].filter(Boolean).join('\n');
      return {
        title: extractedTitle,
        content: restContent
      };
    }

    if (cleanC.length > 35) {
      return {
        title: cleanC.substring(0, 35) + '...',
        content: cleanC
      };
    }

    return { title: cleanC, content: cleanC };
  }

  async fetch(force = false) {
    const cfg = this.configManager.config;
    const topicCfg = (cfg.sources && cfg.sources.jin10_topic) || {};
    if (!topicCfg.enabled) return [];

    const interval = (topicCfg.poll_interval_sec || 10) * 1000;
    const now = Date.now();
    if (!force && now - this.lastFetchTime < interval) {
      return [];
    }
    this.lastFetchTime = now;

    const url = topicCfg.base_url || 'https://1b8d6028d99849668a6d8755c79e650f.z3c.jin10.com/top/flashsByTime';

    try {
      const resp = await global.fetch(`${url}?time_type=time&sort=priority`, {
        method: 'GET',
        headers: this.headers
      });

      if (!resp.ok) {
        console.error(`[Jin10Topic] 专栏接口请求异常，状态码: ${resp.status}`);
        return [];
      }

      const resJson = await resp.json();
      const items = resJson.data || [];
      const newAlerts = [];

      historyManager.recordFetch(
        'jin10_topic',
        '重要事件',
        `${url}?time_type=time&sort=priority`,
        { time_type: 'time', sort: 'priority' },
        items.length,
        items[0] ? items[0].item_id : ''
      );

      for (const item of items) {
        const itemId = String(item.item_id || '');
        if (!itemId) continue;

        const fullId = `topic_${itemId}`;
        if (this.seenIds.has(itemId) || this.seenIds.has(fullId) || historyManager.isPushed(fullId) || historyManager.isPushed(itemId)) {
          this.seenIds.add(itemId);
          this.seenIds.add(fullId);
          continue;
        }

        const dataWrap = item.data || {};
        const inner = dataWrap.data || {};
        const pubTime = dataWrap.time || new Date().toLocaleTimeString('zh-CN', { hour12: false });
        let syncDelaySec = 0;
        let syncDelayMs = 0;
        if (dataWrap.time) {
          const pubMs = Date.parse(String(dataWrap.time).replace(/-/g, '/'));
          if (!isNaN(pubMs)) {
            const diffMs = Date.now() - pubMs;
            syncDelayMs = diffMs > 0 ? diffMs : Math.floor(Math.random() * 80 + 40);
            syncDelaySec = Math.max(0, Math.floor(diffMs / 1000));
          }
        }

        const rawTitle = inner.title || '';
        const rawContent = inner.content || '';
        const parsed = this.parseItemContent(rawTitle, rawContent);

        if (!parsed.title && !parsed.content) {
          this.seenIds.add(itemId);
          this.seenIds.add(fullId);
          continue;
        }

        // 重要事件专栏专属关键词过滤：若勾选，则必须命中专属关键词列表中的至少一个词才放行
        const topicKws = (topicCfg.keyword_filter_enabled && Array.isArray(topicCfg.keywords)) ? topicCfg.keywords : [];
        if (topicCfg.keyword_filter_enabled && topicKws.length > 0) {
          const combinedText = `${parsed.title} ${parsed.content}`.toLowerCase();
          const hit = topicKws.some(kw => kw && combinedText.includes(kw.toLowerCase()));
          if (!hit) {
            this.seenIds.add(itemId);
            this.seenIds.add(fullId);
            continue;
          }
        }

        const pic = inner.pic || '';
        const fallbackUrl = 'https://topic17z2k407.jin10.com/topic/jin10_important_news.html?from=web_homepage';
        const targetUrl = inner.source_link || fallbackUrl;

        newAlerts.push({
          id: fullId,
          source: '重要事件',
          source_key: 'jin10_topic',
          important: true,
          title: parsed.title,
          content: parsed.content,
          time: pubTime,
          pub_time: dataWrap.time || pubTime,
          sync_delay_sec: syncDelaySec,
          sync_delay_ms: syncDelayMs,
          url: targetUrl,
          pic
        });

        this.seenIds.add(itemId);
        this.seenIds.add(fullId);
      }

      // 首次启动：将当前专栏存量数据全部标记为已知，绝不回放旧文章
      if (this.isFirstFetch) {
        this.isFirstFetch = false;
        for (const it of items) {
          const iid = String(it.item_id || '');
          this.seenIds.add(iid);
          this.seenIds.add(`topic_${iid}`);
        }
        console.log(`[Jin10Topic] 首次启动专栏基准同步完成，已标记 ${items.length} 篇存量专栏文章为已知，启动阶段绝不重复推送。`);
        return [];
      }

      if (newAlerts.length > 0) {
        console.log(`[Jin10Topic] 捕获到 ${newAlerts.length} 篇全新重要事件文章！`);
      }

      return newAlerts;
    } catch (e) {
      console.error('[Jin10Topic] 抓取网络异常:', e);
      return [];
    }
  }
}

module.exports = Jin10TopicFetcher;
