const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');

class TrayManager {
  constructor() {
    this.tray = null;
    this.unreadCount = 0;
    this.isFlashing = false;
    this.flashTimer = null;
    this.flashState = false;

    this.onShowUnread = null;
    this.onOpenSettings = null;
    this.onSendTest = null;

    this.normalIcon = null;
    this.badgeIcon = null;
    this.blankIcon = null;
  }

  init({ onShowUnread, onOpenSettings, onSendTest, onCheckUpdate }) {
    this.onShowUnread = onShowUnread;
    this.onOpenSettings = onOpenSettings;
    this.onSendTest = onSendTest;
    this.onCheckUpdate = onCheckUpdate;

    const assetsDir = path.join(__dirname, '..', 'assets');
    const normalPath = path.join(assetsDir, 'tray_icon.png');
    const badgePath = path.join(assetsDir, 'tray_badge.png');
    const blankPath = path.join(assetsDir, 'tray_blank.png');

    this.normalIcon = nativeImage.createFromPath(normalPath);
    this.badgeIcon = nativeImage.createFromPath(badgePath);
    this.blankIcon = nativeImage.createFromPath(blankPath);

    // macOS 菜单栏状态图标规格适配：
    // macOS 菜单栏标准图标高度为 16~18pt，自动缩放至 18x18，解决比正常系统图标大一圈的问题
    if (process.platform === 'darwin') {
      this.normalIcon = this.normalIcon.resize({ width: 18, height: 18 });
      this.badgeIcon = this.badgeIcon.resize({ width: 18, height: 18 });
      this.blankIcon = this.blankIcon.resize({ width: 18, height: 18 });
    }

    this.tray = new Tray(this.normalIcon);
    this.tray.setToolTip('桌面快讯与重要事件监控 - 正在常驻监听');

    this.updateContextMenu();

    // 单击/双击托盘图标：若有未看消息优先看未看，否则打开管理配置
    this.tray.on('click', () => {
      this.handleDefaultClick();
    });

    this.tray.on('double-click', () => {
      this.handleDefaultClick();
    });

    console.log('[TrayManager] 状态栏/系统托盘图标已就绪，已成功常驻！');
  }

  handleDefaultClick() {
    const now = Date.now();
    if (this.lastClickTime && (now - this.lastClickTime < 350)) {
      return;
    }
    this.lastClickTime = now;

    if (this.unreadCount > 0 && this.onShowUnread) {
      this.onShowUnread();
    } else if (this.onOpenSettings) {
      this.onOpenSettings();
    }
  }

  updateContextMenu() {
    if (!this.tray) return;

    const unreadLabel = this.unreadCount > 0 
      ? `📰 查看未看快讯 (${this.unreadCount} 条未看)`
      : '📰 查看未看快讯 (暂无未看)';

    const contextMenu = Menu.buildFromTemplate([
      {
        label: unreadLabel,
        enabled: this.unreadCount > 0,
        click: () => {
          if (this.onShowUnread) this.onShowUnread();
        }
      },
      {
        label: '⚙ 管理配置中心',
        click: () => {
          if (this.onOpenSettings) this.onOpenSettings();
        }
      },
      {
        label: '🔄 检查版本更新',
        click: () => {
          if (this.onCheckUpdate) this.onCheckUpdate();
        }
      },
      { type: 'separator' },
      {
        label: '❌ 退出程序',
        click: () => {
          this.destroy();
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  setUnreadCount(count) {
    this.unreadCount = Math.max(0, count);
    this.updateContextMenu();

    if (!this.tray) return;

    if (this.unreadCount > 0) {
      this.tray.setToolTip(`桌面快讯 - 有 ${this.unreadCount} 条未看快讯 (点击查看)`);
      if (!this.isFlashing) {
        this.startFlashing();
      }
    } else {
      this.tray.setToolTip('桌面快讯与重要事件监控 - 正在常驻监听');
      if (this.isFlashing) {
        this.stopFlashing();
      }
    }
  }

  startFlashing() {
    this.isFlashing = true;
    this.flashState = false;

    if (this.flashTimer) clearInterval(this.flashTimer);

    // QQ 消息式经典闪烁循环：400ms 交替切换红点图标与空白图标
    this.flashTimer = setInterval(() => {
      if (!this.tray) return;
      try {
        if (this.flashState) {
          this.tray.setImage(this.badgeIcon);
        } else {
          this.tray.setImage(this.blankIcon);
        }
        this.flashState = !this.flashState;
      } catch (e) {}
    }, 400);
  }

  stopFlashing() {
    this.isFlashing = false;
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.tray) {
      try {
        this.tray.setImage(this.normalIcon);
      } catch (e) {}
    }
  }

  destroy() {
    this.stopFlashing();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = new TrayManager();
