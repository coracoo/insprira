# 灵感熔炉

本地自媒体工作台。

## 功能

- 热榜与趋势：多平台实时聚合
- 选题生成、账号追踪、知识库、内容创作
- 容器化部署

## 启动

需 Node.js ≥ 20 或 Docker。

### Docker

```bash
cp .env.example .env
# 填写 .env
docker compose up -d
```

镜像：[`ghcr.io/coracoo/insprira`](https://github.com/coracoo/insprira/pkgs/container/insprira)

### 本地

```bash
npm install
cp .env.example .env
npm start
```

## 配置

见 [`.env.example`](.env.example)。

## License

[AGPL-3.0](LICENSE)
