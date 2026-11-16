const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const configManager = require('./config');
const historyManager = require('./history');
const Jin10Fetcher = require('./fetcherJin10');
const Jin10TopicFetcher = require('./fetcherTopic');
const XueqiuFetcher = require('./fetcherXueqiu');
const MaimaiFetcher = require('./fetcherMaimai');
const LocalGovFetcher = require('./fetcherLocalGov');
const storageCleaner = require('./cleaner');
const StrategyEngine = require('./strategy');
const FinancialAIEngine = require('./financialAi');
const ToastManager = require('./toastManager');
const trayManager = require('./trayManager');
const updateManager = require('./updater');
const Translator = require('./translator');
const XFetcher = require('./fetcherX');
const { WeChatFetcher } = require('./fetcherWechat');
const LicenseManager = require('./licenseManager');
const notifier = require('./notifier');
const stockQuoteManager = require('./stockQuote');
const cryptoPriceManager = require('./cryptoPrice');
const { formatAuthorName, getAuthorChineseName } = require('./authorTranslator');

// 启动全局日志与异常拦截
logger.setupGlobalHandlers();

// 深度适配企业内网环境：忽略内网行为审计/安全网关弱算法或自签拦截证书，彻底解决 net::ERR_CERT_WEAK_SIGNATURE_ALGORITHM
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

// 单实例锁：防止多开冲突
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let settingsWin = null;
let toastManager = null;
let jin10Fetcher = null;
let topicFetcher = null;
let xueqiuFetcher = null;
let maimaiFetcher = null;
let xFetcher = null;
let wechatFetcher = null;
let licenseManager = null;
let localGovFetcher = null;
let translator = null;
let strategyEngine = null;
let financialAi = null;
const sourceHealthManager = require('./sourceHealthManager');
sourceHealthManager.setConfigProvider(() => configManager.config);

let pollTimer = null;
let pollCount = 0;

const DOMESTIC_PROXY_BYPASS_LIST = [
  '<local>',
  '127.0.0.1',
  'localhost',
  '*.gov.cn',           // 政府政务直连（保留具体政务直连，避免全局 *.cn 阻断飞书等办公应用走代理避开内网封锁）
  '*jin10.com',         // 金十快讯主站及 API
  '*xueqiu.com',        // 雪球财经
  '*eastmoney.com',     // 东方财富
  '*qq.com',            // 腾讯全系
  '*gtimg.cn',          // 腾讯股票与行情
  '*sina.com.cn',       // 新浪财经
  '*sinajs.cn',         // 新浪股票与贵金属黄金行情
  '*baidu.com',         // 百度
  '*aliyun.com',        // 阿里云
  '*aliyuncs.com',      // 阿里云
  '*tencent.com',       // 腾讯云
  '*rednet.cn',         // 问政湖南红网
  '*changsha.gov.cn',   // 长沙市政府/规资局/住建局
  '*hunan.gov.cn',      // 湖南省政务服务
  '*maimai.cn',         // 脉脉
  '*10jqka.com.cn',     // 同花顺
  '*cls.cn',            // 财联社
  '*yicai.com',         // 第一财经
  '*deepseek.com',      // 国内 DeepSeek AI 官方直连
  '*bigmodel.cn'        // 智谱 GLM AI 官方直连
].join(';');

let currentDetectedProxy = null;

function detectSystemProxyOnWindows() {
  if (process.platform !== 'win32') return null;
  try {
    const { execSync } = require('child_process');
    const output = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', { encoding: 'utf8', timeout: 2000 });
    const enabledMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    const isEnabled = enabledMatch && parseInt(enabledMatch[1], 16) === 1;
    if (!isEnabled) return null;

    const serverMatch = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
    if (serverMatch && serverMatch[1]) {
      let server = serverMatch[1].trim();
      if (!server.startsWith('http://') && !server.startsWith('https://') && !server.startsWith('socks5://')) {
        server = 'http://' + server;
      }
      return server;
    }
  } catch (e) {}
  return null;
}

// 专用于 macOS 系统的原生系统代理自动探测 (无需任何额外依赖，原生支持 ClashX, Surge, Shadowrocket, V2rayU 等)
function detectSystemProxyOnMac() {
  if (process.platform !== 'darwin') return null;
  try {
    const { execSync } = require('child_process');
    const output = execSync('scutil --proxy', { encoding: 'utf8', timeout: 2000 });
    
    // 1. 检查 HTTP 代理 (HTTPEnable : 1)
    const isHttpEnabled = /HTTPEnable\s*:\s*1/.test(output);
    const httpProxy = output.match(/HTTPProxy\s*:\s*([^\s\r\n]+)/);
    const httpPort = output.match(/HTTPPort\s*:\s*(\d+)/);
    if (isHttpEnabled && httpProxy && httpPort) {
      return `http://${httpProxy[1]}:${httpPort[1]}`;
    }

    // 2. 检查 HTTPS 代理 (HTTPSEnable : 1)
    const isHttpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
    const httpsProxy = output.match(/HTTPSProxy\s*:\s*([^\s\r\n]+)/);
    const httpsPort = output.match(/HTTPSPort\s*:\s*(\d+)/);
    if (isHttpsEnabled && httpsProxy && httpsPort) {
      return `http://${httpsProxy[1]}:${httpsPort[1]}`;
    }

    // 3. 检查 SOCKS 代理 (SOCKSEnable : 1)
    const isSocksEnabled = /SOCKSEnable\s*:\s*1/.test(output);
    const socksProxy = output.match(/SOCKSProxy\s*:\s*([^\s\r\n]+)/);
    const socksPort = output.match(/SOCKSPort\s*:\s*(\d+)/);
    if (isSocksEnabled && socksProxy && socksPort) {
      return `socks5://${socksProxy[1]}:${socksPort[1]}`;
    }
  } catch (e) {}
  return null;
}

// 快速探测本机常见科学上网代理端口 (Clash/Surge/v2ray: 7890, 7892, 10809, 6152, 10808)
function checkLocalPort(port, timeoutMs = 150) {
  return new Promise(async (resolve) => {
    const net = require('net');
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => {
      s.destroy();
      resolve(port);
    });
    s.once('timeout', () => {
      s.destroy();
      resolve(null);
    });
    s.once('error', () => {
      resolve(null);
    });
    s.connect(port, '127.0.0.1');
  });
}

async function findOpenLocalProxy() {
  const commonPorts = [7890, 7897, 7892, 10809, 6152, 10808];
  try {
    const results = await Promise.all(commonPorts.map(p => checkLocalPort(p, 150)));
    const openPort = results.find(p => p !== null);
    if (openPort) {
      return `http://127.0.0.1:${openPort}`;
    }
  } catch (e) {}
  return null;
}

async function configureSmartProxy(sess, cfgMgr) {
  if (!sess || !sess.defaultSession) return;

  // 深度适配企业内网：全局信任自签/弱签名网关证书
  try {
    sess.defaultSession.setCertificateVerifyProc((request, callback) => {
      callback(0); // 0 = PR_SUCCESS, 信任内网弱签名/中间人审计证书
    });
  } catch (e) {}

  const cfg = cfgMgr ? cfgMgr.config : {};
  let proxySetting = (cfg.system?.proxy || cfg.sources?.x_twitter?.proxy || cfg.crypto_prices?.proxy || '').trim();
  
  if (!proxySetting) {
    proxySetting = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || 
                   process.env.http_proxy || process.env.https_proxy || process.env.all_proxy || '';
  }
  
  if (!proxySetting) {
    proxySetting = detectSystemProxyOnWindows() || detectSystemProxyOnMac() || '';
  }

  if (!proxySetting) {
    proxySetting = (await findOpenLocalProxy()) || '';
  }

  currentDetectedProxy = proxySetting || null;

  if (proxySetting) {
    try {
      await sess.defaultSession.setProxy({
        proxyRules: proxySetting,
        proxyBypassRules: DOMESTIC_PROXY_BYPASS_LIST
      });
      logger.info(`[Proxy] 智能网络分流已激活: 海外服务走 ${proxySetting}，国内股票/政务/快讯 100% 强制 DIRECT 直连 (0 代理流量)`);
    } catch (err) {
      logger.warn('[Proxy] session.setProxy 异常:', err.message);
    }
  } else {
    try {
      // 关键修复：未检测到显式独立代理时，采用操作系统原生代理模式 (mode: system)，绝不使用 direct:// 阻断 Mac 底层系统代理或 TUN/VPN
      await sess.defaultSession.setProxy({
        mode: 'system'
      });
      logger.info('[Proxy] 未配置独立代理，已启用操作系统原生代理模式 (mode: system)');
    } catch (e) {}
  }
}

function getSettingsPayload(targetTab = null) {
  return {
    config: configManager.config,
    stats: historyManager.getStorageStats(),
    targetTab: targetTab || null,
    updateInfo: updateManager.lastCheckResult || null,
    appVersion: app.getVersion(),
    defaultDataDir: configManager.getDefaultDataDir(),
    sourcesHealth: sourceHealthManager.getHealthReport(configManager.config),
    detectedProxy: currentDetectedProxy
  };
}

function openSettingsWindow(targetTab = null) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try {
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.show();
      settingsWin.focus();
      settingsWin.setAlwaysOnTop(true);
      settingsWin.setAlwaysOnTop(false);
      // 窗口再次打开或唤起时，主动推送最新配置数据，消除状态陈旧或未初始化
      settingsWin.webContents.send('init-settings', getSettingsPayload(targetTab));
      if (targetTab) {
        settingsWin.webContents.send('switch-tab', targetTab);
      }
    } catch (e) {}
    return;
  }

  const win = new BrowserWindow({
    show: false,
    width: 980,
    height: 740,
    minWidth: 920,
    minHeight: 650,
    center: true,
    title: '快讯通 · 常驻服务与管理配置中心',
    resizable: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'app_icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  settingsWin = win;

  win.loadFile(path.join(__dirname, 'ui', 'settings.html'));

  const sendInit = () => {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send('init-settings', getSettingsPayload(targetTab));
    }
  };

  // 双保险机制：页面加载完毕和首帧就绪均触发初始化，杜绝单点竞态丢消息
  win.webContents.once('did-finish-load', sendInit);

  win.once('ready-to-show', () => {
    sendInit();
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    }
  });

  sourceHealthManager.onStatusChanged = (report) => {
    if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents) {
      settingsWin.webContents.send('sources-health-updated', report);
    }
  };

  win.on('closed', () => {
    if (settingsWin === win) {
      settingsWin = null;
    }
  });
}

function getCurrentAiSourceInfo() {
  const cfg = configManager ? configManager.config : {};
  const aiCfg = cfg.ai_analysis || {};
  const deepseekKey = (aiCfg.deepseek_api_key || aiCfg.api_key || '').trim();
  const zhipuKey = (aiCfg.zhipu_api_key || '').trim();
  const isAiEnabled = aiCfg.enabled !== false;

  if (!isAiEnabled) {
    return {
      name: '本地规则默认分析 (免 Key)',
      type: 'rule_engine'
    };
  }

  if (deepseekKey && zhipuKey) {
    return {
      name: 'DeepSeek + 智谱双核研判',
      type: 'deepseek'
    };
  }

  if (deepseekKey) {
    return {
      name: 'DeepSeek 智能研判',
      type: 'deepseek'
    };
  }

  if (zhipuKey) {
    return {
      name: '智谱 GLM 智能研判',
      type: 'zhipu'
    };
  }

  return {
    name: '本地规则默认分析 (免 Key)',
    type: 'rule_engine'
  };
}

function triggerTestToast(targetSourceKey) {
  const activeAi = getCurrentAiSourceInfo();
  logger.info(`[TestCard] 用户点击发送测试卡片，目标数据源: ${targetSourceKey || '默认(金十)'}，立即发起即时自检弹窗...`);
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
  const pubTimeStr = now.toLocaleString('zh-CN', { hour12: false });

  let sample = null;

  if (targetSourceKey === 'wechat') {
    sample = {
      id: `test_wechat_${Date.now()}`,
      is_test: true,
      source: '💬 微信公众号',
      source_key: 'wechat',
      author: '新华社',
      author_name: '新华社',
      author_avatar: '../../assets/wechat_avatars/xinhuashe.png',
      time: timeStr,
      pub_time: pubTimeStr,
      title: '新华社：重磅发布！我国在关键核心技术自主攻关领域取得重大战略突破',
      content: '【新华社微讯】国家高新技术发展领导小组今日联合公布最新成果专项，我国在自主可控核心硬科技、先进算力芯片及新能源前沿材料等产业链多节点实现战略性跨越突破，多项核心指标位列全球前沿，自主替代步伐全面提速。（新华社）',
      url: 'https://mp.weixin.qq.com',
      important: true,
      score: 92,
      impact_score: 92,
      watchlist_impact: {
        target: '自选股票池 / 半导体与硬科技',
        direction: '强烈利好',
        reason: '国家级核心科技攻关取得实质性突破，全面激活产业链国产替代与估值重构'
      },
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 92,
        summary: '国家级权威官媒通报关键科技自主突破，硬科技与高成长半导体板块迎来实质性政策与产业双重驱动，显著提升市场中长期风险偏好。',
        impacts: {
          'A股科技': '利好',
          '科创50': '利好',
          '半导体': '利好',
          '传统板块': '中性'
        },
        watchlist_impact: {
          target: '自选股票池 / 半导体与硬科技',
          direction: '强烈利好',
          reason: '核心关键产业链自主可控进程全面加速'
        }
      }
    };
  } else if (targetSourceKey === 'x_twitter') {
    sample = {
      id: `test_x_${Date.now()}`,
      is_test: true,
      source: '𝕏 顶流关注',
      source_key: 'x_twitter',
      author: 'Elon Musk',
      author_name: 'Elon Musk',
      author_handle: 'elonmusk',
      screen_name: 'elonmusk',
      author_avatar: 'https://pbs.twimg.com/profile_images/1874558173719080960/bzbwhmep_400x400.jpg',
      time: timeStr,
      pub_time: pubTimeStr,
      title: 'Elon Musk (@elonmusk) 刚刚发布推文',
      content: '【𝕏 独家翻译】Grok 3 与新一代全自主人形机器人将于下季度启动大规模商业试点验证，能源系统升级全面完成。',
      original_text: 'Grok 3 and the next-gen humanoid robotics will begin large-scale commercial pilot validation next quarter. Full energy system upgrade complete.',
      url: 'https://x.com/elonmusk',
      important: true,
      score: 93,
      impact_score: 93,
      watchlist_impact: {
        target: '自选股票池 / 人工智能与机器人',
        direction: '强烈利好',
        reason: '顶流领袖释放新一代 AI 模型与具身智能规模化试点信号，全面点燃科技产业链情绪'
      },
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 93,
        summary: '马斯克宣布 Grok 3 与人形机器人迈入大规模商业化试点阶段，具身智能、高算力芯片与核心传感器供应链迎强催化。',
        impacts: {
          'AI机器人': '利好',
          '算力硬件': '利好',
          '纳斯达克': '利好'
        }
      }
    };
  } else if (targetSourceKey === 'xueqiu') {
    sample = {
      id: `test_xueqiu_${Date.now()}`,
      is_test: true,
      source: '❄️ 雪球快讯',
      source_key: 'xueqiu',
      time: timeStr,
      pub_time: pubTimeStr,
      title: '【雪球行情突发】中芯国际 (688981) 尾盘放量直线拉升涨超 12%',
      content: '雪球行情异动监测：中芯国际 (688981) 尾盘获巨额主力资金净流入超 35 亿元，多笔万手大单连续扫盘，盘中涨幅迅速扩大至 12.4%，成交额突破百亿关口，带动科创芯片 ETF 整体强势翻红。',
      url: 'https://xueqiu.com',
      important: true,
      score: 90,
      impact_score: 90,
      watchlist_impact: {
        target: '中芯国际 (688981)',
        direction: '强烈利好',
        reason: '百亿成交与巨额主力净买入推动股价放量突破关键技术阻力位'
      },
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 90,
        summary: '半导体龙头尾盘获百亿级机构巨额资金抢筹，行业基本面景气度迎来周期底部确认与估值修复。',
        impacts: {
          'A股': '利好',
          '科创板': '利好',
          '半导体': '利好'
        }
      }
    };
  } else if (targetSourceKey === 'maimai') {
    sample = {
      id: `test_maimai_${Date.now()}`,
      is_test: true,
      source: '💼 脉脉职言',
      source_key: 'maimai',
      time: timeStr,
      pub_time: pubTimeStr,
      title: '【职言情报】头部互联网大厂成立新一代端侧 AI 智能体研发实验室',
      content: '据脉脉认证员工职言热议，某互联网巨头内部正式完成组织架构调整，原技术中台核心业务线整合，成立专属「端侧AI智能体研发集群」，首批百人编制已全部到位，重点攻关端侧自学习智能体与商业变现闭环。',
      url: 'https://maimai.cn',
      important: false,
      score: 82,
      impact_score: 82,
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 82,
        summary: '头部大厂调整组织阵型押注端侧 AI 智能体研发，显示一线产业界对端侧落地应用与技术创新的紧迫布局。',
        impacts: {
          '端侧AI': '利好',
          '互联网': '利好'
        }
      }
    };
  } else if (targetSourceKey === 'local_gov') {
    sample = {
      id: `test_local_gov_${Date.now()}`,
      is_test: true,
      source: '📍 本地周边 · 规划局与问政',
      source_key: 'local_gov',
      time: timeStr,
      pub_time: pubTimeStr,
      title: '【自规局规划公示】长沙市雨花区重大交通枢纽与配套名校规划获批复',
      content: '长沙市自然资源和规划局最新发布批前公示：雨花区省政府板块新增一条重点快速路连通工程及一所省级示范名校规划正式落地，总用地面积约 4.8 万平方米，规划周边配套商住环境全面优化提升。（红网政民互动）',
      url: 'https://rednet.cn',
      important: true,
      score: 86,
      impact_score: 86,
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 86,
        summary: '雨花区重点交通路网与名校教育资源规划双重落地，大幅提升板块居住品质与周边不动产流动性价值。'
      }
    };
  } else if (targetSourceKey === 'jin10_topic') {
    sample = {
      id: `test_jin10_topic_${Date.now()}`,
      is_test: true,
      source: '🔥 重要事件',
      source_key: 'jin10_topic',
      time: timeStr,
      pub_time: pubTimeStr,
      title: '【金十专栏特报】全球地缘新博弈：关键航运海峡局势演变全景追踪',
      content: '金十深度专栏突发追踪：红海与关键国际能源运输要道通行安全评级最新下调，多家头部国际集装箱航运巨头宣布暂停原定航线并绕行好望角，欧洲天然气期货与布伦特原油短线飙涨逾 4.5%。（金十数据）',
      url: 'https://jin10.com',
      important: true,
      score: 91,
      impact_score: 91,
      watchlist_impact: {
        target: '自选股票池 / 航运与原油',
        direction: '强烈利好',
        reason: '航运绕行大幅拉长航行周期推升运价与能源风险溢价'
      },
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 91,
        summary: '国际关键水道通行受阻导致全球供应链运力短缺，短期内直接刺激集运指数与油气期货暴涨，通胀预期可能再次抬头。',
        impacts: {
          '原油': '利好',
          '航运港口': '利好',
          '全球通胀': '利空'
        }
      }
    };
  } else {
    // 默认走金十财经宏观突发
    sample = {
      id: `test_${Date.now()}`,
      is_test: true,
      source: '⚡ 金十快讯',
      source_key: 'jin10',
      time: timeStr,
      pub_time: pubTimeStr,
      title: '【重磅突发】全球央行启动联合协同宽松，释放万亿美元流动性',
      content: '多国央行与核心金融监管机构发布联合声明，宣布即刻启动联合流动性互换机制，基准利率协同下调 50 个基点，并设立专项市场平准稳定基金。主要股指期货秒级拉升，大宗商品与数字资产全线暴涨。（财联社）',
      url: 'https://github.com/dengwka/kuaixuntong',
      important: true,
      score: 95,
      impact_score: 95,
      watchlist_impact: {
        target: '自选股票池 / 港股科技',
        direction: '强烈利好',
        reason: '全球协同宽松直接降低资金成本，提振成长性科技板块估值与风险偏好'
      },
      ai_analysis: {
        ai_source: activeAi.name,
        source_type: activeAi.type,
        impact_score: 95,
        summary: '多国央行罕见落地协同降息与巨量流动性注入，极大利好权益类资产与高弹性科技成长股，黄金与大宗商品全面提振，美元指数短线承压下挫。',
        impacts: {
          'A股': '利好',
          '港股科技': '利好',
          '黄金': '利好',
          '美元': '利空',
          '虚拟币': '利好',
          '原油': '中性'
        },
        watchlist_impact: {
          target: '自选股票池 / 港股科技',
          direction: '强烈利好',
          reason: '全球协同宽松直接降低资金成本，提振成长性科技板块估值与风险偏好'
        }
      }
    };
  }

  toastManager.showToast(sample);
}

async function pollCycle() {
  if (configManager.isInQuietHours()) {
    logger.info('[Poll] 当前处于夜间免打扰时间段，跳过弹窗轮询。');
    return;
  }

  pollCount++;
  sourceHealthManager.totalPollCycles = pollCount;
  sourceHealthManager.lastPollTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  // 周期性探测外网连通性
  if (pollCount % 4 === 1) {
    sourceHealthManager.checkNetworkHealth().catch(() => {});
  }

  try {
    const cfgSources = configManager.config.sources || {};

    const fetchWithHealth = async (key, isEnabled, fetcherFn) => {
      if (!isEnabled) {
        sourceHealthManager.markDisabled(key);
        return [];
      }
      sourceHealthManager.markFetching(key);
      const t0 = Date.now();
      try {
        const items = await fetcherFn();
        const latency = Date.now() - t0;
        sourceHealthManager.recordSuccess(key, latency, items.length);
        return items;
      } catch (err) {
        const latency = Date.now() - t0;
        sourceHealthManager.recordError(key, latency, err.message);
        logger.error(`[Worker] ${key} 抓取异常:`, err.message);
        return [];
      }
    };

    const flashItems = await fetchWithHealth('jin10', cfgSources.jin10?.enabled !== false, () => jin10Fetcher.fetch());
    const topicItems = await fetchWithHealth('jin10_topic', cfgSources.jin10_topic?.enabled !== false, () => topicFetcher.fetch());
    const xueqiuItems = await fetchWithHealth('xueqiu', cfgSources.xueqiu?.enabled !== false, () => xueqiuFetcher.fetch());
    const maimaiItems = await fetchWithHealth('maimai', cfgSources.maimai?.enabled !== false, () => maimaiFetcher.fetch());
    const xItems = await fetchWithHealth('x_twitter', cfgSources.x_twitter?.enabled === true, () => (xFetcher ? xFetcher.fetch() : []));
    const localGovItems = await fetchWithHealth('local_gov', cfgSources.local_gov?.enabled !== false, () => (localGovFetcher ? localGovFetcher.fetch() : []));
    const wechatItems = await fetchWithHealth('wechat', cfgSources.wechat?.enabled === true, () => (wechatFetcher ? wechatFetcher.fetch() : []));
    const allItems = [...flashItems, ...topicItems, ...xueqiuItems, ...maimaiItems, ...xItems, ...localGovItems, ...wechatItems];

    let newCount = 0;
    const MAX_TOASTS_PER_CYCLE = 3; // 单轮轮询心跳最多弹出 3 条桌面卡片，防止突发洪峰刷屏
    for (const item of allItems) {
      const itemUid = historyManager.getItemUniqueId(item);
      if (historyManager.isPushed(itemUid)) continue;

      // ⏰ 全局消息抓取与时效总闸门：突发快讯工具绝不推送超过时效的过期旧闻（防止接口吐出数天前历史归档）
      const fetchingStrategy = configManager.config?.rules?.fetching_strategy || {};
      const globalMaxHours = fetchingStrategy.mode === 'unlimited' ? Infinity : (Number(fetchingStrategy.max_age_hours) || 24);
      const globalMaxSec = globalMaxHours === Infinity ? Infinity : (globalMaxHours * 3600);

      // 计算该消息的实际延迟/存在时长（秒）
      let delaySec = Number(item.sync_delay_sec);
      if (isNaN(delaySec) || delaySec <= 0) {
        const pubStr = item.pub_time || item.time;
        if (pubStr) {
          const parsedMs = Date.parse(String(pubStr).replace(/-/g, '/'));
          if (!isNaN(parsedMs)) {
            delaySec = Math.max(0, Math.floor((Date.now() - parsedMs) / 1000));
            item.sync_delay_sec = delaySec;
          }
        }
      }

      // 确定各数据源生效的时效上限（兼顾全局抓取策略与快讯特征）
      let effectiveMaxAgeSec = globalMaxSec;
      if (effectiveMaxAgeSec !== Infinity) {
        if (item.source_key === 'jin10' || item.source_key === 'jin10_topic' || item.source_key === 'xueqiu' || item.source_key === 'maimai') {
          effectiveMaxAgeSec = Math.min(globalMaxSec, 2 * 3600); // 财经敏捷快讯默认不超过 2 小时
        } else if (item.source_key === 'x_twitter') {
          effectiveMaxAgeSec = Math.min(globalMaxSec, 12 * 3600); // X 推文默认不超过 12 小时
        } else if (item.source_key === 'local_gov' || item.source_key === 'wechat') {
          effectiveMaxAgeSec = globalMaxSec; // 微信长文与本地政务完全遵循全局时效策略 (默认 24 小时)
        }
      }

      if (effectiveMaxAgeSec !== Infinity && delaySec > effectiveMaxAgeSec) {
        const hoursAgo = (delaySec / 3600).toFixed(1);
        logger.warn(`[时效拦截] [${item.source || item.source_key}] 《${item.title}》原文发布于 ${item.pub_time || item.time}（已过去 ${hoursAgo} 小时），超过时效策略上限(${(effectiveMaxAgeSec / 3600).toFixed(1)}小时)，已精准拦截丢弃！`);
        historyManager.pushedIds.add(itemUid);
        continue;
      }

      const evalRes = strategyEngine.evaluate(item);
      if (evalRes.matched) {
        const evalItem = evalRes.item;
        const evalUid = historyManager.getItemUniqueId(evalItem);
        if (historyManager.isPushed(evalUid)) continue;

        if (evalItem.source_key === 'x_twitter' || evalItem.source_key === 'wechat') {
          // X 监控与微信公众号推文已由各自 Fetcher 根据独立的 ai_analysis_enabled 配置完成研判，保留原有结果
        } else {
          try {
            evalItem.ai_analysis = await financialAi.analyze(evalItem);
          } catch (e) {
            logger.error('[FinancialAI] 解读异常:', e);
          }
        }

        // 结合本地策略与AI分析计算综合行情影响评分 (0-100)
        const impactScore = financialAi.calculateImpactScore(evalItem, evalItem.ai_analysis);
        evalItem.impact_score = impactScore;
        if (evalItem.ai_analysis) {
          evalItem.ai_analysis.impact_score = impactScore;
          if (impactScore === 0) {
            if (evalItem.ai_analysis.impacts) {
              for (const k of Object.keys(evalItem.ai_analysis.impacts)) {
                if (typeof evalItem.ai_analysis.impacts[k] === 'object' && evalItem.ai_analysis.impacts[k] !== null) {
                  evalItem.ai_analysis.impacts[k].direction = '中性';
                } else {
                  evalItem.ai_analysis.impacts[k] = '中性';
                }
              }
            }
            evalItem.ai_analysis.watchlist_impact = null;
          }
        }

        // 独立数据源【行情级别过滤】检查 (默认不开启，开启后按 0-100 档位过滤)
        const sourceConf = cfgSources[evalItem.source_key] || {};
        if (sourceConf.impact_filter_enabled && !evalItem.is_test) {
          const minImpactScore = Math.max(0, Math.min(100, parseInt(sourceConf.impact_min_score) || 0));
          if (minImpactScore > 0 && impactScore < minImpactScore) {
            logger.info(`[行情级别过滤] [${evalItem.source || evalItem.source_key}] ${evalItem.title} 影响评分(${impactScore}分) < 门槛(${minImpactScore}分)，已拦截不推送`);
            historyManager.pushedIds.add(evalUid);
            continue;
          }
        }

        historyManager.recordPushed(evalItem, evalItem.sync_delay_sec);

        // 🖥️ 电脑端桌面弹窗推送 (独立平齐控制，默认开启)
        const isDesktopEnabled = configManager.config?.desktop_push?.enabled !== false;
        if (isDesktopEnabled) {
          if (newCount < MAX_TOASTS_PER_CYCLE) {
            logger.info(`[桌面提示] [${evalItem.source || '快讯'}] ${evalItem.title} (已落盘 ID: ${evalUid})`);
            await toastManager.showToast(evalItem);
          } else {
            logger.warn(`[限流保护] 本轮轮询触发量超过 ${MAX_TOASTS_PER_CYCLE} 条，[${evalItem.title}] 已记录历史但不弹窗打扰`);
          }
        } else {
          logger.info(`[电脑端桌面推送已关闭] [${evalItem.title}] 已记录历史，不弹窗打扰`);
        }
        newCount++;

        // 📱 手机端企业微信 / 飞书 / 微信公众号推送 (独立平齐控制，勾选即推送)
        try {
          if (notifier.shouldPushToMobile(evalItem, configManager.config?.mobile_push, configManager.config)) {
            const tickers = toastManager ? toastManager.getCachedTickerPayloadSync() : null;
            notifier.sendAlert(evalItem, configManager.config?.mobile_push, configManager.config, tickers).catch(err => {
              logger.warn('[MobilePush] 手机推送失败:', err.message);
            });
          }
        } catch (pushErr) {
          logger.warn('[MobilePush] 推送判定异常:', pushErr.message);
        }
      }
    }

    if (pollCount % 6 === 1 || newCount > 0) {
      logger.info(`[POLL_HEARTBEAT] 轮询心跳正常 (第 ${pollCount} 次) - 金十: ${flashItems.length}条, 专栏: ${topicItems.length}条, 雪球: ${xueqiuItems.length}条, 脉脉: ${maimaiItems.length}条, 𝕏: ${xItems.length}条, 新增推送: ${newCount}条`);
    }
  } catch (e) {
    logger.error('[Worker] 轮询异常:', e);
  }
}

let tickerPreheatTimer = null;
function startTickerPreheat() {
  if (tickerPreheatTimer) clearInterval(tickerPreheatTimer);
  const preheat = () => {
    try {
      const cfg = configManager.config;
      if (cfg?.watchlist?.enabled !== false && (cfg?.watchlist?.stocks || []).length > 0) {
        stockQuoteManager.getFormattedSummary(cfg.watchlist.stocks).catch(() => {});
      }
      if (cfg?.crypto_prices?.enabled !== false && (cfg?.crypto_prices?.selected_coins || []).length > 0) {
        cryptoPriceManager.getFormattedSummary(cfg.crypto_prices.selected_coins).catch(() => {});
      }
    } catch (e) {}
  };
  preheat();
  tickerPreheatTimer = setInterval(preheat, 20000); // 每 20 秒静默更新一次内存缓存，确保推送时 0ms 命中现成行情
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const intervalSec = Math.max(3, (configManager.config.system && configManager.config.system.poll_interval_sec) || 5);
  
  // 首次运行
  pollCycle();
  pollTimer = setInterval(pollCycle, intervalSec * 1000);
  startTickerPreheat();
}

app.whenReady().then(() => {
  // 配置全局网络代理 (国内金融、政务数据源一律强制直连 bypass，零代理流量损耗)
  configureSmartProxy(session, configManager);

  // 1. 初始化系统托盘（常驻状态栏）
  trayManager.init({
    onShowUnread: () => {
      toastManager.showNextUnread();
    },
    onOpenSettings: (targetTab) => {
      openSettingsWindow(targetTab);
    },
    onSendTest: () => {
      triggerTestToast();
    },
    onCheckUpdate: () => {
      openSettingsWindow('update');
    }
  });

  // 2. 初始化弹窗管理器
  toastManager = new ToastManager(configManager, trayManager);
  toastManager.setOpenSettingsCallback(openSettingsWindow);

  // 3. 初始化核心抓取与分析引擎
  strategyEngine = new StrategyEngine(configManager);
  financialAi = new FinancialAIEngine(configManager);
  translator = new Translator(configManager, financialAi);
  xFetcher = new XFetcher(configManager, translator, financialAi);
  wechatFetcher = new WeChatFetcher(configManager, financialAi);

  // 微信公众号预设精品账号智能增量对齐 (无缝注入侠客岛、晚点、泽平宏观等10大精选公众号，绝不覆盖用户已有自选)
  try {
    const wcCfg = configManager.config.sources?.wechat;
    if (wcCfg && !wcCfg.accounts_cleared) {
      const defaultAccounts = configManager.getDefaultConfig().sources?.wechat?.accounts || [];
      const currentAccounts = Array.isArray(wcCfg.accounts) ? wcCfg.accounts : [];
      const currentIds = new Set(currentAccounts.map(a => (a.wechat_id || a.id || a.name || '').toLowerCase()));
      let hasNew = false;
      for (const defAcc of defaultAccounts) {
        const key = (defAcc.wechat_id || defAcc.id || defAcc.name || '').toLowerCase();
        if (!currentIds.has(key)) {
          currentAccounts.push(defAcc);
          currentIds.add(key);
          hasNew = true;
        }
      }
      if (hasNew) {
        wcCfg.accounts = currentAccounts;
        configManager.saveConfig(configManager.config);
        logger.info(`[WeChatFetcher] 自动增量补充官方精选公众号预设库，当前已订阅数: ${currentAccounts.length}`);
      }
    }
  } catch (eWcAlign) {
    logger.warn('[WeChatFetcher] 增量对齐预设公众号异常:', eWcAlign.message);
  }
  jin10Fetcher = new Jin10Fetcher(configManager);
  topicFetcher = new Jin10TopicFetcher(configManager);
  xueqiuFetcher = new XueqiuFetcher(configManager);
  maimaiFetcher = new MaimaiFetcher(configManager);
  localGovFetcher = new LocalGovFetcher(configManager);
  licenseManager = new LicenseManager(configManager);

  // 启动存储与日志自动清理巡检
  storageCleaner.startPeriodicCleanup();

  // 开机自启动默认开启同步
  try {
    const autoStart = (configManager.config.system && configManager.config.system.auto_start !== false);
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      openAsHidden: true
    });
  } catch (e) {
    logger.error('[AutoLaunch] 初始化开机启动设置异常:', e);
  }

  // 4. 监听设置面板 IPC
  ipcMain.on('settings-save-config', (event, newCfg) => {
    configManager.saveConfig(newCfg);
    if (newCfg.storage && newCfg.storage.data_dir) {
      historyManager.setDataDir(newCfg.storage.data_dir);
    }
    if (newCfg.system && newCfg.system.auto_start !== undefined) {
      try {
        app.setLoginItemSettings({
          openAtLogin: !!newCfg.system.auto_start,
          openAsHidden: true
        });
      } catch (e) {
        logger.error('[AutoLaunch] 设置开机启动异常:', e);
      }
    }

    // 动态同步网络代理配置 (确保国内接口全量直连绕过)
    configureSmartProxy(session, configManager);
    startPolling();
    sourceHealthManager.notifyChanged();
  });

  ipcMain.on('settings-toggle-sound', (event, isEnabled) => {
    configManager.saveConfig({ system: { play_sound: !!isEnabled } });
    logger.info(`[Sound] 用户快捷切换声音/语音提醒: ${isEnabled ? '开启' : '关闭'}`);
  });

  ipcMain.on('settings-trigger-test', (event, sourceKey) => {
    triggerTestToast(sourceKey);
  });

  ipcMain.on('settings-poll-now', async (event) => {
    logger.info('[ManualPoll] 用户点击立即检查更新...');
    await pollCycle();
    event.reply('poll-completed', historyManager.getStorageStats());
  });

  ipcMain.handle('get-settings-payload', (event, targetTab) => {
    return getSettingsPayload(targetTab);
  });

  ipcMain.handle('choose-data-dir', async () => {
    const result = await dialog.showOpenDialog(settingsWin || null, {
      title: '选择数据与日志保存目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.on('open-data-dir', (event, targetDir) => {
    const dir = targetDir || historyManager.dataDir;
    if (dir) {
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      }
      shell.openPath(dir);
    }
  });

  ipcMain.on('open-log-dir', () => {
    const dir = logger.logDir;
    if (dir) {
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      }
      shell.openPath(dir);
    }
  });

  ipcMain.handle('clean-storage-now', async (event, opts) => {
    logger.info('[ManualClean] 用户点击立即清理历史数据与日志...');
    const result = storageCleaner.performCleanup(opts);
    return {
      ...result,
      stats: historyManager.getStorageStats()
    };
  });

  ipcMain.handle('get-storage-stats', () => {
    return historyManager.getStorageStats();
  });

  ipcMain.handle('test-crypto-price', async (event, coins) => {
    await configureSmartProxy(session, configManager);
    const cryptoPriceManager = require('./cryptoPrice');
    const res = await cryptoPriceManager.testPrices(coins);
    return {
      ...res,
      detectedProxy: currentDetectedProxy
    };
  });

  ipcMain.handle('validate-okx-coin', async (event, input) => {
    await configureSmartProxy(session, configManager);
    const cryptoPriceManager = require('./cryptoPrice');
    const res = await cryptoPriceManager.validateOkxCoin(input);
    return {
      ...res,
      detectedProxy: currentDetectedProxy
    };
  });

  // 股票行情与自选标的搜索 IPC
  ipcMain.handle('search-stocks', async (event, query) => {
    const stockQuote = require('./stockQuote');
    return await stockQuote.searchStock(query);
  });

  ipcMain.handle('get-stock-quotes', async (event, symbols) => {
    const stockQuote = require('./stockQuote');
    return await stockQuote.getQuotes(symbols);
  });

  ipcMain.handle('test-stock-summary', async (event, stocks) => {
    const stockQuote = require('./stockQuote');
    return await stockQuote.getFormattedSummary(stocks);
  });

  // 本地周边规划与问政立即拉取测试 IPC
  ipcMain.handle('test-local-gov-fetch', async (event, previewCfg) => {
    if (!localGovFetcher) {
      localGovFetcher = new LocalGovFetcher(configManager);
  licenseManager = new LicenseManager(configManager);
    }
    const items = await localGovFetcher.fetch(true, previewCfg);
    
    // 关键优化：用户点击立即拉取后，除了返回列表预览，还立即触发桌面弹窗与通知推送
    if (Array.isArray(items) && items.length > 0) {
      const topItem = { ...items[0], is_test: true };
      try {
        await toastManager.showToast(topItem);
        logger.info(`[TestLocalGov] 成功触发本地情报测试桌面弹窗: [${topItem.title}]`);
      } catch (err) {
        logger.warn('[TestLocalGov] 桌面弹窗触发异常:', err.message);
      }

      try {
        const tickers = toastManager ? toastManager.getCachedTickerPayloadSync() : null;
        notifier.sendAlert(topItem, configManager.config?.mobile_push, configManager.config, tickers).catch(err => {
          logger.warn('[TestLocalGov] 手机/外部通知触发异常:', err.message);
        });
      } catch (pushErr) {
        logger.warn('[TestLocalGov] 外部通知判定异常:', pushErr.message);
      }
    } else {
      // 若当前过滤条件下暂无新公开件，构造一条专属自检情报触发弹窗，确认弹窗链路
      const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const sampleItem = {
        id: `test_local_gov_${Date.now()}`,
        source: '本地周边',
        source_key: 'local_gov',
        sub_source: '规划局',
        title: `【政务自检】${previewCfg?.district_name || '本地'}片区官方规划与问政数据源连通正常`,
        content: `恭喜！红网问政与自然资源局接口抓取链路完全通畅。当前所设板块关键词已生效，若所选片区有新规划公示、用地调整或民生答复，将第一时间以此形态弹窗并推送！`,
        time: timeStr,
        pub_time: timeStr,
        is_test: true,
        url: 'https://wz.rednet.cn/'
      };
      try {
        await toastManager.showToast(sampleItem);
      } catch (err) {}
      try {
        const tickers = toastManager ? toastManager.getCachedTickerPayloadSync() : null;
        notifier.sendAlert(sampleItem, configManager.config?.mobile_push, configManager.config, tickers).catch(() => {});
      } catch (pushErr) {}
    }

    return items;
  });

  // P0: 数据源健康诊断与网络指标 IPC
  ipcMain.handle('get-sources-health', () => {
    return sourceHealthManager.getHealthReport(configManager.config);
  });

  ipcMain.handle('diagnose-sources-now', async () => {
    await sourceHealthManager.checkNetworkHealth();
    await pollCycle();
    return sourceHealthManager.getHealthReport(configManager.config);
  });

  // 测试黑金 VIP 尊贵卡片效果 IPC
  ipcMain.handle('test-vip-toast', async (event, customVipWord) => {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const sampleVip = {
      id: `test_vip_${Date.now()}`,
      source: '黑天鹅特级特报',
      source_key: 'jin10',
      title: '【特级警报】某战略能源中枢突遭高超音速导弹袭击，全球大宗与避险资产全面暴动',
      content: '突发外电快讯：核心海峡与炼油枢纽突遭多枚高超音速导弹袭击并引发连环剧烈爆炸，总统紧急发表电视讲话并进入最高战争警戒状态。布伦特原油瞬间暴涨 8.6%，现货黄金秒级突破历史新高，纳斯达克及主要股指期货全线重挫。',
      pub_time: timeStr,
      pubTime: timeStr,
      is_test: true,
      is_vip: true,
      vip_keyword: customVipWord || '导弹袭击',
      ai_analysis: {
        summary: '极端地缘军事危机瞬间爆发，引发全球金融海啸级避险浪潮，大宗能源与黄金暴涨，高风险资产遭遇剧烈冲击。',
        impacts: {
          '原油': '利好',
          '黄金': '利好',
          '美元': '利好',
          'A股': '利空',
          '美股': '利空'
        },
        ai_source: activeAi.name
      }
    };
    toastManager.showToast(sampleVip);
    return { success: true };
  });

  // 手机端企业微信群机器人推送连通性测试 IPC
  ipcMain.handle('test-mobile-push', async (event, { webhookUrl }) => {
    return await notifier.sendTestMessage(webhookUrl, configManager.config);
  });

  // 手机端飞书（群机器人 / 智能体）推送连通性测试 IPC
  ipcMain.handle('test-feishu-push', async (event, payload) => {
    return await notifier.sendFeishuTestMessage(payload, configManager.config);
  });

  // 手机端 Server酱 (方糖) 个人微信直推连通性测试 IPC
  ipcMain.handle('test-serverchan-push', async (event, { sendKey }) => {
    return await notifier.sendServerChanTestMessage(sendKey, configManager.config);
  });

  // 手机端微信公众号 / 测试号官方直推连通性测试 IPC
  ipcMain.handle('test-wx-official-push', async (event, wxConfig) => {
    return await notifier.sendWxOfficialTestMessage(wxConfig, configManager.config);
  });

  ipcMain.handle('test-ai-key', async (event, { provider, key, customUrl, customModel }) => {
    return await financialAi.testApiKey(provider, key, customUrl, customModel);
  });

  // 𝕏 (Twitter) 监控模块 IPC 处理器
  ipcMain.handle('x:lookup-account', async (event, handle) => {
    if (!xFetcher) return { success: false, msg: 'X 服务未初始化' };
    return await xFetcher.lookupAccount(handle);
  });

  ipcMain.handle('x:get-accounts-status', async () => {
    const cfg = configManager.config;
    const accounts = (cfg.sources && cfg.sources.x_twitter && cfg.sources.x_twitter.accounts) || [];
    return accounts.map(acc => {
      const cooling = xFetcher ? xFetcher.getAccountCoolingStatus(acc.screen_name) : { isCooling: false, remainingSec: 0 };
      return {
        ...acc,
        isCooling: cooling.isCooling,
        coolingRemainingSec: cooling.remainingSec
      };
    });
  });

  ipcMain.handle('x:clear-cooling', async (event, screenName) => {
    if (xFetcher) {
      xFetcher.clearAccountCooling(screenName);
    }
    return { success: true };
  });

  ipcMain.handle('x:save-accounts', async (event, accounts, isCleared) => {
    const cfg = configManager.config;
    if (!cfg.sources) cfg.sources = {};
    if (!cfg.sources.x_twitter) cfg.sources.x_twitter = {};
    cfg.sources.x_twitter.accounts = accounts;
    if (typeof isCleared === 'boolean') {
      cfg.sources.x_twitter.accounts_cleared = isCleared;
    }
    configManager.saveConfig(cfg);
    return { success: true };
  });

  ipcMain.handle('x:restore-defaults', async () => {
    const defaultAccounts = configManager.getDefaultConfig().sources.x_twitter.accounts;
    const cfg = configManager.config;
    if (!cfg.sources) cfg.sources = {};
    if (!cfg.sources.x_twitter) cfg.sources.x_twitter = {};
    cfg.sources.x_twitter.accounts = JSON.parse(JSON.stringify(defaultAccounts));
    cfg.sources.x_twitter.accounts_cleared = false;
    configManager.saveConfig(cfg);
    return { success: true, accounts: cfg.sources.x_twitter.accounts };
  });

  // 💬 微信公众号与服务号监控模块 IPC 处理器
  ipcMain.handle('wechat:lookup-account', async (event, query) => {
    if (!wechatFetcher) return { success: false, msg: '微信服务未初始化' };
    return await wechatFetcher.lookupAccount(query);
  });

  ipcMain.handle('wechat:get-accounts-status', async () => {
    const cfg = configManager.config;
    const accounts = (cfg.sources && cfg.sources.wechat && cfg.sources.wechat.accounts) || [];
    return accounts.map(acc => {
      const cooling = wechatFetcher ? wechatFetcher.getAccountCoolingStatus(acc.id || acc.name) : { isCooling: false, remainingSec: 0 };
      return {
        ...acc,
        isCooling: cooling.isCooling,
        coolingRemainingSec: cooling.remainingSec
      };
    });
  });

  ipcMain.handle('wechat:save-accounts', async (event, accounts, isCleared) => {
    const cfg = configManager.config;
    if (!cfg.sources) cfg.sources = {};
    if (!cfg.sources.wechat) cfg.sources.wechat = {};
    cfg.sources.wechat.accounts = accounts;
    if (typeof isCleared === 'boolean') {
      cfg.sources.wechat.accounts_cleared = isCleared;
    }
    configManager.saveConfig(cfg);
    return { success: true };
  });

  
  // 微信公众号单账号演练测试弹窗 (和 X 顶流关注完全一致的测试体验)
  ipcMain.handle('wechat:trigger-test-article', async (event, account) => {
    logger.info(`[WeChat] 触发公众号 @${account?.name} 演练测试通知...`);
    let latestArticle = null;

    if (wechatFetcher && wechatFetcher.isAuthValid() && account?.fakeid) {
      try {
        const articles = await wechatFetcher.getMpArticles(account.fakeid, 3);
        if (articles && articles.length > 0) {
          latestArticle = articles[0];
        }
      } catch (e) {
        logger.warn('[WeChatFetcher] 获取最新推文失败:', e.message);
      }
    }

    const accName = account?.name || '微信公众号';
    const wechatId = account?.wechat_id || account?.display_id || '';
    const title = latestArticle?.title || account?.latest_article || account?.sample_article || `【${accName}】最新重磅深度观察与产业前沿研判`;
    const digest = latestArticle?.digest || account?.desc || `来自 ${accName} (${wechatId ? '@' + wechatId : '微信公众平台'}) 的官方实时推文更新，全面追踪重大事件进展与宏观产业动态。`;
    const url = latestArticle?.link || account?.latest_url || account?.sample_url || 'https://mp.weixin.qq.com';
    const avatar = account?.avatar || '';

    const sample = {
      id: `test_wx_${Date.now()}`,
      is_test: true,
      source: '微信公众号',
      source_key: 'wechat',
      author: accName,
      author_name: accName,
      author_handle: wechatId ? `@${wechatId}` : accName,
      avatar: avatar,
      title: title,
      content: digest,
      url: url,
      important: true,
      score: 92,
      impact_score: 92,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      pub_time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      watchlist_impact: {
        target: '自选股票池 / 宏观重点标的',
        direction: '重点关注',
        reason: '权威官媒重磅发文深度指引'
      }
    };

    if (financialAi && (account?.ai_analysis_enabled !== false && account?.enable_ai !== false)) {
      try {
        const aiRes = await financialAi.analyze(sample);
        if (aiRes) {
          sample.ai_analysis = aiRes;
          sample.ai_source = aiRes.ai_source;
        }
      } catch (eAi) {
        logger.warn('[WeChat] AI 研判异常:', eAi.message);
      }
    }

    if (toastManager) {
      toastManager.showToast(sample);
    }
    return { success: true };
  });

  ipcMain.handle('wechat:restore-defaults', async () => {
    const defaultAccounts = configManager.getDefaultConfig().sources.wechat.accounts;
    const cfg = configManager.config;
    if (!cfg.sources) cfg.sources = {};
    if (!cfg.sources.wechat) cfg.sources.wechat = {};
    cfg.sources.wechat.accounts = JSON.parse(JSON.stringify(defaultAccounts));
    cfg.sources.wechat.accounts_cleared = false;
    configManager.saveConfig(cfg);
    return { success: true, accounts: cfg.sources.wechat.accounts };
  });

  // 📱 微信公众平台扫码授权 IPC 处理器 (全面兼容公众号与小程序)
  let wechatLoginWin = null;

  ipcMain.handle('wechat:open-qr-login', async () => {
    // 1. 若已有打开的窗口，强制销毁重建，杜绝因异常卡死导致再次点击无反应
    if (wechatLoginWin && !wechatLoginWin.isDestroyed()) {
      try {
        wechatLoginWin.destroy();
      } catch (e) {}
      wechatLoginWin = null;
    }

    // 2. 扫码授权前清理残留会话 Cookie，确保 100% 弹出全新未登录二维码供用户扫码
    try {
      await session.defaultSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'cache'],
        origin: 'https://mp.weixin.qq.com'
      });
      const cookiesAll = await session.defaultSession.cookies.get({});
      for (const cookie of cookiesAll) {
        if (cookie.domain.includes('weixin.qq.com')) {
          const url = (cookie.secure ? 'https://' : 'http://') + cookie.domain.replace(/^\./, '') + cookie.path;
          await session.defaultSession.cookies.remove(url, cookie.name).catch(() => {});
        }
      }
    } catch (e) {}

    return new Promise((resolve) => {
      // 纯净极简授权窗口：仅展示提示文案卡片与核心二维码
      const loginWin = new BrowserWindow({
        width: 420,
        height: 520,
        minWidth: 400,
        minHeight: 480,
        title: '微信公众平台扫码授权',
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        backgroundColor: '#FFFFFF',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });
      wechatLoginWin = loginWin;

      let resolved = false;
      const done = (result) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      // 仅展示提示文案与二维码的核心注入逻辑 (过滤官方星空背景、头部导航、slogan等无关元素)
      loginWin.webContents.on('did-finish-load', () => {
        loginWin.webContents.executeJavaScript(`
          (() => {
            if (!document.getElementById('pureGlobalStyle')) {
              const s = document.createElement('style');
              s.id = 'pureGlobalStyle';
              s.textContent = \`
                html, body {
                  overflow: hidden !important;
                  margin: 0 !important;
                  padding: 0 !important;
                  background: #FFFFFF !important;
                }
                .login__type__container__select-type,
                .login__type__container__select-type__scan,
                .login__type__container__account,
                .login_frame .weui-desktop-global-mod,
                .login_frame .login__type__container__scan__info__title {
                  display: none !important;
                }
              \`;
              document.head.appendChild(s);
            }

            function setupPureModal() {
              const loginFrame = document.querySelector('.login_frame');
              if (!loginFrame) return;

              // 1. 创建纯净居中容器
              let modalWrap = document.getElementById('pureWechatModalWrap');
              if (!modalWrap) {
                modalWrap = document.createElement('div');
                modalWrap.id = 'pureWechatModalWrap';
                modalWrap.style.cssText = \`
                  position: fixed !important;
                  top: 0 !important;
                  left: 0 !important;
                  right: 0 !important;
                  bottom: 0 !important;
                  width: 100vw !important;
                  height: 100vh !important;
                  background: #FFFFFF !important;
                  z-index: 2147483647 !important;
                  display: flex !important;
                  flex-direction: column !important;
                  align-items: center !important;
                  justify-content: center !important;
                  padding: 16px 20px !important;
                  box-sizing: border-box !important;
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
                  overflow: hidden !important;
                \`;
                document.body.appendChild(modalWrap);
              }

              // 2. 注入顶部提示文案卡片
              let tipCard = document.getElementById('pureTipCard');
              if (!tipCard) {
                tipCard = document.createElement('div');
                tipCard.id = 'pureTipCard';
                tipCard.style.cssText = \`
                  background: #FFFBEB !important;
                  border: 1.5px solid #FCD34D !important;
                  border-radius: 8px !important;
                  padding: 10px 14px !important;
                  margin-bottom: 14px !important;
                  width: 320px !important;
                  box-sizing: border-box !important;
                  box-shadow: 0 1px 3px rgba(0,0,0,0.05) !important;
                \`;
                tipCard.innerHTML = \`
                  <div style="font-size: 12.5px; font-weight: 700; color: #B45309; display: flex; align-items: center; gap: 5px; margin-bottom: 3px;">
                    <span>⚠️</span> <span>授权提醒 (请务必留意)</span>
                  </div>
                  <div style="font-size: 11px; color: #92400E; line-height: 1.5;">
                    1. 微信官方仅对<b>【公众号】(订阅号/服务号)</b>开放搜索接口；<br>
                    2. 扫码后请在手机微信中选择<b>【公众号】</b>登录；<br>
                    3. 若误选【小程序】将无法检索公众号！
                  </div>
                \`;
                modalWrap.appendChild(tipCard);
              }

              // 3. 将 login_frame 移动到 modalWrap 中
              if (loginFrame.parentNode !== modalWrap) {
                modalWrap.appendChild(loginFrame);
              }

              // 4. 重塑 login_frame 样式
              loginFrame.style.cssText = \`
                position: static !important;
                width: 320px !important;
                margin: 0 auto !important;
                padding: 0 !important;
                box-shadow: none !important;
                border: none !important;
                background: transparent !important;
                display: flex !important;
                flex-direction: column !important;
                align-items: center !important;
              \`;

              // 确保二维码居中且尺寸清晰
              const qrcodeEl = loginFrame.querySelector('.login__type__container__scan__qrcode');
              if (qrcodeEl) {
                qrcodeEl.style.width = '200px';
                qrcodeEl.style.height = '200px';
                qrcodeEl.style.margin = '0 auto 8px auto';
                qrcodeEl.style.display = 'block';
              }

              const descEl = loginFrame.querySelector('.login__type__container__scan__info__desc');
              if (descEl) {
                descEl.style.fontSize = '12px';
                descEl.style.color = '#64748B';
                descEl.style.textAlign = 'center';
                descEl.style.marginTop = '4px';
              }
            }

            setupPureModal();
            const observer = new MutationObserver(setupPureModal);
            observer.observe(document.body, { childList: true, subtree: true });
          })()
        `).catch(() => {});
      });

      loginWin.loadURL('https://mp.weixin.qq.com/');

      // 监听导航：全面兼容公众号 (cgi-bin/home) 与小程序 (wxopen/home 或 wxopen/*) 登录跳转
      const handleNavigation = async (navUrl) => {
        try {
          const urlObj = new URL(navUrl);
          const token = urlObj.searchParams.get('token');
          if (token && urlObj.hostname.includes('mp.weixin.qq.com')) {
            const isMiniProgram = urlObj.pathname.includes('/wxopen');
            const accountType = isMiniProgram ? '小程序' : '公众号';
            logger.info(`[WeChatAuth] 扫码登录成功 (${accountType})，获取 token: ${token.substring(0, 6)}...`);

            // 获取 cookies
            const cookies = await session.defaultSession.cookies.get({ domain: 'mp.weixin.qq.com' });
            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            // 提取当前登录账号的真实名称与类型
            let accountName = '';
            try {
              await new Promise(r => setTimeout(r, 400));
              const extracted = await loginWin.webContents.executeJavaScript(`
                (() => {
                  let name = '';
                  let type = '';
                  try {
                    if (window.wx && window.wx.commonData) {
                      name = window.wx.commonData.nick_name || window.wx.commonData.user_name || '';
                    }
                  } catch (e) {}
                  if (!name) {
                    const el = document.querySelector('.weui-desktop-account__nickname, .mp-head-nav__account-name, .header_account_name, .account_name, .user_name');
                    if (el) name = el.textContent.trim();
                  }
                  if (!name && document.title) {
                    const t = document.title.replace(/[-_].*$/, '').trim();
                    if (t && !t.includes('微信公众平台') && !t.includes('登录')) {
                      name = t;
                    }
                  }
                  const typeEl = document.querySelector('.weui-desktop-account__extra, .account_type, .type_name');
                  if (typeEl) type = typeEl.textContent.trim();
                  return { name, type };
                })()
              `).catch(() => null);

              if (extracted && extracted.name) {
                accountName = extracted.name;
              }
            } catch (eName) {}

            // 设置到 fetcher
            if (wechatFetcher) {
              wechatFetcher.setAuth({
                token,
                cookie: cookieStr,
                account_name: accountName,
                account_type: accountType
              });
            }

            // 关闭登录窗口
            try { loginWin.close(); } catch (e) {}
            done({
              success: true,
              token,
              account_name: accountName,
              account_type: accountType
            });
            return;
          }
        } catch (e) {}
      };

      loginWin.webContents.on('did-navigate', (event, url) => handleNavigation(url));
      loginWin.webContents.on('did-navigate-in-page', (event, url) => handleNavigation(url));

      // 用户手动关闭窗口
      loginWin.on('closed', () => {
        if (wechatLoginWin === loginWin) {
          wechatLoginWin = null;
        }
        done({ success: false, msg: '登录窗口已关闭' });
      });
    });
  });

  ipcMain.handle('wechat:get-auth-status', async () => {
    if (!wechatFetcher) return { authorized: false, msg: '服务未初始化' };
    return wechatFetcher.getAuthStatus();
  });

  ipcMain.handle('wechat:clear-auth', async () => {
    if (wechatFetcher) wechatFetcher.clearAuth();
    return { success: true };
  });

  // ==========================================
  // 🛡️ License 软件授权管理 IPC
  // ==========================================
  ipcMain.handle('license:get-info', () => {
    if (!licenseManager) return { macAddress: '', allMacs: [], state: { status: 'unlicensed', isAuthorized: false } };
    return licenseManager.getInfo();
  });

  ipcMain.handle('license:activate', async (_event, payload) => {
    if (!licenseManager) return { ok: false, message: '授权服务未初始化' };
    return await licenseManager.activateOnline(payload || {});
  });

  ipcMain.handle('license:verify', async (_event, payload) => {
    if (!licenseManager) return { ok: false, message: '授权服务未初始化' };
    return await licenseManager.verifyHeartbeat(payload || {});
  });

  ipcMain.handle('license:verify-offline', async (_event, payload) => {
    if (!licenseManager) return { ok: false, message: '授权服务未初始化' };
    return await licenseManager.verifyOffline(payload || {});
  });

  ipcMain.handle('license:clear', () => {
    if (!licenseManager) return { ok: false };
    return licenseManager.clearLicense();
  });

  ipcMain.handle('test-wechat-account', async (event, account) => {
    if (!toastManager || !account) return { success: false };

    let latestInfo = null;
    if (wechatFetcher) {
      try {
        latestInfo = await wechatFetcher.fetchLatestArticleForAccount(account);
      } catch (e) {
        logger.warn('[WeChatFetcher] 获取公众号最新推文失败:', e.message);
      }
    }

    const title = latestInfo?.title || account?.latest_article || `【${account.name}】官方最新深度报道与行业专栏推送`;
    const summary = latestInfo?.summary || account?.desc || `${account.name} 微信公众号最新重点文章已发布，点击卡片可直接在浏览器中打开微信原文查阅全文。`;
    const authorName = account.name || '微信公众号';
    const authorHandle = account.wechat_id || account.id || 'mp_wechat';
    let authorAvatar = (wechatFetcher ? wechatFetcher.getAccountAvatar(account) : '') || latestInfo?.author_avatar || account.avatar || (wechatFetcher ? wechatFetcher.getFallbackAvatar(authorName) : '');

    let aiAnalysis = null;
    if (account.ai_analysis_enabled && financialAi) {
      try {
        aiAnalysis = await financialAi.analyze(`${title}\n${summary}`);
      } catch (errAi) {
        logger.warn('[FinancialAI] 测试微信文章研判异常:', errAi.message);
      }
    }

    if (!aiAnalysis) {
      aiAnalysis = {
        summary: `【${authorName}】发布重要深度评论与行业洞察，对宏观政策落地及实体产业链发展预期形成积极指引。`,
        impacts: {
          'A股': '利好',
          '产业经济': '利好',
          '市场信心': '偏多'
        },
        ai_source: '本地策略深度研判'
      };
    }

    const testItem = {
      id: `wx_test_${Date.now()}`,
      is_test: true,
      source: '微信公众号',
      source_key: 'wechat',
      source_name: `微信 ${authorName}`,
      author_name: authorName,
      author_handle: authorHandle,
      author_avatar: authorAvatar,
      account_type: account.type || '订阅号',
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      pub_time: new Date().toLocaleString('zh-CN', { hour12: false }),
      title: title,
      content: summary,
      pic: latestInfo?.pic || null,
      pics: latestInfo?.pic ? [latestInfo.pic] : [],
      url: latestInfo?.url || `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(authorName)}`,
      important: true,
      score: 80,
      ai_analysis: aiAnalysis
    };

    toastManager.showToast(testItem);
    return { success: true };
  });

  ipcMain.on('open-external-url', (event, url) => {
    if (url) {
      try {
        const { shell } = require('electron');
        shell.openExternal(url);
      } catch (e) {
        logger.error('[Main] 打开外部链接异常:', e);
      }
    }
  });

  ipcMain.on('toast-open-image', (event, picUrl) => {
    if (picUrl) {
      try {
        const { shell } = require('electron');
        shell.openExternal(picUrl);
      } catch (e) {
        logger.error('[Main] 打开图片异常:', e);
      }
    }
  });

  ipcMain.handle('x:trigger-test-tweet', async (event, account) => {
    let latestInfo = null;
    if (xFetcher) {
      try {
        latestInfo = await xFetcher.fetchLatestTweetForAccount(account);
      } catch (e) {
        logger.warn('[XFetcher] 获取博主最新推文失败:', e.message);
      }
    }

    let rawText = (latestInfo?.text || account?.latest_tweet || '').trim();
    let isFallback = false;
    if (!rawText || rawText.includes('已成功接入')) {
      rawText = `We are rolling out major new intelligence updates across our frontier models, delivering breakthrough reasoning speeds and lowering developer API compute costs by 60%. Expanding full multimodal capabilities worldwide.`;
      isFallback = true;
    }

    const authorName = latestInfo?.author_name || account?.name || '博主';
    const authorHandle = latestInfo?.author_handle || account?.screen_name || 'user';
    const authorAvatar = latestInfo?.author_avatar || account?.avatar || '';
    const pics = latestInfo?.pics || [];

    // 检测语言并翻译
    const isChinese = translator ? translator.isMostlyChinese(rawText) : false;
    let translatedText = rawText;
    let isTranslated = false;

    if (isFallback) {
      translatedText = `【技术发布】我们正在对前沿大模型进行重大技术升级，实现突破性推理提速，并将开发者 API 计算调用成本大幅降低 60%。持续向全球开发者扩展全模态 AI 生产力生态。（实时播报）`;
      isTranslated = true;
    } else if (!isChinese && translator) {
      try {
        const transRes = await translator.translate(rawText);
        if (transRes && transRes.isTranslated) {
          translatedText = transRes.translatedText;
          isTranslated = true;
        }
      } catch (errT) {
        logger.warn('[Translator] 测试推文翻译失败，回退原文:', errT.message);
      }
    }

    let aiAnalysis = null;
    if (account?.ai_analysis_enabled && financialAi) {
      try {
        const textForAi = translatedText || rawText;
        aiAnalysis = await financialAi.analyze(textForAi);
      } catch (errAi) {
        logger.warn('[FinancialAI] 测试推文观点分析失败:', errAi.message);
      }
    }

    // 若未配置AI或分析为空，注入生产级演练研判与多空芯片，确保自检弹窗完整真实
    if (!aiAnalysis) {
      aiAnalysis = {
        summary: `@${authorHandle} 发布重磅产品与算力更新，推理提速与调用降本形成显著催化，极大利好全球 AI 算力与科技产业链。`,
        impacts: {
          '科技股': '利好',
          '算力芯片': '利好',
          'A股': '利好',
          '美元': '中性'
        },
        ai_source: activeAi.name,
        watchlist_impact: {
          target: `${authorName} 关联科技板块`,
          direction: '利好',
          reason: '核心行业龙头实时发声，提振上下游科技与成长标的预期'
        }
      };
    }

    const cfg = configManager ? configManager.config : {};
    const showChineseName = !!(cfg.sources?.x_twitter?.show_chinese_name);
    const displayAuthorName = formatAuthorName(authorName, authorHandle, showChineseName, account?.chinese_name);

    const testTweet = {
      id: `x_test_${Date.now()}`,
      is_test: true,
      source: '𝕏 监控',
      source_key: 'x_twitter',
      source_name: `𝕏 ${displayAuthorName}`,
      author_name: displayAuthorName,
      author_name_raw: authorName,
      author_chinese_name: getAuthorChineseName(authorName, authorHandle, account?.chinese_name),
      author_handle: authorHandle,
      author_avatar: authorAvatar,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      pub_time: new Date().toLocaleString('zh-CN', { hour12: false }),
      title: `𝕏 ${displayAuthorName} (@${authorHandle})`,
      content: translatedText,
      original_text: isTranslated ? rawText : null,
      is_translated: isTranslated,
      pics: pics,
      pic: pics.length > 0 ? pics[0] : null,
      url: latestInfo?.url || `https://x.com/${authorHandle}`,
      important: true,
      score: 85,
      watchlist_impact: aiAnalysis?.watchlist_impact || null,
      ai_analysis: aiAnalysis
    };
    toastManager.showToast(testTweet);
    return { success: true };
  });

  // 检查版本更新 IPC
  ipcMain.handle('check-for-updates', async () => {
    const res = await updateManager.checkForUpdates();
    if (res && res.success) {
      trayManager.setHasUpdate(res.hasUpdate, res.latestTag);
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('update-status-changed', res);
      }
    }
    return res;
  });

  // 自动下载并执行安装包更新 IPC (支持多源极速镜像与测速)
  ipcMain.handle('download-and-install-update', async (event, payload) => {
    try {
      const url = typeof payload === 'string' ? payload : (payload && payload.url);
      const options = typeof payload === 'object' ? payload : {};
      const res = await updateManager.downloadAndInstallUpdate(url, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('update-download-progress', progress);
        }
      }, options);
      return res;
    } catch (e) {
      logger.error('[Updater] 自动下载安装包失败:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.on('open-download-page', (event, payload) => {
    const url = typeof payload === 'string' ? payload : (payload && payload.url);
    const mode = (payload && payload.mode) || 'accelerated';
    updateManager.openDownloadPage(url, mode);
  });

  if (configManager.config.storage && configManager.config.storage.data_dir) {
    historyManager.setDataDir(configManager.config.storage.data_dir);
  }

  // 5. 启动轮询（启动时保持彻底静默，杜绝重复弹窗）
  startPolling();
  logger.info(`[App] 快讯通已成功常驻启动，已载入 ${historyManager.pushedIds.size} 条历史已推送记录。`);

  // 6. 启动后静默延迟检查一次新版本更新（根据配置策略决定是否执行）
  updateManager.scheduleStartupCheck(configManager, toastManager, 8000, (res) => {
    if (res && res.hasUpdate) {
      trayManager.setHasUpdate(true, res.latestTag);
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('update-status-changed', res);
      }
    }
  });

  // 7. 启动周期性后台版本检查
  updateManager.startPeriodicCheck(configManager, toastManager, (res) => {
    if (res && res.hasUpdate) {
      trayManager.setHasUpdate(true, res.latestTag);
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('update-status-changed', res);
      }
    }
  });

  // 8. 用户手动双击启动时，直接打开管理配置中心主界面（开机自启动 --hidden 时静默常驻托盘）
  const isHidden = process.argv.includes('--hidden') || process.argv.includes('--silent');
  if (!isHidden) {
    openSettingsWindow();
  }
});

// Windows/Mac 平台关闭所有窗口不退出程序（保持常驻托盘）
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('second-instance', () => {
  openSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    settingsWin.setAlwaysOnTop(true);
    settingsWin.setAlwaysOnTop(false);
  }
});
