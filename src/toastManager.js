const { BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const historyManager = require('./history');
const cryptoPriceManager = require('./cryptoPrice');
const stockQuoteManager = require('./stockQuote');
const logger = require('./logger');

class ToastManager {
  constructor(configManager, trayManager) {
    this.configManager = configManager;
    this.trayManager = trayManager;
    this.currentToastWin = null;
    this.currentAlertData = null;
    this.unreadList = [];
    if (historyManager.unattendedAlerts && historyManager.unattendedAlerts.length > 0) {
      this.unreadList = [...historyManager.unattendedAlerts];
    }
    this.openSettingsCallback = null;
    this.toastWidth = 500; // 默认基准宽度
    this.currentAdaptiveWidth = 500; // 动态自适应宽度：0~1个标的 400px，2~4个标的 500px，5~14个标的 620px
    this.toastQueue = Promise.resolve(); // 异步排队任务锁，杜绝并发调用产生多个重叠窗口或孤儿窗口

    this.initIpc();
  }

  setOpenSettingsCallback(cb) {
    this.openSettingsCallback = cb;
  }

  calculateAdaptiveWidth(quoteText) {
    if (!quoteText || !quoteText.trim()) return 400; // 0个标的：紧凑 400px，杜绝大片留白
    const count = quoteText.trim().split(/\s{2,}/).filter(Boolean).length;
    if (count <= 1) return 400; // 1个标的：紧凑 400px，杜绝大片留白
    if (count <= 4) return 500; // 2~4个标的：标准 500px，优雅均衡
    return 620; // 5~14个标的：宽屏 620px，提供充裕横向展布空间
  }

  initIpc() {
    ipcMain.on('toast-mark-read', (event, alertId) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      this.markAsRead(alertId, senderWin);
    });

    ipcMain.on('toast-expired-unread', (event, alertData) => {
      this.onToastExpiredUnread(alertData);
    });

    ipcMain.on('toast-close', (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      if (senderWin && !senderWin.isDestroyed()) {
        try { senderWin.close(); } catch (e) {}
      }
      if (this.currentToastWin && !this.currentToastWin.isDestroyed() && (this.currentToastWin === senderWin || !senderWin)) {
        try { this.currentToastWin.close(); } catch (e) {}
        this.currentToastWin = null;
        this.currentAlertData = null;
      }
    });

    ipcMain.on('toast-open-settings', () => {
      if (this.openSettingsCallback) {
        this.openSettingsCallback();
      }
    });

    ipcMain.on('toast-open-url', (event, url) => {
      if (this.currentAlertData) {
        historyManager.recordInteraction(this.currentAlertData.id, 'clicked', this.currentAlertData);
      }
      if (url && !this.currentAlertData?.is_test) {
        try {
          shell.openExternal(url);
        } catch (e) {
          logger.error('[ToastManager] 打开链接失败:', e.message);
        }
      }
    });

    ipcMain.on('toast-open-image', (event, picUrl) => {
      if (picUrl) {
        try {
          shell.openExternal(picUrl);
        } catch (e) {
          logger.error('[ToastManager] 打开图片失败:', e.message);
        }
      }
    });

    ipcMain.on('open-external-url', (event, url) => {
      if (url) {
        try {
          shell.openExternal(url);
        } catch (e) {
          logger.error('[ToastManager] 打开外部链接失败:', e.message);
        }
      }
    });

    // 单帧完美渲染完成后再统一显示窗口，彻底杜绝闪烁和尺寸跳跃
    ipcMain.on('toast-ready-to-display', (event, { height, width }) => {
      const win = BrowserWindow.fromWebContents(event.sender) || this.currentToastWin;
      if (win && !win.isDestroyed()) {
        this.applyFinalBoundsAndShow(height, width, win);
      }
    });

    ipcMain.on('toast-resize-height', (event, targetHeight) => {
      const win = BrowserWindow.fromWebContents(event.sender) || this.currentToastWin;
      if (win && !win.isDestroyed()) {
        this.relayoutToast(targetHeight, win);
      }
    });

    // 翻看上一条未读消息
    ipcMain.on('toast-show-prev-unread', (event, currentAlertId) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      this.showPrevUnreadInPlace(currentAlertId, senderWin);
    });

    // 忽略全部历史消息
    ipcMain.on('toast-ignore-all-history', (event) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender);
      this.ignoreAllHistory(senderWin);
    });
  }

  markAsRead(alertId, senderWin) {
    const aid = String(alertId || '');
    const prevLen = this.unreadList.length;
    this.unreadList = this.unreadList.filter(a => String(a.id || a.item_id || '') !== aid);
    historyManager.recordInteraction(aid, 'hovered');
    if (this.trayManager) {
      this.trayManager.setUnreadCount(this.unreadList.length);
    }
    const win = senderWin || this.currentToastWin;
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed() && prevLen !== this.unreadList.length) {
      try {
        win.webContents.send('update-unread-count', this.unreadList.length);
      } catch (e) {}
    }
  }

  onToastExpiredUnread(alertData) {
    if (!alertData) return;
    const aid = String(alertData.id || alertData.item_id || '');
    const exists = this.unreadList.some(a => String(a.id || a.item_id || '') === aid);
    if (aid && !exists) {
      this.unreadList.unshift(alertData);
    }
    historyManager.recordInteraction(aid, 'unattended_expired', alertData);
    if (this.trayManager) {
      this.trayManager.setUnreadCount(this.unreadList.length);
    }
  }

  /**
   * 极速同步获取内存缓存中的行情字串（0ms 响应，杜绝网络等待导致卡死弹窗与翻页）
   */
  getCachedTickerPayloadSync() {
    try {
      const cfg = this.configManager?.config || {};
      let stockText = '';
      let cryptoText = '';
      if (cfg.watchlist?.enabled !== false) {
        stockText = stockQuoteManager.getCachedSummary(cfg.watchlist?.stocks || []);
      }
      if (cfg.crypto_prices?.enabled !== false) {
        cryptoText = cryptoPriceManager.getCachedSummary(cfg.crypto_prices?.selected_coins || []);
      }
      const list = [stockText, cryptoText].map(s => (s || '').trim()).filter(Boolean);
      return {
        combinedPrices: list.join('    '),
        stockPrices: (stockText || '').trim(),
        cryptoPrices: (cryptoText || '').trim()
      };
    } catch (e) {
      return { combinedPrices: '', stockPrices: '', cryptoPrices: '' };
    }
  }

  async getCryptoPricesText() {
    try {
      const cfg = this.configManager.config;
      const cryptoCfg = cfg.crypto_prices || {};
      if (cryptoCfg.enabled !== false) {
        const coins = (Array.isArray(cryptoCfg.selected_coins) && cryptoCfg.selected_coins.length > 0)
          ? cryptoCfg.selected_coins
          : cryptoPriceManager.defaultCoins;
        return await cryptoPriceManager.getFormattedSummary(coins);
      }
    } catch (e) {
      logger.error('[ToastManager] 获取加密货币行情异常:', e.message);
    }
    return '';
  }

  async getStockPricesText() {
    try {
      const cfg = this.configManager.config;
      const watchCfg = cfg.watchlist || {};
      if (watchCfg.enabled !== false) {
        const stocks = (Array.isArray(watchCfg.stocks) && watchCfg.stocks.length > 0)
          ? watchCfg.stocks
          : stockQuoteManager.defaultStocks;
        return await stockQuoteManager.getFormattedSummary(stocks);
      }
    } catch (e) {
      logger.error('[ToastManager] 获取股票行情异常:', e.message);
    }
    return '';
  }

  /**
   * 异步获取行情（带 600ms 快速超时竞速保护，超时立即回退至本地内存缓存）
   */
  async getTickerPayload() {
    try {
      const fetchPromise = Promise.all([
        this.getStockPricesText(),
        this.getCryptoPricesText()
      ]);
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(['', '']), 600));

      const [stockText, cryptoText] = await Promise.race([fetchPromise, timeoutPromise]);
      const cached = this.getCachedTickerPayloadSync();

      const finalStock = (stockText && stockText.trim()) || cached.stockPrices;
      const finalCrypto = (cryptoText && cryptoText.trim()) || cached.cryptoPrices;
      const list = [finalStock, finalCrypto].map(s => (s || '').trim()).filter(Boolean);

      return {
        combinedPrices: list.join('    '),
        stockPrices: finalStock,
        cryptoPrices: finalCrypto
      };
    } catch (e) {
      return this.getCachedTickerPayloadSync();
    }
  }

  /**
   * 后台非阻塞刷新行情并平滑推送到前端
   */
  refreshTickerBackground(targetWin) {
    const win = targetWin || this.currentToastWin;
    if (!win || win.isDestroyed()) return;

    this.getTickerPayload().then(payload => {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        try {
          win.webContents.send('update-ticker', payload);
        } catch (e) {}
      }
    }).catch(() => {});
  }

  /**
   * 优先展示最近的弹窗
   * 如果当前窗口正在展示旧卡片，将旧卡片推入历史未读栈，最新卡片立即抢占置顶展示
   * 经过 Promise 队列串行化锁保护，严防并发创建多个独立窗口
   */
  async showToast(alertData) {
    this.toastQueue = this.toastQueue.then(() => this._doShowToast(alertData)).catch(err => {
      logger.error('[ToastManager] showToast 处理异常:', err ? err.message : err);
    });
    return this.toastQueue;
  }

  async _doShowToast(alertData) {
    historyManager.recordPushed(alertData, alertData.sync_delay_sec);

    if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
      // 如果当前已有正在弹出的卡片，将其存入未读历史堆栈
      if (this.currentAlertData && String(this.currentAlertData.id) !== String(alertData.id)) {
        const aid = String(this.currentAlertData.id);
        if (!this.unreadList.some(a => String(a.id) === aid)) {
          this.unreadList.unshift(this.currentAlertData);
          if (this.trayManager) {
            this.trayManager.setUnreadCount(this.unreadList.length);
          }
        }
      }

      this.currentAlertData = alertData;
      // 0ms 同步极速载入，杜绝网络异步导致的页面撕裂与崩溃
      const { combinedPrices, stockPrices, cryptoPrices } = this.getCachedTickerPayloadSync();
      const allQuotes = combinedPrices || [stockPrices, cryptoPrices].filter(Boolean).join('    ');
      this.currentAdaptiveWidth = this.calculateAdaptiveWidth(allQuotes);

      if (this.currentToastWin && !this.currentToastWin.isDestroyed() && this.currentToastWin.webContents && !this.currentToastWin.webContents.isDestroyed()) {
        try {
          this.currentToastWin.webContents.send('init-toast', {
            alertData,
            config: this.configManager.config,
            unreadCount: this.unreadList.length,
            cryptoPrices: cryptoPrices || '',
            stockPrices: stockPrices || '',
            combinedPrices: combinedPrices || '',
            targetWidth: this.currentAdaptiveWidth
          });

          // 无论此前窗口是否处于不可见状态，均确保重新展现并置顶
          if (!this.currentToastWin.isVisible()) {
            this.currentToastWin.show();
          }
          this.currentToastWin.setAlwaysOnTop(true, 'screen-saver');
          this.currentToastWin.moveTop();

          this.refreshTickerBackground(this.currentToastWin);
          return;
        } catch (e) {
          logger.warn('[ToastManager] 更新已有弹窗失败，将重建窗口:', e.message);
        }
      }
    }

    this.currentAlertData = alertData;
    const { combinedPrices, stockPrices, cryptoPrices } = this.getCachedTickerPayloadSync();
    const allQuotes = combinedPrices || [stockPrices, cryptoPrices].filter(Boolean).join('    ');
    this.currentAdaptiveWidth = this.calculateAdaptiveWidth(allQuotes);
    await this.createToastWindow(alertData, this.currentAdaptiveWidth);
  }

  async createToastWindow(alertData, initialWidth) {
    // 彻底销毁任何残留的孤儿 toast 窗口，绝不允许双弹窗重叠
    try {
      BrowserWindow.getAllWindows().forEach(w => {
        if (w !== this.currentToastWin && !w.isDestroyed()) {
          const u = w.webContents ? w.webContents.getURL() : '';
          if (u.includes('toast.html')) {
            try { w.destroy(); } catch (e) {}
          }
        }
      });
    } catch (e) {}

    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    const workArea = activeDisplay.workArea;
    const width = initialWidth || this.currentAdaptiveWidth || 500;
    this.currentAdaptiveWidth = width;
    const isMac = process.platform === 'darwin';
    const marginX = 12;
    const marginY = 8;

    // 先隐藏创建窗口，等待页面完整计算高度并组装完毕后一次性贴角显示
    const initX = workArea.x + workArea.width - width - marginX;
    const initY = isMac ? (workArea.y + marginY) : (workArea.y + workArea.height - 300 - marginY);

    const toastWin = new BrowserWindow({
      x: initX,
      y: initY,
      width,
      height: 300,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false, // 严格保持隐藏，消除闪烁
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    this.currentToastWin = toastWin;

    toastWin.loadFile(path.join(__dirname, 'ui', 'toast.html'));

    toastWin.webContents.once('did-finish-load', () => {
      try {
        if (toastWin.isDestroyed() || !toastWin.webContents || toastWin.webContents.isDestroyed()) {
          return;
        }
        const { combinedPrices, stockPrices, cryptoPrices } = this.getCachedTickerPayloadSync();
        const allQuotes = combinedPrices || [stockPrices, cryptoPrices].filter(Boolean).join('    ');
        this.currentAdaptiveWidth = this.calculateAdaptiveWidth(allQuotes);

        toastWin.webContents.send('init-toast', {
          alertData,
          config: this.configManager.config,
          unreadCount: this.unreadList.length,
          cryptoPrices: cryptoPrices || '',
          stockPrices: stockPrices || '',
          combinedPrices: combinedPrices || '',
          targetWidth: this.currentAdaptiveWidth
        });

        // 强保底机制：如果 150ms 内未收到渲染进程的高度通知，立即强制显示窗口，绝不静默！
        setTimeout(() => {
          if (toastWin && !toastWin.isDestroyed() && !toastWin.isVisible()) {
            this.applyFinalBoundsAndShow(260, this.currentAdaptiveWidth, toastWin);
          }
        }, 150);

        this.refreshTickerBackground(toastWin);
      } catch (err) {
        logger.warn('[ToastManager] did-finish-load 发送数据异常 (安全跳过):', err.message);
      }
    });

    toastWin.on('closed', () => {
      if (this.currentToastWin === toastWin) {
        this.currentToastWin = null;
        this.currentAlertData = null;
      }
    });
  }

  applyFinalBoundsAndShow(height, customWidth, targetWin) {
    const win = targetWin || this.currentToastWin;
    if (!win || win.isDestroyed()) return;

    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    const workArea = activeDisplay.workArea;
    const width = customWidth || this.currentAdaptiveWidth || 500;
    const userMaxHeight = (this.configManager && this.configManager.config?.system?.content_view_height) || 650;
    const maxHeight = Math.min(Math.max(650, userMaxHeight), workArea.height - 30);
    const targetHeight = Math.min(Math.max(160, Math.ceil(height)), maxHeight);

    const isMac = process.platform === 'darwin';
    const marginX = 12;
    const marginY = 12;
    const x = workArea.x + workArea.width - width - marginX;
    const y = isMac ? (workArea.y + marginY) : Math.max(workArea.y + 10, workArea.y + workArea.height - targetHeight - marginY);

    win.setBounds({ x, y, width, height: targetHeight });
    try {
      win.webContents.send('toast-bounds-applied', { targetHeight, maxHeight, targetWidth: width });
    } catch (e) {}
    win.showInactive();
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }

  relayoutToast(height, targetWin) {
    const win = targetWin || this.currentToastWin;
    if (!win || win.isDestroyed()) return;
    this.applyFinalBoundsAndShow(height, this.currentAdaptiveWidth, win);
  }

  /**
   * 查看上一条未读消息
   */
  async showPrevUnreadInPlace(currentAlertId, senderWin) {
    if (currentAlertId) {
      this.markAsRead(currentAlertId, senderWin);
    }

    const targetWin = (senderWin && !senderWin.isDestroyed()) ? senderWin : this.currentToastWin;

    if (this.unreadList.length === 0) {
      if (targetWin && !targetWin.isDestroyed() && targetWin.webContents && !targetWin.webContents.isDestroyed()) {
        try {
          targetWin.webContents.send('update-unread-count', 0);
        } catch (e) {}
      }
      return;
    }

    const prevAlert = this.unreadList.shift();
    if (this.trayManager) {
      this.trayManager.setUnreadCount(this.unreadList.length);
    }
    prevAlert.is_prev_unread = true;
    historyManager.recordInteraction(prevAlert.id, 'unread_viewed', prevAlert);

    this.currentAlertData = prevAlert;

    // 0ms 极速切换：使用本地缓存行情，杜绝卡顿
    const { combinedPrices, stockPrices, cryptoPrices } = this.getCachedTickerPayloadSync();
    const allQuotes = combinedPrices || [stockPrices, cryptoPrices].filter(Boolean).join('    ');
    this.currentAdaptiveWidth = this.calculateAdaptiveWidth(allQuotes);

    if (targetWin && !targetWin.isDestroyed() && targetWin.webContents && !targetWin.webContents.isDestroyed()) {
      try {
        targetWin.webContents.send('init-toast', {
          alertData: prevAlert,
          config: this.configManager.config,
          unreadCount: this.unreadList.length,
          cryptoPrices: cryptoPrices || '',
          stockPrices: stockPrices || '',
          combinedPrices: combinedPrices || '',
          targetWidth: this.currentAdaptiveWidth
        });

        if (!targetWin.isVisible()) {
          targetWin.show();
        }
        targetWin.setAlwaysOnTop(true, 'screen-saver');
        targetWin.moveTop();

        this.refreshTickerBackground(targetWin);
        return;
      } catch (e) {
        logger.warn('[ToastManager] 切换上一条卡片发送失败，尝试新建窗口:', e.message);
      }
    }

    await this.createToastWindow(prevAlert, this.currentAdaptiveWidth);
  }

  /**
   * 忽略全部历史消息
   */
  ignoreAllHistory(senderWin) {
    if (this.currentAlertData) {
      this.markAsRead(this.currentAlertData.id, senderWin);
    }
    for (const a of this.unreadList) {
      historyManager.recordInteraction(a.id, 'ignored_batch', a);
    }
    this.unreadList = [];
    if (this.trayManager) {
      this.trayManager.setUnreadCount(0);
    }
    historyManager.clearAllUnattended();

    const winsToClose = new Set();
    if (senderWin && !senderWin.isDestroyed()) winsToClose.add(senderWin);
    if (this.currentToastWin && !this.currentToastWin.isDestroyed()) winsToClose.add(this.currentToastWin);

    try {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          const u = w.webContents ? w.webContents.getURL() : '';
          if (u.includes('toast.html')) {
            winsToClose.add(w);
          }
        }
      });
    } catch (e) {}

    winsToClose.forEach(w => {
      try { w.close(); } catch (e) {}
    });

    this.currentToastWin = null;
    this.currentAlertData = null;
  }

  showNextUnread() {
    if (this.unreadList.length === 0) return;
    this.showPrevUnreadInPlace(this.currentAlertData ? this.currentAlertData.id : null);
  }
}

module.exports = ToastManager;
