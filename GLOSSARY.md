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
