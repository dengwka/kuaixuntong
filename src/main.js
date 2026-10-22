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
let strategyEngine = null;
let financialAi = null;
let pollTimer = null;
let pollCount = 0;

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    try {
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.show();
      settingsWin.focus();
      settingsWin.setAlwaysOnTop(true);
      settingsWin.setAlwaysOnTop(false);
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
        stats: historyManager.getStorageStats()
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
    const allItems = [...flashItems, ...topicItems, ...xueqiuItems, ...maimaiItems];

    let newCount = 0;
    for (const item of allItems) {
      const itemUid = historyManager.getItemUniqueId(item);
      if (historyManager.isPushed(itemUid)) continue;

      const evalRes = strategyEngine.evaluate(item);
      if (evalRes.matched) {
        const evalItem = evalRes.item;
        const evalUid = historyManager.getItemUniqueId(evalItem);
        if (historyManager.isPushed(evalUid)) continue;

        try {
          evalItem.ai_analysis = await financialAi.analyze(evalItem);
        } catch (e) {
          logger.error('[FinancialAI] 解读异常:', e);
        }

        historyManager.recordPushed(evalItem, evalItem.sync_delay_sec);
        logger.info(`[提示触发] [${evalItem.source || '快讯'}] ${evalItem.title} (已落盘 ID: ${evalUid})`);
        toastManager.showToast(evalItem);
        newCount++;
      }
    }

    if (pollCount % 6 === 1 || newCount > 0) {
      logger.info(`[POLL_HEARTBEAT] 轮询心跳正常 (第 ${pollCount} 次) - 金十: ${flashItems.length}条, 专栏: ${topicItems.length}条, 雪球: ${xueqiuItems.length}条, 脉脉: ${maimaiItems.length}条, 新增推送: ${newCount}条`);
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
    onOpenSettings: () => {
      openSettingsWindow();
    },
    onSendTest: () => {
      triggerTestToast();
    },
    onCheckUpdate: async () => {
      const res = await updateManager.checkForUpdates();
      if (res && res.hasUpdate && toastManager) {
        updateManager.scheduleStartupCheck(toastManager, 100);
      } else if (res && res.success) {
        dialog.showMessageBox(settingsWin || null, {
          type: 'info',
          title: '检查更新',
          message: `当前已是最新版本 (v${updateManager.currentVersion})`,
          detail: '暂无可用更新，快讯通正在持续为您监控市场行情。'
        });
      } else {
        dialog.showMessageBox(settingsWin || null, {
          type: 'warning',
          title: '检查更新',
          message: '未能连接到更新服务器',
          detail: `错误详情: ${(res && res.error) || '网络请求超时'}`
        });
      }
    }
  });

  // 2. 初始化弹窗管理器
  toastManager = new ToastManager(configManager, trayManager);
  toastManager.setOpenSettingsCallback(openSettingsWindow);

  // 3. 初始化核心抓取与分析引擎
  strategyEngine = new StrategyEngine(configManager);
  financialAi = new FinancialAIEngine(configManager);
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

  // 检查版本更新 IPC
  ipcMain.handle('check-for-updates', async () => {
    return await updateManager.checkForUpdates();
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

  // 6. 启动后静默延迟检查一次新版本更新
  updateManager.scheduleStartupCheck(toastManager, 8000);

  // 7. 用户手动双击启动时，直接打开管理配置中心主界面（开机自启动 --hidden 时静默常驻托盘）
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
