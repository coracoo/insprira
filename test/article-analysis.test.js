// 文章级表现分析：纯函数与选篇/基线逻辑单测
// 经 _helper 引导（独立 DATA_DIR、关闭调度器），不碰真实 data/cache.db
require('./_helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const {
  workReads, classifyPerformance, stripHtml,
  getSnapshotWorks, getWorksBaseline, selectWorksForAnalysis, listArticleAnalyses,
  HOT_RATIO, COLD_RATIO,
} = require('../lib/article-analysis');

const ACC = 'test-acc-1';
const ACC_SNAP = 'test-acc-snap';

function insertWork(accountId, workId, work, publishAt, contentKey) {
  db.prepare(`
    INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
    VALUES (?, 'gzh', ?, ?, ?, ?, ?)
  `).run(accountId, workId, JSON.stringify(work), Date.now(), publishAt, contentKey);
}

test('workReads 多字段回退', () => {
  assert.equal(workReads({ readCount: 100 }), 100);
  assert.equal(workReads({ clicksCount: 80 }), 80);
  assert.equal(workReads({ playCount: 60 }), 60);
  assert.equal(workReads({ '阅读数': 50 }), 50);
  assert.equal(workReads({}), 0);
});

test('classifyPerformance 阈值分类', () => {
  assert.equal(classifyPerformance(HOT_RATIO), 'hot');
  assert.equal(classifyPerformance(2.4), 'hot');
  assert.equal(classifyPerformance(COLD_RATIO), 'cold');
  assert.equal(classifyPerformance(0.3), 'cold');
  assert.equal(classifyPerformance(1.0), 'normal');
  assert.equal(classifyPerformance(null), 'normal');
});

test('stripHtml 去标签与实体', () => {
  assert.equal(stripHtml('<p>你好 <b>世界</b></p><script>x()</script>'), '你好 世界');
  assert.equal(stripHtml('a&nbsp;b&amp;c'), 'a b&c');
  assert.equal(stripHtml(''), '');
});

test('getWorksBaseline 均阅与计数', () => {
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC);
  const now = Date.now();
  insertWork(ACC, 'w1', { title: 'A', readCount: 1000, likeCount: 10, commentsCount: 10 }, now - 1000, 'k1');
  insertWork(ACC, 'w2', { title: 'B', readCount: 3000, likeCount: 20, commentsCount: 10 }, now - 2000, 'k2');
  insertWork(ACC, 'w3', { title: 'C', readCount: 0 }, now - 3000, 'k3'); // 无阅读数不计入
  const b = getWorksBaseline(ACC);
  assert.equal(b.count, 2);
  assert.equal(b.avgReads, 2000);
  assert.ok(Math.abs(b.avgEngagement - ((20 / 1000 + 30 / 3000) / 2)) < 1e-9);
});

test('getWorksBaseline 空账号返回零基线', () => {
  const b = getWorksBaseline('no-such-account');
  assert.deepEqual(b, { avgReads: 0, avgEngagement: 0, count: 0 });
});

test('selectWorksForAnalysis 跳过 7 天内已分析的篇目', () => {
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC);
  db.prepare('DELETE FROM article_analysis WHERE account_id = ?').run(ACC);
  const now = Date.now();
  insertWork(ACC, 'w1', { title: '新篇', readCount: 1000 }, now - 3 * 86400000, 'k-new');
  insertWork(ACC, 'w2', { title: '旧篇已分析', readCount: 2000 }, now - 4 * 86400000, 'k-done');
  db.prepare(`
    INSERT INTO article_analysis (account_id, content_key, plat, title, reads, baseline_reads, ratio, performance, analysis, has_content, created_at, updated_at)
    VALUES (?, 'k-done', 'gzh', '旧篇已分析', 2000, 1000, 2.0, 'hot', NULL, 0, ?, ?)
  `).run(ACC, now - 86400000, now - 86400000); // 1 天前分析过
  const { picked } = selectWorksForAnalysis(ACC, 10, now);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].contentKey, 'k-new');
});

test('selectWorksForAnalysis 超过 7 天的分析记录不拦截', () => {
  const now = Date.now();
  db.prepare('UPDATE article_analysis SET updated_at = ? WHERE account_id = ?').run(now - 8 * 86400000, ACC);
  const { picked } = selectWorksForAnalysis(ACC, 10, now);
  assert.equal(picked.length, 2);
});

test('selectWorksForAnalysis 未满 48h 的作品进入观察期', () => {
  const ACC2 = 'test-acc-mature';
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC2);
  db.prepare('DELETE FROM article_analysis WHERE account_id = ?').run(ACC2);
  const now = Date.now();
  insertWork(ACC2, 'w-fresh', { title: '当日新篇', readCount: 1000 }, now - 3600000, 'k-fresh'); // 1h 前发布
  insertWork(ACC2, 'w-mature', { title: '成熟篇', readCount: 2000 }, now - 3 * 86400000, 'k-mature');
  const { picked, observing } = selectWorksForAnalysis(ACC2, 10, now);
  assert.equal(observing, 1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].contentKey, 'k-mature');
});

test('数据有更新且距上次分析 >24h 时允许重算', () => {
  const ACC3 = 'test-acc-refresh';
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC3);
  db.prepare('DELETE FROM article_analysis WHERE account_id = ?').run(ACC3);
  const now = Date.now();
  insertWork(ACC3, 'w1', { title: '重算篇', readCount: 1000 }, now - 4 * 86400000, 'k-re');
  // 2 天前分析过（>24h），之后同步刷新了数据（synced_at 更晚）
  db.prepare(`
    INSERT INTO article_analysis (account_id, content_key, plat, title, reads, baseline_reads, ratio, performance, analysis, has_content, created_at, updated_at)
    VALUES (?, 'k-re', 'gzh', '重算篇', 1000, 1000, 1.0, 'normal', NULL, 0, ?, ?)
  `).run(ACC3, now - 2 * 86400000, now - 2 * 86400000);
  db.prepare('UPDATE account_works SET synced_at = ? WHERE account_id = ? AND content_key = ?')
    .run(now - 3600000, ACC3, 'k-re');
  const { picked } = selectWorksForAnalysis(ACC3, 10, now);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].contentKey, 'k-re');
  // 反向：数据无更新（synced_at 早于分析时间）则 7 天内不重算
  db.prepare('UPDATE account_works SET synced_at = ? WHERE account_id = ? AND content_key = ?')
    .run(now - 3 * 86400000, ACC3, 'k-re');
  const again = selectWorksForAnalysis(ACC3, 10, now);
  assert.equal(again.picked.length, 0);
});

test('listArticleAnalyses 按 content_key 返回 map', () => {
  const map = listArticleAnalyses(ACC);
  assert.ok(map['k-done']);
  assert.equal(map['k-done'].performance, 'hot');
  assert.equal(map['k-done'].ratio, 2.0);
});

function insertSnapshotWithWorks(accountId) {
  const now = Date.now();
  const works = [
    { '标题': '[爆款文章标题](https://mp.weixin.qq.com/s?__biz=MzX&mid=1&idx=1&sn=a)', '阅读数': 30000, '点赞数': 900, '评论数': 100, '发布时间': new Date(now - 3 * 86400000).toISOString() },
    { '标题': '[冷门文章标题](https://mp.weixin.qq.com/s?__biz=MzX&mid=2&idx=1&sn=b)', '阅读数': 3000, '点赞数': 60, '评论数': 10, '发布时间': new Date(now - 4 * 86400000).toISOString() },
    { '标题': '无链接常规文章', '阅读数': 10000, '点赞数': 200, '评论数': 30, '发布时间': new Date(now - 5 * 86400000).toISOString() },
  ];
  db.prepare(`
    INSERT INTO account_snapshots (account_id, snapshot_date, follower_count, redfox_index, work_count, score, analysis, raw_data, captured_at)
    VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(accountId, new Date(now).toISOString().slice(0, 10), JSON.stringify({ works }), now);
}

test('getSnapshotWorks 解析 markdown 标题与链接', () => {
  db.prepare('DELETE FROM account_snapshots WHERE account_id = ?').run(ACC_SNAP);
  insertSnapshotWithWorks(ACC_SNAP);
  const works = getSnapshotWorks(ACC_SNAP);
  assert.equal(works.length, 3);
  assert.equal(works[0].work.title, '爆款文章标题');
  assert.ok(works[0].work.url.includes('__biz=MzX'));
  assert.equal(works[0].work.readCount, 30000);
  assert.equal(works[2].work.url, '');
  assert.ok(works[0].contentKey);
});

test('account_works 为空时 baseline 与选篇用快照兜底', () => {
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC_SNAP);
  db.prepare('DELETE FROM article_analysis WHERE account_id = ?').run(ACC_SNAP);
  const baseline = getWorksBaseline(ACC_SNAP);
  assert.equal(baseline.count, 3);
  assert.equal(baseline.avgReads, Math.round((30000 + 3000 + 10000) / 3));
  const { picked } = selectWorksForAnalysis(ACC_SNAP);
  assert.equal(picked.length, 3);
  assert.equal(picked[0].work.title, '爆款文章标题');
});

test('syncXhsOwnWorks 拉取自己笔记 upsert 并留历史点；未登录静默跳过', async () => {
  const ACC4 = 'test-acc-xhs';
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC4);
  db.prepare('DELETE FROM work_stats_history WHERE account_id = ?').run(ACC4);
  const { make } = require('../lib/article-analysis');
  const mod = make({
    redfoxData: async () => ({}),
    callLlmJson: async () => ({}),
    xhsService: {
      getLoginStatus: async () => ({ data: { is_logged_in: true } }),
      getMyProfile: async () => ({ data: { data: { feeds: [
        { id: 'note1', noteCard: { displayTitle: '笔记一', interactInfo: { likedCount: '1.7万', collectedCount: '300', commentCount: '25' } } },
      ] } } }),
    },
  });
  const result = await mod.syncXhsOwnWorks({ id: ACC4, plat: 'xhs' });
  assert.equal(result.synced, 1);
  const row = db.prepare('SELECT work_data FROM account_works WHERE account_id = ? AND work_id = ?').get(ACC4, 'note1');
  const work = JSON.parse(row.work_data);
  assert.equal(work.title, '笔记一');
  assert.equal(work.likeCount, 17000);
  assert.equal(work.collectedCount, 300);
  const points = db.prepare('SELECT * FROM work_stats_history WHERE account_id = ?').all(ACC4);
  assert.equal(points.length, 1);
  assert.equal(points[0].likes, 17000);
  // 未登录：静默跳过
  const mod2 = make({
    redfoxData: async () => ({}), callLlmJson: async () => ({}),
    xhsService: { getLoginStatus: async () => ({ data: { is_logged_in: false } }) },
  });
  const r2 = await mod2.syncXhsOwnWorks({ id: ACC4, plat: 'xhs' });
  assert.equal(r2.synced, 0);
  assert.equal(r2.reason, 'xhs-mcp 未登录');
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC4);
  db.prepare('DELETE FROM work_stats_history WHERE account_id = ?').run(ACC4);
});
