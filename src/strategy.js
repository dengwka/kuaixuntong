class StrategyEngine {
  constructor(configManager) {
    this.configManager = configManager;
  }

  evaluate(alertData) {
    const cfg = this.configManager.config;
    const rules = cfg.rules || {};
    const minScore = rules.min_alert_score || 60;
    const highlightKws = rules.highlight_keywords || [];
    const excludeKws = rules.exclude_keywords || [];

    const title = alertData.title || '';
    const content = alertData.content || '';
    const fullText = `${title} ${content}`.toLowerCase();

    // 1. 黑名单排除
    for (const kw of excludeKws) {
      if (kw && fullText.includes(kw.toLowerCase())) {
        return { matched: false, score: 0, reason: `命中排除词: ${kw}` };
      }
    }

    // 2. 检查数据源专属关键词过滤与星级并集规则
    const sources = cfg.sources || {};
    const sourceConf = sources[alertData.source_key] || {};

    const isJin10 = (alertData.source_key === 'jin10');
    const minStar = isJin10 ? Math.max(1, Math.min(5, parseInt(sourceConf.min_star) || 3)) : 3;
    const econStar = (alertData.economic_data && alertData.economic_data.star !== undefined) 
      ? Number(alertData.economic_data.star) 
      : 0;
    const isMinStarEcon = isJin10 && (alertData.is_economic_data || econStar > 0) && (econStar >= minStar);

    if (sourceConf.keyword_filter_enabled) {
      const sourceKws = Array.isArray(sourceConf.keywords) ? sourceConf.keywords : [];
      let hasHit = false;
      if (sourceKws.length > 0) {
        hasHit = sourceKws.some(kw => kw && fullText.includes(kw.toLowerCase()));
      }

      // 金十：和 N星（含）以上宏观指标取并集
      if (isJin10) {
        if (!hasHit && !isMinStarEcon) {
          return {
            matched: false,
            score: 0,
            reason: `未命中金十专属关键词且未达到 ${minStar} 星以上宏观指标要求`
          };
        }
      } else {
        if (!hasHit) {
          return {
            matched: false,
            score: 0,
            reason: `未命中【${sourceConf.name || alertData.source || '该数据源'}】指定的专属过滤关键词`
          };
        }
      }
    }

    // 3. 检查是否开启【只看重要】
    const jin10Conf = sources.jin10 || {};
    if (alertData.source_key === 'jin10' && jin10Conf.only_important !== false) {
      // 达到指定星级、或标红重要、或勾选了关键词过滤且已放行，均不在此拦截
      if (!alertData.important && !isMinStarEcon && !sourceConf.keyword_filter_enabled) {
        return { matched: false, score: 0, reason: '非金十官方标红重要快讯或未达标宏观指标，已严格过滤' };
      }
    }

    const xqConf = sources.xueqiu || {};
    if (alertData.source_key === 'xueqiu' && xqConf.only_important !== false && !alertData.important) {
      return { matched: false, score: 0, reason: '非雪球官方标红重点快讯，已严格过滤' };
    }

    let score = 70;
    if (alertData.source_key === 'jin10_topic') {
      score = 95;
    } else if (alertData.source_key === 'jin10') {
      score = 80;
    } else if (alertData.source_key === 'xueqiu') {
      score = 75;
    } else if (alertData.source_key === 'maimai') {
      score = 75;
    } else if (alertData.source_key === 'x_twitter') {
      score = 85;
    }

    if (alertData.important || isMinStarEcon) score += 20;

    const matchedTags = [];
    // 全局高亮词
    for (const kw of highlightKws) {
      if (kw && fullText.includes(kw.toLowerCase())) {
        score += 15;
        if (!matchedTags.includes(kw)) matchedTags.push(kw);
      }
    }

    // 数据源专属命中关键词
    if (sourceConf.keyword_filter_enabled && Array.isArray(sourceConf.keywords)) {
      for (const kw of sourceConf.keywords) {
        if (kw && fullText.includes(kw.toLowerCase())) {
          score += 10;
          if (!matchedTags.includes(kw)) matchedTags.push(kw);
        }
      }
    }

    // 达标星级宏观指标打上对应标签
    if (isMinStarEcon && econStar > 0) {
      const starTag = `★ ${econStar}星宏观指标`;
      if (!matchedTags.includes(starTag)) matchedTags.push(starTag);
    }

    const matched = score >= minScore;
    return {
      matched,
      score,
      item: Object.assign({}, alertData, { matched_tags: matchedTags })
    };
  }
}

module.exports = StrategyEngine;
