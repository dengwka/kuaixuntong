# 术语表 (GLOSSARY.md)

本文档记录「快讯通」系统的核心业务概念、实体术语与数据定义，确保方案设计、代码实现与用户认知保持高度一致。

---

## 核心实体与概念

### 1. 资讯重要性分级 (Alert Importance Tier)
* **官方重要快讯 (Official Important Flash)**: 金十等数据源官方编辑部人工标红置顶、标记 `important === 1` 的重大突发与深度头条，在客户端享有最高展示优先级。
* **重磅宏观指标 (High-Star Macro Indicator)**: 财经日历中星级大于等于三星（`star >= 3`）的权威经济数据（如非农、CPI、央行利率决议），两星及以下视为日常背景杂音。
* **常规快讯 (Routine Flash)**: 金十等普通黑字行情波动与常规公告（`important === 0`），只在“全部快讯”模式下流转。

### 2. 存储自清理策略 (Storage Auto-Cleanup)
* **时间滚动保留 (Time-based Retention)**: 依据记录的生成时间戳（`pushed_at` / 日志时间），自动物理清理超过保留周期（默认 3 天）的历史日志与落盘条目。
* **体积阈值截断 (Size-based Rotation)**: 当单份数据文件（`pushed_history.json`）或日志文件（`app_runtime.log`）超过体积阈值（默认 10MB）时，触发安全滚动截断，保留最新头部记录。

### 3. 多源资讯聚合 (Multi-Source Feeds)
* **雪球 7x24 (Xueqiu Live Feed)**: 覆盖股票投资、二级市场行情与大V热度异动的 7x24 敏捷快讯流，支持标红加精（`mark === 1`）识别。
* **脉脉职言 (Maimai Gossip/Company Trends)**: 聚焦中概科技、金融与知名企业的员工内部爆料、裁员重组与人事动向等第一手商业情报。

### 4. 𝕏 (Twitter) 情报订阅源 (X Monitored Feed)
* **博主档案预检 (Account Profile Resolution)**: 基于用户输入的 handle（如 `elonmusk`），在保存订阅前通过官方 Syndication 服务即时校验用户真实性，并预取头像 (`avatar_url`)、显示昵称 (`name`)、唯一标识与最新推文快照。
* **推文类型过滤 (Tweet Categorization & Filtering)**:
  - **原创推文 (Original Tweet)**: 博主独立撰写发布的推文，默认开启推送。
  - **转发推文 (Retweet / Quote)**: 博主转发或引用他人的推文，默认开启推送。
  - **互动回复 (Reply)**: 博主在他人推文下的对话回复，默认静默过滤，支持高级开关自选。
* **双通道翻译管道 (Dual-Channel Translation Pipeline)**:
  - **语义精准翻译 (LLM Contextual Translation)**: 优先经由已集成的 DeepSeek / 智谱大模型，保留金融缩写、俚语与专业语境翻译为地道中文。
  - **基础兜底翻译 (Fallback Machine Translation)**: 在未配置大模型 API Key 或模型网络超时（默认 6 秒）时，无缝降级为轻量免配置翻译引擎。

### 5. 𝕏 平台风控与冗余调度 (X Anti-Scraping & Resilience Architecture)
* **精确重置退避 (Precise Rate-Limit Backoff)**: 针对 HTTP 429 响应，优先解析服务端下发的 `x-rate-limit-reset` UNIX 时间戳，计算出精确剩余休眠时间进入熔断冷却；无标头时按指数递增退避（30s ➔ 60s ➔ 120s）。
* **心跳随机抖动 (Heartbeat Jitter)**: 在预设轮询基准间隔上注入随机时间浮动（±15%），消除固定周期机器爬虫特征。
* **三级冗余采集矩阵 (Three-Tier Ingestion Fallback)**:
  - **L1 官方免登录通道 (Primary Syndication)**: 默认主通道，免登录、免配置、零门槛。
  - **L2 公开镜像/网关冗余 (Secondary Mirror/RSS Gateway)**: 当 L1 遭遇区域性 CDN 拦截时，无缝切换至公共/备用 RSSHub 协议探活。
  - **L3 私有凭据深潜扩展 (Tertiary Auth-Token Slot)**: 可选槽位，允许高级用户填入个人 `auth_token` Cookie 切换为官方 Web GraphQL 原生高限额通道。
* **单账号故障域隔离 (Account-level Fault Domain Isolation)**: 每一个被订阅账号拥有独立的健康度状态机与退避计时器，单个账号被限流绝不波及其他账号的实时轮询。
