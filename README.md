# 灵感熔炉

基于 [RedFox API](https://redfox.hk/invite?invitationCode=774T2BJn) 的本地自媒体工作台。

## 更新

- **创作助手支持联网**：基于主题/大纲创作时，可调用联网搜索补全实时信息
- **一键导出到知识库**：重构后的成稿可直接导出到 Obsidian 或 Notion，源在导出按钮旁选择
- **Skill 分类扩展**：新增 帐号 / 信息源 两个分类，覆盖热门账号榜单、内容聚合源等场景
- **热榜支持更多源**：短剧、公众号 / 抖音 TOP10、文旅等 Skill 可绑定为热榜 Tab
- **错误日志**：服务异常会写入 `~/.inspira-errors.log` 便于排查

## 功能

- **热榜与趋势**：全网热点、抖音 / 小红书 / 公众号热榜、AI 公众号 / AI B站 / AI 小红书 / AI 抖音 / AI 快手 / AI 视频号 / 短剧抖音 / 短剧公众号昨日榜；7/14 天增长、稳定、冷却趋势
- **Skill 中心**：从 [redfox-community](https://github.com/redfox-community/skills) 拉取并热更新；支持 LLM 自动分类（热点 / 创作 / 分析 / 检索 / 生成工具）；热点 Skill 可一键绑定到热榜 Tab
- **热榜动态 Tab**：默认只显示抖音 / 小红书 / 公众号 3 个基础 Tab，其余平台通过 Skill 绑定后动态创建，解绑即移除
- **选题生成**：基于本地热榜证据 + 公众号爆款搜索，调用 OpenAI 兼容 LLM 生成选题
- **账号追踪**：分组订阅、作品同步、公众号 / 抖音 / 小红书诊断、趋势图表（粉丝 / 红狐指数 / 评分 / 作品数）
- **知识库**：Obsidian / Notion 双源接入 + WeRss（we-mp-rss）公众号文章同步
- **内容重构**：多平台改写、RedFox `gpt-image-2` 封面生成、违禁词检测
- **本地 Agent**：Codex / Claude Code / Kimi / OpenClaw / Hermes 子进程集成
- **CRON 调度**：内置每日热榜快照、缓存清理、WeRss 同步、账号追踪刷新等任务；支持自定义、拖拽排序
- **Docker 部署**：Dockerfile + Docker Compose，支持 linux/amd64 与 linux/arm64

## 本地启动

Node.js ≥ 20：

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 REDFOX_API_KEY、LLM_API_KEY、KB_ENCRYPTION_KEY
npm start
```

首次启动创建默认账号 `admin / 123456`，登录后请立即在「账户与安全」修改密码。

## Docker 部署

```bash
cp .env.example .env
docker compose up -d
```

数据挂载到 `./data`（SQLite 数据库、日志）。

## 配置

必填字段见 [`.env.example`](.env.example)：

- `REDFOX_API_KEY` — RedFox API Key
- `LLM_API_KEY` — OpenAI 兼容 LLM Key（选题生成、热点分析）
- `KB_ENCRYPTION_KEY` — 加密密钥，用 `openssl rand -hex 32` 生成

## License

[AGPL-3.0](LICENSE)
