// 微信公众平台官方 datacube 数据源：token 缓存 / 失效重试 / 同步幂等 / 账号匹配
// 经 _helper 引导（独立 DATA_DIR、关闭调度器），不碰真实 data/cache.db
require('./_helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../lib/db');
const { make, dateStr } = require('../lib/wechat-official');

const ACC = 'test-mp-official-acc';
// ENV_FILE 指向不存在路径，强制走 process.env，防真实 .env 配置干扰
const ENV_FILE = '/nonexistent/insprira-test.env';

process.env.MP_APP_ID = 'test-app-id';
process.env.MP_APP_SECRET = 'test-app-secret';
delete process.env.MP_ACCOUNT_NAME;

function cleanup() {
  db.prepare('DELETE FROM my_accounts WHERE id = ?').run(ACC);
  db.prepare('DELETE FROM account_works WHERE account_id = ?').run(ACC);
  db.prepare('DELETE FROM work_stats_history WHERE account_id = ?').run(ACC);
  db.prepare("DELETE FROM local_data WHERE module = 'wechat-official'").run();
}

// fetchImpl 工厂：token 按序列发放，datacube 行为由 handler 决定
function mockFetch({ tokens = ['tok1'], onDatacube } = {}) {
  const calls = { token: 0, datacube: 0 };
  const fetchImpl = async (url, opts) => {
    if (url.includes('/cgi-bin/token')) {
      const token = tokens[Math.min(calls.token, tokens.length - 1)];
      calls.token++;
      return { json: async () => ({ access_token: token, expires_in: 7200 }) };
    }
    calls.datacube++;
    const accessToken = new URL(url).searchParams.get('access_token');
    const body = JSON.parse(opts.body);
    return { json: async () => onDatacube(accessToken, body) };
  };
  return { fetchImpl, calls };
}

test('access_token 缓存：有效期内的重复获取不再请求', async () => {
  cleanup();
  const { fetchImpl, calls } = mockFetch();
  const mp = make({ ENV_FILE, fetchImpl });
  const t1 = await mp.getAccessToken();
  const t2 = await mp.getAccessToken();
  assert.equal(t1, 'tok1');
  assert.equal(t2, 'tok1');
  assert.equal(calls.token, 1);
});

test('datacube 遇 40001 自动刷新 token 并重试一次', async () => {
  cleanup();
  const { fetchImpl, calls } = mockFetch({
    tokens: ['tok-expired', 'tok-fresh'],
    onDatacube: (token) => (token === 'tok-expired' ? { errcode: 40001, errmsg: 'invalid credential' } : { list: [] }),
  });
  const mp = make({ ENV_FILE, fetchImpl });
  const data = await mp.datacube('getarticleread', { begin_date: '2026-08-01', end_date: '2026-08-01' });
  assert.deepEqual(data, { list: [] });
  assert.equal(calls.token, 2);
  assert.equal(calls.datacube, 2);
});

test('syncMpOfficialStats：按日幂等合并，重复同步不重复累计', async () => {
  cleanup();
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
    VALUES (?, NULL, '测试官号', 'gzh', '', ?, ?)
  `).run(ACC, Date.now(), Date.now());

  const now = Date.now();
  const day1 = dateStr(new Date(now - 86400000)); // 昨天
  const { fetchImpl } = mockFetch({
    onDatacube: (_token, body) => ({
      list: [{
        msgid: 'msg-1', title: '官方文章一',
        int_page_read_count: body.begin_date === day1 ? 100 : 200,
        ori_page_read_count: 10,
        int_page_read_user: 80, ori_page_read_user: 5,
        share_count: 3, add_to_fav_count: 1,
      }],
    }),
  });
  const mp = make({ ENV_FILE, fetchImpl });

  const r1 = await mp.syncMpOfficialStats({ days: 2, now });
  assert.equal(r1.synced, 2);
  assert.equal(r1.account, '测试官号');

  const works = db.prepare('SELECT * FROM account_works WHERE account_id = ?').all(ACC);
  assert.equal(works.length, 1);
  const work = JSON.parse(works[0].work_data);
  assert.equal(Object.keys(work.official_daily).length, 2);
  // 阅读 = 中间页 + 原文页，两天合计 (100+10) + (200+10) = 320
  assert.equal(work.readCount, 320);
  assert.equal(work.source, 'mp-official');
  const points1 = db.prepare('SELECT COUNT(*) n FROM work_stats_history WHERE account_id = ?').get(ACC).n;
  assert.equal(points1, 1);

  // 同样数据再同步一次：行不增、readCount 不翻倍、历史点不重复
  const r2 = await mp.syncMpOfficialStats({ days: 2, now });
  assert.equal(r2.synced, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_works WHERE account_id = ?').get(ACC).n, 1);
  const work2 = JSON.parse(db.prepare('SELECT work_data FROM account_works WHERE account_id = ?').get(ACC).work_data);
  assert.equal(work2.readCount, 320);
  assert.equal(Object.keys(work2.official_daily).length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM work_stats_history WHERE account_id = ?').get(ACC).n, 1);
});

test('MP_ACCOUNT_NAME 与账号不匹配时拒绝写入', async () => {
  cleanup();
  process.env.MP_ACCOUNT_NAME = '别的公众号';
  try {
    db.prepare(`
      INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
      VALUES (?, NULL, '测试官号', 'gzh', '', ?, ?)
    `).run(ACC, Date.now(), Date.now());
    const { fetchImpl, calls } = mockFetch({ onDatacube: () => ({ list: [] }) });
    const mp = make({ ENV_FILE, fetchImpl });
    const r = await mp.syncMpOfficialStats({ account: { id: ACC, name: '测试官号', plat: 'gzh' } });
    assert.equal(r.synced, 0);
    assert.ok(r.reason);
    assert.equal(calls.datacube, 0); // 未匹配不应发起任何 datacube 请求
  } finally {
    delete process.env.MP_ACCOUNT_NAME;
  }
});

test('40164 结构化返回：errcode + 被拒 IP，且首日即中止', async () => {
  cleanup();
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, created_at, updated_at)
    VALUES (?, NULL, '测试官号', 'gzh', '', ?, ?)
  `).run(ACC, Date.now(), Date.now());
  let datacubeCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/cgi-bin/token')) {
      return { json: async () => ({ errcode: 40164, errmsg: 'invalid ip 203.0.113.9 ipv6 ::ffff:203.0.113.9, not in whitelist rid: x' }) };
    }
    datacubeCalls++;
    return { json: async () => ({ list: [] }) };
  };
  const mp = make({ ENV_FILE, fetchImpl });
  const r = await mp.syncMpOfficialStats({ days: 7, now: Date.now() });
  assert.equal(r.synced, 0);
  assert.equal(r.errcode, 40164);
  assert.equal(r.ip, '203.0.113.9');
  assert.match(r.error, /白名单/);
  assert.equal(datacubeCalls, 0); // token 阶段就被拒，不进 datacube
});

test('dateStr 输出补零的 YYYY-MM-DD', () => {
  assert.equal(dateStr(new Date(2026, 0, 5)), '2026-01-05');
});
