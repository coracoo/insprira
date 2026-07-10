// 路由组：登录/登出/status/version/redfox-apply/account/env
// 这些路由依赖很少（auth/db/password/redfox/env/http），适合首先拆出
// 由 handleLocalApi 调用 try(req, res, url, ctx)，返回 true 表示已处理
const crypto = require('crypto');
const { db } = require('../db');
const {
  sessionSet, sessionDel, getCookies, currentSession, publicUser,
  sessions, KB_ENC_INSECURE,
} = require('../auth');
const { verifyPassword, validateUsername, validatePassword, hashPassword } = require('../password');
const { API_KEY } = require('../redfox');
const { publicEnvConfig, updateEnvConfig } = require('../env');
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const { APP_VERSION, ENABLE_SCHEDULER, ENV_FILE } = ctx;

  if (url.pathname === '/api/_/login' && req.method === 'POST') {
    const { data } = await readBody(req);
    const username = String(data.username || '').trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user || !verifyPassword(data.password || '', user.password_hash)) {
      json(res, 401, { ok: false, error: '用户名或密码错误' });
      return true;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = 7 * 24 * 60 * 60;
    const now = Date.now();
    sessionSet(token, user.id, now + maxAge * 1000);
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    json(res, 200, { ok: true, data: { authenticated: true, user: publicUser(updatedUser) } }, {
      'Set-Cookie': `furnace_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
    });
    return true;
  }

  if (url.pathname === '/api/_/logout' && req.method === 'POST') {
    const token = getCookies(req).furnace_session;
    if (token) sessionDel(token);
    json(res, 200, { ok: true }, {
      'Set-Cookie': 'furnace_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    return true;
  }

  if (url.pathname === '/api/_/status' && req.method === 'GET') {
    const auth = currentSession(req);
    // Notion 凭证存在 kb_config 表里（不是 env），单独查
    const kbRow = require('../db').db.prepare('SELECT notion_api_key FROM kb_config LIMIT 1').get();
    json(res, 200, {
      ok: true,
      version: APP_VERSION,
      redfoxConfigured: Boolean(API_KEY),
      llmConfigured: Boolean(process.env.LLM_API_KEY),
      githubConfigured: Boolean(String(process.env.GITHUB_API_TOKEN || '').trim()),
      notionConfigured: Boolean(kbRow?.notion_api_key),
      schedulerEnabled: ENABLE_SCHEDULER,
      authRequired: true,
      authenticated: Boolean(auth),
      user: auth ? publicUser(auth.user) : null,
      kbEncryptionInsecure: KB_ENC_INSECURE,
    });
    return true;
  }

  if (url.pathname === '/api/_/version' && req.method === 'GET') {
    json(res, 200, { ok: true, version: APP_VERSION });
    return true;
  }

  if (url.pathname === '/api/_/redfox/apply' && req.method === 'GET') {
    json(res, 200, { ok: true, url: String(process.env.REDFOX_APPLY_URL || '').trim() });
    return true;
  }

  if (url.pathname === '/api/_/account' && req.method === 'GET') {
    const auth = currentSession(req);
    json(res, 200, { ok: true, data: publicUser(auth.user) });
    return true;
  }

  if (url.pathname === '/api/_/account' && req.method === 'PATCH') {
    const auth = currentSession(req);
    const { data } = await readBody(req);
    let username;
    try {
      username = validateUsername(data.username ?? auth.user.username);
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
      return true;
    }
    const displayName = String(data.displayName ?? auth.user.display_name).trim();
    if (!displayName || displayName.length > 50) {
      json(res, 400, { ok: false, error: '显示名称需为 1-50 个字符' });
      return true;
    }
    const duplicate = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?')
      .get(username, auth.user.id);
    if (duplicate) {
      json(res, 409, { ok: false, error: '用户名已存在' });
      return true;
    }
    const now = Date.now();
    db.prepare('UPDATE users SET username = ?, display_name = ?, updated_at = ? WHERE id = ?')
      .run(username, displayName, now, auth.user.id);
    json(res, 200, {
      ok: true,
      data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id)),
    });
    return true;
  }

  if (url.pathname === '/api/_/account/password' && req.method === 'POST') {
    const auth = currentSession(req);
    const { data } = await readBody(req);
    if (!verifyPassword(data.currentPassword || '', auth.user.password_hash)) {
      json(res, 400, { ok: false, error: '当前密码错误' });
      return true;
    }
    let newPassword;
    try {
      newPassword = validatePassword(data.newPassword);
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
      return true;
    }
    if (verifyPassword(newPassword, auth.user.password_hash)) {
      json(res, 400, { ok: false, error: '新密码不能与当前密码相同' });
      return true;
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(hashPassword(newPassword), now, now, auth.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(auth.user.id, auth.token);
    })();
    for (const [token, session] of sessions) {
      if (session.userId === auth.user.id && token !== auth.token) sessions.delete(token);
    }
    json(res, 200, {
      ok: true,
      data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id)),
    });
    return true;
  }

  if (url.pathname === '/api/_/env' && req.method === 'GET') {
    json(res, 200, { ok: true, data: publicEnvConfig(ENV_FILE) });
    return true;
  }

  if (url.pathname === '/api/_/env' && req.method === 'PUT') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: updateEnvConfig(ENV_FILE, data || {}), restartRequired: true });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
