let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

const { URL } = require('url');
const logger = require('./logger');

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
   * 自动联想搜索股票代码（支持输入“腾讯”、“京东”、“茅台”、“苹果”等）
   */
  async searchStock(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();

    try {
      const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!res.ok) return [];

      const json = await res.json();
      const rawList = (json && json.QuotationCodeTable && json.QuotationCodeTable.Data) || [];
      
      const results = [];
      for (const item of rawList.slice(0, 8)) {
        const code = item.Code;
        const name = item.Name;
        const mkt = item.SecurityTypeName || '';
        const jys = (item.JYS || '').toUpperCase();

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

        results.push({
          code,
          name,
          market: marketCategory,
          symbol,
          display: `${name} (${code} · ${marketCategory})`
        });
      }
      return results;
    } catch (e) {
      logger.error('[StockQuote] 搜索联想异常:', e.message);
      return [];
    }
  }

  /**
   * 批量查询股票行情（A股 / 港股 / 美股）
   * @param {Array<string>} symbols - 形如 ['r_hk00700', 'usJD', 'sh600519']
   */
  async getQuotes(symbols = []) {
    let cleanSymbols = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
    if (cleanSymbols.length === 0) {
      cleanSymbols = this.defaultStocks.map(s => s.symbol);
    }

    const now = Date.now();
    const needFetchSymbols = [];
    const cachedQuotes = [];

    for (const sym of cleanSymbols) {
      const cached = this.cache.get(sym.toLowerCase());
      if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
        cachedQuotes.push(cached.data);
      } else {
        needFetchSymbols.push(sym);
      }
    }

    // 全部在 15s 缓存内，立即返回缓存（0延迟，杜绝弹窗卡顿）
    if (needFetchSymbols.length === 0 && cachedQuotes.length > 0) {
      return cachedQuotes;
    }

    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);

      const url = `https://qt.gtimg.cn/q=${cleanSymbols.join(',')}`;
      const res = await fetchFn(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        // 请求失败，尝试返回已有缓存兜底
        const fallback = cleanSymbols.map(s => this.cache.get(s.toLowerCase())?.data).filter(Boolean);
        return fallback.length > 0 ? fallback : cachedQuotes;
      }

      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const lines = text.trim().split(';').filter(Boolean);

      const quotes = [];
      for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const rawId = line.substring(0, idx).trim();
        const cleanId = rawId.replace(/^v_+/, '');
        // 尝试从 cleanSymbols 中找到完全匹配的请求 symbol，保证 ID 一致性
        const matchedReqSymbol = cleanSymbols.find(s => s.toLowerCase() === cleanId.toLowerCase()) || cleanId;
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

          quotes.push(qObj);
          this.cache.set(matchedReqSymbol.toLowerCase(), { data: qObj, timestamp: now });
          this.cache.set(cleanId.toLowerCase(), { data: qObj, timestamp: now });
        }
      }

      // 如果个别 symbol 响应中缺失，用已有缓存补全
      for (const sym of cleanSymbols) {
        if (!quotes.some(q => q.symbol.toLowerCase() === sym.toLowerCase() || q.rawSymbol.toLowerCase() === sym.toLowerCase())) {
          const cached = this.cache.get(sym.toLowerCase());
          if (cached && cached.data) quotes.push(cached.data);
        }
      }

      return quotes;
    } catch (e) {
      logger.error('[StockQuote] 获取股票行情异常:', e.message);
      const fallback = cleanSymbols.map(s => this.cache.get(s.toLowerCase())?.data).filter(Boolean);
      return fallback.length > 0 ? fallback : cachedQuotes;
    }
  }

  /**
   * 格式化底栏显示的股票行情字串
   */
  async getFormattedSummary(stockConfigs) {
    let stocks = (Array.isArray(stockConfigs) && stockConfigs.length > 0) ? stockConfigs : this.defaultStocks;
    stocks = stocks.slice(0, 7); // 最多展示 7 支股票
    const symbols = stocks.map(s => s.symbol || s.code).filter(Boolean);
    if (symbols.length === 0) return '';
    const quotes = await this.getQuotes(symbols);
    if (!quotes || quotes.length === 0) return '';

    return quotes.map(q => {
      // 港股 / 美股 / A股 规范缩写
      const shortName = q.name.length > 4 ? q.name.substring(0, 4) : q.name;
      return `${shortName} ${q.currency}${q.price} ${q.changePercent}`;
    }).join('  ');
  }
}

module.exports = new StockQuoteManager();
