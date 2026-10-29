/**
 * 快讯通 - 数据源存活与健康诊断管理中心 (P0 核心引擎)
 * 实时监测各数据源 API 连通性、网络延迟、最近同步时间、错误状态与全局网络质量
 */
const { net } = require('electron');
const logger = require('./logger');

class SourceHealthManager {
  constructor() {
    this.network = {
      isOnline: true,
      pingMs: 0,
      lastCheckTime: '--',
      dnsOk: true,
      errorMsg: null
    };

    this.sources = {
      jin10: {
        key: 'jin10',
        name: '金十快讯',
        icon: '⚡',
        status: 'idle', // 'idle' | 'fetching' | 'ok' | 'error' | 'disabled'
        latencyMs: 0,
        lastSyncTime: '--',
        lastCount: 0,
        totalSuccess: 0,
        totalFailures: 0,
        errorMsg: null,
        apiUrl: 'https://flash-api.jin10.com'
      },
      jin10_topic: {
        key: 'jin10_topic',
        name: '重要事件',
        icon: '🔥',
        status: 'idle',
        latencyMs: 0,
        lastSyncTime: '--',
        lastCount: 0,
        totalSuccess: 0,
        totalFailures: 0,
        errorMsg: null,
        apiUrl: 'https://*.z3c.jin10.com'
      },
      xueqiu: {
        key: 'xueqiu',
        name: '雪球快讯',
        icon: '❄️',
        status: 'idle',
        latencyMs: 0,
        lastSyncTime: '--',
        lastCount: 0,
        totalSuccess: 0,
        totalFailures: 0,
        errorMsg: null,
        apiUrl: 'https://xueqiu.com'
      },
      x_twitter: {
        key: 'x_twitter',
        name: '𝕏 顶流关注',
        icon: '𝕏',
        status: 'idle',
        latencyMs: 0,
        lastSyncTime: '--',
        lastCount: 0,
        totalSuccess: 0,
        totalFailures: 0,
        errorMsg: null,
        apiUrl: 'https://cdn.syndication.twimg.com'
      },
      maimai: {
        key: 'maimai',
        name: '脉脉职言',
        icon: '💼',
        status: 'idle',
        latencyMs: 0,
        lastSyncTime: '--',
        lastCount: 0,
        totalSuccess: 0,
        totalFailures: 0,
        errorMsg: null,
        apiUrl: 'https://maimai.cn / 36kr'
      },
      local_gov: {
        key: 'local_gov',
        name: '本地周边',
        icon: '📍',
        status: 'idle',
        latencyMs: 0,
        lastSyncTime: '--',
        lastCount: 0,
        totalSuccess: 0,
        totalFailures: 0,
        errorMsg: null,
        apiUrl: 'wzapi.rednet.cn / zygh.changsha.gov.cn'
      }
    };

    this.totalPollCycles = 0;
    this.lastPollTime = '--';
    this.onStatusChanged = null;
    this.configProvider = null;

    // 启动时先行探测一次基础网络连通性
    this.checkNetworkHealth().catch(() => {});
  }

  setConfigProvider(fn) {
    this.configProvider = fn;
  }

  notifyChanged() {
    if (typeof this.onStatusChanged === 'function') {
      try {
        const cfg = typeof this.configProvider === 'function' ? this.configProvider() : null;
        this.onStatusChanged(this.getHealthReport(cfg));
      } catch (e) {}
    }
  }

  async checkNetworkHealth() {
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch('https://www.baidu.com', {
        method: 'HEAD',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      this.network.isOnline = res.ok;
      this.network.pingMs = Date.now() - t0;
      this.network.lastCheckTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.network.dnsOk = true;
      this.network.errorMsg = null;
    } catch (e) {
      this.network.isOnline = false;
      this.network.pingMs = Date.now() - t0;
      this.network.lastCheckTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.network.errorMsg = e.message || '网络连接异常断开';
    }
    this.notifyChanged();
    return this.network;
  }

  markFetching(sourceKey) {
    if (this.sources[sourceKey]) {
      this.sources[sourceKey].status = 'fetching';
      this.notifyChanged();
    }
  }

  markDisabled(sourceKey) {
    if (this.sources[sourceKey]) {
      this.sources[sourceKey].status = 'disabled';
      this.notifyChanged();
    }
  }

  recordSuccess(sourceKey, latencyMs, count = 0) {
    const s = this.sources[sourceKey];
    if (!s) return;
    s.status = 'ok';
    s.latencyMs = latencyMs;
    s.lastSyncTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    s.lastCount = count;
    s.totalSuccess = (s.totalSuccess || 0) + 1;
    s.errorMsg = null;
    this.notifyChanged();
  }

  recordError(sourceKey, latencyMs, errorMsg) {
    const s = this.sources[sourceKey];
    if (!s) return;
    s.status = 'error';
    s.latencyMs = latencyMs;
    s.lastSyncTime = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    s.totalFailures = (s.totalFailures || 0) + 1;
    s.errorMsg = errorMsg || '接口连接异常';
    this.notifyChanged();
  }

  /**
   * 生成当前完整的健康报告 (结合用户配置的 enabled 状态)
   */
  getHealthReport(config) {
    const cfg = config || (typeof this.configProvider === 'function' ? this.configProvider() : null);
    const cfgSources = (cfg && cfg.sources) || {};

    const sourceReports = Object.values(this.sources).map(s => {
      const conf = cfgSources[s.key] || {};
      const isEnabled = s.key === 'x_twitter' ? (conf.enabled === true) : (conf.enabled !== false);
      let displayStatus = s.status;
      if (!isEnabled) {
        displayStatus = 'disabled';
      } else if (!this.network.isOnline) {
        displayStatus = 'offline';
      }

      return {
        ...s,
        enabled: isEnabled,
        status: displayStatus
      };
    });

    const enabledCount = sourceReports.filter(s => s.enabled).length;

    return {
      network: { ...this.network },
      sources: sourceReports,
      enabledCount,
      totalSourcesCount: sourceReports.length,
      totalPollCycles: this.totalPollCycles,
      lastPollTime: this.lastPollTime
    };
  }
}

module.exports = new SourceHealthManager();
