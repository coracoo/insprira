# syntax=docker/dockerfile:1
FROM node:22-slim

# better-sqlite3 需要编译原生模块；unzip 用于 Skill 一键更新；
# python3-pip 用于给 skill 脚本装第三方包（Debian 12 PEP 668 需 --break-system-packages）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    gcc \
    ca-certificates \
    git \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# skill 脚本目前用到的第三方 Python 包只有 requests（已扫过所有 skill 脚本）
RUN pip3 install --no-cache-dir --break-system-packages requests

WORKDIR /app

# 先复制依赖文件，利用 Docker 层缓存
COPY package*.json ./
RUN npm ci --only=production \
 && npm install nodemon --no-save

# 复制应用代码（bind mount 会覆盖个别文件用于热更新）
COPY . .

# 数据目录：SQLite 数据库和日志建议挂载到此目录
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

# 默认监听端口
EXPOSE 8080

# nodemon -L = 强制轮询模式，穿透 Docker bind mount 检测文件变化
CMD ["node", "server.js"]
