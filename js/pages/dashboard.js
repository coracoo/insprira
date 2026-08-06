import { localApi } from '../api.js';
import { LS } from '../state.js';
import { esc, fmt, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { initIcons } from '../icons.js';
import { toast, Modal } from '../components.js';

const ISSUE_LABEL = { topic: '选题', title: '标题', content: '内容' };
// MP 浏览器插件固定 ID（extension/mp-stats/manifest.json 内置 key 派生）
const MP_EXT_ID = 'kimpkibmhdimbomifeofhhefckgdhahj';

// 数据新鲜度：N 分钟/小时/天前
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  return `${Math.round(diff / 86400000)} 天前`;
}

export async function renderDashboard() {
  const rowsEl = document.getElementById('ops-account-rows');
  if (!rowsEl) return;

  try {
    const [overview, summaryData, trackers] = await Promise.all([
      localApi('dashboard/overview').catch(() => null),
      localApi('dashboard/summary').catch(() => null),
      localApi('trackers').catch(() => []),
    ]);

    const data = overview || { stats: {}, accounts: [], articles: [] };
    renderKpis(data.stats);
    renderSummaryCard(summaryData, data.stats, data.weekActions || []);
    renderIssueDist(data.stats, data.issueTrend);
    renderAccountRows(data.accounts);
    renderArticleLists(data.articles);
    renderQuickStats(trackers);
  } catch (e) {
    rowsEl.innerHTML = `<div class="text-red-400 text-sm py-4 text-center">${esc(e.message)}</div>`;
  }
}

// ============ KPI 条 ============

function renderKpis(stats = {}) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ops-kpi-accounts', stats.accountCount ?? 0);
  set('ops-kpi-score', stats.avgScore ?? '—');
  set('ops-kpi-analyzed', stats.analyzedArticles ?? 0);
  set('ops-kpi-hot', stats.hotCount ?? 0);
  set('ops-kpi-cold', stats.coldCount ?? 0);
  set('ops-kpi-pending', stats.pendingDiagnose ?? 0);
}

// ============ LLM 运营总结 ============

function renderSummaryCard(summaryData, stats = {}, weekActions = []) {
  const el = document.getElementById('ops-summary');
  if (!el) return;
  const summary = summaryData?.summary;
  const generatedAt = summaryData?.generatedAt;

  const genBtn = (label) => `
    <button class="btn btn-secondary py-1 px-3 text-xs inline-flex items-center gap-1.5" data-action="generateSummary">
      <i data-lucide="sparkles" class="w-3.5 h-3.5"></i><span>${label}</span>
    </button>`;

  // 本周行动：有持久化清单则渲染可勾选（闭环跟踪），否则回退总结里的纯文本
  const actionItem = (a) => {
    const done = a.status === 'done';
    const dismissed = a.status === 'dismissed';
    return `
      <li class="text-xs leading-relaxed flex items-start gap-1.5 group ${done ? 'text-gray-500 line-through' : dismissed ? 'text-gray-600' : 'text-gray-300'}">
        <button class="flex-shrink-0 mt-0.5 ${done ? 'text-emerald-400' : 'text-gray-500 hover:text-emerald-400'}" data-action="setActionStatus" data-id="${a.id}" data-status="${done ? 'pending' : 'done'}" title="${done ? '标记未做' : '标记完成'}">
          <i data-lucide="${done ? 'check-circle-2' : 'circle'}" class="w-3.5 h-3.5"></i>
        </button>
        <span class="flex-1 min-w-0">${esc(a.text)}</span>
        ${!done && !dismissed ? `<button class="flex-shrink-0 text-gray-600 hover:text-gray-400 opacity-0 group-hover:opacity-100" data-action="setActionStatus" data-id="${a.id}" data-status="dismissed" title="忽略"><i data-lucide="x" class="w-3 h-3"></i></button>` : ''}
      </li>`;
  };
  const actionsHtml = weekActions.length
    ? weekActions.filter(a => a.status !== 'dismissed').map(actionItem).join('') || '<li class="text-xs text-gray-600">—</li>'
    : (summary?.actions || []).map(a => `<li class="text-xs text-gray-300 leading-relaxed flex gap-1.5"><span class="text-amber-400 flex-shrink-0">▸</span>${esc(a)}</li>`).join('') || '<li class="text-xs text-gray-600">—</li>';

  let body;
  if (summary) {
    const timeStr = generatedAt ? new Date(generatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    body = `
      ${summary.overall ? `<p class="text-sm text-gray-200 leading-relaxed mb-4">${esc(summary.overall)}</p>` : ''}
      ${summary.actionReview ? `<div class="text-xs text-gray-200 bg-white/5 border border-white/10 rounded-lg px-3 py-2 mb-4 leading-relaxed"><span class="font-medium">上周回顾：</span>${esc(summary.actionReview)}</div>` : ''}
      <div class="grid md:grid-cols-3 gap-4">
        <div>
          <div class="text-[10px] uppercase tracking-wider text-red-400/80 mb-2">关键问题</div>
          <ul class="space-y-1.5">${(summary.keyProblems || []).map(p => `<li class="text-xs text-gray-300 leading-relaxed flex gap-1.5"><span class="text-red-400 flex-shrink-0">▸</span>${esc(p)}</li>`).join('') || '<li class="text-xs text-gray-600">—</li>'}</ul>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-amber-400/80 mb-2">本周行动${weekActions.length ? `（${weekActions.filter(a => a.status === 'done').length}/${weekActions.length}）` : ''}</div>
          <ul class="space-y-1.5">${actionsHtml}</ul>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-2">亮点</div>
          <ul class="space-y-1.5">${(summary.highlights || []).map(h => `<li class="text-xs text-gray-300 leading-relaxed flex gap-1.5"><span class="text-emerald-400 flex-shrink-0">▸</span>${esc(h)}</li>`).join('') || '<li class="text-xs text-gray-600">—</li>'}</ul>
        </div>
      </div>
      <div class="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
        <span class="text-[10px] text-gray-600">${timeStr ? `生成于 ${timeStr} · ` : ''}基于 ${stats.analyzedArticles ?? 0} 篇文章诊断与 ${stats.diagnosedCount ?? 0} 个账号评分</span>
        ${genBtn('重新生成')}
      </div>`;
  } else {
    const hasData = (stats.analyzedArticles ?? 0) > 0 || (stats.diagnosedCount ?? 0) > 0;
    body = `
      <div class="text-center py-6">
        <i data-lucide="clipboard-list" class="w-8 h-8 mx-auto mb-2 text-gray-600"></i>
        <div class="text-sm text-gray-400">还没有运营总结</div>
        <p class="text-xs text-gray-600 mt-1 mb-4">${hasData ? '基于已有的账号评分与文章诊断，让 LLM 生成整体运营建议' : '先在「账号追踪」诊断账号、点「分析文章」生成文章诊断，再来生成总结'}</p>
        ${hasData ? genBtn('生成运营总结') : ''}
      </div>`;
  }

  el.innerHTML = `
    <div class="flex items-center gap-2 mb-4">
      <i data-lucide="brain" class="w-4 h-4 text-amber-400"></i>
      <h2 class="text-sm font-semibold">运营总结</h2>
      <span class="text-[10px] text-gray-500">LLM 基于真实数据生成</span>
    </div>
    ${body}`;
  initIcons(el);
}

// 周行动勾选：完成/忽略/撤销，然后刷新 dashboard
export async function setActionStatus(el, d) {
  try {
    await localApi(`dashboard/actions/${d.id}`, { method: 'POST', body: { status: d.status } });
    await renderDashboard();
  } catch (e) {
    toast(`更新失败：${e.message}`, 'error');
  }
}

// LLM 运营总结：手动生成（有 LLM 调用成本，故不自动生成）
export async function generateSummary(el) {
  const btn = el?.closest('button');
  const originalHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'pointer-events-none');
    btn.innerHTML = '<i data-lucide="loader-circle" class="w-3.5 h-3.5 animate-spin"></i><span>生成中…</span>';
    initIcons(btn);
  }
  toast('正在生成运营总结（约 10-30 秒）…', 'info');
  try {
    await localApi('dashboard/summary', { method: 'POST' });
    toast('运营总结已生成', 'success');
    await renderDashboard();
  } catch (e) {
    toast(`生成失败：${e.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'pointer-events-none');
      btn.innerHTML = originalHtml;
      initIcons(btn);
    }
  }
}

// ============ 问题分布 ============

function renderIssueDist(stats = {}, issueTrend = null) {
  const el = document.getElementById('ops-issue-dist');
  if (!el) return;
  const issueDist = stats.issueDist || { topic: 0, title: 0, content: 0 };
  const issueTotal = issueDist.topic + issueDist.title + issueDist.content;
  const perfTotal = (stats.hotCount ?? 0) + (stats.normalCount ?? 0) + (stats.coldCount ?? 0);

  const deltaBadge = (key) => {
    const d = issueTrend?.delta?.[key];
    if (d == null) return '';
    if (d === 0) return '<span class="text-[10px] text-gray-600 ml-1">±0</span>';
    // 短板变多是坏事（红），变少是好事（绿）
    const cls = d > 0 ? 'text-red-400/80' : 'text-emerald-400/80';
    return `<span class="text-[10px] ${cls} ml-1">${d > 0 ? '+' : ''}${d}</span>`;
  };

  const bar = (label, count, total, color, textColor, trendKey) => {
    const pct = total ? Math.round(count / total * 100) : 0;
    return `
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-gray-400 w-10 flex-shrink-0">${label}</span>
        <div class="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
          <div class="h-full rounded-full ${color}" style="width:${Math.max(pct, count ? 6 : 0)}%"></div>
        </div>
        <span class="text-[11px] font-mono w-8 text-right ${textColor}">${count}</span>${trendKey ? deltaBadge(trendKey) : ''}
      </div>`;
  };

  el.innerHTML = `
    <h2 class="text-sm font-semibold flex items-center gap-2 mb-3"><i data-lucide="pie-chart" class="w-4 h-4 text-amber-400"></i>问题分布</h2>
    <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">短板维度（${issueTotal} 篇有诊断）${issueTrend ? `<span class="normal-case text-gray-600">· 较 ${issueTrend.prevWeek.slice(5)} 当周</span>` : ''}</div>
    <div class="space-y-2 mb-4">
      ${bar('选题', issueDist.topic, issueTotal, 'bg-amber-400', 'text-amber-400', 'topic')}
      ${bar('标题', issueDist.title, issueTotal, 'bg-sky-400', 'text-sky-400', 'title')}
      ${bar('内容', issueDist.content, issueTotal, 'bg-slate-400', 'text-slate-400', 'content')}
    </div>
    <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">表现分布（${perfTotal} 篇已分析）</div>
    <div class="space-y-2">
      ${bar('爆款', stats.hotCount ?? 0, perfTotal, 'bg-emerald-400', 'text-emerald-300')}
      ${bar('常规', stats.normalCount ?? 0, perfTotal, 'bg-gray-400', 'text-gray-300')}
      ${bar('冷门', stats.coldCount ?? 0, perfTotal, 'bg-red-400', 'text-red-300')}
    </div>
    ${!perfTotal ? '<div class="text-[11px] text-gray-600 mt-3">还没有文章分析数据，点击账号行的「分析文章」开始</div>' : ''}`;
  initIcons(el);
}

// ============ 账号概览（紧凑行） ============

function renderAccountRows(accounts = []) {
  const rowsEl = document.getElementById('ops-account-rows');
  const emptyEl = document.getElementById('ops-account-empty');
  if (!rowsEl) return;

  if (!accounts.length) {
    rowsEl.innerHTML = '';
    rowsEl.classList.add('hidden');
    emptyEl?.classList.remove('hidden');
    initIcons(emptyEl || rowsEl);
    return;
  }
  rowsEl.classList.remove('hidden');
  emptyEl?.classList.add('hidden');

  rowsEl.innerHTML = accounts.map(acc => {
    const avatar = proxyImage(acc.avatar);
    const initial = (acc.name || '?')[0];
    const platCls = acc.plat === 'dy' ? 'pill-hot' : acc.plat === 'xhs' ? 'pill-brand' : 'pill-green';
    const score = acc.score;
    const scoreColor = score == null ? 'text-gray-600'
      : score < 60 ? 'text-red-300' : score >= 80 ? 'text-emerald-300' : 'text-gray-200';
    const trendHtml = acc.trend != null
      ? (acc.trend > 0 ? `<span class="text-emerald-400">▲${acc.trend.toFixed(1)}</span>`
         : acc.trend < 0 ? `<span class="text-red-400">▼${Math.abs(acc.trend).toFixed(1)}</span>`
         : '<span class="text-gray-600">—</span>')
      : '';
    const stalePill = score == null
      ? '<span class="pill pill-gray !text-[10px]">未诊断</span>'
      : acc.daysSince > 7 ? `<span class="pill pill-amber !text-[10px]">${acc.daysSince}天前</span>` : '';
    const issuePill = acc.topIssue
      ? `<span class="pill pill-hot !text-[10px]">短板·${ISSUE_LABEL[acc.topIssue] || acc.topIssue}</span>` : '';
    const spark = (acc.scoreHistory || []).length >= 2 ? renderSparkline(acc.scoreHistory) : '';
    const perfStr = acc.analyzed
      ? `<span class="text-emerald-400/80">${acc.hot} 爆</span><span class="text-gray-600 mx-1">·</span><span class="text-red-400/80">${acc.cold} 冷</span><span class="text-gray-600 mx-1">·</span><span class="text-gray-500">${acc.analyzed} 篇</span>`
      : '<span class="text-gray-600">未分析</span>';

    return `
      <div class="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/[0.03] transition cursor-pointer" data-action="gotoPage" data-page="tracker">
        <div class="account-avatar flex-shrink-0" style="width:32px;height:32px;font-size:12px;">
          ${initial}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-sm font-medium truncate">${esc(acc.name)}</span>
            <span class="pill ${platCls} !text-[10px] !py-0 flex-shrink-0">${esc(platName(acc.plat))}</span>
            ${stalePill}${issuePill}
          </div>
          <div class="text-[10px] mt-0.5">${perfStr}</div>
        </div>
        <div class="flex-shrink-0 hidden sm:block">${spark}</div>
        <div class="flex-shrink-0 text-right w-16">
          <div class="text-lg font-bold leading-none ${scoreColor}">${score != null ? score.toFixed(1) : '—'}</div>
          <div class="text-[10px] mt-0.5">${trendHtml}</div>
        </div>
        <button class="btn btn-secondary py-1 px-2.5 text-[11px] flex-shrink-0 inline-flex items-center gap-1" data-action="analyzeMyWorks" data-id="${esc(acc.id)}" title="RedFox 数据 + LLM 逐篇诊断选题/标题/内容">
          <i data-lucide="sparkles" class="w-3 h-3"></i><span>分析文章</span>
        </button>
        ${acc.plat === 'gzh' ? `
        <button class="btn btn-secondary py-1 px-2.5 text-[11px] flex-shrink-0 inline-flex items-center gap-1" data-action="syncMpOfficial" data-id="${esc(acc.id)}" title="同步微信公众平台官方 T+1 阅读数据（需配置 MP_APP_ID/MP_APP_SECRET）">
          <i data-lucide="shield-check" class="w-3 h-3"></i><span>官方数据</span>
        </button>
        <button class="btn btn-secondary py-1 px-2.5 text-[11px] flex-shrink-0 inline-flex items-center gap-1" data-action="fetchMpStats" title="调用浏览器插件，用你已登录的公众号后台会话抓一次准实时数据">
          <i data-lucide="download" class="w-3 h-3"></i><span>浏览器取数</span>
        </button>` : ''}
      </div>`;
  }).join('');
  initIcons(rowsEl);
}

function renderSparkline(values) {
  const w = 56, h = 22, pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const isUp = values[values.length - 1] >= values[0];
  const color = isUp ? '#059669' : '#dc2626';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" />
  </svg>`;
}

// ============ 文章诊断列表（需关注 / 爆款经验） ============

function renderArticleLists(articles = []) {
  const cold = articles
    .filter(a => a.performance === 'cold')
    .sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99))
    .slice(0, 10);
  const hot = articles
    .filter(a => a.performance === 'hot')
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
    .slice(0, 10);

  const coldList = document.getElementById('ops-cold-list');
  const hotList = document.getElementById('ops-hot-list');
  const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n ? `${n} 篇` : ''; };
  setCount('ops-cold-count', cold.length);
  setCount('ops-hot-count-articles', hot.length);

  if (coldList) {
    coldList.innerHTML = cold.map(a => renderArticleCard(a, 'cold')).join('');
    coldList.classList.toggle('hidden', !cold.length);
    initIcons(coldList);
  }
  document.getElementById('ops-cold-empty')?.classList.toggle('hidden', Boolean(cold.length));
  if (hotList) {
    hotList.innerHTML = hot.map(a => renderArticleCard(a, 'hot')).join('');
    hotList.classList.toggle('hidden', !hot.length);
    initIcons(hotList);
  }
  document.getElementById('ops-hot-empty')?.classList.toggle('hidden', Boolean(hot.length));
}

function renderArticleCard(a, kind) {
  const isCold = kind === 'cold';
  const borderCls = isCold ? 'border-l-red-400/60' : 'border-l-emerald-400/60';
  const avatar = proxyImage(a.avatar);
  const ana = a.analysis || {};
  const ratioChip = a.ratio != null
    ? `<span class="pill ${isCold ? 'pill-hot' : 'pill-green'} !text-[10px] !py-0">${a.ratio}x 均阅</span>` : '';
  const issuePill = ana.mainIssue && ana.mainIssue !== 'none'
    ? `<span class="pill pill-hot !text-[10px] !py-0">短板·${ISSUE_LABEL[ana.mainIssue] || '其他'}</span>` : '';
  const scoreChip = (label, val) => val != null
    ? `<span class="${val >= 4 ? 'text-emerald-300' : val >= 3 ? 'text-amber-300' : 'text-red-300'}">${label} ${val}/5</span>` : '';
  const scores = [scoreChip('选题', ana.topicScore), scoreChip('标题', ana.titleScore), scoreChip('内容', ana.contentScore)].filter(Boolean);
  const titleHtml = a.url
    ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="hover:text-amber-300 transition">${esc(a.title)}</a>`
    : esc(a.title);

  return `
    <div class="glass rounded-xl p-4 border-l-2 ${borderCls}">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="text-[13px] font-medium leading-snug line-clamp-2 min-w-0">${titleHtml}</div>
        <div class="flex items-center gap-1 flex-shrink-0">${ratioChip}${issuePill}</div>
      </div>
      <div class="flex items-center gap-1.5 mb-2.5 text-[10px] text-gray-500">
        <div class="account-avatar" style="width:16px;height:16px;font-size:9px;">
          ${(a.accountName || '?')[0]}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}
        </div>
        <span class="truncate">${esc(a.accountName)}</span>
        <span class="text-gray-700">·</span>
        <span>阅读 ${fmt(a.reads)}${a.baselineReads ? ` / 基线 ${fmt(a.baselineReads)}` : ''}</span>
        ${scores.length ? `<span class="text-gray-700">·</span><span class="flex gap-2">${scores.join('')}</span>` : ''}
      </div>
      ${ana.issueDetail ? `<div class="text-[11px] text-red-300/90 leading-relaxed mb-1.5">短板：${esc(ana.issueDetail)}</div>` : ''}
      ${ana.why ? `<div class="text-[11px] text-gray-400 leading-relaxed ${isCold ? 'mb-1.5' : ''}">${isCold ? '原因：' : '经验：'}${esc(ana.why)}</div>` : ''}
      ${isCold && (ana.suggestions || []).length ? `
        <ul class="mt-1.5 pt-1.5 border-t border-white/5 space-y-1">
          ${ana.suggestions.map(s => `<li class="text-[11px] text-gray-300 leading-relaxed flex gap-1.5"><span class="flex-shrink-0 text-amber-400">▸</span>${esc(s)}</li>`).join('')}
        </ul>` : ''}
      <div class="mt-2 pt-1.5 border-t border-white/5 text-[9px] text-gray-600">
        分析于 ${timeAgo(a.updatedAt)}${a.statsSyncedAt ? ` · 阅读数据为 ${new Date(a.statsSyncedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 快照` : ' · 阅读数据来自诊断快照'}
      </div>
    </div>`;
}

// ============ 快捷入口统计 ============

async function renderQuickStats(trackers) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  try {
    const kw = await localApi('hot/keywords').catch(() => ({}));
    set('ops-hot-count', `${kw?.data?.length || 0} 条热榜`);
  } catch {}
  set('ops-tracker-count', `${trackers.length} 个追踪`);
  const lib = LS.get('library', []);
  set('ops-lib-count', `${lib.length} 条收藏`);
}

// tracker 数据变化（同步/诊断）后由 app.js、tracker.js 回调刷新 dashboard
export async function renderFeedAndHistory() {
  if (document.getElementById('ops-account-rows')) await renderDashboard();
}

// 文章级表现分析：RedFox 数据 + LLM 逐篇诊断选题/标题/内容
export async function analyzeMyWorks(el, d) {
  const btn = el?.closest('button');
  const originalHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'pointer-events-none');
    btn.innerHTML = '<i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i><span>分析中…</span>';
    initIcons(btn);
  }
  toast('正在分析文章表现（约 1-2 分钟）…', 'info');
  try {
    const result = await localApi(`my-accounts/${encodeURIComponent(d.id)}/analyze-works`, { method: 'POST' });
    if (!result.analyzed) toast(result.message || '没有可分析的作品', 'info');
    else toast(`已分析 ${result.analyzed} 篇文章${result.observing ? `，${result.observing} 篇未满 48h 观察中` : ''}`, 'success');
    if (result.mpSync?.errcode === 40164) {
      toast('官方数据同步被拒：当前 IP 不在白名单，可一键自动配置', 'info');
      openMpWhitelistModal(result.mpSync.ip || '');
    }
    await renderDashboard();
  } catch (e) {
    toast(`分析失败：${e.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'pointer-events-none');
      btn.innerHTML = originalHtml;
      initIcons(btn);
    }
  }
}

// 从浏览器获取数据：调起 MP 插件，用用户已登录的公众号后台会话抓一次准实时数据
export async function fetchMpStats(el) {
  const btn = el?.closest('button');
  const originalHtml = btn?.innerHTML;
  const restore = () => {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('opacity-60', 'pointer-events-none');
    btn.innerHTML = originalHtml;
    initIcons(btn);
  };
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    toast('当前浏览器不支持插件调用，请用 Chrome 并安装 extension/mp-stats（见该目录 README）', 'error');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'pointer-events-none');
    btn.innerHTML = '<i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i><span>抓取中…</span>';
    initIcons(btn);
  }
  toast('正在通过浏览器插件抓取公众号后台数据（最长约 1 分钟）…', 'info');
  chrome.runtime.sendMessage(MP_EXT_ID, { type: 'mp-stats-sync-now' }, async (resp) => {
    restore();
    if (chrome.runtime.lastError) {
      toast('未检测到数据同步插件，请先安装 extension/mp-stats（见该目录 README）', 'error');
      return;
    }
    if (!resp?.ok) {
      toast(`抓取失败：${resp?.error || '未知错误'}`, 'error');
      return;
    }
    toast(resp.upserted ? `已从浏览器同步 ${resp.upserted} 篇（${resp.account}）` : '未解析到文章数据', resp.upserted ? 'success' : 'info');
    await renderDashboard();
  });
}

// ============ 公众号官方数据同步 + IP 白名单自动配置 ============

let mpwlPollTimer = null;

// 同步微信官方 T+1 阅读数据；40164（IP 不在白名单）时引导自动加白
export async function syncMpOfficial(el, d) {
  const btn = el?.closest('button');
  const originalHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'pointer-events-none');
    btn.innerHTML = '<i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i><span>同步中…</span>';
    initIcons(btn);
  }
  try {
    const data = await localApi(`my-accounts/${encodeURIComponent(d.id)}/sync-mp-official`, { method: 'POST' });
    if (data.errcode === 40164) {
      toast('官方接口被拒：当前出口 IP 不在公众平台白名单', 'error');
      openMpWhitelistModal(data.ip || '');
      return;
    }
    if (data.error) { toast(`同步失败：${data.error}`, 'error'); return; }
    toast(data.synced
      ? `已同步官方数据 ${data.synced} 条（${data.account}，T+1 口径）`
      : (data.reason || '无可同步数据'), data.synced ? 'success' : 'info');
    if (data.synced) await renderDashboard();
  } catch (e) {
    toast(`同步失败：${e.message}`, 'error');
    // 500 上抛的 40164（token 阶段被拒）也引导加白
    if (/40164|白名单|not in whitelist/i.test(e.message)) {
      const ipMatch = e.message.match(/invalid ip ([\d.]+)/);
      openMpWhitelistModal(ipMatch ? ipMatch[1] : '');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'pointer-events-none');
      btn.innerHTML = originalHtml;
      initIcons(btn);
    }
  }
}

// 白名单自动配置弹窗：说明 + 出口 IP + 启动按钮 + 轮询状态/二维码
export async function openMpWhitelistModal(ip = '') {
  let detectedIp = ip;
  if (!detectedIp) {
    try {
      const r = await localApi('mp-whitelist/outbound-ip');
      detectedIp = r?.ip || '';
    } catch { /* 探测失败留空，启动时后端再探 */ }
  }
  const modal = new Modal({
    title: '自动配置 IP 白名单',
    maxWidth: '560px',
    onClose: () => { if (mpwlPollTimer) { clearInterval(mpwlPollTimer); mpwlPollTimer = null; } },
    body: `
      <div class="space-y-3 text-[12px]">
        <div class="text-gray-400 leading-relaxed">
          将自动驱动本机 Chrome 打开公众平台控制台，把出口 IP
          <span class="text-cyan-300 font-mono">${esc(detectedIp || '（启动时自动探测）')}</span>
          <b>追加</b>进「设置与开发 → 基本配置 → IP 白名单」（保留已有条目）。
          过程需公众号管理员微信扫码 1~2 次，二维码会实时显示在下方。
        </div>
        <div id="mpwl-status" class="text-gray-500">未开始</div>
        <div id="mpwl-qr" class="hidden"></div>
        <div class="flex justify-end">
          <button class="btn btn-primary py-1.5 px-3 text-[12px] inline-flex items-center gap-1.5" data-action="startMpWhitelistJob" data-ip="${esc(detectedIp)}">
            <i data-lucide="wand-sparkles" class="w-3.5 h-3.5"></i><span>开始自动配置</span>
          </button>
        </div>
        <div class="text-[10px] text-gray-600 leading-relaxed border-t border-white/5 pt-2">
          说明：修改白名单是微信强制的管理员核验操作，扫码无法跳过；家宽 IP 变更后需重新配置一次。
        </div>
      </div>`,
  });
  modal.open();
}

// 启动加白任务并轮询状态（waiting_login/waiting_confirm 时展示页面截图供扫码）
export async function startMpWhitelistJob(el, d) {
  const btn = el?.closest('button');
  const statusEl = document.getElementById('mpwl-status');
  const qrEl = document.getElementById('mpwl-qr');
  const setStatus = (html) => { if (statusEl) { statusEl.innerHTML = html; initIcons(statusEl); } };
  if (btn) { btn.disabled = true; btn.classList.add('opacity-60', 'pointer-events-none'); }
  setStatus('<span class="text-gray-400 inline-flex items-center gap-1.5"><i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i>正在启动浏览器…</span>');
  try {
    const data = await localApi('mp-whitelist/auto', { method: 'POST', body: { ips: d.ip ? [d.ip] : [] } });
    const jobId = data.jobId;
    if (mpwlPollTimer) clearInterval(mpwlPollTimer);
    mpwlPollTimer = setInterval(async () => {
      let job;
      try {
        job = await localApi(`mp-whitelist/auto/${jobId}`);
      } catch { return; } // 单轮失败忽略，下轮继续
      if (job.status === 'done') {
        clearInterval(mpwlPollTimer); mpwlPollTimer = null;
        setStatus(`<span class="text-emerald-300">✓ ${esc(job.message || '白名单已更新')}</span>`);
        if (qrEl) qrEl.classList.add('hidden');
        toast('白名单配置完成，可重试「官方数据」同步', 'success');
      } else if (job.status === 'error') {
        clearInterval(mpwlPollTimer); mpwlPollTimer = null;
        setStatus(`<span class="text-red-400 leading-relaxed">${esc(job.message || '配置失败')}</span>`);
      } else {
        setStatus(`<span class="text-gray-400 inline-flex items-center gap-1.5"><i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i>${esc(job.message || job.status)}</span>`);
        if (job.qr && qrEl) {
          qrEl.innerHTML = `<img src="data:image/png;base64,${job.qr}" class="w-full rounded border border-white/10" alt="控制台页面实时截图" />
            <div class="text-[10px] text-gray-500 text-center mt-1">页面实时截图 · 手机微信扫码</div>`;
          qrEl.classList.remove('hidden');
        } else if (qrEl) {
          qrEl.classList.add('hidden');
        }
      }
    }, 2000);
  } catch (e) {
    setStatus(`<span class="text-red-400">${esc(e.message)}</span>`);
    if (btn) { btn.disabled = false; btn.classList.remove('opacity-60', 'pointer-events-none'); }
  }
}
