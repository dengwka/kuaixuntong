const { app, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
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

      // 整理资产列表
      const assetList = Array.isArray(release.assets) ? release.assets.map(a => ({
        name: a.name,
        size: a.size,
        sizeMb: (a.size / (1024 * 1024)).toFixed(1) + ' MB',
        downloadUrl: a.browser_download_url
      })) : [];

      // 寻找当前操作系统匹配的安装包资产
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
        publishedAt,
        assets: assetList
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
   * 下载安装包并在完成后自动执行安装
   */
  async downloadAndInstallUpdate(url, onProgress) {
    const fetchFn = (typeof net !== 'undefined' && net.fetch) ? net.fetch : fetch;
    const downloadUrl = url || (this.lastCheckResult && this.lastCheckResult.downloadUrl);
    if (!downloadUrl) {
      throw new Error('未找到可用安装包下载地址');
    }

    logger.info(`[Updater] 开始自动下载最新安装包: ${downloadUrl}`);
    const res = await fetchFn(downloadUrl);
    if (!res.ok) {
      throw new Error(`下载请求失败: HTTP ${res.status}`);
    }

    const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    const ext = isWin ? '.exe' : (isMac ? '.dmg' : '');
    const fileName = `kuaixuntong-setup-${Date.now()}${ext}`;
    const tempDir = app ? app.getPath('temp') : path.resolve(__dirname, '..', 'data');
    const destPath = path.join(tempDir, fileName);

    const destStream = fs.createWriteStream(destPath);
    let receivedBytes = 0;

    const { Readable } = require('stream');
    const nodeStream = (typeof Readable.fromWeb === 'function' && res.body)
      ? Readable.fromWeb(res.body)
      : res.body;

    nodeStream.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (totalBytes > 0 && typeof onProgress === 'function') {
        const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
        onProgress({
          percent,
          receivedMb: (receivedBytes / (1024 * 1024)).toFixed(1),
          totalMb: (totalBytes / (1024 * 1024)).toFixed(1)
        });
      }
    });

    await new Promise((resolve, reject) => {
      nodeStream.pipe(destStream);
      destStream.on('finish', resolve);
      destStream.on('error', reject);
      nodeStream.on('error', reject);
    });

    logger.info(`[Updater] 安装包已下载至: ${destPath} (${(receivedBytes / (1024 * 1024)).toFixed(1)} MB)，正在启动安装程序...`);

    // 自动唤起安装包
    if (shell) {
      shell.openPath(destPath);
    }

    return {
      success: true,
      filePath: destPath
    };
  }

  /**
   * 触发新版本桌面通知弹窗
   */
  showUpdateToast(toastManager, result) {
    if (!toastManager || !result) return;
    const cleanNotes = (result.releaseNotes || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/^(\-{3,}|\*{3,}|_{3,})$/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '• ')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\|.*?\|/g, '')
      .trim();
    const snippet = cleanNotes.substring(0, 140) + (cleanNotes.length > 140 ? '...' : '');

    const alertData = {
      id: `update_${result.latestTag}_${Date.now()}`,
      is_test: false,
      source: '版本更新',
      source_key: 'system',
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      pub_time: result.publishedAt || new Date().toLocaleString('zh-CN', { hour12: false }),
      title: `🚀 发现新版本: ${result.latestTag}`,
      content: `快讯通已发布全新版本！\n\n• 当前运行版本: v${result.currentVersion}\n• 线上最新版本: ${result.latestTag}\n• 更新亮点概要:\n${snippet}\n\n点击卡片即可前往配置中心一键更新。`,
      url: result.downloadUrl || result.releasePageUrl,
      important: true,
      ai_analysis: {
        ai_source: '版本更新管家',
        source_type: 'system',
        summary: `发现可用新版本 ${result.latestTag}，建议前往升级以获得最新性能与功能。`,
        impacts: {}
      }
    };
    toastManager.showToast(alertData);
  }

  /**
   * 启动时检查更新（根据配置策略自动执行）
   */
  scheduleStartupCheck(configManager, toastManager, delayMs = 6000, onFoundCallback = null) {
    setTimeout(async () => {
      const updateCfg = (configManager && configManager.config && configManager.config.updates) || {};
      if (updateCfg.strategy === 'manual') {
        logger.info('[Updater] 当前更新策略为【手动更新】，跳过启动自动检测。');
        return;
      }

      const result = await this.checkForUpdates();
      if (result && result.hasUpdate) {
        if (typeof onFoundCallback === 'function') {
          onFoundCallback(result);
        }
        if (updateCfg.notify_on_new !== false && toastManager) {
          this.showUpdateToast(toastManager, result);
        }
      } else if (result && typeof onFoundCallback === 'function') {
        onFoundCallback(result);
      }
    }, delayMs);
  }

  /**
   * 后台周期性检测
   */
  startPeriodicCheck(configManager, toastManager, onFoundCallback = null) {
    // 默认每 12 小时检查一次
    const hours = (configManager && configManager.config && configManager.config.updates && configManager.config.updates.check_interval_hours) || 12;
    const intervalMs = Math.max(1, hours) * 3600 * 1000;

    setInterval(async () => {
      const updateCfg = (configManager && configManager.config && configManager.config.updates) || {};
      if (updateCfg.strategy === 'manual') return;

      const result = await this.checkForUpdates();
      if (result && result.hasUpdate) {
        if (typeof onFoundCallback === 'function') {
          onFoundCallback(result);
        }
        if (updateCfg.notify_on_new !== false && toastManager) {
          this.showUpdateToast(toastManager, result);
        }
      }
    }, intervalMs);
  }
}

module.exports = new UpdateManager();
