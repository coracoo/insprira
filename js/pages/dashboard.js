import { localApi } from '../api.js';
import { LS } from '../state.js';
import { esc, fmt, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { initIcons } from '../icons.js';

const STAGES = [
  { key: 'analyze', label: '分析', icon: 'search', page: 'tracker' },
  { key: 'topics', label: '选题', icon: 'lightbulb', page: 'inspiration' },
  { key: 'create', label: '创作', icon: 'pen-tool', page: 'creator' },
  { key: 'publish', label: '发布', icon: 'send', page: 'creator' },
  { key: 'verify', label: '反馈', icon: 'trending-up', page: 'tracker' },
];

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
      return;
    }

    listEl.classList.remove('hidden');
    emptyEl?.classList.add('hidden');

    // 并发拉每个账号的最新诊断快照
    const accountsWithSnapshot = await Promise.all(accounts.map(async (acc) => {
      const trackerId = acc.trackerId || acc.id;
      const tracker = trackers.find(t => t.id === trackerId);
      let snapshot = null;
      try {
        const snaps = await localApi(`trackers/${encodeURIComponent(trackerId)}/snapshots`);
        snapshot = Array.isArray(snaps) && snaps.length ? snaps[0] : null;
      } catch {}
      return { ...acc, tracker, snapshot };
    }));

    // 渲染账号流水线卡片
    listEl.innerHTML = accountsWithSnapshot.map(renderAccountPipeline).join('');
    initIcons(listEl);

    // 统计
    renderPipelineStats(accountsWithSnapshot);
    renderQuickStats(trackers);

  } catch (e) {
    listEl.innerHTML = `<div class="text-red-400 text-sm py-4 text-center">${esc(e.message)}</div>`;
  }
}

function determineStage(acc) {
  const hasSnapshot = Boolean(acc.snapshot);
  const score = acc.snapshot?.score;
  const hasTracks = acc.tracks?.length > 0;
  const hasStyle = Boolean(acc.styleProfile);

  if (!hasSnapshot) return 0;                    // 待分析
  if (score != null && score < 65) return 1;     // 有问题
  if (hasTracks || hasStyle) return 2;           // 有选题/风格
  return 1;                                       // 默认：有问题待优化
}

function renderAccountPipeline(acc) {
  const stage = determineStage(acc);
  const avatar = proxyImage(acc.avatar);
  const initial = (acc.name || '?')[0];
  const platCls = acc.plat === 'dy' ? 'pill-hot' : acc.plat === 'xhs' ? 'pill-brand' : 'pill-green';
  const score = acc.snapshot?.score;
  const snapshotDate = acc.snapshot?.snapshotDate || acc.snapshot?.captured_at;
  const dateStr = snapshotDate
    ? new Date(snapshotDate).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : null;
  const daysSince = acc.snapshot?.captured_at
    ? Math.floor((Date.now() - new Date(acc.snapshot.captured_at).getTime()) / 86400000)
    : null;

  // pipeline stepper
  const pipeline = STAGES.map((s, i) => {
    const done = i < stage;
    const active = i === stage;
    const dotCls = active ? 'ops-dot ops-dot-active'
      : done ? 'ops-dot ops-dot-done'
      : 'ops-dot';
    const labelCls = active ? 'ops-label ops-label-active' : 'ops-label';
    const lineCls = i < STAGES.length - 1
      ? (i < stage ? 'ops-line ops-line-done' : 'ops-line')
      : null;
    return `
      <div class="ops-stage">
        <div class="${dotCls}"></div>
        <div class="${labelCls}">${s.label}</div>
      </div>
      ${lineCls ? `<div class="${lineCls}"></div>` : ''}
    `;
  }).join('');

  // 状态提示
  let statusBadge = '';
  let statusHint = '';
  if (!acc.snapshot) {
    statusBadge = '<span class="pill pill-gray !text-[10px]">未诊断</span>';
    statusHint = '点击分析账号数据，发现优化方向';
  } else if (score != null && score < 65) {
    statusBadge = '<span class="pill pill-hot !text-[10px]">需优化</span>';
    statusHint = `评分 ${score.toFixed(0)} · 有改进空间`;
  } else {
    statusBadge = '<span class="pill pill-green !text-[10px]">健康</span>';
    statusHint = score ? `评分 ${score.toFixed(0)}` : '';
  }
  if (daysSince != null && daysSince > 7) {
    statusHint += ` · ${daysSince}天前（建议更新）`;
  }

  const nextStage = STAGES[Math.min(stage, STAGES.length - 1)];
  const trackerId = acc.trackerId || acc.id;

  return `
    <div class="ops-card glass-strong rounded-xl p-4">
      <!-- 账号头 -->
      <div class="flex items-center gap-3 mb-3">
        <div class="account-avatar flex-shrink-0" style="width:36px;height:36px;font-size:14px;">
          ${initial}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-sm truncate">${esc(acc.name)}</span>
            <span class="pill ${platCls} !text-[10px] !py-0 flex-shrink-0">${esc(platName(acc.plat))}</span>
            ${statusBadge}
          </div>
          <div class="text-[11px] text-gray-500 mt-0.5">
            ${acc.tracks?.length ? `${acc.tracks.length} 个赛道` : '未设赛道'}
            ${acc.styleProfile ? ' · 已提炼风格' : ''}
            ${dateStr ? ` · ${dateStr}诊断` : ''}
          </div>
        </div>
        <button class="btn btn-ghost py-1 px-2 text-[11px] flex-shrink-0" data-action="gotoPage" data-page="${nextStage.page}">
          ${nextStage.label} <i data-lucide="arrow-right" class="w-3 h-3 inline"></i>
        </button>
      </div>

      <!-- pipeline stepper -->
      <div class="ops-pipeline mb-2">${pipeline}</div>

      <!-- 状态提示 -->
      ${statusHint ? `<div class="text-[11px] text-gray-500 flex items-center gap-1.5">
        <i data-lucide="${score != null && score < 65 ? 'alert-circle' : 'info'}" class="w-3 h-3"></i>
        ${esc(statusHint)}
      </div>` : ''}
    </div>
  `;
}

function renderPipelineStats(accounts) {
  const stats = { analyze: 0, issues: 0, topics: 0, creating: 0, verify: 0 };
  for (const acc of accounts) {
    const stage = determineStage(acc);
    if (stage === 0) stats.analyze++;
    else if (stage === 1) stats.issues++;
    else if (stage === 2) stats.topics++;
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ops-stat-analyze', stats.analyze);
  set('ops-stat-issues', stats.issues);
  set('ops-stat-topics', stats.topics);
  set('ops-stat-creating', '—');
  set('ops-stat-verify', '—');
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

// 兼容旧调用（renderFeedAndHistory / renderDashboard 原有引用）
export async function renderFeedAndHistory() {}
