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
    const systemPrompt = `你是一位专注于城市规划、住建规划、轨道交通与民生问答的政务权威分析顾问。
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
      summary: '官方发布最新规划公示或民生答复，点击卡片可直接调取原网页查看高清图纸与红头答复。',
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

    // 关键分支：针对“本地周边”专属民生政务规划，不参与任何金融多空评级，专精于大白话提炼事实干货
    if (alertData && (alertData.source_key === 'local_gov' || alertData.source === '本地周边')) {
      return await this.analyzeLocalGov(alertData, availableProviders, timeoutSec);
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
      const macroKeywords = ['降息', '加息', '非农', 'cpi', '关税', '通胀', '违约', '制裁', '涨停', '跌停', '暴涨', '暴跌', '印花税', '熔断', '崩盘'];
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

  ruleBasedAnalysis(text) {
    const t = text.toLowerCase();
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
      '停战', '停火', '和谈', '原油', '黄金', '石油'
    ];
    const hasCoreFinance = coreFinancialWords.some(w => t.includes(w));
    if (!hasCoreFinance && nonFinancialWords.some(w => t.includes(w))) {
      res.summary = '社会文化或日常言论，无实质金融资产传导影响';
      res.impact_score = 0;
      return res;
    }

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
      res.summary = '地缘停火和谈破裂受阻，避险情绪与原油供给中断担忧再度升温';
      res.impact_score = 80;
      res.impacts['原油'] = '利好';
      res.impacts['黄金'] = '利好';
      res.impacts['美元'] = '利好';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      return res;
    }

    // 1.2 地缘缓和 / 停火草案 / 达成协议（核心关键：原油暴跌利空、黄金避险退潮利空、权益全面回暖利好！）
    if (geoDeescalationKeywords.some(w => t.includes(w))) {
      res.summary = '地缘局势现停火与和解曙光，原油地缘溢价大幅回落，全球市场风险偏好提振回暖';
      res.impact_score = 75;
      res.impacts['原油'] = '利空';
      res.impacts['黄金'] = '利空';
      res.impacts['美元'] = '中性';
      res.impacts['A股'] = '利好';
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    // 1.3 真实冲突与军事打击突发升级（必须有明确动作，排除纯地名实体误伤）
    if (geoEscalationKeywords.some(w => t.includes(w))) {
      res.summary = '地缘局势突发军事冲突升级，原油断供担忧骤起，资金大举涌入黄金与美元避险';
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
      res.summary = '国际关税壁垒趋于缓和豁免，贸易流通预期改善，显著提振出口供应链与风险资产';
      res.impact_score = 70;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['黄金'] = '中性';
      res.impacts['美元'] = '利空';
      return res;
    }

    if (tariffWarKeywords.some(w => t.includes(w))) {
      res.summary = '国际关税与贸易摩擦升级，推升二次通胀隐忧并扰动全球供应链与外需';
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
    const dovishKeywords = ['降息', '宽松', '降准', '降准降息', '鸽派', '下调存款准备金率', '量化宽松', '公开市场净投放', '通胀放缓', 'cpi回落', '降息25个基点', '降息50个基点'];
    const hawkishKeywords = ['加息', '紧缩', '鹰派', '上调基准利率', '通胀超预期', '通胀反弹', '维持高利率', '推迟降息', '不急于降息', '收紧银根', '量化紧缩', '缩表'];

    if (dovishKeywords.some(w => t.includes(w))) {
      res.summary = '全球流动性宽松预期升温，压低无息资产成本，股、币等高弹性风险资产全面受益';
      res.impact_score = 80;
      res.impacts['黄金'] = '利好';
      res.impacts['A股'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['美元'] = '利空';
      return res;
    }

    if (hawkishKeywords.some(w => t.includes(w))) {
      res.summary = '央行紧缩立场延续推升美债收益率，无息资产与权益投机品估值承压收缩';
      res.impact_score = 80;
      res.impacts['美元'] = '利好';
      res.impacts['黄金'] = '利空';
      res.impacts['A股'] = '利空';
      res.impacts['虚拟币'] = '利空';
      res.impacts['原油'] = '利空';
      return res;
    }

    // ==========================================
    // 4. 加密货币专属行业驱动（生态爆发 VS 暴雷黑天鹅）
    // ==========================================
    const cryptoBullKeywords = ['比特币', '以太坊', 'btc', 'eth', 'sol', '币圈', '加密货币', '虚拟币', '区块链', 'web3', 'sec批准', 'etf资金净流入', '战略储备', '稳定币法案', '比特币减半'];
    const cryptoBearKeywords = ['交易所爆仓', '黑客攻击', '清洗代币', '清盘', '破产重组', '监管打击', '下架代币', '查封交易所'];

    if (cryptoBearKeywords.some(w => t.includes(w)) && cryptoBullKeywords.some(w => t.includes(w))) {
      res.summary = '加密行业监管重拳或安全黑天鹅爆发，链上流动性骤降，代币遭遇恐慌抛售';
      res.impact_score = 80;
      res.impacts['虚拟币'] = '利空';
      return res;
    }
    if (cryptoBullKeywords.some(w => t.includes(w))) {
      res.summary = '加密核心资产热点催化与资金净流入，链上流动性与情绪显著活跃';
      res.impact_score = 65;
      res.impacts['虚拟币'] = '利好';
      return res;
    }

    // ==========================================
    // 5. 财政刺激与宏观经济复苏（特别国债/化债/实体增长）
    // ==========================================
    const fiscalStimulusKeywords = ['特别国债', '财政发力', '地方化债', '增量财政', '超长期国债', '扩大内需', '设备更新', '以旧换新', '一揽子增量政策', '稳增长政策'];
    if (fiscalStimulusKeywords.some(w => t.includes(w))) {
      res.summary = '增量财政与稳增长政策加码发力，提振实体用能需求与核心权益估值信心';
      res.impact_score = 75;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      res.impacts['虚拟币'] = '利好';
      res.impacts['美元'] = '利空';
      res.impacts['黄金'] = '中性';
      return res;
    }

    // ==========================================
    // 6. 权益市场（A股/港股）基本面驱动
    // ==========================================
    if (['a股', '股票', '股市', '大盘', '上证', '深证', '创业板', '汇金', '增持回购', '回购', '扭亏为盈', '净利润增长', '引导长期资金'].some(w => t.includes(w))) {
      res.summary = '核心产业链盈利向好或资本市场改革深化，稳固宏观风险偏好与估值修复';
      res.impact_score = 55;
      res.impacts['A股'] = '利好';
      res.impacts['原油'] = '利好';
      return res;
    }

    // 默认中性兜底
    res.summary = '宏观政策与产业要闻密集释放，多空力量博弈均衡，资产走势分化';
    res.impact_score = 30;
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
