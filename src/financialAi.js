const TOP_10_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek (深度求索)',
    desc: '国产大模型性价比之王，金融逻辑严密，综合性价比极高',
    url: 'https://api.deepseek.com/chat/completions',
    balanceUrl: 'https://api.deepseek.com/user/balance',
    defaultModel: 'deepseek-chat',
    tag: '首选高精',
    hasBalanceApi: true
  },
  {
    id: 'zhipu',
    name: '智谱 GLM (清言)',
    desc: '清华系全能模型，glm-4-flash 极速低成本、高并发保障',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4-flash',
    tag: '极速轻量',
    hasBalanceApi: false
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    desc: '长上下文先驱，超大窗口宏观事件脉络梳理能力拔群',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    balanceUrl: 'https://api.moonshot.cn/v1/users/me/balance',
    defaultModel: 'moonshot-v1-8k',
    tag: '长文先驱',
    hasBalanceApi: true
  },
  {
    id: 'qwen',
    name: '通义千问 (阿里百炼)',
    desc: '阿里云通义千问兼容接口，金融与政经理解全面稳定',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-turbo',
    tag: '阿里百炼',
    hasBalanceApi: false
  },
  {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    desc: '云端聚合加速，预置 DeepSeek-V3 / Qwen2.5 满血版算力',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    balanceUrl: 'https://api.siliconflow.cn/v1/user/info',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    tag: '聚合加速',
    hasBalanceApi: true
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    desc: '跃问阶跃星辰系列，强逻辑严密推理与因果归因',
    url: 'https://api.stepfun.com/v1/chat/completions',
    defaultModel: 'step-1-8k',
    tag: '逻辑推理',
    hasBalanceApi: false
  },
  {
    id: 'lingyi',
    name: '零一万物 (01.AI / Yi)',
    desc: '李开复团队零一万物，yi-lightning 毫秒级闪电推理',
    url: 'https://api.lingyiwanwu.com/v1/chat/completions',
    defaultModel: 'yi-lightning',
    tag: '闪电轻快',
    hasBalanceApi: false
  },
  {
    id: 'minimax',
    name: 'MiniMax (海螺 AI)',
    desc: '自研 MoE 架构，中文财经语义与深度对话精准自然',
    url: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    defaultModel: 'abab6.5s-chat',
    tag: '海螺自研',
    hasBalanceApi: false
  },
  {
    id: 'baichuan',
    name: '百川智能 (Baichuan)',
    desc: '百川智能大模型，中文政经百科知识储备底蕴深厚',
    url: 'https://api.baichuan-ai.com/v1/chat/completions',
    defaultModel: 'Baichuan4-Air',
    tag: '中文深厚',
    hasBalanceApi: false
  },
  {
    id: 'custom',
    name: 'OpenAI 规范 / 自定义代理',
    desc: '支持 OneAPI、NewAPI、自建反代或 OpenAI 官方中转',
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    tag: '通用中转',
    hasBalanceApi: false,
    isCustom: true
  }
];

let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron.net;
} catch (e) {}

class FinancialAIEngine {

  getAvailableProviders(aiCfg) {
    const list = [];
    const keysMap = (aiCfg && typeof aiCfg.keys === 'object' && aiCfg.keys !== null) ? aiCfg.keys : {};

    const dsKey = (keysMap.deepseek || aiCfg.deepseek_api_key || aiCfg.api_key || '').trim();
    const zpKey = (keysMap.zhipu || aiCfg.zhipu_api_key || '').trim();

    for (const prov of TOP_10_PROVIDERS) {
      let key = '';
      if (prov.id === 'deepseek') key = dsKey;
      else if (prov.id === 'zhipu') key = zpKey;
      else key = (keysMap[prov.id] || '').trim();

      if (key) {
        const url = (prov.id === 'custom' && aiCfg.custom_url) ? aiCfg.custom_url.trim() : prov.url;
        const model = (prov.id === 'custom' && aiCfg.custom_model) ? aiCfg.custom_model.trim() : prov.defaultModel;
        list.push({
          id: prov.id,
          name: prov.name,
          url,
          key,
          model,
          tag: prov.tag
        });
      }
    }
    return list;
  }

  async checkDeepSeekBalance(apiKey) {
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const resp = await fetchFn('https://api.deepseek.com/user/balance', {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && Array.isArray(data.balance_infos) && data.balance_infos.length > 0) {
        const info = data.balance_infos[0];
        const curr = info.currency === 'CNY' ? '¥' : String.fromCharCode(36);
        return curr + info.total_balance;
      }
    }
    return null;
  }

  async checkMoonshotBalance(apiKey) {
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const resp = await fetchFn('https://api.moonshot.cn/v1/users/me/balance', {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.data && data.data.available_balance !== undefined) {
        return '¥' + Number(data.data.available_balance).toFixed(2);
      }
    }
    return null;
  }

  async checkSiliconFlowBalance(apiKey) {
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
    const resp = await fetchFn('https://api.siliconflow.cn/v1/user/info', {
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.data && (data.data.balance !== undefined || data.data.totalBalance !== undefined)) {
        const bal = data.data.balance || data.data.totalBalance;
        return '¥' + Number(bal).toFixed(2);
      }
    }
    return null;
  }
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
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object') {
        if (parsed.impact_score !== undefined && parsed.impact_score !== null) {
          const s = Number(parsed.impact_score);
          parsed.impact_score = isNaN(s) ? null : Math.max(0, Math.min(100, Math.round(s)));
        }
      }
      return parsed;
    } catch (e) {
      return null;
    }
  }

  detectWatchlistImpact(text, watchlist) {
    if (!Array.isArray(watchlist) || watchlist.length === 0 || !text) return null;
    const t = text.toLowerCase();
    for (const item of watchlist) {
      if (!item || !item.name) continue;
      const rawName = item.name.trim();
      const shortName = rawName.replace(/(?:控股|股份|集团|科技|有限公司|公司)$/g, '').trim();

      let matched = false;
      if (t.includes(rawName.toLowerCase())) {
        matched = true;
      } else if (shortName.length >= 2 && t.includes(shortName.toLowerCase())) {
        matched = true;
      }

      if (matched) {
        const isBull = ['暴涨', '涨停', '大涨', '盈利', '净利润', '增长', '突破', '利好', '回购', '增持', '上调', '胜诉', '获批', '创新高', '超预期', '订单'].some(w => t.includes(w));
        const isBear = ['暴跌', '跌停', '大跌', '亏损', '下滑', '立案', '调查', '重罚', '处分', '减持', '做空', '下调', '警告', '被查', '违规', '利空'].some(w => t.includes(w));

        let direction = '持仓关注';
        let reason = `自选标的【${rawName}】出现重要动态`;
        if (isBull && !isBear) {
          direction = '直接利好';
          reason = `自选标的【${rawName}】迎来正面利好催化`;
        } else if (isBear && !isBull) {
          direction = '突发利空';
          reason = `自选标的【${rawName}】面临突发利空承压`;
        }

        return {
          target: rawName,
          direction,
          reason
        };
      }
    }
    return null;
  }

  async callLlmApi(provider, apiUrl, apiKey, model, text, timeoutSec = 6, watchlistNames = []) {
    let watchlistHint = '';
    if (watchlistNames && watchlistNames.length > 0) {
      watchlistHint = `用户的自选股票池包括: [${watchlistNames.join(', ')}]。如果新闻内容直接涉及这些自选股，请在 JSON 的 "watchlist_impact" 字段中返回 {"target": "股票名", "direction": "直接利好/突发利空/重点关注", "reason": "10字以内原因"}，否则为 null。`;
    }

    const systemPrompt = `你是一名顶级量化宏观对冲基金的首席事件策略分析师与金融NLP量化研判系统。
你的任务是针对最新财经/政经突发要闻与权威推文，给出极度精炼、客观求真、不夸大、不编造的深度研判（30字以内），并评估其对五大核心资产【黄金、美元、原油、A股、虚拟币】在未来短中期的真实传导影响（方向严格限定在【利好】、【利空】、【中性】中三选一）。

【特别警示与打分铁律】：
1. 真实与中性原则：绝大多数日常言论、社会文化争论、个人私生活、意识形态议题对全球金融资产无实质影响，严禁强行牵强附会推导利好利空！凡与金融/宏观/产业无直接事实关系的事件，各资产必须全部评为【中性】，行情影响分必须打 0 分！
2. 区分【已确认实锤事实】与【推测/预测/口水/分析师观点】：
   - 包含“料”、“预计”、“可能”、“恐”、“或”、“倾向于”、“分析师称”等未落地言论，属于纯观点预期，影响度必须大幅打折，打分严格限制在 10-35 分以内！
   - 只有主要央行正式公布利率决议、统计局正式发布关键经济数据（CPI/非农）、国家元首正式签署法案/实施制裁、重大突发战争或黑天鹅事件，才属于高烈度事件！

【impact_score (0-100) 量化标准】：
- 0分：纯非金融话题（文化/性别/种族/生活/花边）、日常问候、休市日历或纯中性消息。
- 10-35分：分析师预测、主观猜测（含“料/或/恐/预计”等）、日常盘面回顾、未落实的外交口头表态。
- 36-55分：符合预期的常规经济数据、一般部委例行工作通知、常规行业动态。
- 56-75分：超预期的重要经济数据、重要政策正式落地出台、行业重磅监管变动。
- 76-100分：决定性历史时刻或重大黑天鹅（央行正式加息/降息决议生效、突发战争冲突、重大金融机构暴雷、不可抗力熔断）。

${watchlistHint}
你必须严格返回以下 JSON 格式，不要携带任何 Markdown 标记或多余字符：
{
  "is_pending": false,
  "summary": "针对本条新闻的客观精炼研判，不超过30字",
  "impact_score": 0,
  "impacts": {
    "gold": {"name": "黄金", "direction": "中性"},
    "usd": {"name": "美元", "direction": "中性"},
    "oil": {"name": "原油", "direction": "中性"},
    "a_share": {"name": "A股", "direction": "中性"},
    "crypto": {"name": "虚拟币", "direction": "中性"}
  },
  "watchlist_impact": null
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
      } else {
        let errDesc = '';
        try {
          const errJson = await resp.json();
          errDesc = errJson.error ? (errJson.error.message || JSON.stringify(errJson.error)) : JSON.stringify(errJson);
        } catch (e) {
          errDesc = `HTTP ${resp.status}`;
        }
        throw new Error(`${resp.status}: ${errDesc}`);
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

  async analyzeLocalGov(alertData, availableProviders, timeoutSec) {
    const text = `${alertData.title || ''}\n${alertData.content || ''}`.trim();
    const isPersonnel = (alertData.sub_source === '政务人事' || (alertData.title && (alertData.title.includes('任免') || alertData.title.includes('任职') || alertData.title.includes('公示'))));
    const systemPrompt = isPersonnel
      ? `你是一位专注于党政机关领导人事任免与省市班子变动的权威政情分析顾问。
你的任务是针对最新发布的【党委常委变动、省市府领导班子调整、厅局长任命、干部任前公示】，用大白话提炼出 30 字以内的核心事实结论（包含：主要官员姓名、新任或免去的重要职务）。

【铁律要求】：
1. 绝对保真：仅基于原文提炼官方任命，严禁脑补任何未提及的个人信息。
2. 提取核心干货：明确写出“谁 任/免 什么职务”或“谁 进行任前公示”。
3. 纯净政务信息：不涉及任何金融资产，严禁生成任何金融利好利空分析。

你必须严格返回以下 JSON 格式：
{
  "summary": "30字以内的政务人事任免大白话事实结论"
}`
      : `你是一位专注于城市规划、住建规划、轨道交通与民生问答的政务权威分析顾问。
你的任务是针对最新发布的【政府规划公示、控规修改、地铁进展、官方问政答复】，用大白话为普通市民提炼出 30 字以内的确定性核心结论。

【铁律要求】：
1. 绝对保真、拒绝脑补：只能基于原文已有事实进行总结。如果官方答复是“正在研究”或“暂无规划”，必须明确说“暂无规划”；严禁脑补任何未在文中提及的年份、学校品牌或拆迁金额。
2. 提取核心干货：直接写明涉及的【项目/地块/地铁站名】以及【实质性进展/官方定性回复】。
3. 纯净民生信息：本条为本地民生规划，不涉及任何金融资产，严禁生成任何金融利好利空分析。

你必须严格返回以下 JSON 格式：
{
  "summary": "30字以内的民生规划核心干货大白话结论"
}`;

    if (availableProviders && availableProviders.length > 0) {
      for (const prov of availableProviders) {
        try {
          const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
          const resp = await fetchFn(prov.url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${prov.key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: prov.model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
              ],
              temperature: 0.1,
              response_format: { type: 'json_object' }
            }),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (resp.ok) {
            const json = await resp.json();
            const rawContent = json.choices?.[0]?.message?.content;
            if (rawContent) {
              const parsed = JSON.parse(rawContent.trim());
              return {
                ai_source: prov.name,
                source_type: prov.id,
                is_pending: false,
                summary: parsed.summary || '官方发布规划与民生信息，点击卡片可查验图纸原件。',
                impact_score: 0,
                sentiment_chips: [],
                impacts: null,
                watchlist_impact: null
              };
            }
          }
        } catch (e) {
          console.warn(`[FinancialAI] 本地规划 ${prov.name} 解读异常:`, e.message);
        }
      }
    }

    return {
      ai_source: '本地规则默认分析',
      source_type: 'rule_engine',
      is_pending: false,
      summary: isPersonnel
        ? ((alertData.title || '').replace(/^【[^】]+】/, '').trim() || '官方发布省市领导干部任免与人事调整通知，点击卡片可查看原文公告。')
        : '官方发布最新规划公示或民生答复，点击卡片可直接调取原网页查看高清图纸与红头答复。',
      impact_score: 0,
      sentiment_chips: [],
      impacts: null,
      watchlist_impact: null
    };
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
        impact_score: 0,
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
    const watchlist = (cfg.watchlist && cfg.watchlist.stocks) || [];
    const watchlistNames = watchlist.map(s => s.name).filter(Boolean);

    const availableProviders = this.getAvailableProviders(aiCfg);

    // 关键分支：针对“本地周边”专属民生政务规划，不参与任何金融多空评级，专精于大白话提炼事实干货
    if (alertData && (alertData.source_key === 'local_gov' || alertData.source === '本地周边')) {
      return await this.analyzeLocalGov(alertData, availableProviders, timeoutSec);
    }

    let finalResult = null;

    // 2. 如果配置了大模型（支持单模型、双模型动态负载均衡/轮询与失败自动切换）
    let lastErrorReason = null;

    if (availableProviders.length > 0 && aiCfg.enabled !== false) {
      const strategy = aiCfg.strategy || 'failover';
      let candidateQueue = [];

      if (strategy === 'designated') {
        const targetId = aiCfg.designated_provider || 'deepseek';
        const target = availableProviders.find(p => p.id === targetId);
        if (target) {
          candidateQueue = [target, ...availableProviders.filter(p => p.id !== targetId)];
        } else {
          candidateQueue = [...availableProviders];
        }
      } else if (strategy === 'round_robin') {
        const startIdx = (this.roundRobinIndex++) % availableProviders.length;
        candidateQueue = [
          ...availableProviders.slice(startIdx),
          ...availableProviders.slice(0, startIdx)
        ];
      } else {
        // failover: 默认智能主备容灾
        candidateQueue = [...availableProviders];
      }

      for (let i = 0; i < candidateQueue.length; i++) {
        const prov = candidateQueue[i];
        try {
          const res = await this.callLlmApi(prov.id, prov.url, prov.key, prov.model, text, timeoutSec, watchlistNames);
          if (res) {
            finalResult = {
              ai_source: prov.name,
              source_type: prov.id,
              is_pending: false,
              summary: res.summary,
              impact_score: res.impact_score !== undefined ? res.impact_score : null,
              impacts: this.formatImpacts(res.impacts),
              watchlist_impact: res.watchlist_impact || null
            };
            lastErrorReason = null;
            break;
          }
        } catch (e) {
          console.warn('[FinancialAI] ' + prov.name + ' 调用异常:', e.message);
          if (e.message.includes('402') || e.message.includes('Insufficient Balance') || e.message.includes('balance') || e.message.includes('quota')) {
            lastErrorReason = prov.name + '余额不足';
          } else if (e.message.includes('401')) {
            lastErrorReason = prov.name + 'Key无效';
          } else if (e.message.includes('abort') || e.message.includes('timeout')) {
            lastErrorReason = prov.name + '超时';
          } else if (e.message.includes('429')) {
            lastErrorReason = prov.name + '限流';
          } else {
            lastErrorReason = prov.name + '异常';
          }
        }
      }
    }

    // 3. 都没配置 或 调用均失败时，全自动降级为本地增强策略分析
    if (!finalResult) {
      finalResult = this.ruleBasedAnalysis(text, alertData);
      if (lastErrorReason) {
        finalResult.ai_source = `本地策略分析 (${lastErrorReason})`;
      } else {
        finalResult.ai_source = '本地策略离线分析';
      }
      finalResult.source_type = 'rule_engine';
    }

    // 4. 始终以本地规则引擎做自选股命中兜底，确保 100% 不漏报
    if (!finalResult.watchlist_impact) {
      const localWl = this.detectWatchlistImpact(text, watchlist);
      if (localWl) {
        finalResult.watchlist_impact = localWl;
      }
    }

    // 5. 结合本地策略与AI研判综合得出最终行情影响分 (0-100)
    finalResult.impact_score = this.calculateImpactScore(alertData, finalResult);

    // 关键规范：若行情影响为 0 分（无影响/纯中性/非金融社会议题），清空所有利好/利空方向，统一重置为“中性”，杜绝荒谬误判
    if (finalResult.impact_score === 0) {
      if (finalResult.impacts) {
        for (const k of Object.keys(finalResult.impacts)) {
          if (typeof finalResult.impacts[k] === 'object' && finalResult.impacts[k] !== null) {
            finalResult.impacts[k].direction = '中性';
          } else {
            finalResult.impacts[k] = '中性';
          }
        }
      }
      finalResult.watchlist_impact = null;
    }

    return finalResult;
  }

  /**
   * 结合本地策略（关键词/星级/VIP/自选股）与 AI 多空研判综合计算行情影响评分 (0-100)
   * 0: 代表没有触发分析的必要，或纯中性行情
   * 100: 必然大涨或大跌 (重磅黑天鹅、决议、自选股直接涨停跌停)
   * 80: 大概率 (80% 概率会引发板块或标的大涨大跌)
   */
  calculateImpactScore(alertData, aiAnalysis) {
    if (!alertData && !aiAnalysis) return 0;
    
    // 0. 日程/会议预告或无实质结果快讯 -> 0分（纯中性或无分析必要）
    if (aiAnalysis && aiAnalysis.is_pending) {
      return 0;
    }

    // 本地周边民生规划公告 -> 0分（纯本地政务，不计入金融行情波动）
    if (alertData && (alertData.source_key === 'local_gov' || alertData.source === '本地周边' || (typeof alertData.source === 'string' && alertData.source.includes('本地周边')))) {
      return 0;
    }

    let title = '';
    let content = '';
    if (typeof alertData === 'string') {
      content = alertData;
    } else if (alertData && typeof alertData === 'object') {
      title = alertData.title || '';
      content = alertData.content || alertData.text || '';
    }
    const fullText = `${title} ${content}`.toLowerCase();

    // 1. 非金融社会文化/意识形态/个人私生活言论 -> 零盘面波动，直接一票归零！
    const nonFinancialWords = [
      '白人', '黑人', '男性气质', '女性气质', '种族', '身份政治', '性别', '性取向', 
      '同性', '平权', '多元化', '跨性别', '意识形态', '宗教', '价值观', '私人生活', 
      '绯闻', '出轨', '八卦', '明星', '综艺', '恋情', '离婚'
    ];
    const coreFinancialWords = [
      '降息', '加息', 'cpi', 'gdp', '财报', '利润', '净利润', '营收', '股票', 
      'a股', '大盘', '加税', '关税', '非农', '准备金率', '违约', '破产', '涨停', '跌停'
    ];
    const hasCoreFinance = coreFinancialWords.some(w => fullText.includes(w));
    if (!hasCoreFinance && nonFinancialWords.some(w => fullText.includes(w))) {
      return 0;
    }

    // 2. VIP 顶级法定事实黑天鹅 -> 必然引发极端行情，直接满分 100 分
    const vipKws = ['导弹袭击', '总统遇难', '宣战', '核打击', '核武器', '军事政变', '特大突发', '宣布破产', '暂停交易', '特大黑天鹅', '全面爆发', '紧急熔断'];
    for (const kw of vipKws) {
      if (fullText.includes(kw.toLowerCase())) {
        return 100;
      }
    }

    // 3. 自选股直接命中强催化
    const wl = (aiAnalysis && aiAnalysis.watchlist_impact) || (alertData && alertData.watchlist_impact);
    if (wl && wl.target) {
      const dir = wl.direction || '';
      if (dir.includes('利好') || dir.includes('利空') || dir.includes('涨停') || dir.includes('跌停')) {
        const isExtreme = ['涨停', '跌停', '立案', '重组', '退市', '暴增', '暴跌', '违约'].some(w => fullText.includes(w));
        return isExtreme ? 90 : 75;
      }
    }

    // 4. 判断推测性/预测性/主观猜测词汇 (Speculative Penalty)
    const speculationWords = ['料', '或', '可能', '预计', '恐遭', '或将', '或许', '猜测', '推断', '大概念', '倾向于', '恐', '或释放', '分析师表示', '分析师称', '专家预计', '经济学家认为', '若', '假如'];
    const hasSpeculation = speculationWords.some(w => fullText.includes(w));

    // 5. 汇总流水账类快讯 (Summary Post)
    const summaryKeywords = ['盘前市场要闻速递', '盘前要闻', '要闻汇总', '早间速递', '早报', '晚报', '收评', '午间回顾', '市场要闻', '要闻速递', '要闻一览'];
    const isSummaryPost = summaryKeywords.some(w => fullText.includes(w));

    // 6. 核心实锤落地动作词
    const confirmedActionWords = [
      '正式宣布降息', '正式宣布加息', '下调基准利率', '上调基准利率', '下调存款准备金率', 
      '正式签署', '决定制裁', '正式生效', '实施关税', '非农就业人数增加', 'cpi同比上涨', '决议公布'
    ];
    const hasConfirmedAction = confirmedActionWords.some(w => fullText.includes(w));

    // 7. 提取 AI 原始打分
    let aiScore = null;
    if (aiAnalysis && typeof aiAnalysis.impact_score === 'number' && !isNaN(aiAnalysis.impact_score)) {
      aiScore = Math.max(0, Math.min(100, Math.round(aiAnalysis.impact_score)));
    }

    // 8. 本地规则基础分
    let localScore = 25; // 默认常规快讯基准分 25 分
    if (hasConfirmedAction) {
      localScore = 80;
    } else {
      const macroKeywords = [
        '降息', '加息', '非农', 'cpi', '关税', '通胀', '违约', '制裁', '涨停', '跌停', '暴涨', '暴跌', '印花税', '熔断', '崩盘',
        '就业', '招聘', '失业率', '荣枯线', 'pmi', 'gdp', 'ppi', '停火', '停战', '宣战', '冲突'
      ];
      const hitMacro = macroKeywords.some(w => fullText.includes(w));
      if (hitMacro) {
        localScore = 50;
      }
    }

    // 9. 宏观高权重星级指标加权 (经济日历客观权威星级)
    if (alertData && typeof alertData === 'object') {
      const econStar = (alertData.economic_data && alertData.economic_data.star !== undefined) 
        ? Number(alertData.economic_data.star) 
        : 0;
      if (econStar >= 5) {
        localScore = Math.max(localScore, 85);
      } else if (econStar >= 4) {
        localScore = Math.max(localScore, 70);
      } else if (econStar >= 3) {
        localScore = Math.max(localScore, 50);
      }
    }

    // 10. 推测词强力惩罚：如果包含“料/或/恐/预计/大概念/可能”等推测词，且不是已敲定落地动作，顶格严惩至 35 分以内！
    if (hasSpeculation && !hasConfirmedAction) {
      localScore = Math.min(localScore, 35);
      if (aiScore !== null) {
        aiScore = Math.min(aiScore, 35);
      }
    }

    // 11. 汇总流水账封顶 40 分
    if (isSummaryPost) {
      localScore = Math.min(localScore, 40);
      if (aiScore !== null) {
        aiScore = Math.min(aiScore, 40);
      }
    }

    // 12. 纯日常/低价值生活类惩罚归零
    const neutralWords = ['早安', '周末愉快', '日历', '日程', '休市'];
    if (neutralWords.some(w => fullText.includes(w))) {
      localScore = 0;
      if (aiScore !== null) aiScore = 0;
    }

    // 13. 综合 AI 打分与本地规则 (AI 55% + 本地规则 45%)
    let finalScore = localScore;
    if (aiScore !== null) {
      finalScore = Math.round(aiScore * 0.55 + localScore * 0.45);
    }

    // 终极保护：凡带推测词者，无论如何不得超过 35 分
    if (hasSpeculation && !hasConfirmedAction) {
      finalScore = Math.min(finalScore, 35);
    }

    // 若得分低于 15 分，视作市场背景杂音，彻底归零为 0 分
    if (finalScore < 15) {
      finalScore = 0;
    }

    return Math.max(0, Math.min(100, finalScore));
  }

  extractSubject(text, alertData = null) {
    const t = text || '';
    // 1. 国际主要国家、地区与央行
    if (/英国|英格兰|rec|kpmg/i.test(t)) return { name: '英国', cb: '英国央行', curr: '英镑' };
    if (/美联储|鲍威尔|fomc|非农|白宫|美国劳工部|美国cpi|美债/i.test(t)) return { name: '美联储/美国', cb: '美联储', curr: '美元' };
    if (/欧洲央行|拉加德|欧元区/i.test(t)) return { name: '欧洲央行', cb: '欧洲央行', curr: '欧元' };
    if (/日本央行|植田和男|日元|日经/i.test(t)) return { name: '日本央行', cb: '日本央行', curr: '日元' };
    if (/人民银行|中国央行|央行公开市场|mlf|逆回购/i.test(t)) return { name: '中国央行', cb: '人民银行', curr: '人民币' };
    
    // 2. 宏观部委与监管
    if (/财政部|发改委|证监会|工信部|商务部/i.test(t)) {
      const m = t.match(/财政部|发改委|证监会|工信部|商务部/);
      return { name: m ? m[0] : '部委宏观政策', cb: '宏观政策层', curr: 'A股' };
    }
    
    // 3. 产油国组织与能源核心
    if (/欧佩克|opec\+|opec|沙特阿美|产油国/i.test(t)) return { name: 'OPEC+产油国', cb: null, curr: '原油' };
    
    // 4. 全球核心硬科技与资产龙头
    if (/英伟达|nvidia/i.test(t)) return { name: '英伟达', cb: null, curr: '科技股' };
    if (/微软|microsoft/i.test(t)) return { name: '微软', cb: null, curr: '科技股' };
    if (/苹果|apple/i.test(t)) return { name: '苹果', cb: null, curr: '消费电子' };
    if (/特斯拉|tesla/i.test(t)) return { name: '特斯拉', cb: null, curr: '新能源车' };
    if (/比特币|btc/i.test(t)) return { name: '比特币', cb: null, curr: '加密货币' };
    if (/以太坊|eth/i.test(t)) return { name: '以太坊', cb: null, curr: '加密货币' };
    if (/波音|空客|台积电|asml|丰田|大众|比亚迪|宁德时代|中芯国际|腾讯|阿里|美团/i.test(t)) {
      const m = t.match(/波音|空客|台积电|asml|丰田|大众|比亚迪|宁德时代|中芯国际|腾讯|阿里|美团/i);
      return { name: m[0], cb: null, curr: '核心标的' };
    }
    
    // 5. 核心城市楼市
    if (/广州|深圳|北京|上海|杭州|成都/i.test(t) && /限购|首付|楼市|房贷/i.test(t)) {
      const city = t.match(/广州|深圳|北京|上海|杭州|成都/)[0];
      return { name: city + '楼市', cb: null, curr: '房地产' };
    }

    // 6. 地缘热点国家与区域
    if (/以色列|内塔尼亚胡|以军/i.test(t)) return { name: '以色列/中东', cb: null, curr: '黄金原油' };
    if (/伊朗/i.test(t)) return { name: '伊朗', cb: null, curr: '原油' };
    if (/俄罗斯|普京|俄军/i.test(t)) return { name: '俄罗斯', cb: null, curr: '原油' };
    if (/乌克兰|泽连斯基/i.test(t)) return { name: '乌克兰', cb: null, curr: '地缘' };

    // 7. 通用企业/机构名称提取
    const corpMatch = t.match(/[\u4e00-\u9fa5]{2,10}(?:公司|企业|银行|控股|股份|科技|集团|药业|生物|证券|基金)/);
    if (corpMatch) {
      return { name: corpMatch[0], cb: null, curr: '个股基本面' };
    }

    // 8. 标题提取作为主体
    if (alertData && alertData.title) {
      const titleMatch = alertData.title.match(/^[^，,。；;\s]{2,8}/);
      if (titleMatch && titleMatch[0].length >= 2) {
        return { name: titleMatch[0], cb: null, curr: '相关要闻' };
      }
    }

    return null;
  }

  extractMilestone(text) {
    if (!text || typeof text !== 'string') return '';
    const parts = [];

    // 1. 周期/月度首次与极值 (e.g. 四个月来首次萎缩, 创今年5月以来最低)
    const m1 = text.match(/(?:近|创)?(?:[\d一二三四五六七八九十]+个?月|[\d一二三四五六七八九十]+年)?(?:来)?(?:首次|首度)[^，,。；;\s]{2,10}/);
    if (m1) parts.push(m1[0].trim());

    // 2. 荣枯线破位/重回 (e.g. 跌破50荣枯线, 重返荣枯线上方)
    const m2 = text.match(/(?:跌破|跌穿|跌落|重回|升破|站上|处于)?\s*(?:\d+(?:\.\d+)?\s*)?荣枯线/);
    if (m2 && (!m1 || !m1[0].includes('荣枯线'))) parts.push(m2[0].trim());

    // 3. 政策利率与基点 (e.g. 降息25个基点, 加息50个基点)
    const m3 = text.match(/(?:降息|加息|降准|上调|下调)\s*\d+(?:\.\d+)?\s*(?:个?基点|个?百分点|%|bps)/i);
    if (m3) parts.push(m3[0].trim());

    // 4. 行情价格与点位大关 (e.g. 突破90000美元, 站上3000点)
    const m4 = text.match(/(?:突破|站上|跌破)\s*[\d,]+(?:\.\d+)?\s*(?:点|美元|元)/);
    if (m4) parts.push(m4[0].trim());

    // 5. 核心地产/实物/能源动作 (e.g. 首套房首付降至15%, 取消限购, 全部售罄, 日均220万桶)
    const mDownPayment = text.match(/(?:首套房)?首付(?:比例)?(?:降至|下调至)?\s*\d+%/);
    if (mDownPayment) {
      parts.push(mDownPayment[0].trim());
    }
    const m5 = text.match(/(?:取消限购|降低首付|全部售罄|日均\s*\d+(?:\.\d+)?\s*万桶)/);
    if (m5 && !parts.some(p => p.includes(m5[0]))) parts.push(m5[0].trim());

    // 6. 资金量级/利润规模 (e.g. 净流入超10亿美元, 增加化债资源10万亿元, 净利润增长超40%)
    const m6 = text.match(/(?:净流入|流入|成交|净利润|增产|减产|化债资源|自愿减产)?\s*(?:超|达)?\s*[\d,]+(?:\.\d+)?\s*(?:万桶|亿美元|亿元|万亿元|%)/);
    if (m6 && !m3 && !m4 && !mDownPayment && !parts.some(p => p.includes(m6[0]))) parts.push(m6[0].trim());

    // 7. 专利/资质
    const m7 = text.match(/获.*?专利授权/);
    if (m7) parts.push(m7[0].trim());

    return parts.filter(Boolean).slice(0, 2).join('，');
  }

  formatPrecisionSummary(sub, ms, eventName, transmission) {
    let sName = sub ? sub.name : '';
    let part1 = sName;
    if (eventName) {
      part1 += eventName;
    }
    if (ms) {
      let cleanMs = ms;
      if (sName && cleanMs.startsWith(sName)) {
        cleanMs = cleanMs.slice(sName.length).trim();
      }
      if (cleanMs) {
        part1 += '（' + cleanMs + '）';
      }
    }
    if (part1) {
      return `${part1}；${transmission}`;
    }
    return transmission;
  }

  extractDynamicHeadlineSummary(text, alertData = null, sub = null, ms = '') {
    let clean = (alertData && alertData.title ? alertData.title + ' ' : '') + (alertData && alertData.content ? alertData.content : (text || ''));
    clean = clean
      .replace(/【(?:快讯|独家|突发|特报|要闻|重磅|盘中|午评|收评|盘前|早报|晚报|简讯|公告)】/g, ' ')
      .replace(/（(?:新浪财经|财联社|证券时报|第一财经|界面新闻|同花顺|新华社|路透社|彭博社|央视网|央视新闻客户端|中新社)[^）]*）/g, ' ')
      .replace(/\((?:Reuters|Bloomberg|CNBC|WSJ|AP)[^)]*\)/gi, ' ')
      .replace(/^\s*\d{1,2}月\d{1,2}日[，,\s]*/, '')
      .replace(/^(?:据.*?报道|据.*?消息|据.*?称)[，,\s]*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 优先提取清晰简练的标题
    if (alertData && alertData.title) {
      let tClean = alertData.title
        .replace(/【[^】]+】/g, '')
        .replace(/（[^）]+）/g, '')
        .replace(/\([^)]+\)/g, '')
        .trim();
      if (tClean.length >= 10 && tClean.length <= 40) {
        return tClean;
      }
    }

    const firstSentence = clean.split(/[。！？\n]/)[0].trim();
    if (firstSentence && firstSentence.length >= 10 && firstSentence.length <= 40) {
      return firstSentence;
    }

    if (sub && sub.name && ms) {
      return `${sub.name}核心要闻（${ms}）；关注后续实际商业化与市场流动性传导`;
    }

    return firstSentence.substring(0, 36) + (firstSentence.length > 36 ? '...' : '');
  }

  ruleBasedAnalysis(text, alertData = null) {
    const t = (text || '').toLowerCase();
    const res = {
      is_pending: false,
      summary: '',
      impact_score: 40,
      impacts: {
        '黄金': '中性',
        '美元': '中性',
        '原油': '中性',
        'A股': '中性',
        '虚拟币': '中性'
      }
    };

    // 0. 非金融社会文化/私生活言论过滤
    const nonFinancialWords = [
      '白人', '黑人', '男性气质', '女性气质', '种族', '身份政治', '性别', '性取向', 
      '同性', '平权', '多元化', '跨性别', '意识形态', '宗教', '价值观', '私人生活', 
      '绯闻', '出轨', '八卦', '明星', '综艺', '恋情', '离婚'
    ];
    const coreFinancialWords = [
      '降息', '加息', 'cpi', 'gdp', '财报', '利润', '净利润', '营收', '股票', 
      'a股', '大盘', '加税', '关税', '非农', '准备金率', '违约', '破产', '涨停', '跌停',
      '停战', '停火', '和谈', '原油', '黄金', '石油', '就业', '招聘', '失业率', '荣枯线', 'pmi'
    ];
    const hasCoreFinance = coreFinancialWords.some(w => t.includes(w));
    if (!hasCoreFinance && nonFinancialWords.some(w => t.includes(w))) {
      res.summary = '社会文化或日常言论，无实质金融资产传导影响';
      res.impact_score = 0;
      return res;
    }

    // 精准金融主体与异动数据智能提取
    const sub = this.extractSubject(text, alertData);
    const ms = this.extractMilestone(text);
    const cbName = sub && sub.cb ? sub.cb : '央行';
    const currName = sub && sub.curr ? sub.curr : '本币';

    // ==========================================
    // 1. 地缘政治与国际安全核心模型（严格区分：缓和停战 VS 冲突升级 VS 谈判破裂）
    // ==========================================
    const geoDeescalationNegation = ['停火破裂', '和谈破裂', '拒绝停战', '拒绝停火', '拒绝和谈', '谈判破裂', '打破停火', '撕毁协议', '停战受阻', '协议破产'];
    const geoDeescalationKeywords = [
      '停战', '停火', '和谈', '和解', '解决分歧', '停战方案', '停战协议', '停火草案', '停火协议',
      '和平方案', '和平草案', '停战草案', '协议草案', '达成停战', '签署停战', '达成停火', '签署停火',
      '达成和平协议', '签署和平协议', '局势缓和', '地缘降温', '解除制裁', '豁免制裁', '撤军',
      '释放人质', '复交', '恢复建交', '重启对话', '结束战争', '结束冲突', '互不侵犯', '和平谈判'
    ];
    const geoEscalationKeywords = [
      '遇袭', '袭击', '空袭', '导弹袭击', '遭导弹', '爆炸', '开火', '交火', '宣战',
      '全面战争', '军事打击', '地面进攻', '地面部队', '击沉', '击落', '扣押油轮', '油轮遇袭',
      '封锁海峡', '封锁霍尔木兹', '突发爆炸', '阵亡', '轰炸', '冲突升级', '战事升级', '战局恶化'
    ];

    // 1.1 谈判破裂 / 停火撕毁（明确看空权益，看多原油黄金）
    if (geoDeescalationNegation.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '地缘和谈受阻破裂', '避险情绪与供给中断担忧再度升温，强化原油黄金避险配置');
      res.impact_score = 80;
      res.impacts['原油'] = '利好';
      res.impacts['黄金'] = '利好';
      res.impacts['美元'] = '利好';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    // 1.2 地缘缓和 / 停火草案 / 达成协议
    if (geoDeescalationKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '地缘现停火和解曙光', '原油地缘溢价大幅回落，全球市场风险偏好提振回暖');
      res.impact_score = 75;
      res.impacts['原油'] = '利空';
      res.impacts['黄金'] = '利空';
      res.impacts['美元'] = '中性';
      res.impacts['A股'] = '利好';
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    // 1.3 真实冲突与军事打击突发升级
    if (geoEscalationKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '突发军事冲突升级', '原油供给断供担忧骤起，资金大举涌入黄金与美元避险');
      res.impact_score = 85;
      res.impacts['原油'] = '利好';
      res.impacts['黄金'] = '利好';
      res.impacts['美元'] = '利好';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    // ==========================================
    // 2. 国际贸易与关税政策模型（区分：加征壁垒 VS 减免豁免）
    // ==========================================
    const isTariffRelief = ['取消关税', '减免关税', '关税豁免', '免征关税', '下调关税', '达成贸易协议', '撤销出口管制', '贸易谈判取得突破', '取消加征', '撤销关税'].some(w => t.includes(w)) ||
                           ((t.includes('取消') || t.includes('减免') || t.includes('豁免') || t.includes('下调')) && t.includes('关税'));
    const tariffWarKeywords = ['加征关税', '提高关税', '征收关税', '关税战', '贸易战', '贸易摩擦', '出口管制', '反倾销税', '实体清单', '对华制裁'];

    if (isTariffRelief) {
      res.summary = this.formatPrecisionSummary(sub, ms, '关税壁垒趋于豁免缓解', '跨国贸易流通预期改善，显著提振出口供应链与风险资产');
      res.impact_score = 70;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['黄金'] = '中性';
      res.impacts['美元'] = '利空';
      return res;
    }

    if (tariffWarKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '关税与贸易摩擦升级', '推升二次通胀隐忧并扰动全球供应链分工，压制外需与权益风险偏好');
      res.impact_score = 75;
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利好';
      res.impacts['A股'] = '利空';
      res.impacts['原油'] = '利空';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    // ==========================================
    // 3. 宏观货币政策与央行流动性模型（降息宽松 VS 加息紧缩）
    // ==========================================
    const dovishKeywords = ['降息', '宽松', '降准', '降准降息', '鸽派', '下调存款准备金率', '量化宽松', '公开市场净投放', '降息25个基点', '降息50个基点'];
    const hawkishKeywords = ['加息', '紧缩', '鹰派', '上调基准利率', '维持高利率', '推迟降息', '不急于降息', '收紧银根', '量化紧缩', '缩表'];

    if (dovishKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '推进宽松降息', `基准利率调降压低借贷成本，提振黄金与高弹性流动性资产估值`);
      res.impact_score = 80;
      res.impacts['黄金'] = '利好';
      res.impacts['A股'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['美元'] = (sub && sub.name && sub.name.includes('美国')) ? '利空' : '中性';
      return res;
    }

    if (hawkishKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '延续紧缩鹰派立场', `推升国债实际收益率，无息资产与权益投机品估值承压收缩`);
      res.impact_score = 80;
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利空';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      res.impacts['原油'] = '利空';
      return res;
    }

    // ==========================================
    // 4. 就业市场与劳动力供需模型（降温走弱 VS 强劲韧性）
    // ==========================================
    const laborCoolingKeywords = [
      '就业降温', '就业市场降温', '就业走弱', '招聘萎缩', '招工萎缩', '招工放缓', 
      '首次萎缩', '跌破50荣枯线', '跌破荣枯线', '招聘指数从', '招聘指数', '劳动力市场降温',
      '裁员潮', '裁员计划', '失业率上升', '申请失业救济人数增加', '初请失业金人数超预期', '非农不及预期'
    ];
    const laborHotKeywords = [
      '就业强劲', '非农超预期', '新增非农超预期', '失业率降至', '失业率创下新低', '劳动力需求旺盛', '招工紧俏', '就业韧性'
    ];

    if (laborCoolingKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '就业招聘走弱降温', `实体用工快速收缩将倒逼${cbName}加快降息步伐，${currName}汇率承压`);
      res.impact_score = 58;
      res.impacts['黄金'] = '利好';
      res.impacts['美元'] = (sub && sub.name && sub.name.includes('美国')) ? '利空' : '中性';
      res.impacts['原油'] = '利空';
      res.impacts['A股'] = '中性';
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    if (laborHotKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '就业数据展现超预期韧性', `劳动力市场紧俏缓解经济硬着陆担忧，或压制激进降息空间`);
      res.impact_score = 60;
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利空';
      res.impacts['原油'] = '利好';
      res.impacts['A股'] = '中性';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    // ==========================================
    // 5. 宏观景气与制造业/服务业PMI模型（收缩破位 VS 重回扩张）
    // ==========================================
    const pmiContractionKeywords = [
      '制造业pmi萎缩', '服务业pmi下滑', 'pmi降至', '跌入收缩区间', '景气度低迷', '经济增长放缓', '衰退风险', '外需走弱'
    ];
    const pmiExpansionKeywords = [
      'pmi重回荣枯线', '重回扩张区间', '制造业pmi超预期', '服务业pmi强劲', '景气度显著回升', '经济企稳回升'
    ];

    if (pmiContractionKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '宏观景气与PMI收缩', `实体总需求动能偏弱，避险情绪升温并打开${cbName}逆周期托底空间`);
      res.impact_score = 58;
      res.impacts['美元'] = (sub && sub.name && sub.name.includes('美国')) ? '利空' : '中性';
      res.impacts['黄金'] = '利好';
      res.impacts['原油'] = '利空';
      res.impacts['A股'] = (sub && sub.name && sub.name.includes('中国')) ? '利空' : '中性';
      res.impacts['虚拟币'] = '中性';
      return res;
    }

    if (pmiExpansionKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '主要景气指标重返扩张区间', '供需两端共振修复，显著提振顺周期资产配置信心');
      res.impact_score = 65;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '中性';
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    // ==========================================
    // 6. 物价指数与通胀预期模型（通胀降温 VS 通胀反弹高企）
    // ==========================================
    const inflationCoolingKeywords = ['cpi回落', '通胀放缓', '通胀降温', 'cpi低于预期', '通胀走低', '物价涨幅收窄', '核心cpi放缓', 'ppi降幅扩大'];
    const inflationHotKeywords = ['cpi超预期', '通胀反弹', '通胀超预期高企', '核心通胀反弹', '再通胀', '通胀顽固', '物价超预期上涨'];

    if (inflationCoolingKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '通胀指标持续走低降温', `物价上行压力显著缓解，为${cbName}后续宽松降息打开更大操作空间`);
      res.impact_score = 65;
      res.impacts['黄金'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['A股'] = '利好';
      res.impacts['美元'] = (sub && sub.name && sub.name.includes('美国')) ? '利空' : '中性';
      res.impacts['原油'] = '中性';
      return res;
    }

    if (inflationHotKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '物价通胀超预期反弹高企', '通胀高粘性加剧再通胀担忧，降息预期受阻承压');
      res.impact_score = 70;
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利空';
      res.impacts['虚拟币'] = '利空';
      res.impacts['A股'] = '利空';
      res.impacts['原油'] = '利好';
      return res;
    }

    // ==========================================
    // 7. 房地产与城建基建模型（核心松绑支持 VS 债务违约出清）
    // ==========================================
    const realEstateSupportKeywords = ['楼市新政', '取消限购', '降低首付', '下调房贷利率', '公积金新政', '白名单项目', '保交楼', '城中村改造', '商品房销售回暖'];
    const realEstateRiskKeywords = ['房企爆雷', '房企违约', '债务重组', '销售大幅下滑', '断供'];

    if (realEstateSupportKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '信贷与限购松绑落地', '一线与重点城市政策底夯实，加速二手房去化与房企流动性改善');
      res.impact_score = 65;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['虚拟币'] = '中性';
      res.impacts['黄金'] = '中性';
      res.impacts['美元'] = '中性';
      return res;
    }

    if (realEstateRiskKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '房企融资端与债务承压', '行业处于深度调整筑底与信用出清阶段，基本面拐点仍待修复');
      res.impact_score = 65;
      res.impacts['A股'] = '利空';
      res.impacts['原油'] = '利空';
      res.impacts['美元'] = '中性';
      res.impacts['黄金'] = '利好';
      res.impacts['虚拟币'] = '中性';
      return res;
    }

    // ==========================================
    // 8. 科技与半导体/AI硬核产业链（算力爆发 VS 出口管制封锁）
    // ==========================================
    const techBullKeywords = ['算力爆发', 'ai大模型', '半导体需求', '芯片订单', '先进封装', '资本开支大增', '算力集群', '大模型发布', '智能驾驶方案落地', '芯片已全部售罄', '全部售罄', '售罄'];
    const techBearKeywords = ['芯片制裁', '先进芯片管制', '半导体出口管制', '技术封锁', '断供', '限制对华出口'];

    if (techBullKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '先进制程与算力爆发', '科技巨头Capex资本开支高位延续，提振半导体与算力产业链高景气');
      res.impact_score = 68;
      res.impacts['A股'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['美元'] = '中性';
      res.impacts['原油'] = '中性';
      res.impacts['黄金'] = '中性';
      return res;
    }

    if (techBearKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '先进制程供应链限制升级', '短期板块受地缘情绪扰动，中长期加速国产核心技术自主可控替代');
      res.impact_score = 70;
      res.impacts['A股'] = '利空';
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '中性';
      res.impacts['原油'] = '中性';
      res.impacts['虚拟币'] = '中性';
      return res;
    }

    // ==========================================
    // 9. 能源与工业大宗商品（OPEC减产挺价 VS 累库疲软增产）
    // ==========================================
    const oilBullKeywords = ['opec减产', '欧佩克减产', '延长减产', '自愿减产措施延长', '原油库存超预期下降', '天然气供给受限', '原油断供', '自愿减产'];
    const oilBearKeywords = ['原油库存增加', '原油超预期累库', '原油大幅增产', '提高石油产量', '原油需求疲软'];

    if (oilBullKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '收紧供给自愿减产挺价', '原油现货与供给端偏紧托底油价底线，短期提振大宗现货溢价');
      res.impact_score = 68;
      res.impacts['原油'] = '利好';
      res.impacts['美元'] = '利好';
      res.impacts['A股'] = '中性';
      res.impacts['黄金'] = '中性';
      res.impacts['虚拟币'] = '中性';
      return res;
    }

    if (oilBearKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '原油大宗超预期累库增产', '下游工业消耗疲软与供应放量，压制国际能源价格中枢');
      res.impact_score = 60;
      res.impacts['原油'] = '利空';
      res.impacts['美元'] = '利空';
      res.impacts['A股'] = '中性';
      res.impacts['黄金'] = '中性';
      res.impacts['虚拟币'] = '中性';
      return res;
    }

    // ==========================================
    // 10. 加密货币专属行业驱动（生态爆发 VS 暴雷黑天鹅）
    // ==========================================
    const cryptoBullKeywords = ['比特币', '以太坊', 'btc', 'eth', 'sol', '币圈', '加密货币', '虚拟币', '区块链', 'web3', 'sec批准', 'etf资金净流入', '战略储备', '稳定币法案', '比特币减半'];
    const cryptoBearKeywords = ['交易所爆仓', '黑客攻击', '清洗代币', '清盘', '破产重组', '监管打击', '下架代币', '查封交易所'];

    if (cryptoBearKeywords.some(w => t.includes(w)) && cryptoBullKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '突发监管重拳或链上清算', '链上流动性骤降引发多头踩踏抛售，短线震荡探底寻支撑');
      res.impact_score = 80;
      res.impacts['虚拟币'] = '利空';
      return res;
    }
    if (cryptoBullKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '资金持续强势净流入', '机构现货ETF买盘吸筹充沛，维持高位强势多头格局');
      res.impact_score = 68;
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    // ==========================================
    // 11. 财政刺激与宏观经济复苏（特别国债/化债/实体增长）
    // ==========================================
    const fiscalStimulusKeywords = ['特别国债', '财政发力', '地方化债', '增量财政', '超长期国债', '扩大内需', '设备更新', '以旧换新', '一揽子增量政策', '稳增长政策'];
    if (fiscalStimulusKeywords.some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '一揽子增量政策加码落地', '大幅置换地方隐性债务缓释流动性压力，利好顺周期资产与权益估值修复');
      res.impact_score = 75;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['美元'] = '利空';
      res.impacts['黄金'] = '中性';
      return res;
    }

    // ==========================================
    // 12. 权益市场（A股/港股）基本面驱动与资本市场改革
    // ==========================================
    if (['a股', '股票', '股市', '大盘', '上证', '深证', '创业板', '汇金', '增持回购', '回购', '扭亏为盈', '净利润增长', '引导长期资金', '市值管理', '分红'].some(w => t.includes(w))) {
      res.summary = this.formatPrecisionSummary(sub, ms, '基本面改善与资本回报提升', '盈利预期稳健或股东增持回购加码，稳固宏观风险偏好与估值修复');
      res.impact_score = 58;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      return res;
    }

    // ==========================================
    // 13. 终极动态语义摘要提炼器 (Dynamic Headline Extractor)
    // 坚决摒弃死板万能模板与概论套话，根据新闻本身高密度提取真实事实短句！
    // ==========================================
    const dynamicHeadline = this.extractDynamicHeadlineSummary(text, alertData, sub, ms);
    res.summary = dynamicHeadline ? dynamicHeadline : '核心要闻动态更新，关注实际宏观与产业流动性传导';
    res.impact_score = 35;
    return res;
  }

  async testApiKey(provider, apiKey, customUrl, customModel) {
    const key = String(apiKey || '').trim();
    if (!key) {
      return { success: false, msg: '请先填入 API Key 再测试' };
    }

    const prov = TOP_10_PROVIDERS.find(p => p.id === provider) || TOP_10_PROVIDERS[0];
    const apiUrl = (prov.id === 'custom' && customUrl) ? customUrl.trim() : (prov.url || 'https://api.deepseek.com/chat/completions');
    const model = (prov.id === 'custom' && customModel) ? customModel.trim() : (prov.defaultModel || 'deepseek-chat');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    const fetchFn = (electronNet && electronNet.fetch) ? electronNet.fetch.bind(electronNet) : global.fetch;

    const startTime = Date.now();
    let balanceStr = null;

    if (provider === 'deepseek') {
      try { balanceStr = await this.checkDeepSeekBalance(key); } catch (e) {}
    } else if (provider === 'moonshot') {
      try { balanceStr = await this.checkMoonshotBalance(key); } catch (e) {}
    } else if (provider === 'siliconflow') {
      try { balanceStr = await this.checkSiliconFlowBalance(key); } catch (e) {}
    }

    try {
      const resp = await fetchFn(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 2
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (resp.ok) {
        let msg = '可用 (延迟 ' + latencyMs + 'ms) · 连通正常';
        if (balanceStr) {
          msg = '可用 (延迟 ' + latencyMs + 'ms) · 💰 余额: ' + balanceStr;
        }
        return { success: true, latency: latencyMs, balance: balanceStr, msg };
      } else {
        let rawErr = '';
        try {
          const errJson = await resp.json();
          rawErr = errJson.error ? (errJson.error.message || JSON.stringify(errJson.error)) : JSON.stringify(errJson);
        } catch (e) {
          rawErr = 'HTTP ' + resp.status + ' (' + resp.statusText + ')';
        }

        let userFriendlyMsg = rawErr;
        if (resp.status === 402 || rawErr.includes('Insufficient Balance') || rawErr.includes('quota') || rawErr.includes('balance')) {
          userFriendlyMsg = '余额不足 (HTTP 402)，请充值' + (balanceStr ? ' (当前余额: ' + balanceStr + ')' : '');
        } else if (resp.status === 401 || rawErr.includes('invalid') || rawErr.includes('Authentication') || rawErr.includes('Unauthorized')) {
          userFriendlyMsg = 'API Key 无效或未授权 (HTTP 401)';
        } else if (resp.status === 429) {
          userFriendlyMsg = '接口并发超限或限流 (HTTP 429)';
        } else if (resp.status === 404) {
          userFriendlyMsg = '模型不存在或接口地址有误 (HTTP 404): ' + model;
        }

        return { success: false, balance: balanceStr, msg: userFriendlyMsg };
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError' || e.message.includes('abort') || e.message.includes('timeout')) {
        return { success: false, msg: '连接超时 (超过 7 秒未响应)' };
      }
      return { success: false, msg: '网络连接异常: ' + e.message };
    }
  }
}

module.exports = FinancialAIEngine;
module.exports.FinancialAIEngine = FinancialAIEngine;
module.exports.TOP_10_PROVIDERS = TOP_10_PROVIDERS;
