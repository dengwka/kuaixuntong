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
   * 准确检测当前操作系统的硬件芯片架构
   * 特别处理 macOS 场景：精准区分 Apple Silicon (M系列芯片) 与 Intel 芯片 (即便处于 Rosetta 2 转译下亦能穿透识别)
   */
  getSystemInfo() {
    const platform = process.platform;
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';
    let arch = process.arch; // 'arm64' 或 'x64'

    if (isMac && arch === 'x64') {
      try {
        const { execSync } = require('child_process');
        // sysctl -in sysctl.proc_translated 为 1 表示在 Apple Silicon 芯片上以 Rosetta 2 运行
        const translated = execSync('sysctl -in sysctl.proc_translated', { timeout: 1000 }).toString().trim();
        if (translated === '1') {
          arch = 'arm64';
        }
      } catch (e) {}
    }

    let archName = '未知架构';
    let platformName = '未知系统';
    if (isWin) {
      platformName = 'Windows';
      archName = 'x64 (64位)';
    } else if (isMac) {
      platformName = 'macOS';
      archName = arch === 'arm64' ? 'Apple Silicon (M系列芯片)' : 'Intel 芯片';
    }

    return {
      platform,
      isWin,
      isMac,
      arch, // 'arm64' 或 'x64'
      archName,
      platformName,
      summary: `${platformName} (${archName})`
    };
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
      const sys = this.getSystemInfo();
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

      // 获取资产中最新构建上传的时间 (若重新上传构建包，时间会晚于 release.published_at)
      let latestAssetTime = '';
      if (Array.isArray(release.assets) && release.assets.length > 0) {
        let maxMs = 0;
        for (const a of release.assets) {
          const t = new Date(a.updated_at || a.created_at || 0).getTime();
          if (t > maxMs) maxMs = t;
        }
        if (maxMs > 0) {
          latestAssetTime = new Date(maxMs).toLocaleString('zh-CN', { hour12: false });
        }
      }
      const buildTime = latestAssetTime || publishedAt;
      const checkTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });

      // 整理资产列表并清晰标注芯片与适用平台
      const assetList = Array.isArray(release.assets) ? release.assets.map(a => {
        const name = a.name || '';
        let targetType = 'other';
        let targetLabel = '通用附件';
        let isRecommended = false;

        if (name.endsWith('.exe')) {
          targetType = 'win';
          targetLabel = 'Windows (64位安装包)';
          if (sys.isWin) isRecommended = true;
        } else if (name.endsWith('.dmg')) {
          if (name.includes('arm64') || name.includes('arm')) {
            targetType = 'mac-arm64';
            targetLabel = 'macOS (Apple Silicon M系列芯片专用)';
            if (sys.isMac && sys.arch === 'arm64') isRecommended = true;
          } else if (name.includes('x64') || name.includes('intel')) {
            targetType = 'mac-x64';
            targetLabel = 'macOS (Intel 处理器芯片专用)';
            if (sys.isMac && sys.arch === 'x64') isRecommended = true;
          } else {
            targetType = 'mac-dmg';
            targetLabel = 'macOS 磁盘映像 (.dmg)';
            if (sys.isMac) isRecommended = true;
          }
        } else if (name.endsWith('.zip')) {
          if (name.includes('arm64') || name.includes('arm')) {
            targetType = 'mac-arm64-zip';
            targetLabel = 'macOS (Apple Silicon M系列便携包)';
          } else if (name.includes('x64') || name.includes('intel')) {
            targetType = 'mac-x64-zip';
            targetLabel = 'macOS (Intel 芯片便携包)';
          } else {
            targetType = 'zip';
            targetLabel = '压缩包 (.zip)';
          }
        }

        return {
          name: a.name,
          size: a.size,
          sizeMb: (a.size / (1024 * 1024)).toFixed(1) + ' MB',
          downloadUrl: a.browser_download_url,
          targetType,
          targetLabel,
          isRecommended
        };
      }) : [];

      // 为当前运行的机器精准匹配专属安装包 (自动更新与一键更新使用)
      let downloadUrl = releasePageUrl;
      let matchedAsset = null;

      if (Array.isArray(release.assets)) {
        if (sys.isWin) {
          matchedAsset = release.assets.find(a => a.name.endsWith('.exe'));
        } else if (sys.isMac) {
          if (sys.arch === 'arm64') {
            // Apple Silicon M系列芯片：精准匹配 arm64 安装包
            matchedAsset = release.assets.find(a => a.name.endsWith('.dmg') && (a.name.includes('arm64') || a.name.includes('arm')))
              || release.assets.find(a => a.name.endsWith('.zip') && (a.name.includes('arm64') || a.name.includes('arm')))
              || release.assets.find(a => a.name.endsWith('.dmg') && !a.name.includes('x64'))
              || release.assets.find(a => a.name.endsWith('.dmg'));
          } else {
            // Intel 芯片机器：精准匹配 x64 安装包，严格排除 arm64
            matchedAsset = release.assets.find(a => a.name.endsWith('.dmg') && (a.name.includes('x64') || a.name.includes('x86_64') || a.name.includes('intel')))
              || release.assets.find(a => a.name.endsWith('.zip') && (a.name.includes('x64') || a.name.includes('x86_64') || a.name.includes('intel')))
              || release.assets.find(a => a.name.endsWith('.dmg') && !a.name.includes('arm64'))
              || release.assets.find(a => a.name.endsWith('.dmg'));
          }
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
        matchedAssetName: matchedAsset ? matchedAsset.name : '',
        systemInfo: sys,
        releasePageUrl,
        publishedAt,
        buildTime,
        checkTime,
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
   * 获取多源加速下载节点列表 (智能 CDN 镜像加速，国内提速 10~50 倍)
   */
  getAcceleratedDownloadUrls(rawUrl, customNode = 'auto') {
    if (!rawUrl || typeof rawUrl !== 'string') return [];
    const cleanRaw = rawUrl.trim();
    if (!cleanRaw.includes('github.com')) {
      return [{ url: cleanRaw, name: '直连源' }];
    }

    const mirrorFast = `https://ghfast.top/${cleanRaw}`;
    const mirrorProxy = `https://gh-proxy.com/${cleanRaw}`;

    if (customNode === 'ghfast') {
      return [
        { url: mirrorFast, name: '⚡ 智能高速镜像 (GHFast CDN)' },
        { url: mirrorProxy, name: '🚀 国内备用镜像 (GH-Proxy CDN)' },
        { url: cleanRaw, name: '🌐 GitHub 官方源 (直连)' }
      ];
    } else if (customNode === 'ghproxy') {
      return [
        { url: mirrorProxy, name: '🚀 国内备用镜像 (GH-Proxy CDN)' },
        { url: mirrorFast, name: '⚡ 智能高速镜像 (GHFast CDN)' },
        { url: cleanRaw, name: '🌐 GitHub 官方源 (直连)' }
      ];
    } else if (customNode === 'official') {
      return [
        { url: cleanRaw, name: '🌐 GitHub 官方源 (直连)' },
        { url: mirrorFast, name: '⚡ 智能高速镜像 (GHFast CDN)' },
        { url: mirrorProxy, name: '🚀 国内备用镜像 (GH-Proxy CDN)' }
      ];
    } else {
      // 默认 'auto' 模式：首选高速 CDN 镜像，自动优雅备用兜底
      return [
        { url: mirrorFast, name: '⚡ 智能高速镜像 (GHFast CDN)' },
        { url: mirrorProxy, name: '🚀 国内备用镜像 (GH-Proxy CDN)' },
        { url: cleanRaw, name: '🌐 GitHub 官方源 (直连)' }
      ];
    }
  }

  /**
   * 打开下载或发布页 (支持高速镜像模式)
   */
  openDownloadPage(url, mode = 'accelerated') {
    let targetUrl = url || (this.lastCheckResult && this.lastCheckResult.downloadUrl) || `https://github.com/${this.owner}/${this.repo}/releases/latest`;
    if (mode === 'accelerated' && targetUrl.includes('github.com') && targetUrl.includes('/releases/download/')) {
      targetUrl = `https://ghfast.top/${targetUrl}`;
    }
    if (shell) {
      shell.openExternal(targetUrl);
    }
  }

  /**
   * 下载安装包并在完成后自动执行安装 (多源极速加速 + 自动降级兜底)
   */
  async downloadAndInstallUpdate(url, onProgress, options = {}) {
    const fetchFn = (typeof net !== 'undefined' && net.fetch) ? net.fetch : fetch;
    const rawUrl = url || (this.lastCheckResult && this.lastCheckResult.downloadUrl);
    if (!rawUrl) {
      throw new Error('未找到可用安装包下载地址');
    }

    const selectedNode = (options && options.node) || this.preferredNode || 'auto';
    const candidates = this.getAcceleratedDownloadUrls(rawUrl, selectedNode);

    let lastError = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const isLast = (i === candidates.length - 1);
      logger.info(`[Updater] 启动极速下载 (第 ${i + 1}/${candidates.length} 节点 [${candidate.name}]): ${candidate.url}`);

      if (typeof onProgress === 'function' && i > 0) {
        onProgress({
          percent: 0,
          receivedMb: '0.0',
          totalMb: '0.0',
          speedText: '正在切换备用节点...',
          remainingText: '',
          nodeName: candidate.name
        });
      }

      try {
        const result = await this.executeDownload(candidate.url, candidate.name, fetchFn, onProgress);
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[Updater] 节点 [${candidate.name}] 下载受阻: ${err.message}` + (isLast ? '' : '，正在自动切换至下一个镜像节点...'));
      }
    }

    throw new Error(`所有镜像与官方节点下载均未完成: ${(lastError && lastError.message) || '网络连接超时'}`);
  }

  /**
   * 执行单节点流式下载并实时计算精确下载速度与剩余耗时
   */
  async executeDownload(targetUrl, nodeName, fetchFn, onProgress) {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => {
      controller.abort();
    }, 15000); // 15秒握手超时

    let res;
    try {
      res = await fetchFn(targetUrl, {
        redirect: 'follow',
        signal: controller.signal
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
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
    let lastReportTime = Date.now();
    let lastReportBytes = 0;
    let currentSpeedText = '-- MB/s';

    const emitProgress = () => {
      if (typeof onProgress !== 'function') return;
      const now = Date.now();
      const deltaSec = (now - lastReportTime) / 1000;
      if (deltaSec >= 0.25 || (totalBytes > 0 && receivedBytes === totalBytes)) {
        const deltaBytes = receivedBytes - lastReportBytes;
        const bytesPerSec = deltaSec > 0 ? (deltaBytes / deltaSec) : 0;
        const speedMb = (bytesPerSec / (1024 * 1024)).toFixed(1);
        currentSpeedText = `${speedMb} MB/s`;

        const remainingSec = (bytesPerSec > 0 && totalBytes > receivedBytes)
          ? Math.ceil((totalBytes - receivedBytes) / bytesPerSec)
          : 0;
        const remainingText = remainingSec > 0 ? `剩余约 ${remainingSec} 秒` : '';

        const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
        onProgress({
          percent,
          receivedMb: (receivedBytes / (1024 * 1024)).toFixed(1),
          totalMb: (totalBytes / (1024 * 1024)).toFixed(1),
          speedText: currentSpeedText,
          remainingText,
          nodeName
        });

        lastReportTime = now;
        lastReportBytes = receivedBytes;
      }
    };

    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            receivedBytes += value.length;
            const canContinue = destStream.write(value);
            if (!canContinue) {
              await new Promise(r => destStream.once('drain', r));
            }
            emitProgress();
          }
        }
      } else {
        for await (const chunk of res.body) {
          receivedBytes += chunk.length;
          const canContinue = destStream.write(chunk);
          if (!canContinue) {
            await new Promise(r => destStream.once('drain', r));
          }
          emitProgress();
        }
      }
    } catch (streamErr) {
      destStream.destroy();
      try { fs.unlinkSync(destPath); } catch (e) {}
      throw streamErr;
    }

    await new Promise((resolve, reject) => {
      destStream.on('close', resolve);
      destStream.on('error', reject);
      destStream.end();
    });

    const stat = fs.statSync(destPath);
    if (totalBytes > 0 && stat.size !== totalBytes) {
      try { fs.unlinkSync(destPath); } catch (e) {}
      throw new Error(`完整性校验未通过: 预期 ${totalBytes} 字节，实际仅接收 ${stat.size} 字节`);
    }

    logger.info(`[Updater] 安装包已安全下载并校验完成: ${destPath} (${(receivedBytes / (1024 * 1024)).toFixed(1)} MB)，正在启动安装程序...`);

    await new Promise(r => setTimeout(r, 600));

    if (shell && typeof shell.openPath === 'function') {
      const err = await shell.openPath(destPath);
      if (err) {
        logger.warn(`[Updater] shell.openPath 启动安装程序返回提示: ${err}`);
      }
    }

    return {
      success: true,
      filePath: destPath,
      nodeName
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
