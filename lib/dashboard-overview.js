// 运营总览聚合：跨账号 KPI、问题分布、文章诊断列表、LLM 运营总结
// buildOverview 为纯读库聚合（可单测）；LLM 总结经 .make({ callLlmJson }) 注入
// 周闭环：generateSummary 把行动项落 weekly_actions 表（可勾选跟踪）、快照问题分布（算周趋势），
// 下周生成时带上上周行动状态与行动后新发文表现，让 LLM 验证上周建议是否奏效
const { db } = require('./db');
const { parseJson, weekStartKey } = require('./utils');
const { getLocalData, setLocalData } = require('./local-data');

const SUMMARY_MODULE = 'dashboard';
const SUMMARY_KEY = 'summary';
const DIST_HISTORY_KEY = 'issueDistHistory';
const MAX_ARTICLES = 200;
const ACTION_STATUSES = ['pending', 'done', 'dismissed'];
const ACTION_STATUS_LABEL = { pending: '未开始', done: '已完成', dismissed: '已忽略' };
const PERF_LABEL = { hot: '爆款', normal: '常规', cold: '冷门' };

// 周行动清单：generateSummary 落库，dashboard 勾选跟踪
function listWeekActions(week = weekStartKey()) {
  return db.prepare(
    'SELECT id, week, text, status, created_at, updated_at FROM weekly_actions WHERE week = ? ORDER BY id'
  ).all(week);
}

function setActionStatus(id, status) {
  if (!ACTION_STATUSES.includes(status)) throw new Error(`非法状态：${status}`);
  const r = db.prepare('UPDATE weekly_actions SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
  if (!r.changes) throw new Error('行动项不存在');
  return { id: Number(id), status };
}

// 问题分布周趋势：与最近一次非同周快照对比，无历史返回 null
function getIssueTrend(currentDist, now = Date.now()) {
  const thisWeek = weekStartKey(now);
  const row = getLocalData(SUMMARY_MODULE, DIST_HISTORY_KEY);
  const list = Array.isArray(row) ? row : [];
  const prev = list.find(e => e?.week && e.week !== thisWeek);
  if (!prev?.dist) return null;
  const delta = {};
  for (const k of ['topic', 'title', 'content']) delta[k] = (currentDist[k] || 0) - (prev.dist[k] || 0);
  return { prevWeek: prev.week, delta };
}

// 行动后新发文表现：publish_at 晚于 cutoff 且有诊断的作品（闭环验证素材）
function listWorksAfter(cutoffTs, limit = 8) {
  const rows = db.prepare(`
    SELECT w.account_id, w.work_data, w.publish_at, a.title, a.ratio, a.performance
    FROM account_works w
    JOIN article_analysis a ON a.account_id = w.account_id AND a.content_key = w.content_key
    WHERE w.publish_at > ?
    ORDER BY w.publish_at DESC LIMIT ?
  `).all(cutoffTs, limit);
  const accRows = db.prepare('SELECT id, tracker_id, name FROM my_accounts').all();
  const nameOf = new Map();
  for (const a of accRows) { nameOf.set(a.id, a.name); if (a.tracker_id) nameOf.set(a.tracker_id, a.name); }
  return rows.map(r => ({
    accountName: nameOf.get(r.account_id) || '未知账号',
    title: r.title || parseJson(r.work_data)?.title || '(无标题)',
    ratio: r.ratio ?? null,
    performance: r.performance || 'normal',
  }));
}

// 账号在快照/文章分析表里的主键：优先 tracker_id，与 routes/accounts.js 的聚合口径一致
function accountKey(row) {
  return row.tracker_id || row.id;
}

function parseAnalysis(row) {
  const a = parseJson(row.analysis);
  if (!a || typeof a !== 'object') return null;
  return {
    topicScore: a.topicScore ?? null,
    titleScore: a.titleScore ?? null,
    contentScore: a.contentScore ?? null,
    mainIssue: a.mainIssue || 'none',
    issueDetail: a.issueDetail || '',
    why: a.why || '',
    suggestions: Array.isArray(a.suggestions) ? a.suggestions : [],
  };
}

// 跨账号运营总览聚合
function buildOverview(now = Date.now()) {
  const accountRows = db.prepare(`
    SELECT id, tracker_id, name, plat, avatar FROM my_accounts ORDER BY created_at DESC
  `).all();
  const snapStmt = db.prepare(`
    SELECT score, snapshot_date, captured_at FROM account_snapshots
    WHERE account_id = ? AND score IS NOT NULL
    ORDER BY snapshot_date DESC, captured_at DESC LIMIT 2
  `);
  const sparkStmt = db.prepare(`
    SELECT score FROM account_snapshots
    WHERE account_id = ? AND score IS NOT NULL
    ORDER BY snapshot_date DESC, captured_at DESC LIMIT 8
  `);
  const analysisRows = db.prepare(`
    SELECT account_id, content_key, plat, title, url, reads, baseline_reads,
           ratio, performance, analysis, updated_at
    FROM article_analysis ORDER BY updated_at DESC LIMIT ?
  `).all(MAX_ARTICLES);

  // 文章按账号分组
  const analysesByAccount = new Map();
  for (const row of analysisRows) {
    const list = analysesByAccount.get(row.account_id) || [];
    list.push(row);
    analysesByAccount.set(row.account_id, list);
  }

  const accounts = accountRows.map(row => {
    const key = accountKey(row);
    const snaps = snapStmt.all(key);
    const latest = snaps[0] || null;
    const prev = snaps[1] || null;
    const score = latest?.score ?? null;
    const trend = (score != null && prev?.score != null) ? Number((score - prev.score).toFixed(1)) : null;
    const lastDate = latest ? (latest.snapshot_date || latest.captured_at) : null;
    const lastTs = lastDate ? (typeof lastDate === 'number' ? lastDate : Date.parse(String(lastDate).replace(/-/g, '/'))) : null;
    const daysSince = lastTs ? Math.floor((now - lastTs) / 86400000) : null;
    const mine = analysesByAccount.get(key) || [];
    const issueCount = { topic: 0, title: 0, content: 0 };
    let hot = 0, cold = 0, normal = 0;
    for (const r of mine) {
      if (r.performance === 'hot') hot++;
      else if (r.performance === 'cold') cold++;
      else normal++;
      const issue = parseJson(r.analysis)?.mainIssue;
      if (issue && issueCount[issue] != null) issueCount[issue]++;
    }
    const topIssue = Object.entries(issueCount).sort((a, b) => b[1] - a[1])[0];
    return {
      id: row.id,
      name: row.name,
      plat: row.plat,
      avatar: row.avatar || '',
      score,
      trend,
      daysSince,
      lastDate,
      scoreHistory: sparkStmt.all(key).map(s => s.score).reverse(),
      analyzed: mine.length,
      hot, cold, normal,
      topIssue: topIssue && topIssue[1] > 0 ? topIssue[0] : null,
    };
  });

  const accountByKey = new Map(accountRows.map(row => [accountKey(row), row]));
  const syncStmt = db.prepare('SELECT MAX(synced_at) AS s FROM account_works WHERE account_id = ? AND content_key = ?');
  const articles = analysisRows.map(row => {
    const acc = accountByKey.get(row.account_id);
    return {
      contentKey: row.content_key,
      accountId: row.account_id,
      accountName: acc?.name || '未知账号',
      avatar: acc?.avatar || '',
      plat: row.plat,
      title: row.title || '(无标题)',
      url: row.url || '',
      reads: row.reads ?? 0,
      baselineReads: row.baseline_reads ?? 0,
      ratio: row.ratio ?? null,
      performance: row.performance || 'normal',
      analysis: parseAnalysis(row),
      updatedAt: row.updated_at,
      statsSyncedAt: syncStmt.get(row.account_id, row.content_key)?.s || null,
    };
  });

  // 全局统计
  const diagnosed = accounts.filter(a => a.score != null);
  const issueDist = { topic: 0, title: 0, content: 0 };
  let hotCount = 0, coldCount = 0, normalCount = 0;
  for (const a of articles) {
    if (a.performance === 'hot') hotCount++;
    else if (a.performance === 'cold') coldCount++;
    else normalCount++;
    if (a.analysis?.mainIssue && issueDist[a.analysis.mainIssue] != null) {
      issueDist[a.analysis.mainIssue]++;
    }
  }
  const stats = {
    accountCount: accounts.length,
    diagnosedCount: diagnosed.length,
    pendingDiagnose: accounts.length - diagnosed.length,
    avgScore: diagnosed.length
      ? Number((diagnosed.reduce((s, a) => s + a.score, 0) / diagnosed.length).toFixed(1))
      : null,
    analyzedArticles: articles.length,
    hotCount, coldCount, normalCount,
    issueDist,
  };

  return {
    stats,
    accounts,
    articles,
    weekActions: listWeekActions(weekStartKey(now)),
    issueTrend: getIssueTrend(issueDist, now),
    generatedAt: now,
  };
}

function getSummary() {
  const cached = getLocalData(SUMMARY_MODULE, SUMMARY_KEY);
  if (!cached || typeof cached !== 'object') return null;
  return { summary: cached.data || null, generatedAt: cached.generatedAt || null };
}

function make({ callLlmJson }) {
  // LLM 运营总结：聚合账号分数/涨跌、短板分布、典型降级/爆款文诊断 → 总评+问题+行动
  // 周闭环：带上上周行动回顾与行动后新发文表现让 LLM 验证效果；行动项落库可勾选；问题分布快照算趋势
  async function generateSummary() {
    const overview = buildOverview();
    const { stats, accounts, articles } = overview;
    if (!accounts.length) throw new Error('还没有添加账号，请先在「账号追踪」添加');
    if (!stats.analyzedArticles && !stats.diagnosedCount) {
      throw new Error('还没有可总结的数据，请先诊断账号或分析文章');
    }

    const now = Date.now();
    const thisWeek = weekStartKey(now);
    const lastWeek = weekStartKey(now - 7 * 86400000);
    const lastActions = listWeekActions(lastWeek);
    // 行动后新发文：上周行动生成之后发布的作品；无上周行动则看本周新发文
    const cutoff = lastActions.length
      ? Math.min(...lastActions.map(a => a.created_at))
      : new Date(`${thisWeek}T00:00:00`).getTime();
    const newWorks = listWorksAfter(cutoff);

    const coldArticles = articles
      .filter(a => a.performance === 'cold')
      .sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99))
      .slice(0, 5);
    const hotArticles = articles
      .filter(a => a.performance === 'hot')
      .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
      .slice(0, 3);

    const payload = [
      `账号数 ${stats.accountCount}，已诊断 ${stats.diagnosedCount}，平均分 ${stats.avgScore ?? '无'}`,
      `文章分析 ${stats.analyzedArticles} 篇：爆款 ${stats.hotCount}、常规 ${stats.normalCount}、冷门 ${stats.coldCount}`,
      `短板分布：选题 ${stats.issueDist.topic}、标题 ${stats.issueDist.title}、内容 ${stats.issueDist.content}`,
      '',
      '【各账号】' + accounts.map(a =>
        `${a.name}（${a.plat}）：分数 ${a.score ?? '未诊断'}${a.trend != null ? `，较上次 ${a.trend > 0 ? '+' : ''}${a.trend}` : ''}，爆款 ${a.hot} 冷门 ${a.cold}`
      ).join('；'),
      '',
      '【典型降级文】' + (coldArticles.map(a =>
        `《${a.title}》(${a.accountName}，${a.ratio}x 均阅，短板 ${a.analysis?.mainIssue || '?'}：${a.analysis?.issueDetail || a.analysis?.why || '无诊断'})`
      ).join('；') || '无'),
      '',
      '【典型爆款】' + (hotArticles.map(a =>
        `《${a.title}》(${a.accountName}，${a.ratio}x 均阅：${a.analysis?.why || '无诊断'})`
      ).join('；') || '无'),
      '',
      '【上周行动回顾】' + (lastActions.length
        ? lastActions.map(a => `[${ACTION_STATUS_LABEL[a.status] || a.status}] ${a.text}`).join('；')
        : '无（上周未生成行动清单）'),
      '',
      '【行动后新发文表现】' + (newWorks.length
        ? newWorks.map(w => `《${w.title}》(${w.accountName}，${w.ratio == null ? '无基线' : w.ratio + 'x 均阅'}，${PERF_LABEL[w.performance] || w.performance})`).join('；')
        : '行动后暂无带诊断的新发文'),
    ].join('\n');

    const result = await callLlmJson([
      {
        role: 'system',
        content: '你是自媒体运营总监。基于跨账号的真实运营数据，输出一段运营总结。'
          + '只输出 JSON 对象：{"overall":"2-3 句总评，点出整体健康度与最突出问题",'
          + '"actionReview":"上周行动回顾与效果评价（1-2 句，结合新发文表现判断哪些行动奏效/没奏效）；没有上周行动数据则为空字符串",'
          + '"keyProblems":["按严重度排序的关键问题，每条一句，具体到账号或文章"],'
          + '"actions":["本周可执行行动，每条一句，具体可落地"],'
          + '"highlights":["值得保持的亮点，没有就空数组"]}。'
          + 'keyProblems 和 actions 各 2-4 条。已完成的上周行动不要原样重复，未奏效的要换打法。必须基于给定数据，不得编造。',
      },
      { role: 'user', content: payload },
    ], { maxTokens: 4000, timeoutMs: 90000 });

    const summary = {
      overall: String(result?.overall || ''),
      actionReview: String(result?.actionReview || ''),
      keyProblems: Array.isArray(result?.keyProblems) ? result.keyProblems.map(String).slice(0, 5) : [],
      actions: Array.isArray(result?.actions) ? result.actions.map(String).slice(0, 5) : [],
      highlights: Array.isArray(result?.highlights) ? result.highlights.map(String).slice(0, 3) : [],
    };
    const generatedAt = Date.now();
    const persist = db.transaction(() => {
      setLocalData(SUMMARY_MODULE, SUMMARY_KEY, { data: summary, generatedAt });
      // 行动项落库：本周未开始的旧建议被新一轮替换，已标记完成/忽略的保留
      db.prepare("DELETE FROM weekly_actions WHERE week = ? AND status = 'pending'").run(thisWeek);
      const ins = db.prepare(
        "INSERT INTO weekly_actions (week, text, status, summary_generated_at, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?)"
      );
      for (const text of summary.actions) ins.run(thisWeek, text, generatedAt, now, now);
      // 问题分布快照（每周一条，留 8 周算趋势）
      const histRow = getLocalData(SUMMARY_MODULE, DIST_HISTORY_KEY);
      const hist = Array.isArray(histRow) ? histRow : [];
      const nextHist = [{ week: thisWeek, dist: stats.issueDist, at: now }, ...hist.filter(e => e?.week !== thisWeek)].slice(0, 8);
      setLocalData(SUMMARY_MODULE, DIST_HISTORY_KEY, nextHist);
    });
    persist();
    return { summary, generatedAt };
  }

  return { generateSummary, getSummary };
}

module.exports = { make, buildOverview, getSummary, listWeekActions, setActionStatus, getIssueTrend, listWorksAfter };
