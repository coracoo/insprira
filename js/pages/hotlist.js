import { localApi, cancelApi } from '../api.js';
import { toggleCron } from './settings.js';
import { esc, fmt } from '../utils.js';
import { platName, platColor, platCodeByName } from '../config.js';
import { toast, skeleton, rankBadge } from '../components.js';
import { initIcons } from '../icons.js';
import { adaptDY, adaptXHS, adaptGZH, adaptAIGZH, adaptAIBili, adaptAIXHS, adaptAiFeed } from '../core/adapters.js';
import { renderListItem } from '../core/renderers.js';

let hotCache = { dy: null, xhs: null, gzh: null, aiGzh: null, hotKeyword: null, hotCacheTime: 0 };
let hotPlatforms = [];

export function clearHotCache() {
  hotCache = { dy: null, xhs: null, gzh: null, aiGzh: null, hotKeyword: null, hotCacheTime: 0 };
}

export function clearHotPlatforms() {
  hotPlatforms = [];
}

async function loadHotPlatforms() {
  if (hotPlatforms.length) return hotPlatforms;
  try {
    const data = await localApi('hot/platforms');
    hotPlatforms = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('加载热榜 platform 列表失败:', e.message);
    hotPlatforms = []; // TOP50 默认关闭，需要去 Skills 中心绑定才显示
  }
  return hotPlatforms;
}

function hotSourceMeta(result, realtime = false) {
  const isApi = result?.sourceMode === 'api';
  const sourceClass = isApi ? 'pill-green' : 'pill-amber';
  const captured = result?.capturedAt ? new Date(result.capturedAt).toLocaleString('zh-CN') : '未知';
  const dataDate = result?.dataDate || '无';
  const attempt = result?.latestAttempt;
  const attemptText = attempt && attempt.status !== 'success'
    ? ` · 最近 API 尝试：${attempt.status === 'empty' ? '空数据' : '失败'}${attempt.error ? `（${esc(attempt.error)}）` : ''}`
    : '';
  return {
    isApi,
    badge: `<span class="pill ${sourceClass}">${esc(result?.sourceLabel || '本地缓存数据')}</span>`,
    text: realtime
      ? `数据日期 ${esc(dataDate)} · 抓取于 ${esc(captured)}${attemptText}`
      : `榜单日期 ${esc(dataDate)} · 入库于 ${esc(captured)}${attemptText}`,
  };
}

export async function renderHotlist() {
  const top = document.getElementById('hot-top10');
  const tabContent = document.getElementById('hot-tab-content');
  const topTime = document.getElementById('hot-top10-time');
  if (!top || !tabContent || !topTime) return;
  top.innerHTML = skeleton(8);
  tabContent.innerHTML = skeleton(6);
  topTime.textContent = '加载中…';

  try {
    const [kwResult] = await Promise.all([
      localApi('hot/keywords'),
    ]);
    if (!top.isConnected) return;

    if (kwResult?.length) {
      hotCache.hotKeyword = kwResult;
      top.innerHTML = kwResult.slice(0, 12).map((kw, i) => {
        const plats = kw.raw?.plats || [];
        return `
        <div class="flex items-center gap-2 p-2 bg-white/[0.02] rounded-lg card border border-white/5">
          ${rankBadge(i + 1)}
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium truncate leading-tight">${esc(kw.title)}</div>
            <div class="flex items-center gap-1 mt-0.5 text-[9px] text-gray-500 flex-wrap">
              ${plats.slice(0, 4).map(p => `<span class="flex items-center gap-0.5"><span class="platform-dot" style="background:${platColor(platCodeByName(p))}"></span>${esc(p)}</span>`).join(' ')}
            </div>
          </div>
        </div>`;
      }).join('');
      const capturedAt = kwResult.capturedAt ? new Date(kwResult.capturedAt) : null;
      const timeText = capturedAt
        ? capturedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '已更新';
      const meta = hotSourceMeta(kwResult, true);
      topTime.innerHTML = `${meta.badge}<span>${esc(timeText)} · 数据日期 ${esc(kwResult.dataDate || '')}</span>`;
    } else {
      top.innerHTML = `
        <div class="col-span-2 text-center text-gray-400 py-8 text-sm">
          <div class="mb-3">暂无全网热点数据</div>
          <button class="btn btn-primary py-1.5 text-xs" data-action="syncHotKeywords"><i data-lucide="refresh-cw" class="w-3 h-3"></i>刷新热点</button>
        </div>`;
    }
  } catch (e) {
    if (top.isConnected) top.innerHTML = `<div class="col-span-2 text-center text-red-400 py-8 text-sm">加载失败：${esc(e.message)}</div>`;
  }

  if (!top.isConnected) return;
  await renderHotTabs();
  if (!top.isConnected) return;
  await renderHotTab('trending-hub');
  if (!top.isConnected) return;
  await loadHotTrends();
  if (!top.isConnected) return;
  bindHotTabs();
  initIcons(document.getElementById('content-area'));
}

async function renderHotTabs() {
  const container = document.getElementById('hot-tabs');
  if (!container) return;
  const platforms = await loadHotPlatforms();
  container.innerHTML = platforms.map((p, idx) =>
    `<div class="relative group inline-flex">
      <button class="tab-btn ${idx === 0 ? 'active' : ''} px-3 py-1.5 text-sm rounded-md pr-5" data-tab="${esc(p.key)}">${esc(p.label)}</button>
      <button class="absolute right-0.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full hover:bg-red-500/80 text-[10px] text-gray-500 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" data-action="closeHotTab" data-cron-id="${esc(p.cronId)}" data-tab="${esc(p.key)}" title="删除该 Tab">×</button>
    </div>`
  ).join('');
}

export async function syncHotKeywords() {
  toast('正在刷新全网热点…', 'info');
  try {
    await localApi('hot/keywords/sync', { method: 'POST', body: {} });
    toast('热点刷新成功', 'success');
    renderHotlist();
  } catch (e) {
    toast('刷新失败：' + e.message, 'error');
    renderHotlist();
  }
}

export async function renderHotTab(tab) {
  const content = document.getElementById('hot-tab-content');
  const metaEl = document.getElementById('hot-tab-meta');
  if (!content || !metaEl) return;

  // 特殊：全网聚合 tab 直接复用 top 区域的关键词数据
  if (tab === 'trending-hub') {
    if (!hotCache.hotKeyword) {
      try { hotCache.hotKeyword = await localApi('hot/keywords'); } catch {}
    }
    const kw = hotCache.hotKeyword || [];
    metaEl.innerHTML = `<div class="text-[11px] text-gray-400">基于 hourly 收录的 7 大平台热搜数据聚合 · 共 ${kw.length} 条</div>`;
    if (!kw.length) {
      content.innerHTML = '<div class="text-center text-gray-500 py-8 text-sm">暂无热点数据，<button class="text-pink-400 underline" data-action="syncHotKeywords">立即刷新</button></div>';
      initIcons(content);
      return;
    }
    content.innerHTML = kw.map((item, i) => {
      const plats = item.raw?.plats || [];
      return `
        <div class="flex items-center gap-3 p-2.5 bg-white/[0.02] rounded-lg card border border-white/5">
          ${rankBadge(i + 1)}
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium truncate">${esc(item.title)}</div>
            <div class="flex items-center gap-1 mt-0.5 text-[10px] text-gray-500 flex-wrap">
              ${plats.slice(0, 6).map(p => `<span class="flex items-center gap-0.5"><span class="platform-dot" style="background:${platColor(platCodeByName(p))}"></span>${esc(p)}</span>`).join(' ')}
            </div>
          </div>
        </div>`;
    }).join('');
    initIcons(content);
    return;
  }

  content.innerHTML = '<div class="text-center text-gray-500 py-8 text-sm">加载中…</div>';
  metaEl.innerHTML = '';
  cancelApi('hotlist-tab');
  try {
    const result = await localApi('hot/list?platform=' + tab, { abortKey: 'hotlist-tab' });
    if (!content.isConnected) return;
    const platforms = await loadHotPlatforms();
    const tabNames = Object.fromEntries(platforms.map(p => [p.key, p.label]));
    const cronId = `hot-daily-${tab}`;
    const meta = hotSourceMeta(result);
    metaEl.innerHTML = `
      <div class="flex items-center justify-between gap-3 rounded-lg bg-white/[0.025] px-3 py-2 text-[11px] text-gray-400">
        <div class="flex items-center gap-2 flex-wrap">${meta.badge}<span>${meta.text}</span><code class="text-purple-300">${esc(result.cronExpr || '')}</code></div>
        <button class="btn btn-ghost py-1 px-2 text-[11px]" data-action="toggleHotPlatformCron" data-cron-id="${cronId}" data-enabled="${result.cronEnabled ? 'false' : 'true'}" data-tab="${tab}">
          <i data-lucide="${result.cronEnabled ? 'pause' : 'play'}" class="w-3 h-3"></i>
          自动刷新：${result.cronEnabled ? '开' : '关'}
        </button>
      </div>`;
    if (!Array.isArray(result) || result.length === 0) {
      content.innerHTML = `
        <div class="text-center text-gray-400 py-8 text-sm">
          <div class="mb-3">暂无 ${tabNames[tab] || tab} 本地数据</div>
          <button class="btn btn-primary py-1.5 text-xs" data-action="syncHotTab" data-tab="${tab}"><i data-lucide="refresh-cw" class="w-3 h-3"></i>刷新 ${tabNames[tab] || tab}</button>
        </div>`;
      initIcons(document.getElementById('content-area'));
      return;
    }
    const platformCfg = platforms.find(p => p.key === tab);
    const adapter = platformCfg?.adapter;
    let list = [];
    if (tab === 'dy') {
      list = result.slice(0, 20).map(item => adaptDY(item.raw));
    } else if (tab === 'xhs') {
      list = result.slice(0, 20).map(item => adaptXHS(item.raw));
    } else if (tab === 'gzh') {
      list = result.slice(0, 20).map(item => adaptGZH(item.raw));
    } else if (tab === 'ai-gzh') {
      list = result.slice(0, 50).map(item => adaptAIGZH(item.raw));
    } else if (tab === 'ai-bili') {
      list = result.slice(0, 50).map(item => adaptAIBili(item.raw));
    } else if (tab === 'ai-xhs') {
      list = result.slice(0, 50).map(item => adaptAIXHS(item.raw));
    } else if (adapter === 'aiFeed') {
      list = result.slice(0, 50).map(item => adaptAiFeed(item.raw, tab));
    }
    list = list.filter(item => item.title);
    list.forEach((it, i) => it._rank = i + 1);
    const tabDate = result.dataDate || (result[0]?.snapshotDate || '');
    const dateStr = tabDate ? tabDate.slice(5).replace('-', '/') : '';
    const dateHtml = dateStr ? `<div class="text-[10px] text-gray-600 mb-2">榜单所属日期：${dateStr}</div>` : '';
    content.innerHTML = dateHtml + list.map(renderListItem).join('');
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (content.isConnected) content.innerHTML = `<div class="text-center text-red-400 py-8 text-sm">加载失败：${esc(e.message)}</div>`;
  }
  if (content.isConnected) initIcons(document.getElementById('content-area'));
}

export async function toggleHotPlatformCron(cronId, enabled, tab) {
  await toggleCron(cronId, enabled);
  await renderHotTab(tab);
}

export async function closeHotTab(cronId, tab) {
  if (!confirm('确定删除这个热榜 Tab？删除后会同时移除自动选题中的对应数据源。')) return;
  try {
    await localApi('crons/' + cronId, { method: 'DELETE' });
    toast('已删除 Tab', 'success');
    clearHotPlatforms();
    await renderHotTabs();
    const activeBtn = document.querySelector(`#hot-tabs [data-tab="${esc(tab)}"]`);
    if (activeBtn) activeBtn.classList.remove('active');
    const firstBtn = document.querySelector('#hot-tabs [data-tab]');
    if (firstBtn) {
      firstBtn.click();
    } else {
      const content = document.getElementById('hot-tab-content');
      const metaEl = document.getElementById('hot-tab-meta');
      if (content) content.innerHTML = '<div class="text-center text-gray-500 py-8 text-sm">暂无热榜 Tab，可通过 Skill 中心绑定。</div>';
      if (metaEl) metaEl.innerHTML = '';
    }
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

export async function syncHotTab(tab) {
  const platforms = await loadHotPlatforms();
  const tabNames = Object.fromEntries(platforms.map(p => [p.key, p.label]));
  toast(`正在刷新 ${tabNames[tab] || tab}…`, 'info');
  try {
    await localApi('hot/list/sync?platform=' + tab, { method: 'POST', body: {} });
    toast(`${tabNames[tab] || tab} 刷新成功`, 'success');
    renderHotTab(tab);
  } catch (e) {
    toast('刷新失败：' + e.message, 'error');
    renderHotTab(tab);
  }
}

export function bindHotTabs() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-tab]').forEach(b => { b.classList.remove('active'); b.style.background = 'transparent'; b.style.color = ''; });
      btn.classList.add('active');
      btn.style.background = 'rgba(139,92,246,.15)';
      btn.style.color = '#c4b5fd';
      renderHotTab(btn.dataset.tab);
    };
    btn.onmouseenter = () => { if (!btn.classList.contains('active')) btn.style.background = 'rgba(255,255,255,.04)'; };
    btn.onmouseleave = () => { if (!btn.classList.contains('active')) btn.style.background = 'transparent'; };
    if (btn.classList.contains('active')) { btn.style.background = 'rgba(139,92,246,.15)'; btn.style.color = '#c4b5fd'; }
  });
}

export async function loadHotTrends() {
  const el = document.getElementById('hot-trends');
  if (!el) return;
  const days = document.getElementById('trendDays')?.value || 14;
  el.innerHTML = skeleton(4);
  try {
    const trends = await localApi(`hot/trends?days=${days}`);
    if (!el.isConnected) return;
    const analyzed = trends.analyzed === true;

    if (analyzed && trends.themes) {
      renderLlmTrends(el, trends);
      return;
    }
    if (!trends.length) {
      el.innerHTML = '<div class="md:col-span-2 text-center text-gray-500 py-8 text-sm">还没有足够的历史快照。点击"立即快照"保存今天的数据，连续运行后即可看到趋势。</div>';
      return;
    }
    const analyzeBtn = `<div class="md:col-span-2 text-center py-2"><button class="btn btn-ghost py-1.5 text-xs" data-action="analyzeTrends"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i>AI 深度分析趋势</button></div>`;
    el.innerHTML = trends.slice(0, 16).map(item => {
      const style = item.trend === '增长' ? 'pill-green' : item.trend === '冷却' ? 'pill-hot' : 'pill-sky';
      const icon = item.trend === '增长' ? 'trending-up' : item.trend === '冷却' ? 'trending-down' : 'minus';
      const change = item.rankChange > 0 ? `上升 ${item.rankChange} 位` : item.rankChange < 0 ? `下降 ${Math.abs(item.rankChange)} 位` : '排名持平';
      return `<div class="glass rounded-xl p-4">
        <div class="flex items-start gap-3">
          <span class="pill ${style} flex-shrink-0"><i data-lucide="${icon}" class="w-3 h-3"></i>${item.trend}</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium line-clamp-2">${esc(item.title)}</div>
            <div class="text-[11px] text-gray-500 mt-1">${platName(item.platform)} · 当前 #${item.latestRank} · ${change} · 出现 ${item.daysSeen} 天</div>
          </div>
        </div>
      </div>`;
    }).join('') + analyzeBtn;
    initIcons(document.getElementById('content-area'));
  } catch (e) {
    if (el.isConnected) el.innerHTML = `<div class="md:col-span-2 text-center text-red-400 py-8 text-sm">${esc(e.message)}</div>`;
  }
}

export function renderLlmTrends(el, data) {
  const themes = data.themes || [];
  if (!themes.length) {
    el.innerHTML = `<div class="md:col-span-2 text-center text-gray-500 py-8 text-sm">${esc(data.summary || '尚未积累足够的真实日榜数据')}</div>`;
    return;
  }
  const summaryHtml = data.summary
    ? `<div class="md:col-span-2 glass-strong rounded-xl p-4 text-sm"><span class="pill pill-brand flex-shrink-0 mr-2"><i data-lucide="sparkles" class="w-3 h-3"></i>AI</span><span class="text-purple-200">${esc(data.summary)}</span></div>`
    : '';
  const themesHtml = themes.map(t => {
    const style = t.trend === '增长' ? 'pill-green' : t.trend === '冷却' ? 'pill-hot' : 'pill-sky';
    const icon = t.trend === '增长' ? 'trending-up' : t.trend === '冷却' ? 'trending-down' : 'minus';
    const plats = (t.platforms || []).map(p => platName(p)).join('、');
    const keywords = (t.keywords || []).map(k => `<span class="tag">${esc(k)}</span>`).join(' ');
    const titles = (t.topTitles || []).slice(0, 2).map(title => `<div class="text-[11px] text-gray-500 mt-0.5 truncate">· ${esc(title)}</div>`).join('');
    return `<div class="glass rounded-xl p-4">
      <div class="flex items-start gap-3 mb-2">
        <span class="pill ${style} flex-shrink-0"><i data-lucide="${icon}" class="w-3 h-3"></i>${t.trend}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium">${esc(t.name)}</div>
          <div class="text-[11px] text-gray-500 mt-0.5">${plats} · ${t.daysSeen || '?'} 天 · ${t.scoreChange || '--'}</div>
        </div>
      </div>
      ${keywords ? `<div class="flex flex-wrap gap-1.5 mb-1">${keywords}</div>` : ''}
      ${t.reason ? `<div class="text-[11px] text-gray-400">${esc(t.reason)}</div>` : ''}
      ${titles}
    </div>`;
  }).join('');
  const reanalyzeBtn = `<div class="md:col-span-2 text-center py-2"><button class="btn btn-ghost py-1.5 text-xs" data-action="analyzeTrends"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i>重新分析</button></div>`;
  el.innerHTML = summaryHtml + themesHtml + reanalyzeBtn;
  initIcons(document.getElementById('content-area'));
}

export async function analyzeTrends() {
  const el = document.getElementById('hot-trends');
  if (!el) return;
  const days = document.getElementById('trendDays')?.value || 14;
  el.innerHTML = '<div class="md:col-span-2 text-center text-purple-300 py-8 text-sm"><i data-lucide="sparkles" class="w-4 h-4 inline-block animate-pulse"></i> AI 正在分析热榜趋势…</div>';
  initIcons(document.getElementById('content-area'));
  try {
    await localApi(`hot/trends/analyze?days=${days}`, { method: 'POST', body: {} });
    loadHotTrends();
  } catch (e) {
    if (el.isConnected) el.innerHTML = `<div class="md:col-span-2 text-center text-red-400 py-8 text-sm">分析失败：${esc(e.message)}</div>`;
  }
}

export async function runSnapshot() {
  const el = document.getElementById('hot-trends');
  if (el) el.innerHTML = '<div class="md:col-span-2 text-center text-gray-400 py-8 text-sm">正在抓取六个平台并保存快照，请稍候…</div>';
  try {
    const result = await localApi('snapshot/run', { method: 'POST', body: {} });
    const okCount = result.platforms.filter(item => item.ok).length;
    toast(`快照完成：${okCount}/${result.platforms.length} 个数据源成功`, okCount ? 'success' : 'error');
    await loadHotTrends();
  } catch (e) {
    toast(e.message, 'error');
    await loadHotTrends();
  }
}
