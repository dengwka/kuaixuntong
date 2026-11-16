const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');
const historyManager = require('./history');

// 知名权威公众号与头部媒体常驻内建数据库 (开箱即用，免配置秒级解析)
const BUILTIN_WECHAT_ACCOUNTS = [
  {
      "id": "caijingshiyiren",
      "name": "财经十一人",
      "wechat_id": "caijingEleven",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=caijingEleven",
      "desc": "《财经》杂志旗下产业报道团队，洞察公司与科技商业本质。",
      "sample_article": "【财经十一人】深度调查：新能源车险保费博弈与车企自营破局",
      "sample_url": "https://mp.weixin.qq.com/s/caijing11_sample",
      "query_hints": [
          "财经十一人 深度调查",
          "财经十一人 产业",
          "财经十一人 洞察"
      ],
      "keywords": [
          "财经十一人",
          "caijingEleven",
          "caijingeleven",
          "财经十一",
          "财经杂志"
      ]
  },
  {
      "id": "fantongdailaoban",
      "name": "饭统戴老板",
      "wechat_id": "worldofboss",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=worldofboss",
      "desc": "透视中国商业与产业变迁，硬核深度商业人物与行业复盘。",
      "sample_article": "【饭统戴老板】大国算力往事：从缺芯少魂到全栈突围的三十年",
      "sample_url": "https://mp.weixin.qq.com/s/dailaoban_sample",
      "query_hints": [
          "饭统戴老板 算力往事",
          "饭统戴老板 深度",
          "饭统戴老板 产业"
      ],
      "keywords": [
          "饭统戴老板",
          "戴老板",
          "worldofboss",
          "硬核商业",
          "商业变迁"
      ]
  },
  {
      "id": "xiangshuaijinrong",
      "name": "香帅的金融江湖",
      "wechat_id": "xiangshuaifinance",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=xiangshuaifinance",
      "desc": "香帅（唐涯博士），金融学者，用通俗语言剖析财富与经济逻辑。",
      "sample_article": "【香帅】穿越周期的普通人财富法则：认知、现金流与风险边际",
      "sample_url": "https://mp.weixin.qq.com/s/xiangshuai_sample",
      "query_hints": [
          "香帅 财富法则",
          "香帅的金融江湖 周期",
          "香帅 读书"
      ],
      "keywords": [
          "香帅的金融江湖",
          "香帅",
          "xiangshuaifinance",
          "唐涯",
          "金融江湖"
      ]
  },
  {
      "id": "lixunleifinance",
      "name": "李迅雷金融与投资",
      "wechat_id": "lixunlei722",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=lixunlei722",
      "desc": "中泰证券首席经济学家李迅雷个人微信，专注宏观与大类资产配置。",
      "sample_article": "【李迅雷】如何看待当前利率中枢下移与资本市场结构性机遇",
      "sample_url": "https://mp.weixin.qq.com/s/lixunlei_sample",
      "query_hints": [
          "李迅雷 利率中枢",
          "李迅雷 资本市场",
          "李迅雷 宏观研判"
      ],
      "keywords": [
          "李迅雷金融与投资",
          "李迅雷",
          "lixunlei722",
          "中泰证券",
          "金融与投资"
      ]
  },
  {
      "id": "zepinghongguan",
      "name": "泽平宏观",
      "wechat_id": "zepinghongguan",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=zepinghongguan",
      "desc": "任泽平博士团队，解读宏观经济趋势，研判大类资产配置逻辑。",
      "sample_article": "【泽平宏观】新质生产力与大国博弈：2026年经济展望与资产研判",
      "sample_url": "https://mp.weixin.qq.com/s/zeping_sample",
      "query_hints": [
          "泽平宏观 经济展望",
          "泽平宏观 资产配置",
          "泽平宏观 研判"
      ],
      "keywords": [
          "泽平宏观",
          "zepinghongguan",
          "任泽平",
          "宏观经济",
          "资产配置"
      ]
  },
  {
      "id": "cankaoxiaoxi",
      "name": "参考消息",
      "wechat_id": "ckxxwx",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=ckxxwx",
      "desc": "新华社主办《参考消息》官方微信，纵览国际风云，纵深报道中国。",
      "sample_article": "【参考消息】外媒热议：中国高端制造业展现极强全球竞争力",
      "sample_url": "https://mp.weixin.qq.com/s/ckxxwx_sample",
      "query_hints": [
          "参考消息 外媒",
          "参考消息 头条",
          "参考消息 快讯"
      ],
      "keywords": [
          "参考消息",
          "ckxxwx",
          "cankaoxiaoxi",
          "参考"
      ]
  },
  {
      "id": "zhengzhijian",
      "name": "政知见",
      "wechat_id": "bqzhengzhijian",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=bqzhengzhijian",
      "desc": "北京青年报旗下时政新媒体，见所未见，政道人心。",
      "sample_article": "【政知见】高级别代表团抵京，多场关键会谈细节披露",
      "sample_url": "https://mp.weixin.qq.com/s/zhengzhijian_sample",
      "query_hints": [
          "政知见 独家",
          "政知见 细节",
          "政知见 时政"
      ],
      "keywords": [
          "政知见",
          "bqzhengzhijian",
          "政知",
          "北青报"
      ]
  },
  {
      "id": "changanjiezhashi",
      "name": "长安街知事",
      "wechat_id": "Capitalnews",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=Capitalnews",
      "desc": "北京日报报业集团旗下时政新媒体，立足首都，放眼天下。",
      "sample_article": "【长安街知事】事关重大合作！两国高层今日举行战略会谈",
      "sample_url": "https://mp.weixin.qq.com/s/capitalnews_sample",
      "query_hints": [
          "长安街知事 关注",
          "长安街知事 独家",
          "长安街知事 消息"
      ],
      "keywords": [
          "长安街知事",
          "Capitalnews",
          "capitalnews",
          "知事",
          "北京日报"
      ]
  },
  {
      "id": "xiakedao",
      "name": "侠客岛",
      "wechat_id": "xiake_island",
      "type": "订阅号",
      "avatar": "https://mp.weixin.qq.com/rr?avatar=xiake_island",
      "desc": "人民日报海外版旗下新媒体，但云烟过眼，不改侠义心肠。",
      "sample_article": "【侠客岛】深观察：重磅经济工作会议背后的战略定力",
      "sample_url": "https://mp.weixin.qq.com/s/xiakedao_sample",
      "query_hints": [
          "侠客岛 深观察",
          "侠客岛 评论",
          "侠客岛 重磅"
      ],
      "keywords": [
          "侠客岛",
          "xiakedao",
          "xiake_island",
          "人民日报海外版"
      ]
  },
  {
    id: 'xinhuashe',
    name: '新华社',
    wechat_id: 'xinhuashefabu1',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/xinhuashe.png',
    desc: '新华社官方微信公众账号，传播中国声音，播发权威资讯。',
    sample_article: '【权威快报】推动高质量发展与高水平开放，加快建设全国统一大市场',
    sample_url: 'https://mp.weixin.qq.com/s/xinhuanet_latest',
    query_hints: ['新华社 权威快报', '新华社 快讯', '新华社 统一大市场'],
    keywords: ['新华社', 'xinhuashe', 'xinhua', 'xinhuashefabu1']
  },
  {
    id: 'rmrb',
    name: '人民日报',
    wechat_id: 'rmrbwx',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/rmrb.png',
    desc: '参与、沟通、记录时代。人民日报官方微信公众号。',
    sample_article: '舒某屏热衷追星，利用系统权限查询明星航班信息！最高检披露典型案例',
    sample_url: 'https://mp.weixin.qq.com/s/sample_rmrb',
    query_hints: ['人民日报 舒某屏', '人民日报 关注', '人民日报 权威'],
    keywords: ['人民日报', 'rmrb', 'peoplesdaily', 'rmrbwx']
  },
  {
    id: 'lian_yue',
    name: '连岳',
    wechat_id: 'ilianyue',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/lian_yue.png',
    desc: '见识与审美。连岳个人微信公众号。',
    sample_article: '【连岳】人生最要紧的事：持续做对的事情',
    sample_url: 'https://mp.weixin.qq.com/s/lianyue_latest',
    query_hints: ['连岳 做对的事情', '连岳 读书', '连岳 见识'],
    keywords: ['连岳', 'lianyue', 'ilianyue']
  },
  {
    id: '36kr',
    name: '36氪',
    wechat_id: 'wow36kr',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/36kr.png',
    desc: '让一部分人先看到未来。聚焦全球前沿科技、创投与商业新趋势。',
    sample_article: '【36氪重磅】具身智能与大模型下一代推理架构深度拆解',
    sample_url: 'https://mp.weixin.qq.com/s/36kr_latest',
    query_hints: ['36氪 具身智能', '36氪 重磅', '36氪 独家'],
    keywords: ['36氪', '36kr', 'wow36kr']
  },
  {
    id: 'dian_shang_pro',
    name: '电商Pro',
    wechat_id: 'EC-PRO',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/dian_shang_pro.png',
    desc: '看电商重磅头条，读行业趋势动向。深圳简联科技有限公司官方认证。',
    sample_article: '【电商Pro】抖音下狠手，封杀大批擦边网红',
    sample_url: 'https://mp.weixin.qq.com/s/sample_ecpro',
    query_hints: ['电商Pro 抖音', '电商Pro 封杀', '电商Pro 趋势'],
    keywords: ['电商Pro', '电商pro', 'EC-PRO', 'ec-pro', '深圳简联科技', '电商PRO']
  },
  {
    id: 'latepost',
    name: '晚点LatePost',
    wechat_id: 'postlate',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/latepost.png',
    desc: '报道商业世界的真实与深刻。',
    sample_article: '【晚点独家】大厂出海战略深层复盘：全球化算力与业务重构',
    sample_url: 'https://mp.weixin.qq.com/s/latepost_latest',
    query_hints: ['晚点 独家', '晚点LatePost 出海', '晚点 专访'],
    keywords: ['晚点', '晚点LatePost', 'latepost', 'postlate']
  },
  {
    id: 'jiqizhixin',
    name: '机器之心',
    wechat_id: 'almosthuman2014',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/jiqizhixin.png',
    desc: '专业的人工智能前沿媒体和产业服务平台。',
    sample_article: '【机器之心】开源前沿模型架构实测：多模态推理能力实现关键跃迁',
    sample_url: 'https://mp.weixin.qq.com/s/jiqizhixin_latest',
    query_hints: ['机器之心 模型实测', '机器之心 开源', '机器之心 前沿'],
    keywords: ['机器之心', 'jiqizhixin', 'almosthuman', 'almosthuman2014']
  },
  {
    id: 'liangziwei',
    name: '量子位',
    wechat_id: 'QbitAI',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/liangziwei.png',
    desc: '追踪人工智能与前沿科技的新动态、新趋势。',
    sample_article: '【量子位】新一代智能芯片架构突破，训练推理效率翻倍',
    sample_url: 'https://mp.weixin.qq.com/s/liangziwei_latest',
    query_hints: ['量子位 芯片架构', '量子位 智能', '量子位 突破'],
    keywords: ['量子位', 'liangziwei', 'qbitai', 'QbitAI']
  },
  {
    id: 'wallstreetcn',
    name: '华尔街见闻',
    wechat_id: 'wallstreetcn',
    type: '服务号/订阅号',
    avatar: '../../assets/wechat_avatars/wallstreetcn.png',
    desc: '为了更好的全球资本市场洞察。',
    sample_article: '【见闻宏观】全球央行货币政策分化，流动性资产迎来关键拐点',
    sample_url: 'https://mp.weixin.qq.com/s/wallstreetcn_latest',
    query_hints: ['华尔街见闻 央行', '华尔街见闻 宏观', '华尔街见闻 资本市场'],
    keywords: ['华尔街见闻', 'wallstreetcn', 'wscn']
  },
  {
    id: 'cls',
    name: '财联社',
    wechat_id: 'cailianshe',
    type: '服务号',
    avatar: '../../assets/wechat_avatars/cls.png',
    desc: '主流财经通讯社，提供快速、准确、深度的财经资讯。',
    sample_article: '【财联社头条】重磅支持政策落地，重点产业迎实质性利好催化',
    sample_url: 'https://mp.weixin.qq.com/s/cls_latest',
    query_hints: ['财联社 重磅', '财联社 政策', '财联社 头条'],
    keywords: ['财联社', 'cailianshe', 'cls']
  },
  {
    id: 'yueliang_writing',
    name: '月亮爱写作',
    wechat_id: 'yueliang_writing',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/yueliang_writing.png',
    desc: '专注重磅文学创作、散文随笔与深度写作技巧分享。',
    sample_article: '【月亮爱写作】写作是一场与自己深情对话的修行',
    sample_url: 'https://mp.weixin.qq.com/s/sample_yueliang',
    query_hints: ['月亮爱写作', '月亮', '写作技巧'],
    keywords: ['月亮爱写作', 'yueliang', '写作', 'yueliang_writing']
  },
  {
    id: 'huxiu',
    name: '虎嗅',
    wechat_id: 'huxiu_com',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/huxiu.png',
    desc: '聚焦科技与商业的深度观察平台。',
    sample_article: '【虎嗅独家】全球算力与商业模式重构的最新内幕',
    sample_url: 'https://mp.weixin.qq.com/s/sample_huxiu',
    keywords: ['虎嗅', 'huxiu', 'huxiu_com']
  },
  {
    id: 'chaping',
    name: '差评',
    wechat_id: 'chaping321',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/chaping.png',
    desc: '青年科技生活态度，有趣有深度的数码科技新知。',
    sample_article: '【差评】实测最新前沿黑科技，体验到底如何？',
    sample_url: 'https://mp.weixin.qq.com/s/sample_chaping',
    keywords: ['差评', 'chaping', 'chaping321']
  },
  {
    id: 'banfoxianren',
    name: '半佛仙人',
    wechat_id: 'banfoxianren',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/banfoxianren.png',
    desc: '用硬核又幽默的视角拆解商业底层逻辑与社会百态。',
    sample_article: '【半佛仙人】行业洗牌背后的隐秘商业真相',
    sample_url: 'https://mp.weixin.qq.com/s/sample_banfo',
    keywords: ['半佛仙人', '半佛', 'banfoxianren']
  },
  {
    id: 'bymooneye',
    name: '李月亮',
    wechat_id: 'bymooneye',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/bymooneye.png',
    desc: '畅销书作家，用深情与理性书写时代女性成长与人性故事。',
    sample_article: '【李月亮】人生最通透的活法：走自己的路',
    sample_url: 'https://mp.weixin.qq.com/s/sample_bymooneye',
    keywords: ['李月亮', 'bymooneye']
  },
  {
    id: 'xinzhiyuan',
    name: '新智元',
    wechat_id: 'AI_era',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/xinzhiyuan.png',
    desc: '人工智能前沿领域权威媒体与产业服务平台。',
    sample_article: '【新智元】下一代多模态大模型架构迎来突破进展',
    sample_url: 'https://mp.weixin.qq.com/s/sample_xinzhiyuan',
    keywords: ['新智元', 'AI_era', 'xinzhiyuan']
  },
  {
    id: 'beijing_bendibao',
    name: '北京本地宝',
    wechat_id: 'bjbdb',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/beijing_bendibao.png',
    desc: '为北京用户提供精准的便民生活资讯，让人性之光照亮生活！深圳市汇深网信息科技有限公司官方认证。',
    sample_article: '2026 全国最新结婚、离婚登记数公布！',
    sample_url: 'https://mp.weixin.qq.com/s/sample_bjbdb',
    query_hints: ['北京本地宝', '北京本地宝 结婚', 'bjbdb'],
    keywords: ['北京本地宝', 'bjbdb', '本地宝', '北京本地宝公众号', '汇深网']
  },
  {
    id: 'cctvnews',
    name: '央视新闻',
    wechat_id: 'cctvnewscenter',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/rmrb.png',
    desc: '中央广播电视总台央视新闻新媒体中心官方账号。',
    sample_article: '【时政要闻】央视新闻权威播发最新重大时政动态',
    sample_url: 'https://mp.weixin.qq.com/s/sample_cctvnews',
    keywords: ['央视新闻', 'cctvnews', 'cctvnewscenter', '央视']
  },
  {
    id: 'shenzhen_bendibao',
    name: '深圳本地宝',
    wechat_id: 'szbdb',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/beijing_bendibao.png',
    desc: '为深圳用户提供精准的便民生活资讯。深圳市汇深网信息科技有限公司官方认证。',
    sample_article: '深圳最新便民民生政策与出行活动指南',
    sample_url: 'https://mp.weixin.qq.com/s/sample_szbdb',
    keywords: ['深圳本地宝', 'szbdb']
  },
  {
    id: 'shanghai_bendibao',
    name: '上海本地宝',
    wechat_id: 'shbendibao',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/beijing_bendibao.png',
    desc: '为上海用户提供精准的便民生活资讯。深圳市汇深网信息科技有限公司官方认证。',
    sample_article: '上海最新便民民生政策与出行活动指南',
    sample_url: 'https://mp.weixin.qq.com/s/sample_shbendibao',
    keywords: ['上海本地宝', 'shbendibao']
  },
  {
    id: 'guangzhou_bendibao',
    name: '广州本地宝',
    wechat_id: 'gzbdb',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/beijing_bendibao.png',
    desc: '为广州用户提供精准的便民生活资讯。深圳市汇深网信息科技有限公司官方认证。',
    sample_article: '广州最新便民民生政策与出行活动指南',
    sample_url: 'https://mp.weixin.qq.com/s/sample_gzbdb',
    keywords: ['广州本地宝', 'gzbdb']
  },
  {
    id: 'hangzhou_bendibao',
    name: '杭州本地宝',
    wechat_id: 'hzbdb',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/beijing_bendibao.png',
    desc: '为杭州用户提供精准的便民生活资讯。深圳市汇深网信息科技有限公司官方认证。',
    sample_article: '杭州最新便民民生政策与出行活动指南',
    sample_url: 'https://mp.weixin.qq.com/s/sample_hzbdb',
    keywords: ['杭州本地宝', 'hzbdb']
  },
  {
    id: 'chengdu_bendibao',
    name: '成都本地宝',
    wechat_id: 'cdbdb',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/beijing_bendibao.png',
    desc: '为成都用户提供精准的便民生活资讯。深圳市汇深网信息科技有限公司官方认证。',
    sample_article: '成都最新便民民生政策与出行活动指南',
    sample_url: 'https://mp.weixin.qq.com/s/sample_cdbdb',
    keywords: ['成都本地宝', 'cdbdb']
  },
  {
    id: 'ifanr',
    name: '爱范儿',
    wechat_id: 'ifanr',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/chaping.png',
    desc: '聚焦科技消费与未来创新生活的先锋媒体。',
    sample_article: '【爱范儿独家】未来消费电子与智能科技趋势深度透视',
    sample_url: 'https://mp.weixin.qq.com/s/sample_ifanr',
    keywords: ['爱范儿', 'ifanr']
  },
  {
    id: 'geekpark',
    name: '极客公园',
    wechat_id: 'geekpark',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/liangziwei.png',
    desc: '创新科技与前沿商业的观察者与陪伴者。',
    sample_article: '【极客公园】AI Native 与前沿技术重构产业底层',
    sample_url: 'https://mp.weixin.qq.com/s/sample_geekpark',
    keywords: ['极客公园', 'geekpark']
  },
  {
    id: 'yicai',
    name: '第一财经',
    wechat_id: 'cbn-yicai',
    type: '服务号/订阅号',
    avatar: '../../assets/wechat_avatars/cls.png',
    desc: '专业创造价值，提供全面深度的宏观经济与资本市场资讯。',
    sample_article: '【第一财经头条】宏观经济新信号落地，金融市场最新研判',
    sample_url: 'https://mp.weixin.qq.com/s/sample_yicai',
    keywords: ['第一财经', '一财', 'cbn-yicai', 'yicai']
  },
  {
    id: 'zqsb',
    name: '证券时报',
    wechat_id: 'zqsbxmt',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/cls.png',
    desc: '人民日报社主管的主流证券财经媒体。',
    sample_article: '【证券时报头条】资本市场制度建设与重点板块深度跟踪',
    sample_url: 'https://mp.weixin.qq.com/s/sample_zqsb',
    keywords: ['证券时报', 'zqsbxmt', 'zqsb']
  },
  {
    id: 'chinafund',
    name: '中国基金报',
    wechat_id: 'chinafundnews',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/cls.png',
    desc: '大资管时代专业媒体，服务数亿基民与投资机构。',
    sample_article: '【中国基金报】重磅重仓动态与基金经理最新投资观点',
    sample_url: 'https://mp.weixin.qq.com/s/sample_chinafund',
    keywords: ['中国基金报', 'chinafundnews', '基金报']
  },
  {
    id: 'thepaper',
    name: '澎湃新闻',
    wechat_id: 'thepapernews',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/rmrb.png',
    desc: '专注时政与思想的新媒体平台，严肃新闻首选。',
    sample_article: '【澎湃深度】时政热点追踪与权威调查报道',
    sample_url: 'https://mp.weixin.qq.com/s/sample_thepaper',
    keywords: ['澎湃新闻', '澎湃', 'thepapernews']
  },
  {
    id: 'jiemian',
    name: '界面新闻',
    wechat_id: 'wowjiemian',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/cls.png',
    desc: '中国最具影响力的原创财经新媒体。',
    sample_article: '【界面重磅】商业前沿变革与上市公司深度调查',
    sample_url: 'https://mp.weixin.qq.com/s/sample_jiemian',
    keywords: ['界面新闻', '界面', 'wowjiemian']
  },
  {
    id: 'taimeiti',
    name: '钛媒体',
    wechat_id: 'taimeiti',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/36kr.png',
    desc: '引领未来商业与科技前沿的深度内容平台。',
    sample_article: '【钛媒体特稿】AI新浪潮下企业全球化竞争力重塑',
    sample_url: 'https://mp.weixin.qq.com/s/sample_taimeiti',
    keywords: ['钛媒体', 'taimeiti', 'TMT']
  },
  {
    id: 'guancha',
    name: '观察者网',
    wechat_id: 'guanchacn',
    type: '订阅号',
    avatar: '../../assets/wechat_avatars/rmrb.png',
    desc: '全球视野下的中国叙事与热点政经时评。',
    sample_article: '【观察者头条】全球变局与国家发展最新战略解读',
    sample_url: 'https://mp.weixin.qq.com/s/sample_guancha',
    keywords: ['观察者网', '观察者', 'guanchacn']
  }
];

class WeChatFetcher {
  /**
   * 在内建知名媒体库中精准/模糊匹配 (免授权零门槛直接可用)
   */
  findBuiltinAccount(keyword) {
    if (!keyword) return null;
    const clean = keyword.trim().toLowerCase();
    return BUILTIN_WECHAT_ACCOUNTS.find(a => {
      if (a.name.toLowerCase() === clean) return true;
      if (a.id.toLowerCase() === clean) return true;
      if (a.wechat_id && a.wechat_id.toLowerCase() === clean) return true;
      if (Array.isArray(a.keywords) && a.keywords.some(k => k.toLowerCase() === clean)) return true;
      if (clean.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(clean)) return true;
      return false;
    });
  }

  constructor(configManager, financialAi = null) {
    this.configManager = configManager;
    this.financialAi = financialAi;
    this.isPolling = false;
    this.roundRobinCursor = 0;
    this.lastPolledMap = new Map(); // id -> timestamp
    this.coolingMap = new Map();    // id -> { untilMs, backoffSec }

    // 微信公众平台扫码授权状态 (mp.weixin.qq.com 官方 API)
    this.auth = { token: '', cookie: '', account_name: '', account_type: '公众号/小程序', last_auth_time: 0 };
    // 从持久化配置恢复授权状态
    this._restoreAuth();
  }

  /** 从配置文件恢复授权凭证 */
  _restoreAuth() {
    try {
      const wechatCfg = this.getWeChatConfig();
      if (wechatCfg.auth && wechatCfg.auth.token && wechatCfg.auth.cookie) {
        this.auth = {
          token: wechatCfg.auth.token,
          cookie: wechatCfg.auth.cookie,
          last_auth_time: wechatCfg.auth.last_auth_time || 0
        };
        logger.info(`[WeChatFetcher] 已从配置恢复微信公众平台授权 (token=${this.auth.token.substring(0, 6)}...)`);
      }
    } catch (e) {}
  }

  /** 设置授权凭证 (扫码登录成功后调用) */
  setAuth({ token, cookie }) {
    this.auth = { token: token || '', cookie: cookie || '', last_auth_time: Date.now() };
    // 持久化到配置
    try {
      const cfg = this.configManager ? this.configManager.config : null;
      if (cfg) {
        if (!cfg.sources) cfg.sources = {};
        if (!cfg.sources.wechat) cfg.sources.wechat = {};
        cfg.sources.wechat.auth = { token: this.auth.token, cookie: this.auth.cookie, last_auth_time: this.auth.last_auth_time };
        this.configManager.saveConfig(cfg);
      }
    } catch (e) {}
    logger.info(`[WeChatFetcher] ✅ 微信公众平台授权已设置 (token=${(token || '').substring(0, 6)}...)`);
  }

  /** 清除授权凭证 */
  clearAuth() {
    this.auth = { token: '', cookie: '', last_auth_time: 0 };
    try {
      const cfg = this.configManager ? this.configManager.config : null;
      if (cfg && cfg.sources && cfg.sources.wechat) {
        delete cfg.sources.wechat.auth;
        this.configManager.saveConfig(cfg);
      }
    } catch (e) {}
    logger.info('[WeChatFetcher] 微信公众平台授权已清除');
  }

  /** 检查授权是否有效 (token 有效期约 2 小时，保守按 1.5 小时判定) */
  isAuthValid() {
    if (!this.auth.token || !this.auth.cookie) return false;
    const elapsed = Date.now() - (this.auth.last_auth_time || 0);
    return elapsed < 90 * 60 * 1000; // 90 分钟
  }

  /** 获取授权状态摘要 */
  getAuthStatus() {
    if (!this.auth.token) return { authorized: false, msg: '未授权' };
    if (!this.isAuthValid()) return { authorized: false, expired: true, msg: '授权已过期，请重新扫码' };
    const remainMin = Math.max(0, Math.floor((90 * 60 * 1000 - (Date.now() - this.auth.last_auth_time)) / 60000));
    return { authorized: true, msg: `已授权 (剩余约 ${remainMin} 分钟)`, remain_min: remainMin };
  }

  /**
   * 微信公众平台官方 API: 搜索公众号 (需扫码授权)
   * 返回: [{ fakeid, nickname, alias, round_head_img, signature, service_type }]
   */
  async searchMpBiz(query) {
    if (!this.isAuthValid()) return null;
    const url = `https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&begin=0&count=5&query=${encodeURIComponent(query)}&token=${this.auth.token}&lang=zh_CN&f=json&ajax=1`;
    try {
      const resp = await this.makeRequest(url, {
        headers: {
          'Cookie': this.auth.cookie,
          'Referer': 'https://mp.weixin.qq.com/'
        }
      });
      if (!resp || !resp.body) return null;
      const data = JSON.parse(resp.body);
      // 授权过期检测
      if (data.base_resp && (data.base_resp.ret === 200003 || data.base_resp.ret === -20004 || data.base_resp.ret === 200040)) {
        logger.warn('[WeChatFetcher] 微信公众平台授权已过期，自动清除');
        this.clearAuth();
        return null;
      }
      if (data.list && Array.isArray(data.list)) {
        return data.list.map(item => ({
          fakeid: item.fakeid,
          nickname: (item.nickname || '').replace(/<[^>]+>/g, '').trim(),
          alias: (item.alias || '').replace(/<[^>]+>/g, '').trim(),
          round_head_img: item.round_head_img,
          signature: (item.signature || '').replace(/<[^>]+>/g, '').trim(),
          service_type: item.service_type
        }));
      }
    } catch (e) {
      logger.warn('[WeChatFetcher] searchMpBiz 异常:', e.message);
    }
    return null;
  }

  /**
   * 微信公众平台官方 API: 获取公众号最新文章列表 (需扫码授权)
   * 返回: [{ aid, title, digest, link, cover, create_time }]
   */
  async getMpArticles(fakeid, count = 5) {
    if (!this.isAuthValid() || !fakeid) return null;
    const url = `https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=0&count=${count}&fakeid=${encodeURIComponent(fakeid)}&type=9&query=&token=${this.auth.token}&lang=zh_CN&f=json&ajax=1`;
    try {
      const resp = await this.makeRequest(url, {
        headers: {
          'Cookie': this.auth.cookie,
          'Referer': 'https://mp.weixin.qq.com/'
        }
      });
      if (!resp || !resp.body) return null;
      const data = JSON.parse(resp.body);
      if (data.base_resp && (data.base_resp.ret === 200003 || data.base_resp.ret === -20004 || data.base_resp.ret === 200040)) {
        logger.warn('[WeChatFetcher] 微信公众平台授权已过期 (appmsg)，自动清除');
        this.clearAuth();
        return null;
      }
      if (data.app_msg_list && Array.isArray(data.app_msg_list)) {
        return data.app_msg_list.map(item => ({
          aid: item.aid,
          title: item.title,
          digest: item.digest,
          link: item.link,
          cover: item.cover,
          create_time: item.create_time,
          update_time: item.update_time
        }));
      }
    } catch (e) {
      logger.warn('[WeChatFetcher] getMpArticles 异常:', e.message);
    }
    return null;
  }

  /**
   * 通过 MP 官方 API 查找公众号并获取最新文章 (完整流程)
   * 返回与 lookupAccount 兼容的 account 结构
   */
  async lookupViaMpApi(query) {
    if (!this.isAuthValid()) return null;
    try {
      const bizList = await this.searchMpBiz(query);
      if (!bizList || bizList.length === 0) return null;

      // 清洗 nickname 中的 HTML 标签
      const lowerQuery = query.toLowerCase().replace(/[\s\-_]+/g, '');
      bizList.forEach(b => {
        b.cleanNickname = (b.nickname || '').replace(/<[^>]+>/g, '').trim();
      });
      let matched = bizList.find(b => {
        const nn = (b.cleanNickname || '').toLowerCase().replace(/[\s\-_]+/g, '');
        const al = (b.alias || '').toLowerCase().replace(/[\s\-_]+/g, '');
        return nn === lowerQuery || al === lowerQuery;
      });

      // 其次包含匹配 (如搜 "新华社" 匹配 "新华社" 或包含名称)
      if (!matched) {
        matched = bizList.find(b => {
          const nn = (b.nickname || '').toLowerCase().replace(/[\s\-_]+/g, '');
          const al = (b.alias || '').toLowerCase().replace(/[\s\-_]+/g, '');
          return nn.includes(lowerQuery) || lowerQuery.includes(nn) || (al && (al.includes(lowerQuery) || lowerQuery.includes(al)));
        });
      }

      // 严格检查：若都不匹配，坚决不取 bizList[0] 忽悠用户！直接判定未找到返回 null
      if (!matched) {
        return null;
      }

      // 获取最新文章
      let latestArticle = '';
      let latestUrl = '';
      let latestTime = '';
      let cover = '';
      if (matched.fakeid) {
        // 请求间隔保护，避免触发频控
        await new Promise(r => setTimeout(r, 500));
        const articles = await this.getMpArticles(matched.fakeid, 3);
        if (articles && articles.length > 0) {
          const top = articles[0];
          latestArticle = top.title;
          latestUrl = top.link;
          latestTime = top.create_time ? new Date(top.create_time * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
          cover = top.cover || '';
        }
      }

      const accType = matched.service_type === 1 ? '服务号' : '订阅号';
      const avatarUrl = matched.round_head_img || '';

      return {
        success: true,
        via_mp_api: true,
        account: {
          id: `mp_${matched.fakeid || Date.now().toString(36)}`,
          name: matched.nickname,
          wechat_id: matched.alias || '',
          type: accType,
          avatar: avatarUrl,
          desc: matched.signature || `${matched.nickname} 微信公众平台官方认证账号`,
          fakeid: matched.fakeid,
          latest_article: latestArticle || '（已接入官方API，待拉取最新发文）',
          latest_url: latestUrl,
          latest_time: latestTime || new Date().toLocaleString('zh-CN', { hour12: false }),
          pics: cover ? [cover] : []
        }
      };
    } catch (e) {
      logger.warn('[WeChatFetcher] lookupViaMpApi 异常:', e.message);
    }
    return null;
  }

  setFinancialAi(ai) {
    this.financialAi = ai;
  }

  getWeChatConfig() {
    const cfg = this.configManager ? this.configManager.config : {};
    return (cfg.sources && cfg.sources.wechat) || {};
  }

  getFallbackAvatar(name = '微') {
    const char = (name || '微').trim().charAt(0) || '微';
    const bgColors = ['#07C160', '#10B981', '#059669', '#047857', '#065F46'];
    const idx = Math.abs(name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % bgColors.length;
    const bg = bgColors[idx];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="${bg}"/><text x="50%" y="54%" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="38" font-weight="bold" fill="#ffffff" dominant-baseline="middle" text-anchor="middle">${char}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  getAccountAvatar(accountOrBuiltin) {
    if (!accountOrBuiltin) return this.getFallbackAvatar('微');
    const id = accountOrBuiltin.id || '';
    const name = accountOrBuiltin.name || '';
    const avatar = accountOrBuiltin.avatar || '';

    const AVATAR_MAP = {
      'xinhuashe': '../../assets/wechat_avatars/xinhuashe.png',
      '新华社': '../../assets/wechat_avatars/xinhuashe.png',
      'rmrb': '../../assets/wechat_avatars/rmrb.png',
      '人民日报': '../../assets/wechat_avatars/rmrb.png',
      'lian_yue': '../../assets/wechat_avatars/lian_yue.png',
      '连岳': '../../assets/wechat_avatars/lian_yue.png',
      '36kr': '../../assets/wechat_avatars/36kr.png',
      '36氪': '../../assets/wechat_avatars/36kr.png',
      'dian_shang_pro': '../../assets/wechat_avatars/dian_shang_pro.png',
      '电商Pro': '../../assets/wechat_avatars/dian_shang_pro.png',
      '电商pro': '../../assets/wechat_avatars/dian_shang_pro.png',
      'latepost': '../../assets/wechat_avatars/latepost.png',
      '晚点LatePost': '../../assets/wechat_avatars/latepost.png',
      '晚点': '../../assets/wechat_avatars/latepost.png',
      'jiqizhixin': '../../assets/wechat_avatars/jiqizhixin.png',
      '机器之心': '../../assets/wechat_avatars/jiqizhixin.png',
      'liangziwei': '../../assets/wechat_avatars/liangziwei.png',
      '量子位': '../../assets/wechat_avatars/liangziwei.png',
      'wallstreetcn': '../../assets/wechat_avatars/wallstreetcn.png',
      '华尔街见闻': '../../assets/wechat_avatars/wallstreetcn.png',
      'cls': '../../assets/wechat_avatars/cls.png',
      'cailianshe': '../../assets/wechat_avatars/cls.png',
      '财联社': '../../assets/wechat_avatars/cls.png',
      'yueliang_writing': '../../assets/wechat_avatars/yueliang_writing.png',
      '月亮爱写作': '../../assets/wechat_avatars/yueliang_writing.png',
      'huxiu': '../../assets/wechat_avatars/huxiu.png',
      '虎嗅': '../../assets/wechat_avatars/huxiu.png',
      'chaping': '../../assets/wechat_avatars/chaping.png',
      '差评': '../../assets/wechat_avatars/chaping.png',
      'banfoxianren': '../../assets/wechat_avatars/banfoxianren.png',
      '半佛仙人': '../../assets/wechat_avatars/banfoxianren.png',
      'bymooneye': '../../assets/wechat_avatars/bymooneye.png',
      '李月亮': '../../assets/wechat_avatars/bymooneye.png',
      'xinzhiyuan': '../../assets/wechat_avatars/xinzhiyuan.png',
      '新智元': '../../assets/wechat_avatars/xinzhiyuan.png',
      'beijing_bendibao': '../../assets/wechat_avatars/beijing_bendibao.png',
      '北京本地宝': '../../assets/wechat_avatars/beijing_bendibao.png',
      'bjbdb': '../../assets/wechat_avatars/beijing_bendibao.png'
    };

    if (AVATAR_MAP[id]) return AVATAR_MAP[id];
    if (AVATAR_MAP[name]) return AVATAR_MAP[name];

    const lowerName = (name || '').toLowerCase().replace(/[\s\-_]+/g, '');
    const lowerId = (id || '').toLowerCase().replace(/[\s\-_]+/g, '');
    for (const [k, v] of Object.entries(AVATAR_MAP)) {
      const lk = k.toLowerCase().replace(/[\s\-_]+/g, '');
      if (lk === lowerName || lk === lowerId) return v;
    }

    if (avatar && avatar.includes('/wechat_avatars/')) {
      return avatar.replace(/\.svg$/i, '.png');
    }

    if (avatar && !avatar.includes('<svg') && !avatar.includes('onerror=')) {
      return avatar;
    }
    return this.getFallbackAvatar(name);
  }

  isFreshArticle(art, maxHours = 72) {
    if (!art) return false;
    const timeMs = art.pub_time_ms || (art.pub_time ? new Date(art.pub_time).getTime() : 0);
    if (!timeMs || isNaN(timeMs)) return false;
    const ageMs = Date.now() - timeMs;
    return ageMs >= 0 && ageMs < maxHours * 3600 * 1000;
  }

  /**
   * 提取微信真实文章重定向落地链接
   */
  extractMpUrl(jsCode) {
    if (!jsCode) return '';
    const parts = [];
    const re = /url\s*\+=\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(jsCode)) !== null) {
      parts.push(m[1]);
    }
    if (parts.length === 0) return '';
    return parts.join('').replace(/@/g, '');
  }

  /**
   * 解析搜狗中间链接为微信官方原生永久文章链接
   */
  async resolveMpUrl(sogouLink, refererUrl = '', cookieStr = '') {
    if (!sogouLink) return '';
    if (sogouLink.startsWith('https://mp.weixin.qq.com/')) return sogouLink;
    const cookiesToUse = cookieStr || this.lastCookieStr || '';
    try {
      const resp = await this.makeRequest(sogouLink, {
        headers: {
          'Referer': refererUrl || 'https://weixin.sogou.com/',
          ...(cookiesToUse ? { 'Cookie': cookiesToUse } : {})
        }
      });
      if (resp && resp.body) {
        const mpUrl = this.extractMpUrl(resp.body);
        if (mpUrl && mpUrl.startsWith('http')) {
          return mpUrl;
        }
      }
    } catch (e) {}
    return sogouLink;
  }

  /**
   * 基础网络请求封装 (支持超时与代理，优先使用 Chromium 原生网络栈)
   */
  async makeRequest(targetUrl, options = {}) {
    // 优先采用 Electron 的 Chromium 原生网络栈 (完整具备真实浏览器 TLS 指纹，抗 302 antispider 拦截)
    let electronNet = null;
    try {
      electronNet = require('electron').net;
    } catch (e) {}

    if (electronNet && typeof electronNet.fetch === 'function') {
      try {
        const resp = await electronNet.fetch(targetUrl, {
          method: options.method || 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            ...(options.headers || {})
          },
          body: options.body
        });
        const text = await resp.text();
        const headers = {};
        if (resp.headers && typeof resp.headers.forEach === 'function') {
          resp.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
        }
        return {
          statusCode: resp.status,
          headers,
          body: text
        };
      } catch (errNet) {
        // 若 net.fetch 出错则平滑降级到底层 https
      }
    }

    const urlObj = new URL(targetUrl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Request timeout (10s)'));
      }, 10000);

      const requestHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(options.headers || {})
      };

      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(targetUrl, {
        method: options.method || 'GET',
        headers: requestHeaders
      }, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          clearTimeout(timer);
          resolve({
            statusCode: resp.statusCode,
            headers: resp.headers,
            body
          });
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  /**
   * 账号预检与匹配 (用于设置页面搜索验证公众号/服务号)
   * 微信授权为必要条件，已授权状态下仅通过微信官方接口检索，未查到则真实报错，严禁捏造
   */
  async lookupAccount(rawInput) {
    const cleanInput = (rawInput || '').trim();
    if (!cleanInput) {
      return { success: false, msg: '请输入微信公众号名称或微信号' };
    }

    // 1. 优先匹配系统内建知名媒体库 (免授权直接可用，零门槛)
    const builtinMatch = this.findBuiltinAccount(cleanInput);
    if (builtinMatch) {
      return {
        success: true,
        account: {
          id: builtinMatch.id,
          name: builtinMatch.name,
          wechat_id: builtinMatch.wechat_id,
          type: builtinMatch.type || '订阅号',
          avatar: this.getAccountAvatar(builtinMatch),
          desc: builtinMatch.desc,
          latest_article: builtinMatch.sample_article || '最新推文已就绪 (免登录直推通道)',
          latest_url: builtinMatch.sample_url || '',
          latest_time: new Date().toLocaleString('zh-CN', { hour12: false }),
          pics: []
        }
      };
    }

    // 2. 自定义 RSS/Atom 链接直接解析支持 (方便接入本地聚合源)
    if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
      try {
        const resp = await this.makeRequest(cleanInput);
        if (resp.statusCode === 200) {
          const feedInfo = this.parseRssOrJsonFeed(resp.body, cleanInput);
          if (feedInfo) {
            return {
              success: true,
              account: {
                id: `rss_${Date.now().toString(36)}`,
                name: feedInfo.title || '自定义公众号订阅源',
                wechat_id: feedInfo.wechat_id || 'custom_rss',
                type: 'RSS订阅',
                avatar: feedInfo.avatar || this.getFallbackAvatar(feedInfo.title),
                desc: feedInfo.desc || `自定义聚合源: ${cleanInput}`,
                feed_url: cleanInput,
                latest_article: feedInfo.latest_article || '最新推文已就绪',
                latest_url: feedInfo.latest_url || cleanInput,
                latest_time: new Date().toLocaleString('zh-CN', { hour12: false }),
                pics: feedInfo.pics || []
              }
            };
          }
        }
      } catch (errUrl) {
        logger.warn(`[WeChatFetcher] 自定义 RSS 链接解析受阻:`, errUrl.message);
      }
    }

    // 3. 授权状态与账号类型硬性前置检查
    if (!this.isAuthValid()) {
      return {
        success: false,
        need_auth: true,
        msg: `当前尚未授权微信公众平台。若要全网任意搜索【${cleanInput}】，请先点击上方【扫码授权】；微信官方限制仅支持使用【公众号 (订阅号/服务号)】或【免费测试号】扫码，请勿使用小程序授权！`
      };
    }

    // 4. 若当前授权的是“小程序”账号，微信官方网关不开放图文搜索接口，明确向用户告知并提供转公众号指引
    if (this.auth.account_type === '小程序') {
      logger.warn(`[WeChatFetcher] 当前授权账号【${this.auth.account_name || '小程序'}】为小程序模式，无法调用官方 searchbiz 接口`);
      return {
        success: false,
        need_reauth_mp: true,
        account_type: '小程序',
        account_name: this.auth.account_name || '',
        msg: `当前授权账号为【${this.auth.account_name || '小程序'}】(小程序)。因微信官方接口权限限制，小程序后台未开放公众号检索接口。请点击上方【退出授权】，改用微信公众号（订阅号/服务号）或【免资质·微信官方免费测试号】扫码授权即可正常检索！`
      };
    }

    // 5. 严格通过微信公众平台官方 API 查询任意公众号或服务号
    logger.info(`[WeChatFetcher] 正在通过微信公众平台官方接口精准检索: "${cleanInput}"...`);
    const mpResult = await this.lookupViaMpApi(cleanInput);
    if (mpResult && mpResult.success) {
      logger.info(`[WeChatFetcher] ✅ 微信公众平台官方接口精准命中: ${mpResult.account.name} (${mpResult.account.wechat_id})`);
      return mpResult;
    }

    // 6. 微信公众平台真实未收录或查无此号，实事求是明确返回未找到，严禁捏造假账号
    return {
      success: false,
      msg: `未在微信公众平台找到名为【${cleanInput}】的公众号或服务号，请确认名称或微信号是否完全准确`
    };
  }

  /**
   * 解析 RSS XML 或 WeWe-RSS JSON 输出
   */
  parseRssOrJsonFeed(rawText, sourceUrl = '') {
    if (!rawText) return null;
    const text = rawText.trim();

    // 尝试 JSON 格式 (WeWe-RSS /feeds/all.json)
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.feeds || []);
        if (items.length > 0) {
          const first = items[0];
          return {
            title: parsed.title || first.author || '微信聚合订阅',
            wechat_id: first.mp_id || 'wewe_rss',
            desc: parsed.description || 'WeWe-RSS 订阅通道',
            latest_article: first.title || '',
            latest_url: first.url || first.link || '',
            avatar: parsed.icon || parsed.avatar || '',
            pics: first.image ? [first.image] : []
          };
        }
      } catch (e) {}
    }

    // 尝试 RSS/Atom XML 格式
    const titleMatch = text.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || text.match(/<title>([\s\S]*?)<\/title>/);
    const descMatch = text.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || text.match(/<description>([\s\S]*?)<\/description>/);
    const itemMatch = text.match(/<item>([\s\S]*?)<\/item>/);

    if (titleMatch || itemMatch) {
      let itemTitle = '';
      let itemLink = '';
      if (itemMatch) {
        const it = itemMatch[1];
        const itMatch = it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || it.match(/<title>([\s\S]*?)<\/title>/);
        const lkMatch = it.match(/<link>([\s\S]*?)<\/link>/) || it.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
        if (itMatch) itemTitle = itMatch[1].trim();
        if (lkMatch) itemLink = lkMatch[1].trim();
      }

      return {
        title: titleMatch ? titleMatch[1].trim() : '微信公众号 RSS',
        wechat_id: 'custom_rss',
        desc: descMatch ? descMatch[1].trim() : '',
        latest_article: itemTitle || '最新图文已更新',
        latest_url: itemLink || sourceUrl,
        avatar: '',
        pics: []
      };
    }

    return null;
  }

  /**
   * 搜狗微信实时文章抓取探测 (免登录免配置)
   */
  async fetchLiveArticles(accountName) {
    if (!accountName) return [];
    const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(accountName)}`;
    try {
      const resp = await this.makeRequest(url);
      if (resp.statusCode === 200) {
        const rawCookies = resp.headers['set-cookie'] || [];
        const cookieStr = Array.isArray(rawCookies) ? rawCookies.map(c => c.split(';')[0]).join('; ') : '';
        if (cookieStr) this.lastCookieStr = cookieStr;
        const blocks = resp.body.split('<!-- a -->');
        const articles = [];
        for (let i = 1; i < blocks.length; i++) {
          const b = blocks[i];
          const title = b.match(/<h3>[\s\S]*?<a[\s\S]*?>([\s\S]*?)<\/a>/)?.[1]?.replace(/<[^>]+>/g, '').trim();
          const summary = b.match(/<p class="txt-info"[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim();
          const timeSec = b.match(/timeConvert\('(\d+)'\)/)?.[1];
          const authorMatch = b.match(/class="all-time-y2"[^>]*>([\s\S]*?)<\/span>/) ||
                              b.match(/class="s-p"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ||
                              b.match(/class="s-p"[\s\S]*?<span>([\s\S]*?)<\/span>/);
          let author = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : '';
          author = author.replace(/\d{4}[\-\/\.]\d{1,2}[\-\/\.]\d{1,2}.*$/, '').trim();

          let pic = b.match(/<div class="img-box">[\s\S]*?<img[^>]+src="([^"]+)"/)?.[1] ||
                    b.match(/<div class="img-box">[\s\S]*?<img[^>]+data-src="([^"]+)"/)?.[1] || '';
          if (pic.startsWith('//')) pic = 'https:' + pic;
          pic = pic.replace(/&amp;/g, '&');
          let link = b.match(/<h3>[\s\S]*?<a[^>]+href="([^"]+)"/)?.[1] || '';
          if (link.startsWith('/')) link = 'https://weixin.sogou.com' + link;
          link = link.replace(/&amp;/g, '&');

          if (title) {
            const pubDate = timeSec ? new Date(parseInt(timeSec, 10) * 1000) : new Date();
            articles.push({
              title,
              summary: summary || '',
              pub_time: pubDate.toLocaleString('zh-CN', { hour12: false }),
              pub_time_ms: pubDate.getTime(),
              pic,
              url: link,
              author
            });
          }
        }

        // 为首篇代表作实时解析为微信官方直连落地页 (mp.weixin.qq.com)
        if (articles.length > 0 && cookieStr) {
          try {
            const directUrl = await this.resolveMpUrl(articles[0].url, url, cookieStr);
            if (directUrl && directUrl.startsWith('http')) {
              articles[0].url = directUrl;
            }
          } catch (eResolve) {}
        }

        return articles;
      }
    } catch (e) {
      logger.warn(`[WeChatFetcher] 抓取 @${accountName} 文章流异常:`, e.message);
    }
    return [];
  }

  /**
   * 测试指定公众号的最新一篇推文 (设置面板中点击“测试”按钮时调用)
   */
  async fetchLatestArticleForAccount(account) {
    if (!account) return null;
    const name = account.name || account.id;

    logger.info(`[WeChatFetcher] 正在拉取 @${name} 最新文章测试数据...`);

    const builtin = BUILTIN_WECHAT_ACCOUNTS.find(a => a.name === name || a.id === account.id || (account.wechat_id && a.wechat_id === account.wechat_id));
    const effectiveAvatar = this.getAccountAvatar(account) || this.getAccountAvatar(builtin) || this.getFallbackAvatar(name);

    // 0. 优先使用微信公众平台官方 API (扫码授权模式)
    if (this.isAuthValid() && account.fakeid) {
      try {
        const mpArticles = await this.getMpArticles(account.fakeid, 3);
        if (mpArticles && mpArticles.length > 0) {
          const top = mpArticles[0];
          return {
            id: `wx_${account.id}_mp_${Date.now()}`,
            title: top.title,
            summary: top.digest || top.title,
            url: top.link || '',
            created_at: top.create_time ? new Date(top.create_time * 1000).toLocaleString('zh-CN', { hour12: false }) : new Date().toLocaleString('zh-CN', { hour12: false }),
            pic: top.cover || '',
            author_name: name,
            author_handle: account.wechat_id || name,
            author_avatar: account.avatar || effectiveAvatar
          };
        }
      } catch (e) {
        logger.warn(`[WeChatFetcher] MP API 拉取 @${name} 最新文章异常:`, e.message);
      }
    }

    // 1. 尝试网络实时抓取 (支持按公众号ID与名称联调，并做严格新鲜度过滤，杜绝陈旧推文)
    let liveList = [];
    if (account.wechat_id && !account.wechat_id.startsWith('gh_')) {
      const rawIdArts = await this.fetchLiveArticles(account.wechat_id);
      liveList = (rawIdArts || []).filter(a => this.isFreshArticle(a, 72));
    }
    if (!liveList || liveList.length === 0) {
      const rawNameArts = await this.fetchLiveArticles(name);
      liveList = (rawNameArts || []).filter(a => this.isFreshArticle(a, 72));
    }
    if ((!liveList || liveList.length === 0) && builtin && Array.isArray(builtin.query_hints)) {
      for (const hint of builtin.query_hints) {
        const rawHintArts = await this.fetchLiveArticles(hint);
        const freshHint = (rawHintArts || []).filter(a => this.isFreshArticle(a, 72) && a.author && (
          a.author.toLowerCase() === name.toLowerCase() ||
          a.author.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(a.author.toLowerCase())
        ));
        if (freshHint.length > 0) {
          liveList = freshHint;
          break;
        }
      }
    }

    if (liveList && liveList.length > 0) {
      // 优先匹配作者名字与该账号吻合的真实推文
      const top = liveList.find(a => 
        a.author && (
          a.author.toLowerCase() === name.toLowerCase() ||
          a.author.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(a.author.toLowerCase())
        )
      ) || liveList[0];

      let targetUrl = top.url || `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(name)}`;
      if (targetUrl && targetUrl.includes('weixin.sogou.com/link')) {
        try {
          const direct = await this.resolveMpUrl(targetUrl, `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(name)}`);
          if (direct && direct.startsWith('http')) targetUrl = direct;
        } catch (eResolve) {}
      }

      return {
        id: `wx_${account.id}_${Date.now()}`,
        title: top.title,
        summary: top.summary,
        url: targetUrl,
        created_at: top.pub_time || new Date().toLocaleString('zh-CN', { hour12: false }),
        pic: top.pic || '',
        author_name: name,
        author_handle: account.wechat_id || name,
        author_avatar: effectiveAvatar
      };
    }

    // 2. 内建代表作或描述兜底 (确保始终展示高质量最新官方内容与正确头像)
    const title = builtin?.sample_article || account.latest_article || `【${name}】最新重点动态与行业专栏推送`;
    const summary = account.desc || `${name} 官方微信公众号最新发布动态已接入实时监控，有新发文将第一时间弹窗提醒。`;

    return {
      id: `wx_${account.id}_fallback`,
      title,
      summary,
      url: builtin?.sample_url || `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(name)}`,
      created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
      pic: '',
      author_name: name,
      author_handle: account.wechat_id || name,
      author_avatar: effectiveAvatar
    };
  }

  getAccountCoolingStatus(screenName) {
    const key = (screenName || '').toLowerCase();
    const info = this.coolingMap.get(key);
    if (!info) return { isCooling: false, remainingSec: 0 };
    const now = Date.now();
    if (info.untilMs > now) {
      return {
        isCooling: true,
        remainingSec: Math.ceil((info.untilMs - now) / 1000)
      };
    }
    this.coolingMap.delete(key);
    return { isCooling: false, remainingSec: 0 };
  }

  /**
   * 轮询所有已订阅微信公众号：采用平滑时间片分发调度（Staggered Round-Robin）
   * 每次主循环心跳仅调度 1 个已到期的公众号，低频温和，杜绝突发流量与风控
   */
  async fetch() {
    if (this.isPolling) return [];
    this.isPolling = true;

    const wechatCfg = this.getWeChatConfig();
    if (!wechatCfg.enabled) {
      this.isPolling = false;
      return [];
    }

    const accounts = Array.isArray(wechatCfg.accounts) ? wechatCfg.accounts : [];
    const enabledAccounts = accounts.filter(a => a && a.enabled !== false && (a.name || a.id));
    if (enabledAccounts.length === 0) {
      this.isPolling = false;
      return [];
    }

    const newAlerts = [];
    let configUpdated = false;

    try {
      const now = Date.now();
      const total = enabledAccounts.length;

      // 单公众号轮询基准间隔：至少 120 秒（建议 180 秒 / 3分钟）
      const targetCycleSec = Math.max(60, wechatCfg.poll_interval_sec || 180);
      const minIntervalMs = targetCycleSec * 1000;

      let selectedAccount = null;
      for (let attempt = 0; attempt < total; attempt++) {
        const idx = (this.roundRobinCursor + attempt) % total;
        const candidate = enabledAccounts[idx];
        const accKey = (candidate.id || candidate.name).toLowerCase();
        const cooling = this.getAccountCoolingStatus(accKey);

        if (cooling.isCooling) {
          continue;
        }

        const lastPolled = this.lastPolledMap.get(accKey) || 0;
        if (now - lastPolled >= minIntervalMs) {
          selectedAccount = candidate;
          this.roundRobinCursor = (idx + 1) % total;
          break;
        }
      }

      if (selectedAccount) {
        const accKey = (selectedAccount.id || selectedAccount.name).toLowerCase();
        this.lastPolledMap.set(accKey, now);

        try {
          const items = await this.pollSingleAccount(selectedAccount);
          if (items && items.length > 0) {
            newAlerts.push(...items);
            configUpdated = true;
          }
        } catch (errOne) {
          logger.warn(`[WeChatFetcher] 轮询公众号 @${selectedAccount.name} 发生异常:`, errOne.message);
        }
      }

      if (configUpdated && this.configManager) {
        this.configManager.saveConfig(this.configManager.config);
      }
    } finally {
      this.isPolling = false;
    }

    return newAlerts;
  }

  async pollSingleAccount(account) {
    const accName = account.name || account.id;
    let articles = [];

    // 优先使用微信公众平台官方 API 轮询 (扫码授权模式，100% 实时精准)
    if (this.isAuthValid() && account.fakeid) {
      try {
        const mpArticles = await this.getMpArticles(account.fakeid, 3);
        if (mpArticles && mpArticles.length > 0) {
          articles = mpArticles.map(a => ({
            title: a.title,
            summary: a.digest || '',
            pub_time: a.create_time ? new Date(a.create_time * 1000).toLocaleString('zh-CN', { hour12: false }) : new Date().toLocaleString('zh-CN', { hour12: false }),
            pub_time_ms: a.create_time ? a.create_time * 1000 : Date.now(),
            pic: a.cover || '',
            url: a.link || '',
            author: accName
          })).filter(a => this.isFreshArticle(a, 72));
        }
      } catch (e) {
        logger.warn(`[WeChatFetcher] MP API 轮询 @${accName} 异常:`, e.message);
      }
    }

    // 若未授权或 MP API 无结果，降级到搜狗抓取
    if (!articles || articles.length === 0) {
      if (account.wechat_id && !account.wechat_id.startsWith('gh_')) {
        const rawIdArts = await this.fetchLiveArticles(account.wechat_id);
        articles = (rawIdArts || []).filter(a => this.isFreshArticle(a, 72));
      }
      if (!articles || articles.length === 0) {
        const rawNameArts = await this.fetchLiveArticles(accName);
        articles = (rawNameArts || []).filter(a => this.isFreshArticle(a, 72));
      }
    }
    if (!articles || articles.length === 0) return [];

    // 优先匹配作者名字与该账号吻合的真实推文
    const latest = articles.find(a => 
      a.author && (
        a.author.toLowerCase() === accName.toLowerCase() ||
        a.author.toLowerCase().includes(accName.toLowerCase()) ||
        accName.toLowerCase().includes(a.author.toLowerCase())
      )
    ) || articles[0];
    const latestUid = `wx_${account.id || account.name}_${Buffer.from(latest.title).toString('base64').substring(0, 16)}`;

    // 首次接入 / 水位线初始化 / 冷启动防护
    if (!account.last_seen_id) {
      account.last_seen_id = latestUid;
      if (this.configManager) this.configManager.saveConfig(this.configManager.config);
      logger.info(`[WeChatFetcher] 公众号 @${accName} 首次加入监控，静默标记水位线: ${latestUid}`);
      return [];
    }

    if (account.last_seen_id === latestUid) {
      return []; // 无最新更新
    }

    // 发现文章变动，更新水位线并持久化
    account.last_seen_id = latestUid;
    if (this.configManager) this.configManager.saveConfig(this.configManager.config);
    if (historyManager.isPushed(latestUid)) return [];

    const pubDate = new Date(latest.pub_time_ms || Date.now());
    const syncDelaySec = Math.max(0, Math.floor((Date.now() - pubDate.getTime()) / 1000));
    const timeStr = pubDate.toLocaleTimeString('zh-CN', { hour12: false });
    const pubTimeStr = pubDate.toLocaleString('zh-CN', { hour12: false });

    // ⏰ 严格时效保护：检测文章是否超出全局允许的最大时效（默认 24 小时）
    const strategy = this.configManager?.config?.rules?.fetching_strategy;
    const maxHours = strategy?.mode === 'unlimited' ? Infinity : (Number(strategy?.max_age_hours) || 24);
    const maxAgeSec = maxHours === Infinity ? Infinity : (maxHours * 3600);

    if (maxAgeSec !== Infinity && syncDelaySec > maxAgeSec) {
      const hoursAgo = (syncDelaySec / 3600).toFixed(1);
      logger.warn(`[WeChatFetcher] 公众号 @${accName} 最新发文《${latest.title}》发布于 ${pubTimeStr}（已过去 ${hoursAgo} 小时），超过时效上限(${maxHours}小时)，属历史旧闻，已静默对齐水位线，跳过推送！`);
      return [];
    }

    // AI 观点分析与利多利空研判
    let aiAnalysis = null;
    if (account.ai_analysis_enabled && this.financialAi) {
      try {
        const textForAi = `${latest.title}\n${latest.summary}`;
        aiAnalysis = await this.financialAi.analyze(textForAi);
      } catch (errAi) {
        logger.warn(`[WeChatFetcher] 公众号 @${accName} 推文 AI 研判异常:`, errAi.message);
      }
    }

    let articleUrl = latest.url || `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(accName)}`;
    if (articleUrl && articleUrl.includes('weixin.sogou.com/link')) {
      try {
        const direct = await this.resolveMpUrl(articleUrl, `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(accName)}`);
        if (direct && direct.startsWith('http')) articleUrl = direct;
      } catch (eResolve) {}
    }

    const alertItem = {
      id: latestUid,
      source: '微信公众号',
      source_key: 'wechat',
      source_name: `微信 ${accName}`,
      author_name: accName,
      author_handle: account.wechat_id || accName,
      author_avatar: this.getAccountAvatar(account),
      account_type: account.type || '订阅号',
      time: timeStr,
      pub_time: pubTimeStr,
      sync_delay_sec: syncDelaySec,
      title: latest.title,
      content: latest.summary || latest.title,
      pic: latest.pic || null,
      pics: latest.pic ? [latest.pic] : [],
      url: articleUrl,
      important: true,
      score: 80,
      ai_analysis: aiAnalysis
    };

    return [alertItem];
  }
}

module.exports = {
  WeChatFetcher,
  BUILTIN_WECHAT_ACCOUNTS
};
