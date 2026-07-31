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

    // 并发拉每个账号的快照历史
    const enriched = await Promise.all(accounts.map(async (acc) => {
      const trackerId = acc.trackerId || acc.id;
      const tracker = trackers.find(t => t.id === trackerId);
      let snapshots = [];
      try {
        snapshots = await localApi(`trackers/${encodeURIComponent(trackerId)}/snapshots`);
        if (!Array.isArray(snapshots)) snapshots = [];
      } catch {}
      return { ...acc, tracker, snapshots };
    }));

    listEl.innerHTML = enriched.map(renderAccountCard).join('');
    initIcons(listEl);

    renderSummaryStats(enriched);
    renderQuickStats(trackers);

  } catch (e) {
    listEl.innerHTML = `<div class="text-red-400 text-sm py-4 text-center">${esc(e.message)}</div>`;
  }
}

function renderAccountCard(acc) {
  const snaps = (acc.snapshots || []).sort((a, b) =>
    new Date(b.captured_at || b.snapshot_date) - new Date(a.captured_at || a.snapshot_date)
  );
  const latest = snaps[0];
  const prev = snaps[1];
  const score = latest?.score;
  const prevScore = prev?.score;
  const trend = (score != null && prevScore != null) ? score - prevScore : null;
  const scoreHist = snaps.slice(0, 6).reverse().map(s => s.score).filter(v => v != null);

  const avatar = proxyImage(acc.avatar);
  const initial = (acc.name || '?')[0];
  const platCls = acc.plat === 'dy' ? 'pill-hot' : acc.plat === 'xhs' ? 'pill-brand' : 'pill-green';
  const trackerId = acc.trackerId || acc.id;
  const lastDate = latest?.snapshot_date || latest?.captured_at;
  const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : null;

  // 状态判断
  let alert = null;
  if (!latest) {
    alert = { icon: 'circle-alert', text: '尚未诊断', tone: 'gray' };
  } else if (daysSince > 7) {
    alert = { icon: 'clock', text: `${daysSince} 天未更新`, tone: 'amber' };
  } else if (score != null && score < 60) {
    alert = { icon: 'trending-down', text: `评分偏低（${score.toFixed(0)}）`, tone: 'red' };
  } else if (trend != null && trend < -3) {
    alert = { icon: 'trending-down', text: `较上次降 ${Math.abs(trend).toFixed(1)} 分`, tone: 'red' };
  } else if (trend != null && trend > 3) {
    alert = { icon: 'trending-up', text: `较上次升 ${trend.toFixed(1)} 分`, tone: 'green' };
  }

  const alertCls = {
    gray: 'text-gray-400', amber: 'text-amber-300',
    red: 'text-red-400', green: 'text-emerald-400',
  }[alert?.tone || 'gray'];

  // 分数展示
  const scoreDisplay = score != null ? score.toFixed(1) : '—';
  const trendDisplay = trend != null
    ? (trend > 0 ? `<span class="text-emerald-400 text-xs">+${trend.toFixed(1)}</span>`
       : trend < 0 ? `<span class="text-red-400 text-xs">${trend.toFixed(1)}</span>`
       : `<span class="text-gray-500 text-xs">持平</span>`)
    : '';

  // sparkline（mini 折线）
  const sparkline = scoreHist.length >= 2 ? renderSparkline(scoreHist) : '';

  // 赛道标签
  const trackBadges = (acc.tracks || []).slice(0, 3).map(t =>
    `<span class="pill pill-gray !text-[10px] !py-0 !px-1.5">${esc(t)}</span>`
  ).join('');

  return `
    <div class="glass rounded-xl p-4 hover:bg-white/[0.02] transition cursor-pointer" data-action="gotoPage" data-page="tracker">
      <div class="flex items-start gap-3">
        <!-- 头像 -->
        <div class="account-avatar flex-shrink-0" style="width:40px;height:40px;font-size:15px;">
          ${initial}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}
        </div>

        <!-- 中间：名称 + 信息 -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="font-semibold text-sm truncate">${esc(acc.name)}</span>
            <span class="pill ${platCls} !text-[10px] !py-0 flex-shrink-0">${esc(platName(acc.plat))}</span>
            ${acc.styleProfile ? '<span class="pill pill-cyan !text-[10px] !py-0 flex-shrink-0" title="已提炼风格档案">风格</span>' : ''}
          </div>
          ${trackBadges ? `<div class="flex flex-wrap gap-1 mb-1">${trackBadges}</div>` : ''}
          ${alert ? `<div class="flex items-center gap-1 text-[11px] ${alertCls}">
            <i data-lucide="${alert.icon}" class="w-3 h-3"></i>${esc(alert.text)}
          </div>` : ''}
          <div class="text-[10px] text-gray-600 mt-0.5">
            ${snaps.length ? `${snaps.length} 次诊断` : '无诊断记录'}
            ${lastDate ? ` · 最后 ${new Date(lastDate).toLocaleDateString('zh-CN', {month:'numeric',day:'numeric'})}` : ''}
          </div>
        </div>

        <!-- 右侧：分数 + 趋势 -->
        <div class="flex-shrink-0 text-right">
          <div class="flex items-baseline gap-1 justify-end">
            <span class="text-2xl font-bold ${score != null && score < 60 ? 'text-red-300' : score != null && score >= 80 ? 'text-emerald-300' : 'text-gray-200'}">${scoreDisplay}</span>
            <span class="text-[10px] text-gray-600">分</span>
          </div>
          ${trendDisplay}
          ${sparkline}
        </div>
      </div>
    </div>
  `;
}

function renderSparkline(values) {
  const w = 56, h = 20, pad = 2;
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
  return `<svg width="${w}" height="${h}" class="mt-1 ml-auto block" viewBox="0 0 ${w} ${h}">
    <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

function renderSummaryStats(accounts) {
  let totalScore = 0, scoreCount = 0, needAttention = 0, totalDiag = 0;
  for (const acc of accounts) {
    const snaps = acc.snapshots || [];
    totalDiag += snaps.length;
    if (snaps.length) {
      const latest = snaps.sort((a, b) =>
        new Date(b.captured_at || b.snapshot_date) - new Date(a.captured_at || a.snapshot_date)
      )[0];
      if (latest?.score != null) {
        totalScore += latest.score;
        scoreCount++;
        if (latest.score < 65) needAttention++;
      }
    }
  }
  const avgScore = scoreCount ? (totalScore / scoreCount).toFixed(0) : '—';
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ops-stat-analyze', accounts.length - scoreCount);
  set('ops-stat-issues', needAttention);
  set('ops-stat-topics', avgScore);
  set('ops-stat-creating', totalDiag);
  set('ops-stat-verify', accounts.filter(a => a.styleProfile).length);

  // 更新统计标签
  const labels = {
    'ops-stat-analyze': '待诊断',
    'ops-stat-issues': '需关注',
    'ops-stat-topics': '平均分',
    'ops-stat-creating': '总诊断',
    'ops-stat-verify': '有风格',
  };
  for (const [id, label] of Object.entries(labels)) {
    const el = document.getElementById(id)?.previousElementSibling;
    if (el) el.textContent = label;
  }
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
