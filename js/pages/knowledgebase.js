import { localApi } from '../api.js';
import { LS, currentPage } from '../state.js';
import { esc, renderMarkdown, renderWechatArticle, prepareMarkdownLinks, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';
import { cacheKbEntry, sendKbToCreatorByKey } from '../core/itemCache.js';
import { gotoPage } from '../navigation.js';

let currentLibFilter = 'all';
let currentKbSource = 'obsidian';
let currentKbTab = 'kb';
let kbEntries = [];
let kbFolders = [];
let kbDebounceTimer = null;
let kbSelectedFolder = '';
let kbExpandedFolders = new Set();

const AVATAR_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-green-500',
  'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-sky-500',
  'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500',
  'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500',
];

function mpAvatarColor(name, id) {
  const seed = String(name || id || '').split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return AVATAR_COLORS[seed % AVATAR_COLORS.length];
}

function mpAvatarPlaceholder(name, id, size = 'w-5 h-5', iconSize = 'w-3 h-3') {
  return `<div class="${size} rounded-full ${mpAvatarColor(name, id)} flex items-center justify-center flex-shrink-0"><i data-lucide="user" class="${iconSize} text-white"></i></div>`;
}

export async function renderKnowledgebase() {
  try {
    const cfg = await localApi('kb/config');
    // 默认强制 Obsidian tab：不读 cfg.sourceType，避免配置过 notion 后视觉/数据错位
    currentKbSource = 'obsidian';
    currentKbTab = 'obsidian';
    syncKbTabHighlight('obsidian');
    const libCount = LS.get('library', []).length;
    document.getElementById('kb-lib-count').textContent = libCount;
    if (!cfg.sourceType) {
      document.getElementById('kb-entries').innerHTML = '';
      document.getElementById('kb-empty').classList.remove('hidden');
      document.getElementById('kb-empty-msg').textContent = '知识库未配置';
      document.getElementById('kb-empty-hint').textContent = '点击"配置"按钮设置 Obsidian 路径或 Notion API';
      await updateKbSub('obsidian');
      initIcons(document.getElementById('content-area'));
      return;
    }
    // 根据 currentKbTab 渲染对应区域
    if (currentKbTab === 'library') {
      renderKbLibrary();
    } else if (currentKbTab === 'wersss') {
      renderWersss();
    } else {
      await loadKbEntries();
    }
    await updateKbSub(currentKbTab || currentKbSource);
  } catch (e) {
    toast('加载知识库配置失败: ' + e.message, 'error');
  }
}

function syncKbTabHighlight(tab) {
  document.querySelectorAll('.kb-tab').forEach(t => {
    const isActive = t.dataset.tabName === tab || t.dataset.tab === tab;
    t.classList.toggle('active', isActive);
    t.classList.toggle('border-brand', isActive);
    t.classList.toggle('border-transparent', !isActive);
    t.classList.toggle('text-gray-400', !isActive);
  });
  const isKbSource = tab === 'obsidian' || tab === 'notion';
  document.getElementById('kb-tab-kb')?.classList.toggle('hidden', !isKbSource);
  document.getElementById('kb-tab-library')?.classList.toggle('hidden', tab !== 'library');
  document.getElementById('kb-tab-wersss')?.classList.toggle('hidden', tab !== 'wersss');
}

export async function switchKbTab(el, d) {
  const tab = d?.tabName || d?.tab || 'obsidian';
  currentKbTab = tab;
  document.querySelectorAll('.kb-tab').forEach(t => {
    t.classList.remove('active', 'border-brand');
    t.classList.add('border-transparent', 'text-gray-400');
  });
  const active = document.querySelector(`.kb-tab[data-tab-name="${tab}"]`) || document.querySelector(`.kb-tab[data-tab="${tab}"]`);
  if (active) {
    active.classList.add('active', 'border-brand');
    active.classList.remove('border-transparent', 'text-gray-400');
  }
  const isKbSource = tab === 'obsidian' || tab === 'notion';
  document.getElementById('kb-tab-kb').classList.toggle('hidden', !isKbSource);
  document.getElementById('kb-tab-library').classList.toggle('hidden', tab !== 'library');
  document.getElementById('kb-tab-wersss').classList.toggle('hidden', tab !== 'wersss');
  await updateKbSub(tab);
  if (tab === 'library') renderKbLibrary();
  else if (tab === 'wersss') renderWersss();
  else {
    // obsidian/notion：切换不弹配置框，直接读对应源数据
    currentKbSource = tab;
    await loadKbEntries(null, null, null, true, tab);
  }
}

async function updateKbSub(tab) {
  const sub = document.getElementById('kb-sub');
  if (!sub) return;
  if (tab === 'obsidian' || tab === 'notion') {
    try {
      const cfg = await localApi('kb/config');
      if (cfg.sourceType === tab) {
        if (tab === 'obsidian') sub.textContent = `来源：Obsidian · ${cfg.sourcePath || '(未配置路径)'}`;
        else sub.textContent = `来源：Notion${cfg.notionConfigured ? ` · ${cfg.notionDatabaseId || '(已配置)'}` : ' · 未配置'}`;
      } else {
        sub.textContent = `未配置 ${tab === 'obsidian' ? 'Obsidian' : 'Notion'}（点击 tab 弹出配置）`;
      }
    } catch { sub.textContent = '读取配置失败'; }
  } else if (tab === 'wersss') {
    try {
      const cfg = await localApi('wersss/config');
      sub.textContent = cfg.configured
        ? `WeRss 接入：${cfg.enabled ? '已启用' : '已停用'} · ${cfg.baseUrl}`
        : 'WeRss 接入：未配置';
    } catch { sub.textContent = '读取 WeRss 配置失败'; }
  } else if (tab === 'library') {
    const count = LS.get('library', []).length;
    sub.textContent = `本地收藏 · ${count} 条`;
  }
}

export async function switchKbSource(source) {
  const config = await localApi('kb/config');
  if (source !== config.sourceType) {
    openKbConfigModal(source);
    return;
  }
  currentKbSource = source;
  updateKbSourceTabs(config);
  await loadKbEntries(null, null, null, true);
}

export function renderKbLibrary() {
  const lib = LS.get('library', []);
  const grid = document.getElementById('kb-lib-entries');
  const empty = document.getElementById('kb-lib-empty');
  if (!lib.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = lib.map((it, i) => {
    const kbKey = cacheKbEntry(it, i);
    return `
    <div class="glass rounded-xl overflow-hidden card" style="cursor:default">
      <div class="aspect-[4/3] bg-black/40 relative overflow-hidden">
        ${it.cover && it.cover.startsWith('http') ? `<img src="${proxyImage(it.cover)}" class="w-full h-full object-cover" data-image-error="hide" />` : ''}
        <div class="absolute top-2 left-2"><span class="pill ${it.plat==='dy'?'pill-hot':it.plat==='xhs'?'pill-brand':'pill-green'}">${it.plat ? platName(it.plat) : 'KB'}</span></div>
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <i data-lucide="${it.plat==='dy'?'video':it.plat==='xhs'?'image':it.plat==='kb'?'book-open':'file-text'}" class="w-12 h-12 text-white/30"></i>
        </div>
      </div>
      <div class="p-3">
        <div class="text-sm font-medium line-clamp-2 mb-1.5 min-h-[2.5em]">${esc(it.title)}</div>
        <div class="text-[11px] text-gray-500 mb-2">${esc(it.author || '')}${it.authorFans ? ' · ' + esc(it.authorFans) + ' 粉' : ''}</div>
        ${it.summary ? `<div class="text-[11px] text-gray-600 line-clamp-2 mb-2">${esc(it.summary)}</div>` : ''}
        <div class="flex items-center gap-1.5">
          ${it.plat ? `<button class="btn btn-ghost text-[11px] py-1 px-2 flex-1 justify-center" data-action="showDetail" data-plat="${it.plat}" data-work-id="${it.workId}"><i data-lucide="eye" class="w-3 h-3"></i></button>` : ''}
          <button class="btn btn-ghost text-[11px] py-1 px-2 flex-1 justify-center" data-action="sendKbToCreatorByKey" data-key="${kbKey}"><i data-lucide="sparkles" class="w-3 h-3"></i></button>
          <button class="btn btn-ghost text-[11px] py-1 px-2" data-action="removeFromLibrary" data-plat="${it.plat}" data-work-id="${it.workId}"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
        </div>
      </div>
    </div>
  `}).join('');
  initIcons(document.getElementById('kb-lib-entries'));
}

export async function loadKbEntries(q, tag, folder, refresh = false, source) {
  const src = source || currentKbSource || 'obsidian';
  const params = new URLSearchParams();
  params.set('source', src);
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  if (folder) params.set('folder', folder);
  params.set('limit', '50');
  if (refresh) params.set('refresh', '1');
  const result = await localApi('kb/entries?' + params.toString());
  kbEntries = result.entries || [];
  kbFolders = result.folders || [];
  kbSelectedFolder = folder || '';
  renderKbGrid();
  renderKbFolderTree();

  const tagSel = document.getElementById('kb-filter-tag');
  tagSel.innerHTML = '<option value="">全标签</option>' +
    (result.tags || []).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  if (tag) tagSel.value = tag;
}

export function renderKbGrid() {
  const grid = document.getElementById('kb-entries');
  const empty = document.getElementById('kb-empty');
  if (!kbEntries.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = kbEntries.map((e, index) => `
    <div class="glass rounded-xl overflow-hidden card" data-action="openKbEntry" data-index="${index}">
      <div class="p-4">
        <div class="text-sm font-medium line-clamp-2 mb-2">${esc(e.title)}</div>
        ${e.tags && e.tags.length ? `<div class="flex flex-wrap gap-1 mb-2">${e.tags.slice(0,4).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="text-[11px] text-gray-500 truncate">${esc(e.folder || '—')}</div>
        <div class="text-[11px] text-gray-600 mt-1 line-clamp-2">${esc(e.content_preview || '（无预览）')}</div>
      </div>
    </div>
  `).join('');
  initIcons(document.getElementById('kb-entries'));
}

function buildFolderTree(paths) {
  const root = { name: '', children: new Map(), count: 0 };
  for (const path of paths) {
    const parts = String(path || '').split('/').filter(Boolean);
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), count: 0, fullPath: '' });
      }
      node = node.children.get(part);
      node.count++;
      node.fullPath = parts.slice(0, i + 1).join('/');
    }
  }
  return root;
}

function renderFolderNode(node, level = 0) {
  const indent = level * 12;
  const hasChildren = node.children && node.children.size > 0;
  const isRoot = level === 0 && node.name === '';
  if (isRoot) {
    return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => renderFolderNode(child, level)).join('');
  }
  const activeClass = kbSelectedFolder === node.fullPath ? 'bg-purple-500/20 text-purple-300' : 'hover:bg-white/[0.04] text-gray-400';
  const expanded = !hasChildren || kbExpandedFolders.has(node.fullPath);
  const childrenHtml = (hasChildren && expanded)
    ? `<div class="mt-0.5">${[...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => renderFolderNode(child, level + 1)).join('')}</div>`
    : '';
  const chevron = hasChildren
    ? `<i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}" class="w-3 h-3 flex-shrink-0 text-gray-500" data-action="toggleKbFolder" data-folder="${esc(node.fullPath)}"></i>`
    : `<span class="w-3 flex-shrink-0"></span>`;
  return `
    <div class="select-none">
      <div class="flex items-center gap-1 py-1 pr-2 rounded-md cursor-pointer ${activeClass}" style="padding-left:${4 + indent}px" data-action="selectKbFolder" data-folder="${esc(node.fullPath)}">
        ${chevron}
        ${expanded && hasChildren ? `<i data-lucide="folder-open" class="w-3.5 h-3.5 flex-shrink-0 text-amber-400/70"></i>` : `<i data-lucide="folder" class="w-3.5 h-3.5 flex-shrink-0 text-amber-400/70"></i>`}
        <span class="truncate flex-1">${esc(node.name)}</span>
      </div>
      ${childrenHtml}
    </div>
  `;
}

export function renderKbFolderTree() {
  const host = document.getElementById('kb-folder-tree');
  if (!host) return;
  const tree = buildFolderTree(kbFolders);
  const rootActive = kbSelectedFolder === '' ? 'bg-purple-500/20 text-purple-300' : 'hover:bg-white/[0.04] text-gray-400';
  host.innerHTML = `
    <div class="flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer ${rootActive}" data-action="selectKbFolder" data-folder="">
      <i data-lucide="folders" class="w-3.5 h-3.5 flex-shrink-0"></i>
      <span class="truncate flex-1">全部文件夹</span>
    </div>
    ${renderFolderNode(tree)}
  `;
  initIcons(host);
}

export function toggleKbFolder(el, d) {
  const folder = d.folder || '';
  if (kbExpandedFolders.has(folder)) kbExpandedFolders.delete(folder);
  else kbExpandedFolders.add(folder);
  renderKbFolderTree();
}

export async function selectKbFolder(el, d) {
  const folder = d.folder || '';
  kbSelectedFolder = folder;
  const q = document.getElementById('kb-search')?.value.trim() || '';
  const tag = document.getElementById('kb-filter-tag')?.value || '';
  await loadKbEntries(q, tag, folder);
}

export function searchKb() {
  clearTimeout(kbDebounceTimer);
  kbDebounceTimer = setTimeout(async () => {
    const q = document.getElementById('kb-search').value.trim();
    const tag = document.getElementById('kb-filter-tag').value;
    await loadKbEntries(q, tag, kbSelectedFolder);
  }, 350);
}

export async function openKbEntry(index) {
  const entryKey = kbEntries[index]?.entry_key;
  if (!entryKey) {
    toast('条目路径无效，请刷新知识库后重试', 'error');
    return;
  }
  const encoded = encodeURIComponent(entryKey);
  try {
    const entry = await localApi('kb/entries/' + encoded + '?refresh=1');
    openKbEntryModal(entry, currentKbSource);
  } catch (e) {
    toast('加载条目失败: ' + e.message, 'error');
  }
}

export function openKbEntryModal(entry, sourceType) {
  const tagsHtml = (entry.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
  const contentHtml = renderMarkdown(entry.content);
  window._activeKbEntry = entry;
  window._activeKbSource = sourceType;
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal flex flex-col overflow-hidden" style="max-width:1120px;width:96vw;height:min(88vh,860px);padding:0">
      <div class="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/10 flex-shrink-0">
        <div class="min-w-0">
          <h2 class="text-lg font-bold truncate">${esc(entry.title)}</h2>
          <div class="flex items-center gap-2 flex-wrap mt-2">
            ${tagsHtml}
            <span class="text-[11px] text-gray-500">${esc(entry.folder || '')}</span>
          </div>
        </div>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="grid grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(240px,.65fr)] lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-1 flex-1 min-h-0">
        <div class="overflow-y-auto scrollbar-thin p-6 min-h-0">
          <div class="markdown-body" data-markdown-body>${contentHtml}</div>
        </div>
        <aside class="border-t lg:border-t-0 lg:border-l border-white/10 bg-black/10 flex flex-col min-h-0">
          <div class="p-4 border-b border-white/10 flex-shrink-0">
            <div class="grid grid-cols-2 gap-2">
              <button class="btn btn-ghost justify-center" data-action="linkKbToInspiration"><i data-lucide="link" class="w-3.5 h-3.5"></i>关联选题</button>
              <button class="btn btn-ghost justify-center" id="kb-match-btn" data-action="matchKbToInspirations"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i>匹配选题</button>
              <button class="btn btn-ghost justify-center" id="kb-analyze-btn" data-action="analyzeKbEntry"><i data-lucide="bar-chart-2" class="w-3.5 h-3.5"></i>对比热榜</button>
              <button class="btn btn-primary justify-center" data-action="sendKbToCreatorActive"><i data-lucide="sparkles" class="w-3.5 h-3.5"></i>发送创作</button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto scrollbar-thin p-4 min-h-0">
            <div id="kb-entry-match-section" class="hidden"></div>
            <div id="kb-entry-analysis-section" class="hidden"></div>
            <div id="kb-entry-side-empty" class="text-xs text-gray-500 text-center py-10">选择“匹配选题”或“对比热榜”查看分析结果</div>
          </div>
        </aside>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  prepareMarkdownLinks(modal.querySelector('[data-markdown-body]'));
  initIcons(modal);
}

export async function analyzeKbEntry(btn) {
  const entryKey = window._activeKbEntry?.entry_key;
  const sourceType = window._activeKbSource || currentKbSource;
  if (!entryKey) return;
  const section = document.getElementById('kb-entry-analysis-section');
  document.getElementById('kb-entry-side-empty')?.classList.add('hidden');
  document.getElementById('kb-entry-match-section')?.classList.add('hidden');
  if (!section.classList.contains('hidden')) {
    section.classList.add('hidden');
    section.innerHTML = '';
    document.getElementById('kb-entry-side-empty')?.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>分析中…';
  initIcons(section);
  section.classList.remove('hidden');
  section.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">正在对比热榜数据…</div>';
  try {
    const result = await localApi('kb/entries/analyze', { method: 'POST', body: { entryKey, sourceType } });
    showKbAnalysisResult(result, entryKey, sourceType);
  } catch (e) {
    section.innerHTML = `<div class="text-xs text-red-400 py-2">分析失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="bar-chart-2" class="w-3.5 h-3.5"></i>对比热榜';
    initIcons(section);
  }
}

export function showKbAnalysisResult(result, entryKey, sourceType) {
  const section = document.getElementById('kb-entry-analysis-section');
  const dirColor = { '增长': 'text-emerald-400', '稳定': 'text-amber-400', '冷却': 'text-red-400' };
  const dirIcon = { '增长': 'trending-up', '稳定': 'minus', '冷却': 'trending-down' };
  if (!result || !result.topMatches?.length) {
    section.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <span class="text-xs font-medium flex items-center gap-1"><i data-lucide="bar-chart-2" class="w-3.5 h-3.5"></i>热榜对比结果</span>
      <button class="btn btn-ghost py-0.5 px-1.5 text-[10px]" data-action="reanalyzeKbEntry"><i data-lucide="refresh-cw" class="w-3 h-3"></i>重新分析</button>
    </div>
    <div class="text-xs text-gray-500 py-2">${result?.suggestedAngle || '文章与当前热榜暂无明显关联，建议持续观察或选择其他方向。'}</div>
    ${result?.trendOutlook ? `<div class="text-[11px] text-gray-400 mt-1"><i data-lucide="activity" class="w-3 h-3 inline"></i>${esc(result.trendOutlook)}</div>` : ''}`;
    initIcons(section);
    return;
  }
  section.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <span class="text-xs font-medium flex items-center gap-1"><i data-lucide="bar-chart-2" class="w-3.5 h-3.5"></i>热榜对比结果</span>
      <button class="btn btn-ghost py-0.5 px-1.5 text-[10px]" data-action="reanalyzeKbEntry"><i data-lucide="refresh-cw" class="w-3 h-3"></i>重新分析</button>
    </div>
    <div class="space-y-2">${result.topMatches.map(m => `
      <div class="glass rounded-lg p-3">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1">
            <div class="text-sm font-medium">${esc(m.trendTitle)}</div>
            <div class="flex items-center gap-2 mt-1">
              <span class="text-[10px] ${dirColor[m.trendDirection] || 'text-gray-400'}"><i data-lucide="${dirIcon[m.trendDirection] || 'minus'}" class="w-3 h-3 inline"></i>${m.trendDirection}</span>
              <span class="text-[10px] text-purple-400">关联度 ${m.relevanceScore}</span>
              <span class="text-[10px] text-gray-500">${esc(m.platform || '多平台')}</span>
            </div>
            <div class="text-[11px] text-gray-400 mt-1.5">${esc(m.matchReason)}</div>
          </div>
        </div>
      </div>`).join('')}</div>
    ${result.extractedKeywords?.length ? `<div class="mt-3 pt-3 border-t border-white/10"><div class="text-[10px] text-gray-500 mb-1.5">文章热词</div><div class="flex flex-wrap gap-1">${result.extractedKeywords.map(k => `<span class="tag">${esc(k)}</span>`).join('')}</div></div>` : ''}
    ${result.suggestedAngle ? `<div class="mt-3 pt-3 border-t border-white/10"><div class="text-[10px] text-gray-500 mb-1">切入角度</div><div class="text-xs text-gray-300">${esc(result.suggestedAngle)}</div></div>` : ''}
    ${result.platformSuggestion ? `<div class="mt-2 flex items-center gap-2 text-[11px] text-gray-400"><i data-lucide="target" class="w-3 h-3"></i>发布平台：${esc(result.platformSuggestion)}</div>` : ''}`;
  initIcons(section);
}

export async function reanalyzeKbEntry() {
  const entryKey = window._activeKbEntry?.entry_key;
  const sourceType = window._activeKbSource || currentKbSource;
  if (!entryKey) return;
  try {
    const result = await localApi('kb/entries/analyze', {
      method: 'POST',
      body: { entryKey, sourceType, force: true },
    });
    showKbAnalysisResult(result, entryKey, sourceType);
  } catch (error) {
    toast('重新分析失败：' + error.message, 'error');
  }
}

export async function matchKbToInspirations(btn) {
  const entry = window._activeKbEntry;
  if (!entry) return;
  const entryKey = entry.entry_key;
  const title = entry.title || '';
  const tags = (entry.tags || []).join(',');
  const section = document.getElementById('kb-entry-match-section');
  document.getElementById('kb-entry-side-empty')?.classList.add('hidden');
  document.getElementById('kb-entry-analysis-section')?.classList.add('hidden');
  if (section.classList.contains('hidden')) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>匹配中…';
    initIcons(btn);
    section.classList.remove('hidden');
    section.innerHTML = '<div class="text-xs text-gray-500 py-2">正在分析…</div>';
    try {
      const inspirations = await localApi('inspirations');
      const allText = ((title || '') + ' ' + (tags || '').replace(/,/g, ' ')).toLowerCase();
      const scored = inspirations.map(insp => {
        const keywords = insp.sourceKeywords || [];
        const matched = keywords.filter(k => allText.includes(k.toLowerCase())).length;
        const titleMatch = insp.title?.toLowerCase().includes(title?.toLowerCase());
        const score = matched * 2 + (titleMatch ? 3 : 0);
        return { ...insp, matchScore: score, matchedKeywords: matched };
      }).filter(x => x.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore).slice(0, 6);
      if (!scored.length) {
        section.innerHTML = '<div class="text-xs text-gray-500 py-2">未找到匹配的选题，可先关联再创作</div>';
      } else {
        window._kbMatchedInspirations = scored.map(item => ({
          ...item,
          matchedLabels: (item.sourceKeywords || []).filter(keyword => allText.includes(keyword.toLowerCase())),
        }));
        renderMatchedInspirations(window._kbMatchedInspirations);
      }
    } catch (e) {
      section.innerHTML = '<div class="text-xs text-red-400 py-2">匹配失败：' + esc(e.message) + '</div>';
    }
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="sparkles" class="w-3.5 h-3.5"></i>匹配选题';
    initIcons(section);
  } else {
    section.classList.add('hidden');
    section.innerHTML = '';
    document.getElementById('kb-entry-side-empty')?.classList.remove('hidden');
  }
}

export function renderMatchedInspirations(inspirations) {
  const section = document.getElementById('kb-entry-match-section');
  const entryKey = window._activeKbEntry?.entry_key;
  if (!section) return;
  section.innerHTML = `
    <div class="text-xs font-medium mb-3">匹配选题</div>
    <div class="space-y-2">${inspirations.map((item, index) => {
      const linked = item.kbLink?.entry_key === entryKey;
      return `
        <button class="glass rounded-lg p-3 cursor-pointer hover:border-brand text-left w-full ${linked ? 'border-emerald-500/40' : ''}" data-action="linkKbMatchByIndex" data-index="${index}">
          <div class="flex items-start justify-between gap-2">
            <div class="text-sm font-medium">${esc(item.title)}</div>
            ${linked ? '<span class="pill pill-green flex-shrink-0">已关联</span>' : ''}
          </div>
          <div class="flex items-center gap-2 mt-1 flex-wrap">
            <span class="text-[10px] text-purple-400">匹配度 ${item.matchScore}</span>
            <span class="text-[10px] text-gray-500">${item.matchedKeywords} 个关键词</span>
            ${item.matchedLabels?.length ? `<span class="text-[10px] text-emerald-400">${esc(item.matchedLabels.join(', '))}</span>` : ''}
          </div>
        </button>`;
    }).join('')}</div>`;
  initIcons(document.getElementById('kb-entry-match-section'));
}

export async function linkKbMatchByIndex(index) {
  const inspiration = window._kbMatchedInspirations?.[index];
  const entry = window._activeKbEntry;
  if (!inspiration || !entry) return;
  try {
    await localApi('kb/entries/link', {
      method: 'POST',
      body: {
        inspirationId: inspiration.id,
        entryKey: entry.entry_key,
        sourceType: window._activeKbSource || currentKbSource,
      },
    });
    toast('已关联到选题', 'success');
    inspiration.kbLink = { entry_key: entry.entry_key };
    renderMatchedInspirations(window._kbMatchedInspirations);
  } catch (e) {
    toast('关联失败：' + e.message, 'error');
  }
}

export function openKbConfigModal(preferredSource) {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">知识库配置</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <form id="kb-config-form" class="space-y-3">
        <div>
          <label class="text-xs text-gray-400 mb-1 block">来源类型</label>
          <select class="input" id="kb-cfg-type">
            <option value="obsidian">Obsidian 本地</option>
            <option value="notion">Notion API</option>
          </select>
        </div>
        <div id="kb-cfg-obsidian">
          <label class="text-xs text-gray-400 mb-1 block">Vault 路径</label>
          <input class="input" id="kb-cfg-path" placeholder="/home/user/Obsidian Vault" />
        </div>
        <div id="kb-cfg-notion" class="hidden">
          <label class="text-xs text-gray-400 mb-1 block">Notion API Key</label>
          <input class="input" id="kb-cfg-notion-key" type="password" autocomplete="new-password" placeholder="secret_..." />
          <label class="text-xs text-gray-400 mb-1 block mt-2">Database ID</label>
          <input class="input" id="kb-cfg-notion-db" placeholder="数据库 ID" />
        </div>
        <button type="submit" class="btn btn-primary w-full mt-2" data-action="saveKbConfig">保存配置</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#kb-config-form')?.addEventListener('submit', event => {
    event.preventDefault();
    saveKbConfig();
  });
  initIcons(modal);

  document.getElementById('kb-cfg-type').onchange = () => {
    const t = document.getElementById('kb-cfg-type').value;
    document.getElementById('kb-cfg-obsidian').classList.toggle('hidden', t !== 'obsidian');
    document.getElementById('kb-cfg-notion').classList.toggle('hidden', t !== 'notion');
  };

  localApi('kb/config').then(cfg => {
    if (!modal.isConnected) return;
    if (cfg.sourceType || preferredSource) {
      document.getElementById('kb-cfg-type').value = preferredSource || cfg.sourceType;
      document.getElementById('kb-cfg-type').onchange();
      document.getElementById('kb-cfg-path').value = cfg.sourcePath || '';
      document.getElementById('kb-cfg-notion-db').value = cfg.notionDatabaseId || '';
      if (cfg.notionConfigured) {
        document.getElementById('kb-cfg-notion-key').placeholder = '已配置，留空保持不变';
      }
    }
  });
}

export async function saveKbConfig() {
  const sourceType = document.getElementById('kb-cfg-type').value;
  const sourcePath = document.getElementById('kb-cfg-path').value.trim();
  const notionApiKey = document.getElementById('kb-cfg-notion-key').value.trim();
  const notionDbId = document.getElementById('kb-cfg-notion-db').value.trim();
  try {
    await localApi('kb/config', {
      method: 'POST',
      body: { sourceType, sourcePath, notionApiKey, notionDatabaseId: notionDbId },
    });
    toast('配置已保存', 'success');
    document.querySelector('.modal-mask')?.remove();
    await renderKnowledgebase();
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

export function createKbEntry() {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">新建条目</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="space-y-3">
        <div>
          <label class="text-xs text-gray-400 mb-1 block">标题</label>
          <input class="input" id="kb-new-title" placeholder="输入标题…" />
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">标签（逗号分隔）</label>
          <input class="input" id="kb-new-tags" placeholder="AI, 教程" />
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">文件夹</label>
          <input class="input" id="kb-new-folder" placeholder="留空则放在根目录" />
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">内容</label>
          <textarea class="input" id="kb-new-content" rows="8" placeholder="输入正文内容…"></textarea>
        </div>
        <button class="btn btn-primary w-full" data-action="submitKbEntry">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  initIcons(modal);
  document.getElementById('kb-new-title').focus();
  window._kbNewModal = modal;
}

export async function submitKbEntry() {
  const title = document.getElementById('kb-new-title').value.trim();
  const tagsStr = document.getElementById('kb-new-tags').value.trim();
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  const folder = document.getElementById('kb-new-folder').value.trim();
  const content = document.getElementById('kb-new-content').value;
  if (!title) { toast('标题不能为空', 'error'); return; }
  try {
    await localApi('kb/entries', { method: 'POST', body: { title, tags, folder, content } });
    toast('条目已创建', 'success');
    window._kbNewModal?.remove();
    await loadKbEntries();
  } catch (e) {
    toast('创建失败: ' + e.message, 'error');
  }
}

export async function linkKbToInspiration() {
  const entry = window._activeKbEntry;
  if (!entry) return;
  const section = document.getElementById('kb-entry-match-section');
  document.getElementById('kb-entry-side-empty')?.classList.add('hidden');
  document.getElementById('kb-entry-analysis-section')?.classList.add('hidden');
  section.classList.remove('hidden');
  section.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">正在加载选题…</div>';
  try {
    const inspirations = await localApi('inspirations');
    if (!inspirations.length) {
      section.innerHTML = '<div class="text-xs text-gray-500 py-4 text-center">暂无选题可关联</div>';
      return;
    }
    window._kbPickerInspirations = inspirations;
    section.innerHTML = `
      <div class="text-xs font-medium mb-3">选择要关联的选题</div>
      <div class="space-y-2">${inspirations.map((item, index) => {
        const linked = item.kbLink?.entry_key === entry.entry_key;
        return `
          <button class="glass rounded-lg p-3 cursor-pointer hover:border-brand text-left w-full ${linked ? 'border-emerald-500/40' : ''}" data-action="linkKbPickerByIndex" data-index="${index}">
            <div class="flex items-start justify-between gap-2">
              <div class="text-sm font-medium">${esc(item.title)}</div>
              ${linked ? '<span class="pill pill-green flex-shrink-0">已关联</span>' : ''}
            </div>
            <div class="text-xs text-gray-500 mt-1">${esc(item.summary?.slice(0, 80) || '')}</div>
          </button>`;
      }).join('')}</div>`;
    initIcons(section);
  } catch (e) {
    section.innerHTML = `<div class="text-xs text-red-400 py-3">加载选题失败：${esc(e.message)}</div>`;
  }
}

export async function linkKbPickerByIndex(index) {
  const inspiration = window._kbPickerInspirations?.[index];
  const entry = window._activeKbEntry;
  if (!inspiration || !entry) return;
  try {
    await localApi('kb/entries/link', {
      method: 'POST',
      body: {
        inspirationId: inspiration.id,
        entryKey: entry.entry_key,
        sourceType: window._activeKbSource || currentKbSource,
      },
    });
    toast('已关联到选题', 'success');
    inspiration.kbLink = { entry_key: entry.entry_key };
    linkKbToInspiration();
  } catch (e) {
    toast('关联失败: ' + e.message, 'error');
  }
}

export function sendKbToCreator(entry) {
  LS.set('creatorSource', {
    plat: 'kb',
    title: entry.title,
    summary: entry.content || entry.content_preview || '',
    tags: entry.tags,
    savedAt: new Date().toLocaleString('zh-CN'),
  });
  toast('已发送到创作助手', 'success');
  gotoPage('creator');
}

export function renderLibrary() { renderKnowledgebase(); }

export function addToLibrary(item) {
  const lib = LS.get('library', []);
  if (lib.some(x => x.plat === item.plat && x.workId === item.workId)) {
    toast('已在收藏中', 'error');
    return;
  }
  lib.unshift({
    plat: item.plat,
    workId: item.workId,
    title: item.title,
    author: item.author,
    authorFans: item.authorFans,
    like: item.like,
    read: item.read,
    collect: item.collect,
    cover: item.cover,
    url: item.url,
    summary: item.summary,
    tags: item.tags,
    savedAt: new Date().toLocaleString('zh-CN'),
  });
  LS.set('library', lib.slice(0, 200));
  toast('已收藏', 'success');
  if (currentPage === 'knowledgebase' || currentPage === 'library') renderKnowledgebase();
}

export function removeFromLibrary(plat, workId) {
  const lib = LS.get('library', []).filter(x => !(x.plat === plat && x.workId === workId));
  LS.set('library', lib);
  toast('已移除', 'success');
  if (currentPage === 'knowledgebase' || currentPage === 'library') renderKnowledgebase();
}

export function exportLibrary(format) {
  const lib = LS.get('library', []);
  if (!lib.length && !kbEntries.length) { toast('知识库是空的', 'error'); return; }
  if (format === 'json') {
    const content = JSON.stringify({ kb: kbEntries, library: lib }, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `kb-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('已导出', 'success');
  } else {
    const libMd = lib.map((it, i) => `## ${i+1}. ${it.title}\n- **平台**: ${platName(it.plat) || '知识库'}\n- **作者**: ${it.author || '—'}\n- **摘要**: ${it.summary || '—'}\n- **收藏时间**: ${it.savedAt || ''}\n`).join('\n');
    const kbIds = kbEntries.map(e => e.entry_key);
    if (kbIds.length) {
      const params = new URLSearchParams({ format: 'md' });
      kbIds.forEach(id => params.append('id', id));
      localApi('kb/export?' + params.toString()).then(kbData => {
        const kbMd = '\n\n---\n\n# 知识库\n\n' + kbData;
        const final = '# 知识库导出\n\n---\n\n# 收藏\n\n' + libMd + kbMd;
        const blob = new Blob([final], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `kb-${Date.now()}.md`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('已导出', 'success');
      }).catch(() => {
        const blob = new Blob([libMd], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `kb-${Date.now()}.md`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('已导出收藏', 'success');
      });
    } else {
      const blob = new Blob([libMd], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `kb-${Date.now()}.md`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('已导出', 'success');
    }
  }
}

// ============ WeRss 公众号 ============
let currentWersssMp = ''; // 空 = 显示全部
let currentWersssQuery = ''; // 搜索关键词
let wersssSearchTimer = null;
let wersssBodyScrollStyle = ''; // 保存打开弹窗前的 body overflow
let wersssQrTimer = null;

export async function renderWersss() {
  try {
    const status = await localApi('wersss/status');
    if (status.configured && status.enabled && (!status.wxAuthorized || status.tokenExpired)) {
      await showWersssQrModal(status);
      return;
    }
  } catch (e) {
    console.warn('检查 WeRss 状态失败:', e.message);
  }
  await Promise.all([loadWersssStatus(), loadWersssSubs(), loadWersssArticles()]);
  bindWersssSearch();
}

// 强制弹出扫码授权窗口（"重新授权"按钮调用）
export async function forceWersssQr() {
  try {
    const status = await localApi('wersss/status');
    await showWersssQrModal(status);
  } catch (e) {
    console.warn('打开 WeRss 扫码失败:', e.message);
  }
}

async function showWersssQrModal(status) {
  const existing = document.getElementById('wersss-qr-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'wersss-qr-modal';
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal" style="max-width:380px">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">WeRss 授权已过期</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeWersssQrModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <p class="text-xs text-gray-400 mb-4">${esc(status.message || '请使用微信扫描下方二维码重新授权')}</p>
      <div class="flex justify-center mb-4">
        <div class="text-sm text-gray-500" id="wersss-qr-img-placeholder">加载中…</div>
      </div>
      <div class="text-center text-xs text-gray-500 mb-4" id="wersss-qr-status-text">等待扫码…</div>
      <div class="flex justify-center gap-2">
        <button class="btn btn-primary" data-action="refreshWersssQr">刷新二维码</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  initIcons(modal);
  startWersssQrPolling();
  // 触发一次 QR 生成并显示（只在此处调用，不要在轮询里重复调）
  await refreshWersssQr();
}

export function closeWersssQrModal() {
  if (wersssQrTimer) { clearInterval(wersssQrTimer); wersssQrTimer = null; }
  document.getElementById('wersss-qr-modal')?.remove();
}

export async function refreshWersssQr() {
  try {
    const { data, error } = await localApi('wersss/qr/start', { method: 'POST' });
    if (error) throw new Error(error);
    // 用同域代理 URL，避免跨域 Opaque Response Blocking
    const imgSrc = '/api/_/wersss/qr/proxy';
    const placeholder = document.getElementById('wersss-qr-img-placeholder');
    const existingImg = document.querySelector('#wersss-qr-modal img');
    if (existingImg) {
      existingImg.src = imgSrc;
    } else if (placeholder) {
      const img = document.createElement('img');
      img.src = imgSrc;
      img.alt = 'WeRss 授权二维码';
      img.className = 'rounded-lg border border-white/10';
      img.style = 'max-width:280px';
      placeholder.replaceWith(img);
    }
  } catch (e) {
    const placeholder = document.getElementById('wersss-qr-img-placeholder');
    if (placeholder) placeholder.textContent = '二维码加载失败，请刷新';
  }
}

function startWersssQrPolling() {
  if (wersssQrTimer) clearInterval(wersssQrTimer);
  wersssQrTimer = setInterval(async () => {
    try {
      const { data: status, error } = await localApi('wersss/status');
      if (error || !status) return;
      const statusText = document.getElementById('wersss-qr-status-text');
      if (!status.wxAuthorized) {
        if (statusText) statusText.textContent = '等待扫码…';
        return;
      }
      if (statusText) statusText.textContent = '授权成功，即将刷新…';
      setTimeout(() => { closeWersssQrModal(); renderWersss(); }, 1000);
    } catch (e) { /* ignore */ }
  }, 3000);
}

function bindWersssSearch() {
  const input = document.getElementById('wersss-search-input');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = '1';
  input.addEventListener('input', () => {
    clearTimeout(wersssSearchTimer);
    wersssSearchTimer = setTimeout(() => {
      currentWersssQuery = input.value.trim();
      loadWersssArticles();
    }, 350);
  });
}

async function loadWersssStatus() {
  const dot = document.getElementById('wersss-status-dot');
  const text = document.getElementById('wersss-status-text');
  if (!dot || !text) return;
  try {
    const cfg = await localApi('wersss/config');
    if (!cfg.configured) {
      dot.className = 'inline-block w-2 h-2 rounded-full bg-gray-500 mr-1.5';
      text.textContent = '未配置';
      return;
    } else if (!cfg.enabled) {
      dot.className = 'inline-block w-2 h-2 rounded-full bg-amber-400 mr-1.5';
      text.textContent = `已停用 · ${cfg.baseUrl}`;
      return;
    }
    // 也拿 status 看 token 是否过期
    const status = await localApi('wersss/status');
    if (status.tokenExpired) {
      dot.className = 'inline-block w-2 h-2 rounded-full bg-red-400 mr-1.5';
      const exp = status.tokenExpiresAt ? new Date(status.tokenExpiresAt).toLocaleString('zh-CN') : '';
      text.textContent = `Token 已过期 ${exp ? '· ' + exp : ''}`;
    } else {
      dot.className = 'inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1.5';
      text.textContent = `${cfg.username} @ ${cfg.baseUrl}`;
    }
  } catch (e) {
    text.textContent = '读取配置失败';
  }
}

async function loadWersssSubs() {
  const host = document.getElementById('wersss-subs');
  if (!host) return;
  try {
    const subs = await localApi('wersss/subscriptions');
    const allActive = !currentWersssMp;
    let html = `
      <button class="w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between transition ${allActive ? 'bg-purple-500/15 text-purple-300' : 'hover:bg-white/[0.04] text-gray-300'}" data-action="selectWersssMp" data-mp-id="">
        <span class="flex items-center gap-2"><i data-lucide="layers" class="w-3.5 h-3.5"></i>全部</span>
      </button>`;
    html += subs.map(s => {
      const active = currentWersssMp === s.mpId;
      return `
        <div class="group flex items-center gap-1 px-3 py-2 rounded-lg text-sm cursor-pointer transition ${active ? 'bg-purple-500/15 text-purple-300' : 'hover:bg-white/[0.04] text-gray-300'}" data-action="selectWersssMp" data-mp-id="${esc(s.mpId)}">
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <div class="w-5 h-5 rounded-full ${mpAvatarColor(s.mpName, s.mpId)} flex items-center justify-center flex-shrink-0 overflow-hidden relative">
              <i data-lucide="user" class="w-3 h-3 text-white"></i>
              ${s.avatar ? `<img src="${proxyImage(s.avatar)}" class="absolute inset-0 w-full h-full object-cover" alt="" data-image-error="remove">` : ''}
            </div>
            <span class="truncate">${esc(s.mpName)}</span>
          </div>
          <button class="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 flex-shrink-0" data-action="removeWersssSub" data-mp-id="${esc(s.mpId)}" title="取消订阅"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
        </div>`;
    }).join('');
    if (!subs.length) {
      html += '<div class="px-3 py-2 text-xs text-gray-500">还没有订阅，点击"添加订阅"</div>';
    }
    host.innerHTML = html;
    initIcons(host);
  } catch (e) {
    host.innerHTML = `<div class="px-3 py-2 text-xs text-red-400">加载失败：${esc(e.message)}</div>`;
  }
}

export async function selectWersssMp(el, d) {
  currentWersssMp = d.mpId || '';
  await Promise.all([loadWersssSubs(), loadWersssArticles()]);
}

async function loadWersssArticles() {
  const host = document.getElementById('wersss-articles');
  const titleEl = document.getElementById('wersss-articles-title');
  if (!host) return;
  host.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">加载中…</div>';
  try {
    let articles;
    if (currentWersssQuery) {
      const q = encodeURIComponent(currentWersssQuery);
      const mpParam = currentWersssMp ? `&mp_id=${encodeURIComponent(currentWersssMp)}` : '';
      articles = await localApi(`wersss/search-local?q=${q}${mpParam}&limit=30`);
    } else {
      const query = currentWersssMp
        ? `wersss/articles?mp_id=${encodeURIComponent(currentWersssMp)}&limit=50`
        : 'wersss/articles?limit=50';
      articles = await localApi(query);
    }
    if (titleEl) {
      let label;
      if (currentWersssQuery) {
        label = `搜索 "${currentWersssQuery}" · ${articles.length} 篇`;
      } else if (currentWersssMp) {
        const sub = (await localApi('wersss/subscriptions')).find(s => s.mpId === currentWersssMp);
        label = sub ? `${sub.mpName} · ${articles.length} 篇` : `${articles.length} 篇`;
      } else {
        label = `全部 · ${articles.length} 篇`;
      }
      titleEl.textContent = label;
    }
    if (!articles.length) {
      host.innerHTML = currentWersssQuery
        ? '<div class="text-xs text-gray-500 text-center py-8">未匹配到文章</div>'
        : '<div class="text-xs text-gray-500 text-center py-8">还没有同步的文章，点击"立即同步"</div>';
      return;
    }
    host.innerHTML = articles.map(a => {
      const date = a.publishTime ? new Date(a.publishTime).toLocaleDateString('zh-CN') : '';
      return `
        <div class="glass rounded-lg p-3 cursor-pointer hover:bg-white/[0.04] transition" data-action="openWersssArticle" data-id="${esc(a.id)}">
          <div class="flex items-start gap-3">
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium line-clamp-2">${esc(a.title)}</div>
              <div class="text-[11px] text-gray-500 mt-1">
                ${currentWersssMp ? '' : `<span class="text-purple-300">${esc(a.mpName || a.mpId)}</span> · `}
                ${date}
              </div>
              ${a.summary ? `<div class="text-xs text-gray-400 mt-1 line-clamp-2">${esc(a.summary)}</div>` : ''}
            </div>
            ${a.cover ? `<img src="${esc(a.cover)}" class="w-16 h-12 object-cover rounded flex-shrink-0" alt="" data-image-error="remove">` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = `<div class="text-xs text-red-400 text-center py-4">加载失败：${esc(e.message)}</div>`;
  }
}

export async function prefetchWersss() {
  if (!confirm('批量抓取所有文章的正文（用于全文搜索）。60 篇约需 30-60 秒，确认开始？')) return;
  toast('开始抓取正文…', 'info');
  try {
    const result = await localApi('wersss/prefetch', { method: 'POST' });
    if (result.total === 0) {
      toast('所有文章已有正文，无需抓取', 'success');
    } else {
      toast(`完成：${result.done}/${result.total} 篇${result.failed ? `，失败 ${result.failed}` : ''}`, result.failed ? 'info' : 'success');
    }
  } catch (e) { toast(e.message, 'error'); }
}

export async function openWersssConfig() {
  let cfg = { configured: false, baseUrl: '', username: '' };
  try { cfg = { ...cfg, ...(await localApi('wersss/config')) }; } catch {}
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" style="max-width:520px">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-bold">配置 WeRss 接入</h2>
      <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="space-y-3">
      <p class="text-[11px] text-gray-500">填写已部署的 we-mp-rss 服务地址和账号密码。保存时会自动测试登录。</p>
      <label class="block">
        <span class="text-xs text-gray-400">Base URL</span>
        <input class="input mt-1" id="wersss-base-url" placeholder="http://127.0.0.1:18001" value="${esc(cfg.baseUrl || '')}">
      </label>
      <label class="block">
        <span class="text-xs text-gray-400">用户名</span>
        <input class="input mt-1" id="wersss-username" value="${esc(cfg.username || '')}">
      </label>
      <label class="block">
        <span class="text-xs text-gray-400">密码 ${cfg.configured ? '（留空表示不修改）' : ''}</span>
        <input class="input mt-1" id="wersss-password" type="password" autocomplete="new-password" placeholder="${cfg.configured ? '••••••' : ''}">
      </label>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button class="btn btn-ghost py-1.5" data-action="closeModal">取消</button>
      <button class="btn btn-primary py-1.5" data-action="saveWersssConfig">保存</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
}

export async function saveWersssConfig() {
  try {
    const baseUrl = document.getElementById('wersss-base-url').value.trim();
    const username = document.getElementById('wersss-username').value.trim();
    const password = document.getElementById('wersss-password').value;
    if (!baseUrl || !username) { toast('Base URL 和用户名必填', 'error'); return; }
    await localApi('wersss/config', { method: 'POST', body: { baseUrl, username, password, enabled: true } });
    toast('已保存并验证通过', 'success');
    document.querySelector('.modal-mask')?.remove();
    renderWersss();
  } catch (e) { toast(e.message, 'error'); }
}

export async function addWersssSub() {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" style="max-width:640px">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-bold">添加订阅</h2>
      <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <p class="text-[11px] text-gray-500 mb-3">从 we-mp-rss 已订阅的公众号里勾选要同步的。新公众号请先在 we-mp-rss 后台添加。</p>
    <div class="flex gap-2 mb-3">
      <input class="input flex-1" id="wersss-search-kw" placeholder="（可选）按名称过滤">
      <button class="btn btn-ghost py-1.5" data-action="loadWersssAvailable">刷新</button>
    </div>
    <div id="wersss-search-results" class="space-y-2 max-h-[60vh] overflow-y-auto scrollbar-thin">
      <div class="text-xs text-gray-500 text-center py-4">加载中…</div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
  loadWersssAvailable();
}

export async function loadWersssAvailable() {
  const results = document.getElementById('wersss-search-results');
  if (!results) return;
  results.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">加载中…</div>';
  try {
    const list = await localApi('wersss/subscriptions/available');
    if (!list.length) {
      results.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">we-mp-rss 上还没有订阅任何公众号</div>';
      return;
    }
    results.innerHTML = list.map(mp => `
      <div class="flex items-center gap-3 p-3 bg-white/[0.02] rounded-lg ${mp.alreadySubscribed ? 'opacity-50' : ''}">
        <div class="w-10 h-10 rounded-full ${mpAvatarColor(mp.mpName, mp.mpId)} flex items-center justify-center flex-shrink-0 overflow-hidden relative">
          <i data-lucide="user" class="w-5 h-5 text-white"></i>
          ${mp.avatar ? `<img src="${proxyImage(mp.avatar)}" class="absolute inset-0 w-full h-full object-cover" alt="" data-image-error="remove">` : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">${esc(mp.mpName)}</div>
          <div class="text-[11px] text-gray-500 truncate">${esc(mp.mpAlias || mp.mpIntro || '')}</div>
        </div>
        ${mp.alreadySubscribed
          ? '<span class="text-[11px] text-emerald-400">已订阅</span>'
          : `<button class="btn btn-ghost py-1 px-2 text-xs" data-action="confirmAddWersssSub"
              data-mp-id="${esc(mp.mpId)}" data-mp-name="${esc(mp.mpName)}"
              data-mp-alias="${esc(mp.mpAlias || '')}" data-avatar="${esc(mp.avatar || '')}">添加</button>`}
      </div>`).join('');
    initIcons(results);
  } catch (e) {
    results.innerHTML = `<div class="text-xs text-red-400 text-center py-4">${esc(e.message)}</div>`;
  }
}

export async function searchWersssMp() {
  const kw = document.getElementById('wersss-search-kw').value.trim();
  const results = document.getElementById('wersss-search-results');
  if (!kw) { toast('请输入关键词', 'error'); return; }
  results.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">搜索中…</div>';
  try {
    const list = await localApi(`wersss/search?kw=${encodeURIComponent(kw)}`);
    if (!list.length) {
      results.innerHTML = '<div class="text-xs text-gray-500 text-center py-4">未找到匹配的公众号</div>';
      return;
    }
    results.innerHTML = list.map(mp => `
      <div class="flex items-center gap-3 p-3 bg-white/[0.02] rounded-lg">
        <div class="w-10 h-10 rounded-full ${mpAvatarColor(mp.mpName, mp.mpId)} flex items-center justify-center flex-shrink-0 overflow-hidden relative">
          <i data-lucide="user" class="w-5 h-5 text-white"></i>
          ${mp.avatar ? `<img src="${proxyImage(mp.avatar)}" class="absolute inset-0 w-full h-full object-cover" alt="" data-image-error="remove">` : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium">${esc(mp.mpName)}</div>
          <div class="text-[11px] text-gray-500">${esc(mp.mpAlias || mp.mpIntro || '')}</div>
        </div>
        <button class="btn btn-ghost py-1 px-2 text-xs" data-action="confirmAddWersssSub"
          data-mp-id="${esc(mp.mpId)}" data-mp-name="${esc(mp.mpName)}"
          data-mp-alias="${esc(mp.mpAlias || '')}" data-avatar="${esc(mp.avatar || '')}">添加</button>
      </div>`).join('');
    initIcons(results);
  } catch (e) {
    results.innerHTML = `<div class="text-xs text-red-400 text-center py-4">${esc(e.message)}</div>`;
  }
}

export async function confirmAddWersssSub(el, d) {
  try {
    await localApi('wersss/subscriptions', { method: 'POST', body: {
      mpId: d.mpId, mpName: d.mpName, mpAlias: d.mpAlias, avatar: d.avatar,
    } });
    toast(`已订阅 ${d.mpName}`, 'success');
    document.querySelector('.modal-mask')?.remove();
    loadWersssSubs();
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeWersssSub(el, d) {
  if (!confirm(`取消订阅 ${d.mpId}？相关文章会一并删除。`)) return;
  try {
    await localApi(`wersss/subscriptions/${encodeURIComponent(d.mpId)}`, { method: 'DELETE' });
    toast('已取消', 'success');
    loadWersssSubs();
    loadWersssArticles();
  } catch (e) { toast(e.message, 'error'); }
}

export async function syncWersss(el, d) {
  try {
    toast('同步中…', 'info');
    const result = await localApi('wersss/sync', { method: 'POST' });
    toast(`同步完成：${result.perMp?.length || 0} 个公众号，新增 ${result.articles} 篇`, 'success');
    loadWersssArticles();
  } catch (e) { toast(e.message, 'error'); }
}

export async function openWersssArticle(el, d) {
  // 先开弹窗显示标题和 loading，再异步拉正文
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  wersssBodyScrollStyle = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  modal.innerHTML = `<div class="modal flex flex-col" style="max-width:760px;max-height:90vh">
    <div class="flex items-center justify-between mb-4 flex-shrink-0">
      <div class="flex-1 min-w-0 pr-3">
        <h2 class="text-lg font-bold" id="wersss-art-title">加载中…</h2>
        <div class="text-[11px] text-gray-500 mt-1" id="wersss-art-meta"></div>
      </div>
      <button class="btn btn-ghost py-1 px-2 flex-shrink-0" data-action="closeWersssArticleModal"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div id="wersss-art-body" class="flex-1 min-h-0 overflow-y-auto overscroll-contain text-sm text-gray-300 py-4 px-1">
      <div class="text-center py-8 text-gray-500">
        <i data-lucide="loader-circle" class="w-5 h-5 animate-spin inline-block"></i>
        <div class="mt-2 text-xs">首次查看需要从 we-mp-rss 拉取正文…</div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
  let article = null;
  try { article = await localApi(`wersss/articles/${encodeURIComponent(d.id)}`); }
  catch (e) {
    const body = document.getElementById('wersss-art-body');
    if (body) body.innerHTML = `<div class="text-red-400 text-center">${esc(e.message)}</div>`;
    return;
  }
  if (!article) return;
  const titleEl = document.getElementById('wersss-art-title');
  const metaEl = document.getElementById('wersss-art-meta');
  const body = document.getElementById('wersss-art-body');
  if (titleEl) titleEl.textContent = article.title || '(无标题)';
  if (metaEl) metaEl.textContent = `${article.mpName || article.mpId || ''} · ${article.publishTime ? new Date(article.publishTime).toLocaleString('zh-CN') : ''}`;
  if (body) {
    body.className = 'flex-1 min-h-0 overflow-y-auto overscroll-contain text-sm text-gray-300 py-4 px-1';
    if (article.content) {
      body.innerHTML = `<article class="wechat-article">${renderWechatArticle(article.content)}</article>`;
    } else if (article.summary) {
      body.innerHTML = `<article class="wechat-article"><div class="text-gray-400">${esc(article.summary)}</div></article>`;
    } else {
      body.innerHTML = '<p class="text-gray-500">无正文</p>';
    }
    // 在正文底部追加原文链接
    if (article.url) {
      body.insertAdjacentHTML('beforeend', `<div class="mt-6 pt-4 border-t border-white/10 text-xs"><a href="${esc(article.url)}" target="_blank" rel="noopener" class="text-purple-300 hover:underline">查看原文 →</a></div>`);
    }
  }
}

export function closeWersssArticleModal(el) {
  document.body.style.overflow = wersssBodyScrollStyle;
  el.closest('.modal-mask')?.remove();
}
