const { BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const historyManager = require('./history');
const cryptoPriceManager = require('./cryptoPrice');

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
    this.toastWidth = 590; // 宽裕宽度，确保左右操作按钮与虚拟币价格完全单行容纳不换行

    this.initIpc();
  }

  setOpenSettingsCallback(cb) {
    this.openSettingsCallback = cb;
  }

  initIpc() {
    ipcMain.on('toast-mark-read', (event, alertId) => {
      this.markAsRead(alertId);
    });

    ipcMain.on('toast-expired-unread', (event, alertData) => {
      this.onToastExpiredUnread(alertData);
    });

    ipcMain.on('toast-close', () => {
      if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
        try { this.currentToastWin.close(); } catch (e) {}
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
        shell.openExternal(url);
      }
    });

    ipcMain.on('toast-open-image', (event, picUrl) => {
      if (picUrl) {
        try {
          shell.openExternal(picUrl);
        } catch (e) {
          logger.error('[ToastManager] 打开图片失败:', e);
        }
      }
    });

    ipcMain.on('open-external-url', (event, url) => {
      if (url) {
        try {
          shell.openExternal(url);
        } catch (e) {
          logger.error('[ToastManager] 打开外部链接失败:', e);
        }
      }
    });

    // 单帧完美渲染完成后再统一显示窗口，彻底杜绝闪烁和尺寸跳跃
    ipcMain.on('toast-ready-to-display', (event, { height }) => {
      if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
        this.applyFinalBoundsAndShow(height);
      }
    });

    ipcMain.on('toast-resize-height', (event, targetHeight) => {
      if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
        this.relayoutToast(targetHeight);
      }
    });

    // 翻看上一条未读消息
    ipcMain.on('toast-show-prev-unread', (event, currentAlertId) => {
      this.showPrevUnreadInPlace(currentAlertId);
    });

    // 忽略全部历史消息
    ipcMain.on('toast-ignore-all-history', () => {
      this.ignoreAllHistory();
    });
  }

  markAsRead(alertId) {
    const aid = String(alertId || '');
    this.unreadList = this.unreadList.filter(a => String(a.id || a.item_id || '') !== aid);
    historyManager.recordInteraction(aid, 'hovered');
    if (this.trayManager) {
      this.trayManager.setUnreadCount(this.unreadList.length);
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

  async getCryptoPricesText() {
    try {
      const cfg = this.configManager.config;
      const cryptoCfg = cfg.crypto_prices || {};
      if (cryptoCfg.enabled !== false) {
        const coins = cryptoCfg.selected_coins || ['BTC/USDT', 'SOL/USDT', 'BZ/USDT'];
        return await cryptoPriceManager.getFormattedSummary(coins);
      }
    } catch (e) {}
    return '';
  }

  /**
   * 优先展示最近的弹窗
   * 如果当前窗口正在展示旧卡片，将旧卡片推入历史未读栈，最新卡片立即抢占置顶展示
   */
  async showToast(alertData) {
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
      const cryptoSummary = await this.getCryptoPricesText();
      if (!this.currentToastWin || this.currentToastWin.isDestroyed()) {
        await this.createToastWindow(alertData);
        return;
      }
      this.currentToastWin.webContents.send('init-toast', {
        alertData,
        config: this.configManager.config,
        unreadCount: this.unreadList.length,
        cryptoPrices: cryptoSummary
      });

      // 无论此前窗口是否处于不可见状态，均确保重新展现并置顶
      if (!this.currentToastWin.isVisible()) {
        this.currentToastWin.show();
      }
      this.currentToastWin.setAlwaysOnTop(true, 'screen-saver');
      this.currentToastWin.moveTop();
      return;
    }

    this.currentAlertData = alertData;
    await this.createToastWindow(alertData);
  }

  async createToastWindow(alertData) {
    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    const workArea = activeDisplay.workArea;
    const width = this.toastWidth;
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

    toastWin.webContents.once('did-finish-load', async () => {
      if (!toastWin.isDestroyed()) {
        const cryptoSummary = await this.getCryptoPricesText();
        toastWin.webContents.send('init-toast', {
          alertData,
          config: this.configManager.config,
          unreadCount: this.unreadList.length,
          cryptoPrices: cryptoSummary
        });

        // 强保底机制：如果 150ms 内未收到渲染进程的高度通知，立即强制显示窗口，绝不静默！
        setTimeout(() => {
          if (toastWin && !toastWin.isDestroyed() && !toastWin.isVisible()) {
            this.applyFinalBoundsAndShow(260);
          }
        }, 150);
      }
    });

    toastWin.on('closed', () => {
      if (this.currentToastWin === toastWin) {
        this.currentToastWin = null;
        this.currentAlertData = null;
      }
    });
  }

  applyFinalBoundsAndShow(height) {
    if (!this.currentToastWin || this.currentToastWin.isDestroyed()) return;

    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    const workArea = activeDisplay.workArea;
    const width = this.toastWidth;
    const userMaxHeight = (this.configManager && this.configManager.config?.system?.content_view_height) || 540;
    const maxHeight = Math.min(Math.max(540, userMaxHeight), workArea.height - 30);
    const targetHeight = Math.min(Math.max(160, Math.ceil(height)), maxHeight);

    const isMac = process.platform === 'darwin';
    const marginX = 12;
    const marginY = 12;
    const x = workArea.x + workArea.width - width - marginX;
    const y = isMac ? (workArea.y + marginY) : Math.max(workArea.y + 10, workArea.y + workArea.height - targetHeight - marginY);

    this.currentToastWin.setBounds({ x, y, width, height: targetHeight });
    try {
      this.currentToastWin.webContents.send('toast-bounds-applied', { targetHeight, maxHeight });
    } catch (e) {}
    this.currentToastWin.showInactive();
    this.currentToastWin.show();
    this.currentToastWin.setAlwaysOnTop(true, 'screen-saver');
    this.currentToastWin.moveTop();
  }

  relayoutToast(height) {
    if (!this.currentToastWin || this.currentToastWin.isDestroyed()) return;
    this.applyFinalBoundsAndShow(height);
  }

  /**
   * 查看上一条未读消息
   */
  async showPrevUnreadInPlace(currentAlertId) {
    if (currentAlertId) {
      this.markAsRead(currentAlertId);
    }

    if (this.unreadList.length === 0) {
      return;
    }

    const prevAlert = this.unreadList.shift();
    if (this.trayManager) {
      this.trayManager.setUnreadCount(this.unreadList.length);
    }
    prevAlert.is_prev_unread = true;
    historyManager.recordInteraction(prevAlert.id, 'unread_viewed', prevAlert);

    this.currentAlertData = prevAlert;

    if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
      const cryptoSummary = await this.getCryptoPricesText();
      if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
        this.currentToastWin.webContents.send('init-toast', {
          alertData: prevAlert,
          config: this.configManager.config,
          unreadCount: this.unreadList.length,
          cryptoPrices: cryptoSummary
        });
      } else {
        await this.createToastWindow(prevAlert);
      }
    } else {
      await this.createToastWindow(prevAlert);
    }
  }

  /**
   * 忽略全部历史消息
   */
  ignoreAllHistory() {
    if (this.currentAlertData) {
      this.markAsRead(this.currentAlertData.id);
    }
    for (const a of this.unreadList) {
      historyManager.recordInteraction(a.id, 'ignored_batch', a);
    }
    this.unreadList = [];
    if (this.trayManager) {
      this.trayManager.setUnreadCount(0);
    }
    historyManager.clearAllUnattended();

    if (this.currentToastWin && !this.currentToastWin.isDestroyed()) {
      try { this.currentToastWin.close(); } catch (e) {}
    }
  }

  showNextUnread() {
    if (this.unreadList.length === 0) return;
    this.showPrevUnreadInPlace(this.currentAlertData ? this.currentAlertData.id : null);
  }
}

module.exports = ToastManager;
