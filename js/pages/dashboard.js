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

  let diag = null;
  try { diag = latest?.report || (latest?.raw_data ? JSON.parse(latest.raw_data) : null); } catch {}

  const avatar = proxyImage(acc.avatar);
  const initial = (acc.name || '?')[0];
  const platCls = acc.plat === 'dy' ? 'pill-hot' : acc.plat === 'xhs' ? 'pill-brand' : 'pill-green';
  const lastDate = latest?.snapshot_date || latest?.captured_at;
  const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : null;

  let alertBadge = '';
  if (!latest) alertBadge = '<span class="pill pill-gray !text-[10px]">未诊断</span>';
  else if (daysSince > 7) alertBadge = `<span class="pill pill-amber !text-[10px]">${daysSince}天未更新</span>`;
  else if (score != null && score < 60) alertBadge = '<span class="pill pill-hot !text-[10px]">需优化</span>';
  else alertBadge = '<span class="pill pill-green !text-[10px]">健康</span>';

  const scoreDisplay = score != null ? score.toFixed(1) : '—';
  const scoreColor = score != null && score < 60 ? 'text-red-300'
    : score != null && score >= 80 ? 'text-emerald-300' : 'text-gray-200';
  const trendDisplay = trend != null
    ? (trend > 0 ? `<span class="text-emerald-400 text-xs">▲${trend.toFixed(1)}</span>`
       : trend < 0 ? `<span class="text-red-400 text-xs">▼${Math.abs(trend).toFixed(1)}</span>`
       : `<span class="text-gray-500 text-xs">—</span>`)
    : '';

  const dimensions = diag?.dimensions || [];
  const dimBars = dimensions.map(d => {
    const pct = d.max ? (d.score / d.max * 100).toFixed(0) : 0;
    const tone = pct >= 75 ? 'bg-emerald-400' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400';
    return `
      <div class="flex items-center gap-2">
        <span class="text-[11px] text-gray-400 w-24 flex-shrink-0">${esc(d.name)}</span>
        <div class="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
          <div class="h-full rounded-full ${tone}" style="width:${pct}%"></div>
        </div>
        <span class="text-[11px] font-mono w-12 text-right ${pct >= 75 ? 'text-emerald-300' : pct >= 60 ? 'text-amber-300' : 'text-red-300'}">${d.score}/${d.max}</span>
      </div>`;
  }).join('');

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

  const strengths = (diag?.scores?.['优势模块'] || []).map(s =>
    `<span class="pill pill-green !text-[10px] !py-0.5">${esc(s['维度名'])} ${s['得分率']}%</span>`
  ).join('');
  const weaknesses = (diag?.scores?.['待优化模块'] || []).map(s =>
    `<span class="pill pill-amber !text-[10px] !py-0.5">${esc(s['维度名'])} ${s['得分率']}%</span>`
  ).join('');

  const competitors = (diag?.similar_accounts || []).slice(0, 5).map(c =>
    `<span class="pill pill-gray !text-[10px] !py-0.5">${esc(c['账号名称'] || c.name || '?')}</span>`
  ).join('');

  const trackBadges = (acc.tracks || []).slice(0, 3).map(t =>
    `<span class="pill pill-gray !text-[10px] !py-0 !px-1.5">${esc(t)}</span>`
  ).join('');

  const scoreHist = all.slice(0, 8).reverse().map(s => s.score).filter(v => v != null);
  const sparkline = scoreHist.length >= 2 ? renderSparkline(scoreHist) : '';

  // 阅读量趋势图 + 作品卡片
  const hasRedfoxWorks = Array.isArray(diag?.works) && diag.works.length > 0;
  const worksBlock = renderWorksSection(diag?.works, hasRedfoxWorks ? null : acc.wersssArticles);

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
            ${count ? `${count} 次诊断` : '无诊断'}${lastDate ? ` · ${new Date(lastDate).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'})}` : ''}${diag?.header?.['平均阅读数'] ? ` · 均阅 ${fmt(diag.header['平均阅读数'])}` : ''}
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
      <button class="w-full mt-2 flex items-center justify-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 py-1" data-expand-toggle="${idx}">
        <span>诊断明细</span>
        <i data-lucide="chevron-down" class="w-3 h-3 expand-icon transition-transform" style="transform:rotate(180deg)"></i>
      </button>

      <div class="mt-2 pt-3 border-t border-white/5 space-y-4" data-expand-detail="${idx}">

        ${worksBlock}

        ${dimBars ? `<div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-2">维度评分</div>
          <div class="space-y-1.5">${dimBars}</div>
        </div>` : ''}

        ${strengths || weaknesses ? `<div class="grid grid-cols-2 gap-3">
          ${strengths ? `<div><div class="text-[10px] uppercase tracking-wider text-emerald-400/70 mb-1.5">优势</div><div class="flex flex-wrap gap-1">${strengths}</div></div>` : '<div></div>'}
          ${weaknesses ? `<div><div class="text-[10px] uppercase tracking-wider text-amber-400/70 mb-1.5">待优化</div><div class="flex flex-wrap gap-1">${weaknesses}</div></div>` : ''}
        </div>` : ''}

        ${benchmarkRows ? `<div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">行业对标</div>
          ${benchmarkRows}
        </div>` : ''}

        ${competitors ? `<div>
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">相似竞品</div>
          <div class="flex flex-wrap gap-1">${competitors}</div>
        </div>` : ''}

        ${analysisBlock}

      </div>` : ''}
    </div>
  `;
}

// ============ 作品阅读量：趋势图 + 卡片列表 ============

function renderWorksSection(works, wersssArticles) {
  // 合并诊断作品 + WeRss
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
        url: rawTitle.match(/\((https?:\/\/[^\)]+)\)/)?.[1] || '',
        source: '诊断',
      });
    }
  }
  if (!parsed.length && Array.isArray(wersssArticles)) {
    for (const a of wersssArticles) {
      parsed.push({
        title: String(a.title || '').trim().slice(0, 50),
        reads: 0, likes: 0, comments: 0, watch: 0,
        date: a.publishTime ? new Date(Number(a.publishTime)).toISOString() : '',
        url: a.url || '', source: 'WeRss',
      });
    }
  }
  if (!parsed.length) return '';

  // 按日期排序（旧→新，用于趋势图）
  const sorted = [...parsed].sort((a, b) => new Date(a.date) - new Date(b.date));
  const withReads = sorted.filter(w => w.reads > 0);

  // 统计
  const maxRead = withReads.length ? Math.max(...withReads.map(w => w.reads)) : 0;
  const avgRead = withReads.length ? Math.round(withReads.reduce((s, w) => s + w.reads, 0) / withReads.length) : 0;
  const totalReads = sorted.reduce((s, w) => s + w.reads, 0);
  const totalLikes = sorted.reduce((s, w) => s + w.likes, 0);
  const totalComments = sorted.reduce((s, w) => s + w.comments, 0);
  const engagementRate = totalReads ? ((totalLikes + totalComments) / totalReads * 100).toFixed(1) : '—';

  // 分类：爆款/冷门/常规
  let best = null, worst = null;
  if (withReads.length >= 2) {
    best = withReads.reduce((a, b) => a.reads > b.reads ? a : b);
    worst = withReads.reduce((a, b) => a.reads < b.reads ? a : b);
  }

  // 趋势图（面积折线）
  const trendChart = withReads.length >= 2 ? renderReadsChart(withReads) : '';

  // 作品卡片列表（新→旧）
  const cardList = [...parsed].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10).map(w => {
    const dateStr = w.date ? new Date(w.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
    const hasData = w.reads > 0;
    // 分类
    let tier, tierLabel, tierColor, barColor;
    if (!hasData) {
      tier = 'none'; tierLabel = '无数据'; tierColor = 'text-gray-600'; barColor = 'bg-gray-600';
    } else if (best && w.title === best.title) {
      tier = 'hot'; tierLabel = '爆款'; tierColor = 'text-emerald-300'; barColor = 'bg-emerald-400';
    } else if (worst && w.title === worst.title && best !== worst) {
      tier = 'cold'; tierLabel = '冷门'; tierColor = 'text-red-300'; barColor = 'bg-red-400';
    } else {
      tier = 'normal'; tierLabel = '常规'; tierColor = 'text-amber-300'; barColor = 'bg-amber-400';
    }
    const barPct = hasData && maxRead ? Math.max((w.reads / maxRead * 100), 8).toFixed(0) : 0;
    const sourceTag = w.source === 'WeRss' ? '<span class="text-[9px] text-cyan-500">RSS</span>' : '';
    const link = w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener" class="hover:text-amber-300">` : '<div>';
    const linkEnd = w.url ? '</a>' : '</div>';

    return `
      <div class="bg-white/[0.02] rounded-lg p-2.5 border-l-2 ${tier === 'hot' ? 'border-emerald-400' : tier === 'cold' ? 'border-red-400' : tier === 'normal' ? 'border-amber-400' : 'border-gray-700'}">
        ${link}<div class="text-[10px] text-gray-200 font-medium leading-tight line-clamp-2 mb-1">${esc(w.title)}</div>${linkEnd}
        ${hasData ? `
        <div class="h-1 rounded-full bg-white/[0.06] overflow-hidden mb-1.5">
          <div class="h-full rounded-full ${barColor}" style="width:${barPct}%"></div>
        </div>
        <div class="flex items-center justify-between text-[9px]">
          <span class="${tierColor} font-bold">📖 ${fmt(w.reads)}</span>
          <span class="text-gray-500">👍${fmt(w.likes)} 💬${fmt(w.comments)}</span>
        </div>` : '<div class="text-[9px] text-gray-700">无数据</div>'}
      </div>`;
  }).join('');

  return `
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">作品阅读量</div>
        <div class="flex items-center gap-3 text-[10px] text-gray-500">
          ${avgRead ? `<span>均阅 <span class="text-gray-300 font-medium">${fmt(avgRead)}</span></span>` : ''}
          <span>互动率 <span class="text-gray-300 font-medium">${engagementRate}%</span></span>
          <span>${parsed.length} 篇</span>
        </div>
      </div>

      ${trendChart}

      <div class="flex items-center gap-3 mb-2 text-[10px]">
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-400"></span>爆款</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-400"></span>常规</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-red-400"></span>冷门</span>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">
        ${cardList}
      </div>

      ${best && worst ? `
      <div class="flex items-center gap-4 mt-2 text-[10px]">
        <span class="text-emerald-400/80">▲ 爆款 ${esc(best.title.slice(0,16))}… ${fmt(best.reads)}</span>
        <span class="text-red-400/60">▼ 冷门 ${esc(worst.title.slice(0,16))}… ${fmt(worst.reads)}</span>
      </div>` : ''}
    </div>`;
}

function renderReadsChart(works) {
  const w = 100; // percentage width
  const h = 60;
  const pad = { l: 4, r: 4, t: 6, b: 14 };
  const reads = works.map(x => x.reads);
  const max = Math.max(...reads);
  const min = Math.min(...reads);
  const range = max - min || max || 1;
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const step = cw / (works.length - 1);

  const points = works.map((x, i) => {
    const px = pad.l + i * step;
    const py = pad.t + ch - ((x.reads - min) / range) * ch;
    return { x: px, y: py, read: x.reads, date: x.date };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = linePath + ` L ${points[points.length - 1].x.toFixed(1)} ${pad.t + ch} L ${points[0].x.toFixed(1)} ${pad.t + ch} Z`;
  const labels = points.map((p, i) => {
    const d = p.date ? new Date(p.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
    const readLabel = `<text x="${p.x.toFixed(1)}" y="${(p.y - 3).toFixed(1)}" fill="#94a3b8" font-size="5" text-anchor="middle">${fmt(p.read)}</text>`;
    const dateLabel = `<text x="${p.x.toFixed(1)}" y="${(h - 3).toFixed(1)}" fill="#475569" font-size="4.5" text-anchor="middle">${d}</text>`;
    return readLabel + dateLabel;
  }).join('');
  const dots = points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.2" fill="#fbbf24" />`).join('');

  return `
    <div class="mb-3">
      <svg viewBox="0 0 ${w} ${h}" class="w-full" style="height:80px" preserveAspectRatio="none">
        <defs>
          <linearGradient id="readsGrad${Math.random().toString(36).slice(2,6)}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.25" />
            <stop offset="100%" stop-color="#fbbf24" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#readsGrad)" />
        <path d="${linePath}" fill="none" stroke="#fbbf24" stroke-width="0.6" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
        ${labels}
      </svg>
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
