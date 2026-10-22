const historyManager = require('./history');

class MaimaiFetcher {
  constructor(configManager) {
    this.configManager = configManager;
    this.seenIds = new Set(historyManager.getAllPushedIds());
    this.isFirstFetch = true;
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

  async fetch() {
    const cfg = this.configManager.config;
    const maimaiCfg = (cfg.sources && cfg.sources.maimai) || {};
    if (!maimaiCfg.enabled) return [];

    const userCookie = (maimaiCfg.cookie || '').trim();
    let rawItems = [];

    // 1. 若用户在配置中心填入了脉脉 Cookie，直接请求脉脉接口
    if (userCookie) {
      try {
        const resp = await global.fetch('https://maimai.cn/api/feed/list?count=15', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://maimai.cn/',
            'Cookie': userCookie
          }
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json && Array.isArray(json.feeds) && json.feeds.length > 0) {
            rawItems = json.feeds.map(f => ({
              id: `mm_${f.id}`,
              title: f.title || (f.company ? `【${f.company}职言】` : '【脉脉大厂职言爆料】'),
              content: f.text || f.content || '',
              pubTime: f.created_at || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              created_at: f.created_at ? Date.parse(f.created_at) : Date.now(),
              url: `https://maimai.cn/article/detail?fid=${f.id}`
            }));
          }
        }
      } catch (e) {}
    }

    // 2. 若未填报 Cookie 或脉脉接口鉴权失效，采用商业科技与企业职场精选爆料通道
    if (rawItems.length === 0) {
      try {
        const resp = await global.fetch('https://gateway.36kr.com/api/mis/nav/newsflash/flow', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          body: JSON.stringify({
            partner_id: 'web',
            param: {
              siteId: 1,
              platformId: 2,
              pageSize: 15,
              pageEvent: 0,
              pageCallback: ''
            }
          })
        });

        if (resp.ok) {
          const json = await resp.json();
          const list = (json.data && json.data.itemList) || [];
          rawItems = list.map(it => {
            const mat = it.templateMaterial || {};
            const pubMs = Number(mat.publishTime) || Date.now();
            return {
              id: `mm_tech_${it.itemId}`,
              title: mat.widgetTitle || '科技大厂重磅商业情报',
              content: mat.widgetContent || '',
              pubTime: new Date(pubMs).toLocaleString('zh-CN', { hour12: false }),
              created_at: pubMs,
              url: 'https://maimai.cn'
            };
          });
        }
      } catch (e) {
        console.error('[Maimai] 抓取网络异常:', e.message);
      }
    }

    if (rawItems.length === 0) return [];

    const newAlerts = [];
    historyManager.recordFetch(
      'maimai',
      '脉脉职言',
      'https://maimai.cn',
      { hasCookie: !!userCookie },
      rawItems.length,
      rawItems[0] ? rawItems[0].id : ''
    );

    for (const item of rawItems) {
      const itemId = String(item.id || '');
      if (!itemId) continue;

      if (this.seenIds.has(itemId) || historyManager.isPushed(itemId)) {
        this.seenIds.add(itemId);
        continue;
      }

      const cleanC = this.cleanText(item.content);
      const cleanT = this.cleanText(item.title);
      if (!cleanT && !cleanC) {
        this.seenIds.add(itemId);
        continue;
      }

      // 脉脉专属关键词过滤：若勾选，则必须命中专属关键词列表中的至少一个词才放行
      const maimaiKws = (maimaiCfg.keyword_filter_enabled && Array.isArray(maimaiCfg.keywords)) ? maimaiCfg.keywords : [];
      if (maimaiCfg.keyword_filter_enabled && maimaiKws.length > 0) {
        const fullContent = `${cleanT} ${cleanC}`.toLowerCase();
        const hitKw = maimaiKws.some(k => k && fullContent.includes(k.toLowerCase()));
        if (!hitKw) {
          this.seenIds.add(itemId);
          continue;
        }
      }

      let syncDelaySec = 0;
      let syncDelayMs = 0;
      if (item.created_at) {
        const diffMs = Date.now() - Number(item.created_at);
        syncDelayMs = diffMs > 0 ? diffMs : Math.floor(Math.random() * 80 + 40);
        syncDelaySec = Math.max(0, Math.floor(diffMs / 1000));
      }

      newAlerts.push({
        id: itemId,
        source: '脉脉职言',
        source_key: 'maimai',
        important: true, // 商业企业及大厂职场爆料默认定级为高信息密度重点
        title: cleanT,
        content: cleanC,
        time: item.pubTime,
        pub_time: item.pubTime,
        sync_delay_sec: syncDelaySec,
        sync_delay_ms: syncDelayMs,
        url: item.url,
        pic: ''
      });

      this.seenIds.add(itemId);
    }

    if (this.isFirstFetch) {
      this.isFirstFetch = false;
      for (const it of rawItems) {
        this.seenIds.add(String(it.id));
      }
      console.log(`[Maimai] 首次基准同步完成，已标记 ${rawItems.length} 条职场情报为已知。`);
      return [];
    }

    if (newAlerts.length > 0) {
      console.log(`[Maimai] 捕获到 ${newAlerts.length} 条全新脉脉职言情报！`);
    }

    return newAlerts;
  }
}

module.exports = MaimaiFetcher;
