// 运营总览聚合：buildOverview 统计/分布/排序 + LLM 总结缓存读写
// 经 _helper 引导（独立 DATA_DIR、关闭调度器），不碰真实 data/cache.db
require('./_helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const { buildOverview, getSummary, make } = require('../lib/dashboard-overview');

const ACC_A = 'test-ov-acc-a';
const ACC_B = 'test-ov-acc-b';

function seedAccount(id, trackerId, name) {
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
    VALUES (?, ?, ?, 'gzh', '', ?, ?)
  `).run(id, trackerId, name, Date.now(), Date.now());
}

function seedSnapshot(accountId, date, score, capturedAt) {
  db.prepare(`
    INSERT INTO account_snapshots (account_id, snapshot_date, score, captured_at)
    VALUES (?, ?, ?, ?)
    `).run(accountId, date, score, capturedAt);
}

function seedAnalysis(accountId, contentKey, { title, ratio, performance, mainIssue, why }) {
  const analysis = JSON.stringify({
    topicScore: 3, titleScore: 4, contentScore: 2,
    mainIssue, issueDetail: `${mainIssue} 短板说明`, why, suggestions: ['建议1'],
  });
  const now = Date.now();
  db.prepare(`
    INSERT INTO article_analysis (account_id, content_key, plat, title, url, reads, baseline_reads, ratio, performance, analysis, has_content, created_at, updated_at)
    VALUES (?, ?, 'gzh', ?, '', 100, 200, ?, ?, ?, 0, ?, ?)
  `).run(accountId, contentKey, title, ratio, performance, analysis, now, now);
}

function cleanup() {
  db.prepare('DELETE FROM my_accounts WHERE id IN (?, ?)').run(ACC_A, ACC_B);
  db.prepare('DELETE FROM account_snapshots WHERE account_id IN (?, ?, ?)').run(ACC_A, ACC_B, 'tracker-b');
  db.prepare('DELETE FROM article_analysis WHERE account_id IN (?, ?, ?)').run(ACC_A, ACC_B, 'tracker-b');
  db.prepare("DELETE FROM local_data WHERE module = 'dashboard'").run();
}

test('buildOverview 聚合 KPI、问题分布与账号行', () => {
  cleanup();
  seedAccount(ACC_A, null, '账号甲');
  seedAccount(ACC_B, 'tracker-b', '账号乙'); // 走 tracker_id 口径
  seedSnapshot(ACC_A, '2026-07-01', 70, 1000);
  seedSnapshot(ACC_A, '2026-08-01', 80, 2000);
  seedSnapshot('tracker-b', '2026-08-01', 55, 2000);
  seedAnalysis(ACC_A, 'k1', { title: '爆款文', ratio: 2.1, performance: 'hot', mainIssue: 'none', why: '选题蹭到热点' });
  seedAnalysis(ACC_A, 'k2', { title: '冷门文', ratio: 0.3, performance: 'cold', mainIssue: 'topic', why: '选题太窄' });
  seedAnalysis('tracker-b', 'k3', { title: '常规文', ratio: 1.0, performance: 'normal', mainIssue: 'title', why: '标题平淡' });

  const ov = buildOverview();
  assert.equal(ov.stats.accountCount, 2);
  assert.equal(ov.stats.diagnosedCount, 2);
  assert.equal(ov.stats.pendingDiagnose, 0);
  assert.equal(ov.stats.avgScore, 67.5);
  assert.equal(ov.stats.analyzedArticles, 3);
  assert.equal(ov.stats.hotCount, 1);
  assert.equal(ov.stats.coldCount, 1);
  assert.equal(ov.stats.normalCount, 1);
  assert.deepEqual(ov.stats.issueDist, { topic: 1, title: 1, content: 0 });

  const accA = ov.accounts.find(a => a.id === ACC_A);
  assert.equal(accA.score, 80);
  assert.equal(accA.trend, 10);
  assert.equal(accA.hot, 1);
  assert.equal(accA.cold, 1);
  assert.equal(accA.topIssue, 'topic');
  assert.ok(accA.scoreHistory.length >= 2);

  const accB = ov.accounts.find(a => a.id === ACC_B);
  assert.equal(accB.score, 55); // tracker_id 口径读到快照
  assert.equal(accB.analyzed, 1);

  const coldArticle = ov.articles.find(a => a.contentKey === 'k2');
  assert.equal(coldArticle.accountName, '账号甲');
  assert.equal(coldArticle.analysis.mainIssue, 'topic');
  assert.equal(coldArticle.analysis.why, '选题太窄');
  cleanup();
});

test('buildOverview 空库返回零值', () => {
  cleanup();
  const ov = buildOverview();
  assert.equal(ov.stats.accountCount, 0);
  assert.equal(ov.stats.avgScore, null);
  assert.deepEqual(ov.accounts, []);
  assert.deepEqual(ov.articles, []);
});

test('getSummary 无缓存返回 null', () => {
  cleanup();
  assert.equal(getSummary(), null);
});

test('generateSummary 调用 LLM 并写缓存', async () => {
  cleanup();
  seedAccount(ACC_A, null, '账号甲');
  seedSnapshot(ACC_A, '2026-08-01', 80, 2000);
  seedAnalysis(ACC_A, 'k2', { title: '冷门文', ratio: 0.3, performance: 'cold', mainIssue: 'topic', why: '选题太窄' });

  let prompt = '';
  const { generateSummary } = make({
    callLlmJson: async (messages) => {
      prompt = messages.map(m => m.content).join('\n');
      return { overall: '整体一般', keyProblems: ['选题是主要短板'], actions: ['重做选题库'], highlights: [] };
    },
  });
  const result = await generateSummary();
  assert.equal(result.summary.overall, '整体一般');
  assert.ok(result.generatedAt > 0);
  assert.ok(prompt.includes('冷门文')); // 聚合 payload 含典型降级文

  const cached = getSummary();
  assert.equal(cached.summary.keyProblems[0], '选题是主要短板');
  assert.equal(cached.generatedAt, result.generatedAt);
  cleanup();
});

test('generateSummary 无数据时抛错', async () => {
  cleanup();
  const { generateSummary } = make({ callLlmJson: async () => ({}) });
  await assert.rejects(() => generateSummary(), /还没有添加账号/);
});

// ============ 周闭环：行动持久化 / 上周回顾 / 问题趋势 ============
const { listWeekActions, setActionStatus, getIssueTrend, listWorksAfter } = require('../lib/dashboard-overview');
const { weekStartKey } = require('../lib/utils');

function seedWork(accountId, contentKey, publishAt) {
  db.prepare(`
    INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
    VALUES (?, 'gzh', ?, '{}', ?, ?, ?)
  `).run(accountId, `w-${contentKey}`, Date.now(), publishAt, contentKey);
}

function cleanupActions() {
  db.prepare('DELETE FROM weekly_actions').run();
  db.prepare('DELETE FROM account_works WHERE account_id IN (?, ?)').run(ACC_A, ACC_B);
}

test('generateSummary 行动项落库 + 上周回顾入 prompt + 问题分布快照', async () => {
  cleanup(); cleanupActions();
  seedAccount(ACC_A, null, '账号甲');
  seedAnalysis(ACC_A, 'k2', { title: '冷门文', ratio: 0.3, performance: 'cold', mainIssue: 'topic', why: '选题太窄' });
  // 上周行动（一条已完成、一条未开始）+ 行动后新发文（有诊断）
  const lastWeek = weekStartKey(Date.now() - 7 * 86400000);
  const lastWeekTs = new Date(`${lastWeek}T10:00:00`).getTime();
  const ins = db.prepare("INSERT INTO weekly_actions (week, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  ins.run(lastWeek, '重做选题库', 'done', lastWeekTs, lastWeekTs);
  ins.run(lastWeek, '优化标题模板', 'pending', lastWeekTs, lastWeekTs);
  seedWork(ACC_A, 'k2', lastWeekTs + 86400000); // 行动后发布

  let prompt = '';
  const { generateSummary } = make({
    callLlmJson: async (messages) => {
      prompt = messages.map(m => m.content).join('\n');
      return { overall: 'ok', actionReview: '上周选题行动奏效', keyProblems: [], actions: ['新行动A', '新行动B'], highlights: [] };
    },
  });
  const result = await generateSummary();
  assert.equal(result.summary.actionReview, '上周选题行动奏效');
  assert.ok(prompt.includes('[已完成] 重做选题库'), 'prompt 含上周已完成行动');
  assert.ok(prompt.includes('[未开始] 优化标题模板'), 'prompt 含上周未开始行动');
  assert.ok(prompt.includes('行动后新发文'), 'prompt 含新发文表现段落');

  // 本周行动落库
  const thisWeek = weekStartKey();
  const actions = listWeekActions(thisWeek);
  assert.deepEqual(actions.map(a => a.text), ['新行动A', '新行动B']);
  assert.ok(actions.every(a => a.status === 'pending'));

  // 重新生成：替换本周 pending，上周已标记的不动
  await generateSummary();
  assert.equal(listWeekActions(thisWeek).length, 2);
  assert.equal(listWeekActions(lastWeek).length, 2);

  // 问题分布快照 → 趋势可比
  const trend = getIssueTrend({ topic: 2, title: 0, content: 1 });
  // 快照里只有本周一条时，没有更早基准 → null
  assert.equal(trend, null);
  cleanup(); cleanupActions();
});

test('getIssueTrend 有上周快照时给出差值', async () => {
  cleanup(); cleanupActions();
  const { setLocalData } = require('../lib/local-data');
  const lastWeek = weekStartKey(Date.now() - 7 * 86400000);
  setLocalData('dashboard', 'issueDistHistory', [
    { week: weekStartKey(), dist: { topic: 1, title: 1, content: 0 }, at: Date.now() },
    { week: lastWeek, dist: { topic: 3, title: 0, content: 2 }, at: Date.now() - 86400000 },
  ]);
  const trend = getIssueTrend({ topic: 1, title: 1, content: 0 });
  assert.equal(trend.prevWeek, lastWeek);
  assert.deepEqual(trend.delta, { topic: -2, title: 1, content: -2 });
  cleanup(); cleanupActions();
});

test('setActionStatus 状态流转与校验', () => {
  cleanupActions();
  const thisWeek = weekStartKey();
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO weekly_actions (week, text, status, created_at, updated_at) VALUES (?, '测试行动', 'pending', ?, ?)"
  ).run(thisWeek, now, now);
  const id = Number(lastInsertRowid);
  assert.deepEqual(setActionStatus(id, 'done'), { id, status: 'done' });
  assert.equal(listWeekActions(thisWeek)[0].status, 'done');
  setActionStatus(id, 'dismissed');
  assert.equal(listWeekActions(thisWeek)[0].status, 'dismissed');
  assert.throws(() => setActionStatus(id, 'bogus'), /非法状态/);
  assert.throws(() => setActionStatus(999999, 'done'), /不存在/);
  cleanupActions();
});

test('listWorksAfter 只取 cutoff 后有诊断的作品', () => {
  cleanup(); cleanupActions();
  seedAccount(ACC_A, null, '账号甲');
  seedAnalysis(ACC_A, 'k9', { title: '新发文', ratio: 1.8, performance: 'hot', mainIssue: 'none', why: '好' });
  const now = Date.now();
  seedWork(ACC_A, 'k9', now - 3600000);
  seedWork(ACC_A, 'k-old', now - 10 * 86400000); // 无诊断且太早
  const works = listWorksAfter(now - 86400000);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, '新发文');
  assert.equal(works[0].accountName, '账号甲');
  assert.equal(works[0].performance, 'hot');
  cleanup(); cleanupActions();
});
