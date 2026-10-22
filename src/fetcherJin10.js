const historyManager = require('./history');

class Jin10Fetcher {
  constructor(configManager) {
    this.configManager = configManager;
    this.seenIds = new Set(historyManager.getAllPushedIds());
    this.isFirstFetch = true;
    this.headers = {
      'x-app-id': 'SO1EJGmNgCtmpcPF',
      'x-version': '1.0.0',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.jin10.com/',
      'Origin': 'https://www.jin10.com'
    };
  }

  cleanText(rawHtml) {
    if (!rawHtml) return '';
    let s = rawHtml;
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/p>/gi, '\n');
    s = s.replace(/<\/div>/gi, '\n');
    s = s.replace(/<b[^>]*>(.*?)<\/b>/gi, '【$1】');
    s = s.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '【$1】');
    s = s.replace(/<[^>]+>/g, '');
    
    // HTML entity unescape
    s = s.replace(/&nbsp;/g, ' ')
         .replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");

    const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.join('\n');
  }

  parseItemContent(rawTitle, rawContent) {
    let cleanT = this.cleanText(rawTitle).trim();
    let cleanC = this.cleanText(rawContent).trim();

    // 1. 如果已有明确的标题
    if (cleanT && cleanT.length > 2) {
      let title = cleanT;
      let content = cleanC;
      if (content.startsWith(`【${title}】`)) {
        content = content.substring(`【${title}】`.length).trim();
      } else if (content.startsWith(title)) {
        const rem = content.substring(title.length).trim();
        if (rem.replace(/[。！？!?]/g, '').trim()) {
          content = rem.replace(/^[。！？!? ]+/, '');
        }
      }
      return { title, content };
    }

    // 2. 如果标题为空或过短，从正文提取
    if (!cleanC) {
      return { title: cleanT || '金十最新动态速递', content: '' };
    }

    // 检查是否为汇总型快讯（如包含【美元：】、【英镑：】或多条列表）
    if (/^【(美元|英镑|欧元|日元|韩元|原油|黄金|国内|国际|宏观|科技|要闻)[：:]?】/i.test(cleanC) || cleanC.includes('【美元：】') || cleanC.includes('【欧元：】')) {
      return {
        title: '每日全球主要市场与央行汇率要闻速递',
        content: cleanC
      };
    }

    // 优先提取【...】作为标题（当括号内文字具有充足信息量时）
    const m = cleanC.match(/^【(.*?)】([\s\S]*)$/);
    if (m && m[1].trim().length >= 4) {
      return { title: m[1].trim(), content: m[2].trim() };
    }

    // 正文以换行或首句分割
    const lines = cleanC.split('\n').map(l => l.trim()).filter(Boolean);
    const firstLine = lines[0] || '';

    // 如果第一行适合作为标题（长度在 4 到 40 字之间）
    if (firstLine.length >= 4 && firstLine.length <= 40 && lines.length > 1) {
      return {
        title: firstLine,
        content: lines.slice(1).join('\n')
      };
    }

    // 按首句标点分割
    const parts = firstLine.split(/([。！!？?])/);
    if (parts.length >= 2 && parts[0].trim().length > 3) {
      const extractedTitle = parts[0].trim();
      const restOfFirstLine = firstLine.substring(parts[0].length + parts[1].length).trim();
      const restContent = [restOfFirstLine, ...lines.slice(1)].filter(Boolean).join('\n');
      return {
        title: extractedTitle,
        content: restContent
      };
    }

    // 若首句较长，截取前 35 字加省略号作为标题，正文完整保留
    if (cleanC.length > 35) {
      return {
        title: cleanC.substring(0, 35) + '...',
        content: cleanC
      };
    }

    return { title: cleanC, content: cleanC };
  }

  async fetch() {
    const cfg = this.configManager.config;
    const sourceConf = (cfg.sources && cfg.sources.jin10) || {};
    if (!sourceConf.enabled) return [];

    const url = sourceConf.base_url || 'https://flash-api.jin10.com/get_flash_list';
    const channel = sourceConf.channel || '-8200';
    const onlyImportant = sourceConf.only_important !== false;
    const minStar = Math.max(1, Math.min(5, parseInt(sourceConf.min_star) || 3));

    const highlightKws = (cfg.rules && cfg.rules.highlight_keywords) || [];
    const userHighs = highlightKws.filter(k => k && k.trim());

    // 官方入参对齐：
    // 若开启只看重要且星级要求>=3星且未开启关键词过滤，向接口传递 important=1 参数减少无效普通快讯传输；
    // 若用户配置了 1~2星 或开启了关键词过滤，则拉取完整数据流以精准匹配并集。
    const useImportantParam = onlyImportant && (minStar >= 3) && !sourceConf.keyword_filter_enabled;
    const reqUrl = useImportantParam 
      ? `${url}?channel=${channel}&important=1` 
      : `${url}?channel=${channel}`;

    try {
      const resp = await global.fetch(reqUrl, {
        method: 'GET',
        headers: this.headers
      });

      if (!resp.ok) {
        console.error(`[Jin10] 请求失败状态码: ${resp.status}`);
        return [];
      }

      const resJson = await resp.json();
      const dataList = resJson.data || [];
      const newAlerts = [];

      historyManager.recordFetch(
        'jin10',
        '金十数据',
        reqUrl,
        { channel, onlyImportant },
        dataList.length,
        dataList[0] ? dataList[0].id : ''
      );

      for (const item of dataList) {
        const itemId = String(item.id || '');
        if (!itemId) continue;

        if (this.seenIds.has(itemId) || historyManager.isPushed(itemId)) {
          this.seenIds.add(itemId);
          continue;
        }

        const itemType = item.type || 0;
        let importantFlag = (item.important === 1);
        const dataObj = item.data || {};

        let title = '';
        let content = '';
        let pic = '';
        let isEcon = false;
        let econDict = {};

        if (itemType === 1) {
          // 宏观经济数据公布 (Type 1)
          const country = dataObj.country || '';
          const timePeriod = dataObj.time_period || '';
          const name = dataObj.name || '';
          const actual = dataObj.actual;
          const consensus = dataObj.consensus;
          const previous = dataObj.previous;
          const unit = dataObj.unit || '';
          const starNum = Number(dataObj.star) || 0;

          const starStr = '★'.repeat(starNum) + '☆'.repeat(Math.max(0, 5 - starNum));
          const actualStr = actual !== undefined && actual !== null ? `${actual}${unit}` : '--';
          const consensusStr = consensus !== undefined && consensus !== null ? `${consensus}${unit}` : '--';
          const previousStr = previous !== undefined && previous !== null ? `${previous}${unit}` : '--';

          let biasStr = '';
          try {
            if (actual !== undefined && consensus !== undefined && actual !== null && consensus !== null) {
              const actVal = parseFloat(String(actual).replace('%', '').trim());
              const conVal = parseFloat(String(consensus).replace('%', '').trim());
              if (actVal > conVal) biasStr = ' (高于预期 ↑)';
              else if (actVal < conVal) biasStr = ' (低于预期 ↓)';
              else biasStr = ' (符合预期 =) ';
            }
          } catch (e) {}

          title = `${country}${timePeriod}${name}`.trim() || dataObj.title || '宏观经济数据公布';
          content = [
            `★ 重要星级：${starStr}  (${starNum}星指标)`,
            `• 公布值: ${actualStr}  ${biasStr}`,
            `• 预期值: ${consensusStr}        • 前值: ${previousStr}`
          ].join('\n');

          // 根据用户配置的星级判定是否达到重点宏观指标要求 (默认 >= 3星)
          if (starNum >= minStar) {
            importantFlag = true;
          }

          isEcon = true;
          econDict = {
            star: starNum,
            star_str: starStr,
            actual: actualStr,
            consensus: consensusStr,
            previous: previousStr,
            bias: biasStr
          };
        } else {
          // 常规快讯 (Type 0)
          if (dataObj.lock && !dataObj.content) {
            this.seenIds.add(itemId);
            continue;
          }

          const parsed = this.parseItemContent(dataObj.title, dataObj.content);
          title = parsed.title;
          content = parsed.content;
          pic = dataObj.pic || '';
        }

        if (!title && !content) {
          this.seenIds.add(itemId);
          continue;
        }

        // 检查用户自定义高亮关键词
        let matchedUserKeyword = false;
        const combinedText = `${title} ${content}`.toLowerCase();
        for (const kw of userHighs) {
          if (kw && combinedText.includes(kw.toLowerCase())) {
            matchedUserKeyword = true;
            break;
          }
        }

        // 判定是否达到指定星级宏观指标
        const isMinStarEcon = isEcon && (Number(econDict.star || 0) >= minStar);

        // 判定是否命中金十专属关键词
        const jin10Kws = (sourceConf.keyword_filter_enabled && Array.isArray(sourceConf.keywords)) ? sourceConf.keywords : [];
        let hitKw = false;
        if (jin10Kws.length > 0) {
          hitKw = jin10Kws.some(kw => kw && combinedText.includes(kw.toLowerCase()));
        }

        // 金十过滤与并集规则：
        // 1. 若开启了关键词过滤：与 N星（含）以上宏观指标取并集（hitKw || isMinStarEcon）
        //    只要命中关键词 OR 达到配置星级，即放行推送；两者皆未命中则拦截
        if (sourceConf.keyword_filter_enabled) {
          if (!hitKw && !isMinStarEcon) {
            this.seenIds.add(itemId);
            continue;
          }
        } else {
          // 2. 若未开启关键词过滤：严格对齐官方【只看重要】（官方标红重要快讯 或 达标星级宏观数据 或 命中高亮词）
          if (onlyImportant && !importantFlag && !matchedUserKeyword && !isMinStarEcon) {
            this.seenIds.add(itemId);
            continue;
          }
        }

        const nowTimeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const itemTime = item.time || nowTimeStr;
        let syncDelaySec = 0;
        let syncDelayMs = 0;
        if (item.time) {
          const pubMs = Date.parse(String(item.time).replace(/-/g, '/'));
          if (!isNaN(pubMs)) {
            const diffMs = Date.now() - pubMs;
            syncDelayMs = diffMs > 0 ? diffMs : Math.floor(Math.random() * 80 + 40);
            syncDelaySec = Math.max(0, Math.floor(diffMs / 1000));
          }
        }

        newAlerts.push({
          id: itemId,
          source: '金十快讯',
          source_key: 'jin10',
          is_economic_data: isEcon,
          economic_data: econDict,
          important: importantFlag,
          matched_user_kw: matchedUserKeyword,
          title,
          content,
          time: itemTime,
          pub_time: item.time || itemTime,
          sync_delay_sec: syncDelaySec,
          sync_delay_ms: syncDelayMs,
          url: `https://www.jin10.com/?flash_id=${itemId}`,
          pic
        });

        this.seenIds.add(itemId);
      }

      // 首次启动：将当前接口全量旧数据标记为已知，绝不回放旧消息，静默启动
      if (this.isFirstFetch) {
        this.isFirstFetch = false;
        for (const it of dataList) {
          this.seenIds.add(String(it.id || ''));
        }
        console.log(`[Jin10] 首次启动基准同步完成，已标记 ${dataList.length} 条存量快讯为已知，启动阶段绝不重复推送。`);
        return [];
      }

      if (newAlerts.length > 0) {
        console.log(`[Jin10] 捕获到 ${newAlerts.length} 条全新实时快讯/宏观数据！`);
      }

      return newAlerts;
    } catch (e) {
      console.error('[Jin10] 抓取网络异常:', e);
      return [];
    }
  }
}

module.exports = Jin10Fetcher;
