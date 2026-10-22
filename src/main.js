const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const configManager = require('./config');
const historyManager = require('./history');
const Jin10Fetcher = require('./fetcherJin10');
const Jin10TopicFetcher = require('./fetcherTopic');
const XueqiuFetcher = require('./fetcherXueqiu');
const MaimaiFetcher = require('./fetcherMaimai');
const storageCleaner = require('./cleaner');
const StrategyEngine = require('./strategy');
const FinancialAIEngine = require('./financialAi');
const ToastManager = require('./toastManager');
const trayManager = require('./trayManager');
const updateManager = require('./updater');
const Translator = require('./translator');
const XFetcher = require('./fetcherX');

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
let translator = null;
let strategyEngine = null;
let financialAi = null;
let pollTimer = null;
let pollCount = 0;

function openSettingsWindow(targetTab = null) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try {
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.show();
      settingsWin.focus();
      settingsWin.setAlwaysOnTop(true);
      settingsWin.setAlwaysOnTop(false);
      if (targetTab) {
        settingsWin.webContents.send('switch-tab', targetTab);
      }
    } catch (e) {}
    return;
  }

  const win = new BrowserWindow({
    show: false,
    width: 780,
    height: 800,
    minWidth: 700,
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

  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send('init-settings', {
        config: configManager.config,
        stats: historyManager.getStorageStats(),
        targetTab: targetTab || null,
        updateInfo: updateManager.lastCheckResult || null,
        appVersion: app.getVersion()
      });
      win.show();
      win.focus();
      win.setAlwaysOnTop(true);
      win.setAlwaysOnTop(false);
    }
  });

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
    source: '测试演练',
    source_key: 'test',
    time: timeStr,
    pub_time: pubTimeStr,
    title: '【实时自检】快讯通监控引擎运行正常',
    content: `这是一条系统自检演练快讯。\n\n• 数据存储目录：${historyManager.dataDir}\n• 运行日志目录：${logger.logDir}\n• 监听接口、智能研判与托盘闪烁机制就绪。`,
    url: '',
    important: false,
    ai_analysis: {
      ai_source: '系统自检演练',
      source_type: 'test',
      summary: '快讯通监控引擎自检通过，后台轮询监听与桌面渲染管道畅通。',
      impacts: {} // 测试内容完全不显示利好利空芯片
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
  try {
    const flashItems = await jin10Fetcher.fetch();
    const topicItems = await topicFetcher.fetch();
    const xueqiuItems = await xueqiuFetcher.fetch();
    const maimaiItems = await maimaiFetcher.fetch();
    const xItems = (xFetcher ? await xFetcher.fetch() : []);
    const allItems = [...flashItems, ...topicItems, ...xueqiuItems, ...maimaiItems, ...xItems];

    let newCount = 0;
    for (const item of allItems) {
      const itemUid = historyManager.getItemUniqueId(item);
      if (historyManager.isPushed(itemUid)) continue;

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

        historyManager.recordPushed(evalItem, evalItem.sync_delay_sec);
        logger.info(`[提示触发] [${evalItem.source || '快讯'}] ${evalItem.title} (已落盘 ID: ${evalUid})`);
        toastManager.showToast(evalItem);
        newCount++;
      }
    }

    if (pollCount % 6 === 1 || newCount > 0) {
      logger.info(`[POLL_HEARTBEAT] 轮询心跳正常 (第 ${pollCount} 次) - 金十: ${flashItems.length}条, 专栏: ${topicItems.length}条, 雪球: ${xueqiuItems.length}条, 脉脉: ${maimaiItems.length}条, 𝕏: ${xItems.length}条, 新增推送: ${newCount}条`);
    }
  } catch (e) {
    logger.error('[Worker] 轮询异常:', e);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const intervalSec = Math.max(3, (configManager.config.system && configManager.config.system.poll_interval_sec) || 5);
  
  // 首次运行
  pollCycle();
  pollTimer = setInterval(pollCycle, intervalSec * 1000);
}

app.whenReady().then(() => {
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
    startPolling();
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
    return await cryptoPriceManager.getFormattedSummary(coins);
  });

  ipcMain.handle('validate-okx-coin', async (event, input) => {
    const cryptoPriceManager = require('./cryptoPrice');
    return await cryptoPriceManager.validateOkxCoin(input);
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

  ipcMain.handle('x:save-accounts', async (event, accounts) => {
    const cfg = configManager.config;
    if (!cfg.sources) cfg.sources = {};
    if (!cfg.sources.x_twitter) cfg.sources.x_twitter = {};
    cfg.sources.x_twitter.accounts = accounts;
    configManager.saveConfig(cfg);
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

    const rawText = (latestInfo?.text || account?.latest_tweet || `关注 @${account?.screen_name || 'elonmusk'} 实时动态更新。`).trim();
    const authorName = latestInfo?.author_name || account?.name || '博主';
    const authorHandle = latestInfo?.author_handle || account?.screen_name || 'user';
    const authorAvatar = latestInfo?.author_avatar || account?.avatar || '';
    const pics = latestInfo?.pics || [];

    // 检测语言并翻译
    const isChinese = translator ? translator.isMostlyChinese(rawText) : false;
    let translatedText = rawText;
    let isTranslated = false;

    if (!isChinese && translator) {
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

  // 自动下载并执行安装包更新 IPC
  ipcMain.handle('download-and-install-update', async (event, url) => {
    try {
      const res = await updateManager.downloadAndInstallUpdate(url, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('update-download-progress', progress);
        }
      });
      return res;
    } catch (e) {
      logger.error('[Updater] 自动下载安装包失败:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.on('open-download-page', (event, url) => {
    updateManager.openDownloadPage(url);
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
