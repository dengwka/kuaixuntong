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
const notifier = require('./notifier');
const stockQuoteManager = require('./stockQuote');
const cryptoPriceManager = require('./cryptoPrice');

// 启动全局日志与异常拦截
logger.setupGlobalHandlers();

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
  '*.cn',               // 统统直连：所有 .cn 域名（包含 .gov.cn, .edu.cn, .com.cn 等）
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

function configureSmartProxy(sess, cfgMgr) {
  if (!sess || !sess.defaultSession) return;
  const cfg = cfgMgr ? cfgMgr.config : {};
  let proxySetting = (cfg.sources?.x_twitter?.proxy || '').trim();
  
  if (!proxySetting) {
    proxySetting = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || '';
  }
  
  if (!proxySetting) {
    proxySetting = detectSystemProxyOnWindows() || '';
  }

  if (proxySetting) {
    sess.defaultSession.setProxy({
      proxyRules: proxySetting,
      proxyBypassRules: DOMESTIC_PROXY_BYPASS_LIST
    }).then(() => {
      logger.info(`[Proxy] 智能网络分流已激活: 海外服务走 ${proxySetting}，国内股票/政务/快讯 100% 强制 DIRECT 直连 (0 代理流量)`);
    }).catch(err => {
      logger.warn('[Proxy] session.setProxy 异常:', err.message);
    });
  } else {
    sess.defaultSession.setProxy({
      proxyRules: 'direct://',
      proxyBypassRules: DOMESTIC_PROXY_BYPASS_LIST
    }).catch(() => {});
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
    sourcesHealth: sourceHealthManager.getHealthReport(configManager.config)
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
    width: 940,
    height: 800,
    minWidth: 800,
    minHeight: 620,
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

function triggerTestToast() {
  logger.info('[TestCard] 用户点击发送测试卡片，立即发起即时自检弹窗...');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
  const pubTimeStr = now.toLocaleString('zh-CN', { hour12: false });

  const sample = {
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
      ai_source: 'DeepSeek 智能研判',
      source_type: 'deepseek',
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
    const allItems = [...flashItems, ...topicItems, ...xueqiuItems, ...maimaiItems, ...xItems, ...localGovItems];

    let newCount = 0;
    const MAX_TOASTS_PER_CYCLE = 3; // 单轮轮询心跳最多弹出 3 条桌面卡片，防止突发洪峰刷屏
    for (const item of allItems) {
      const itemUid = historyManager.getItemUniqueId(item);
      if (historyManager.isPushed(itemUid)) continue;

      // ⏰ 全局时效总闸门：突发快讯工具绝不推送超过时效的过期旧闻（防止接口吐出数天前历史归档）
      const maxAgeSec = item.source_key === 'local_gov' ? (72 * 3600) : (item.source_key === 'x_twitter' ? (12 * 3600) : (2 * 3600));
      if (item.sync_delay_sec && item.sync_delay_sec > maxAgeSec) {
        logger.warn(`[时效拦截] [${item.source || item.source_key}] ${item.title} 原文发布于 ${item.pub_time || item.time}，延迟已达 ${item.sync_delay_sec}秒 (>2小时)，判定为过期历史归档，已拦截丢弃`);
        historyManager.pushedIds.add(itemUid);
        continue;
      }

      const evalRes = strategyEngine.evaluate(item);
      if (evalRes.matched) {
        const evalItem = evalRes.item;
        const evalUid = historyManager.getItemUniqueId(evalItem);
        if (historyManager.isPushed(evalUid)) continue;

        if (evalItem.source_key === 'x_twitter') {
          // X 监控推文已由 XFetcher 根据博主独立的 ai_analysis_enabled 配置完成研判，保留原有结果
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
  jin10Fetcher = new Jin10Fetcher(configManager);
  topicFetcher = new Jin10TopicFetcher(configManager);
  xueqiuFetcher = new XueqiuFetcher(configManager);
  maimaiFetcher = new MaimaiFetcher(configManager);
  localGovFetcher = new LocalGovFetcher(configManager);

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

  ipcMain.on('settings-trigger-test', () => {
    triggerTestToast();
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
    const cryptoPriceManager = require('./cryptoPrice');
    return await cryptoPriceManager.testPrices(coins);
  });

  ipcMain.handle('validate-okx-coin', async (event, input) => {
    const cryptoPriceManager = require('./cryptoPrice');
    return await cryptoPriceManager.validateOkxCoin(input);
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
        ai_source: 'DeepSeek 特报引擎'
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

  ipcMain.handle('test-ai-key', async (event, { provider, key }) => {
    return await financialAi.testApiKey(provider, key);
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
        ai_source: 'DeepSeek 智能研判',
        watchlist_impact: {
          target: `${authorName} 关联科技板块`,
          direction: '利好',
          reason: '核心行业龙头实时发声，提振上下游科技与成长标的预期'
        }
      };
    }

    const testTweet = {
      id: `x_test_${Date.now()}`,
      is_test: true,
      source: '𝕏 监控',
      source_key: 'x_twitter',
      source_name: `𝕏 ${authorName}`,
      author_name: authorName,
      author_handle: authorHandle,
      author_avatar: authorAvatar,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      pub_time: new Date().toLocaleString('zh-CN', { hour12: false }),
      title: `𝕏 ${authorName} (@${authorHandle})`,
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
