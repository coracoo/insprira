// 插件上报接口路由级测试：token 鉴权 / 账号匹配 / upsert + 历史点
const path = require('path');
process.env.INGEST_TOKEN = process.env.INGEST_TOKEN || 'test-ingest-token';
const { boot, close, req } = require('./_server');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const { readEnvValues } = require('../lib/env');

// 与服务端同一解析口径：.env 文件优先，process.env 兜底（防真实 .env 已配置时误挂）
const ENV_FILE = path.join(__dirname, '..', '.env');
const TOKEN = (readEnvValues(ENV_FILE).INGEST_TOKEN || process.env.INGEST_TOKEN || '').trim();

const ACC = 'test-ingest-acc';

function cleanup() {
  db.prepare('DELETE FROM my_accounts WHERE id = ?').run(ACC);
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC);
  db.prepare('DELETE FROM work_stats_history WHERE account_id = ?').run(ACC);
}

test.before(async () => { await boot(); });
test.after(async () => { cleanup(); await close(); });

test('ingest 数据质量：垃圾行过滤 / 分析页链接归一化 / 合并不回退', async () => {
  cleanup();
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
    VALUES (?, NULL, '测试公众号', 'gzh', '', ?, ?)
  `).run(ACC, Date.now(), Date.now());
  const post = (articles) => req('/api/_/ingest/mp-stats', {
    method: 'POST',
    headers: { 'X-Ingest-Token': TOKEN },
    body: { mpName: '测试公众号', articles },
  });

  // 同篇两行：一行带后台分析页链接且 0 阅读，一行无链接有阅读 → 归并为一条
  const r1 = await post([
    { title: '深度长文一篇', url: 'https://mp.weixin.qq.com/misc/appmsganalysis?action=home', reads: 0 },
    { title: '深度长文一篇', reads: 800 },
    { title: 'x' }, // 垃圾行
  ]);
  assert.equal(r1.status, 200);
  const works = db.prepare('SELECT * FROM account_works WHERE account_id = ?').all(ACC);
  assert.equal(works.length, 1);
  const w = JSON.parse(works[0].work_data);
  assert.equal(w.readCount, 800);
  assert.equal(w.url, ''); // 分析页链接被丢弃

  // 冲突合并不回退：后续批次 0 阅读不冲掉已有 800
  await post([{ title: '深度长文一篇', reads: 0, publishTime: '' }]);
  const w2 = JSON.parse(db.prepare('SELECT work_data FROM account_works WHERE account_id = ?').get(ACC).work_data);
  assert.equal(w2.readCount, 800);
  // 字段补全：后报发表时间/链接会补上而不是清空
  await post([{ title: '深度长文一篇', url: 'https://mp.weixin.qq.com/s/abc', reads: 900, publishTime: '2026-08-02 10:00' }]);
  const rowsNow = db.prepare('SELECT * FROM account_works WHERE account_id = ?').all(ACC);
  const merged = JSON.parse(rowsNow.find(r => JSON.parse(r.work_data).url).work_data);
  assert.equal(merged.readCount, 900);
  assert.ok(merged.publishTime);
});

test('ingest 全流程：鉴权 → 匹配账号 → upsert + 历史点', async () => {
  cleanup();
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
    VALUES (?, NULL, '测试公众号', 'gzh', '', ?, ?)
  `).run(ACC, Date.now(), Date.now());

  // 无 token → 401
  const noAuth = await req('/api/_/ingest/mp-stats', {
    method: 'POST',
    body: { mpName: '测试公众号', articles: [{ title: 'A', reads: 100 }] },
  });
  assert.equal(noAuth.status, 401);

  // 未知公众号 → 404
  const noMatch = await req('/api/_/ingest/mp-stats', {
    method: 'POST',
    headers: { 'X-Ingest-Token': TOKEN },
    body: { mpName: '不存在的号', articles: [{ title: 'A', reads: 100 }] },
  });
  assert.equal(noMatch.status, 404);

  // 正常上报
  const ok = await req('/api/_/ingest/mp-stats', {
    method: 'POST',
    headers: { 'X-Ingest-Token': TOKEN },
    body: {
      mpName: '测试公众号',
      articles: [
        { title: '文章一', url: 'https://mp.weixin.qq.com/s/abc', reads: 1200, likes: 30, comments: 5, publishTime: '2026-08-01 10:00' },
        { title: '文章二', reads: 800, likes: 20 },
      ],
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.upserted, 2);

  const works = db.prepare('SELECT * FROM account_works WHERE account_id = ?').all(ACC);
  assert.equal(works.length, 2);
  const w1 = works.find(w => JSON.parse(w.work_data).title === '文章一');
  assert.equal(JSON.parse(w1.work_data).readCount, 1200);
  assert.ok(w1.publish_at > 0);
  const points = db.prepare('SELECT * FROM work_stats_history WHERE account_id = ?').all(ACC);
  assert.equal(points.length, 2);

  // 重复上报同数据：upsert 不增行，历史点不重复
  await req('/api/_/ingest/mp-stats', {
    method: 'POST',
    headers: { 'X-Ingest-Token': TOKEN },
    body: { mpName: '测试公众号', articles: [{ title: '文章一', url: 'https://mp.weixin.qq.com/s/abc', reads: 1200, likes: 30, comments: 5, publishTime: '2026-08-01 10:00' }] },
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_works WHERE account_id = ?').get(ACC).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM work_stats_history WHERE account_id = ?').get(ACC).n, 2);
});


test('ingest 主键合流：老数据无 URL 按标题哈希，带真链接的新数据继承旧主键', async () => {
  cleanup();
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
    VALUES (?, NULL, '测试公众号', 'gzh', '', ?, ?)
  `).run(ACC, Date.now(), Date.now());
  const post = (articles) => req('/api/_/ingest/mp-stats', {
    method: 'POST',
    headers: { 'X-Ingest-Token': TOKEN },
    body: { mpName: '测试公众号', articles },
  });

  // 老批次：无 URL，主键 = sha1(title)
  await post([{ title: '合流测试文章', reads: 100, publishTime: '2026-08-01 10:00' }]);
  const oldRow = db.prepare('SELECT * FROM account_works WHERE account_id = ?').get(ACC);
  const oldWorkId = oldRow.work_id;

  // 新批次：带真文章链接（含每会话都变的 token query）+ 更高阅读 → 必须合并进旧行而不是新建
  await post([{ title: '合流测试文章', url: 'https://mp.weixin.qq.com/s/xyz123?token=5&lang=zh_CN', reads: 250 }]);
  const rows = db.prepare('SELECT * FROM account_works WHERE account_id = ?').all(ACC);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].work_id, oldWorkId);
  const w = JSON.parse(rows[0].work_data);
  assert.equal(w.url, 'https://mp.weixin.qq.com/s/xyz123'); // 短链 query 被剥掉

  // 长链 /s?__biz=... 的 query 是文章标识本身，必须保留
  await post([{ title: '合流长链文章', url: 'https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc', reads: 10 }]);
  const longRow = db.prepare("SELECT work_data FROM account_works WHERE account_id = ? AND json_extract(work_data,'$.title') = '合流长链文章'").get(ACC);
  assert.equal(JSON.parse(longRow.work_data).url, 'https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc');

  assert.equal(w.readCount, 250);
  assert.ok(w.publishTime); // 旧字段不被清空
});
