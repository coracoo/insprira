// WeRss 公众号同步：token 管理 + 文章抓取与预抓取
// 依赖：lib/db（实例）、lib/auth（decryptKb）、kb_wersss（HTTP client）
const { db } = require('./db');
const { decryptKb } = require('./auth');
const wersss = require('../kb_wersss');

function getWersssConfigRow() {
  return db.prepare('SELECT * FROM wersss_config WHERE id = 1').get();
}

function getWersssConfig() {
  const row = getWersssConfigRow();
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    username: row.username,
    password: decryptKb(row.password_enc),
    token: row.token,
    tokenExpiresAt: row.token_expires_at,
    enabled: Boolean(row.enabled),
  };
}

async function getValidWersssToken() {
  const config = getWersssConfig();
  if (!config || !config.enabled) throw new Error('WeRss 接入未配置');
  const now = Date.now();
  if (config.token && config.tokenExpiresAt && config.tokenExpiresAt - now > 60 * 1000) {
    return { token: config.token, config };
  }
  const result = await wersss.login(config.baseUrl, config.username, config.password);
  if (!result?.access_token) throw new Error('WeRss 登录未返回 token');
  const expiresIn = result.expires_in ? Number(result.expires_in) * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = now + expiresIn;
  db.prepare(`UPDATE wersss_config SET token = ?, token_expires_at = ?, updated_at = ? WHERE id = 1`)
    .run(result.access_token, expiresAt, now);
  return { token: result.access_token, config: { ...config, token: result.access_token, tokenExpiresAt: expiresAt } };
}

async function getWersssAuthStatus() {
  const cfgRow = getWersssConfigRow();
  if (!cfgRow) return { configured: false, enabled: false, message: 'WeRss 未配置' };
  if (!cfgRow.enabled) return { configured: true, enabled: false, message: 'WeRss 接入已禁用' };
  let token;
  let tokenRefreshed = false;
  let tokenExpiresAt = cfgRow.token_expires_at || 0;
  try {
    const valid = await getValidWersssToken();
    token = valid.token;
    tokenRefreshed = !cfgRow.token || cfgRow.token !== token;
    tokenExpiresAt = valid.config.tokenExpiresAt || tokenExpiresAt;
  } catch (e) {
    // 登录失败：通常是服务连不上（URL 错或服务挂了）
    return {
      configured: true, enabled: true,
      serviceReachable: false,
      tokenValid: false,
      message: `服务连接失败：${e.message}`,
    };
  }
  const config = getWersssConfig();
  const now = Date.now();
  const tokenExpired = tokenExpiresAt > 0 && tokenExpiresAt - now <= 0;
  try {
    const status = await wersss.qrStatus(config.baseUrl, token);
    const loginStatus = Boolean(status?.login_status);
    const hasCode = Boolean(status?.qr_code);
    return {
      configured: true,
      enabled: true,
      serviceReachable: true,
      tokenValid: !tokenExpired,
      tokenExpired,
      tokenExpiresAt,
      tokenRefreshed,
      wxAuthorized: loginStatus,
      hasQrCode: hasCode,
      message: tokenExpired
        ? 'Token 已过期，请到设置页重新授权'
        : loginStatus ? '微信已授权' : '微信授权已过期，请扫码重新授权',
    };
  } catch (e) {
    // qrStatus 调用失败：服务连不上
    return {
      configured: true, enabled: true,
      serviceReachable: false,
      tokenValid: !tokenExpired,
      tokenExpired,
      tokenExpiresAt,
      wxAuthorized: false,
      message: `服务连接失败：${e.message}`,
    };
  }
}

async function syncWersssArticles() {
  const cfgRow = getWersssConfigRow();
  if (!cfgRow) throw new Error('WeRss 未配置');
  if (!cfgRow.enabled) throw new Error('WeRss 接入已禁用');
  const { token, config } = await getValidWersssToken();
  const tokenRefreshed = !cfgRow.token || cfgRow.token !== token;
  const subs = db.prepare('SELECT * FROM wersss_subscriptions WHERE enabled = 1').all();
  if (!subs.length) return { ok: true, tokenStatus: 'valid', tokenRefreshed, synced: 0, articles: 0, perMp: [] };
  const now = Date.now();
  try {
    const updateSubMeta = db.prepare(`
      UPDATE wersss_subscriptions
      SET mp_name = COALESCE(NULLIF(?, ''), mp_name),
          mp_alias = COALESCE(NULLIF(?, ''), mp_alias),
          avatar = COALESCE(NULLIF(?, ''), avatar),
          updated_at = ?
      WHERE mp_id = ?
    `);
    let subOffset = 0;
    const subPageSize = 100;
    while (true) {
      const freshSubs = await wersss.listSubscriptions(config.baseUrl, token, { limit: subPageSize, offset: subOffset });
      if (!freshSubs.length) break;
      for (const mp of freshSubs) {
        updateSubMeta.run(mp.mpName, mp.mpAlias, mp.avatar, now, mp.mpId);
      }
      if (freshSubs.length < subPageSize) break;
      subOffset += subPageSize;
    }
  } catch (e) {
    console.warn('[wersss] 刷新订阅元信息失败:', e.message);
  }
  const upsertArticle = db.prepare(`
    INSERT INTO wersss_articles (id, mp_id, title, summary, content, url, cover, publish_time, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(NULLIF(?, ''), wersss_articles.title),
      summary = COALESCE(NULLIF(?, ''), wersss_articles.summary),
      url = COALESCE(NULLIF(?, ''), wersss_articles.url),
      cover = COALESCE(NULLIF(?, ''), wersss_articles.cover),
      publish_time = COALESCE(?, wersss_articles.publish_time),
      synced_at = ?
  `);
  const updateSub = db.prepare('UPDATE wersss_subscriptions SET last_synced_at = ? WHERE mp_id = ?');
  let totalArticles = 0;
  const perMp = [];
  for (const sub of subs) {
    try {
      try {
        await wersss.updateMp(config.baseUrl, token, sub.mp_id);
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.warn(`[wersss] updateMp ${sub.mp_name} 失败:`, e.message);
      }
      let offset = 0;
      let count = 0;
      let batch;
      // 首次同步只拉最新一页（100 条），避免导入大量历史文章。
      // 后续同步从 offset 0 增量拉，遇到已存在的文章 ID 就停（说明后面的都是旧的）。
      const isFirstSync = !sub.last_synced_at;
      const maxOffset = isFirstSync ? 100 : 1000;
      do {
        batch = await wersss.listArticles(config.baseUrl, token, { mpId: sub.mp_id, limit: 100, offset, hasContent: false });
        if (!batch.length) break;
        // 后续同步：如果这批全是已存在的，说明没有新文章了，停
        if (!isFirstSync && offset > 0) {
          const existingIds = batch.filter(a => a.id).map(a => a.id);
          const placeholders = existingIds.map(() => '?').join(',');
          const existing = existingIds.length
            ? db.prepare(`SELECT COUNT(*) as n FROM wersss_articles WHERE id IN (${placeholders})`).get(...existingIds)
            : { n: 0 };
          if (existing.n === existingIds.length) break;  // 全部已存在
        }
        const tx = db.transaction((items) => {
          for (const a of items) {
            if (!a.id) continue;
            upsertArticle.run(
            a.id, sub.mp_id, a.title || '', a.summary || '', a.content || '', a.url || '', a.cover || '', a.publishTime || null, now,
            a.title || '', a.summary || '', a.url || '', a.cover || '', a.publishTime || null, now,
          );
            count++;
          }
        });
        tx(batch);
        offset += batch.length;
      } while (batch.length === 100 && offset < maxOffset);
      if (offset >= 1000 && batch.length === 100) {
        console.warn(`[wersss] 公众号 ${sub.mp_name}(${sub.mp_id}) 同步达 1000 条上限，可能仍有未拉取的历史文章`);
      }
      updateSub.run(now, sub.mp_id);
      totalArticles += count;
      perMp.push({ mpId: sub.mp_id, mpName: sub.mp_name, count, ok: true });
      console.log(`[wersss] 同步公众号 ${sub.mp_name}(${sub.mp_id}) 完成，新增/更新 ${count} 条`);
    } catch (e) {
      console.warn(`[wersss] 同步公众号 ${sub.mp_name}(${sub.mp_id}) 失败:`, e.message);
      perMp.push({ mpId: sub.mp_id, mpName: sub.mp_name, count: 0, ok: false, error: e.message });
    }
  }
  const failed = perMp.filter(m => !m.ok);
  return {
    ok: failed.length === 0,
    tokenStatus: 'valid',
    tokenRefreshed,
    synced: subs.length,
    articles: totalArticles,
    failed: failed.length,
    perMp,
  };
}

async function runWersssSyncCron() {
  const syncResult = await syncWersssArticles();
  let prefetchResult = null;
  if (syncResult.ok && syncResult.articles > 0) {
    try {
      prefetchResult = await prefetchWersssContent();
    } catch (e) {
      console.warn('[wersss] 预抓取正文失败:', e.message);
      prefetchResult = { error: e.message };
    }
  }
  return { ...syncResult, prefetch: prefetchResult };
}

async function prefetchWersssContent() {
  const { token, config } = await getValidWersssToken();
  const pending = db.prepare(`SELECT id FROM wersss_articles WHERE content IS NULL OR length(content) < 100`).all();
  if (!pending.length) return { total: 0, done: 0, failed: 0 };
  const CONCURRENCY = 4;
  const update = db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?');
  let done = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(a => wersss.getArticle(config.baseUrl, token, a.id))
    );
    const tx = db.transaction(() => {
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value?.content && r.value.content.length >= 100) {
          update.run(r.value.content, batch[idx].id);
          done++;
        } else {
          failed++;
        }
      });
    });
    tx();
  }
  return { total: pending.length, done, failed };
}

module.exports = {
  getWersssConfigRow,
  getWersssConfig,
  getValidWersssToken,
  getWersssAuthStatus,
  syncWersssArticles,
  runWersssSyncCron,
  prefetchWersssContent,
};
