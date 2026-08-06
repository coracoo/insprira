# AGENTS.md

> 本文件面向 AI 编程助手，介绍「灵感熔炉」(insprira) 项目的架构、命令与开发约定。仓库内注释与文档以中文为主。

## 项目概览

灵感熔炉是一个**本地自媒体工作台**（单用户、自托管 web 应用）。核心功能：全网热榜聚合与趋势分析、基于 LLM 的选题生成、账号追踪与诊断、Obsidian/Notion/WeRss 知识库、多平台内容改写、本地 Agent（Codex / Claude Code / Kimi 等子进程）集成、CRON 定时调度。

它是一个「重后端单进程 + 无构建前端」的应用：

- **后端**：`server.js`（Node.js CommonJS，原生 `http` 模块，无 Express）。既是静态文件服务器，又是 RedFox API 代理（带 SQLite 缓存与允许列表），也是本地业务 API（`/api/_/*`）的宿主，还内置 CRON 调度器。
- **前端**：单页应用，`index.html` + 原生 ES Module（`js/app.js` 为入口，无打包器、无框架），Tailwind CSS 需手动编译产物，第三方库（Chart.js / lucide / marked / DOMPurify）以 `vendor/` 下的静态文件直接 `<script>` 引入。
- **存储**：better-sqlite3，数据库文件默认在 `data/cache.db`（WAL 模式）。schema 由 `lib/db.js` 在启动时 `CREATE TABLE IF NOT EXISTS` 创建，`ensureColumn` 做增量列迁移；`server.js` 顶部还有若干启动期数据迁移脚本。
- **License**：AGPL-3.0。

## 技术栈与运行时

- Node.js **≥ 20**（`.nvmrc` 指定 20；Docker 镜像用 node:24-slim）。
- `package.json` 为 `"type": "commonjs"`：后端全部 `require()`；前端 `js/` 是浏览器 ES Module，两者不要混用。
- npm 依赖：`better-sqlite3`、`puppeteer-core`（生产；后者用于公众号白名单自动配置，驱动系统 Chrome 不自带浏览器）、`tailwindcss`（dev）。
- 外部依赖：RedFox API（`REDFOX_API_KEY` 必填）、任意 OpenAI 兼容 LLM（`LLM_*` 配置）、可选 GitHub token（Skill 更新）、可选本地 Agent CLI、可选 xiaohongshu-mcp 容器。
- 时区：启动早期把 `process.env.TZ` 设为 `USER_TIMEZONE`（默认 `Asia/Shanghai`），影响 cron 与 `data_date` 边界，新增日期逻辑时需注意。

## 目录结构与模块划分

```
server.js            # 入口：HTTP server、路由分发、CRON 调度器、启动期迁移、部分业务函数
lib/                 # 后端核心模块（CommonJS）
  db.js              #   SQLite 单例 + schema + ensureColumn；导出 { db, ensureColumn, DATA_ROOT, DB_PATH }
  redfox.js          #   RedFox API 代理 + 端点允许列表 + SQLite 缓存
  auth.js            #   会话（内存 Map）、Cookie、知识库凭证 AES-256-GCM 加解密
  password.js        #   scrypt 密码哈希与校验
  llm.js             #   OpenAI 兼容 chat.completions 封装（.make() 工厂注入工具函数）
  hot.js             #   热榜同步/快照/趋势/日报（.make() 工厂）
  skills.js          #   Skill 中心：社区仓库拉取、分类、自定义 Skill、Hub（.make() 工厂）
  agent.js           #   本地 Agent 子进程适配（.make() 工厂）
  article-analysis.js #  文章级表现分析：账号基线对比 + RedFox 正文 + LLM 逐篇诊断（.make() 工厂）
                     #   含 48h 成熟门槛、数据更新重算、XHS 账号经 xhs-mcp 拉准实时互动数据
  dashboard-overview.js # 运营总览：跨账号 KPI/问题分布（含周趋势）/文章诊断聚合 + LLM 运营总结（.make() 工厂）
                     #   周闭环：行动项落 weekly_actions 表可勾选，下周总结带上周回顾+行动后新发文表现验证
  wechat-official.js #  微信公众平台官方 datacube 数据源：认证号 T+1 权威阅读数据（.make() 工厂）
  mp-whitelist.js    #   公众号 IP 白名单自动配置：puppeteer-core 驱动控制台 + 扫码核验（40164 自救）
  work-stats.js      #   单篇作品指标时间序列（work_stats_history 表）：tracker 同步/插件上报/XHS 拉取都追加点
  tracker.js inspiration.js rewrite.js wersss.js notifications.js observability.js ...
  routes/            #   HTTP 路由组，每个文件导出 tryRoute(req, res, url, ctx)，
                     #   命中则处理并返回 true；由 server.js 的 handleLocalApi 依次尝试
  xhs-mcp/           #   小红书 MCP 服务封装
kb_obsidian.js kb_notion.js kb_wersss.js   # 知识库三源适配器（仓库根目录，历史遗留位置）
extension/           # 浏览器插件（无构建，MV3）
  mp-stats/          #   公众号后台数据同步：用户日常浏览器真人会话抓「内容分析」→ POST /api/_/ingest/mp-stats
js/                  # 前端（浏览器 ES Module）
  app.js             #   入口，聚合各 page 模块并注册到 window
  router.js state.js api.js config.js components.js icons.js theme.js ...
  core/              #   平台适配器（adapters.js）、列表渲染、条目缓存
  pages/             #   每个页面对应一个文件：dashboard/hotlist/inspiration/tracker/
                     #   knowledgebase/creator/settings/agent/my/search/detail
css/                 # tailwind-input.css → 编译出 tailwind.css；styles.css 为手写样式
vendor/              # 前端第三方库静态文件（不经过 npm）
test/                # node:test 测试
data/                # 运行时数据（cache.db、skills/、agent-home/、xhs-mcp/、mp-console-profile/ 公众号控制台登录态），已 gitignore
```

## 常用命令

```bash
npm install             # 安装依赖
npm run dev             # node --watch server.js，改代码热重启
npm start               # node server.js
npm run build           # 编译 Tailwind：css/tailwind-input.css → css/tailwind.css（--minify）
npm run check           # node --check server.js 语法检查
npm test                # node --test，跑 test/ 下全部测试
node --test test/utils.test.js   # 跑单个测试文件
./start.sh {start|stop|restart|status|logs}   # 本地后台运行（nohup + PID 文件）
```

改了 `index.html` 或 `js/**` 中的 Tailwind class 后需要重跑 `npm run build`，否则样式不生效。

## 运行与部署

- **配置**：`cp .env.example .env` 后填写。`server.js` 直接读 `.env` 文件（`lib/env.js`），并用 `fs.watch` 热加载变更——改 `.env` 不必重启（Docker compose `environment` 段设置的变量优先，不会被覆盖）。
- **Docker**：`docker compose up -d`（首次需 `docker compose build`）。当前唯一的 `docker-compose.yaml` 就是 dev 取向的配置——源码挂载 `./:/app` + `node --watch server.js` 热重启，数据落在 `./data/`。（README 提到的 `docker-compose.dev.yaml` / `docker-compose.local-agents.yaml` 在仓库中并不存在。）Dockerfile 为两阶段构建（builder 编 better-sqlite3 native binding，runtime 只留 python3/git/unzip），发布镜像在 `ghcr.io/coracoo/insprira`。
- **CI/CD**：`.github/workflows/docker.yml` 在 push 到 main/master 或 `v*` tag 时构建并推送 linux/amd64 + linux/arm64 镜像；`release.yml` 在 `v*` tag 时创建 GitHub Release。
- **Agent 接入**：三种模式（本地映射 / sbx microVM / 容器内安装），详见 `.env.example` 与 `docker-compose.yaml` 内注释。`docker-entrypoint.sh` 把容器内 HOME 重定向到 `/data/agent-home` 并从 `/seed/` 同步宿主 CLI 凭证。
- 首次启动自动创建默认账号 `admin / 123456`（`must_change_password=1`），登录后应立即修改。

## 代码约定

- **语言**：注释、日志、提交信息、文档均为中文；保持这一惯例。
- **风格**：2 空格缩进、LF、UTF-8（见 `.editorconfig`）；无 ESLint/Prettier，以 `npm run check` 与现有代码风格为准。
- **模块模式**：
  - 后端 `lib/*.js` 用 CommonJS。有外部依赖（业务函数、定时器、配置）的模块用 **`.make(deps)` 工厂**注入（如 `lib/llm.js`、`lib/skills.js`、`lib/hot.js`），避免循环依赖和硬耦合；纯工具模块直接导出函数。
  - 路由全部走 `lib/routes/*.js` 的 `tryRoute(req, res, url, ctx)` 模式：返回 `true` 表示已处理。新增接口时在对应路由组里加分支，并在 `server.js` 的 `handleLocalApi` 的 `ctx` 参数里传入所需依赖。本地业务 API 路径前缀为 `/api/_/`；`/api/<endpoint>` 是 RedFox 透传代理，仅 POST 且端点必须在 `lib/redfox.js` 的 `REDFOX_ENDPOINTS` 允许列表中。
  - 前端每页一个 `js/pages/*.js`，导出渲染/事件函数，由 `js/app.js` import 后挂到 `window` 供内联 `onclick` 调用；全局状态在 `js/state.js`，平台数据结构适配在 `js/core/adapters.js`。
- **数据库**：所有 SQL 用 better-sqlite3 预编译语句；时间戳一律用毫秒整数（`Date.now()`）；多步写入包 `db.transaction()`；加列用 `ensureColumn`，不要改已有 `CREATE TABLE` 之外的破坏性迁移。
- **`.env` 读取**：运行时读取配置优先用 `readEnvValues(ENV_FILE)`（直接读文件）而非 `process.env`，保证用户改文件后立即生效（参考 `server.js` 中 `getOfficialQuota` 的写法）。

## 测试策略

- 使用 Node 内置 `node:test` + `node:assert/strict`，无第三方测试框架。
- `test/_helper.js`：纯函数测试的引导——把 `DATA_DIR` 指到 `os.tmpdir()` 下每进程独立目录、`ENABLE_SCHEDULER=false`，再 `require('../server.js')`。纯函数测试通过它取模块，避免污染真实 `data/cache.db`。
- `test/_server.js`：路由级集成测试引导——额外屏蔽 LLM/RedFox 等密钥 env，把真实 `server` 监听在随机端口，提供 `boot()/close()/req()`。`test/routes.test.js`、`test/auth.test.js` 走这条路。
- 新增后端逻辑时：纯函数放 `lib/utils.js` 之类模块并配 `test/*.test.js`；新增路由应配路由级集成测试。运行 `npm test` 全量验证。

## 安全注意事项

- `.env`、`cookies.json`、`data/` 均含密钥/登录态，已 gitignore，**绝不提交**；也不要把真实密钥写进代码或测试。
- 知识库凭证（Notion key 等）用 `KB_ENCRYPTION_KEY` 做 AES-256-GCM 加密后入库（`lib/auth.js` 的 `encryptKb/decryptKb`）；该 key 一旦配置不可更换，否则旧数据无法解密。
- 会话 Cookie 为 `HttpOnly; SameSite=Strict`；除 `/api/_/login|status|version` 外所有 `/api/` 接口都要求登录。新增公开接口需明确意识到这是绕过鉴权。
- `/api/_/ingest/mp-stats` 是唯一的 token 鉴权公开接口（浏览器插件跨源带不了会话 Cookie）：`INGEST_TOKEN` 放 `.env`，路由内校验 `X-Ingest-Token` 头；该 token 泄露等于任何人可写入作品数据，按密码对待。
- RedFox 透传代理有端点允许列表 + `MAX_BODY_SIZE` 限制（`lib/http.js`），新增端点务必加进允许列表而不是放开通配。
- 前端渲染用户/外部内容时用 `js/utils.js` 的 `esc()`、markdown 经 `renderMarkdown`（marked + DOMPurify），不要直接拼 `innerHTML`。
- 密码用 scrypt（`lib/password.js`），有用户名/密码强度校验，新增认证相关代码请复用。
