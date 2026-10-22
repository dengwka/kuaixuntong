const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const logger = require('./logger');

class HistoryManager {
  constructor(maxRecords = 5000) {
    this.maxRecords = maxRecords;
    this.dataDir = '';
    this.logDir = '';
    this.filepath = '';
    this.fetchPath = '';
    this.unattendedPath = '';

    this.pushedIds = new Set();
    this.records = [];
    this.unattendedAlerts = [];
    this.fetchLocations = { last_sync: '', sources: {} };
    this.lastSyncTime = '';

    this.initDefaultDir();
    this.load();
  }

  getDefaultDataDir() {
    if (app) {
      return path.join(app.getPath('userData'), 'data');
    }
    return path.resolve(__dirname, '..', 'data');
  }

  initDefaultDir() {
    this.setDataDir(this.getDefaultDataDir());
    this.logDir = app ? path.join(app.getPath('userData'), 'log') : path.resolve(__dirname, '..', 'log');
  }

  setDataDir(targetDir) {
    if (!targetDir) return;
    let safeDir = String(targetDir);
    if (safeDir.includes('app.asar')) {
      safeDir = safeDir.replace(/[\\/]app\.asar[\\/]?.*/i, path.sep + 'data');
    }
    this.dataDir = path.resolve(safeDir);

    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      this.filepath = path.join(this.dataDir, 'pushed_history.json');
      this.fetchPath = path.join(this.dataDir, 'fetch_locations.json');
      this.unattendedPath = path.join(this.dataDir, 'unattended_alerts.json');

      logger.info(`[HistoryManager] 数据存储目录已设定为: ${this.dataDir}`);
    } catch (e) {
      logger.error('[HistoryManager] 初始化存储目录异常:', e);
    }
  }

  getItemUniqueId(item) {
    if (!item) return '';
    if (typeof item !== 'object') return String(item).trim();

    const rawId = item.id || item.item_id || item.flash_id;
    if (rawId) return String(rawId).trim();

    const source = String(item.source || '');
    const time = String(item.time || '');
    const title = String(item.title || '');
    const content = String(item.content || '').substring(0, 80);
    const sig = `${source}_${time}_${title}_${content}`;
    return 'hash_' + crypto.createHash('md5').update(sig).digest('hex');
  }

  isPushed(itemOrId) {
    const uid = typeof itemOrId === 'object' ? this.getItemUniqueId(itemOrId) : String(itemOrId).trim();
    return this.pushedIds.has(uid);
  }

  getAllPushedIds() {
    return new Set(this.pushedIds);
  }

  recordFetch(sourceKey, sourceName, url, params = {}, count = 0, latestId = '', error = null) {
    const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
    this.lastSyncTime = nowStr;

    if (!this.fetchLocations.sources) {
      this.fetchLocations.sources = {};
    }

    this.fetchLocations.last_sync = nowStr;
    this.fetchLocations.sources[sourceKey] = {
      name: sourceName,
      url: url,
      params: params,
      last_fetch_time: nowStr,
      items_received: count,
      latest_id: String(latestId || ''),
      status: error ? `error: ${error}` : 'ok'
    };

    try {
      if (this.fetchPath) {
        fs.writeFileSync(this.fetchPath, JSON.stringify(this.fetchLocations, null, 2), 'utf-8');
      }
    } catch (e) {
      logger.error('[HistoryManager] 保存抓取位置失败:', e);
    }

    if (error) {
      logger.error(`[FETCH] ${sourceName} 抓取异常 [${url}]: ${error}`);
    } else {
      logger.info(`[FETCH] ${sourceName} 抓取成功 [${url}], 收到 ${count} 条, 最新ID: ${latestId || '--'}`);
    }
  }

  recordPushed(item, syncDelaySec = 0) {
    const uid = this.getItemUniqueId(item);
    if (!uid || this.pushedIds.has(uid)) return false;

    this.pushedIds.add(uid);
    const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });

    const newRecord = {
      id: uid,
      title: item.title || '',
      source: item.source || '',
      pub_time: item.pub_time || item.time || '',
      pushed_at: nowStr,
      sync_delay_sec: Number(syncDelaySec) || 0,
      important: !!item.important,
      url: item.url || '',
      lifecycle_status: 'pushed',
      ai_summary: (item.ai_analysis && item.ai_analysis.summary) || '',
      impacts: (item.ai_analysis && item.ai_analysis.impacts) || {}
    };

    this.records.unshift(newRecord);

    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(0, this.maxRecords);
      this.pushedIds = new Set(this.records.map(r => r.id));
    }

    this.save();
    logger.info(`[PUSH_TOAST] 弹窗展示成功: [${uid}] 原文发布: ${newRecord.pub_time}, 显示延迟: ${newRecord.sync_delay_sec}秒, 标题: ${newRecord.title.substring(0, 35)}`);
    return true;
  }

  recordInteraction(alertId, action, extraData = {}) {
    const aid = String(alertId || '');
    if (!aid) return;

    const record = this.records.find(r => r.id === aid);
    if (record) {
      record.lifecycle_status = action;
      record.last_interacted_at = new Date().toLocaleString('zh-CN', { hour12: false });
    }

    if (action === 'unattended_expired') {
      const exists = this.unattendedAlerts.some(a => String(a.id) === aid);
      if (!exists) {
        this.unattendedAlerts.push({
          id: aid,
          title: (extraData && extraData.title) || (record && record.title) || '',
          source: (extraData && extraData.source) || (record && record.source) || '',
          pub_time: (extraData && extraData.pub_time) || (record && record.pub_time) || '',
          expired_at: new Date().toLocaleString('zh-CN', { hour12: false }),
          url: (extraData && extraData.url) || (record && record.url) || ''
        });
        this.saveUnattended();
      }
      logger.info(`[UNATTENDED] 弹窗未点击超时关闭: [${aid}], 计入未读池并开启托盘闪烁`);
    } else if (action === 'clicked' || action === 'hovered' || action === 'unread_viewed') {
      const oldLen = this.unattendedAlerts.length;
      this.unattendedAlerts = this.unattendedAlerts.filter(a => String(a.id) !== aid);
      if (this.unattendedAlerts.length !== oldLen) {
        this.saveUnattended();
      }
      const actionName = action === 'clicked' ? '用户点击弹窗' : (action === 'hovered' ? '用户鼠标悬停' : '用户补看未读');
      logger.info(`[INTERACTION] ${actionName}: [${aid}] (已标记已读)`);
    }

    this.save();
  }

  clearAllUnattended() {
    this.unattendedAlerts = [];
    this.saveUnattended();
    logger.info('[UNATTENDED] 用户执行忽略全部历史未读，未读池已清空。');
  }

  markSeenBatch(items) {
    let changed = false;
    const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });

    for (const item of items) {
      const uid = this.getItemUniqueId(item);
      if (uid && !this.pushedIds.has(uid)) {
        this.pushedIds.add(uid);
        this.records.push({
          id: uid,
          title: (item.title || '').substring(0, 100),
          source: item.source || '',
          pub_time: item.pub_time || item.time || '',
          pushed_at: `${nowStr} (基线同步)`,
          lifecycle_status: 'baseline_skip'
        });
        changed = true;
      }
    }

    if (changed) {
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(0, this.maxRecords);
        this.pushedIds = new Set(this.records.map(r => r.id));
      }
      this.save();
    }
  }

  load() {
    if (this.filepath && fs.existsSync(this.filepath)) {
      try {
        const raw = fs.readFileSync(this.filepath, 'utf-8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          const ids = data.pushed_ids || [];
          this.records = data.records || [];
          this.pushedIds = new Set(ids.map(String));
          for (const r of this.records) {
            if (r && r.id) this.pushedIds.add(String(r.id));
          }
        }
        logger.info(`[HistoryManager] 成功载入 ${this.pushedIds.size} 条历史已推送记录。`);
      } catch (e) {
        logger.error('[HistoryManager] 读取历史记录异常:', e);
      }
    }

    if (this.unattendedPath && fs.existsSync(this.unattendedPath)) {
      try {
        const raw = fs.readFileSync(this.unattendedPath, 'utf-8');
        this.unattendedAlerts = JSON.parse(raw) || [];
      } catch (e) {}
    }

    if (this.fetchPath && fs.existsSync(this.fetchPath)) {
      try {
        const raw = fs.readFileSync(this.fetchPath, 'utf-8');
        this.fetchLocations = JSON.parse(raw) || { last_sync: '', sources: {} };
        this.lastSyncTime = this.fetchLocations.last_sync || '';
      } catch (e) {}
    }
  }

  save() {
    try {
      if (!this.filepath) return;
      const data = {
        version: '2.0',
        updated_at: new Date().toLocaleString('zh-CN', { hour12: false }),
        storage_dir: this.dataDir,
        total_count: this.pushedIds.size,
        pushed_ids: Array.from(this.pushedIds),
        records: this.records
      };
      fs.writeFileSync(this.filepath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.error('[HistoryManager] 保存推送记录失败:', e);
    }
  }

  saveUnattended() {
    try {
      if (!this.unattendedPath) return;
      fs.writeFileSync(this.unattendedPath, JSON.stringify(this.unattendedAlerts, null, 2), 'utf-8');
    } catch (e) {
      logger.error('[HistoryManager] 保存未读快讯失败:', e);
    }
  }

  getStorageStats() {
    return {
      data_dir: this.dataDir,
      log_dir: logger.logDir,
      pushed_count: this.pushedIds.size,
      unattended_count: this.unattendedAlerts.length,
      last_sync_time: this.lastSyncTime || '尚未抓取',
      runtime_log_file: logger.runtimeLogPath,
      error_log_file: logger.errorLogPath,
      fetch_file: this.fetchPath,
      pushed_file: this.filepath,
      unattended_file: this.unattendedPath
    };
  }
}

module.exports = new HistoryManager();
