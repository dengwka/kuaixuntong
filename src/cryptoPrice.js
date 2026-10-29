let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class CryptoPriceManager {
  constructor() {
    this.cache = new Map(); // symbol -> { priceStr, numPrice, change24h, cnyStr, timestamp }
    this.cacheTtlMs = 60000; // 60秒有效缓存，保证突发快讯连发时持续命中现成价格
    this.symbolToInstId = new Map(); // 缓存已成功识别的 OKX instId
    this.defaultCoins = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
    this.usdCnyRate = 6.6621; // 实时汇率默认基准
    this.lastRateTime = 0;
    this.rateTtlMs = 300000; // 5分钟有效缓存
    this.coinNames = {
      'BTC': '比特币',
      'ETH': '以太坊',
      'SOL': '索拉纳',
      'BZ': '布伦特原油',
      'CRCL': 'WTI原油',
      'BNB': '币安币',
      'DOGE': '狗狗币',
      'XRP': '瑞波币',
      'SUI': 'Sui',
      'PEPE': '佩佩蛙',
      'ADA': '艾达币',
      'AVAX': '雪崩',
      'DOT': '波卡',
      'LINK': 'Chainlink',
      'TRX': '波场',
      'LTC': '莱特币',
      'NEAR': 'NEAR',
      'SHIB': '柴犬币',
      'TON': 'Toncoin'
    };
    this.presetCoins = [
      'BTC/USDT',
      'ETH/USDT',
      'SOL/USDT',
      'BZ/USDT',
      'BNB/USDT',
      'DOGE/USDT',
      'XRP/USDT',
      'SUI/USDT',
      'PEPE/USDT',
      'CRCL/USDT'
    ];
  }

  formatPrice(num) {
    if (isNaN(num) || num === null || num === undefined) return '--';
    if (num >= 1000) {
      return '$' + Math.round(num).toLocaleString('en-US');
    } else if (num >= 1) {
      return '$' + num.toFixed(2);
    } else if (num >= 0.01) {
      return '$' + num.toFixed(4);
    } else if (num > 0) {
      return '$' + num.toFixed(6);
    } else {
      return '$0';
    }
  }

  async getLiveUsdCnyRate() {
    const now = Date.now();
    if (this.lastRateTime && (now - this.lastRateTime < this.rateTtlMs) && this.usdCnyRate > 0) {
      return this.usdCnyRate;
    }

    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);

      const resp = await fetchFn('https://hq.sinajs.cn/list=fx_susdcny', {
        headers: {
          'Referer': 'https://finance.sina.com.cn',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      if (resp.ok) {
        const text = await resp.text();
        const parts = text.split(',');
        // parts[8] 为最新在岸成交价，parts[1] 为买入价，parts[2] 为卖出价
        const parsed = parseFloat(parts[8]) || parseFloat(parts[1]) || parseFloat(parts[2]);
        if (!isNaN(parsed) && parsed > 5 && parsed < 10) {
          this.usdCnyRate = parseFloat(parsed.toFixed(4));
          this.lastRateTime = now;
          return this.usdCnyRate;
        }
      }
    } catch (e) {}

    return this.usdCnyRate || 6.6621;
  }

  formatCnyPrice(num, customRate) {
    if (isNaN(num) || num <= 0) return '--';
    const rate = (typeof customRate === 'number' && customRate > 0) ? customRate : (this.usdCnyRate || 6.6621);
    const cny = num * rate;
    if (cny >= 100000000) {
      return '¥' + (cny / 100000000).toFixed(2) + '亿';
    } else if (cny >= 10000) {
      return '¥' + (cny / 10000).toFixed(2) + '万';
    } else if (cny >= 1000) {
      return '¥' + Math.round(cny).toLocaleString('zh-CN');
    } else if (cny >= 1) {
      return '¥' + cny.toFixed(2);
    } else if (cny >= 0.01) {
      return '¥' + cny.toFixed(4);
    } else {
      return '¥' + cny.toFixed(6);
    }
  }

  getShortSymbol(pair) {
    const p = String(pair || '').toUpperCase().trim();
    return p.split('/')[0] || p;
  }

  /**
   * 规范化币种输入
   * 支持 "BTC", "eth/usdt", "SOL-USDT", "PEPE"
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
      return { success: false, msg: '请输入币种名称或交易对（如 BTC、ETH、SOL 或 PEPE/USDT）' };
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
              this.symbolToInstId.set(base, ticker.instId);
              const formatted = this.formatPrice(num);
              const isSwap = ticker.instId.includes('SWAP');
              const openNum = parseFloat(ticker.open24h);
              let change24h = '';
              if (!isNaN(openNum) && openNum > 0) {
                const pct = ((num - openNum) / openNum) * 100;
                change24h = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
              }
              const cnName = this.coinNames[base] || base;
              return {
                success: true,
                symbol: base,
                name: cnName,
                pair: `${base}/${quote}`,
                instId: ticker.instId,
                priceStr: formatted,
                numPrice: num,
                cnyStr: this.formatCnyPrice(num),
                change24h,
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

    const checkCandidate = async (instId) => {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);

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
              const openNum = parseFloat(json.data[0].open24h);
              let change24h = '';
              if (!isNaN(openNum) && openNum > 0) {
                const pct = ((lastNum - openNum) / openNum) * 100;
                change24h = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
              }
              const isSwap = String(json.data[0].instId || instId).includes('SWAP');
              return {
                symbol,
                pair: `${symbol}/USDT`,
                priceStr: formatted,
                numPrice: lastNum,
                change24h,
                cnyStr: this.formatCnyPrice(lastNum),
                type: isSwap ? '永续合约' : '现货',
                source: 'OKX'
              };
            }
          }
        }
      } catch (e) {
        clearTimeout(timer);
      }
      return null;
    };

    if (cachedInstId) {
      return await checkCandidate(cachedInstId);
    }

    // 并行发起各候选交易对检测，谁先成功返回谁
    const results = await Promise.allSettled(candidates.map(inst => checkCandidate(inst)));
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) {
        return res.value;
      }
    }

    return null;
  }

  async fetchBinanceFallback(pair) {
    const symbol = this.getShortSymbol(pair);

    const binanceSymbol = `${symbol}USDT`;
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
      const resp = await fetchFn(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json && json.lastPrice) {
          const lastNum = parseFloat(json.lastPrice);
          if (!isNaN(lastNum)) {
            const pctNum = parseFloat(json.priceChangePercent);
            const change24h = !isNaN(pctNum) ? ((pctNum >= 0 ? '+' : '') + pctNum.toFixed(2) + '%') : '';
            return {
              symbol,
              pair: `${symbol}/USDT`,
              priceStr: this.formatPrice(lastNum),
              numPrice: lastNum,
              change24h,
              cnyStr: this.formatCnyPrice(lastNum),
              type: '现货',
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

  async getCoinPrice(pair, forceRefresh = false) {
    const symbol = this.getShortSymbol(pair);
    const now = Date.now();

    // 检查有效内存缓存 (forceRefresh 为 true 时坚决跳过缓存，强制走实时网络)
    if (!forceRefresh) {
      const cached = this.cache.get(symbol);
      if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
        return cached;
      }
    }

    // 1. 优先获取 OKX 价格（支持现货与永续）
    let res = await this.fetchOkxTicker(pair);

    // 2. 兜底获取 Binance 价格
    if (!res) {
      res = await this.fetchBinanceFallback(pair);
    }

    // 3. 网络若暂时失败或超时，回退使用上一轮有效历史缓存
    const cached = this.cache.get(symbol);
    if (!res && cached && cached.priceStr && cached.priceStr !== '--') {
      return cached;
    }

    if (res) {
      res.timestamp = now;
      this.cache.set(symbol, res);
      return res;
    }

    if (cached && cached.priceStr && cached.priceStr !== '--') {
      return cached;
    }

    return {
      symbol,
      pair: `${symbol}/USDT`,
      priceStr: '--',
      numPrice: 0,
      source: 'none'
    };
  }

  /**
   * 专用于设置页面「⚡ 实时测试获取 OKX 报价」
   * 强制实时拉取、0缓存、带中文币名、折合人民币换算与24h涨跌幅
   */
  async testPrices(selectedCoins) {
    // 1. 优先实时拉取最新的美元/人民币外汇汇率 (新浪官方金融行情直连)
    const liveRate = await this.getLiveUsdCnyRate();

    let coins = Array.isArray(selectedCoins) ? selectedCoins : this.defaultCoins;
    if (coins.length === 0) coins = this.defaultCoins;
    coins = coins.slice(0, 7);

    const promises = coins.map(c => this.getCoinPrice(c, true));
    const results = await Promise.allSettled(promises);

    const items = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.priceStr && r.value.priceStr !== '--') {
        const item = r.value;
        const sym = item.symbol;
        items.push({
          symbol: sym,
          name: this.coinNames[sym] || sym,
          pair: item.pair || `${sym}/USDT`,
          priceStr: item.priceStr,
          numPrice: item.numPrice,
          cnyStr: this.formatCnyPrice(item.numPrice, liveRate),
          change24h: item.change24h || '',
          type: item.type || '现货',
          source: item.source || 'OKX'
        });
      }
    }

    return {
      success: items.length > 0,
      items,
      liveRate,
      summary: items.map(it => `${it.symbol} ${it.priceStr}`).join('  '),
      rateText: `实时外汇牌价: 1 USD ≈ ${liveRate.toFixed(4)} CNY (新浪/银行间外汇)`
    };
  }

  /**
   * 极速同步获取内存缓存中的加密货币行情字串（0ms 响应，绝不阻塞弹窗与交互）
   */
  getCachedSummary(selectedCoins) {
    try {
      let coins = Array.isArray(selectedCoins) ? selectedCoins : this.defaultCoins;
      if (coins.length === 0) return '';
      coins = coins.slice(0, 7);
      const parts = [];
      for (const c of coins) {
        const symbol = this.getShortSymbol(c);
        const cached = this.cache.get(symbol);
        if (cached && cached.priceStr && cached.priceStr !== '--') {
          const chg = cached.change24h ? ` ${cached.change24h}` : '';
          parts.push(`${cached.symbol || symbol} ${cached.priceStr}${chg}`);
        }
      }
      return parts.join('  ');
    } catch (e) {
      return '';
    }
  }

  async getFormattedSummary(selectedCoins) {
    let coins = Array.isArray(selectedCoins) ? selectedCoins : this.defaultCoins;
    if (coins.length === 0) return '';
    coins = coins.slice(0, 7);

    const promises = coins.map(c => this.getCoinPrice(c));
    const results = await Promise.allSettled(promises);

    const parts = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && r.value.priceStr && r.value.priceStr !== '--') {
        const chg = r.value.change24h ? ` ${r.value.change24h}` : '';
        parts.push(`${r.value.symbol} ${r.value.priceStr}${chg}`);
      }
    }

    return parts.join('  ');
  }
}

module.exports = new CryptoPriceManager();
