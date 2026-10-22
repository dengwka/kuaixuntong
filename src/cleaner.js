const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const historyManager = require('./history');
const configManager = require('./config');

class StorageCleaner {
  constructor() {
    this.timer = null;
    this.intervalMs = 6 * 60 * 60 * 1000; // 每 6 小时自动巡检一次
  }

  startPeriodicCleanup() {
    if (this.timer) clearInterval(this.timer);
    // 启动延迟 10 秒后执行首次清理巡检
    setTimeout(() => {
      this.performCleanup();
    }, 10000);

    this.timer = setInterval(() => {
      this.performCleanup();
    }, this.intervalMs);
  }

  performCleanup(manualOptions = null) {
    const cfg = configManager.config;
    const storageCfg = (cfg && cfg.storage) || {};

    if (!manualOptions && storageCfg.auto_cleanup === false) {
      return { skipped: true, reason: 'auto_cleanup is disabled in config' };
    }

    const retentionDays = manualOptions && manualOptions.retentionDays !== undefined 
      ? manualOptions.retentionDays 
      : (storageCfg.retention_days || 3);

    const maxFileSizeMb = manualOptions && manualOptions.maxFileSizeMb !== undefined 
      ? manualOptions.maxFileSizeMb 
      : (storageCfg.max_file_size_mb || 10);

    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const maxSizeBytes = maxFileSizeMb * 1024 * 1024;

    logger.info(`[StorageCleaner] 开始执行存储清理巡检 (保留天数: ${retentionDays}天, 单文件上限: ${maxFileSizeMb}MB)...`);

    let cleanedRecords = 0;
    let freedBytes = 0;

    // 1. 清理 pushed_history.json
    try {
      const historyFile = historyManager.filepath;
      if (fs.existsSync(historyFile)) {
        const stat = fs.statSync(historyFile);
        const originalSize = stat.size;

        if (Array.isArray(historyManager.records)) {
          const beforeCount = historyManager.records.length;
          
          // 过滤掉超过 retentionDays 的历史记录
          historyManager.records = historyManager.records.filter(r => {
            if (!r) return false;
            let timeMs = 0;
            if (r.pushed_at) timeMs = Date.parse(r.pushed_at.replace(/-/g, '/'));
            if (!timeMs && r.pub_time) timeMs = Date.parse(r.pub_time.replace(/-/g, '/'));
            if (isNaN(timeMs)) return true; // 无法解析时间的不轻易删除
            return timeMs >= cutoffMs;
          });

          // 如果文件仍然超过大小上限，截断仅保留最新的 1000 条
          if (originalSize > maxSizeBytes && historyManager.records.length > 1000) {
            historyManager.records = historyManager.records.slice(0, 1000);
          }

          cleanedRecords += (beforeCount - historyManager.records.length);
          historyManager.pushedIds = new Set(historyManager.records.map(r => r.id));
          historyManager.save();

          if (fs.existsSync(historyFile)) {
            const newSize = fs.statSync(historyFile).size;
            if (originalSize > newSize) {
              freedBytes += (originalSize - newSize);
            }
          }
        }
      }
    } catch (e) {
      logger.error('[StorageCleaner] 清理 pushed_history.json 异常:', e);
    }

    // 2. 清理日志文件 (app_runtime.log, app_error.log)
    try {
      const logDir = logger.logDir;
      const logFiles = ['app_runtime.log', 'app_error.log'];

      for (const fname of logFiles) {
        const fpath = path.join(logDir, fname);
        if (fs.existsSync(fpath)) {
          const stat = fs.statSync(fpath);
          if (stat.size > maxSizeBytes) {
            const originalSize = stat.size;
            // 超过最大大小，保留尾部 30% 最新的日志
            const content = fs.readFileSync(fpath, 'utf-8');
            const lines = content.split('\n');
            const keepLines = lines.slice(Math.floor(lines.length * 0.7));
            fs.writeFileSync(fpath, keepLines.join('\n'), 'utf-8');
            const newSize = fs.statSync(fpath).size;
            freedBytes += (originalSize - newSize);
            logger.info(`[StorageCleaner] 日志文件 ${fname} 超过 ${maxFileSizeMb}MB，已自动修剪截断，释放 ${(originalSize - newSize) / 1024}KB 空间。`);
          }
        }
      }
    } catch (e) {
      logger.error('[StorageCleaner] 清理日志文件异常:', e);
    }

    const summary = {
      cleanedRecords,
      freedKb: Math.round(freedBytes / 1024),
      time: new Date().toLocaleString('zh-CN', { hour12: false })
    };
    logger.info(`[StorageCleaner] 存储清理巡检完成: 清理过期快讯 ${cleanedRecords} 条, 释放磁盘约 ${summary.freedKb} KB。`);
    return summary;
  }
}

module.exports = new StorageCleaner();
