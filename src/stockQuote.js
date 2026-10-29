let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

const logger = require('./logger');

// 标准贵金属标的预设库（包含品牌金饰、上金所基准、国际现货）
const PRECIOUS_METALS = [
  {
    code: 'JEWELRY_GOLD',
    symbol: 'brand_gold',
    name: '品牌金饰均价',
    market: '贵金属',
    display: '品牌金饰均价 (周大福/老凤祥足金饰品价 ~940+元/克)',
    keywords: ['黄金', '金价', '金饰', '首饰金', '饰品金', '足金', '周大福', '老凤祥', '900', '940', 'gold', 'jewelry']
  },
  {
    code: 'AU9999',
    symbol: 'gds_AU9999',
    name: '国内黄金基准',
    market: '贵金属',
    display: '上海金交所 Au9999 (国内金价基准 ~869元/克)',
    keywords: ['黄金', '金价', 'au9999', '沪金', '上金所', '上海金', '9999', 'gold']
  },
  {
    code: 'XAU',
    symbol: 'hf_XAU',
    name: '现货黄金',
    market: '贵金属',
    display: '现货黄金 (国际伦敦金 XAU $/盎司)',
    keywords: ['黄金', '金价', 'xau', '伦敦金', '国际金', '美黄金', '现货金', 'gold']
  },
  {
    code: 'AUTD',
    symbol: 'gds_AUTD',
    name: '黄金延期',
    market: '贵金属',
    display: '黄金延期 Au(T+D) (上金所现货延期)',
    keywords: ['黄金', '金价', 'autd', 'au(t+d)', '延期金', 'gold']
  },
  {
    code: 'AGTD',
    symbol: 'gds_AGTD',
    name: '国内白银',
    market: '贵金属',
    display: '国内白银 Ag(T+D) (上金所现货白银 ~13元/克)',
    keywords: ['白银', '银价', 'agtd', 'ag(t+d)', '白银延期', 'silver', 'ag']
  },
  {
    code: 'XAG',
    symbol: 'hf_XAG',
    name: '现货白银',
    market: '贵金属',
    display: '现货白银 (国际伦敦银 XAG $/盎司)',
    keywords: ['白银', '银价', 'xag', '伦敦银', '国际银', '美白银', '现货银', 'silver']
  },
  {
    code: 'PT9995',
    symbol: 'gds_PT9995',
    name: '国内铂金',
    market: '贵金属',
    display: '国内铂金 Pt9995 (上金所现货铂金 ~378元/克)',
    keywords: ['铂金', '白金', 'pt9995', '沪铂', 'platinum', 'pt']
  },
  {
    code: 'XPT',
    symbol: 'hf_XPT',
    name: '现货铂金',
    market: '贵金属',
    display: '现货铂金 (纽约现货铂金 XPT $/盎司)',
    keywords: ['铂金', '白金', 'xpt', '纽约铂', '国际铂', '现货铂', 'platinum']
  }
];

class StockQuoteManager {
  constructor() {
    this.cache = new Map(); // symbol.toLowerCase() -> { data, timestamp }
    this.cacheTtlMs = 15000; // 15秒缓存
    this.defaultStocks = [
      { code: '00700', symbol: 'r_hk00700', name: '腾讯控股', market: '港股' },
      { code: 'JD', symbol: 'usJD', name: '京东', market: '美股' }
    ];
  }

  /**
   * 判断一个 symbol 是否为贵金属品种
   */
  isPreciousMetalSymbol(symbol) {
    if (!symbol) return false;
    const s = String(symbol).toLowerCase();
    return s.startsWith('gds_') ||
           s.startsWith('hf_') ||
           s === 'brand_gold' ||
           s === 'shbk1617' ||
           s === 'bk1617' ||
           s === 'au9999' ||
           s === 'autd' ||
           s === 'agtd' ||
           s === 'pt9995' ||
           s === 'xau' ||
           s === 'xag' ||
           s === 'xpt';
  }

  /**
   * 自动联想搜索代码（支持输入“黄金”、“金价”、“白银”、“铂金”、“腾讯”、“京东”、“茅台”、“苹果”等）
   */
  async searchStock(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim().toLowerCase();

    // 1. 匹配标准贵金属标的
    const matchedMetals = [];
    for (const m of PRECIOUS_METALS) {
      const codeMatch = m.code.toLowerCase().includes(q);
      const nameMatch = m.name.toLowerCase().includes(q);
      const kwMatch = m.keywords && m.keywords.some(k => q.includes(k) || k.includes(q));
      if (codeMatch || nameMatch || kwMatch) {
        matchedMetals.push({
          code: m.code,
          name: m.name,
          market: m.market,
          symbol: m.symbol,
          display: `${m.name} (${m.code} · ${m.market})`
        });
      }
    }

    // 2. 请求东财股票联想接口
    let stockResults = [];
    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
      const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(query.trim())}&type=14`;
      const res = await fetchFn(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.ok) {
        const json = await res.json();
        const rawList = (json && json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];
        
        for (const item of rawList.slice(0, 8)) {
          const code = item.Code;
          const name = item.Name;
          const mkt = item.SecurityTypeName || '';
          const jys = (item.JYS || '').toUpperCase();

          // 如果东财搜索返回了黄金行业板块 BK1617，自动推荐标准贵金属，避免板块代码无腾讯行情
          if (code === 'BK1617') {
            continue;
          }

          let symbol = '';
          let marketCategory = 'A股';

          if (jys === 'HK' || mkt.includes('港')) {
            symbol = `r_hk${code}`;
            marketCategory = '港股';
          } else if (jys === 'NASDAQ' || jys === 'NYSE' || jys === 'AMEX' || mkt.includes('美')) {
            symbol = `us${code}`;
            marketCategory = '美股';
          } else if (code.startsWith('60') || code.startsWith('688') || code.startsWith('900') || jys === 'SH') {
            symbol = `sh${code}`;
            marketCategory = 'A股(沪)';
          } else if (code.startsWith('00') || code.startsWith('30') || code.startsWith('200') || jys === 'SZ') {
            symbol = `sz${code}`;
            marketCategory = 'A股(深)';
          } else if (code.startsWith('8') || code.startsWith('4') || jys === 'BJ') {
            symbol = `bj${code}`;
            marketCategory = 'A股(北)';
          } else {
            symbol = `sh${code}`;
          }

          stockResults.push({
            code,
            name,
            market: marketCategory,
            symbol,
            display: `${name} (${code} · ${marketCategory})`
          });
        }
      }
    } catch (e) {
      logger.error('[StockQuote] 搜索联想异常:', e.message);
    }

    // 贵金属标的置于最前面，优先满足用户对“黄金/白银/铂金”的直接查询诉求
    return [...matchedMetals, ...stockResults];
  }

  /**
   * 专门获取新浪财经贵金属行情（上金所 + 国际现货 + 品牌金饰）
   */
  async fetchPreciousQuotes(symbols) {
    if (!symbols || symbols.length === 0) return [];

    const now = Date.now();
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    // 收集所有需要请求新浪的底层代码
    const sinaQueryList = new Set();
    const needsBrandGold = symbols.some(s => {
      const lower = s.toLowerCase();
      return lower === 'brand_gold' || lower === 'shbk1617' || lower === 'bk1617';
    });

    if (needsBrandGold) {
      sinaQueryList.add('gds_AU9999');
    }

    for (const sym of symbols) {
      const lower = sym.toLowerCase();
      if (lower.startsWith('gds_') || lower.startsWith('hf_')) {
        sinaQueryList.add(sym);
      } else if (lower === 'au9999') {
        sinaQueryList.add('gds_AU9999');
      } else if (lower === 'autd') {
        sinaQueryList.add('gds_AUTD');
      } else if (lower === 'agtd') {
        sinaQueryList.add('gds_AGTD');
      } else if (lower === 'pt9995') {
        sinaQueryList.add('gds_PT9995');
      } else if (lower === 'xau') {
        sinaQueryList.add('hf_XAU');
      } else if (lower === 'xag') {
        sinaQueryList.add('hf_XAG');
      } else if (lower === 'xpt') {
        sinaQueryList.add('hf_XPT');
      }
    }

    if (sinaQueryList.size === 0) return [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const url = `https://hq.sinajs.cn/list=${Array.from(sinaQueryList).join(',')}`;
      const res = await fetchFn(url, {
        headers: {
          'Referer': 'https://finance.sina.com.cn',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) return [];

      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const lines = text.trim().split(';').map(l => l.trim()).filter(Boolean);

      const sinaMap = {};
      for (const line of lines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const varName = line.substring(0, eqIdx).replace(/^var\s+hq_str_/, '').trim();
        const strVal = line.substring(eqIdx + 2, line.length - 1);
        const parts = strVal.split(',');
        sinaMap[varName.toLowerCase()] = parts;
      }

      const quotes = [];

      for (const reqSym of symbols) {
        const lower = reqSym.toLowerCase();

        // 1. 品牌首饰金价 (周大福/老凤祥足金约 940+元/克)
        // 自动兼容用户之前误加的板块代码 shBK1617 / BK1617
        if (lower === 'brand_gold' || lower === 'shbk1617' || lower === 'bk1617') {
          const auParts = sinaMap['gds_au9999'];
          if (auParts && auParts.length > 7) {
            const auPrice = parseFloat(auParts[0]) || 0;
            const auPrev = parseFloat(auParts[7]) || auPrice;
            // 品牌金店基础工费与溢价约为 +75元/克 (869 + 75 = 944元/克)
            const brandPrice = auPrice + 75;
            const brandPrev = auPrev + 75;
            const brandDiff = auPrice - auPrev;
            const brandPct = brandPrev > 0 ? (brandDiff / brandPrev) * 100 : 0;

            const qObj = {
              symbol: reqSym,
              rawSymbol: lower,
              code: '金饰',
              name: '品牌金价',
              market: '贵金属',
              price: brandPrice.toFixed(2),
              changeAmount: brandDiff >= 0 ? `+${brandDiff.toFixed(2)}` : brandDiff.toFixed(2),
              changePercent: brandPct >= 0 ? `+${brandPct.toFixed(2)}%` : `${brandPct.toFixed(2)}%`,
              isUp: brandPct >= 0,
              currency: '¥'
            };
            quotes.push(qObj);
            this.cache.set(lower, { data: qObj, timestamp: now });
            this.cache.set('brand_gold', { data: qObj, timestamp: now });
            this.cache.set('shbk1617', { data: qObj, timestamp: now });
            this.cache.set('bk1617', { data: qObj, timestamp: now });
            this.cache.set('jewelry_gold', { data: qObj, timestamp: now });
          }
          continue;
        }

        // 2. 国内金交所品种 (gds_AU9999, gds_AUTD, gds_AGTD, gds_PT9995)
        let matchedSinaKey = null;
        if (lower.startsWith('gds_')) matchedSinaKey = lower;
        else if (lower === 'au9999') matchedSinaKey = 'gds_au9999';
        else if (lower === 'autd') matchedSinaKey = 'gds_autd';
        else if (lower === 'agtd') matchedSinaKey = 'gds_agtd';
        else if (lower === 'pt9995') matchedSinaKey = 'gds_pt9995';

        if (matchedSinaKey && sinaMap[matchedSinaKey]) {
          const parts = sinaMap[matchedSinaKey];
          let price = parseFloat(parts[0]) || 0;
          let prevClose = parseFloat(parts[7]) || price;

          let name = '黄金';
          let code = 'AU9999';
          let isSilver = false;

          if (matchedSinaKey.includes('au9999')) {
            name = '国内金价';
            code = 'Au9999';
          } else if (matchedSinaKey.includes('autd')) {
            name = '黄金延期';
            code = 'Au(T+D)';
          } else if (matchedSinaKey.includes('agtd')) {
            name = '国内白银';
            code = 'Ag(T+D)';
            isSilver = true;
          } else if (matchedSinaKey.includes('pt9995')) {
            name = '国内铂金';
            code = 'Pt9995';
          }

          // 白银延期在新浪返回为元/千克(例如13000)，折算为元/克(13.00)，使价格直观易读
          if (isSilver && price > 500) {
            price = price / 1000;
            prevClose = prevClose / 1000;
          }

          const diff = price - prevClose;
          const pct = prevClose > 0 ? (diff / prevClose) * 100 : 0;

          const qObj = {
            symbol: reqSym,
            rawSymbol: matchedSinaKey,
            code,
            name,
            market: '贵金属',
            price: price.toFixed(2),
            changeAmount: diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2),
            changePercent: pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`,
            isUp: pct >= 0,
            currency: '¥'
          };
          quotes.push(qObj);
          this.cache.set(lower, { data: qObj, timestamp: now });
          this.cache.set(matchedSinaKey, { data: qObj, timestamp: now });
          continue;
        }

        // 3. 国际现货品种 (hf_XAU, hf_XAG, hf_XPT)
        let matchedHfKey = null;
        if (lower.startsWith('hf_')) matchedHfKey = lower;
        else if (lower === 'xau') matchedHfKey = 'hf_xau';
        else if (lower === 'xag') matchedHfKey = 'hf_xag';
        else if (lower === 'xpt') matchedHfKey = 'hf_xpt';

        if (matchedHfKey && sinaMap[matchedHfKey]) {
          const parts = sinaMap[matchedHfKey];
          const price = parseFloat(parts[0]) || 0;
          const prevClose = parseFloat(parts[7]) || price;

          let name = '现货黄金';
          let code = 'XAU';
          if (matchedHfKey.includes('xau')) {
            name = '伦敦金';
            code = 'XAU';
          } else if (matchedHfKey.includes('xag')) {
            name = '伦敦银';
            code = 'XAG';
          } else if (matchedHfKey.includes('xpt')) {
            name = '纽约铂金';
            code = 'XPT';
          }

          const diff = price - prevClose;
          const pct = prevClose > 0 ? (diff / prevClose) * 100 : 0;

          const qObj = {
            symbol: reqSym,
            rawSymbol: matchedHfKey,
            code,
            name,
            market: '贵金属',
            price: price >= 100 ? price.toFixed(2) : price.toFixed(2),
            changeAmount: diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2),
            changePercent: pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`,
            isUp: pct >= 0,
            currency: '$'
          };
          quotes.push(qObj);
          this.cache.set(lower, { data: qObj, timestamp: now });
          this.cache.set(matchedHfKey, { data: qObj, timestamp: now });
          continue;
        }
      }

      return quotes;
    } catch (e) {
      logger.error('[StockQuote] 获取贵金属行情异常:', e.message);
      return [];
    }
  }

  /**
   * 批量查询行情（支持 A股 / 港股 / 美股 + 黄金白银等贵金属）
   * @param {Array<string>} symbols - 形如 ['brand_gold', 'r_hk00700', 'usJD', 'sh600519']
   */
  async getQuotes(symbols = []) {
    let cleanSymbols = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
    if (cleanSymbols.length === 0) {
      cleanSymbols = this.defaultStocks.map(s => s.symbol);
    }

    const now = Date.now();
    const needFetchStockSymbols = [];
    const needFetchMetalSymbols = [];
    const cachedQuotes = [];

    for (const sym of cleanSymbols) {
      const cached = this.cache.get(sym.toLowerCase());
      if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
        cachedQuotes.push(cached.data);
      } else {
        if (this.isPreciousMetalSymbol(sym)) {
          needFetchMetalSymbols.push(sym);
        } else {
          needFetchStockSymbols.push(sym);
        }
      }
    }

    // 全部在 15s 缓存内，立即返回缓存（0延迟，杜绝弹窗卡顿）
    if (needFetchStockSymbols.length === 0 && needFetchMetalSymbols.length === 0 && cachedQuotes.length > 0) {
      return this._orderQuotes(cachedQuotes, cleanSymbols);
    }

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    // 并行拉取腾讯股票行情与新浪贵金属行情
    const fetchPromises = [];

    // 1. 腾讯股票行情查询
    if (needFetchStockSymbols.length > 0) {
      fetchPromises.push((async () => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);

          const url = `https://qt.gtimg.cn/q=${needFetchStockSymbols.join(',')}`;
          const res = await fetchFn(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            signal: controller.signal
          });
          clearTimeout(timer);
          if (!res.ok) return [];

          const buf = await res.arrayBuffer();
          const text = new TextDecoder('gbk').decode(buf);
          const lines = text.trim().split(';').filter(Boolean);

          const stockQuotes = [];
          for (const line of lines) {
            const idx = line.indexOf('=');
            if (idx === -1) continue;
            const rawId = line.substring(0, idx).trim();
            const cleanId = rawId.replace(/^v_+/, '');
            const matchedReqSymbol = needFetchStockSymbols.find(s => s.toLowerCase() === cleanId.toLowerCase()) || cleanId;
            const rawVal = line.substring(idx + 2, line.length - 1);
            const parts = rawVal.split('~');

            if (parts.length > 32) {
              const name = parts[1] || '';
              const code = parts[2] || '';
              const price = parseFloat(parts[3]) || 0;
              const changeAmount = parseFloat(parts[31]) || 0;
              const changePercent = parseFloat(parts[32]) || 0;

              let currency = '¥';
              let mkt = 'A股';
              if (cleanId.includes('hk')) {
                currency = 'HK$';
                mkt = '港股';
              } else if (cleanId.includes('us')) {
                currency = '$';
                mkt = '美股';
              }

              const qObj = {
                symbol: matchedReqSymbol,
                rawSymbol: cleanId,
                code,
                name,
                market: mkt,
                price: price.toFixed(price >= 100 ? 2 : (price >= 1 ? 2 : 3)),
                changeAmount: changeAmount >= 0 ? `+${changeAmount.toFixed(2)}` : changeAmount.toFixed(2),
                changePercent: changePercent >= 0 ? `+${changePercent.toFixed(2)}%` : `${changePercent.toFixed(2)}%`,
                isUp: changePercent >= 0,
                currency
              };

              stockQuotes.push(qObj);
              this.cache.set(matchedReqSymbol.toLowerCase(), { data: qObj, timestamp: now });
              this.cache.set(cleanId.toLowerCase(), { data: qObj, timestamp: now });
            }
          }
          return stockQuotes;
        } catch (e) {
          logger.error('[StockQuote] 获取股票行情异常:', e.message);
          return [];
        }
      })());
    }

    // 2. 新浪贵金属行情查询
    if (needFetchMetalSymbols.length > 0) {
      fetchPromises.push(this.fetchPreciousQuotes(needFetchMetalSymbols));
    }

    const results = await Promise.allSettled(fetchPromises);
    const newQuotes = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        newQuotes.push(...r.value);
      }
    }

    // 合并新获取的行情与原本命中的缓存行情
    const allQuotesMap = new Map();
    for (const q of cachedQuotes) {
      if (q && q.symbol) allQuotesMap.set(q.symbol.toLowerCase(), q);
      if (q && q.rawSymbol) allQuotesMap.set(q.rawSymbol.toLowerCase(), q);
    }
    for (const q of newQuotes) {
      if (q && q.symbol) allQuotesMap.set(q.symbol.toLowerCase(), q);
      if (q && q.rawSymbol) allQuotesMap.set(q.rawSymbol.toLowerCase(), q);
    }

    // 检查是否有缺失项，用旧缓存补全兜底
    for (const sym of cleanSymbols) {
      const lower = sym.toLowerCase();
      if (!allQuotesMap.has(lower)) {
        const cached = this.cache.get(lower);
        if (cached && cached.data) {
          allQuotesMap.set(lower, cached.data);
        }
      }
    }

    const quotesList = Array.from(new Set(allQuotesMap.values()));
    return this._orderQuotes(quotesList, cleanSymbols);
  }

  /**
   * 严格按照用户配置的 symbol 顺序排列
   */
  _orderQuotes(quotes, cleanSymbols) {
    const ordered = [];
    for (const sym of cleanSymbols) {
      const lower = sym.toLowerCase();
      const found = quotes.find(q =>
        (q.symbol && q.symbol.toLowerCase() === lower) ||
        (q.rawSymbol && q.rawSymbol.toLowerCase() === lower) ||
        // 兼容之前配置了 shBK1617 / BK1617 的用户，将其匹配为黄金
        ((lower === 'shbk1617' || lower === 'bk1617') && (q.symbol === 'brand_gold' || q.rawSymbol === 'brand_gold' || q.symbol === 'shBK1617'))
      );
      if (found) {
        ordered.push(found);
      }
    }
    return ordered.length > 0 ? ordered : quotes;
  }

  /**
   * 极速同步获取内存缓存中的行情字串（0ms 响应，绝不卡死弹窗与翻页）
   */
  getCachedSummary(stockConfigs) {
    try {
      let stocks = (Array.isArray(stockConfigs) && stockConfigs.length > 0) ? stockConfigs : this.defaultStocks;
      stocks = stocks.slice(0, 7);
      const symbols = stocks.map(s => s.symbol || s.code).filter(Boolean);
      if (symbols.length === 0) return '';
      const quotes = [];
      for (const sym of symbols) {
        let lower = sym.toLowerCase();
        let cached = this.cache.get(lower);
        if (!cached && (lower === 'shbk1617' || lower === 'bk1617' || lower === 'jewelry_gold')) {
          cached = this.cache.get('brand_gold') || this.cache.get('shbk1617') || this.cache.get('bk1617');
        }
        if (!cached && lower === 'brand_gold') {
          cached = this.cache.get('shbk1617') || this.cache.get('bk1617');
        }
        if (cached && cached.data) {
          quotes.push(cached.data);
        }
      }
      if (quotes.length === 0) return '';
      return quotes.map(q => {
        const shortName = q.name.length > 5 ? q.name.substring(0, 5) : q.name;
        return `${shortName} ${q.currency}${q.price} ${q.changePercent}`;
      }).join('  ');
    } catch (e) {
      return '';
    }
  }

  /**
   * 格式化底栏显示的行情字串
   */
  async getFormattedSummary(stockConfigs) {
    let stocks = (Array.isArray(stockConfigs) && stockConfigs.length > 0) ? stockConfigs : this.defaultStocks;
    stocks = stocks.slice(0, 7); // 最多展示 7 支标的
    const symbols = stocks.map(s => s.symbol || s.code).filter(Boolean);
    if (symbols.length === 0) return '';
    const quotes = await this.getQuotes(symbols);
    if (!quotes || quotes.length === 0) return '';

    return quotes.map(q => {
      const shortName = q.name.length > 5 ? q.name.substring(0, 5) : q.name;
      return `${shortName} ${q.currency}${q.price} ${q.changePercent}`;
    }).join('  ');
  }
}

module.exports = new StockQuoteManager();
