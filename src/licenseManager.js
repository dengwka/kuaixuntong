/**
 * 快讯通 (SYS00001) - License 软件授权管理服务
 * 对接服务端: https://dengwk.ai.studio
 * 支持在线激活、24小时心跳校验、离线 .lic 验签、弱网离线宽限 (最长7天)、单机设备 MAC 绑定
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { app, net } = require('electron');
const logger = require('./logger');

const LICENSE_API_BASE = 'https://dengwk.ai.studio';
const DEFAULT_APP_TYPE = 'SYS00001';
const DEFAULT_APP_NAME = '快讯通';
const LICENSE_REQUEST_TIMEOUT_MS = 35000;
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24小时心跳
const OFFLINE_GRACE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 弱网宽限期最长7天

class LicenseManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.appType = DEFAULT_APP_TYPE;
    this.appName = DEFAULT_APP_NAME;
    this.heartbeatTimer = null;
    this.state = {
      status: 'unlicensed', // 'unlicensed' | 'checking' | 'valid' | 'grace_offline' | 'expired' | 'invalid'
      isAuthorized: false,
      message: '尚未配置软件授权码（安装与启动可跳过，但执行核心监控前需先激活 License）',
      remainingDays: null,
      expireTime: '',
      appType: this.appType,
      appName: this.appName,
      macAddress: '',
      allMacs: [],
      licenseKey: '',
      lastVerifiedAt: '',
      lastAttemptAt: '',
      channelUsed: '',
      isOfflineGrace: false,
    };

    // 初始化硬件 MAC
    this.macContext = this.collectHardwareMacInfo();
    this.state.macAddress = this.macContext.macAddress;
    this.state.allMacs = this.macContext.allMacs;

    // 从存储恢复并做首次校验
    this.initFromStorage();
  }

  getStoragePath() {
    try {
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'kuaixuntong-license.json');
      }
    } catch (e) {}
    return path.join(os.homedir(), '.kuaixuntong-license.json');
  }

  readSavedRecord() {
    try {
      const p = this.getStoragePath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) {
      logger.warn('[LicenseManager] 读取本地授权缓存异常:', e.message);
    }
    return null;
  }

  saveRecord(record) {
    try {
      const p = this.getStoragePath();
      if (!record) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return true;
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(record, null, 2), 'utf8');
      return true;
    } catch (e) {
      logger.error('[LicenseManager] 写入本地授权文件异常:', e.message);
      return false;
    }
  }

  collectHardwareMacInfo() {
    const interfaces = os.networkInterfaces();
    const candidates = [];
    const virtualPattern = /virtual|vmware|vbox|hyper-v|vethernet|docker|br-|virbr|utun|tun|tap|loopback|teredo|isatap|bluetooth|npcap/i;

    for (const [name, addrs] of Object.entries(interfaces || {})) {
      if (!Array.isArray(addrs)) continue;
      for (const addr of addrs) {
        if (!addr || addr.internal) continue;
        const mac = String(addr.mac || '').trim().toUpperCase();
        if (!mac || mac === '00:00:00:00:00:00') continue;
        const isVirtual = virtualPattern.test(name);
        const isPhysicalName = /^(en0|eth0|wlan0|wi-fi|ethernet|以太网|本地连接|en\d+|eth\d+)/i.test(name);
        candidates.push({
          name,
          mac,
          score: (isPhysicalName ? 10 : 0) + (isVirtual ? -10 : 5) + (addr.family === 'IPv4' ? 2 : 0),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const uniqueMacs = [];
    const seen = new Set();
    for (const c of candidates) {
      if (!seen.has(c.mac)) {
        seen.add(c.mac);
        uniqueMacs.push(c.mac);
      }
    }

    const saved = this.readSavedRecord();
    let primaryMac = (saved && saved.macAddress && uniqueMacs.includes(String(saved.macAddress).toUpperCase()))
      ? String(saved.macAddress).toUpperCase()
      : uniqueMacs[0] || (saved && saved.macAddress ? String(saved.macAddress).toUpperCase() : '');

    if (!primaryMac) {
      const rawSeed = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo() ? os.userInfo().username : 'user'}`;
      const hash = crypto.createHash('sha256').update(rawSeed).digest();
      const bytes = [(hash[0] & 0xfe) | 0x02, hash[1], hash[2], hash[3], hash[4], hash[5]];
      primaryMac = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    }

    return { macAddress: primaryMac, allMacs: uniqueMacs, savedLicense: saved };
  }

  parseExpireTimeMs(expireTime) {
    const raw = String(expireTime || '').trim();
    if (!raw) return null;
    const isoCandidate = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const parsed = Date.parse(isoCandidate);
    if (!Number.isNaN(parsed)) return parsed;
    const fallback = Date.parse(raw);
    return Number.isNaN(fallback) ? null : fallback;
  }

  computeRemainingDays(expireTime, serverRemainingDays) {
    if (typeof serverRemainingDays === 'number' && Number.isFinite(serverRemainingDays)) {
      return Math.max(0, Math.floor(serverRemainingDays));
    }
    const expireMs = this.parseExpireTimeMs(expireTime);
    if (expireMs === null) return null;
    const diff = expireMs - Date.now();
    if (diff <= 0) return 0;
    return Math.max(1, Math.ceil(diff / (24 * 60 * 60 * 1000)));
  }

  initFromStorage() {
    const saved = this.readSavedRecord();
    if (saved && saved.licenseKey) {
      const expireMs = this.parseExpireTimeMs(saved.expireTime);
      const remainingDays = this.computeRemainingDays(saved.expireTime, saved.remainingDays);
      const isPastExpire = expireMs !== null && expireMs <= Date.now();

      if (isPastExpire) {
        this.state = {
          ...this.state,
          status: 'expired',
          isAuthorized: false,
          message: '授权已于 ' + (saved.expireTime || '近期') + ' 过期，请及时续费或更换有效授权码',
          remainingDays: 0,
          expireTime: saved.expireTime || '',
          licenseKey: saved.licenseKey,
          lastVerifiedAt: saved.lastVerifiedAt || '',
          isOfflineGrace: false
        };
      } else {
        // 先以保存的凭证就绪启动（快速启动不阻塞）
        this.state = {
          ...this.state,
          status: 'valid',
          isAuthorized: true,
          message: `心跳校验通过 (可用剩余 ${remainingDays ?? '--'} 天)`,
          remainingDays,
          expireTime: saved.expireTime || '',
          licenseKey: saved.licenseKey,
          lastVerifiedAt: saved.lastVerifiedAt || new Date().toISOString(),
          isOfflineGrace: false
        };

        // 异步静默触发一次心跳校验 (更新剩余天数或离线容错)
        setTimeout(() => {
          this.verifyHeartbeat({ proxyUrl: saved.proxyUrl, silent: true }).catch(() => {});
        }, 3000);
      }
    }

    // 启动 24 小时定期心跳调度
    this.startHeartbeatSchedule();
  }

  startHeartbeatSchedule() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.state.licenseKey && this.state.isAuthorized) {
        logger.info('[LicenseManager] 触发日常 24h 授权心跳校验...');
        this.verifyHeartbeat({ silent: true }).catch(err => {
          logger.warn('[LicenseManager] 24h 定时心跳校验未完成:', err.message);
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * 多通道底层网络请求:
   * 1. 显式代理 (HTTP CONNECT)
   * 2. Electron Chromium net.fetch (自动使用系统代理 / VPN / PAC)
   * 3. Node.js IPv4-first 直接发起 HTTPS 请求兜底
   */
  async requestLicenseApi(endpoint, body, proxyUrl = '', timeoutMs = LICENSE_REQUEST_TIMEOUT_MS) {
    const targetUrl = `${LICENSE_API_BASE}${endpoint}`;
    const bodyStr = JSON.stringify(body || {});
    const effectiveTimeout = Math.max(15000, Math.min(Number(timeoutMs) || LICENSE_REQUEST_TIMEOUT_MS, 60000));
    const errors = [];

    // 通道 1: 显式代理 (HTTP CONNECT)
    const envProxy = proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    if (envProxy && /^https?:\/\//i.test(String(envProxy).trim())) {
      try {
        const res = await this._postViaHttpConnectProxy(targetUrl, bodyStr, String(envProxy).trim(), effectiveTimeout);
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          networkError: false,
          channelUsed: 'proxy-connect',
          data: res.data,
        };
      } catch (err) {
        errors.push(`代理通道: ${err.message}`);
      }
    }

    // 通道 2: Electron Chromium net.fetch (支持 OS VPN / 抓包工具 / 强抗封锁)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        const res = await net.fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Kuaixuntong-License/1.0.0',
          },
          body: bodyStr,
          signal: controller.signal,
        });
        const text = await res.text().catch(() => '');
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
        if (res.status < 500) {
          return {
            ok: res.ok,
            status: res.status,
            networkError: false,
            channelUsed: 'electron-net',
            data,
          };
        }
        errors.push(`系统网络栈: HTTP ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      errors.push(`系统网络栈: ${err.message}`);
    }

    // 通道 3: IPv4-first Node https.request 兜底 (杜绝 IPv6 超时黑洞)
    try {
      const res = await this._postDirectIpv4(targetUrl, bodyStr, effectiveTimeout);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        networkError: res.status >= 500,
        channelUsed: 'node-ipv4',
        data: res.data,
      };
    } catch (err) {
      errors.push(`IPv4直连: ${err.message}`);
    }

    return {
      ok: false,
      status: 0,
      networkError: true,
      data: { message: `连接授权服务器超时或网络不可达 (${errors.join(' | ')})` },
    };
  }

  _postViaHttpConnectProxy(targetUrl, bodyStr, proxyUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const target = new URL(targetUrl);
      const proxy = new URL(proxyUrl);
      const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
      const targetPort = Number(target.port) || 443;
      const authHeader = (proxy.username || proxy.password)
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
        : '';

      let settled = false;
      const finishErr = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const connectReq = http.request({
        host: proxy.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: `${target.hostname}:${targetPort}`,
        headers: {
          Host: `${target.hostname}:${targetPort}`,
          ...(authHeader ? { 'Proxy-Authorization': authHeader } : {}),
        },
        timeout: timeoutMs,
      });

      connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')));
      connectReq.on('error', finishErr);

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return finishErr(new Error(`代理 CONNECT 返回 HTTP ${res.statusCode}`));
        }

        const req = https.request({
          host: target.hostname,
          port: targetPort,
          servername: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          agent: false,
          createConnection: () => tls.connect({ socket, servername: target.hostname }),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Kuaixuntong-License/1.0.0',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
          timeout: timeoutMs,
        }, (apiRes) => {
          let raw = '';
          apiRes.setEncoding('utf8');
          apiRes.on('data', chunk => raw += chunk);
          apiRes.on('end', () => {
            socket.destroy();
            if (!settled) {
              settled = true;
              let data = {};
              try { data = JSON.parse(raw); } catch { data = { raw }; }
              resolve({ status: apiRes.statusCode || 200, data });
            }
          });
        });

        req.on('timeout', () => req.destroy(new Error('经代理请求超时')));
        req.on('error', (err) => { socket.destroy(); finishErr(err); });
        req.write(bodyStr);
        req.end();
      });

      connectReq.end();
    });
  }

  _postDirectIpv4(targetUrl, bodyStr, timeoutMs) {
    return new Promise((resolve, reject) => {
      const target = new URL(targetUrl);
      let settled = false;
      const req = https.request({
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Kuaixuntong-License/1.0.0',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: timeoutMs,
      }, (apiRes) => {
        let raw = '';
        apiRes.setEncoding('utf8');
        apiRes.on('data', chunk => raw += chunk);
        apiRes.on('end', () => {
          if (!settled) {
            settled = true;
            let data = {};
            try { data = JSON.parse(raw); } catch { data = { raw }; }
            resolve({ status: apiRes.statusCode || 200, data });
          }
        });
      });

      req.on('timeout', () => req.destroy(new Error('直连请求超时')));
      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      req.write(bodyStr);
      req.end();
    });
  }

  /**
   * 首次在线激活 (POST /api/activate)
   */
  async activateOnline(payload) {
    let licenseKey = '';
    let proxyUrl = '';
    if (typeof payload === 'string') {
      licenseKey = payload;
    } else if (payload && typeof payload === 'object') {
      licenseKey = payload.licenseKey || payload.key || '';
      proxyUrl = payload.proxyUrl || '';
    }
    const cleanKey = String(licenseKey || '').trim().toUpperCase();
    const macAddress = this.state.macAddress;
    const nowStr = new Date().toISOString();

    if (!cleanKey) {
      return {
        ok: false,
        state: this.state,
        message: '请输入授权码后再点击激活'
      };
    }

    logger.info(`[LicenseManager] 正在向服务器申请激活授权码: "${cleanKey}", MAC: ${macAddress}...`);
    this.state.status = 'checking';

    const res = await this.requestLicenseApi('/api/activate', {
      license_key: cleanKey,
      app_type: this.appType,
      mac_address: macAddress
    }, proxyUrl);

    const body = res.data || {};
    if (res.ok && body.ok) {
      const info = body.data || {};
      const expireTime = info.expire_time || '';
      const remainingDays = this.computeRemainingDays(expireTime, info.remaining_days);

      const record = {
        licenseKey: info.license_key || cleanKey,
        appType: info.app_type || this.appType,
        appName: info.app_name || this.appName,
        macAddress: (info.mac_address || macAddress).toUpperCase(),
        expireTime,
        remainingDays: remainingDays ?? undefined,
        activatedAt: nowStr,
        lastVerifiedAt: nowStr,
        proxyUrl: proxyUrl.trim() || undefined,
        mode: 'online',
      };
      this.saveRecord(record);

      this.state = {
        status: 'valid',
        isAuthorized: true,
        code: body.code || 'ACTIVATED',
        message: body.message || `授权激活成功！可用剩余 ${remainingDays ?? '--'} 天`,
        remainingDays,
        expireTime,
        appType: record.appType,
        appName: record.appName,
        macAddress: record.macAddress,
        allMacs: this.state.allMacs,
        licenseKey: record.licenseKey,
        lastVerifiedAt: nowStr,
        lastAttemptAt: nowStr,
        channelUsed: res.channelUsed,
        isOfflineGrace: false,
      };

      logger.info(`[LicenseManager] ✅ 授权激活成功: 剩余 ${remainingDays} 天, 到期: ${expireTime}`);
      return { ok: true, state: this.state, message: this.state.message };
    }

    // 激活失败
    const errMsg = body.message || (res.networkError ? '无法连接授权验证服务器，请检查网络或配置代理地址后重试' : `激活失败 (HTTP ${res.status})`);
    this.state = {
      ...this.state,
      status: 'invalid',
      isAuthorized: false,
      code: body.code || (res.networkError ? 'NETWORK_ERROR' : 'ACTIVATE_FAILED'),
      message: errMsg,
      lastAttemptAt: nowStr,
      channelUsed: res.channelUsed,
      isOfflineGrace: false,
    };

    logger.warn(`[LicenseManager] ❌ 授权激活失败: ${errMsg}`);
    return { ok: false, state: this.state, message: errMsg };
  }

  /**
   * 启动 / 24h 心跳校验 (POST /api/verify)
   * 具备弱网 7 天容错宽限机制
   */
  async verifyHeartbeat({ proxyUrl = '', silent = false } = {}) {
    const saved = this.readSavedRecord();
    const licenseKey = (saved && saved.licenseKey) || this.state.licenseKey;
    const macAddress = this.state.macAddress;
    const nowStr = new Date().toISOString();

    if (!licenseKey) {
      return { ok: false, state: this.state, message: '尚未激活授权码' };
    }

    if (!silent) this.state.status = 'checking';

    const res = await this.requestLicenseApi('/api/verify', {
      license_key: licenseKey,
      app_type: this.appType,
      mac_address: macAddress
    }, proxyUrl || (saved ? saved.proxyUrl : ''));

    const body = res.data || {};
    if (res.ok && body.ok) {
      const info = body.data || {};
      const expireTime = info.expire_time || (saved && saved.expireTime) || '';
      const remainingDays = this.computeRemainingDays(expireTime, info.remaining_days);

      const record = {
        ...(saved || {}),
        licenseKey,
        expireTime,
        remainingDays: remainingDays ?? undefined,
        lastVerifiedAt: nowStr,
      };
      this.saveRecord(record);

      this.state = {
        ...this.state,
        status: 'valid',
        isAuthorized: true,
        code: body.code || 'VERIFIED',
        message: '心跳校验通过',
        remainingDays,
        expireTime,
        licenseKey,
        lastVerifiedAt: nowStr,
        lastAttemptAt: nowStr,
        channelUsed: res.channelUsed,
        isOfflineGrace: false,
      };
      return { ok: true, state: this.state, message: '心跳校验通过' };
    }

    // 弱网容错机制：如果发生网络错误/连接超时，且原本在有效期内，进入本地宽限期
    if (res.networkError && saved && saved.expireTime) {
      const expireMs = this.parseExpireTimeMs(saved.expireTime);
      const lastVerifiedMs = saved.lastVerifiedAt ? Date.parse(saved.lastVerifiedAt) : Date.now();
      const withinGracePeriod = Date.now() - lastVerifiedMs < OFFLINE_GRACE_MAX_MS;
      const notExpiredYet = expireMs === null || expireMs > Date.now();

      if (withinGracePeriod && notExpiredYet) {
        const remainingDays = this.computeRemainingDays(saved.expireTime, saved.remainingDays);
        this.state = {
          ...this.state,
          status: 'grace_offline',
          isAuthorized: true,
          message: `弱网宽限授权中 (外网暂时离线，剩余 ${remainingDays ?? '--'} 天，最长宽限7天)`,
          remainingDays,
          expireTime: saved.expireTime,
          licenseKey,
          lastAttemptAt: nowStr,
          channelUsed: res.channelUsed,
          isOfflineGrace: true,
        };
        logger.info('[LicenseManager] ⚠️ 外网离线，已进入弱网宽限模式，业务正常使用');
        return { ok: true, state: this.state, message: this.state.message };
      }
    }

    // 明确被服务端拒绝 (如：授权码过期、已被禁用、MAC不匹配)
    const errMsg = body.message || (res.networkError ? '无法连接授权验证服务器' : `校验失败 (${body.code || res.status})`);
    const isExpired = (body.code && /EXPIRED/i.test(body.code)) || (errMsg && errMsg.includes('过期'));

    this.state = {
      ...this.state,
      status: isExpired ? 'expired' : 'invalid',
      isAuthorized: false,
      code: body.code || 'VERIFY_FAILED',
      message: errMsg,
      remainingDays: 0,
      lastAttemptAt: nowStr,
      channelUsed: res.channelUsed,
      isOfflineGrace: false,
    };
    logger.warn(`[LicenseManager] ❌ 心跳校验未通过: ${errMsg}`);
    return { ok: false, state: this.state, message: errMsg };
  }

  /**
   * 离线 .lic 文件验签 (POST /api/verify-offline)
   */
  async verifyOffline({ licJson, proxyUrl = '' }) {
    const macAddress = this.state.macAddress;
    const nowStr = new Date().toISOString();
    const lic = licJson || {};

    if (!lic.license_key || !lic.signature) {
      return { ok: false, state: this.state, message: '无效的 .lic 证书：缺少必要字段' };
    }

    this.state.status = 'checking';

    const res = await this.requestLicenseApi('/api/verify-offline', {
      app_type: this.appType,
      mac_address: macAddress,
      lic
    }, proxyUrl);

    const body = res.data || {};
    if (res.ok && body.ok) {
      const info = body.data || {};
      const expireTime = info.expire_time || String(lic.expire_time || '');
      const remainingDays = this.computeRemainingDays(expireTime, info.remaining_days);

      const record = {
        licenseKey: info.license_key || String(lic.license_key).toUpperCase(),
        appType: this.appType,
        appName: this.appName,
        macAddress: macAddress.toUpperCase(),
        expireTime,
        remainingDays: remainingDays ?? undefined,
        activatedAt: nowStr,
        lastVerifiedAt: nowStr,
        mode: 'offline_lic',
      };
      this.saveRecord(record);

      this.state = {
        status: 'valid',
        isAuthorized: true,
        message: body.message || `离线证书验签成功！可用剩余 ${remainingDays ?? '--'} 天`,
        remainingDays,
        expireTime,
        appType: this.appType,
        appName: this.appName,
        macAddress,
        allMacs: this.state.allMacs,
        licenseKey: record.licenseKey,
        lastVerifiedAt: nowStr,
        lastAttemptAt: nowStr,
        channelUsed: res.channelUsed,
        isOfflineGrace: false,
      };
      return { ok: true, state: this.state, message: this.state.message };
    }

    const errMsg = body.message || '离线证书验签失败';
    this.state = {
      ...this.state,
      status: 'invalid',
      isAuthorized: false,
      message: errMsg,
      lastAttemptAt: nowStr,
      isOfflineGrace: false,
    };
    return { ok: false, state: this.state, message: errMsg };
  }

  /**
   * 清除本地授权凭证
   */
  clearLicense() {
    this.saveRecord(null);
    this.state = {
      status: 'unlicensed',
      isAuthorized: false,
      message: '尚未配置软件授权码（安装与启动可跳过，但执行核心监控前需先激活 License）',
      remainingDays: null,
      expireTime: '',
      appType: this.appType,
      appName: this.appName,
      macAddress: this.macContext.macAddress,
      allMacs: this.macContext.allMacs,
      licenseKey: '',
      lastVerifiedAt: '',
      lastAttemptAt: '',
      channelUsed: '',
      isOfflineGrace: false,
    };
    logger.info('[LicenseManager] 本地 License 授权凭证已清除');
    return { ok: true, state: this.state };
  }

  getState() {
    return { ...this.state };
  }

  getInfo() {
    return {
      macAddress: this.state.macAddress,
      allMacs: this.state.allMacs,
      savedLicense: this.readSavedRecord(),
      state: this.getState()
    };
  }

  isLicenseValid() {
    return this.state.isAuthorized === true;
  }
}

module.exports = LicenseManager;
