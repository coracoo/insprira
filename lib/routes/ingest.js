// 路由组：外部数据上报（MP 浏览器插件等）
// 独立于会话的 INGEST_TOKEN 鉴权——插件跨源调用带不了 SameSite=Strict 会话 Cookie
const crypto = require('crypto');
const { db } = require('../db');
const { json, readBody } = require('../http');
const { readEnvValues } = require('../env');
const { recordWorkStats } = require('../work-stats');
const { workContentKey, toNumber } = require('../utils');

const MAX_ARTICLES_PER_CALL = 100;

async function tryRoute(req, res, url, ctx) {
  const { ENV_FILE } = ctx;
  if (url.pathname !== '/api/_/ingest/mp-stats' || req.method !== 'POST') return false;

  // 优先读 .env 文件（改后即时生效），兜底 process.env（Docker environment）
  const token = (readEnvValues(ENV_FILE).INGEST_TOKEN || process.env.INGEST_TOKEN || '').trim();
  if (!token) { json(res, 503, { ok: false, error: '服务端未配置 INGEST_TOKEN，请在 .env 中设置' }); return true; }
  if (String(req.headers['x-ingest-token'] || '') !== token) {
    json(res, 401, { ok: false, error: 'INGEST_TOKEN 不匹配' });
    return true;
  }

  const { data } = await readBody(req);
  // 连通性探测：插件「选项」页测试连接用
  if (data?.ping) { json(res, 200, { ok: true, data: { pong: true } }); return true; }
  const mpName = String(data?.mpName || '').trim();
  const articles = Array.isArray(data?.articles) ? data.articles : [];
  if (!mpName || !articles.length) {
    json(res, 400, { ok: false, error: 'mpName 和 articles 必填' });
    return true;
  }

  // 按公众号名匹配「我的账号」（gzh），analysis 以 tracker_id 为主键口径
  const account = db.prepare("SELECT * FROM my_accounts WHERE plat = 'gzh' AND name = ?").get(mpName);
  if (!account) {
    json(res, 404, { ok: false, error: `未找到公众号账号「${mpName}」，请先在「账号追踪」添加同名账号` });
    return true;
  }
  const accountId = account.tracker_id || account.id;

  const now = Date.now();
  const findStmt = db.prepare(
    "SELECT work_data, publish_at FROM account_works WHERE account_id = ? AND plat = 'gzh' AND work_id = ?"
  );
  // URL 规范化：短链 /s/xxx 的 ?token=...&lang=... 等 query 每会话都变，
  // 不剥会导致主键 sha1(url) 漂移产生重复行；长链 /s?__biz=... 的 query 是标识本身，保留
  const normalizeArticleUrl = (rawUrl) => {
    if (!/^https:\/\/mp\.weixin\.qq\.com\/s[/?]/.test(rawUrl)) return '';
    try {
      const u = new URL(rawUrl);
      if (/^\/s\/[^/]+$/.test(u.pathname)) return u.origin + u.pathname;
      return rawUrl;
    } catch { return ''; }
  };
  // 主键分叉合流：老数据无 URL 按标题哈希入的库，新数据带真文章 URL 时继承旧主键
  const findByTitleStmt = db.prepare(
    "SELECT work_id, work_data, publish_at FROM account_works WHERE account_id = ? AND plat = 'gzh' AND json_extract(work_data, '$.title') = ?"
  );
  const upsert = db.prepare(`
    INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
    VALUES (?, 'gzh', ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, plat, work_id) DO UPDATE SET
      work_data = excluded.work_data,
      synced_at = excluded.synced_at,
      publish_at = COALESCE(excluded.publish_at, account_works.publish_at),
      content_key = excluded.content_key
  `);
  const statsItems = [];
  let upserted = 0;
  const saveAll = db.transaction(() => {
    for (const a of articles.slice(0, MAX_ARTICLES_PER_CALL)) {
      const title = String(a?.title || '').trim();
      // 过滤页面占位/模板垃圾行：标题过短或全无数据
      const reads = toNumber(a.reads) ?? 0;
      const rawUrl = String(a?.url || '').trim();
      // 只认文章页链接；后台分析页（misc/appmsganalysis）等链接一律丢弃；短链剥 query 防主键漂移
      const articleUrl = normalizeArticleUrl(rawUrl);
      const publishTime = a.publishTime || '';
      if (title.length < 2) continue;
      if (!reads && !articleUrl && !publishTime) continue;
      let workId = crypto.createHash('sha1').update(articleUrl || title).digest('hex');
      const publishAt = publishTime
        ? (typeof publishTime === 'number' ? publishTime : Date.parse(String(publishTime).replace(/-/g, '/')) || null)
        : null;
      const incoming = {
        title,
        url: articleUrl,
        readCount: reads,
        likeCount: toNumber(a.likes) ?? 0,
        commentsCount: toNumber(a.comments) ?? 0,
        shareCount: toNumber(a.shares) ?? 0,
        wowCount: toNumber(a.wow) ?? 0,
        publishTime,
        source: 'mp-extension',
      };
      // 冲突合并而非盲目覆盖：指标取大（只增不减），字段留空不冲掉已有值
      let existing = findStmt.get(accountId, workId);
      if (!existing) {
        const byTitle = findByTitleStmt.get(accountId, title);
        if (byTitle) { workId = byTitle.work_id; existing = byTitle; }
      }
      const old = existing ? (JSON.parse(existing.work_data || '{}') || {}) : {};
      const work = {
        ...old,
        ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== '' && v != null)),
        readCount: Math.max(toNumber(old.readCount) || 0, incoming.readCount),
        likeCount: Math.max(toNumber(old.likeCount) || 0, incoming.likeCount),
        commentsCount: Math.max(toNumber(old.commentsCount) || 0, incoming.commentsCount),
        shareCount: Math.max(toNumber(old.shareCount) || 0, incoming.shareCount),
        wowCount: Math.max(toNumber(old.wowCount) || 0, incoming.wowCount),
        url: incoming.url || old.url || '',
        publishTime: incoming.publishTime || old.publishTime || '',
        source: 'mp-extension',
      };
      upsert.run(accountId, workId, JSON.stringify(work), now, publishAt ?? existing?.publish_at ?? null, workContentKey(work));
      statsItems.push({ workId, reads: work.readCount, likes: work.likeCount, comments: work.commentsCount });
      upserted++;
    }
    recordWorkStats(accountId, 'gzh', statsItems, now);
  });
  saveAll();
  json(res, 200, { ok: true, data: { account: account.name, upserted } });
  return true;
}

module.exports = { tryRoute };
