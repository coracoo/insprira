// 文章级表现分析：与账号自身基线对比判定升级/降级，LLM 逐篇诊断选题/标题/内容
// 纯函数（baseline/选篇/分类）直接导出便于单测；外呼（RedFox 正文、LLM）经 .make(deps) 注入
const crypto = require('crypto');
const { db } = require('./db');
const { parseJson, toNumber, parseCountText, workContentKey } = require('./utils');
const { getFirst24hGrowth, getAccountTypical24h, recordWorkStats } = require('./work-stats');

// 表现阈值：≥1.5 倍均阅为升级（爆款），≤0.6 倍为降级（冷门）
const HOT_RATIO = 1.5;
const COLD_RATIO = 0.6;
// 同一篇 7 天内不重复分析（LLM 成本控制）；但数据有更新且距上次分析 >24h 时允许重算
const REANALYZE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const REANALYZE_MIN_GAP_MS = 24 * 60 * 60 * 1000;
// 发布未满 48h 的作品不下结论（RedFox 数据延迟，当日评价不准）
const MATURITY_MS = 48 * 60 * 60 * 1000;
const MAX_LLM_WORKS = 10;    // 每次最多分析的篇数
const MAX_CONTENT_WORKS = 3; // 每次最多拉几篇 gzh 正文（RedFox 配额控制）
const CONTENT_TRUNCATE = 2000;

// 从作品原始数据提取阅读数（各平台字段不同，多字段回退）
function workReads(work) {
  return toNumber(work.readCount ?? work.clicksCount ?? work.viewCount ?? work.playCount ?? work.reads ?? work['阅读数']) || 0;
}

function workLikes(work) {
  return toNumber(work.likeCount ?? work.diggCount ?? work.likes ?? work['点赞数']) || 0;
}

function workComments(work) {
  return toNumber(work.commentsCount ?? work.commentCount ?? work.comments ?? work['评论数']) || 0;
}

function workUrl(work) {
  return work.url || work.workUrl || work.shareUrl || work.sourceUrl || work['链接'] || '';
}

function classifyPerformance(ratio) {
  if (ratio == null) return 'normal';
  if (ratio >= HOT_RATIO) return 'hot';
  if (ratio <= COLD_RATIO) return 'cold';
  return 'normal';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 诊断快照 raw_data.works 是另一条作品数据来源（标题为 markdown 链接、中文字段），
// account_works 未同步时用它兜底，与 dashboard 展示保持一致
function getSnapshotWorks(accountId, limit = 30) {
  const row = db.prepare(`
    SELECT raw_data FROM account_snapshots
    WHERE account_id = ? AND raw_data IS NOT NULL
    ORDER BY snapshot_date DESC, captured_at DESC LIMIT 1
  `).get(accountId);
  const report = row ? parseJson(row.raw_data) : null;
  const works = Array.isArray(report?.works) ? report.works : [];
  const out = [];
  for (const w of works) {
    const rawTitle = String(w['标题'] || w.title || '');
    const title = (rawTitle.match(/^\[([^\]]+)\]\(/)?.[1]
      || rawTitle.replace(/\]\(https?:\/\/[^\)]*\)$/, '').replace(/^\[/, '')).trim();
    const url = rawTitle.match(/\((https?:\/\/[^\)]+)\)/)?.[1] || workUrl(w);
    const reads = workReads(w);
    if (!title || reads <= 0) continue;
    const publishTime = w['发布时间'] || w.date || '';
    const publishAt = Date.parse(String(publishTime).replace(/-/g, '/')) || 0;
    const contentKey = crypto.createHash('sha1')
      .update([title.toLowerCase(), String(publishTime)].join('\n')).digest('hex');
    out.push({
      contentKey,
      work: { title, url, readCount: reads, likeCount: workLikes(w), commentsCount: workComments(w), publishTime },
      publishAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// 账号基线：最近 30 篇有阅读数作品的均阅与均互动率；account_works 未同步时用诊断快照兜底
function getWorksBaseline(accountId) {
  const rows = db.prepare(`
    SELECT work_data FROM account_works
    WHERE account_id = ?
    ORDER BY COALESCE(publish_at, 0) DESC, synced_at DESC
    LIMIT 60
  `).all(accountId);
  const works = rows.map(row => parseJson(row.work_data)).filter(Boolean);
  const source = works.length ? works : getSnapshotWorks(accountId).map(item => item.work);
  const readsList = [];
  const engagementRates = [];
  for (const work of source) {
    const reads = workReads(work);
    if (reads <= 0) continue;
    readsList.push(reads);
    engagementRates.push((workLikes(work) + workComments(work)) / reads);
    if (readsList.length >= 30) break;
  }
  const avgReads = readsList.length ? Math.round(readsList.reduce((a, b) => a + b, 0) / readsList.length) : 0;
  const avgEngagement = engagementRates.length
    ? engagementRates.reduce((a, b) => a + b, 0) / engagementRates.length
    : 0;
  return { avgReads, avgEngagement, count: readsList.length };
}

// 选取待分析作品：成熟（≥48h）且有阅读数据的篇目；
// 跳过规则：7 天内分析过且数据无更新的跳过；数据有更新且距上次 >24h 的允许重算；
// account_works 为空用快照兜底。返回 { picked, observing }（observing = 观察期篇数）
function selectWorksForAnalysis(accountId, limit = MAX_LLM_WORKS, now = Date.now()) {
  const rows = db.prepare(`
    SELECT work_id, content_key, work_data, publish_at, synced_at FROM account_works
    WHERE account_id = ?
    ORDER BY COALESCE(publish_at, 0) DESC, synced_at DESC
    LIMIT 100
  `).all(accountId);
  const analysisRows = db.prepare(`
    SELECT content_key, updated_at FROM article_analysis
    WHERE account_id = ? AND updated_at > ?
  `).all(accountId, now - REANALYZE_AFTER_MS);
  const analysisByKey = new Map(analysisRows.map(r => [r.content_key, r.updated_at]));
  const syncedByKey = new Map(rows.map(r => [r.content_key, r.synced_at]));
  const isDone = (key) => {
    const analyzedAt = analysisByKey.get(key);
    if (!analyzedAt) return false;
    const statsSyncedAt = syncedByKey.get(key) || 0;
    const hasFreshData = statsSyncedAt > analyzedAt && analyzedAt < now - REANALYZE_MIN_GAP_MS;
    return !hasFreshData;
  };
  let candidates = rows.map(row => ({
    contentKey: row.content_key,
    workId: row.work_id,
    work: parseJson(row.work_data),
    publishAt: row.publish_at || 0,
  }));
  if (!candidates.some(c => c.work && workReads(c.work) > 0)) {
    candidates = getSnapshotWorks(accountId, 30);
  }
  const picked = [];
  const seen = new Set();
  let observing = 0;
  for (const { contentKey: key, workId, work, publishAt } of candidates) {
    if (!work || workReads(work) <= 0) continue;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // 发布未满 48h：数据未成熟，标观察中暂不下结论
    if (publishAt && now - publishAt < MATURITY_MS) { observing++; continue; }
    if (isDone(key)) continue;
    picked.push({ contentKey: key, workId, work, publishAt });
    if (picked.length >= limit) break;
  }
  return { picked, observing };
}

function listArticleAnalyses(accountId) {
  const rows = db.prepare(`
    SELECT content_key, plat, title, url, reads, baseline_reads, ratio, performance, analysis, has_content, updated_at
    FROM article_analysis WHERE account_id = ?
    ORDER BY updated_at DESC LIMIT 50
  `).all(accountId);
  const map = {};
  for (const row of rows) {
    map[row.content_key] = {
      contentKey: row.content_key,
      plat: row.plat,
      title: row.title || '',
      url: row.url || '',
      reads: row.reads,
      baselineReads: row.baseline_reads,
      ratio: row.ratio,
      performance: row.performance || 'normal',
      analysis: parseJson(row.analysis) || null,
      hasContent: Boolean(row.has_content),
      updatedAt: row.updated_at,
    };
  }
  return map;
}

function make({ redfoxData, callLlmJson, xhsService = null, mpOfficial = null }) {
  // XHS 账号：经 xhs-mcp（用户自己的登录态）拉准实时互动数据，upsert 进 account_works 并留历史点
  // 未配置/未登录/失败都静默降级，不影响 RedFox 数据路径
  async function syncXhsOwnWorks(account) {
    const accountId = account.trackerId || account.id;
    if (account.plat !== 'xhs' || !xhsService) return { synced: 0 };
    try {
      const status = await xhsService.getLoginStatus().catch(() => null);
      if (!status?.data?.is_logged_in) return { synced: 0, reason: 'xhs-mcp 未登录' };
      const profile = await xhsService.getMyProfile();
      const feeds = profile?.data?.data?.feeds || profile?.data?.feeds || [];
      if (!feeds.length) return { synced: 0, reason: '主页未返回笔记' };
      const now = Date.now();
      const findStmt = db.prepare(
        'SELECT work_data, publish_at FROM account_works WHERE account_id = ? AND plat = ? AND work_id = ?'
      );
      const upsert = db.prepare(`
        INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
        VALUES (?, 'xhs', ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, plat, work_id) DO UPDATE SET
          work_data = excluded.work_data,
          synced_at = excluded.synced_at,
          publish_at = COALESCE(excluded.publish_at, account_works.publish_at),
          content_key = excluded.content_key
      `);
      const statsItems = [];
      let synced = 0;
      for (const feed of feeds) {
        const workId = String(feed.id || '');
        if (!workId) continue;
        const card = feed.noteCard || {};
        const info = card.interactInfo || {};
        const title = String(card.displayTitle || '').trim();
        const likes = parseCountText(info.likedCount);
        const collects = parseCountText(info.collectedCount);
        const comments = parseCountText(info.commentCount);
        const existing = findStmt.get(accountId, 'xhs', workId);
        const work = existing ? (parseJson(existing.work_data) || {}) : {};
        if (title && !work.title) work.title = title;
        if (likes != null) work.likeCount = likes;
        if (collects != null) work.collectedCount = collects;
        if (comments != null) work.commentsCount = comments;
        if (!work.url && !work.workUrl) work.url = `https://www.xiaohongshu.com/explore/${workId}`;
        upsert.run(accountId, workId, JSON.stringify(work), now, existing?.publish_at ?? null, workContentKey(work));
        statsItems.push({
          workId,
          reads: toNumber(work.viewCount ?? work.readCount),
          likes: likes ?? null,
          comments: comments ?? null,
        });
        synced++;
      }
      recordWorkStats(accountId, 'xhs', statsItems, now);
      return { synced };
    } catch (e) {
      console.warn('[article-analysis] XHS MCP 准实时同步失败（降级 RedFox 数据）:', e.message);
      return { synced: 0, error: e.message };
    }
  }

  // 拉 gzh 正文：从文章 URL 解析 biz/mid/idx/sn，失败返回 null（不阻断整体分析）
  async function fetchGzhContent(url) {
    if (!url) return null;
    let biz = '', mid = '', idx = '', sn = '';
    try {
      const parsed = new URL(url);
      biz = parsed.searchParams.get('__biz') || '';
      mid = parsed.searchParams.get('mid') || '';
      idx = parsed.searchParams.get('idx') || '';
      sn = parsed.searchParams.get('sn') || '';
    } catch { return null; }
    if (!biz || !mid) return null;
    try {
      const data = await redfoxData('gzhData/queryArticleDetail', {
        biz, mid, idx, sn, url, source: '灵感熔炉-文章分析',
      });
      const html = data?.content || data?.articleContent || data?.htmlContent || data?.contentHtml || '';
      const text = stripHtml(html);
      return text ? text.slice(0, CONTENT_TRUNCATE) : null;
    } catch (e) {
      console.warn(`[article-analysis] 拉取正文失败 ${url}:`, e.message);
      return null;
    }
  }

  async function analyzeAccountWorks(account) {
    const accountId = account.trackerId || account.id;
    // XHS 账号先用自己登录态刷新互动数据（准实时），失败静默降级
    const xhsSync = account.plat === 'xhs' ? await syncXhsOwnWorks(account) : null;
    // 公众号若配置了官方 AppID/AppSecret，先同步官方 T+1 权威阅读数据，失败静默降级
    const mpSync = account.plat === 'gzh' && mpOfficial
      ? await mpOfficial.syncMpOfficialStats({ account }).catch(e => ({ synced: 0, error: e.message, ...(e.errcode ? { errcode: e.errcode, ip: e.ip } : {}) }))
      : null;
    const baseline = getWorksBaseline(accountId);
    if (!baseline.count) {
      return { analyzed: 0, results: [], observing: 0, message: '该账号还没有带阅读数据的作品，请先在「账号追踪」同步' };
    }
    const { picked, observing } = selectWorksForAnalysis(accountId);
    if (!picked.length) {
      return {
        analyzed: 0, results: [], observing,
        message: observing
          ? `${observing} 篇作品发布未满 48 小时，观察中暂不下结论`
          : '近期作品都已分析过（数据无更新时 7 天内不重复分析）',
      };
    }

    // 账号典型 24h 增速（样本不足为 null）；用于给 LLM 补充同期增速口径
    const typical24h = getAccountTypical24h(accountId);

    // 计算每篇表现
    const items = picked.map(({ contentKey, workId, work, publishAt }) => {
      const reads = workReads(work);
      const ratio = baseline.avgReads ? reads / baseline.avgReads : null;
      return {
        contentKey,
        workId,
        work,
        publishAt,
        title: String(work.title || work.desc || '(无标题)').trim(),
        url: workUrl(work),
        reads,
        likes: workLikes(work),
        comments: workComments(work),
        ratio: ratio == null ? null : Number(ratio.toFixed(2)),
        performance: classifyPerformance(ratio),
        growth24h: workId && publishAt ? getFirst24hGrowth(accountId, workId, publishAt) : null,
        content: null,
      };
    });

    // 仅对表现异常（升级/降级）的 gzh 篇目拉正文，控制 RedFox 配额
    if (account.plat === 'gzh') {
      let fetched = 0;
      for (const item of items) {
        if (fetched >= MAX_CONTENT_WORKS) break;
        if (item.performance === 'normal') continue;
        item.content = await fetchGzhContent(item.url);
        fetched++;
      }
    }

    // LLM 批量诊断：一次调用分析全部选中篇目，按 index 对齐结果
    const worksDesc = items.map((item, i) => [
      `【${i}】标题：${item.title}`,
      `阅读 ${item.reads}（账号均阅 ${baseline.avgReads}，${item.ratio == null ? '无基线对比' : item.ratio + ' 倍'}，判定：${item.performance === 'hot' ? '升级' : item.performance === 'cold' ? '降级' : '持平'}）`,
      `点赞 ${item.likes}｜评论 ${item.comments}`,
      item.growth24h != null
        ? `发布 24h 阅读增量 ${item.growth24h}${typical24h ? `（账号典型 ${typical24h.median}，样本 ${typical24h.samples} 篇）` : ''}`
        : null,
      item.content ? `正文摘要：${item.content}` : null,
    ].filter(Boolean).join('\n')).join('\n\n');

    const llmResult = await callLlmJson([
      {
        role: 'system',
        content: '你是自媒体内容诊断专家。基于给定作品的真实数据与其在账号内的相对表现，逐篇诊断。'
          + '只输出 JSON 对象 {"items":[...]}，items 每个元素对应输入编号：'
          + '[{"index":0,"topic_score":1-5,"title_score":1-5,"content_score":1-5,'
          + '"main_issue":"topic|title|content|none","issue_detail":"主要短板的一句话说明",'
          + '"why":"为什么这篇升级/降级/持平，要具体",'
          + '"suggestions":["可执行建议1","可执行建议2"]}]}。'
          + 'topic=选题（话题吸引力、受众匹配、时效性），title=标题（点击欲、信息量、与内容一致性），'
          + 'content=内容（结构、信息增量、完读性；无正文时基于数据推断并在 why 中注明）。'
          + 'main_issue 选得分最低且明显拖后腿的维度，表现好或无明显短板用 none。不得编造数据。',
      },
      {
        role: 'user',
        content: `平台：${account.plat}\n账号：${account.name}\n赛道：${(account.tracks || []).join('、') || '未提炼'}\n`
          + `账号基线：均阅 ${baseline.avgReads}，均互动率 ${(baseline.avgEngagement * 100).toFixed(2)}%，样本 ${baseline.count} 篇\n\n${worksDesc}`,
      },
    ], { maxTokens: 8000, timeoutMs: 180000 });

    const llmItems = Array.isArray(llmResult) ? llmResult : (Array.isArray(llmResult?.items) ? llmResult.items : []);
    const now = Date.now();
    const upsert = db.prepare(`
      INSERT INTO article_analysis (account_id, content_key, plat, title, url, reads, baseline_reads, ratio, performance, analysis, has_content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, content_key) DO UPDATE SET
        title = excluded.title, url = excluded.url, reads = excluded.reads,
        baseline_reads = excluded.baseline_reads, ratio = excluded.ratio,
        performance = excluded.performance, analysis = excluded.analysis,
        has_content = excluded.has_content, updated_at = excluded.updated_at
    `);
    const results = [];
    const saveAll = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const ai = llmItems.find(entry => Number(entry?.index) === i) || null;
        const analysis = ai ? {
          topicScore: toNumber(ai.topic_score),
          titleScore: toNumber(ai.title_score),
          contentScore: toNumber(ai.content_score),
          mainIssue: ['topic', 'title', 'content', 'none'].includes(ai.main_issue) ? ai.main_issue : 'none',
          issueDetail: String(ai.issue_detail || ''),
          why: String(ai.why || ''),
          suggestions: Array.isArray(ai.suggestions) ? ai.suggestions.map(String).slice(0, 3) : [],
        } : null;
        upsert.run(
          accountId, item.contentKey, account.plat, item.title, item.url,
          item.reads, baseline.avgReads, item.ratio, item.performance,
          analysis ? JSON.stringify(analysis) : null, item.content ? 1 : 0, now, now,
        );
        results.push({ ...item, work: undefined, content: undefined, analysis });
      }
    });
    saveAll();
    return { analyzed: results.length, results, baseline, observing, ...(xhsSync ? { xhsSync } : {}), ...(mpSync ? { mpSync } : {}) };
  }

  return { analyzeAccountWorks, fetchGzhContent, listArticleAnalyses, syncXhsOwnWorks };
}

module.exports = {
  make,
  HOT_RATIO,
  COLD_RATIO,
  MATURITY_MS,
  REANALYZE_MIN_GAP_MS,
  workReads,
  classifyPerformance,
  stripHtml,
  getSnapshotWorks,
  getWorksBaseline,
  selectWorksForAnalysis,
  listArticleAnalyses,
};
