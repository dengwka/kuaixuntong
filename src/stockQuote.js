const { URL } = require('url');
const logger = require('./logger');

class StockQuoteManager {
  constructor() {
    this.cache = new Map(); // symbol -> { data, timestamp }
    this.cacheTtlMs = 10000; // 10秒缓存
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
    if (!Array.isArray(symbols) || symbols.length === 0) return [];
    const cleanSymbols = symbols.filter(Boolean);
    if (cleanSymbols.length === 0) return [];

    try {
      const url = `https://qt.gtimg.cn/q=${cleanSymbols.join(',')}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!res.ok) return [];

      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const lines = text.trim().split(';').filter(Boolean);

      const quotes = [];
      for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const id = line.substring(2, idx).trim();
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
          if (id.includes('hk')) {
            currency = 'HK$';
            mkt = '港股';
          } else if (id.includes('us')) {
            currency = '$';
            mkt = '美股';
          }

          quotes.push({
            symbol: id,
            code,
            name,
            market: mkt,
            price: price.toFixed(price >= 100 ? 2 : (price >= 1 ? 2 : 3)),
            changeAmount: changeAmount >= 0 ? `+${changeAmount.toFixed(2)}` : changeAmount.toFixed(2),
            changePercent: changePercent >= 0 ? `+${changePercent.toFixed(2)}%` : `${changePercent.toFixed(2)}%`,
            isUp: changePercent >= 0,
            currency
          });
        }
      }
      return quotes;
    } catch (e) {
      logger.error('[StockQuote] 获取股票行情异常:', e.message);
      return [];
    }
  }

  /**
   * 格式化底栏显示的股票行情字串
   */
  async getFormattedSummary(stockConfigs = []) {
    if (!Array.isArray(stockConfigs) || stockConfigs.length === 0) return '';
    const symbols = stockConfigs.map(s => s.symbol || s.code).filter(Boolean);
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
