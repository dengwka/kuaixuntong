let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class FinancialAIEngine {
  constructor(configManager) {
    this.configManager = configManager;
    this.roundRobinIndex = 0;
  }

  isPendingOrScheduleEvent(text) {
    const t = text.toLowerCase();
    const pendingPatterns = [
      /将于.*?公布/,
      /将于.*?发布/,
      /即将公布/,
      /即将发布/,
      /即将举行/,
      /将于.*?召开/,
      /十分钟后/,
      /半小时后/,
      /一小时后/,
      /待公布/,
      /日程提醒/,
      /数据前瞻/,
      /等待公布/,
      /预期将于/
    ];
    return pendingPatterns.some(p => p.test(t));
  }

  parseAiResponse(json) {
    if (!json) return null;
    let contentStr = '';
    if (json.choices && json.choices[0] && json.choices[0].message) {
      contentStr = json.choices[0].message.content || '';
    }
    if (!contentStr) return null;

    try {
      // 兼容可能存在的 markdown ```json 标记包裹
      let cleaned = contentStr.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
      }
      return JSON.parse(cleaned);
    } catch (e) {
      return null;
    }
  }

  async callLlmApi(provider, apiUrl, apiKey, model, text, timeoutSec = 6) {
    const systemPrompt = `你是一名顶级宏观对冲基金的资深首席策略分析师。
你的任务是针对抓取到的最新突发财经、政经要闻与重要博主推文（如特朗普、白宫、美联储等），给出高度精炼、入木三分的深度AI解读（字数严格控制在30字以内），并结合全球宏观逻辑、“特朗普交易”（如宽松监管对加密货币、关税政策对美元等传导效应），敏锐研判该事件对五大核心资产：【黄金、美元、原油、A股、虚拟币】的传导影响（方向只能在【利好】、【利空】、【中性】三者中选择其一。对于时政大选动员、监管表态或宏观言论，应积极给出前瞻资产倾向，避免全部中性）。
你必须严格返回以下 JSON 格式，不要携带任何额外的 Markdown 标记或多余字符：
{
  "is_pending": false,
  "summary": "针对本条新闻的精炼AI解读，不超过30字",
  "impacts": {
    "gold": {"name": "黄金", "direction": "利好或利空或中性"},
    "usd": {"name": "美元", "direction": "利好或利空或中性"},
    "oil": {"name": "原油", "direction": "利好或利空或中性"},
    "a_share": {"name": "A股", "direction": "利好或利空或中性"},
    "crypto": {"name": "虚拟币", "direction": "利好或利空或中性"}
  }
}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    try {
      const resp = await fetchFn(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `【最新快讯】：${text}` }
          ],
          temperature: 0.2
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        const json = await resp.json();
        const parsed = this.parseAiResponse(json);
        if (parsed && parsed.summary) {
          return parsed;
        }
      }
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
    return null;
  }

  formatImpacts(rawImpacts) {
    const impactsMap = {};
    if (rawImpacts) {
      impactsMap['黄金'] = (rawImpacts.gold && rawImpacts.gold.direction) || '中性';
      impactsMap['美元'] = (rawImpacts.usd && rawImpacts.usd.direction) || '中性';
      impactsMap['原油'] = (rawImpacts.oil && rawImpacts.oil.direction) || '中性';
      impactsMap['A股'] = (rawImpacts.a_share && rawImpacts.a_share.direction) || '中性';
      impactsMap['虚拟币'] = (rawImpacts.crypto && rawImpacts.crypto.direction) || (rawImpacts.virtual_currency && rawImpacts.virtual_currency.direction) || '中性';
    }
    return impactsMap;
  }

  async analyze(alertData) {
    let text = '';
    if (typeof alertData === 'string') {
      text = alertData.trim();
    } else if (alertData && typeof alertData === 'object') {
      const title = alertData.title || '';
      const content = alertData.content || alertData.text || '';
      text = `${title} ${content}`.trim();
    }

    // 1. 日程预告自动拦截
    if (this.isPendingOrScheduleEvent(text)) {
      return {
        ai_source: '日程预告',
        source_type: 'schedule',
        is_pending: true,
        summary: '重要宏观数据/会议预告，具体结果尚未出炉，市场保持观望。',
        impacts: {
          '黄金': '中性',
          '美元': '中性',
          '原油': '中性',
          'A股': '中性',
          '虚拟币': '中性'
        }
      };
    }

    const cfg = this.configManager.config;
    const aiCfg = cfg.ai_analysis || {};
    const timeoutSec = aiCfg.timeout_sec || 6;

    // 检查 DeepSeek 与 智谱 API Keys
    const deepseekKey = (aiCfg.deepseek_api_key || aiCfg.api_key || '').trim();
    const zhipuKey = (aiCfg.zhipu_api_key || '').trim();

    const deepseekUrl = (aiCfg.deepseek_api_url || 'https://api.deepseek.com/chat/completions').trim();
    const zhipuUrl = (aiCfg.zhipu_api_url || 'https://open.bigmodel.cn/api/paas/v4/chat/completions').trim();

    const deepseekModel = aiCfg.deepseek_model || 'deepseek-chat';
    const zhipuModel = aiCfg.zhipu_model || 'glm-4-flash';

    const availableProviders = [];
    if (deepseekKey) {
      availableProviders.push({
        id: 'deepseek',
        name: 'DeepSeek 大模型',
        url: deepseekUrl,
        key: deepseekKey,
        model: deepseekModel
      });
    }
    if (zhipuKey) {
      availableProviders.push({
        id: 'zhipu',
        name: '智谱 GLM 大模型',
        url: zhipuUrl,
        key: zhipuKey,
        model: zhipuModel
      });
    }

    // 2. 如果配置了大模型（支持单模型、双模型动态负载均衡/轮询与失败自动切换）
    if (availableProviders.length > 0 && aiCfg.enabled !== false) {
      // 动态选择首选模型（如果都配置了，双向轮流调度）
      let primaryIdx = 0;
      if (availableProviders.length > 1) {
        primaryIdx = (this.roundRobinIndex++) % availableProviders.length;
      }
      const first = availableProviders[primaryIdx];
      const second = availableProviders.length > 1 ? availableProviders[(primaryIdx + 1) % availableProviders.length] : null;

      try {
        const res = await this.callLlmApi(first.id, first.url, first.key, first.model, text, timeoutSec);
        if (res) {
          return {
            ai_source: first.name,
            source_type: first.id,
            is_pending: false,
            summary: res.summary,
            impacts: this.formatImpacts(res.impacts)
          };
        }
      } catch (e) {
        console.warn(`[FinancialAI] ${first.name} 调用异常，尝试备用通道:`, e.message);
      }

      // 如果首选失败且配置了第二模型，动态无缝切换至备选模型
      if (second) {
        try {
          const res2 = await this.callLlmApi(second.id, second.url, second.key, second.model, text, timeoutSec);
          if (res2) {
            return {
              ai_source: second.name,
              source_type: second.id,
              is_pending: false,
              summary: res2.summary,
              impacts: this.formatImpacts(res2.impacts)
            };
          }
        } catch (e2) {
          console.warn(`[FinancialAI] 备选 ${second.name} 亦异常:`, e2.message);
        }
      }
    }

    // 3. 都没配置 或 调用均失败时，全自动降级为本地规则默认分析
    const fallback = this.ruleBasedAnalysis(text);
    fallback.ai_source = '本地规则默认分析';
    fallback.source_type = 'rule_engine';
    return fallback;
  }

  ruleBasedAnalysis(text) {
    const t = text.toLowerCase();
    const res = {
      is_pending: false,
      summary: '',
      impacts: {
        '黄金': '中性',
        '美元': '中性',
        '原油': '中性',
        'A股': '中性',
        '虚拟币': '中性'
      }
    };

    if (['比特币', '以太坊', 'btc', 'eth', 'sol', '币圈', '加密货币', '虚拟币', '区块链', 'web3', 'sec批准', 'etf资金流入'].some(w => t.includes(w))) {
      res.summary = '加密资产热点事件驱动，链上流动性与情绪明显活跃';
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    if (['关税', '加征', '贸易战', '反倾销', '出口管制', '贸易摩擦', '贸易保护'].some(w => t.includes(w))) {
      res.summary = '国际关税与贸易摩擦升级，推升二次通胀预期并扰动全球供应链';
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利好';
      res.impacts['A股'] = '利空';
      res.impacts['原油'] = '利空';
      return res;
    }

    if (['遇袭', '袭击', '爆炸', '油轮', '沙特', '伊朗', '中东', '战争', '导弹', '军方', '制裁', '冲突'].some(w => t.includes(w))) {
      res.summary = '地缘局势突发升级，刺激避险买盘与断供恐慌';
      res.impacts['黄金'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['美元'] = '利好';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    if (['降息', '宽松', '鸽派', '通胀放缓', '失业率上升', 'cpi回落', '降准'].some(w => t.includes(w))) {
      res.summary = '流动性宽松预期升温，无息资产与权益风险资产获提振';
      res.impacts['黄金'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['A股'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['美元'] = '利空';
      return res;
    }

    if (['加息', '鹰派', '紧缩', '非农超预期', '通胀超预期', '维持高利率'].some(w => t.includes(w))) {
      res.summary = '紧缩延续推高美债收益率，大宗与权益投机品承压';
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利空';
      res.impacts['原油'] = '利空';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    if (['a股', '股票', '股市', '大盘', '上证', '深证', '创业板', '盘前', '要闻速递', '扭亏为盈', '净利润增长', '回购'].some(w => t.includes(w))) {
      res.summary = '核心产业链盈利向好，稳固宏观风险偏好与估值修复';
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      return res;
    }

    res.summary = '宏观政策与产业要闻密集释放，市场多空博弈均衡';
    return res;
  }

  async testApiKey(provider, apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) {
      return { success: false, msg: '请先填入 API Key 再测试' };
    }

    const cfg = this.configManager.config;
    const aiCfg = cfg.ai_analysis || {};
    const isDs = provider === 'deepseek';

    const apiUrl = isDs
      ? (aiCfg.deepseek_api_url || 'https://api.deepseek.com/chat/completions')
      : (aiCfg.zhipu_api_url || 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    const model = isDs
      ? (aiCfg.deepseek_model || 'deepseek-chat')
      : (aiCfg.zhipu_model || 'glm-4-flash');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    try {
      const resp = await fetchFn(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 5
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        return { success: true, msg: '鉴权成功！大模型响应正常就绪' };
      } else {
        let errDesc = '';
        try {
          const errJson = await resp.json();
          errDesc = errJson.error ? (errJson.error.message || JSON.stringify(errJson.error)) : JSON.stringify(errJson);
        } catch (e) {
          errDesc = `HTTP ${resp.status} (${resp.statusText})`;
        }
        return { success: false, msg: errDesc || `HTTP ${resp.status}` };
      }
    } catch (e) {
      clearTimeout(timeoutId);
      return { success: false, msg: `网络请求失败: ${e.message}` };
    }
  }
}

module.exports = FinancialAIEngine;
