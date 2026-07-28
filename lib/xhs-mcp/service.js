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

// CLI 二进制安装路径（data 卷内，迁移带走）
const path = require('path');
const fs = require('fs');
const CLI_BIN_DIR = path.join(__dirname, '..', '..', 'data', 'xhs-mcp', 'bin');
const CLI_BIN = 'xiaohongshu-mcp';
const CLI_BIN_PATH = path.join(CLI_BIN_DIR, CLI_BIN);

const GITHUB_TOKEN = (process.env.GITHUB_API_TOKEN || '').trim();

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
  // ========== CLI 安装管理 ==========
  // 返回 CLI 状态：已安装 / 版本 / 安装路径 / 启动命令
  getCliStatus() {
    const installed = fs.existsSync(CLI_BIN_PATH);
    let version = null;
    if (installed) {
      try {
        version = require('child_process').execFileSync(CLI_BIN_PATH, ['--version'], { timeout: 5000 }).toString().trim();
      } catch {}
    }
    return {
      installed,
      version: version || null,
      binPath: CLI_BIN_PATH,
      binDir: CLI_BIN_DIR,
      // 启动命令（宿主机用，DATA_DIR=/data → 宿主机上 ./data/xhs-mcp/...）
      startCommand: `./data/xhs-mcp/bin/xiaohongshu-mcp --cookies-path ./data/xhs-mcp/data/cookies.json`,
      downloadUrl: 'https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download/xiaohongshu-mcp-linux-amd64',
    };
  },
  // 从 GitHub 下载最新版 CLI 二进制到 data/xhs-mcp/bin/
  async installCli() {
    const apiUrl = 'https://api.github.com/repos/xpzouying/xiaohongshu-mcp/releases/latest';
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'insprira' };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

    // 查询 release
    let releaseRes;
    try {
      releaseRes = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) });
    } catch (e) { throw new Error(`查询 release 失败：${e.message}`); }
    if (!releaseRes.ok) throw new Error(`GitHub API ${releaseRes.status}`);
    const release = await releaseRes.json();
    const asset = (release.assets || []).find(a => a.name === 'xiaohongshu-mcp-linux-amd64');
    if (!asset) throw new Error(`未找到 Linux 二进制（tag ${release.tag_name}）`);

    // 创建目录 + 下载
    if (!fs.existsSync(CLI_BIN_DIR)) fs.mkdirSync(CLI_BIN_DIR, { recursive: true });
    const tmpPath = CLI_BIN_PATH + '.download';
    let dlRes;
    try {
      dlRes = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'insprira' }, signal: AbortSignal.timeout(120000) });
    } catch (e) { throw new Error(`下载失败：${e.message}`); }
    if (!dlRes.ok) throw new Error(`下载 HTTP ${dlRes.status}`);

    const buf = Buffer.from(await dlRes.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, CLI_BIN_PATH);
    fs.chmodSync(CLI_BIN_PATH, 0o755);
    return { installed: true, binPath: CLI_BIN_PATH, version: release.tag_name, size: asset.size };
  },
};
