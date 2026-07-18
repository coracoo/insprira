// 小红书 MCP HTTP API 客户端
// 调 xpzouying/xiaohongshu-mcp 的 /api/v1/* 端点
// 参数化 baseUrl，无状态，由 service 层负责配置持久化和缓存
//
// 文档：https://github.com/xpzouying/xiaohongshu-mcp/blob/master/docs/API.md

const DEFAULT_TIMEOUT = 20000;

async function request(baseUrl, path, options = {}) {
  const url = `${String(baseUrl).replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || DEFAULT_TIMEOUT),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const err = new Error(payload?.error || payload?.message || `xhs-mcp HTTP ${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

module.exports = {
  health(baseUrl) {
    return request(baseUrl, '/health');
  },
  getLoginStatus(baseUrl) {
    return request(baseUrl, '/api/v1/login/status');
  },
  getLoginQrcode(baseUrl) {
    return request(baseUrl, '/api/v1/login/qrcode');
  },
  deleteCookies(baseUrl) {
    return request(baseUrl, '/api/v1/login/cookies', { method: 'DELETE' });
  },
  publish(baseUrl, payload) {
    return request(baseUrl, '/api/v1/publish', { method: 'POST', body: payload });
  },
  publishVideo(baseUrl, payload) {
    return request(baseUrl, '/api/v1/publish_video', { method: 'POST', body: payload });
  },
  listFeeds(baseUrl) {
    return request(baseUrl, '/api/v1/feeds/list');
  },
  searchFeeds(baseUrl, payload) {
    return request(baseUrl, '/api/v1/feeds/search', { method: 'POST', body: payload });
  },
  getFeedDetail(baseUrl, payload) {
    return request(baseUrl, '/api/v1/feeds/detail', { method: 'POST', body: payload });
  },
  getUserProfile(baseUrl, payload) {
    return request(baseUrl, '/api/v1/user/profile', { method: 'POST', body: payload });
  },
  getMyProfile(baseUrl) {
    return request(baseUrl, '/api/v1/user/me');
  },
  postComment(baseUrl, payload) {
    return request(baseUrl, '/api/v1/feeds/comment', { method: 'POST', body: payload });
  },
  replyComment(baseUrl, payload) {
    return request(baseUrl, '/api/v1/feeds/comment/reply', { method: 'POST', body: payload });
  },
};
