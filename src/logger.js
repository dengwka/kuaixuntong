const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
  constructor() {
    this.logDir = '';
    this.runtimeLogPath = '';
    this.errorLogPath = '';
    this.initDefaultDir();
  }

  getDefaultLogDir() {
    if (app && app.getPath) {
      try {
        return path.join(app.getPath('userData'), 'log');
      } catch (e) {}
    }
    const os = require('os');
    const baseAppData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
    return path.join(baseAppData, 'kuaixuntong', 'log');
  }

  initDefaultDir() {
    this.setLogDir(this.getDefaultLogDir());
  }

  setLogDir(targetDir) {
    if (!targetDir) return;
    let safeDir = String(targetDir);
    if (safeDir.includes('antigravity') || safeDir.includes('桌面提示小工具')) {
      safeDir = this.getDefaultLogDir();
    }
    this.logDir = path.resolve(safeDir);
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      this.runtimeLogPath = path.join(this.logDir, 'app_runtime.log');
      this.errorLogPath = path.join(this.logDir, 'app_error.log');
    } catch (e) {
      // 容错
    }
  }

  formatMessage(level, msg) {
    const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const formatted = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : String(msg);
    return `[${timeStr}] [${level}] ${formatted}\n`;
  }

  info(...args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.log(msg);
    this.appendToFile(this.runtimeLogPath, this.formatMessage('INFO', msg));
  }

  warn(...args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    console.warn(msg);
    this.appendToFile(this.runtimeLogPath, this.formatMessage('WARN', msg));
    this.appendToFile(this.errorLogPath, this.formatMessage('WARN', msg));
  }

  error(...args) {
    const msg = args.map(a => (a && a.stack ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
    console.error(msg);
    this.appendToFile(this.runtimeLogPath, this.formatMessage('ERROR', msg));
    this.appendToFile(this.errorLogPath, this.formatMessage('ERROR', msg));
  }

  appendToFile(filepath, text) {
    if (!filepath) return;
    try {
      fs.appendFileSync(filepath, text, 'utf-8');
    } catch (e) {}
  }

  setupGlobalHandlers() {
    process.on('uncaughtException', (err) => {
      this.error('[UncaughtException] 主进程未捕获异常:', err);
    });

    process.on('unhandledRejection', (reason) => {
      this.error('[UnhandledRejection] 异步Promise未捕获拒绝:', reason);
    });

    this.info(`[Logger] 运行日志系统就绪，日志目录: ${this.logDir}`);
  }
}

module.exports = new Logger();
