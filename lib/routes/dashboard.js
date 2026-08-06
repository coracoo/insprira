// 路由组：运营总览（跨账号聚合 + LLM 运营总结 + 周行动闭环）
// 依赖通过 ctx 注入：buildOverview/getSummary/generateSummary/setActionStatus
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const { buildOverview, getSummary, generateSummary, setActionStatus } = ctx;

  // 运营总览聚合：KPI、问题分布、账号概览、文章诊断列表
  if (url.pathname === '/api/_/dashboard/overview' && req.method === 'GET') {
    try {
      json(res, 200, { ok: true, data: buildOverview() });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  // LLM 运营总结：GET 读缓存，POST 重新生成
  if (url.pathname === '/api/_/dashboard/summary' && req.method === 'GET') {
    json(res, 200, { ok: true, data: getSummary() });
    return true;
  }
  if (url.pathname === '/api/_/dashboard/summary' && req.method === 'POST') {
    try {
      const result = await generateSummary();
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  // 周行动状态更新：POST /api/_/dashboard/actions/<id> { status: pending|done|dismissed }
  const actionMatch = url.pathname.match(/^\/api\/_\/dashboard\/actions\/(\d+)$/);
  if (actionMatch && req.method === 'POST') {
    try {
      const { data } = await readBody(req);
      const result = setActionStatus(Number(actionMatch[1]), String(data.status || ''));
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  return false;
}

module.exports = { tryRoute };
