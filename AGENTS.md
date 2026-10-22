# 快讯通 - 开发与 GitHub 发布工作流规范

## 1. 核心开发工作区
- 日常所有 AI 代码修改、功能调试、测试与维护均在 `D:\antigravity\桌面提示小工具` 目录中进行。

## 2. “更新到github” 自动化流程规范
- 当用户指示“更新到github”或类似同步需求时，严格执行以下两步自动化流程：
  1. **代码同步与安全排除**：
     将 `D:\antigravity\桌面提示小工具` 的最新源码安全同步覆盖到 `D:\antigravity\kuaixuntong`，并**严格排除以下目录与文件**：
     - `node_modules/`
     - `release/`
     - `log/` 与 `logs/`
     - `data/`
     - `.git/`（保留 kuaixuntong 自身原有的 git 元数据）
     - 私人研究报告及本地临时调试文件
  2. **Git 提交并推送**：
     进入 `D:\antigravity\kuaixuntong` 目录，检查 `git status`，执行标准 commit 并自动 `git push origin main` 推送至 GitHub。
