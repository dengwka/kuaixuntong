const http = require('http');
const https = require('https');
const logger = require('./logger');

let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class Translator {
  constructor(configManager, financialAi = null) {
    this.configManager = configManager;
    this.financialAi = financialAi;
    this.cache = new Map(); // hash/text -> translatedText
    this.maxCacheSize = 1000;
  }

  setFinancialAi(ai) {
    this.financialAi = ai;
  }

  isMostlyChinese(text) {
    if (!text || typeof text !== 'string') return true;
    const clean = text.replace(/https?:\/\/\S+/g, '').replace(/[@#]\S+/g, '').trim();
    if (!clean) return true;

    // 若包含日文假名（平假名/片假名）或韩文字符，必然属于外文（日文/韩文），必须予以翻译，坚决不能当做中文跳过
    const hasJapaneseKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(clean);
    const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(clean);
    if (hasJapaneseKana || hasKorean) {
      return false;
    }

    const chineseChars = clean.match(/[\u4e00-\u9fa5]/g) || [];
    // 如果中文字符占比超过 30%，或者包含足够多的中文，视为中文无需翻译
    return (chineseChars.length / clean.length) > 0.3 || chineseChars.length >= 10;
  }

  getProxyConfig() {
    const cfg = this.configManager ? this.configManager.config : {};
    const xCfg = (cfg.sources && cfg.sources.x_twitter) || {};
    let proxy = (xCfg.proxy || (cfg.crypto_prices && cfg.crypto_prices.proxy) || (cfg.system && cfg.system.proxy) || '').trim();
    if (!proxy) {
      proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY ||
              process.env.http_proxy || process.env.https_proxy || '';
    }
    if (!proxy && process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const output = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', { encoding: 'utf8', timeout: 1000 });
        const enabledMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
        if (enabledMatch && parseInt(enabledMatch[1], 16) === 1) {
          const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
          if (serverMatch && serverMatch[1]) {
            let s = serverMatch[1].trim();
            if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'http://' + s;
            proxy = s;
          }
        }
      } catch (e) {}
    }
    if (!proxy) {
      proxy = 'http://127.0.0.1:7897';
    }
    return proxy;
  }

  isInvalidTranslation(res, rawText = '') {
    if (!res || typeof res !== 'string') return true;
    const clean = res.trim();
    if (!clean) return true;
    const upper = clean.toUpperCase();
    if (upper.includes('QUERY LENGTH LIMIT EXCEEDED') ||
        upper.includes('MAX ALLOWED QUERY') ||
        upper.includes('MYMEMORY WARNING') ||
        upper.includes('INVALID USER KEY') ||
        upper.includes('NO QUERY SPECIFIED') ||
        upper.includes('YOU HAVE USED ALL YOUR FREE CREDITS') ||
        upper.includes('PLEASE ENTER A VALID EMAIL') ||
        upper.includes('TRY AGAIN LATER') ||
        upper.includes('403 FORBIDDEN') ||
        upper.includes('RESPONSESTATUS') ||
        (upper.includes('HTML') && upper.includes('<!DOCTYPE'))) {
      return true;
    }
    if (rawText && typeof rawText === 'string') {
      const trimmedRaw = rawText.trim();
      // 1. 如果译文与原文完全相同（且原文不是单个符号），说明未被翻译
      if (clean === trimmedRaw && trimmedRaw.length > 3) {
        return true;
      }
      // 2. 如果原文是非中文，译文中必须含有中文字符，否则说明翻译未生效（如直接返回了西班牙语/英语原文）
      if (!this.isMostlyChinese(trimmedRaw)) {
        if (!/[\u4e00-\u9fa5]/.test(clean)) {
          return true;
        }
      }
    }
    return false;
  }

  splitIntoChunks(text, maxLen = 450) {
    if (!text || text.length <= maxLen) return [text.trim()];
    const paragraphs = text.split(/\n+/);
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
      const trimmedPara = para.trim();
      if (!trimmedPara) continue;

      if (trimmedPara.length <= maxLen) {
        if (current && (current.length + trimmedPara.length + 2 > maxLen)) {
          chunks.push(current);
          current = trimmedPara;
        } else {
          current = current ? current + '\n\n' + trimmedPara : trimmedPara;
        }
      } else {
        // 段落超过 maxLen，按标点句子进行拆分
        const sentences = trimmedPara.match(/[^.!?。！？;；]+[.!?。！？;；]+|[^.!?。！？;；]+$/g) || [trimmedPara];
        for (const sent of sentences) {
          const trimmedSent = sent.trim();
          if (!trimmedSent) continue;

          if (trimmedSent.length > maxLen) {
            if (current) { chunks.push(current); current = ''; }
            const subParts = trimmedSent.match(/[^,， ]+[,， ]+|[^,， ]+$/g) || [trimmedSent];
            let subCurrent = '';
            for (const sp of subParts) {
              if (subCurrent && (subCurrent.length + sp.length > maxLen)) {
                chunks.push(subCurrent.trim());
                subCurrent = sp;
              } else {
                subCurrent += sp;
              }
            }
            if (subCurrent && subCurrent.trim()) {
              if (subCurrent.trim().length < 5 && chunks.length > 0) {
                chunks[chunks.length - 1] += ' ' + subCurrent.trim();
              } else {
                chunks.push(subCurrent.trim());
              }
            }
          } else if (current && (current.length + trimmedSent.length + 1 > maxLen)) {
            chunks.push(current);
            current = trimmedSent;
          } else {
            current = current ? current + ' ' + trimmedSent : trimmedSent;
          }
        }
      }
    }
    if (current && current.trim()) {
      if (current.trim().length < 5 && chunks.length > 0) {
        chunks[chunks.length - 1] += ' ' + current.trim();
      } else {
        chunks.push(current.trim());
      }
    }
    return chunks.length > 0 ? chunks : [text.trim()];
  }

  fetchHttp(url, timeoutMs = 8000) {
    // 优先使用 Electron 原生 net.fetch（内置系统/应用级代理无缝路由）
    if (electronNet && electronNet.fetch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return electronNet.fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          'Accept': 'application/json, text/plain, */*'
        },
        signal: controller.signal
      }).then(async resp => {
        clearTimeout(timer);
        if (resp.ok) {
          return await resp.text();
        }
        return null;
      }).catch(() => {
        clearTimeout(timer);
        return this.fetchDirectHttpsNode(url, timeoutMs);
      });
    }

    return this.fetchDirectHttpsNode(url, timeoutMs);
  }

  fetchDirectHttpsNode(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (val) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(val);
        }
      };

      const timer = setTimeout(() => done(null), timeoutMs);

      try {
        const req = https.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
            'Accept': 'application/json, text/plain, */*'
          },
          timeout: timeoutMs
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => done(data));
        });
        req.on('timeout', () => { req.destroy(); done(null); });
        req.on('error', () => done(null));
      } catch (e) {
        done(null);
      }
    });
  }

  async translateWithGoogle(text) {
    if (!text || !text.trim()) return null;
    try {
      const encoded = encodeURIComponent(text.trim());
      const targetUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encoded}`;
      const raw = await this.fetchHttp(targetUrl, 2500);
      if (!raw) return null;
      const json = JSON.parse(raw);
      if (Array.isArray(json) && Array.isArray(json[0])) {
        const trans = json[0].map(item => (item && item[0]) ? item[0] : '').join('');
        if (trans && !this.isInvalidTranslation(trans, text)) {
          return trans.trim();
        }
      }
    } catch (e) {}
    return null;
  }

  async translateSingleChunk(chunk) {
    if (!chunk || !chunk.trim()) return '';
    try {
      const encoded = encodeURIComponent(chunk.trim());
      // 支持全语种自动感知：Autodetect|zh-CN，并附加开发者合法标识扩容免费额度
      const targetUrl = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=Autodetect|zh-CN&de=support@kuaixuntong.app`;
      const raw = await this.fetchHttp(targetUrl, 7000);
      if (!raw) return null;
      const json = JSON.parse(raw);
      const status = String(json.responseStatus || '');
      if (status === '200' && json.responseData && json.responseData.translatedText) {
        let res = json.responseData.translatedText;
        res = res.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        if (!this.isInvalidTranslation(res, chunk)) {
          return res.trim();
        }
      }
    } catch (e) {}
    return null;
  }

  async translateWithFallback(text) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim();

    // 1. Google GTX 引擎（若开了代理或处于可访问网络，速度极快且翻译地道）
    try {
      const googleRes = await this.translateWithGoogle(trimmed);
      if (googleRes && !this.isInvalidTranslation(googleRes, trimmed)) {
        return { text: googleRes, engine: 'Google' };
      }
    } catch (e) {}

    // 2. MyMemory 引擎（国内直连通常可达，支持全语种自动识别 Autodetect|zh-CN 与分段机制）
    try {
      const chunks = this.splitIntoChunks(trimmed, 450);
      const translatedParts = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let part = await this.translateSingleChunk(chunk);
        if (!part) {
          // 遇网络偶发波动，间隔 300ms 快速重试一次
          await new Promise(r => setTimeout(r, 300));
          part = await this.translateSingleChunk(chunk);
        }
        if (!part || this.isInvalidTranslation(part, chunk)) {
          return null; // 确保不返回残缺或包含错误信息的译文
        }
        translatedParts.push(part);
        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 100)); // 避免过度突发请求
        }
      }

      if (translatedParts.length > 0) {
        const fullResult = translatedParts.join('\n\n');
        if (!this.isInvalidTranslation(fullResult, trimmed)) {
          return { text: fullResult, engine: 'MyMemory' };
        }
      }
    } catch (e) {}

    return null;
  }

  async translate(text) {
    if (!text || typeof text !== 'string') {
      return { translatedText: text, isTranslated: false };
    }

    const trimmed = text.trim();
    if (!trimmed || this.isMostlyChinese(trimmed)) {
      return { translatedText: trimmed, isTranslated: false };
    }

    // 检查缓存
    if (this.cache.has(trimmed)) {
      const cached = this.cache.get(trimmed);
      if (cached && !this.isInvalidTranslation(cached, trimmed)) {
        return { translatedText: cached, isTranslated: true };
      } else {
        this.cache.delete(trimmed);
      }
    }

    // 1. 优先调用大模型 (DeepSeek / GLM-4) 开展上下文精准翻译
    try {
      const aiResult = await this.translateWithAi(trimmed);
      if (aiResult && aiResult.trim() && !this.isInvalidTranslation(aiResult, trimmed)) {
        this.saveCache(trimmed, aiResult.trim());
        return { translatedText: aiResult.trim(), isTranslated: true, engine: 'LLM' };
      }
    } catch (errAi) {
      logger.warn('[Translator] 大模型翻译异常，降级至备用翻译引擎:', errAi.message);
    }

    // 2. 备用通道：免费公用轻量多引擎流水线 (Google GTX + MyMemory 多语种自动识别)
    try {
      const fallbackResult = await this.translateWithFallback(trimmed);
      if (fallbackResult && fallbackResult.text && !this.isInvalidTranslation(fallbackResult.text, trimmed)) {
        this.saveCache(trimmed, fallbackResult.text);
        return { translatedText: fallbackResult.text, isTranslated: true, engine: fallbackResult.engine };
      }
    } catch (errFb) {
      logger.warn('[Translator] 备用翻译引擎请求异常:', errFb.message);
    }

    // 无法翻译则优雅降级返回原文，isTranslated 绝不为 true
    return { translatedText: trimmed, isTranslated: false };
  }

  saveCache(raw, trans) {
    if (!trans || this.isInvalidTranslation(trans, raw)) return;
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(raw, trans);
  }

  async translateWithAi(text) {
    const cfg = this.configManager ? this.configManager.config : {};
    const aiCfg = cfg.ai_analysis || {};
    if (!aiCfg.enabled) return null;

    const hasKey = (aiCfg.deepseek_api_key && aiCfg.deepseek_api_key.trim()) || 
                   (aiCfg.zhipu_api_key && aiCfg.zhipu_api_key.trim()) || 
                   (aiCfg.api_key && aiCfg.api_key.trim());
    if (!hasKey) return null;

    const apiKey = (aiCfg.deepseek_api_key || aiCfg.api_key || aiCfg.zhipu_api_key).trim();
    const isZhipu = aiCfg.provider === 'zhipu' || (aiCfg.zhipu_api_key && !aiCfg.deepseek_api_key) || apiKey.includes('.');
    const apiUrl = isZhipu 
      ? (aiCfg.zhipu_api_url || 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
      : (aiCfg.deepseek_api_url || 'https://api.deepseek.com/chat/completions');
    const model = isZhipu
      ? (aiCfg.zhipu_model || 'glm-4-flash')
      : (aiCfg.deepseek_model || 'deepseek-chat');

    const prompt = `你是一位精通全球财经、宏观经济与科技创投的资深同声传译专家。请将以下推文翻译成自然、流畅、专业的地道中文。
要求：
1. 保持金融术语与商业逻辑严谨，人名/机构名附带规范中文译名；
2. 直接输出中文翻译正文，严禁包含任何前缀、解释、说明或引述符号。

推文内容：
${text}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
      const resp = await fetchFn(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 500
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      if (!resp.ok) {
        throw new Error(`AI HTTP ${resp.status}`);
      }

      const json = await resp.json();
      if (json && json.choices && json.choices[0] && json.choices[0].message) {
        let content = json.choices[0].message.content || '';
        return content.trim();
      }
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
    return null;
  }
}

module.exports = Translator;
