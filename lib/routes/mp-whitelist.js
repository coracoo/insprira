// 路由组：公众号 IP 白名单自动配置（40164 自救：puppeteer 驱动控制台 + 扫码核验）
// 依赖通过 ctx 注入：mpWhitelist（lib/mp-whitelist）、mpOfficial（lib/wechat-official，读 AppID）
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const { mpWhitelist, mpOfficial } = ctx;

  // 探测本机出口公网 IP（前端预填用）
  if (url.pathname === '/api/_/mp-whitelist/outbound-ip' && req.method === 'GET') {
    try {
      json(res, 200, { ok: true, data: { ip: await mpWhitelist.detectOutboundIp() } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  // 启动自动加白任务：appId 缺省读 MP_APP_ID；ips 缺省自动探测出口 IP
  if (url.pathname === '/api/_/mp-whitelist/auto' && req.method === 'POST') {
    const { data } = await readBody(req);
    const appId = String(data.appId || mpOfficial.getMpConfig()?.appId || '').trim();
    if (!appId) { json(res, 400, { ok: false, error: '未配置 MP_APP_ID，无法确定目标公众号' }); return true; }
    const ips = (Array.isArray(data.ips) ? data.ips : String(data.ips || '').split(/[\n,;，；\s]+/))
      .map(s => String(s).trim()).filter(Boolean);
    try {
      const job = await mpWhitelist.startAutoWhitelist({ appId, ips });
      json(res, 200, { ok: true, data: { jobId: job.id, ips: job.ips } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  // 轮询任务状态（waiting_login/waiting_confirm 时带页面截图 base64）
  const jobMatch = url.pathname.match(/^\/api\/_\/mp-whitelist\/auto\/([0-9a-f]+)$/);
  if (jobMatch && req.method === 'GET') {
    const job = mpWhitelist.getJob(jobMatch[1]);
    if (!job) { json(res, 404, { ok: false, error: '任务不存在或已过期' }); return true; }
    json(res, 200, { ok: true, data: job });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
