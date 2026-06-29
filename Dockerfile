FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    gcc \
    ca-certificates \
    git \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages requests

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

CMD ["node", "server.js"]
