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
    const chineseChars = clean.match(/[\u4e00-\u9fa5]/g) || [];
    // 如果中文字符占比超过 30%，或者包含足够多的中文，视为中文无需翻译
    return (chineseChars.length / clean.length) > 0.3 || chineseChars.length >= 10;
  }

  getProxyConfig() {
    const cfg = this.configManager.config;
    const xCfg = (cfg.sources && cfg.sources.x_twitter) || {};
    let proxy = (xCfg.proxy || '').trim();
    if (!proxy) {
      // 检查环境变量代理
      proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:7892';
    }
    return proxy;
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
      return { translatedText: this.cache.get(trimmed), isTranslated: true };
    }

    // 1. 优先调用大模型 (DeepSeek / GLM-4) 开展上下文精准翻译
    try {
      const aiResult = await this.translateWithAi(trimmed);
      if (aiResult && aiResult.trim()) {
        this.saveCache(trimmed, aiResult.trim());
        return { translatedText: aiResult.trim(), isTranslated: true, engine: 'LLM' };
      }
    } catch (errAi) {
      logger.warn('[Translator] 大模型翻译异常，降级至备用翻译引擎:', errAi.message);
    }

    // 2. 备用通道：免费公用轻量翻译服务 (MyMemory)
    try {
      const fallbackResult = await this.translateWithFallback(trimmed);
      if (fallbackResult && fallbackResult.trim()) {
        this.saveCache(trimmed, fallbackResult.trim());
        return { translatedText: fallbackResult.trim(), isTranslated: true, engine: 'MyMemory' };
      }
    } catch (errFb) {
      logger.warn('[Translator] 备用翻译引擎请求异常:', errFb.message);
    }

    // 无法翻译则优雅降级返回原文
    return { translatedText: trimmed, isTranslated: false };
  }

  saveCache(raw, trans) {
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(raw, trans);
  }

  async translateWithAi(text) {
    const cfg = this.configManager.config;
    const aiCfg = cfg.ai_analysis || {};
    if (!aiCfg.enabled) return null;

    const hasKey = (aiCfg.deepseek_api_key && aiCfg.deepseek_api_key.trim()) || 
                   (aiCfg.zhipu_api_key && aiCfg.zhipu_api_key.trim()) || 
                   (aiCfg.api_key && aiCfg.api_key.trim());
    if (!hasKey) return null;

    const apiKey = (aiCfg.deepseek_api_key || aiCfg.api_key || aiCfg.zhipu_api_key).trim();
    const isZhipu = (aiCfg.zhipu_api_key && !aiCfg.deepseek_api_key) || apiKey.includes('.');
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
    const timeout = setTimeout(() => controller.abort(), 5000); // 5秒超时

    try {
      const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch : global.fetch;
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
          max_tokens: 300
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

  async translateWithFallback(text) {
    const proxyUrl = this.getProxyConfig();
    const encoded = encodeURIComponent(text);
    const targetUrl = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|zh-CN`;

    return new Promise((resolve, reject) => {
      let parsedProxy = null;
      if (proxyUrl && proxyUrl.startsWith('http')) {
        try {
          parsedProxy = new URL(proxyUrl);
        } catch (e) {}
      }

      const timer = setTimeout(() => {
        reject(new Error('Fallback translate timeout'));
      }, 5000);

      const handleResponse = (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            if (json && json.responseData && json.responseData.translatedText) {
              let res = json.responseData.translatedText;
              // MyMemory 有时会返回包含 HTML 实体字符
              res = res.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
              resolve(res);
              return;
            }
          } catch (e) {}
          resolve(null);
        });
      };

      if (parsedProxy) {
        const req = http.request({
          host: parsedProxy.hostname,
          port: parsedProxy.port || 80,
          method: 'CONNECT',
          path: 'api.mymemory.translated.net:443'
        });

        req.on('connect', (res, socket) => {
          const agent = new https.Agent({ socket });
          https.get(targetUrl, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, handleResponse)
               .on('error', (err) => { clearTimeout(timer); reject(err); });
        });

        req.on('error', (err) => {
          clearTimeout(timer);
          // 若代理 CONNECT 失败，尝试直连
          https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, handleResponse)
               .on('error', (directErr) => reject(directErr));
        });
        req.end();
      } else {
        https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, handleResponse)
             .on('error', (err) => { clearTimeout(timer); reject(err); });
      }
    });
  }
}

module.exports = Translator;
