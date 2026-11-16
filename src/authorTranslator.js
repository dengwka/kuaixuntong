/**
 * X (Twitter) 博主/机构中文译名标注系统
 * 预置覆盖全球政要、科技先锋、AI实验室、顶级投资机构、加密货币领袖及主流媒体的规范中文名映射库
 */

function normalizeKey(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function containsChinese(str) {
  if (!str || typeof str !== 'string') return false;
  return /[\u4e00-\u9fa5]/.test(str);
}

// 预置固定的外文博主与机构规范中文对照表 (Key 均经过 normalizeKey 处理)
const AUTHOR_CHINESE_MAP = {
  // --- 1. AI 实验室与科技领袖 (用户重点关注标的) ---
  'demishassabis': '德米斯·哈萨比斯',
  'deepmind': '谷歌DeepMind',
  'googledeepmind': '谷歌DeepMind',
  'starlink': '星链',
  'startlink': '星链',
  'starlinkofficial': '星链官方',
  'spacex': '太空探索技术公司',
  'elonmusk': '埃隆·马斯克',
  'sama': '山姆·奥特曼',
  'samaltman': '山姆·奥特曼',
  'openai': 'OpenAI',
  'gdb': '格雷格·布罗克曼',
  'gregbrockman': '格雷格·布罗克曼',
  'ilyasut': '伊利亚·苏茨克维',
  'ilyasutskever': '伊利亚·苏茨克维',
  'karpathy': '安德烈·卡帕西',
  'andrejkarpathy': '安德烈·卡帕西',
  'ylecun': '杨立昆',
  'yannlecun': '杨立昆',
  'geoffreyhinton': '杰弗里·辛顿',
  'darioamodei': '达里奥·阿莫代伊',
  'anthropic': 'Anthropic',
  'anthropicai': 'Anthropic',
  'satyanadella': '萨提亚·纳德拉',
  'timcook': '蒂姆·库克',
  'tim_cook': '蒂姆·库克',
  'sundarpichai': '桑达尔·皮查伊',
  'jensenhuang': '黄仁勋',
  'nvidia': '英伟达',
  'nvidiagpu': '英伟达',
  'microsoft': '微软',
  'google': '谷歌',
  'apple': '苹果',
  'meta': 'Meta',
  'zuck': '马克·扎克伯格',
  'markzuckerberg': '马克·扎克伯格',
  'jeffbezos': '杰夫·贝索斯',
  'amazon': '亚马逊',
  'billgates': '比尔·盖茨',
  'pmarca': '马克·安德森',
  'marcandreessen': '马克·安德森',
  'peterthiel': '彼得·蒂尔',
  'alexkarp': '亚历克斯·卡普',
  'palantir': 'Palantir',
  'palantirtech': 'Palantir',
  'tesla': '特斯拉',
  'teslamotors': '特斯拉',
  'tsla': '特斯拉',
  'xai': 'xAI',
  'grok': 'Grok',

  // --- 2. 全球政要与政府机构 ---
  'realdonaldtrump': '唐纳德·特朗普',
  'donaldjtrump': '唐纳德·特朗普',
  'trump': '唐纳德·特朗普',
  'whitehouse': '美国白宫',
  'thewhitehouse': '美国白宫',
  'presssec': '白宫新闻发言人',
  'potus': '美国总统官方账号',
  'vp': '美国副总统官方账号',
  'jdvance': 'J·D·万斯',
  'kamalaharris': '卡玛拉·哈里斯',
  'joebiden': '乔·拜登',
  'secblinken': '安东尼·布林肯',
  'antonyblinken': '安东尼·布林肯',
  'statedept': '美国国务院',
  'state_dept': '美国国务院',
  'deptofdefense': '美国国防部',
  'departmentofdefense': '美国国防部',
  'ustreasury': '美国财政部',
  'treasury': '美国财政部',
  'secgov': '美国证券交易委员会 (SEC)',
  'sec': '美国证券交易委员会 (SEC)',
  'cftc': '美国商品期货交易委员会 (CFTC)',
  'federalreserve': '美联储',
  'fed': '美联储',
  'jeromepowell': '杰罗姆·鲍威尔',
  'ecb': '欧洲央行',
  'europeancentralbank': '欧洲央行',
  'lagarde': '克里斯蒂娜·拉加德',
  'christinelagarde': '克里斯蒂娜·拉加德',
  'bankofengland': '英国央行',
  'boe': '英国央行',
  'bankofjapan': '日本央行',
  'bank_of_japan': '日本央行',
  'boj': '日本央行',
  'imfnews': '国际货币基金组织 (IMF)',
  'imf': '国际货币基金组织 (IMF)',
  'worldbank': '世界银行',
  'nato': '北约',
  'un': '联合国',
  'unitednations': '联合国',
  'europeancommission': '欧盟委员会',
  'eu_commission': '欧盟委员会',
  'eucouncil': '欧洲理事会',
  'donaldtusk': '唐纳德·图斯克 (波兰总理)',
  'emmanuelmacron': '埃马纽埃尔·马克龙 (法国总统)',
  'keirstarmer': '基尔·斯塔默 (英国首相)',
  'olafscholz': '奥拉夫·朔尔茨 (德国总理)',
  'zelenskyyua': '泽连斯基 (乌克兰总统)',
  'volodymyrzelenskyy': '泽连斯基 (乌克兰总统)',
  'kremlinrussia': '克里姆林宫',
  'netanyahu': '内塔尼亚胡 (以色列总理)',
  'justintrudeau': '贾斯廷·特鲁多 (加拿大总理)',
  'jmilei': '哈维尔·米莱 (阿根廷总统)',
  'javiermilei': '哈维尔·米莱 (阿根廷总统)',
  'nayibbukele': '纳伊布·布克尔 (萨尔瓦多总统)',
  'narendramodi': '纳伦德拉·莫迪 (印度总理)',
  'modi': '纳伦德拉·莫迪 (印度总理)',
  'shigeruishiba': '石破茂 (日本首相)',
  'fbi': '美国联邦调查局',
  'cia': '美国中央情报局',
  'nasa': '美国国家航空航天局',
  'fda': '美国食品药品监督管理局',
  'who': '世界卫生组织',
  'opec': '石油输出国组织 (欧佩克)',

  // --- 3. 加密货币与 Web3 ---
  'czbinance': '赵长鹏 (CZ)',
  'cz_binance': '赵长鹏 (CZ)',
  'changpengzhao': '赵长鹏 (CZ)',
  'vitalikbuterin': '维塔利克·布特林 (V神)',
  'brianarmstrong': '布莱恩·阿姆斯特朗 (Coinbase CEO)',
  'brian_armstrong': '布莱恩·阿姆斯特朗 (Coinbase CEO)',
  'coinbase': 'Coinbase',
  'binance': '币安',
  'saylor': '迈克尔·塞勒 (微策略董事长)',
  'michaelsaylor': '迈克尔·塞勒 (微策略董事长)',
  'microstrategy': '微策略',
  'paoloardoino': '保罗·阿尔多伊诺 (Tether CEO)',
  'tether': '泰达公司 (Tether)',
  'tetherto': '泰达公司 (Tether)',
  'tether_to': '泰达公司 (Tether)',
  'jerallaire': '杰里米·阿莱尔 (Circle CEO)',
  'circle': 'Circle',
  'whalealert': '巨鲸异动警报',
  'whale_alert': '巨鲸异动警报',
  'coindesk': 'CoinDesk',
  'cointelegraph': 'Cointelegraph',
  'justinsuntron': '孙宇晨',
  'justinsun': '孙宇晨',

  // --- 4. 顶级投资人与金融机构 ---
  'warrenbuffett': '沃伦·巴菲特',
  'berkshirehathaway': '伯克希尔·哈撒韦',
  'raydalio': '瑞·达利欧 (桥水基金创始人)',
  'bridgewater': '桥水基金',
  'bridgewaterassociates': '桥水基金',
  'billackman': '比尔·阿克曼 (潘兴广场资本创始人)',
  'cathiewood': '“木头姐”凯茜·伍德',
  'cathiedwood': '“木头姐”凯茜·伍德',
  'arkinvest': '方舟投资 (ARK Invest)',
  'michaelburry': '迈克尔·伯里 (大空头原型)',
  'michaeljburry': '迈克尔·伯里 (大空头原型)',
  'howardmarks': '霍华德·马克斯 (橡树资本)',
  'goldmansachs': '高盛集团',
  'morganstanley': '摩根士丹利',
  'jpmorgan': '摩根大通',
  'blackrock': '贝莱德',
  'larryfink': '拉里·芬克 (贝莱德CEO)',
  'citadel': '城堡投资 (Citadel)',
  'kengriffin': '肯·格里芬 (城堡投资CEO)',
  'stanleydruckenmiller': '斯坦利·德鲁肯米勒',
  'georgesoros': '乔治·索罗斯',
  'carlicahn': '卡尔·伊坎',
  'davidtepper': '大卫·泰珀',

  // --- 5. 权威外媒与全球名嘴 ---
  'bloomberg': '彭博社',
  'bloombergnews': '彭博社',
  'reuters': '路透社',
  'wsj': '华尔街日报',
  'wallstreetjournal': '华尔街日报',
  'financialtimes': '英国金融时报',
  'ft': '英国金融时报',
  'cnbc': 'CNBC',
  'foxnews': '福克斯新闻',
  'cnn': '美国有线电视新闻网 (CNN)',
  'bbc': '英国广播公司 (BBC)',
  'bbcbreaking': '英国广播公司 (BBC)',
  'bbcworld': '英国广播公司 (BBC)',
  'nytimes': '纽约时报',
  'ap': '美联社',
  'associatedpress': '美联社',
  'zerohedge': '零对冲 (ZeroHedge)',
  'walterbloomberg': 'Walter Bloomberg (金融快讯)',
  'deitaone': 'Walter Bloomberg (金融快讯)',
  'watcherguru': 'Watcher Guru (财经快讯)',
  'disclosetv': 'Disclose.tv (突发快讯)',
  'marionawfal': '马里奥·纳法尔 (时事主持人)',
  'lexfridman': '莱克斯·弗里德曼',
  'joerogan': '乔·罗根',
  'tuckercarlson': '塔克·卡尔森',
  'davidsacks': '大卫·萨克斯',
  'chamath': '查马斯·帕利哈皮蒂亚',
  'chamathpalihapitiya': '查马斯·帕利哈皮蒂亚',
  'allinpodcast': 'All-In 播客',
  'techcrunch': 'TechCrunch',
  'theverge': 'The Verge',
  'wired': '连线杂志 (WIRED)',
  'arstechnica': 'Ars Technica'
};

// 常见组织/品牌关键字前缀或包含匹配
const KEYWORD_RULES = [
  { test: /starlink/i, name: '星链' },
  { test: /spacex/i, name: '太空探索技术公司' },
  { test: /deepmind/i, name: '谷歌DeepMind' },
  { test: /openai/i, name: 'OpenAI' },
  { test: /anthropic/i, name: 'Anthropic' },
  { test: /nvidia/i, name: '英伟达' },
  { test: /tesla/i, name: '特斯拉' },
  { test: /whitehouse/i, name: '美国白宫' },
  { test: /federalreserve/i, name: '美联储' },
  { test: /microstrategy/i, name: '微策略' },
  { test: /bloomberg/i, name: '彭博社' },
  { test: /reuters/i, name: '路透社' },
  { test: /coinbase/i, name: 'Coinbase' },
  { test: /binance/i, name: '币安' }
];

/**
 * 获取博主/机构对应的规范中文名称
 * @param {string} rawName 昵称 (如 "Demis Hassabis", "Starlink")
 * @param {string} rawHandle 用户名/Handle (如 "demishassabis", "Starlink")
 * @param {string} customCn 可选的用户自定义或账号绑定的中文名
 * @returns {string|null} 返回规范中文名，无法匹配则返回 null
 */
function getAuthorChineseName(rawName, rawHandle, customCn = '') {
  if (customCn && typeof customCn === 'string' && customCn.trim() && containsChinese(customCn)) {
    return customCn.trim();
  }

  // 1. 如果原始名称已经包含中文（如 "特朗普 (Trump)" 或 "星链官方"），无需重复标注
  if (containsChinese(rawName)) {
    return null;
  }

  const nameKey = normalizeKey(rawName);
  const handleKey = normalizeKey(rawHandle);

  // 2. 精确字典匹配：优先 handleKey，次选 nameKey
  if (handleKey && AUTHOR_CHINESE_MAP[handleKey]) {
    return AUTHOR_CHINESE_MAP[handleKey];
  }
  if (nameKey && AUTHOR_CHINESE_MAP[nameKey]) {
    return AUTHOR_CHINESE_MAP[nameKey];
  }

  // 3. 关键字规则匹配 (如 starlink_updates, openai_dev)
  for (const rule of KEYWORD_RULES) {
    if ((rawHandle && rule.test.test(rawHandle)) || (rawName && rule.test.test(rawName))) {
      return rule.name;
    }
  }

  return null;
}

/**
 * 清除名称末尾已附带的中文括号注释 (防止反复切换配置或多次渲染时重复叠加括号)
 * 如 "Demis Hassabis (德米斯·哈萨比斯)" -> "Demis Hassabis"
 */
function stripAuthorChineseAnnotation(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/\s*[(（][^()（）]*[\u4e00-\u9fa5]+[^()（）]*[)）]\s*$/g, '').trim();
}

/**
 * 格式化输出最终显示的博主名称
 * @param {string} rawName 原作者名/昵称 (如 "Demis Hassabis")
 * @param {string} rawHandle 原用户名 (如 "demishassabis")
 * @param {boolean} enabled 是否启用中文标注 (用户配置开关，默认 false)
 * @param {string} customCn 可选的自定义中文名
 * @returns {string} 格式化后的名称 (如 "Demis Hassabis (德米斯·哈萨比斯)" 或 "Demis Hassabis")
 */
function formatAuthorName(rawName, rawHandle, enabled = false, customCn = '') {
  const cleanName = (rawName || rawHandle || '').trim();
  if (!cleanName) return '';

  // 若功能未启用：剥除可能附带的中文括号注释，恢复原貌
  if (!enabled) {
    return stripAuthorChineseAnnotation(cleanName);
  }

  // 若原始名称本身已包含中文（如原名就是“美国白宫”或已手动带了中文），直接输出
  if (containsChinese(cleanName)) {
    return cleanName;
  }

  // 剥除干净后再做标注
  const baseName = stripAuthorChineseAnnotation(cleanName);
  const cn = getAuthorChineseName(baseName, rawHandle, customCn);

  if (cn) {
    return `${baseName} (${cn})`;
  }

  return baseName;
}

module.exports = {
  AUTHOR_CHINESE_MAP,
  normalizeKey,
  containsChinese,
  getAuthorChineseName,
  stripAuthorChineseAnnotation,
  formatAuthorName
};
