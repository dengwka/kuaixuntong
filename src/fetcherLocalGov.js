let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

const historyManager = require('./history');
const logger = require('./logger');

const HOUSING_POLICY_KEYWORDS = [
  '楼市', '房地产', '房产', '商品房', '住房发展', '住房补贴', '购房补贴', '购房', '房贷', '公积金',
  '首套房', '二套房', '首付', '限购', '限售', '限价', '商转公', '二手房', '现房销售', '保障性住房',
  '配售型', '白名单', '保交房', '保交楼', '契税', '以旧换新', '房票', '房交会', '地下车位补贴',
  '带押过户', '住宅品质', '第四代住宅', '土拍', '容积率', '土地推介'
];

class LocalGovFetcher {
  constructor(configManager) {
    this.configManager = configManager;
    this.seenIds = new Set(historyManager.getAllPushedIds());
    this.isFirstFetch = true;
    this.lastFetchTime = 0;
  }

  getFetchFn() {
    return (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
  }

  cleanText(rawHtml) {
    if (!rawHtml) return '';
    let s = rawHtml;
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n');
    s = s.replace(/<\/div>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ')
         .replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");
    return s.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  }

  /**
   * 判定公文或问政是否属于全城性质的楼市/房产重磅政策通知
   * 全市楼市政策特权：无视用户选择的区或板块，一律穿透直推
   */
  isCitywideHousingNotice(title = '', rawContent = '', company = '') {
    const text = `${title} ${rawContent} ${company}`.toLowerCase();
    return HOUSING_POLICY_KEYWORDS.some(k => text.includes(k));
  }

  /**
   * 获取综合生效的片区关键词列表（预设词库 + 自定义小区/学校词）
   */
  getKeywordsList(govCfg) {
    const kws = new Set();
    const sub = govCfg.sub_channels || {};

    // 预设板块词
    if (Array.isArray(govCfg.sector_keywords)) {
      govCfg.sector_keywords.forEach(k => { if (k && k.trim()) kws.add(k.trim().toLowerCase()); });
    } else if (typeof govCfg.sector_keywords === 'string') {
      govCfg.sector_keywords.split(/[,，\s]+/).forEach(k => { if (k && k.trim()) kws.add(k.trim().toLowerCase()); });
    }

    // 自定义小区/关注词
    if (typeof govCfg.custom_keywords === 'string') {
      govCfg.custom_keywords.split(/[,，\s]+/).forEach(k => { if (k && k.trim()) kws.add(k.trim().toLowerCase()); });
    }

    // 如果启用了地铁子栏目，自动补充轨道交通关键词
    if (sub.metro !== false) {
      ['地铁', '轨道交通', '磁浮', '城际铁路'].forEach(k => kws.add(k));
    }

    return Array.from(kws);
  }

  /**
   * 1. 抓取红网《问政湖南》官方问答
   */
  async fetchWenzheng(govCfg, isTest = false) {
    const fetchFn = this.getFetchFn();
    const isCitywide = !govCfg.district_id || govCfg.district_id === '430100' || govCfg.district_name === '全市' || (govCfg.district_name && govCfg.district_name.includes('全市'));
    const areaId = isCitywide ? '430100' : (govCfg.district_id || '430103');
    const keywords = this.getKeywordsList(govCfg);
    const onlyReplied = !!govCfg.only_replied;
    const scopeMode = govCfg.scope_mode || 'sector';

    const url = 'https://wzapi.rednet.cn/front/msg/index';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://wz.rednet.cn',
          'Referer': 'https://wz.rednet.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: JSON.stringify({ page: 1, limit: 20, area_id: areaId }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) return [];

      const json = await res.json();
      const rows = (json.data && json.data.rows) || [];
      const alerts = [];

      for (const r of rows) {
        const id = String(r.id);
        const fullId = `local_gov_wz_${id}`;

        if (!isTest && this.seenIds.has(fullId)) {
          continue;
        }

        // 仅看已官方实名回复
        if (onlyReplied && r.is_reply !== '1') {
          continue;
        }

        const title = (r.title || '').trim();
        const rawContent = (r.content || '').trim();
        const company = (r.company || govCfg.district_name || '官方部门').trim();
        const combinedText = `${title} ${rawContent} ${company}`.toLowerCase();
        const isHousing = this.isCitywideHousingNotice(title, rawContent, company);

        // 整个楼市/房地产通识政策特权穿透：不论选哪个区或板块，均强制放行通知！
        if (isHousing) {
          // 楼市新政免过滤直接通过
        } else if (scopeMode === 'sector' && keywords.length > 0) {
          // 常规精准板块模式下，过滤匹配关键词；若为全区通报模式则无死角全推
          const matched = keywords.some(k => combinedText.includes(k));
          if (!matched) {
            this.seenIds.add(fullId);
            continue;
          }
        }

        const pubTime = r.publish_at || r.created_at || new Date().toISOString();
        let syncDelaySec = 60;
        try {
          const pubMs = new Date(pubTime.replace(/-/g, '/')).getTime();
          if (!isNaN(pubMs)) {
            syncDelaySec = Math.max(0, Math.floor((Date.now() - pubMs) / 1000));
          }
        } catch (e) {}

        const cleanC = this.cleanText(rawContent);
        const previewContent = cleanC.length > 200 ? cleanC.substring(0, 200) + '...' : cleanC;
        const replyTag = r.is_reply === '1' ? '【已官方回复】' : '【官方已受理】';

        let subSource = '民生问答';
        if (isHousing) {
          subSource = '楼市新政';
        } else if (title.includes('地铁') || rawContent.includes('地铁') || title.includes('轨道交通')) {
          subSource = '地铁规划';
        }

        alerts.push({
          id: fullId,
          source: '本地周边',
          source_key: 'local_gov',
          sub_source: subSource,
          important: false,
          title: `【${company}】${title}`,
          content: `${replyTag}\n${previewContent}`,
          time: pubTime,
          pub_time: pubTime,
          sync_delay_sec: syncDelaySec,
          url: `https://wz.rednet.cn/#/msgDetails?id=${id}`,
          district: govCfg.district_name || '天心区',
          raw_data: r
        });

        this.seenIds.add(fullId);
      }

      return alerts;
    } catch (e) {
      logger.error('[LocalGov] 抓取问政湖南异常:', e.message);
      return [];
    }
  }

  /**
   * 2. 抓取长沙市自然资源和规划局批前公示与控规修改
   */
  async fetchZyghPlanning(govCfg, isTest = false) {
    const fetchFn = this.getFetchFn();
    const isCitywide = !govCfg.district_id || govCfg.district_id === '430100' || govCfg.district_name === '全市' || (govCfg.district_name && govCfg.district_name.includes('全市'));
    const districtName = govCfg.district_name || '天心区';
    const keywords = this.getKeywordsList(govCfg);
    const scopeMode = govCfg.scope_mode || 'sector';

    const url = 'http://zygh.changsha.gov.cn/zfxxgk/tzgg_1/ghgs/ghgs/';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetchFn(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) return [];

      const html = await res.text();
      // 正则匹配每条规划公示项：<li><strong style="...">【天心区】</strong><a href="./202610/t20261027_12601071.html">标题</a><span>2026-10-27</span></li>
      const pattern = /<li><strong[^>]*>【(.*?)】<\/strong><a\s+href="([^"]+)">([^<]+)<\/a><span>([^<]+)<\/span><\/li>/gi;
      const matches = Array.from(html.matchAll(pattern));
      const alerts = [];

      for (const m of matches) {
        const itemDistrict = m[1].trim();
        const relHref = m[2].trim();
        const rawTitle = m[3].trim();
        const dateStr = m[4].trim();

        // 提取文章唯一 ID
        const idMatch = relHref.match(/t\d+_(\d+)\.html/);
        const docId = idMatch ? idMatch[1] : relHref.replace(/[^a-zA-Z0-9]/g, '');
        const fullId = `local_gov_zygh_${docId}`;

        if (!isTest && this.seenIds.has(fullId)) {
          continue;
        }

        const isHousing = this.isCitywideHousingNotice(rawTitle);

        // 整个楼市/土拍等通识政策特权穿透：不论选哪个区或板块，均强制放行通知！
        if (isHousing) {
          // 楼市新政免过滤直接通过
        } else {
          // 仅筛选用户配置的行政区（若非全市范围）
          if (!isCitywide && itemDistrict !== districtName && !rawTitle.includes(districtName)) {
            this.seenIds.add(fullId);
            continue;
          }

          // 精准板块模式下，进一步过滤匹配关键词；若为全区通报模式则无死角全推
          if (scopeMode === 'sector' && keywords.length > 0) {
            const hitSector = keywords.some(k => rawTitle.toLowerCase().includes(k));
            if (!hitSector) {
              this.seenIds.add(fullId);
              continue;
            }
          }
        }

        // 拼接完整的官方直达链接（直达规划局红头文件与图纸）
        let directUrl = relHref;
        if (!directUrl.startsWith('http')) {
          directUrl = new URL(relHref, url).href;
        }

        let syncDelaySec = 60;
        try {
          const dMs = new Date(dateStr.replace(/-/g, '/')).getTime();
          if (!isNaN(dMs)) {
            syncDelaySec = Math.max(0, Math.floor((Date.now() - dMs) / 1000));
          }
        } catch (e) {}

        let subSource = '规划公示';
        if (isHousing) {
          subSource = '楼市新政';
        } else if (rawTitle.includes('地铁') || rawTitle.includes('轨道交通')) {
          subSource = '地铁规划';
        }

        alerts.push({
          id: fullId,
          source: '本地周边',
          source_key: 'local_gov',
          sub_source: subSource,
          important: true,
          title: `【${itemDistrict}】${rawTitle}`,
          content: `长沙市自然资源和规划局发布法定规划公示，涉及地块规划修改与建设工程总平面图方案。点击卡片可直接调取官方原网页查验图纸原件与红线图。`,
          time: `${dateStr} 09:00:00`,
          pub_time: `${dateStr} 09:00:00`,
          sync_delay_sec: syncDelaySec,
          url: directUrl,
          district: itemDistrict,
          raw_data: { district: itemDistrict, title: rawTitle, date: dateStr, url: directUrl }
        });

        this.seenIds.add(fullId);
      }

      return alerts;
    } catch (e) {
      logger.error('[LocalGov] 抓取自然资源和规划局公示异常:', e.message);
      return [];
    }
  }

  /**
   * 3. 抓取长沙市住房和城乡建设局（住建局官网）全市楼市新政与规范性文件
   * 无论用户选择哪个区或板块，全市楼市新政全城无死角特权直通！
   */
  async fetchSzjwHousing(govCfg, isTest = false) {
    const fetchFn = this.getFetchFn();
    const urls = [
      'http://szjw.changsha.gov.cn/zfxxgk/fdzdgknr/lzyj/gfxwj/',
      'http://szjw.changsha.gov.cn/zfxxgk/tzgg/tzgg_37612/'
    ];
    const alerts = [];

    for (const pageUrl of urls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetchFn(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) continue;

        const html = await res.text();
        const liPattern = /<li>([\s\S]*?)<\/li>/gi;
        let liMatch;

        while ((liMatch = liPattern.exec(html)) !== null) {
          const liContent = liMatch[1];
          const aMatch = liContent.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          const spanMatch = liContent.match(/<span>([^<]+)<\/span>/i);

          if (aMatch && spanMatch) {
            const relHref = aMatch[1].trim();
            const rawTitle = aMatch[2].replace(/<[^>]+>/g, '').trim();
            const dateStr = spanMatch[1].trim();

            if (!relHref.includes('.html') || !relHref.includes('t20')) continue;

            const idMatch = relHref.match(/t\d+_(\d+)\.html/);
            const docId = idMatch ? idMatch[1] : relHref.replace(/[^a-zA-Z0-9]/g, '');
            const fullId = `local_gov_szjw_${docId}`;

            if (!isTest && this.seenIds.has(fullId)) {
              continue;
            }

            // 检查是否属于全市楼市/房产相关政策
            if (!this.isCitywideHousingNotice(rawTitle)) {
              continue;
            }

            let directUrl = relHref;
            if (!directUrl.startsWith('http')) {
              directUrl = new URL(relHref, pageUrl).href;
            }

            let syncDelaySec = 60;
            try {
              const dMs = new Date(dateStr.replace(/-/g, '/')).getTime();
              if (!isNaN(dMs)) {
                syncDelaySec = Math.max(0, Math.floor((Date.now() - dMs) / 1000));
              }
            } catch (e) {}

            alerts.push({
              id: fullId,
              source: '本地周边',
              source_key: 'local_gov',
              sub_source: '楼市新政',
              important: true, // 全市楼市重大政策具有最高全城穿透度
              title: `【长沙住建局】${rawTitle}`,
              content: `【全市楼市重磅新政/政策文件】\n发文单位: 长沙市住房和城乡建设局\n发布日期: ${dateStr}\n重要提示: 属于全市房地产通识政策，已自动穿透行政区与板块限制直达推送。`,
              time: `${dateStr} 09:00:00`,
              pub_time: `${dateStr} 09:00:00`,
              sync_delay_sec: syncDelaySec,
              url: directUrl,
              district: '全市通用',
              is_housing_policy: true,
              raw_data: { district: '全市通用', title: rawTitle, date: dateStr, url: directUrl }
            });

            this.seenIds.add(fullId);
          }
        }
      } catch (err) {
        logger.warn(`[LocalGov] 抓取住建局楼市新政异常 (${pageUrl}): ${err.message}`);
      }
    }

    return alerts;
  }

  /**
   * 综合轮询抓取
   */
  async fetch(isTest = false, overrideCfg = null) {
    const cfg = this.configManager ? this.configManager.config : {};
    const govCfg = overrideCfg || cfg.sources?.local_gov || {};

    if (govCfg.enabled === false && !isTest) {
      return [];
    }

    const sub = govCfg.sub_channels || { planning: true, wenzheng: true, metro: true, housing_policy: true };
    const promises = [];

    // 1. 规资局规划公示
    if (sub.planning !== false) {
      promises.push(this.fetchZyghPlanning(govCfg, isTest));
    }

    // 2. 红网问政湖南
    if (sub.wenzheng !== false) {
      promises.push(this.fetchWenzheng(govCfg, isTest));
    }

    // 3. 全市楼市新政与住建政策直通
    if (sub.housing_policy !== false) {
      promises.push(this.fetchSzjwHousing(govCfg, isTest));
    }

    const results = await Promise.allSettled(promises);
    const alerts = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        alerts.push(...r.value);
      }
    }

    // 首次启动时记录存量 ID，杜绝回放历史公告骚扰用户
    if (this.isFirstFetch && !isTest) {
      this.isFirstFetch = false;
      for (const a of alerts) {
        this.seenIds.add(a.id);
      }
      logger.info(`[LocalGov] 首次启动基准同步完成，已标记 ${alerts.length} 条存量政务与问政记录为已知。`);
      return [];
    }

    if (alerts.length > 0) {
      logger.info(`[LocalGov] 捕获到 ${alerts.length} 条全新本地周边规划与问政信息！`);
    }

    return alerts;
  }
}

module.exports = LocalGovFetcher;
