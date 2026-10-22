const { app, net, shell } = require('electron');
const logger = require('./logger');

class UpdateManager {
  constructor() {
    this.owner = 'dengwka';
    this.repo = 'kuaixuntong';
    this.apiUrl = `https://api.github.com/repos/${this.owner}/${this.repo}/releases/latest`;
    this.currentVersion = app ? app.getVersion() : '1.0.0';
    this.lastCheckResult = null;
  }

  /**
   * 语义化版本对比：v1 > v2 返回 1，v1 < v2 返回 -1，相等返回 0
   */
  compareVersions(v1, v2) {
    const clean1 = String(v1).replace(/^[vV]/, '').trim();
    const clean2 = String(v2).replace(/^[vV]/, '').trim();

    const parts1 = clean1.split('.').map(n => parseInt(n, 10) || 0);
    const parts2 = clean2.split('.').map(n => parseInt(n, 10) || 0);

    const maxLen = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < maxLen; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  }

  /**
   * 检查最新版本
   */
  async checkForUpdates() {
    logger.info(`[Updater] 开始检查版本更新 (当前版本: v${this.currentVersion})...`);
    
    try {
      const fetchFn = (typeof net !== 'undefined' && net.fetch) ? net.fetch : fetch;
      const res = await fetchFn(this.apiUrl, {
        headers: {
          'User-Agent': 'KuaixunTong-App',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!res.ok) {
        throw new Error(`GitHub API 响应异常: HTTP ${res.status}`);
      }

      const release = await res.json();
      const latestTag = release.tag_name || '';
      const releaseName = release.name || latestTag;
      const releaseNotes = release.body || '暂无详细更新说明。';
      const releasePageUrl = release.html_url || `https://github.com/${this.owner}/${this.repo}/releases/latest`;
      const publishedAt = release.published_at ? new Date(release.published_at).toLocaleString('zh-CN', { hour12: false }) : '';

      // 寻找对应的安装包资产
      let downloadUrl = releasePageUrl;
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';

      if (Array.isArray(release.assets)) {
        let matchedAsset = null;
        if (isWin) {
          matchedAsset = release.assets.find(a => a.name.endsWith('.exe'));
        } else if (isMac) {
          matchedAsset = release.assets.find(a => a.name.endsWith('.dmg') || a.name.endsWith('.zip'));
        }
        if (matchedAsset && matchedAsset.browser_download_url) {
          downloadUrl = matchedAsset.browser_download_url;
        }
      }

      const hasUpdate = this.compareVersions(latestTag, this.currentVersion) > 0;

      this.lastCheckResult = {
        success: true,
        hasUpdate,
        currentVersion: this.currentVersion,
        latestVersion: latestTag.replace(/^[vV]/, ''),
        latestTag,
        releaseName,
        releaseNotes,
        downloadUrl,
        releasePageUrl,
        publishedAt
      };

      if (hasUpdate) {
        logger.info(`[Updater] 发现新版本: ${latestTag} (当前: v${this.currentVersion})`);
      } else {
        logger.info(`[Updater] 当前已是最新版本: v${this.currentVersion}`);
      }

      return this.lastCheckResult;
    } catch (err) {
      logger.error(`[Updater] 检查更新失败:`, err.message);
      return {
        success: false,
        error: err.message,
        currentVersion: this.currentVersion,
        hasUpdate: false
      };
    }
  }

  /**
   * 打开下载或发布页
   */
  openDownloadPage(url) {
    const targetUrl = url || (this.lastCheckResult && this.lastCheckResult.downloadUrl) || `https://github.com/${this.owner}/${this.repo}/releases/latest`;
    if (shell) {
      shell.openExternal(targetUrl);
    }
  }

  /**
   * 启动时静默检查更新
   */
  scheduleStartupCheck(toastManager, delayMs = 6000) {
    setTimeout(async () => {
      const result = await this.checkForUpdates();
      if (result && result.hasUpdate && toastManager) {
        // 发现新版本，弹出桌面卡片提醒
        const alertData = {
          id: `update_${result.latestTag}_${Date.now()}`,
          is_test: false,
          source: '系统升级',
          source_key: 'system',
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          pub_time: result.publishedAt || new Date().toLocaleString('zh-CN', { hour12: false }),
          title: `🚀 发现新版本: ${result.latestTag}`,
          content: `快讯通已发布全新版本！\n\n• 当前运行版本: v${result.currentVersion}\n• 线上最新版本: ${result.latestTag}\n• 更新内容:\n${result.releaseNotes.substring(0, 180)}${result.releaseNotes.length > 180 ? '...' : ''}\n\n点击卡片即可前往下载更新。`,
          url: result.downloadUrl || result.releasePageUrl,
          important: true,
          ai_analysis: {
            ai_source: '版本更新管家',
            source_type: 'system',
            summary: `发现可用更新 ${result.latestTag}，建议前往升级以获得最新性能与功能。`,
            impacts: {}
          }
        };
        toastManager.showToast(alertData);
      }
    }, delayMs);
  }
}

module.exports = new UpdateManager();
