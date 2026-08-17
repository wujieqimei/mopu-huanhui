# 茶裙画隅 · 抹茶与女仆幻像

纯前端 AI 绘画画廊（HTML/CSS/JS + GitHub Pages），由 WorkBuddy 构建。

- 主题：茶裙画隅
- Slogan：一隅画廊，抹茶与女仆幻像
- 管理员入口：双击标语中的「幻」字（或 URL 加 `?admin`），密码 `725725`
- 数据存储：**直接写入 GitHub 仓库**（`data/artworks.json` + `assets/uploads/`），不依赖浏览器本地库，防丢失、全员实时同步
  - 图片与提示词通过 GitHub Contents API 落库；访客刷新即可见（Pages 重建约 1 分钟）
  - 浏览器 IndexedDB 仅作本地即时预览缓存
  - GitHub 写入 Token 由管理员在画廊点「⚙ 仓库」粘贴，**仅存本浏览器 localStorage，绝不进源码**

部署：GitHub Pages（main 分支）。以后更新内容只需重新推送 main 分支，固定域名自动刷新。
