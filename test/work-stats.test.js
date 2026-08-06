// 单篇指标时间序列：历史点记录 / 24h 增量 / 账号典型增速
// 经 _helper 引导（独立 DATA_DIR、关闭调度器），不碰真实 data/cache.db
require('./_helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const {
  recordWorkStats, getGrowthCurve, getFirst24hGrowth, getAccountTypical24h,
} = require('../lib/work-stats');

const ACC = 'test-ws-acc';
const DAY = 86400000;

function cleanup() {
  db.prepare('DELETE FROM work_stats_history WHERE account_id = ?').run(ACC);
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC);
}

test('recordWorkStats 追加历史点，相同数据不重复', () => {
  cleanup();
  const now = Date.now();
  const n1 = recordWorkStats(ACC, 'gzh', [{ workId: 'w1', reads: 100, likes: 5, comments: 2 }], now);
  assert.equal(n1, 1);
  const n2 = recordWorkStats(ACC, 'gzh', [{ workId: 'w1', reads: 100, likes: 5, comments: 2 }], now + 1000);
  assert.equal(n2, 0); // 与上一点相同，跳过
  const n3 = recordWorkStats(ACC, 'gzh', [{ workId: 'w1', reads: 150, likes: 6, comments: 2 }], now + 2000);
  assert.equal(n3, 1);
  const curve = getGrowthCurve(ACC, 'w1');
  assert.equal(curve.length, 2);
  assert.equal(curve[0].reads, 100);
  assert.equal(curve[1].reads, 150);
  cleanup();
});

test('recordWorkStats 忽略无 workId 或全无指标的项', () => {
  cleanup();
  const n = recordWorkStats(ACC, 'gzh', [
    { workId: '', reads: 100 },
    { workId: 'w2' },
    { workId: 'w3', reads: 0, likes: 0, comments: 0 }, // 0 是有效值
  ]);
  assert.equal(n, 1);
  cleanup();
});

test('getFirst24hGrowth 窗口内至少两点才算增量', () => {
  cleanup();
  const now = Date.now();
  const publishAt = now - 3 * DAY;
  recordWorkStats(ACC, 'gzh', [{ workId: 'w1', reads: 500 }], publishAt + 3600000);
  // 只有 1 个点 → null
  assert.equal(getFirst24hGrowth(ACC, 'w1', publishAt), null);
  recordWorkStats(ACC, 'gzh', [{ workId: 'w1', reads: 900 }], publishAt + 20 * 3600000);
  assert.equal(getFirst24hGrowth(ACC, 'w1', publishAt), 400);
  // 无 publishAt → null
  assert.equal(getFirst24hGrowth(ACC, 'w1', 0), null);
  cleanup();
});

test('getAccountTypical24h 样本不足 3 返回 null，足够取中位数', () => {
  cleanup();
  const now = Date.now();
  // 4 篇作品，各两个历史点，24h 增量分别为 100/200/300/400
  [100, 200, 300, 400].forEach((growth, i) => {
    const workId = `w${i}`;
    const publishAt = now - (10 + i) * DAY;
    db.prepare(`
      INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
      VALUES (?, 'gzh', ?, '{}', ?, ?, ?)
    `).run(ACC, workId, now, publishAt, `k${i}`);
    recordWorkStats(ACC, 'gzh', [{ workId, reads: 1000 }], publishAt + 3600000);
    recordWorkStats(ACC, 'gzh', [{ workId, reads: 1000 + growth }], publishAt + 20 * 3600000);
  });
  const typical = getAccountTypical24h(ACC);
  assert.equal(typical.samples, 4);
  assert.equal(typical.median, 250); // (200+300)/2
  // 删掉两篇后样本不足
  db.prepare("DELETE FROM account_works WHERE account_id = ? AND work_id IN ('w0','w1')").run(ACC);
  assert.equal(getAccountTypical24h(ACC), null);
  cleanup();
});
