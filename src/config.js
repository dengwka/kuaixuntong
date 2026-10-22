const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ConfigManager {
  constructor() {
    this.rootConfigPath = path.join(__dirname, '..', 'config.json');
    this.userConfigPath = app ? path.join(app.getPath('userData'), 'config.json') : this.rootConfigPath;
    this.config = this.loadConfig();
  }

  getDefaultDataDir() {
    if (app) {
      return path.join(app.getPath('userData'), 'data');
    }
    return path.resolve(__dirname, '..', 'data');
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
        content_view_height: 520
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
              avatar: 'https://pbs.twimg.com/profile_images/874276197357596672/kUphPerform_200x200.jpg',
              enabled: true,
              include_replies: false,
              ai_analysis_enabled: true,
              last_seen_id: ''
            },
            {
              id: 'whitehouse',
              screen_name: 'WhiteHouse',
              name: 'The White House',
              avatar: 'https://pbs.twimg.com/profile_images/1349887752674394112/Zz3t0xW1_200x200.jpg',
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
        ]
      },
      ai_analysis: {
        enabled: true,
        deepseek_api_key: '',
        zhipu_api_key: '',
        api_key: '',
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
    let targetPath = this.rootConfigPath;
    if (fs.existsSync(this.userConfigPath)) {
      targetPath = this.userConfigPath;
    } else if (fs.existsSync(this.rootConfigPath)) {
      targetPath = this.rootConfigPath;
    }

    try {
      if (fs.existsSync(targetPath)) {
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
          ai_analysis: { ...defaults.ai_analysis, ...(parsed.ai_analysis || {}) },
          crypto_prices: { ...defaults.crypto_prices, ...(parsed.crypto_prices || {}) },
          storage: { ...defaults.storage, ...(parsed.storage || {}) },
          updates: { ...defaults.updates, ...(parsed.updates || {}) }
        };
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
      ai_analysis: { ...(cur.ai_analysis || {}), ...(newConfig.ai_analysis || {}) },
      storage: { ...(cur.storage || {}), ...(newConfig.storage || {}) },
      crypto_prices: { ...(cur.crypto_prices || {}), ...(newConfig.crypto_prices || {}) },
      updates: { ...(cur.updates || {}), ...(newConfig.updates || {}) }
    };
    try {
      const data = JSON.stringify(this.config, null, 2);
      const userDir = path.dirname(this.userConfigPath);
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }
      fs.writeFileSync(this.userConfigPath, data, 'utf-8');

      // 仅在非 asar 虚拟包环境（如开发源码调试）下写入本地根目录
      if (this.rootConfigPath && !this.rootConfigPath.includes('app.asar')) {
        try {
          fs.writeFileSync(this.rootConfigPath, data, 'utf-8');
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
