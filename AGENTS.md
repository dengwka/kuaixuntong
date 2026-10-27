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

## 3. 功能开发与发布纪律（用户强制要求）
- **本地测试优先，严禁提前提交与发布**：
  - 在日常开发新功能或修复问题时，仅在本地工作区完成代码编写、自检或本地打包测试。
  - **严禁擅自提前提交代码（Git commit）、推送（Git push）或打 Tag 发布**。
  - **必须等待用户在本地充分测试验证通过，并显式给出“提交”、“发布”或“更新到github”等明确指令后，方可执行提交与发布流程**。
