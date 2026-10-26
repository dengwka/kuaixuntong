let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class CryptoPriceManager {
  constructor() {
    this.cache = new Map(); // symbol -> { priceStr, numPrice, timestamp }
    this.cacheTtlMs = 15000; // 15秒缓存
    this.symbolToInstId = new Map(); // 缓存已成功识别的 OKX instId，如 'BZ' -> 'BZ-USDT-SWAP'
    this.defaultCoins = ['BTC/USDT', 'SOL/USDT'];
    this.presetCoins = [
      'BTC/USDT',
      'ETH/USDT',
      'SOL/USDT',
      'BNB/USDT',
      'DOGE/USDT',
      'XRP/USDT',
      'SUI/USDT',
      'BZ/USDT',
      'ZEC/USDT',
      'CRCL/USDT'
    ];
  }

  formatPrice(num) {
    if (isNaN(num)) return '--';
    if (num >= 1000) {
      return '$' + Math.round(num).toLocaleString('en-US');
    } else if (num >= 1) {
      return '$' + Number(num.toFixed(2));
    } else {
      return '$' + Number(num.toFixed(4));
    }
  }

  getShortSymbol(pair) {
    const p = String(pair || '').toUpperCase().trim();
    return p.split('/')[0] || p;
  }

  /**
   * 规范化币种输入
   * 支持 "BZ", "bz/usdt", "BZ-USDT", "CRCL/USDT", "BTC"
   */
  normalizePair(rawInput) {
    let clean = String(rawInput || '').trim().toUpperCase().replace('/', '-');
    if (!clean) return null;
    if (!clean.includes('-')) {
      clean = `${clean}-USDT`;
    }
    const parts = clean.split('-');
    const base = parts[0];
    const quote = parts[1] || 'USDT';
    return {
      base,
      quote,
      pair: `${base}/${quote}`,
      cleanInst: `${base}-${quote}`
    };
  }

  /**
   * 通过 OKX 官方行情接口严格校验交易对有效性
   * 依次校验：现货 -> 永续合约 -> X前缀现货 -> X前缀合约
   */
  async validateOkxCoin(rawInput) {
    const norm = this.normalizePair(rawInput);
    if (!norm) {
      return { success: false, msg: '请输入币种名称或交易对（如 ZEC、BZ/USDT 或 CRCL）' };
    }

    const { base, quote, pair } = norm;
    const candidates = [
      `${base}-${quote}`,
      `${base}-${quote}-SWAP`,
      `X${base}-${quote}`,
      `X${base}-${quote}-SWAP`
    ];

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    for (const instId of candidates) {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);

      try {
        const resp = await fetchFn(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: controller.signal
        });
        clearTimeout(timer);

        if (resp.ok) {
          const json = await resp.json();
          if (json && json.code === '0' && Array.isArray(json.data) && json.data.length > 0 && json.data[0].last) {
            const ticker = json.data[0];
            const num = parseFloat(ticker.last);
            if (!isNaN(num)) {
              // 记住该币种在 OKX 上的映射
              this.symbolToInstId.set(base, ticker.instId);
              const formatted = this.formatPrice(num);
              const isSwap = ticker.instId.includes('SWAP');
              return {
                success: true,
                symbol: base,
                pair: `${base}/${quote}`,
                instId: ticker.instId,
                priceStr: formatted,
                numPrice: num,
                type: isSwap ? '永续合约' : '现货',
                source: 'OKX'
              };
            }
          }
        }
      } catch (e) {
        clearTimeout(timer);
      }
    }

    return {
      success: false,
      msg: `OKX 校验失败：未找到 ${base}/${quote} 现货或永续合约交易对`
    };
  }

  async fetchOkxTicker(pair) {
    const symbol = this.getShortSymbol(pair);
    const cachedInstId = this.symbolToInstId.get(symbol);

    const candidates = cachedInstId
      ? [cachedInstId]
      : [
          `${symbol}-USDT`,
          `${symbol}-USDT-SWAP`,
          `X${symbol}-USDT`,
          `X${symbol}-USDT-SWAP`
        ];

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    for (const instId of candidates) {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2800);

      try {
        const resp = await fetchFn(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
          },
          signal: controller.signal
        });
        clearTimeout(timer);

        if (resp.ok) {
          const json = await resp.json();
          if (json && json.code === '0' && json.data && json.data[0] && json.data[0].last) {
            const lastNum = parseFloat(json.data[0].last);
            if (!isNaN(lastNum)) {
              this.symbolToInstId.set(symbol, json.data[0].instId || instId);
              const formatted = this.formatPrice(lastNum);
              return {
                symbol,
                pair: `${symbol}/USDT`,
                priceStr: formatted,
                numPrice: lastNum,
                source: 'OKX'
              };
            }
          }
        }
      } catch (e) {
        clearTimeout(timer);
      }
    }

    return null;
  }

  async fetchBinanceFallback(pair) {
    const symbol = this.getShortSymbol(pair);
    const binanceSymbol = `${symbol}USDT`;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
      const resp = await fetchFn(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json && json.price) {
          const lastNum = parseFloat(json.price);
          if (!isNaN(lastNum)) {
            return {
              symbol,
              pair: `${symbol}/USDT`,
              priceStr: this.formatPrice(lastNum),
              numPrice: lastNum,
              source: 'Binance'
            };
          }
        }
      }
    } catch (e) {
      clearTimeout(timer);
    }
    return null;
  }

  async getCoinPrice(pair) {
    const symbol = this.getShortSymbol(pair);
    const now = Date.now();

    // 检查有效内存缓存
    const cached = this.cache.get(symbol);
    if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
      return cached;
    }

    // 1. 优先获取 OKX 价格（支持现货与永续）
    let res = await this.fetchOkxTicker(pair);

    // 2. 兜底获取 Binance 价格
    if (!res) {
      res = await this.fetchBinanceFallback(pair);
    }

    // 3. 网络若完全断开，回退使用历史缓存
    if (!res && cached) {
      return cached;
    }

    if (res) {
      res.timestamp = now;
      this.cache.set(symbol, res);
      return res;
    }

    return {
      symbol,
      pair: `${symbol}/USDT`,
      priceStr: '--',
      numPrice: 0,
      source: 'none'
    };
  }

  async getFormattedSummary(selectedCoins) {
    let coins = Array.isArray(selectedCoins) ? selectedCoins : this.defaultCoins;
    if (coins.length === 0) return '';
    // 最多支持展示 7 个自选币种
    coins = coins.slice(0, 7);

    const promises = coins.map(c => this.getCoinPrice(c));
    const results = await Promise.allSettled(promises);

    const parts = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.priceStr && r.value.priceStr !== '--') {
        parts.push(`${r.value.symbol} ${r.value.priceStr}`);
      }
    }

    return parts.join('  ');
  }
}

module.exports = new CryptoPriceManager();
