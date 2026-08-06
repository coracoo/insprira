// 路由组：我的账号 + 风格档案 + 创作提示词模板
// 依赖通过 ctx 注入：listMyAccounts/saveMyAccount/getMyAccount/
// extractAccountTracks/extractAccountStyleProfile/generatePresetInspirations/
// suggestInspirationConfigs/createInspirationConfigFromSuggestion/listAccountSnapshots/
// analyzeAccountWorks/listArticleAnalyses
const { db } = require('../db');
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const {
    listMyAccounts, saveMyAccount, getMyAccount,
    extractAccountTracks, extractAccountStyleProfile, generatePresetInspirations,
    suggestInspirationConfigs, createInspirationConfigFromSuggestion,
    listAccountSnapshots, analyzeAccountWorks, listArticleAnalyses, syncMpOfficialStats,
  } = ctx;

  // ========== 我的账号 + 风格档案 ==========
  if (url.pathname === '/api/_/my-accounts' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listMyAccounts() });
    return true;
  }

  // dashboard 聚合：一次返回账号 + 快照（含总数）+ 公众号文章 + 文章分析，避免前端 N+1 请求
  if (url.pathname === '/api/_/my-accounts/dashboard' && req.method === 'GET') {
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM account_snapshots WHERE account_id = ?');
    const wersssStmt = db.prepare(`
      SELECT a.id, a.mp_id, s.mp_name, a.title, a.url, a.publish_time
      FROM wersss_articles a JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE s.mp_name = ? OR s.mp_alias = ?
      ORDER BY a.publish_time DESC, a.synced_at DESC LIMIT 10`);
    const data = listMyAccounts().map(acc => {
      const trackerId = acc.trackerId || acc.id;
      let wersssArticles = [];
      if (acc.plat === 'gzh') {
        wersssArticles = wersssStmt.all(acc.name, acc.name).map(r => ({
          id: r.id, mpId: r.mp_id, mpName: r.mp_name,
          title: r.title, url: r.url, publishTime: r.publish_time,
        }));
      }
      return {
        ...acc,
        snapshots: listAccountSnapshots(trackerId, 10),
        snapshotTotal: countStmt.get(trackerId).n,
        wersssArticles,
        articleAnalyses: listArticleAnalyses(trackerId),
      };
    });
    json(res, 200, { ok: true, data });
    return true;
  }

  // 文章级表现分析：RedFox 数据 + LLM 逐篇诊断（选题/标题/内容）
  const analyzeWorksMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/analyze-works$/);
  if (analyzeWorksMatch && req.method === 'POST') {
    const id = decodeURIComponent(analyzeWorksMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const result = await analyzeAccountWorks(account);
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // 微信公众号官方 datacube 手动同步（认证号 T+1 权威阅读数据）
  const syncMpMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/sync-mp-official$/);
  if (syncMpMatch && req.method === 'POST') {
    const id = decodeURIComponent(syncMpMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    if (!syncMpOfficialStats) { json(res, 400, { ok: false, error: '官方数据源未启用' }); return true; }
    try {
      const result = await syncMpOfficialStats({ account });
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  if (url.pathname === '/api/_/my-accounts' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data.name || !data.plat) { json(res, 400, { ok: false, error: 'name 和 plat 必填' }); return true; }
    const saved = saveMyAccount(data);
    json(res, 200, { ok: true, data: saved });
    return true;
  }
  const myAccDelMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)$/);
  if (myAccDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(myAccDelMatch[1]);
    db.prepare('DELETE FROM my_accounts WHERE id = ?').run(id);
    json(res, 200, { ok: true });
    return true;
  }
  const extractTracksMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/extract-tracks$/);
  if (extractTracksMatch && req.method === 'POST') {
    const id = decodeURIComponent(extractTracksMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const tracks = await extractAccountTracks(account);
      const saved = saveMyAccount({ ...account, tracks });
      json(res, 200, { ok: true, data: { tracks, account: saved } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const extractStyleMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/extract-style$/);
  if (extractStyleMatch && req.method === 'POST') {
    const id = decodeURIComponent(extractStyleMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const profile = await extractAccountStyleProfile(account);
      const saved = saveMyAccount({ ...account, styleProfile: profile, styleUpdatedAt: Date.now() });
      json(res, 200, { ok: true, data: { profile, account: saved } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const presetInspMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/preset-inspirations$/);
  if (presetInspMatch && req.method === 'POST') {
    const id = decodeURIComponent(presetInspMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const ideas = await generatePresetInspirations(account);
      json(res, 200, { ok: true, data: ideas });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const suggestCfgMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/suggest-configs$/);
  if (suggestCfgMatch && req.method === 'GET') {
    const id = decodeURIComponent(suggestCfgMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const suggestions = await suggestInspirationConfigs(account);
      json(res, 200, { ok: true, data: suggestions });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const createCfgMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/create-config$/);
  if (createCfgMatch && req.method === 'POST') {
    const id = decodeURIComponent(createCfgMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    const { data } = await readBody(req);
    try {
      const config = createInspirationConfigFromSuggestion(account, data.suggestion || data);
      json(res, 200, { ok: true, data: config });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  // ========== 创作提示词模板 ==========
  if (url.pathname === '/api/_/style-templates' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM style_templates ORDER BY is_default DESC, created_at DESC').all();
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, name: r.name, platform: r.platform, template: r.template,
      isDefault: Boolean(r.is_default), createdAt: r.created_at, updatedAt: r.updated_at,
    })) });
    return true;
  }
  if (url.pathname === '/api/_/style-templates' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data.name || !data.template) { json(res, 400, { ok: false, error: 'name 和 template 必填' }); return true; }
    const id = data.id || `tpl:${Date.now()}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO style_templates (id, name, platform, template, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, platform = excluded.platform, template = excluded.template,
        is_default = excluded.is_default, updated_at = excluded.updated_at
    `).run(id, String(data.name), String(data.platform || 'all'), String(data.template), data.isDefault ? 1 : 0, now, now);
    json(res, 200, { ok: true, data: { id } });
    return true;
  }
  const styleTplDelMatch = url.pathname.match(/^\/api\/_\/style-templates\/([^/]+)$/);
  if (styleTplDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(styleTplDelMatch[1]);
    db.prepare('DELETE FROM style_templates WHERE id = ?').run(id);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
