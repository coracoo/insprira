// 路由组：小红书 MCP 接入（xpzouying/xiaohongshu-mcp）
// ctx 注入 xhsMcpService（lib/xhs-mcp/service.js 的导出）
//
// 端点：
//   GET    /api/_/xhs-mcp/config             读配置（脱敏）
//   POST   /api/_/xhs-mcp/config             保存 + 自动 health check
//   GET    /api/_/xhs-mcp/health             主动 ping + 刷新 login_status
//   GET    /api/_/xhs-mcp/login/status       转发 xhs-mcp 登录态
//   GET    /api/_/xhs-mcp/login/qrcode       转发扫码二维码（base64）
//   DELETE /api/_/xhs-mcp/login/cookies      重置登录
//   POST   /api/_/xhs-mcp/publish            发布图文
//   POST   /api/_/xhs-mcp/publish-video      发布视频
//   POST   /api/_/xhs-mcp/feeds/search       搜索笔记
//   POST   /api/_/xhs-mcp/feeds/detail       笔记详情
//   POST   /api/_/xhs-mcp/feeds/comment      发评论
//   POST   /api/_/xhs-mcp/feeds/comment/reply  回复评论
//   POST   /api/_/xhs-mcp/user/profile       拉用户主页
//   GET    /api/_/xhs-mcp/user/me            当前登录用户
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const { xhsMcpService: svc } = ctx;
  if (!svc) return false;

  // —— 配置 CRUD ——
  if (url.pathname === '/api/_/xhs-mcp/config' && req.method === 'GET') {
    json(res, 200, { ok: true, data: svc.getPublicConfig() });
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/config' && req.method === 'POST') {
    const { data } = await readBody(req);
    const baseUrl = String(data.baseUrl || '').trim();
    const mcpUrl = String(data.mcpUrl || '').trim();
    const enabled = data.enabled !== false;
    if (!baseUrl) { json(res, 400, { ok: false, error: 'baseUrl 必填' }); return true; }
    try {
      svc.saveConfig({ baseUrl, mcpUrl, enabled });
      let health = null;
      if (enabled) {
        try { health = await svc.checkHealth(); }
        catch (e) { health = { healthy: false, error: e.message }; }
      }
      json(res, 200, { ok: true, data: { ...svc.getPublicConfig(), health } });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
    return true;
  }

  // —— 健康检查 ——
  if (url.pathname === '/api/_/xhs-mcp/health' && req.method === 'GET') {
    try {
      const result = await svc.checkHealth();
      json(res, 200, { ok: true, data: result });
    } catch (e) {
      json(res, 200, { ok: true, data: { healthy: false, error: e.message } });
    }
    return true;
  }

  // 以下接口都需要先配置且启用
  const guarded = async (fn) => {
    try {
      const data = await fn();
      json(res, 200, { ok: true, data });
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
  };

  // —— 登录管理 ——
  if (url.pathname === '/api/_/xhs-mcp/login/status' && req.method === 'GET') {
    await guarded(async () => {
      const result = await svc.getLoginStatus();
      // 同步更新本地 login_status
      const isLoggedIn = Boolean(result?.data?.is_logged_in);
      svc.updateLoginStatus(isLoggedIn ? 'logged_in' : 'logged_out');
      return result;
    });
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/login/qrcode' && req.method === 'GET') {
    await guarded(() => svc.getLoginQrcode());
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/login/cookies' && req.method === 'DELETE') {
    await guarded(async () => {
      const result = await svc.deleteCookies();
      svc.updateLoginStatus('unknown');
      return result;
    });
    return true;
  }

  // —— 内容发布 ——
  if (url.pathname === '/api/_/xhs-mcp/publish' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.publish(data));
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/publish-video' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.publishVideo(data));
    return true;
  }

  // —— Feed / 笔记 ——
  if (url.pathname === '/api/_/xhs-mcp/feeds/search' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.searchFeeds(data));
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/feeds/detail' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.getFeedDetail(data));
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/feeds/comment' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.postComment(data));
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/feeds/comment/reply' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.replyComment(data));
    return true;
  }

  // —— 用户 ——
  if (url.pathname === '/api/_/xhs-mcp/user/profile' && req.method === 'POST') {
    const { data } = await readBody(req);
    await guarded(() => svc.getUserProfile(data));
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/user/me' && req.method === 'GET') {
    await guarded(() => svc.getMyProfile());
    return true;
  }

  // —— CLI 安装管理 ——
  if (url.pathname === '/api/_/xhs-mcp/cli-status' && req.method === 'GET') {
    json(res, 200, { ok: true, data: svc.getCliStatus() });
    return true;
  }

  if (url.pathname === '/api/_/xhs-mcp/install' && req.method === 'POST') {
    try {
      const result = await svc.installCli();
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  return false;
}

module.exports = { tryRoute };
