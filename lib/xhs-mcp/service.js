// 小红书 MCP 业务服务：配置 CRUD、健康检查、登录态管理
// client 调 xpzouying/xiaohongshu-mcp 的 HTTP API
// 上层 routes/xhs-mcp.js 只与本模块交互，不直接调 client
const { db } = require('../db');
const client = require('./client');

const LOGIN_STATUS = {
  UNKNOWN: 'unknown',
  LOGGED_IN: 'logged_in',
  LOGGED_OUT: 'logged_out',
};

// Docker compose 内网地址（compose 侧配 XHS_MCP_URL=http://xiaohongshu-mcp:18060）
// 如果用户没在设置页手动填 base_url，自动用这个默认值（内网可达时生效）
const DEFAULT_BASE_URL = (process.env.XHS_MCP_URL || '').trim();

function getBaseUrl() {
  const row = getConfigRow();
  if (row) return row.base_url;
  return DEFAULT_BASE_URL || null;
}

function getConfigRow() {
  return db.prepare('SELECT * FROM xhs_mcp_config WHERE id = 1').get();
}

// 脱敏返回给前端
function getPublicConfig() {
  const row = getConfigRow();
  const defaultUrl = DEFAULT_BASE_URL || null;
  if (!row) {
    return {
      configured: Boolean(defaultUrl),
      enabled: Boolean(defaultUrl),
      baseUrl: defaultUrl || '',
      mcpUrl: defaultUrl ? `${defaultUrl}/mcp` : '',
      loginStatus: LOGIN_STATUS.UNKNOWN,
      autoDetected: Boolean(defaultUrl),
    };
  }
  return {
    configured: true,
    enabled: Boolean(row.enabled),
    baseUrl: row.base_url,
    mcpUrl: row.mcp_url || '',
    loginStatus: row.login_status || LOGIN_STATUS.UNKNOWN,
    healthCheckedAt: row.health_checked_at,
    updatedAt: row.updated_at,
    autoDetected: false,
  };
}

// 业务调用前断言：未配置或禁用抛错
function assertEnabled() {
  const row = getConfigRow();
  if (row) {
    if (!row.enabled) throw new Error('小红书 MCP 接入已禁用');
    return row;
  }
  // 无 DB 记录时，默认通过 env var
  if (DEFAULT_BASE_URL) return { base_url: DEFAULT_BASE_URL };
  throw new Error('小红书 MCP 接入未配置');
}

// 复用 checkHealth 中需要 getBaseUrl 的地方
async function checkHealth() {
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error('小红书 MCP 接入未配置');
  let result;
  try {
    result = await client.health(baseUrl);
  } catch (e) {
    updateLoginStatus(LOGIN_STATUS.UNKNOWN);
    return { healthy: false, error: e.message };
  }
  const data = result?.data || result || {};
  let loginStatus = LOGIN_STATUS.UNKNOWN;
  try {
    const status = await client.getLoginStatus(baseUrl);
    const isLoggedIn = Boolean(status?.data?.is_logged_in);
    loginStatus = isLoggedIn ? LOGIN_STATUS.LOGGED_IN : LOGIN_STATUS.LOGGED_OUT;
  } catch (e) {
    loginStatus = LOGIN_STATUS.UNKNOWN;
  }
  updateLoginStatus(loginStatus);
  return { healthy: true, serviceStatus: data.status, account: data.account, loginStatus };
}

// 保存配置（首次或更新）
function saveConfig({ baseUrl, mcpUrl, enabled }) {
  const now = Date.now();
  const existing = getConfigRow();
  const next = {
    base_url: String(baseUrl).trim().replace(/\/$/, ''),
    mcp_url: mcpUrl ? String(mcpUrl).trim().replace(/\/$/, '') : null,
    enabled: enabled === false ? 0 : 1,
  };
  if (!next.base_url) throw new Error('baseUrl 不能为空');
  if (!existing) {
    db.prepare(`
      INSERT INTO xhs_mcp_config (id, base_url, mcp_url, enabled, login_status, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run(next.base_url, next.mcp_url, next.enabled, LOGIN_STATUS.UNKNOWN, now);
  } else {
    db.prepare(`
      UPDATE xhs_mcp_config
      SET base_url = ?, mcp_url = ?, enabled = ?, updated_at = ?
      WHERE id = 1
    `).run(next.base_url, next.mcp_url, next.enabled, now);
  }
  return getPublicConfig();
}

function updateLoginStatus(status) {
  const now = Date.now();
  db.prepare(`
    UPDATE xhs_mcp_config
    SET login_status = ?, health_checked_at = ?, updated_at = ?
    WHERE id = 1
  `).run(status, now, now);
}

// 透传 client：所有调用前先 assertEnabled
async function callWithConfig(fn) {
  const row = assertEnabled();
  return fn(row.base_url);
}

module.exports = {
  LOGIN_STATUS,
  getPublicConfig,
  getConfigRow,
  assertEnabled,
  saveConfig,
  updateLoginStatus,
  checkHealth,
  // 透传 client API（业务层薄包装）
  getLoginStatus: () => callWithConfig(client.getLoginStatus),
  getLoginQrcode: () => callWithConfig(client.getLoginQrcode),
  deleteCookies: () => callWithConfig(client.deleteCookies),
  publish: (payload) => callWithConfig((baseUrl) => client.publish(baseUrl, payload)),
  publishVideo: (payload) => callWithConfig((baseUrl) => client.publishVideo(baseUrl, payload)),
  listFeeds: () => callWithConfig(client.listFeeds),
  searchFeeds: (payload) => callWithConfig((baseUrl) => client.searchFeeds(baseUrl, payload)),
  getFeedDetail: (payload) => callWithConfig((baseUrl) => client.getFeedDetail(baseUrl, payload)),
  getUserProfile: (payload) => callWithConfig((baseUrl) => client.getUserProfile(baseUrl, payload)),
  getMyProfile: () => callWithConfig(client.getMyProfile),
  postComment: (payload) => callWithConfig((baseUrl) => client.postComment(baseUrl, payload)),
  replyComment: (payload) => callWithConfig((baseUrl) => client.replyComment(baseUrl, payload)),
};
