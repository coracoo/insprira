import { localApi } from '../api.js';
import { LS } from '../state.js';
import { esc, fmt, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { initIcons } from '../icons.js';

export async function renderDashboard() {
  const listEl = document.getElementById('ops-account-list');
  const emptyEl = document.getElementById('ops-account-empty');
  if (!listEl) return;

  listEl.innerHTML = '<div class="text-center text-gray-500 py-8 text-sm">加载中…</div>';

  try {
    const [accounts, trackers] = await Promise.all([
      localApi('my-accounts').catch(() => []),
      localApi('trackers').catch(() => []),
    ]);

    if (!accounts.length) {
      listEl.classList.add('hidden');
      emptyEl?.classList.remove('hidden');
      initIcons(emptyEl || document.getElementById('content-area'));
      renderQuickStats(trackers);
      renderSummaryStats([]);
      return;
    }

    listEl.classList.remove('hidden');
    emptyEl?.classList.add('hidden');

    const enriched = await Promise.all(accounts.map(async (acc) => {
      const trackerId = acc.trackerId || acc.id;
      const tracker = trackers.find(t => t.id === trackerId);
      let snapshots = [];
      try {
        const trendResp = await localApi(`trackers/${encodeURIComponent(trackerId)}/trend?limit=10`);
        snapshots = trendResp?.snapshots || trendResp || [];
        if (!Array.isArray(snapshots)) snapshots = [];
      } catch {}
      // 拉 WeRss 文章（公众号才有）
      let wersssArticles = [];
      if (acc.plat === 'gzh') {
        try {
          wersssArticles = await localApi(`wersss/articles?mpName=${encodeURIComponent(acc.name)}&limit=10`);
          if (!Array.isArray(wersssArticles)) wersssArticles = [];
        } catch {}
      }
      return { ...acc, tracker, snapshots, wersssArticles };
    }));

    listEl.innerHTML = enriched.map((acc, i) => renderAccountCard(acc, i)).join('');
    initIcons(listEl);

    // 绑定展开/折叠
    listEl.querySelectorAll('[data-expand-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = btn.dataset.expandToggle;
        const detail = listEl.querySelector(`[data-expand-detail="${idx}"]`);
        if (detail) {
          const isOpen = !detail.classList.contains('hidden');
          detail.classList.toggle('hidden');
          btn.querySelector('.expand-icon').style.transform = isOpen ? '' : 'rotate(180deg)';
        }
      });
    });

    renderSummaryStats(enriched);
    renderQuickStats(trackers);

  } catch (e) {
    listEl.innerHTML = `<div class="text-red-400 text-sm py-4 text-center">${esc(e.message)}</div>`;
  }
}

function getLatestSnapshot(acc) {
  const snaps = (acc.snapshots || []).sort((a, b) =>
    new Date(b.captured_at || b.snapshot_date) - new Date(a.captured_at || a.snapshot_date)
  );
  return { latest: snaps[0], prev: snaps[1], all: snaps, count: snaps.length };
}

function renderAccountCard(acc, idx) {
  const { latest, prev, all, count } = getLatestSnapshot(acc);
  const score = latest?.score;
  const prevScore = prev?.score;
  const trend = (score != null && prevScore != null) ? score - prevScore : null;

  // 解析诊断明细
  let diag = null;
  try { diag = latest?.report || (latest?.raw_data ? JSON.parse(latest.raw_data) : null); } catch {}

  const avatar = proxyImage(acc.avatar);
  const initial = (acc.name || '?')[0];
  const platCls = acc.plat === 'dy' ? 'pill-hot' : acc.plat === 'xhs' ? 'pill-brand' : 'pill-green';
  const lastDate = latest?.snapshot_date || latest?.captured_at;
  const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : null;

  // 状态 badge
  let alertBadge = '';
  if (!latest) {
    alertBadge = '<span class="pill pill-gray !text-[10px]">未诊断</span>';
  } else if (daysSince > 7) {
    alertBadge = `<span class="pill pill-amber !text-[10px]">${daysSince}天未更新</span>`;
  } else if (score != null && score < 60) {
    alertBadge = `<span class="pill pill-hot !text-[10px]">需优化</span>`;
  } else {
    alertBadge = '<span class="pill pill-green !text-[10px]">健康</span>';
  }

  const scoreDisplay = score != null ? score.toFixed(1) : '—';
  const scoreColor = score != null && score < 60 ? 'text-red-300'
    : score != null && score >= 80 ? 'text-emerald-300' : 'text-gray-200';
  const trendDisplay = trend != null
    ? (trend > 0 ? `<span class="text-emerald-400 text-xs">▲${trend.toFixed(1)}</span>`
       : trend < 0 ? `<span class="text-red-400 text-xs">▼${Math.abs(trend).toFixed(1)}</span>`
       : `<span class="text-gray-500 text-xs">—</span>`)
    : '';

  // 维度评分条
  const dimensions = diag?.dimensions || [];
  const dimBars = dimensions.map(d => {
    const pct = d.max ? (d.score / d.max * 100).toFixed(0) : 0;
    const tone = pct >= 75 ? 'bg-emerald-400' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400';
    return `
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-gray-400 w-24 flex-shrink-0">${esc(d.name)}</span>
        <div class="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div class="h-full rounded-full ${tone}" style="width:${pct}%"></div>
        </div>
        <span class="text-[11px] font-mono w-12 text-right ${pct >= 75 ? 'text-emerald-300' : pct >= 60 ? 'text-amber-300' : 'text-red-300'}">${d.score}/${d.max}</span>
      </div>`;
  }).join('');

  // 行业对标
  const benchmark = diag?.scores?.['行业对标'];
  const benchmarkRows = benchmark ? Object.entries(benchmark).slice(0, 4).map(([metric, data]) => {
    if (!data || typeof data !== 'object') return '';
    return `
      <div class="flex items-center justify-between py-1 border-b border-white/[0.03] last:border-0">
        <span class="text-[11px] text-gray-400">${esc(metric)}</span>
        <div class="flex items-center gap-3 text-[11px]">
          <span class="text-gray-300 font-medium">${esc(data['本账号'] || '—')}</span>
          <span class="text-gray-600">行业 ${esc(data['行业均值'] || '—')}</span>
          <span class="text-gray-600">头部 ${esc(data['头部账号'] || '—')}</span>
        </div>
      </div>`;
  }).join('') : '';

  // 优势/待优化
  const strengths = (diag?.scores?.['优势模块'] || []).map(s =>
    `<span class="pill pill-green !text-[10px] !py-0.5">${esc(s['维度名'])} ${s['得分率']}%</span>`
  ).join('');
  const weaknesses = (diag?.scores?.['待优化模块'] || []).map(s =>
    `<span class="pill pill-amber !text-[10px] !py-0.5">${esc(s['维度名'])} ${s['得分率']}%</span>`
  ).join('');

  // 相似竞品
  const competitors = (diag?.similar_accounts || []).slice(0, 5).map(c =>
    `<span class="pill pill-gray !text-[10px] !py-0.5">${esc(c['账号名称'] || c.name || '?')}</span>`
  ).join('');

  // 赛道标签
  const trackBadges = (acc.tracks || []).slice(0, 3).map(t =>
    `<span class="pill pill-gray !text-[10px] !py-0 !px-1.5">${esc(t)}</span>`
  ).join('');

  // sparkline
  const scoreHist = all.slice(0, 8).reverse().map(s => s.score).filter(v => v != null);
  const sparkline = scoreHist.length >= 2 ? renderSparkline(scoreHist) : '';

  // 作品阅读量分析
  const worksBlock = renderWorksAnalysis(diag?.works, acc.wersssArticles);

  // AI 分析（如果有）
  let analysisBlock = '';
  try {
    const analysis = latest?.analysis && typeof latest.analysis === 'object' ? latest.analysis
      : latest?.analysis ? JSON.parse(latest.analysis) : null;
    if (analysis && analysis.summary && !analysis.summary.includes('失败') && !analysis.summary.includes('降级')) {
      const actions = (analysis.actions || []).slice(0, 3).map(a => `<li class="text-[11px] text-gray-400">${esc(a)}</li>`).join('');
      const risks = (analysis.risks || []).slice(0, 2).map(r => `<li class="text-[11px] text-amber-300/80">${esc(r)}</li>`).join('');
      if (actions || risks) {
        analysisBlock = `
          <div class="mt-3 p-3 bg-white/[0.02] rounded-lg space-y-1.5">
            ${risks ? `<div><span class="text-[10px] uppercase text-amber-400/70 tracking-wider">风险</span><ul class="mt-1 space-y-0.5">${risks}</ul></div>` : ''}
            ${actions ? `<div><span class="text-[10px] uppercase text-cyan-400/70 tracking-wider">建议</span><ul class="mt-1 space-y-0.5">${actions}</ul></div>` : ''}
          </div>`;
      }
    }
  } catch {}

  const hasDetail = Boolean(dimBars || benchmarkRows || strengths || weaknesses || competitors || worksBlock);

  return `
    <div class="glass rounded-xl p-4 hover:bg-white/[0.02] transition">
      <!-- 摘要行（点击可跳转追踪页） -->
      <div class="flex items-start gap-3 cursor-pointer" data-action="gotoPage" data-page="tracker">
        <div class="account-avatar flex-shrink-0" style="width:40px;height:40px;font-size:15px;">
          ${initial}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-semibold text-sm truncate">${esc(acc.name)}</span>
            <span class="pill ${platCls} !text-[10px] !py-0 flex-shrink-0">${esc(platName(acc.plat))}</span>
            ${alertBadge}
            ${acc.styleProfile ? '<span class="pill pill-cyan !text-[10px] !py-0 flex-shrink-0">风格</span>' : ''}
          </div>
          ${trackBadges ? `<div class="flex flex-wrap gap-1 mb-1">${trackBadges}</div>` : ''}
          <div class="text-[10px] text-gray-600">
            ${count ? `${count} 次诊断` : '无诊断'}${lastDate ? ` · ${new Date(lastDate).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'})}` : ''}${diag?.header?.['平均阅读数'] ? ` · 均读 ${fmt(diag.header['平均阅读数'])}` : ''}
          </div>
        </div>
        <div class="flex-shrink-0 text-right flex items-end gap-2">
          ${sparkline}
          <div>
            <div class="flex items-baseline gap-1 justify-end">
              <span class="text-2xl font-bold ${scoreColor}">${scoreDisplay}</span>
              <span class="text-[10px] text-gray-600">分</span>
            </div>
            <div class="text-right">${trendDisplay}</div>
          </div>
        </div>
      </div>

      ${hasDetail ? `
      <!-- 展开/折叠按钮 -->
      <button class="w-full mt-2 flex items-center justify-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 py-1" data-expand-toggle="${idx}">
        <span>诊断明细</span>
        <i data-lucide="chevron-down" class="w-3 h-3 expand-icon transition-transform" style="transform:rotate(180deg)"></i>
      </button>

      <!-- 诊断明细（默认展开） -->
      <div class="mt-2 pt-3 border-t border-white/5 space-y-4" data-expand-detail="${idx}">

        <!-- 维度评分 -->
        ${dimBars ? `<div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">维度评分</div>
          <div class="space-y-1.5">${dimBars}</div>
        </div>` : ''}

        <!-- 优势 / 待优化 -->
        ${strengths || weaknesses ? `<div class="grid grid-cols-2 gap-3">
          ${strengths ? `<div><div class="text-[10px] uppercase tracking-wider text-emerald-400/70 mb-1.5">优势</div><div class="flex flex-wrap gap-1">${strengths}</div></div>` : '<div></div>'}
          ${weaknesses ? `<div><div class="text-[10px] uppercase tracking-wider text-amber-400/70 mb-1.5">待优化</div><div class="flex flex-wrap gap-1">${weaknesses}</div></div>` : ''}
        </div>` : ''}

        <!-- 行业对标 -->
        ${benchmarkRows ? `<div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">行业对标</div>
          ${benchmarkRows}
        </div>` : ''}

        <!-- 相似竞品 -->
        ${competitors ? `<div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">相似竞品</div>
          <div class="flex flex-wrap gap-1">${competitors}</div>
        </div>` : ''}

        ${worksBlock}

        ${analysisBlock}

      </div>` : ''}
    </div>
  `;
}

function renderWorksAnalysis(works, wersssArticles) {
  // 合并诊断作品 + WeRss 文章
  const parsed = [];
  if (Array.isArray(works)) {
    for (const w of works) {
      const rawTitle = String(w['标题'] || w.title || '');
      const title = (rawTitle.match(/^\[([^\]]+)\]\(/)?.[1] || rawTitle.replace(/\]\(https?:\/\/[^\)]*\)$/, '').replace(/^\[/, '')).trim();
      parsed.push({
        title: title.slice(0, 50),
        reads: Number(w['阅读数'] || w.reads || 0),
        likes: Number(w['点赞数'] || w.likes || 0),
        comments: Number(w['评论数'] || w.comments || 0),
        watch: Number(w['在看数'] || w.watch || 0),
        date: w['发布时间'] || w.date || '',
        source: '诊断',
        url: String(w['标题'] || '').match(/\((https?:\/\/[^\)]+)\)/)?.[1] || '',
      });
    }
  }
  // WeRss 文章补充（只有标题和日期，没有阅读量，但能展示最近更新）
  if (Array.isArray(wersssArticles)) {
    const existingTitles = new Set(parsed.map(p => p.title.slice(0, 10)));
    for (const a of wersssArticles) {
      const title = String(a.title || '').trim();
      if (!title || existingTitles.has(title.slice(0, 10))) continue;
      parsed.push({
        title: title.slice(0, 50),
        reads: 0,
        likes: 0,
        comments: 0,
        watch: 0,
        date: a.publishTime ? new Date(Number(a.publishTime)).toISOString() : '',
        source: 'WeRss',
        url: a.url || '',
      });
    }
  }

  if (!parsed.length) return '';

  // 按时间排序（新→旧）
  parsed.sort((a, b) => new Date(b.date) - new Date(a.date));

  const withReads = parsed.filter(w => w.reads > 0);
  const maxRead = withReads.length ? Math.max(...withReads.map(w => w.reads)) : 0;
  const avgRead = withReads.length ? Math.round(withReads.reduce((s, w) => s + w.reads, 0) / withReads.length) : 0;
  const totalLikes = parsed.reduce((s, w) => s + w.likes, 0);
  const totalComments = parsed.reduce((s, w) => s + w.comments, 0);
  const totalReads = parsed.reduce((s, w) => s + w.reads, 0);
  const engagementRate = totalReads ? ((totalLikes + totalComments) / totalReads * 100).toFixed(1) : '—';

  // 找爆款和冷门（仅诊断数据有阅读量）
  let best = null, worst = null;
  if (withReads.length >= 2) {
    best = withReads.reduce((a, b) => a.reads > b.reads ? a : b);
    worst = withReads.reduce((a, b) => a.reads < b.reads ? a : b);
  }

  const rows = parsed.slice(0, 10).map(w => {
    const dateStr = w.date ? new Date(w.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
    const hasData = w.reads > 0;
    const pct = hasData && maxRead ? (w.reads / maxRead * 100).toFixed(0) : 0;
    const isBest = best && w.title === best.title;
    const isWorst = worst && w.title === worst.title && best !== worst;
    const tone = isBest ? 'bg-emerald-400' : isWorst ? 'bg-red-400/50' : 'bg-amber-400/50';
    const sourceTag = w.source === 'WeRss'
      ? '<span class="text-[9px] text-cyan-500 ml-1">RSS</span>'
      : '';
    const linkOpen = w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener" class="hover:text-amber-300 block">` : '<div>';
    const linkClose = w.url ? '</a>' : '</div>';

    return `
      <div class="flex items-start gap-2 py-1.5 border-b border-white/[0.03] last:border-0">
        <span class="text-[10px] text-gray-600 w-8 flex-shrink-0 text-right pt-0.5">${dateStr}</span>
        <div class="flex-1 min-w-0">
          ${linkOpen}
          <div class="text-[11px] text-gray-300 truncate">${esc(w.title)}${sourceTag}</div>
          ${linkClose}
          ${hasData ? `
          <div class="flex items-center gap-2 mt-0.5">
            <div class="flex-1 h-2 rounded bg-white/[0.04] overflow-hidden">
              <div class="h-full rounded ${tone}" style="width:${Math.max(pct, 5)}%"></div>
            </div>
          </div>` : ''}
        </div>
        ${hasData ? `
        <div class="flex-shrink-0 flex items-center gap-2 text-[10px] pt-0.5">
          <span class="text-gray-300 font-medium" title="阅读">${fmt(w.reads)}</span>
          <span class="text-gray-600" title="点赞">👍${fmt(w.likes)}</span>
          <span class="text-gray-600" title="评论">💬${fmt(w.comments)}</span>
          ${w.watch ? `<span class="text-gray-600" title="在看">👀${fmt(w.watch)}</span>` : ''}
        </div>` : `<span class="text-[10px] text-gray-700 flex-shrink-0 pt-0.5">无数据</span>`}
      </div>`;
  }).join('');

  return `
    <div>
      <div class="flex items-center justify-between mb-2">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">近期作品</div>
        <div class="flex items-center gap-3 text-[10px] text-gray-500">
          ${avgRead ? `<span>均阅 <span class="text-gray-300 font-medium">${fmt(avgRead)}</span></span>` : ''}
          <span>互动率 <span class="text-gray-300 font-medium">${engagementRate}%</span></span>
          <span>${parsed.length} 篇</span>
        </div>
      </div>
      <div>${rows}</div>
      ${best && worst ? `
      <div class="flex items-center gap-4 mt-2 text-[10px]">
        <span class="text-emerald-400/80">▲ 爆款 ${esc(best.title.slice(0,16))}… ${fmt(best.reads)}</span>
        <span class="text-red-400/50">▼ 冷门 ${esc(worst.title.slice(0,16))}… ${fmt(worst.reads)}</span>
      </div>` : ''}
    </div>`;
}

function renderSparkline(values) {
  const w = 48, h = 20, pad = 2;
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
  const color = isUp ? '#34d399' : '#f87171';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" />
  </svg>`;
}

function renderSummaryStats(accounts) {
  let totalScore = 0, scoreCount = 0, needAttention = 0, totalDiag = 0;
  for (const acc of accounts) {
    const snaps = acc.snapshots || [];
    totalDiag += snaps.length;
    if (snaps.length) {
      const s = getLatestSnapshot(acc).latest;
      if (s?.score != null) {
        totalScore += s.score;
        scoreCount++;
        if (s.score < 65) needAttention++;
      }
    }
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const labels = { 'ops-stat-analyze': '待诊断', 'ops-stat-issues': '需关注', 'ops-stat-topics': '平均分', 'ops-stat-creating': '总诊断', 'ops-stat-verify': '有风格' };
  for (const [id, label] of Object.entries(labels)) {
    const el = document.getElementById(id);
    if (el) {
      const labelEl = el.previousElementSibling;
      if (labelEl) labelEl.textContent = label;
    }
  }
  set('ops-stat-analyze', accounts.length - scoreCount);
  set('ops-stat-issues', needAttention);
  set('ops-stat-topics', scoreCount ? (totalScore / scoreCount).toFixed(0) : '—');
  set('ops-stat-creating', totalDiag);
  set('ops-stat-verify', accounts.filter(a => a.styleProfile).length);
}

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

export async function renderFeedAndHistory() {}
