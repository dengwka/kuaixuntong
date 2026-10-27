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

    const systemPrompt = `你是一名顶级宏观对冲基金的资深首席策略分析师。
你的任务是针对抓取到的最新突发财经、政经要闻与重要博主推文（如特朗普、白宫、美联储等），给出高度精炼、入木三分的深度AI解读（字数严格控制在30字以内），敏锐研判该事件对五大核心资产：【黄金、美元、原油、A股、虚拟币】的传导影响（方向只能在【利好】、【利空】、【中性】三者中选择其一。对于时政大选动员、监管表态或宏观言论，应积极给出前瞻资产倾向，避免全部中性）。
并且针对该事件对金融市场行情影响的剧烈程度给出综合打分 impact_score (整数 0-100)：0为无影响或纯中性；60为普通波动；80为大概率引发相关标的大涨或大跌；100为必然引发暴涨暴跌或重磅黑天鹅。
${watchlistHint}
你必须严格返回以下 JSON 格式，不要携带任何额外的 Markdown 标记或多余字符：
{
  "is_pending": false,
  "summary": "针对本条新闻的精炼AI解读，不超过30字",
  "impact_score": 80,
  "impacts": {
    "gold": {"name": "黄金", "direction": "利好或利空或中性"},
    "usd": {"name": "美元", "direction": "利好或利空或中性"},
    "oil": {"name": "原油", "direction": "利好或利空或中性"},
    "a_share": {"name": "A股", "direction": "利好或利空或中性"},
    "crypto": {"name": "虚拟币", "direction": "利好或利空或中性"}
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

    let finalResult = null;

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
        const res = await this.callLlmApi(first.id, first.url, first.key, first.model, text, timeoutSec, watchlistNames);
        if (res) {
          finalResult = {
            ai_source: first.name,
            source_type: first.id,
            is_pending: false,
            summary: res.summary,
            impact_score: res.impact_score !== undefined ? res.impact_score : null,
            impacts: this.formatImpacts(res.impacts),
            watchlist_impact: res.watchlist_impact || null
          };
        }
      } catch (e) {
        console.warn(`[FinancialAI] ${first.name} 调用异常，尝试备用通道:`, e.message);
      }

      // 如果首选失败且配置了第二模型，动态无缝切换至备选模型
      if (!finalResult && second) {
        try {
          const res2 = await this.callLlmApi(second.id, second.url, second.key, second.model, text, timeoutSec, watchlistNames);
          if (res2) {
            finalResult = {
              ai_source: second.name,
              source_type: second.id,
              is_pending: false,
              summary: res2.summary,
              impact_score: res2.impact_score !== undefined ? res2.impact_score : null,
              impacts: this.formatImpacts(res2.impacts),
              watchlist_impact: res2.watchlist_impact || null
            };
          }
        } catch (e2) {
          console.warn(`[FinancialAI] 备选 ${second.name} 亦异常:`, e2.message);
        }
      }
    }

    // 3. 都没配置 或 调用均失败时，全自动降级为本地规则默认分析
    if (!finalResult) {
      finalResult = this.ruleBasedAnalysis(text);
      finalResult.ai_source = '本地规则默认分析';
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

    let title = '';
    let content = '';
    if (typeof alertData === 'string') {
      content = alertData;
    } else if (alertData && typeof alertData === 'object') {
      title = alertData.title || '';
      content = alertData.content || alertData.text || '';
    }
    const fullText = `${title} ${content}`.toLowerCase();

    // 1. VIP 顶级黑天鹅词 -> 必然引发极端行情，直接满分 100 分
    const vipKws = ['导弹袭击', '总统遇难', '宣战', '核打击', '核武器', '军事政变', '特大突发', '宣布破产', '暂停交易', '特大黑天鹅', '全面爆发', '紧急熔断'];
    for (const kw of vipKws) {
      if (fullText.includes(kw.toLowerCase())) {
        return 100;
      }
    }

    // 2. 自选股直接命中强利好/利空 -> 用户核心持仓，直达 85 - 95 分
    const wl = (aiAnalysis && aiAnalysis.watchlist_impact) || (alertData && alertData.watchlist_impact);
    if (wl && wl.target) {
      const dir = wl.direction || '';
      if (dir.includes('利好') || dir.includes('利空') || dir.includes('涨停') || dir.includes('跌停')) {
        const isExtreme = ['涨停', '跌停', '立案', '重组', '退市', '暴增', '暴跌', '违约'].some(w => fullText.includes(w));
        return isExtreme ? 95 : 85;
      }
    }

    // 3. AI 大模型打分基准 (如果 LLM 返回了合理的 0-100 分数)
    let aiScore = null;
    if (aiAnalysis && typeof aiAnalysis.impact_score === 'number' && !isNaN(aiAnalysis.impact_score)) {
      aiScore = Math.max(0, Math.min(100, Math.round(aiAnalysis.impact_score)));
    }

    // 4. 本地规则多资产传导深度计算
    let localScore = 0;
    const impacts = (aiAnalysis && aiAnalysis.impacts) || {};
    let nonNeutralCount = 0;
    let bullCount = 0;
    let bearCount = 0;

    const parseList = Array.isArray(impacts) 
      ? impacts.map(it => (typeof it === 'string' ? { dir: '中性' } : { dir: it.bias || it.direction || '中性' }))
      : Object.values(impacts).map(v => (typeof v === 'string' ? { dir: v } : { dir: (v && (v.direction || v.bias)) || '中性' }));

    for (const item of parseList) {
      const d = item.dir || '';
      if (d.includes('利好')) {
        bullCount++;
        nonNeutralCount++;
      } else if (d.includes('利空')) {
        bearCount++;
        nonNeutralCount++;
      }
    }

    // 如果 5 大资产全为中性，且没有特殊强关键词，归为 0 分
    if (nonNeutralCount === 0) {
      localScore = 0;
    } else {
      // 基础分 40，每多一个受影响的核心资产 +10 分
      localScore = 40 + nonNeutralCount * 10;
      // 若出现强烈同向多空共振
      if (bullCount >= 3 || bearCount >= 3) {
        localScore += 10;
      }
    }

    // 5. 宏观高权重事实信号修正
    if (alertData && typeof alertData === 'object') {
      // 5.1 金十星级指标加权
      const econStar = (alertData.economic_data && alertData.economic_data.star !== undefined) 
        ? Number(alertData.economic_data.star) 
        : 0;
      if (econStar >= 5) {
        localScore = Math.max(localScore, 90);
      } else if (econStar >= 4) {
        localScore = Math.max(localScore, 80);
      } else if (econStar >= 3) {
        localScore = Math.max(localScore, 65);
      }

      // 5.2 金十重要事件专栏 / 标红重要
      if (alertData.source_key === 'jin10_topic') {
        localScore = Math.max(localScore, 80);
      } else if (alertData.important) {
        localScore = Math.max(localScore, 70);
      }
    }

    // 5.3 强行情关键词修正 (如“降息”、“加息”、“非农”、“CPI”、“关税”、“暴涨”、“闪崩”)
    const highImpactWords = ['降息', '加息', '基点', '非农', 'cpi', '关税', '通胀', '违约', '制裁', '涨停', '跌停', '暴涨', '暴跌', '印花税', '熔断', '崩盘'];
    const hitHighWord = highImpactWords.some(w => fullText.includes(w));
    if (hitHighWord && nonNeutralCount > 0) {
      localScore = Math.max(localScore, 80);
    }

    // 5.4 纯日常/低价值信息惩罚归零
    const neutralWords = ['早安', '收评', '早报', '晚报', '午间回顾', '休市', '周末愉快', '日历', '日程'];
    if (neutralWords.some(w => fullText.includes(w)) && nonNeutralCount <= 1) {
      localScore = Math.min(localScore, 20);
      if (nonNeutralCount === 0) localScore = 0;
    }

    // 6. 综合 AI 打分与本地规则 (AI 权重 60%，本地硬规则 40%)
    let finalScore = localScore;
    if (aiScore !== null) {
      finalScore = Math.round(aiScore * 0.6 + localScore * 0.4);
      // 特殊保护：若本地命中了重磅高分，不允许 AI 单方面压低
      if (localScore >= 80 && finalScore < 80) {
        finalScore = Math.max(finalScore, 80);
      }
      // 反之，若本地判定无资产影响，严格限制高分
      if (nonNeutralCount === 0 && !hitHighWord) {
        finalScore = 0;
      }
    }

    return Math.max(0, Math.min(100, finalScore));
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
