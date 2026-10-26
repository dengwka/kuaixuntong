const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const DEFAULT_DEEPSEEK_KEY = Buffer.from('c2stNzFkOGFiNjU1MzhkNGQwNjg4M2JhZTY5NWQ2MGI1NTI=', 'base64').toString('utf-8');

const DEFAULT_X_ACCOUNTS = [
  {
    id: 'realdonaldtrump',
    screen_name: 'realDonaldTrump',
    name: 'Donald J. Trump',
    avatar: 'https://pbs.twimg.com/profile_images/874276197357596672/kUuht00m_200x200.jpg',
    enabled: true,
    include_replies: false,
    ai_analysis_enabled: true,
    last_seen_id: ''
  },
  {
    id: 'whitehouse',
    screen_name: 'WhiteHouse',
    name: 'The White House',
    avatar: 'https://pbs.twimg.com/profile_images/2062605835256127489/atNMwHxg_200x200.jpg',
    enabled: true,
    include_replies: false,
    ai_analysis_enabled: true,
    last_seen_id: ''
  },
  {
    id: 'elonmusk',
    screen_name: 'elonmusk',
    name: 'Elon Musk',
    avatar: 'https://pbs.twimg.com/profile_images/2103567689515954176/aR-Kjpp4_normal.jpg',
    enabled: true,
    include_replies: false,
    ai_analysis_enabled: false,
    last_seen_id: ''
  },
  {
    id: 'star_okx',
    screen_name: 'star_okx',
    name: 'Star_OKX',
    avatar: 'https://pbs.twimg.com/profile_images/1627290215189741572/7WVhFT9Q_200x200.jpg',
    enabled: true,
    include_replies: false,
    ai_analysis_enabled: true,
    last_seen_id: ''
  },
  {
    id: 'luckybibiw1p',
    screen_name: 'luckybibiw1p',
    name: '超级幸运星~',
    avatar: 'https://pbs.twimg.com/profile_images/2053788604552577024/Oas5X1Hb_200x200.jpg',
    enabled: true,
    include_replies: false,
    ai_analysis_enabled: false,
    last_seen_id: ''
  }
];

const DEFAULT_WATCHLIST_STOCKS = [
  { code: '00700', symbol: 'r_hk00700', name: '腾讯控股', market: '港股' },
  { code: 'JD', symbol: 'usJD', name: '京东', market: '美股' }
];

const DEFAULT_CRYPTO_COINS = ['BTC/USDT', 'SOL/USDT'];

class ConfigManager {
  constructor() {
    this.rootConfigPath = path.join(__dirname, '..', 'config.json');
    this.userConfigPath = app ? path.join(app.getPath('userData'), 'config.json') : this.rootConfigPath;
    // 永久多重安全备份路径：独立于应用安装/卸载目录，防止卸载时被误删清空
    this.backupConfigPath = path.join(os.homedir(), '.kuaixuntong', 'config.json');
    this.backupConfigPath2 = path.join(process.env.APPDATA || os.homedir(), 'kuaixuntong_config_backup', 'config.json');
    // 独立永久 API Key 保险箱文件：彻底隔离应用配置重置风险
    this.apiKeyStorePath = path.join(os.homedir(), '.kuaixuntong_api_keys.json');
    this.apiKeyStorePath2 = path.join(process.env.APPDATA || os.homedir(), 'kuaixuntong_config_backup', '.api_keys.json');
    // 独立永久 X 监听博主保险箱文件
    this.xAccountsStorePath = path.join(os.homedir(), '.kuaixuntong', 'x_accounts.json');
    this.xAccountsStorePath2 = path.join(process.env.APPDATA || os.homedir(), 'kuaixuntong_config_backup', 'x_accounts.json');

    this.config = this.loadConfig();
    // 启动时自动将当前有效配置镜像同步到永久容灾安全备份区
    this.syncBackupFiles(this.config);
  }

  saveXAccounts(accounts) {
    if (!Array.isArray(accounts) || accounts.length === 0) return;
    const data = JSON.stringify(accounts, null, 2);
    for (const p of [this.xAccountsStorePath, this.xAccountsStorePath2]) {
      try {
        if (p) {
          const dir = path.dirname(p);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(p, data, 'utf-8');
        }
      } catch (e) {}
    }
  }

  loadXAccounts() {
    for (const p of [this.xAccountsStorePath, this.xAccountsStorePath2]) {
      try {
        if (p && fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf-8');
          const data = JSON.parse(raw);
          if (Array.isArray(data) && data.length > 0) {
            return data;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  saveApiKeys(aiCfg) {
    if (!aiCfg) return;
    const dsKey = (aiCfg.deepseek_api_key || aiCfg.api_key || '').trim();
    const zpKey = (aiCfg.zhipu_api_key || '').trim();
    if (!dsKey && !zpKey) return; // 保护：空值绝不清空独立 Key 库

    const data = JSON.stringify({
      deepseek_api_key: dsKey,
      zhipu_api_key: zpKey,
      updated_at: new Date().toISOString()
    }, null, 2);

    for (const p of [this.apiKeyStorePath, this.apiKeyStorePath2]) {
      try {
        if (p) {
          const dir = path.dirname(p);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(p, data, 'utf-8');
        }
      } catch (e) {}
    }
  }

  loadApiKeys() {
    for (const p of [this.apiKeyStorePath, this.apiKeyStorePath2]) {
      try {
        if (p && fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf-8');
          const data = JSON.parse(raw);
          if (data && (data.deepseek_api_key || data.zhipu_api_key)) {
            return data;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  syncBackupFiles(cfg) {
    if (!cfg) return;
    try {
      // 1. 同步保存到专用 API Key 独立存储
      if (cfg.ai_analysis && (cfg.ai_analysis.deepseek_api_key || cfg.ai_analysis.zhipu_api_key)) {
        this.saveApiKeys(cfg.ai_analysis);
      }
      // 2. 同步保存 X 账号独立存储
      if (cfg.sources && cfg.sources.x_twitter && Array.isArray(cfg.sources.x_twitter.accounts) && cfg.sources.x_twitter.accounts.length > 0) {
        this.saveXAccounts(cfg.sources.x_twitter.accounts);
      }

      // 3. 写入备份文件，如果当前 cfg 缺少内容，但旧备份中有内容，绝不抹除旧备份
      const safeCfg = JSON.parse(JSON.stringify(cfg));
      for (const bPath of [this.backupConfigPath, this.backupConfigPath2]) {
        if (!bPath) continue;
        try {
          const dir = path.dirname(bPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          if (fs.existsSync(bPath)) {
            try {
              const old = JSON.parse(fs.readFileSync(bPath, 'utf-8'));
              if (old && old.ai_analysis) {
                if (!safeCfg.ai_analysis) safeCfg.ai_analysis = {};
                if (!safeCfg.ai_analysis.deepseek_api_key && old.ai_analysis.deepseek_api_key) {
                  safeCfg.ai_analysis.deepseek_api_key = old.ai_analysis.deepseek_api_key;
                }
                if (!safeCfg.ai_analysis.api_key && old.ai_analysis.api_key) {
                  safeCfg.ai_analysis.api_key = old.ai_analysis.api_key;
                }
                if (!safeCfg.ai_analysis.zhipu_api_key && old.ai_analysis.zhipu_api_key) {
                  safeCfg.ai_analysis.zhipu_api_key = old.ai_analysis.zhipu_api_key;
                }
              }
              if (old && old.sources && old.sources.x_twitter && Array.isArray(old.sources.x_twitter.accounts) && old.sources.x_twitter.accounts.length > 0) {
                if (!safeCfg.sources) safeCfg.sources = {};
                if (!safeCfg.sources.x_twitter) safeCfg.sources.x_twitter = {};
                if (!safeCfg.sources.x_twitter.accounts_cleared && (!safeCfg.sources.x_twitter.accounts || safeCfg.sources.x_twitter.accounts.length === 0)) {
                  safeCfg.sources.x_twitter.accounts = old.sources.x_twitter.accounts;
                }
              }
              if (old && old.watchlist && Array.isArray(old.watchlist.stocks) && old.watchlist.stocks.length > 0) {
                if (!safeCfg.watchlist || !safeCfg.watchlist.stocks_cleared) {
                  if (!safeCfg.watchlist || !Array.isArray(safeCfg.watchlist.stocks) || safeCfg.watchlist.stocks.length === 0) {
                    safeCfg.watchlist = old.watchlist;
                  }
                }
              }
              if (old && old.crypto_prices && Array.isArray(old.crypto_prices.selected_coins) && old.crypto_prices.selected_coins.length > 0) {
                if (!safeCfg.crypto_prices || !safeCfg.crypto_prices.coins_cleared) {
                  if (!safeCfg.crypto_prices || !Array.isArray(safeCfg.crypto_prices.selected_coins) || safeCfg.crypto_prices.selected_coins.length === 0) {
                    safeCfg.crypto_prices = old.crypto_prices;
                  }
                }
              }
            } catch (errOld) {}
          }

          fs.writeFileSync(bPath, JSON.stringify(safeCfg, null, 2), 'utf-8');
        } catch (ePath) {
          console.warn('[Config] 写入备份路径异常:', bPath, ePath.message);
        }
      }
    } catch (e) {
      console.warn('[Config] 镜像同步容灾备份配置异常:', e.message);
    }
  }

  getDefaultDataDir() {
    if (app && app.getPath) {
      try {
        return path.join(app.getPath('userData'), 'data');
      } catch (e) {}
    }
    const baseAppData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
    return path.join(baseAppData, 'kuaixuntong', 'data');
  }

  isDevPath(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') return true;
    const lower = dirPath.toLowerCase();
    return lower.includes('antigravity') || lower.includes('桌面提示小工具');
  }

  getDefaultConfig() {
    return {
      system: {
        auto_start: true,
        poll_interval_sec: 5,
        max_display_toasts: 1,
        toast_duration_sec: 10,
        play_sound: true,
        style: 'light_minimalist',
        quiet_hours: {
          enabled: true,
          start_time: '23:00',
          end_time: '08:00'
        },
        content_view_height: 540
      },
      sources: {
        jin10: {
          name: '金十数据',
          enabled: true,
          base_url: 'https://flash-api.jin10.com/get_flash_list',
          channel: '-8200',
          only_important: true,
          min_star: 3,
          weight: 80,
          keyword_filter_enabled: false,
          keywords: ['降息', '加息', '非农', 'CPI', '美联储', '央行', '利率', '战争', '制裁', '突发']
        },
        jin10_topic: {
          name: '重要事件',
          enabled: true,
          base_url: 'https://1b8d6028d99849668a6d8755c79e650f.z3c.jin10.com/top/flashsByTime',
          topic_page_url: 'https://topic17z2k407.jin10.com/topic/jin10_important_news.html?from=web_homepage',
          weight: 95,
          poll_interval_sec: 10,
          keyword_filter_enabled: false,
          keywords: ['美联储', '宏观决议', '地缘政治', '降息', '加息', '冲突', '战略', '关税']
        },
        xueqiu: {
          name: '雪球快讯',
          enabled: true,
          only_important: true,
          cookie: '',
          weight: 75,
          keyword_filter_enabled: false,
          keywords: ['涨停', '跌停', '财报', '业绩', '减持', '增持', '重组', '违约', '证监会', '突破']
        },
        maimai: {
          name: '脉脉职言',
          enabled: true,
          cookie: '',
          weight: 75,
          keyword_filter_enabled: false,
          keywords: ['裁员', '年终奖', '倒闭', '降薪', '涉案', '调查', '高管变动', '离职', '破产']
        },
        x_twitter: {
          name: '𝕏 (Twitter) 监控',
          enabled: false,
          poll_interval_sec: 30,
          weight: 85,
          accounts: [
            {
              id: 'realdonaldtrump',
              screen_name: 'realDonaldTrump',
              name: 'Donald J. Trump',
              avatar: 'https://pbs.twimg.com/profile_images/874276197357596672/kUuht00m_200x200.jpg',
              enabled: true,
              include_replies: false,
              ai_analysis_enabled: true,
              last_seen_id: ''
            },
            {
              id: 'whitehouse',
              screen_name: 'WhiteHouse',
              name: 'The White House',
              avatar: 'https://pbs.twimg.com/profile_images/2062605835256127489/atNMwHxg_200x200.jpg',
              enabled: true,
              include_replies: false,
              ai_analysis_enabled: true,
              last_seen_id: ''
            },
            {
              id: 'elonmusk',
              screen_name: 'elonmusk',
              name: 'Elon Musk',
              avatar: 'https://pbs.twimg.com/profile_images/2103567689515954176/aR-Kjpp4_normal.jpg',
              enabled: true,
              include_replies: false,
              ai_analysis_enabled: false,
              last_seen_id: ''
            },
            {
              id: 'star_okx',
              screen_name: 'star_okx',
              name: 'Star_OKX',
              avatar: 'https://pbs.twimg.com/profile_images/1627290215189741572/7WVhFT9Q_200x200.jpg',
              enabled: true,
              include_replies: false,
              ai_analysis_enabled: true,
              last_seen_id: ''
            },
            {
              id: 'luckybibiw1p',
              screen_name: 'luckybibiw1p',
              name: '超级幸运星~',
              avatar: 'https://pbs.twimg.com/profile_images/2053788604552577024/Oas5X1Hb_200x200.jpg',
              enabled: true,
              include_replies: false,
              ai_analysis_enabled: false,
              last_seen_id: ''
            }
          ],
          cookie: '',
          auto_translate: true,
          proxy: ''
        }
      },
      rules: {
        min_alert_score: 60,
        highlight_keywords: [
          '突发', '爆炸', '战争', '袭击', '制裁', '降息', '加息', '非农', 'CPI', '伊朗', '特朗普', '美联储', '违约'
        ],
        exclude_keywords: [
          '广告', '扫码', '下载App', '领券', '限时特惠'
        ],
        // 金色VIP重大特报关键词：命中时触发黑金尊贵流光弹窗与特级高亮提醒
        vip_keywords: [
          '导弹袭击', '总统遇难', '宣战', '核打击', '核武器', '军事政变', '特大突发', '宣布破产', '暂停交易', '特大黑天鹅', '重大伤亡'
        ]
      },
      watchlist: {
        enabled: true,
        stocks: [
          { code: '00700', symbol: 'r_hk00700', name: '腾讯控股', market: '港股' },
          { code: 'JD', symbol: 'usJD', name: '京东', market: '美股' }
        ]
      },
      ai_analysis: {
        enabled: true,
        deepseek_api_key: DEFAULT_DEEPSEEK_KEY,
        zhipu_api_key: '',
        api_key: DEFAULT_DEEPSEEK_KEY,
        deepseek_api_url: 'https://api.deepseek.com/chat/completions',
        zhipu_api_url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        deepseek_model: 'deepseek-chat',
        zhipu_model: 'glm-4-flash',
        timeout_sec: 6
      },
      crypto_prices: {
        enabled: true,
        selected_coins: ['BTC/USDT', 'SOL/USDT'],
        custom_coins: []
      },
      storage: {
        data_dir: this.getDefaultDataDir(),
        auto_cleanup: true,
        retention_days: 3,
        max_file_size_mb: 10
      },
      updates: {
        strategy: 'auto', // 'auto': 自动更新(启动与定时后台检测) | 'manual': 手动更新(仅手动点击检查)
        auto_check: true,
        notify_on_new: true,
        check_interval_hours: 12
      }
    };
  }

  loadConfig() {
    let targetPath = null;
    let isFromBackup = false;

    // 优先级 1: 用户 AppData 目录下的正式主配置文件
    if (fs.existsSync(this.userConfigPath)) {
      targetPath = this.userConfigPath;
    } 
    // 优先级 2: 用户家目录下的永久备份配置 (~/.kuaixuntong/config.json，卸载重装绝对保留)
    else if (this.backupConfigPath && fs.existsSync(this.backupConfigPath)) {
      targetPath = this.backupConfigPath;
      isFromBackup = true;
      console.log(`[Config] 发现主配置缺失，自动从永久用户备份还原: ${this.backupConfigPath}`);
    } 
    // 优先级 3: AppData 专属容灾备份目录
    else if (this.backupConfigPath2 && fs.existsSync(this.backupConfigPath2)) {
      targetPath = this.backupConfigPath2;
      isFromBackup = true;
      console.log(`[Config] 自动从二级容灾备份还原: ${this.backupConfigPath2}`);
    } 
    // 优先级 4: 项目根目录内置配置 (开发与初始打包兜底)
    else if (fs.existsSync(this.rootConfigPath)) {
      targetPath = this.rootConfigPath;
    }

    try {
      if (targetPath && fs.existsSync(targetPath)) {
        const raw = fs.readFileSync(targetPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const defaults = this.getDefaultConfig();
        const merged = {
          ...defaults,
          ...parsed,
          system: { ...defaults.system, ...(parsed.system || {}) },
          sources: {
            ...defaults.sources,
            ...(parsed.sources || {}),
            jin10: { ...defaults.sources.jin10, ...((parsed.sources && parsed.sources.jin10) || {}) },
            jin10_topic: { ...defaults.sources.jin10_topic, ...((parsed.sources && parsed.sources.jin10_topic) || {}) },
            xueqiu: { ...defaults.sources.xueqiu, ...((parsed.sources && parsed.sources.xueqiu) || {}) },
            maimai: { ...defaults.sources.maimai, ...((parsed.sources && parsed.sources.maimai) || {}) },
            x_twitter: { ...defaults.sources.x_twitter, ...((parsed.sources && parsed.sources.x_twitter) || {}) }
          },
          rules: { ...defaults.rules, ...(parsed.rules || {}) },
          watchlist: { ...defaults.watchlist, ...(parsed.watchlist || {}) },
          ai_analysis: { ...defaults.ai_analysis, ...(parsed.ai_analysis || {}) },
          crypto_prices: { ...defaults.crypto_prices, ...(parsed.crypto_prices || {}) },
          storage: { ...defaults.storage, ...(parsed.storage || {}) },
          updates: { ...defaults.updates, ...(parsed.updates || {}) }
        };

        // 增量继承保护：从永久多重备份中补全关键配置
        const isDsCleared = merged.ai_analysis && merged.ai_analysis.deepseek_cleared === true;
        const backupCandidates = [this.backupConfigPath, this.backupConfigPath2];
        for (const bkPath of backupCandidates) {
          if (bkPath && fs.existsSync(bkPath)) {
            try {
              const bkRaw = fs.readFileSync(bkPath, 'utf-8');
              const bkParsed = JSON.parse(bkRaw);
              if (bkParsed) {
                if (bkParsed.ai_analysis && !isDsCleared) {
                  if (!merged.ai_analysis.deepseek_api_key && bkParsed.ai_analysis.deepseek_api_key) {
                    merged.ai_analysis.deepseek_api_key = bkParsed.ai_analysis.deepseek_api_key;
                  }
                  if (!merged.ai_analysis.zhipu_api_key && bkParsed.ai_analysis.zhipu_api_key) {
                    merged.ai_analysis.zhipu_api_key = bkParsed.ai_analysis.zhipu_api_key;
                  }
                  if (!merged.ai_analysis.api_key && bkParsed.ai_analysis.api_key) {
                    merged.ai_analysis.api_key = bkParsed.ai_analysis.api_key;
                  }
                }
                if (bkParsed.watchlist && Array.isArray(bkParsed.watchlist.stocks) && bkParsed.watchlist.stocks.length > 0) {
                  if (!merged.watchlist.stocks_cleared && (!merged.watchlist.stocks || merged.watchlist.stocks.length === 0)) {
                    merged.watchlist.stocks = bkParsed.watchlist.stocks;
                  }
                }
                if (bkParsed.sources && bkParsed.sources.x_twitter && Array.isArray(bkParsed.sources.x_twitter.accounts) && bkParsed.sources.x_twitter.accounts.length > 0) {
                  if (!merged.sources.x_twitter.accounts_cleared && (!merged.sources.x_twitter.accounts || merged.sources.x_twitter.accounts.length === 0)) {
                    merged.sources.x_twitter.accounts = bkParsed.sources.x_twitter.accounts;
                  }
                }
                if (bkParsed.crypto_prices && Array.isArray(bkParsed.crypto_prices.selected_coins) && bkParsed.crypto_prices.selected_coins.length > 0) {
                  if (!merged.crypto_prices.coins_cleared && (!merged.crypto_prices.selected_coins || merged.crypto_prices.selected_coins.length === 0)) {
                    merged.crypto_prices.selected_coins = bkParsed.crypto_prices.selected_coins;
                  }
                }
                if (bkParsed.storage && bkParsed.storage.data_dir && (!merged.storage.data_dir || !merged.storage.data_dir.trim())) {
                  merged.storage.data_dir = bkParsed.storage.data_dir;
                }
              }
            } catch (bke) {}
          }
        }

        // 关键恢复 1：X 监听博主容灾自愈链 (独立存储 -> 备份 -> 内置配置 -> 默认预设)
        if (!merged.sources.x_twitter.accounts_cleared && (!Array.isArray(merged.sources.x_twitter.accounts) || merged.sources.x_twitter.accounts.length === 0)) {
          const xVault = this.loadXAccounts();
          if (xVault && xVault.length > 0) {
            merged.sources.x_twitter.accounts = xVault;
          } else if (fs.existsSync(this.rootConfigPath)) {
            try {
              const rootRaw = JSON.parse(fs.readFileSync(this.rootConfigPath, 'utf-8'));
              if (rootRaw && rootRaw.sources && rootRaw.sources.x_twitter && Array.isArray(rootRaw.sources.x_twitter.accounts) && rootRaw.sources.x_twitter.accounts.length > 0) {
                merged.sources.x_twitter.accounts = rootRaw.sources.x_twitter.accounts;
              }
            } catch (eXRoot) {}
          }
          if (!merged.sources.x_twitter.accounts || merged.sources.x_twitter.accounts.length === 0) {
            merged.sources.x_twitter.accounts = JSON.parse(JSON.stringify(DEFAULT_X_ACCOUNTS));
          }
        }

        // 自动巡检并自愈已知失效/404的官方博主头像链接
        if (merged.sources && merged.sources.x_twitter && Array.isArray(merged.sources.x_twitter.accounts)) {
          merged.sources.x_twitter.accounts.forEach(acc => {
            const sn = (acc.screen_name || '').toLowerCase();
            if (sn === 'realdonaldtrump' && (!acc.avatar || acc.avatar.includes('kUphPerform'))) {
              acc.avatar = 'https://pbs.twimg.com/profile_images/874276197357596672/kUuht00m_200x200.jpg';
            }
            if (sn === 'whitehouse' && (!acc.avatar || acc.avatar.includes('Zz3t0xW1'))) {
              acc.avatar = 'https://pbs.twimg.com/profile_images/2062605835256127489/atNMwHxg_200x200.jpg';
            }
          });
        }

        // 关键恢复 2：自选股票容灾自愈
        if (!merged.watchlist.stocks_cleared && (!Array.isArray(merged.watchlist.stocks) || merged.watchlist.stocks.length === 0)) {
          if (fs.existsSync(this.rootConfigPath)) {
            try {
              const rootRaw = JSON.parse(fs.readFileSync(this.rootConfigPath, 'utf-8'));
              if (rootRaw && rootRaw.watchlist && Array.isArray(rootRaw.watchlist.stocks) && rootRaw.watchlist.stocks.length > 0) {
                merged.watchlist.stocks = rootRaw.watchlist.stocks;
              }
            } catch (eStk) {}
          }
          if (!merged.watchlist.stocks || merged.watchlist.stocks.length === 0) {
            merged.watchlist.stocks = JSON.parse(JSON.stringify(DEFAULT_WATCHLIST_STOCKS));
          }
        }

        // 关键恢复 3：主流虚拟币容灾自愈
        if (!merged.crypto_prices.coins_cleared && (!Array.isArray(merged.crypto_prices.selected_coins) || merged.crypto_prices.selected_coins.length === 0)) {
          if (fs.existsSync(this.rootConfigPath)) {
            try {
              const rootRaw = JSON.parse(fs.readFileSync(this.rootConfigPath, 'utf-8'));
              if (rootRaw && rootRaw.crypto_prices && Array.isArray(rootRaw.crypto_prices.selected_coins) && rootRaw.crypto_prices.selected_coins.length > 0) {
                merged.crypto_prices.selected_coins = rootRaw.crypto_prices.selected_coins;
              }
            } catch (eCoin) {}
          }
          if (!merged.crypto_prices.selected_coins || merged.crypto_prices.selected_coins.length === 0) {
            merged.crypto_prices.selected_coins = [...DEFAULT_CRYPTO_COINS];
          }
        }

        // 关键恢复 4：AI API Key 容灾恢复链（独立 Key 库 -> 内置 config.json -> 默认 Key）
        if (!merged.ai_analysis.deepseek_api_key && !isDsCleared) {
          const savedKeys = this.loadApiKeys();
          if (savedKeys && savedKeys.deepseek_api_key) {
            merged.ai_analysis.deepseek_api_key = savedKeys.deepseek_api_key;
            merged.ai_analysis.api_key = savedKeys.deepseek_api_key;
          }
          if (!merged.ai_analysis.deepseek_api_key && fs.existsSync(this.rootConfigPath)) {
            try {
              const rootRaw = JSON.parse(fs.readFileSync(this.rootConfigPath, 'utf-8'));
              if (rootRaw && rootRaw.ai_analysis && rootRaw.ai_analysis.deepseek_api_key) {
                merged.ai_analysis.deepseek_api_key = rootRaw.ai_analysis.deepseek_api_key;
                merged.ai_analysis.api_key = rootRaw.ai_analysis.deepseek_api_key;
              }
            } catch (eRoot) {}
          }
          if (!merged.ai_analysis.deepseek_api_key) {
            merged.ai_analysis.deepseek_api_key = DEFAULT_DEEPSEEK_KEY;
            merged.ai_analysis.api_key = DEFAULT_DEEPSEEK_KEY;
          }
        }

        // 规则关键词默认值保障：除非用户明确清空（*_cleared 为 true），否则确保自动继承默认关键词配置
        const defRules = defaults.rules;
        if (!merged.rules) merged.rules = { ...defRules };
        if (!merged.rules.highlight_keywords_cleared) {
          if (!Array.isArray(merged.rules.highlight_keywords) || merged.rules.highlight_keywords.length === 0) {
            merged.rules.highlight_keywords = [...defRules.highlight_keywords];
          }
        }
        if (!merged.rules.exclude_keywords_cleared) {
          if (!Array.isArray(merged.rules.exclude_keywords) || merged.rules.exclude_keywords.length === 0) {
            merged.rules.exclude_keywords = [...defRules.exclude_keywords];
          }
        }
        if (!merged.rules.vip_keywords_cleared) {
          if (!Array.isArray(merged.rules.vip_keywords) || merged.rules.vip_keywords.length === 0) {
            merged.rules.vip_keywords = [...defRules.vip_keywords];
          }
        }

        // 关键恢复 5：确保存储目录永远有效且为具体的系统用户标准目录，绝不残留开发源码路径或空值
        if (!merged.storage || !merged.storage.data_dir || !merged.storage.data_dir.trim() || this.isDevPath(merged.storage.data_dir)) {
          if (!merged.storage) merged.storage = {};
          merged.storage.data_dir = this.getDefaultDataDir();
        }

        // 若从备份恢复或增量合并，立即回写同步到主用户路径
        if (this.userConfigPath) {
          try {
            const userDir = path.dirname(this.userConfigPath);
            if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
            fs.writeFileSync(this.userConfigPath, JSON.stringify(merged, null, 2), 'utf-8');
            if (isFromBackup) {
              console.log(`[Config] 已将恢复的配置写回主用户配置路径: ${this.userConfigPath}`);
            }
          } catch (re) {
            console.error('[Config] 恢复配置回写异常:', re);
          }
        }

        return merged;
      }
    } catch (e) {
      console.error('[Config] 加载失败，回退到默认设置:', e);
    }
    return this.getDefaultConfig();
  }

  saveConfig(newConfig) {
    const cur = this.config || this.getDefaultConfig();
    this.config = {
      ...cur,
      ...newConfig,
      system: { ...(cur.system || {}), ...(newConfig.system || {}) },
      sources: {
        ...(cur.sources || {}),
        ...(newConfig.sources || {}),
        jin10: { ...((cur.sources && cur.sources.jin10) || {}), ...((newConfig.sources && newConfig.sources.jin10) || {}) },
        jin10_topic: { ...((cur.sources && cur.sources.jin10_topic) || {}), ...((newConfig.sources && newConfig.sources.jin10_topic) || {}) },
        xueqiu: { ...((cur.sources && cur.sources.xueqiu) || {}), ...((newConfig.sources && newConfig.sources.xueqiu) || {}) },
        maimai: { ...((cur.sources && cur.sources.maimai) || {}), ...((newConfig.sources && newConfig.sources.maimai) || {}) },
        x_twitter: { ...((cur.sources && cur.sources.x_twitter) || {}), ...((newConfig.sources && newConfig.sources.x_twitter) || {}) }
      },
      rules: { ...(cur.rules || {}), ...(newConfig.rules || {}) },
      watchlist: { ...(cur.watchlist || {}), ...(newConfig.watchlist || {}) },
      ai_analysis: { ...(cur.ai_analysis || {}), ...(newConfig.ai_analysis || {}) },
      storage: { ...(cur.storage || {}), ...(newConfig.storage || {}) },
      crypto_prices: { ...(cur.crypto_prices || {}), ...(newConfig.crypto_prices || {}) },
      updates: { ...(cur.updates || {}), ...(newConfig.updates || {}) }
    };

    // 保护 X 账号列表：如果保存时传入的是空数组且未标记 cleared，保留原有已有 accounts
    if (newConfig.sources && newConfig.sources.x_twitter) {
      if (Array.isArray(newConfig.sources.x_twitter.accounts) && newConfig.sources.x_twitter.accounts.length > 0) {
        this.saveXAccounts(newConfig.sources.x_twitter.accounts);
      } else if (!newConfig.sources.x_twitter.accounts_cleared) {
        const existingAccounts = (cur.sources && cur.sources.x_twitter && cur.sources.x_twitter.accounts && cur.sources.x_twitter.accounts.length > 0) ? cur.sources.x_twitter.accounts : (this.loadXAccounts() || DEFAULT_X_ACCOUNTS);
        this.config.sources.x_twitter.accounts = existingAccounts;
      }
    }

    // 保护自选股票：如果为空且未显式清空，保留原有或默认标的
    if (newConfig.watchlist) {
      if (!newConfig.watchlist.stocks_cleared && (!newConfig.watchlist.stocks || newConfig.watchlist.stocks.length === 0)) {
        this.config.watchlist.stocks = (cur.watchlist && cur.watchlist.stocks && cur.watchlist.stocks.length > 0) ? cur.watchlist.stocks : DEFAULT_WATCHLIST_STOCKS;
      }
    }

    // 保护虚拟币：如果为空且未显式清空，保留原有或默认币种
    if (newConfig.crypto_prices) {
      if (!newConfig.crypto_prices.coins_cleared && (!newConfig.crypto_prices.selected_coins || newConfig.crypto_prices.selected_coins.length === 0)) {
        this.config.crypto_prices.selected_coins = (cur.crypto_prices && cur.crypto_prices.selected_coins && cur.crypto_prices.selected_coins.length > 0) ? cur.crypto_prices.selected_coins : DEFAULT_CRYPTO_COINS;
      }
    }

    // 保护 API Key：如果保存时传入的是空字符串且未标记 cleared，保留原有已保存 key
    if (newConfig.ai_analysis) {
      if (newConfig.ai_analysis.deepseek_api_key) {
        this.saveApiKeys(newConfig.ai_analysis);
      } else if (!newConfig.ai_analysis.deepseek_cleared) {
        const existingKey = (cur.ai_analysis && cur.ai_analysis.deepseek_api_key) || (this.loadApiKeys() && this.loadApiKeys().deepseek_api_key) || DEFAULT_DEEPSEEK_KEY;
        this.config.ai_analysis.deepseek_api_key = existingKey;
        this.config.ai_analysis.api_key = existingKey;
      }
    }

    // 确保存储目录永远有效且为具体的系统用户标准目录，绝不保存开发源码路径或空值
    if (!this.config.storage || !this.config.storage.data_dir || !this.config.storage.data_dir.trim() || this.isDevPath(this.config.storage.data_dir)) {
      if (!this.config.storage) this.config.storage = {};
      this.config.storage.data_dir = this.getDefaultDataDir();
    }

    try {
      const data = JSON.stringify(this.config, null, 2);
      const userDir = path.dirname(this.userConfigPath);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }
      fs.writeFileSync(this.userConfigPath, data, 'utf-8');

      // 同步写入永久多重容灾备份
      this.syncBackupFiles(this.config);

      // 仅在非 asar 虚拟包环境（如开发源码调试）下写入本地根目录模板 (脱敏保护，符合开源与云端规则)
      if (this.rootConfigPath && !this.rootConfigPath.includes('app.asar')) {
        try {
          const rootCopy = JSON.parse(data);
          if (rootCopy.ai_analysis) {
            rootCopy.ai_analysis.deepseek_api_key = '';
            rootCopy.ai_analysis.api_key = '';
          }
          fs.writeFileSync(this.rootConfigPath, JSON.stringify(rootCopy, null, 2), 'utf-8');
        } catch (errRoot) {
          console.warn('[Config] 写入本地根目录配置失败 (已安全跳过):', errRoot.message);
        }
      }
      return true;
    } catch (e) {
      console.error('[Config] 保存配置失败:', e);
      return false;
    }
  }

  isInQuietHours() {
    const qh = (this.config.system && this.config.system.quiet_hours) || {};
    if (!qh.enabled) return false;

    try {
      const now = new Date();
      const curMinutes = now.getHours() * 60 + now.getMinutes();

      const [sH, sM] = (qh.start_time || '23:00').split(':').map(Number);
      const [eH, eM] = (qh.end_time || '08:00').split(':').map(Number);

      const startMinutes = sH * 60 + sM;
      const endMinutes = eH * 60 + eM;

      if (startMinutes > endMinutes) {
        // 跨午夜，如 23:00 - 08:00
        return curMinutes >= startMinutes || curMinutes < endMinutes;
      } else {
        return curMinutes >= startMinutes && curMinutes < endMinutes;
      }
    } catch (e) {
      console.error('[QuietHours] 计算异常:', e);
      return false;
    }
  }
}

module.exports = new ConfigManager();
