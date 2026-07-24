import { localApi } from '../api.js';
import { LS } from '../state.js';
import { esc } from '../utils.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';
import { gotoPage } from '../navigation.js';
import { clearHotPlatforms } from './hotlist.js';

let skillCache = [];
let agentSkillCache = [];  // 合并三目录（RedFox + custom + hub），Agent / 补全用
let agentCache = [];
let agentMessages = [];
let agentThreads = [];
let currentAgentThreadId = null;
let currentAgentId = null;
let skillUpdateStatus = null;
const agentRuntimeErrors = new Map();

export function clearSkillCache() {
  skillCache = [];
}

export async function loadSkills(force = false) {
  if (force) skillCache = [];
  if (!skillCache.length) skillCache = await localApi('skills');
  const navCount = document.getElementById('nav-skill-count');
  if (navCount) navCount.textContent = skillCache.length;
  return skillCache;
}

export async function renderSkills() {
  try {
    const skills = await loadSkills();
    document.getElementById('skill-local-count').textContent = `${skills.length} 个已下载`;
    filterSkills();
    checkSkillUpdates(false);
    bindSkillTabs();
    // 默认渲染 custom + template（首屏可能没人切到，但提前渲染避免空白）
    renderCustomSkills().catch(() => {});
    renderSkillTemplates().catch(() => {});
  } catch (e) {
    document.getElementById('skill-grid').innerHTML = `<div class="text-red-400 text-sm">${esc(e.message)}</div>`;
  }
}

let _skillTabBound = false;
export function bindSkillTabs() {
  if (_skillTabBound) return;
  _skillTabBound = true;
  document.querySelectorAll('.skill-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.skillTab;
      document.querySelectorAll('.skill-tab').forEach(b => b.classList.toggle('active', b === btn));
      ['redfox', 'hub', 'custom', 'template'].forEach(t => {
        const pane = document.getElementById(`skill-pane-${t}`);
        if (pane) pane.classList.toggle('hidden', t !== tab);
      });
      if (tab === 'hub') {
        renderHubInstalled().catch(() => {});
        bindHubSearchInput();
      }
      if (tab === 'custom') renderCustomSkills().catch(() => {});
      if (tab === 'template') renderSkillTemplates().catch(() => {});
    });
  });
}

let _hubSearchBound = false;
function bindHubSearchInput() {
  if (_hubSearchBound) return;
  _hubSearchBound = true;
  const input = document.getElementById('hubSearchInput');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); searchHubSkills(); }
    });
  }
}

// ========== 我的 Skill ==========
export async function renderCustomSkills() {
  const grid = document.getElementById('custom-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="col-span-full text-center text-gray-500 py-8 text-sm">加载中…</div>';
  try {
    const skills = await localApi('skills/custom');
    if (!skills.length) {
      grid.innerHTML = `<div class="col-span-full text-center text-gray-500 py-8 text-sm">
        <div class="mb-2">还没有自定义 Skill</div>
        <button class="btn btn-primary py-1.5 text-xs" data-action="newCustomSkill"><i data-lucide="plus" class="w-3.5 h-3.5"></i>新建 Skill</button>
      </div>`;
      initIcons(grid);
      return;
    }
    grid.innerHTML = skills.map(s => `
      <div class="glass rounded-xl p-4 card cursor-pointer" data-action="editCustomSkill" data-slug="${esc(s.slug)}">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="text-sm font-semibold flex-1 truncate">${esc(s.title || s.name)}</div>
          <span class="pill pill-gray !text-[10px] !py-0.5 !px-1.5">${esc(s.slug)}</span>
        </div>
        <div class="text-xs text-gray-400 line-clamp-3 mb-3">${esc(s.description || '(无描述)')}</div>
        <div class="flex gap-1">
          <button class="btn btn-ghost py-1 text-[11px] flex-1" data-action="editCustomSkill" data-slug="${esc(s.slug)}"><i data-lucide="pencil" class="w-3 h-3"></i>编辑</button>
          <button class="btn btn-ghost py-1 text-[11px] text-red-300" data-action="deleteCustomSkill" data-slug="${esc(s.slug)}"><i data-lucide="trash-2" class="w-3 h-3"></i></button>
        </div>
      </div>
    `).join('');
    initIcons(grid);
  } catch (e) {
    grid.innerHTML = `<div class="col-span-full text-red-400 text-sm">${esc(e.message)}</div>`;
  }
}

export async function newCustomSkill(el, d) {
  openCustomSkillEditor(null);
}

export async function editCustomSkill(el, d) {
  openCustomSkillEditor(d.slug);
}

export async function deleteCustomSkill(el, d) {
  if (!confirm(`确定删除 Skill "${d.slug}"？此操作不可撤销。`)) return;
  try {
    await localApi(`skills/custom/${encodeURIComponent(d.slug)}`, { method: 'DELETE' });
    toast('已删除', 'success');
    await renderCustomSkills();
  } catch (e) { toast(e.message, 'error'); }
}

function openCustomSkillEditor(slug) {
  const isNew = !slug;
  const init = isNew
    ? Promise.resolve({ slug: '', name: '', title: '', description: '', content: '# 新 Skill\n\n在这里写工作流和约束。\n' })
    : localApi(`skills/custom/${encodeURIComponent(slug)}`);
  init.then(data => {
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:780px;max-height:88vh;overflow-y:auto">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">${isNew ? '新建 Skill' : `编辑 ${esc(slug)}`}</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs text-gray-400">slug ${isNew ? '<span class="text-red-400">*</span>' : '(不可改)'}</span>
            <input class="input mt-1 text-sm" id="cs-slug" value="${esc(data.slug)}" ${isNew ? '' : 'disabled'}>
            <span class="text-[10px] text-gray-500">2-63 位小写字母/数字/连字符，作为目录名和 Agent /命令</span>
          </label>
          <label class="block">
            <span class="text-xs text-gray-400">name</span>
            <input class="input mt-1 text-sm" id="cs-name" value="${esc(data.name || data.title || '')}">
          </label>
        </div>
        <label class="block">
          <span class="text-xs text-gray-400">description</span>
          <textarea class="input mt-1 text-sm" id="cs-desc" rows="2">${esc(data.description || '')}</textarea>
          <span class="text-[10px] text-gray-500">一行描述，Agent 用它判断何时调用此 Skill</span>
        </label>
        <label class="block">
          <span class="text-xs text-gray-400">SKILL.md 内容</span>
          <textarea class="input mt-1 text-sm font-mono" id="cs-content" rows="16" style="font-family:ui-monospace,Menlo,monospace">${esc(data.content || '')}</textarea>
        </label>
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <button class="btn btn-ghost py-1.5" data-action="closeModal">取消</button>
        <button class="btn btn-primary py-1.5" data-action="saveCustomSkill" data-slug="${esc(slug || '')}">${isNew ? '创建' : '保存'}</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    initIcons(modal);
  }).catch(e => toast(e.message, 'error'));
}

export async function saveCustomSkill(el, d) {
  const slug = document.getElementById('cs-slug').value.trim();
  const name = document.getElementById('cs-name').value.trim();
  const description = document.getElementById('cs-desc').value.trim();
  const content = document.getElementById('cs-content').value;
  try {
    if (d.slug) {
      await localApi(`skills/custom/${encodeURIComponent(d.slug)}`, { method: 'PUT', body: { name, description, content } });
      toast('已保存', 'success');
    } else {
      if (!slug) { toast('slug 必填', 'error'); return; }
      await localApi('skills/custom', { method: 'POST', body: { slug, name, description, content } });
      toast('已创建', 'success');
    }
    document.querySelector('.modal-mask')?.remove();
    await renderCustomSkills();
  } catch (e) { toast(e.message, 'error'); }
}

export async function refreshCustomSkills() {
  await renderCustomSkills();
  toast('已刷新', 'success');
}

// ========== Skill Hub (Anthropic 官方) ==========
// 默认展示已安装；搜索后展示 Anthropic 全部
export async function renderHubInstalled() {
  const grid = document.getElementById('hub-installed-grid');
  if (!grid) return;
  try {
    const installed = await localApi('skills/hub/installed');
    const countEl = document.getElementById('hub-installed-count');
    if (countEl) countEl.textContent = `(${installed.length})`;
    if (!installed.length) {
      grid.innerHTML = '<div class="col-span-full text-center text-gray-500 py-3 text-xs">还没安装任何 Hub Skill，下方搜索框去 Anthropic 找</div>';
      return;
    }
    grid.innerHTML = installed.map(s => `
      <div class="glass rounded-xl p-3 card">
        <div class="flex items-start justify-between gap-2 mb-1">
          <div class="text-sm font-semibold flex-1 truncate">${esc(s.title || s.name || s.slug)}</div>
          <span class="pill pill-green !text-[10px] !py-0 !px-1.5">已装</span>
        </div>
        <div class="text-xs text-gray-400 line-clamp-2 mb-2 min-h-[2.5em]">${esc(s.description || '(无描述)')}</div>
        <button class="btn btn-ghost py-1 text-[11px] w-full text-red-300" data-action="uninstallHubSkill" data-slug="${esc(s.slug)}"><i data-lucide="trash-2" class="w-3 h-3"></i>卸载</button>
      </div>
    `).join('');
    initIcons(grid);
  } catch (e) {
    grid.innerHTML = `<div class="col-span-full text-red-400 text-xs">${esc(e.message)}</div>`;
  }
}

export async function searchHubSkills() {
  const grid = document.getElementById('hub-search-grid');
  if (!grid) return;
  const q = (document.getElementById('hubSearchInput')?.value || '').trim();
  if (!q) {
    grid.innerHTML = '<div class="col-span-full text-center text-gray-500 py-3 text-xs">输入关键词后点搜索</div>';
    return;
  }
  grid.innerHTML = `<div class="col-span-full text-center text-gray-500 py-3 text-xs">搜索 "${esc(q)}" 中…</div>`;
  try {
    const skills = await localApi(`skills/hub?q=${encodeURIComponent(q)}`);
    if (!skills.length) {
      grid.innerHTML = `<div class="col-span-full text-center text-gray-500 py-3 text-xs">无匹配结果</div>`;
      return;
    }
    grid.innerHTML = skills.map(s => `
      <div class="glass rounded-xl p-3 card">
        <div class="flex items-start justify-between gap-2 mb-1">
          <div class="text-sm font-semibold flex-1 truncate">${esc(s.name || s.slug)}</div>
          ${s.installed ? '<span class="pill pill-green !text-[10px] !py-0 !px-1.5">已装</span>' : ''}
        </div>
        <div class="text-xs text-gray-400 line-clamp-3 mb-2 min-h-[3.5em]">${esc(s.description || '(无描述)')}</div>
        ${s.installed
          ? '<button class="btn btn-ghost py-1 text-[11px] w-full" disabled>已安装</button>'
          : `<button class="btn btn-primary py-1 text-[11px] w-full" data-action="installHubSkill" data-slug="${esc(s.slug)}"><i data-lucide="download" class="w-3 h-3"></i>安装</button>`}
      </div>
    `).join('');
    initIcons(grid);
  } catch (e) {
    grid.innerHTML = `<div class="col-span-full text-red-400 text-xs">${esc(e.message)}</div>`;
  }
}

export async function loadHubSkills() {
  await renderHubInstalled();
}

export async function installHubSkill(el, d) {
  const btn = el;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i>安装中…'; initIcons(btn); }
  try {
    const result = await localApi(`skills/hub/${encodeURIComponent(d.slug)}/install`, { method: 'POST', body: {} });
    toast(`已安装 ${result.slug}`, 'success');
    await renderHubInstalled();      // 刷新已装列表
    const q = document.getElementById('hubSearchInput')?.value?.trim();
    if (q) await searchHubSkills();  // 刷新搜索结果（标记已装）
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="download" class="w-3 h-3"></i>安装'; initIcons(btn); }
  }
}

export async function uninstallHubSkill(el, d) {
  if (!confirm(`确定卸载 "${d.slug}"？此操作只移除已安装的 Hub Skill。`)) return;
  try {
    await localApi(`skills/hub/${encodeURIComponent(d.slug)}/uninstall`, { method: 'POST', body: {} });
    toast(`已卸载 ${d.slug}`, 'success');
    await renderHubInstalled();
    const q = document.getElementById('hubSearchInput')?.value?.trim();
    if (q) await searchHubSkills();
  } catch (e) { toast(e.message, 'error'); }
}

// ========== 模板 ==========
export async function renderSkillTemplates() {
  const grid = document.getElementById('template-grid');
  if (!grid) return;
  try {
    const templates = await localApi('skills/templates');
    grid.innerHTML = templates.map(t => `
      <div class="glass rounded-xl p-4 card">
        <div class="text-sm font-semibold mb-1 flex items-center gap-1.5"><i data-lucide="file-text" class="w-3.5 h-3.5 text-amber-400"></i>${esc(t.name)}</div>
        <div class="text-xs text-gray-400 line-clamp-3 mb-3 min-h-[3.5em]">${esc(t.description)}</div>
        <button class="btn btn-ghost py-1 text-[11px] w-full" data-action="generateFromTemplate" data-template="${esc(t.id)}"><i data-lucide="wand-sparkles" class="w-3 h-3"></i>从模板创建</button>
      </div>
    `).join('');
    initIcons(grid);
  } catch (e) {
    grid.innerHTML = `<div class="col-span-full text-red-400 text-sm">${esc(e.message)}</div>`;
  }
}

export async function generateFromTemplate(el, d) {
  const templateId = d.template;
  const slug = prompt(`从模板「${templateId}」创建，请输入新 Skill 的 slug\n（2-63 位小写字母/数字/连字符）：`, `${templateId}-new`);
  if (!slug) return;
  try {
    await localApi('skills/templates/generate', { method: 'POST', body: { templateId, slug, name: slug } });
    toast(`已从模板创建 ${slug}`, 'success');
    // 切到 custom tab
    document.querySelector('.skill-tab[data-skill-tab="custom"]')?.click();
  } catch (e) { toast(e.message, 'error'); }
}

export function filterSkills() {
  const grid = document.getElementById('skill-grid');
  if (!grid) return;
  const keyword = document.getElementById('skillSearch')?.value.trim().toLowerCase() || '';
  const category = document.getElementById('skillCategory')?.value || 'all';
  // 每个 skill 只用一个分类：llmCategory（后端已应用 override），fallback 才用 skill.category
  // 排序：按 title 中文/英文首字母
  const filtered = skillCache.filter(skill => {
    const cat = skill.llmCategory || skill.category || '其他';
    const matchesCategory = category === 'all' || cat === category;
    return matchesCategory && (!keyword || `${skill.title} ${skill.name} ${skill.description}`.toLowerCase().includes(keyword));
  }).sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || '', 'zh-Hans-CN'));
  grid.innerHTML = filtered.map(skill => {
    const cat = skill.llmCategory || skill.category || '其他';
    const catColor = { '热榜': 'pill-hot', '信息源': 'pill-cyan', '创作': 'pill-brand', '分析': 'pill-sky', '检索': 'pill-green', '媒体': 'pill-amber', '综合': 'pill-gray' }[cat] || 'pill-gray';
    const bindable = skill.sourceBinding; // 后端配置了热榜映射即显示绑定按钮，不依赖 LLM 分类
    const bindBtn = bindable
      ? `<button class="btn ${skill.cronEnabled ? 'btn-ghost' : 'btn-primary'} py-1 text-[11px] flex-shrink-0" data-action="bindSkillToSource" data-slug="${esc(skill.slug)}" data-stop-propagation title="${skill.cronEnabled ? '已在热榜中' : '启用对应的定时任务'}">
          <i data-lucide="${skill.cronEnabled ? 'check' : 'plus'}" class="w-3 h-3"></i>${skill.cronEnabled ? '已绑定' : '绑定热榜'}
        </button>`
      : '';
    return `
    <div class="glass rounded-xl p-4 card flex flex-col relative" data-action="openSkillDetail" data-slug="${skill.slug}">
      ${skill.isNew ? '<span class="absolute -top-2 -right-2 pill pill-green shadow-lg">New</span>' : ''}
      <div class="flex items-start justify-between gap-3">
        <div class="font-semibold text-sm">${esc(skill.title)}</div>
        <span class="pill ${catColor} !text-[10px]">${esc(cat)}</span>
      </div>
      <p class="text-xs text-gray-500 mt-2 line-clamp-2 flex-1">${esc(skill.description || '暂无描述')}</p>
      <div class="flex items-center justify-between mt-4 gap-2">
        <code class="text-[10px] text-gray-600 truncate flex-1">${esc(skill.slug)}</code>
        ${bindBtn}
        <button class="btn btn-ghost py-1 text-[11px] flex-shrink-0" data-action="openAgentWithSkill" data-slug="${skill.slug}"><i data-lucide="bot" class="w-3 h-3"></i>Agent</button>
      </div>
    </div>`;
  }).join('') || '<div class="text-sm text-gray-500">没有匹配的 Skill</div>';
  initIcons(document.getElementById('content-area'));
}

export async function bindSkillToSource(el, d) {
  if (!d?.slug) return;
  try {
    const result = await localApi(`skills/${encodeURIComponent(d.slug)}/bind-source`, { method: 'POST' });
    const action = result.enabled ? '绑定' : '解绑';
    toast(`${d.slug} 已${action}热榜（${result.cronId}）`, 'success');
    clearHotPlatforms(); // 清除热榜 tab 缓存，下次进入热榜页面会重新拉取
    await loadSkills(true);
    filterSkills();
  } catch (e) { toast(e.message, 'error'); }
}

export async function reclassifySkills() {
  try {
    const result = await localApi('skills/classify?force=1', { method: 'POST' });
    toast(`已重整 ${result.done}/${result.total} 个 skill 分类（slug 规则 · 毫秒级）`, 'success');
    await loadSkills(true);
    filterSkills();
  } catch (e) { toast(e.message, 'error'); }
}

function renderSkillUpdateStatus() {
  const host = document.getElementById('skill-update-status');
  const button = document.getElementById('skill-update-button');
  if (!host || !button) return;
  if (!skillUpdateStatus) {
    host.textContent = '尚未检查更新';
    button.classList.add('hidden');
    return;
  }
  if (skillUpdateStatus.available) {
    host.textContent = `发现更新：新增 ${skillUpdateStatus.addedSlugs.length}、修改 ${skillUpdateStatus.changedSlugs.length}、删除 ${skillUpdateStatus.removedSlugs.length}`;
    host.className = 'text-[11px] text-amber-300';
    button.classList.remove('hidden');
  } else {
    host.textContent = '已是最新版本';
    host.className = 'text-[11px] text-emerald-300';
    button.classList.add('hidden');
  }
  initIcons(document.getElementById('content-area'));
}

export async function checkSkillUpdates(showToast = true) {
  const host = document.getElementById('skill-update-status');
  if (host) {
    host.textContent = '正在检查 GitHub 更新…';
    host.className = 'text-[11px] text-gray-500';
  }
  try {
    skillUpdateStatus = await localApi('skills/status');
    renderSkillUpdateStatus();
    if (showToast) toast(skillUpdateStatus.available ? '发现 Skill 更新' : 'Skill 已是最新版本', 'success');
    return skillUpdateStatus;
  } catch (e) {
    if (host) {
      host.textContent = '更新检查失败';
      host.className = 'text-[11px] text-red-400';
    }
    if (showToast) toast(e.message, 'error');
    return null;
  }
}

export async function updateCommunitySkillsUi() {
  if (!skillUpdateStatus || !skillUpdateStatus.available) {
    toast('当前没有可应用的更新', 'info');
    return;
  }
  openSkillUpdateModal(skillUpdateStatus);
}

function openSkillUpdateModal(status) {
  // 默认勾选：新增 ✓、修改 ✓、删除 ✗（删除破坏性，需用户主动勾）
  const state = {
    add: new Set(status.addedSlugs || []),
    change: new Set(status.changedSlugs || []),
    remove: new Set(),  // 删除默认不勾
  };
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" style="max-width:680px;max-height:85vh;overflow-y:auto" data-action="stopPropagation">
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-bold flex items-center gap-2"><i data-lucide="git-compare" class="w-5 h-5 text-amber-400"></i>Skill 更新明细</h2>
        <p class="text-[11px] text-gray-500 mt-1">勾选要应用的变更，未勾选的保持本地状态不变。</p>
      </div>
      <button class="modal-close" data-action="closeModal">×</button>
    </div>
    <div id="skill-update-list" class="space-y-3 mb-4"></div>
    <div class="flex items-center justify-between gap-3 pt-3 border-t border-white/10">
      <div class="text-[11px] text-gray-500" id="skill-update-summary"></div>
      <div class="flex gap-2">
        <button class="btn btn-ghost py-1.5 text-xs" data-action="closeModal">取消</button>
        <button class="btn btn-primary py-1.5 text-xs" id="skill-update-apply" disabled><i data-lucide="download" class="w-3.5 h-3.5"></i>应用选中</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);

  const list = modal.querySelector('#skill-update-list');
  const renderList = () => {
    const sections = [
      { key: 'add',    label: '新增', icon: 'plus-circle',  color: 'text-emerald-400', slugs: status.addedSlugs || [] },
      { key: 'change', label: '修改', icon: 'pencil-line',  color: 'text-amber-400',   slugs: status.changedSlugs || [] },
      { key: 'remove', label: '删除', icon: 'minus-circle', color: 'text-red-400',     slugs: status.removedSlugs || [] },
    ];
    list.innerHTML = sections.map(section => {
      if (!section.slugs.length) {
        return `<div class="text-[11px] text-gray-600 px-1">${section.label}：0</div>`;
      }
      return `<div>
        <div class="text-[11px] text-gray-400 mb-1.5 flex items-center gap-1.5">
          <i data-lucide="${section.icon}" class="w-3 h-3 ${section.color}"></i>
          <span class="${section.color}">${section.label}</span>
          <span class="text-gray-600">(${section.slugs.length})</span>
          <button class="ml-auto text-[10px] text-gray-500 hover:text-gray-300" data-skill-toggle-section="${section.key}">全选/反选</button>
        </div>
        <div class="space-y-1">
          ${section.slugs.map(slug => {
            const checked = state[section.key].has(slug);
            return `<label class="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/[0.04] cursor-pointer text-xs">
              <input type="checkbox" data-skill-section="${section.key}" data-skill-slug="${esc(slug)}" ${checked ? 'checked' : ''} class="w-3.5 h-3.5 rounded">
              <code class="${section.key === 'remove' ? 'text-red-300' : section.key === 'add' ? 'text-emerald-300' : 'text-amber-300'}">${esc(slug)}</code>
              ${section.key === 'remove' ? '<span class="text-[10px] text-red-400/70 ml-1">本地将被删除</span>' : ''}
            </label>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');
    initIcons(list);

    list.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.onchange = () => {
        const section = cb.dataset.skillSection;
        const slug = cb.dataset.skillSlug;
        if (cb.checked) state[section].add(slug);
        else state[section].delete(slug);
        updateSummary();
      };
    });
    list.querySelectorAll('[data-skill-toggle-section]').forEach(btn => {
      btn.onclick = () => {
        const section = btn.dataset.skillToggleSection;
        const sectionSlugs = sections.find(s => s.key === section).slugs;
        const allChecked = sectionSlugs.every(s => state[section].has(s));
        sectionSlugs.forEach(s => allChecked ? state[section].delete(s) : state[section].add(s));
        renderList();
        updateSummary();
      };
    });
  };
  const updateSummary = () => {
    const total = state.add.size + state.change.size + state.remove.size;
    modal.querySelector('#skill-update-summary').textContent =
      `选中 ${total} 项：新增 ${state.add.size} · 修改 ${state.change.size} · 删除 ${state.remove.size}`;
    modal.querySelector('#skill-update-apply').disabled = total === 0;
  };

  renderList();
  updateSummary();

  modal.querySelector('[data-action=closeModal]').onclick = () => modal.remove();
  modal.querySelector('#skill-update-apply').onclick = async () => {
    const applyBtn = modal.querySelector('#skill-update-apply');
    applyBtn.disabled = true;
    applyBtn.innerHTML = '<i data-lucide="loader-circle" class="w-3.5 h-3.5 animate-spin"></i>应用中…';
    initIcons(applyBtn);
    try {
      const result = await localApi('skills/update', {
        method: 'POST',
        body: {
          add: [...state.add],
          change: [...state.change],
          remove: [...state.remove],
        },
      });
      modal.remove();
      skillUpdateStatus = { ...result, available: false };
      await loadSkills(true);
      document.getElementById('skill-local-count').textContent = `${skillCache.length} 个已下载`;
      filterSkills();
      renderSkillUpdateStatus();
      const a = result.applied || { add: 0, change: 0, remove: 0 };
      toast(`Skill 更新完成：新增 ${a.add} · 修改 ${a.change} · 删除 ${a.remove}`, 'success');
    } catch (e) {
      toast(e.message, 'error');
      applyBtn.disabled = false;
      applyBtn.innerHTML = '<i data-lucide="download" class="w-3.5 h-3.5"></i>应用选中';
      initIcons(applyBtn);
    }
  };
}

export async function openSkillDetail(slug) {
  try {
    const skill = await localApi(`skills/${encodeURIComponent(slug)}`);
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:760px;max-height:85vh;overflow-y:auto" data-action="stopPropagation">
      <div class="flex items-start justify-between mb-4">
        <div><h3 class="font-semibold">${esc(skill.title)}</h3><div class="text-[11px] text-gray-500 mt-1">${esc(skill.path)}</div></div>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <p class="text-sm text-gray-400 mb-4">${esc(skill.description)}</p>
      <pre class="text-xs text-gray-400 whitespace-pre-wrap bg-black/20 rounded-lg p-4 overflow-x-auto">${esc(skill.content.slice(0, 30000))}</pre>
      <button class="btn btn-primary mt-4" data-action="closeModalAndOpenAgentWithSkill" data-slug="${skill.slug}"><i data-lucide="bot" class="w-4 h-4"></i>使用此 Skill 对话</button>
    </div>`;
    modal.addEventListener('click', event => {
      if (event.target === modal) modal.remove();
    });
    document.getElementById('modal-host').appendChild(modal);
    initIcons(modal);
  } catch (e) {
    toast(e.message, 'error');
  }
}

export function openAgentWithSkill(slug) {
  LS.set('agentSkillDraft', `/${slug} `);
  gotoPage('agent');
}

export function loadAgentThreads() {
  try {
    const saved = localStorage.getItem('agent_threads');
    if (saved) agentThreads = JSON.parse(saved);
  } catch {}
  if (!agentThreads.length && currentAgentId) startNewAgentThread();
}

export function saveAgentThreads() {
  localStorage.setItem('agent_threads', JSON.stringify(agentThreads));
}

export function startNewAgentThread() {
  const agentId = document.getElementById('agentProvider')?.value || currentAgentId || '';
  const agentName = agentCache.find(a => a.id === agentId)?.name || '未知 Agent';
  const id = 'thread_' + Date.now();
  // 默认标题：HH.MM（如 14.25）
  const now = new Date();
  const defaultName = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
  const thread = { id, agentId, agentName, name: defaultName, messages: [], sessionIds: [], createdAt: Date.now() };
  agentThreads.unshift(thread);
  if (agentThreads.length > 20) agentThreads.pop();
  saveAgentThreads();
  switchAgentThread(id);
  renderAgentThreads();
}

export function switchAgentThread(threadId) {
  currentAgentThreadId = threadId;
  const thread = agentThreads.find(t => t.id === threadId);
  if (thread) {
    agentMessages = thread.messages;
    document.getElementById('agent-thread-name').textContent = thread.name;
    const sel = document.getElementById('agentProvider');
    if (sel && thread.agentId) {
      sel.value = thread.agentId;
      currentAgentId = thread.agentId;
    }
  }
  renderAgentMessages();
  updateResumeHint();
}

export function clearCurrentAgentThread() {
  if (!currentAgentThreadId) return;
  const thread = agentThreads.find(t => t.id === currentAgentThreadId);
  if (!thread) return;
  if (!confirm('确定清空当前对话？')) return;
  thread.messages = [];
  agentMessages = [];
  saveAgentThreads();
  renderAgentMessages();
}

export function deleteAgentThread(threadId) {
  agentThreads = agentThreads.filter(t => t.id !== threadId);
  saveAgentThreads();
  if (currentAgentThreadId === threadId) {
    const currentAgentThreads = agentThreads.filter(t => t.agentId === currentAgentId);
    if (currentAgentThreads.length) switchAgentThread(currentAgentThreads[0].id);
    else { agentMessages = []; currentAgentThreadId = null; }
  }
  renderAgentThreads();
  renderAgentMessages();
}

export async function copySessionId(threadId) {
  const thread = agentThreads.find(t => t.id === threadId);
  const sid = thread?.lastSessionId?.sessionId;
  if (!sid) { toast('该对话没有 session-id', 'error'); return; }
  try {
    await navigator.clipboard.writeText(sid);
    toast(`已复制 session-id: ${sid.slice(0, 8)}…（外部用 ${thread.agentId} --resume 接续）`, 'success');
  } catch {
    toast('复制失败，请手动选择', 'error');
  }
}

export function toggleResumeMode(threadId) {
  const thread = agentThreads.find(t => t.id === threadId);
  if (!thread) return;
  if (!thread.lastSessionId?.sessionId) {
    toast('该对话没有 session-id，无法接续', 'error');
    return;
  }
  thread.resumeMode = !thread.resumeMode;
  saveAgentThreads();
  renderAgentThreads();
  // 切到该 thread，让用户立即可以发消息
  if (currentAgentThreadId !== threadId) switchAgentThread(threadId);
  // 在输入框上方提示
  updateResumeHint();
  toast(thread.resumeMode
    ? `已开启接续：下条消息将带 ${thread.lastSessionId.sessionId.slice(0, 8)}…，发完自动关`
    : '已关闭接续', 'info');
}

function updateResumeHint() {
  const hint = document.getElementById('agent-resume-hint');
  const thread = agentThreads.find(t => t.id === currentAgentThreadId);
  if (!hint) return;
  if (thread?.resumeMode && thread.lastSessionId?.sessionId) {
    hint.classList.remove('hidden');
    hint.innerHTML = `<i data-lucide="link-intact" class="w-3 h-3 inline"></i> 接续模式：将带 session <code class="text-amber-300">${thread.lastSessionId.sessionId.slice(0, 8)}…</code>，${esc(thread.agentName)} 会记得之前对话`;
    initIcons(hint);
  } else {
    hint.classList.add('hidden');
  }
}

export function renderAgentThreads() {
  const host = document.getElementById('agent-thread-list');
  if (!host) return;
  const myThreads = agentThreads.filter(t => t.agentId === currentAgentId);
  if (!myThreads.length) {
    host.innerHTML = '<div class="text-[10px] text-gray-600 px-2">当前 Agent 无对话记录</div>';
    initIcons(host);
    return;
  }
  host.innerHTML = myThreads.map(thread => `
    <div class="group flex items-center gap-1 px-2.5 py-2 rounded-lg border cursor-pointer text-xs ${thread.id === currentAgentThreadId ? 'border-amber-500/25 bg-amber-500/10 text-white' : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-white/10 hover:bg-white/[0.04]'}" data-action="switchAgentThread" data-id="${thread.id}">
      <span class="flex-1 truncate">${esc(thread.name)}</span>
      ${thread.lastSessionId ? `<button class="hidden group-hover:flex btn btn-ghost py-0 px-0.5 ${thread.resumeMode ? 'text-amber-300' : ''}" data-action="toggleResumeMode" data-id="${thread.id}" data-stop-prop title="${thread.resumeMode ? '已开启接续：发完下条会自动关' : '开启接续：下条消息会带上 session-id 让 ' + esc(thread.agentId) + ' 记得之前对话'}">
        <i data-lucide="${thread.resumeMode ? 'link-intact' : 'link'}" class="w-3 h-3"></i>
      </button>
      <button class="hidden group-hover:flex btn btn-ghost py-0 px-0.5" data-action="copySessionId" data-id="${thread.id}" data-stop-prop title="复制 session-id，可用 ${esc(thread.agentId)} --resume 接续">
        <i data-lucide="clipboard-copy" class="w-3 h-3"></i>
      </button>` : ''}
      <button class="hidden group-hover:flex btn btn-ghost py-0 px-0.5" data-action="deleteAgentThread" data-id="${thread.id}" data-stop-prop title="删除">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    </div>
  `).join('');
  initIcons(host);
}

export function onAgentProviderChange(agentId) {
  currentAgentId = agentId;
  LS.set('agentSelected', agentId);
  const agentName = agentCache.find(a => a.id === agentId)?.name || '未知 Agent';
  const currentName = document.getElementById('agent-current-name');
  if (currentName) currentName.textContent = agentName;
  renderAgentProviderStatus(agentId);
  if (currentAgentThreadId) {
    const thread = agentThreads.find(t => t.id === currentAgentThreadId);
    if (thread && !thread.agentId) {
      thread.agentId = agentId;
      thread.agentName = agentName;
      saveAgentThreads();
    }
  }
  renderAgentThreads();
  const myThreads = agentThreads.filter(t => t.agentId === agentId);
  if (myThreads.length) {
    switchAgentThread(myThreads[0].id);
  } else {
    agentMessages = [];
    currentAgentThreadId = null;
    renderAgentMessages();
  }
}

function renderAgentProviderStatus(agentId) {
  const status = document.getElementById('agent-provider-status');
  if (!status) return;
  const agent = agentCache.find(item => item.id === agentId);
  const runtimeError = agentRuntimeErrors.get(agentId);
  if (!agent) {
    status.className = 'text-[10px] text-gray-600 mt-1.5 leading-relaxed';
    status.textContent = '未选择 Agent';
    return;
  }
  if (!agent.available) {
    status.className = 'text-[10px] text-red-400 mt-1.5 leading-relaxed';
    status.textContent = agent.reason || '未检测到本地 CLI';
    return;
  }
  if (runtimeError) {
    status.className = 'text-[10px] text-amber-400 mt-1.5 leading-relaxed';
    status.textContent = runtimeError;
    return;
  }
  status.className = 'text-[10px] text-emerald-400 mt-1.5 leading-relaxed';
  status.textContent = `已检测到 ${agent.family || agent.name} CLI。实际调用仍受本地登录状态和服务额度限制。`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  const diffMs = Date.now() - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)} 小时前`;
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
}

export function copyAgentMessage(index) {
  const msg = agentMessages[index];
  if (!msg) return;
  navigator.clipboard.writeText(msg.content).then(() => toast('已复制', 'success')).catch(() => toast('复制失败', 'error'));
}

export function deleteAgentMessage(index) {
  agentMessages.splice(index, 1);
  const thread = agentThreads.find(t => t.id === currentAgentThreadId);
  if (thread) thread.messages = agentMessages;
  saveAgentThreads();
  renderAgentMessages();
}

export function regenerateAgentMessage(index) {
  const userMsgIdx = agentMessages.slice(0, index).reverse().findIndex(m => m.role === 'user');
  if (userMsgIdx === -1) return;
  const actualUserIdx = index - 1 - userMsgIdx;
  const userMsg = agentMessages[actualUserIdx];
  agentMessages = agentMessages.slice(0, actualUserIdx);
  const thread = agentThreads.find(t => t.id === currentAgentThreadId);
  if (thread) thread.messages = agentMessages;
  saveAgentThreads();
  renderAgentMessages();
  document.getElementById('agentInput').value = userMsg.content;
  sendAgentMessage();
}

export function toggleStreamingIndicator(show, text = 'Agent 正在思考…') {
  const el = document.getElementById('agent-streaming');
  const textEl = document.getElementById('agent-streaming-text');
  if (!el) return;
  if (show) { el.classList.remove('hidden'); if (textEl) textEl.textContent = text; }
  else { el.classList.add('hidden'); }
  initIcons(el);
}

export function handleAgentInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    sendAgentMessage();
  }
}

export async function renderAgent() {
  try {
    const [skillsResult, agentsResult] = await Promise.allSettled([
      localApi('skills/all').catch(() => []),
      localApi('agents'),
    ]);
    if (agentsResult.status === 'rejected') throw agentsResult.reason;
    if (skillsResult.status === 'fulfilled') {
      agentSkillCache = skillsResult.value || [];
    }
    if (skillsResult.status === 'rejected') {
      toast(`Skill 列表加载失败，但仍可使用 Agent：${skillsResult.reason.message}`, 'info');
    }
    agentCache = agentsResult.value;
    const select = document.getElementById('agentProvider');
    if (!select || !select.isConnected) return; // 用户在 await 期间切走了
    select.innerHTML = agentCache.map(agent => `
      <option value="${esc(agent.id)}" ${agent.available ? '' : 'disabled'}>
        ${esc(agent.name)}${agent.model ? ` · ${esc(agent.model)}` : ''}${agent.available ? '' : ` · 不可用`}
      </option>`).join('');
    const preferred = LS.get('agentSelected', 'codex');
    const firstAvailable = agentCache.find(agent => agent.available)?.id || '';
    select.value = agentCache.some(agent => agent.id === preferred && agent.available) ? preferred : firstAvailable;
    currentAgentId = select.value;
    const selectedAgent = agentCache.find(agent => agent.id === currentAgentId);
    const currentName = document.getElementById('agent-current-name');
    if (currentName) currentName.textContent = selectedAgent?.name || '未检测到可用 Agent';
    renderAgentProviderStatus(currentAgentId);
    loadAgentThreads();
    const myThreads = agentThreads.filter(t => t.agentId === currentAgentId);
    if (myThreads.length) {
      switchAgentThread(myThreads[0].id);
    } else {
      startNewAgentThread();
    }
    const draft = LS.get('agentSkillDraft', '');
    if (draft) {
      document.getElementById('agentInput').value = draft;
      LS.set('agentSkillDraft', '');
      showSkillCommands();
    }
    renderAgentMessages();
  } catch (e) {
    const status = document.getElementById('agent-provider-status');
    if (status) {
      status.className = 'text-[10px] text-red-400 mt-1.5 leading-relaxed';
      status.textContent = e.message;
    }
    toast(e.message, 'error');
  }
}

function buildMessageHTML(message, index) {
  const isUser = message.role === 'user';
  const bubbleClass = isUser
    ? 'bg-purple-500/15 border-purple-500/30'
    : 'bg-white/[0.03] border-white/10';
  const alignClass = isUser ? 'items-end' : 'items-start';
  const label = isUser ? '你' : esc(message.agentName || 'Local Agent');
  const labelColor = isUser ? 'text-purple-400' : 'text-cyan-400';
  return `
  <div class="flex flex-col ${alignClass}">
    <div class="flex items-center gap-2 mb-1.5 ${isUser ? 'flex-row-reverse' : ''}">
      <span class="text-[10px] ${labelColor} uppercase tracking-wider">${label}</span>
      <span class="text-[9px] text-gray-600">${formatTime(message.timestamp || Date.now())}</span>
    </div>
    <div class="relative group w-full max-w-[75%]">
      <div class="border ${bubbleClass} rounded-2xl p-4 ${isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'}">
        <div class="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">${esc(message.content)}</div>
      </div>
      <div class="absolute top-2 ${isUser ? 'left-2' : 'right-2'} hidden group-hover:flex gap-1">
        <button class="btn btn-ghost py-0.5 px-1 text-[10px]" data-action="copyAgentMessage" data-index="${index}" title="复制">
          <i data-lucide="copy" class="w-3 h-3"></i>
        </button>
        ${!isUser ? `
        <button class="btn btn-ghost py-0.5 px-1 text-[10px]" data-action="regenerateAgentMessage" data-index="${index}" title="重新生成">
          <i data-lucide="refresh-cw" class="w-3 h-3"></i>
        </button>
        ` : ''}
        <button class="btn btn-ghost py-0.5 px-1 text-[10px] text-red-400" data-action="deleteAgentMessage" data-index="${index}" title="删除">
          <i data-lucide="trash-2" class="w-3 h-3"></i>
        </button>
      </div>
    </div>
  </div>`;
}

export function renderAgentMessages() {
  const host = document.getElementById('agentMessages');
  if (!host) return;
  if (!agentMessages.length) {
    host.innerHTML = `<div class="h-full min-h-[240px] flex items-center justify-center text-center" data-agent-empty>
      <div class="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-8 py-7">
        <i data-lucide="message-square" class="w-9 h-9 text-gray-600 mx-auto mb-3"></i>
        <p class="text-sm text-gray-400">开始一段新对话</p>
        <p class="text-xs text-gray-600 mt-1">输入 <code class="text-purple-300">/</code> 可选择 Skill</p>
      </div>
    </div>`;
    initIcons(host);
    return;
  }
  host.innerHTML = agentMessages.map((message, index) => buildMessageHTML(message, index)).join('');
  host.scrollTop = host.scrollHeight;
  initIcons(host);
}

export function appendAgentMessage(message) {
  const host = document.getElementById('agentMessages');
  if (!host) return;
  const placeholder = host.querySelector('[data-agent-empty]');
  if (placeholder) placeholder.remove();
  const index = agentMessages.length - 1;
  host.insertAdjacentHTML('beforeend', buildMessageHTML(message, index));
  const inserted = host.lastElementChild;
  initIcons(inserted);
  host.scrollTop = host.scrollHeight;
}

export function showSkillCommands() {
  const input = document.getElementById('agentInput');
  const host = document.getElementById('agentSkillCommands');
  if (!input || !host) return;
  const match = input.value.match(/^\/([a-z0-9-]*)$/i);
  if (!match) {
    host.classList.add('hidden');
    return;
  }
  const keyword = match[1].toLowerCase();
  const matches = agentSkillCache.filter(skill =>
    !keyword || skill.slug.includes(keyword) || (skill.title || '').toLowerCase().includes(keyword)
  ).slice(0, 12);
  host.innerHTML = matches.map(skill => `
    <button class="w-full text-left rounded-lg px-3 py-2 hover:bg-white/[0.06] flex items-center gap-2" data-action="insertSkillCommand" data-slug="${skill.slug}">
      <span class="pill ${skill.source === 'custom' ? 'pill-brand' : skill.source === 'hub' ? 'pill-cyan' : 'pill-gray'} !text-[9px] !py-0 !px-1">${skill.source || 'redfox'}</span>
      <span class="flex-1 truncate">${esc(skill.slug)}</span>
      ${skill.title ? `<span class="text-[10px] text-gray-500 truncate">${esc(skill.title)}</span>` : ''}
    </button>
      <div class="text-xs text-purple-300">/${esc(skill.slug)}</div>
      <div class="text-[11px] text-gray-500 mt-0.5">${esc(skill.title)} · ${esc(skill.category)}</div>
    </button>`).join('') || '<div class="p-2 text-xs text-gray-500">没有匹配的 Skill</div>';
  host.classList.remove('hidden');
  initIcons(host);
}

export function insertSkillCommand(slug) {
  const input = document.getElementById('agentInput');
  input.value = `/${slug} `;
  input.focus();
  document.getElementById('agentSkillCommands').classList.add('hidden');
}

export async function sendAgentMessage() {
  const input = document.getElementById('agentInput');
  const message = input.value.trim();
  if (!message) return;
  const mode = document.getElementById('agentMode').value;
  const agent = document.getElementById('agentProvider').value;
  const agentInfo = agentCache.find(item => item.id === agent);
  if (!agentInfo?.available) { toast('请选择可用的本地 Agent', 'error'); return; }
  if (mode === 'workspace' && !confirm('工作区模式允许本地 Agent 修改当前项目文件，确定继续吗？')) return;
  const button = document.getElementById('agentSend');
  const timestamp = Date.now();
  const userMsg = { role: 'user', content: message, timestamp };
  agentMessages.push(userMsg);
  const thread = agentThreads.find(t => t.id === currentAgentThreadId);
  // 默认 HH.MM 标题在首次发消息时保留（不强制改成首句），让用户能按时间定位
  if (thread && !thread.touched) {
    thread.touched = true;
  }
  if (thread) thread.messages = agentMessages;
  saveAgentThreads();
  renderAgentThreads();
  appendAgentMessage(userMsg);
  input.value = '';
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>执行中…';
  initIcons(button);
  toggleStreamingIndicator(true);
  // 如果 thread 开了 resume 模式，把 sessionId 一起带给后端
  const resumeSessionId = thread?.resumeMode && thread.lastSessionId?.sessionId
    ? thread.lastSessionId.sessionId : undefined;
  try {
    const result = await localApi('agent/chat', {
      method: 'POST',
      body: { message, mode, agent, sessionId: resumeSessionId },
    });
    // resume 用过即关，避免下次默认接续
    if (thread?.resumeMode) {
      thread.resumeMode = false;
      saveAgentThreads();
      renderAgentThreads();
      updateResumeHint();
    }
    const assistantMsg = { role: 'assistant', content: result.answer, agentName: result.agentName, timestamp: Date.now(), resumed: Boolean(resumeSessionId) };
    // 后端从 ~/.xxx/projects/ 扫出的 session-id（resume 用），存到 thread
    if (thread && result.sessionId) {
      thread.sessionIds = thread.sessionIds || [];
      const entry = { agent, sessionId: result.sessionId, ts: Date.now() };
      thread.sessionIds.push(entry);
      thread.lastSessionId = entry;
      saveAgentThreads();
      renderAgentThreads();
    }
    agentRuntimeErrors.delete(agent);
    renderAgentProviderStatus(agent);
    agentMessages.push(assistantMsg);
    appendAgentMessage(assistantMsg);
  } catch (e) {
    agentRuntimeErrors.set(agent, e.message);
    renderAgentProviderStatus(agent);
    toast(e.message, 'error');
    const errorMsg = { role: 'assistant', content: `执行失败：${e.message}`, timestamp: Date.now() };
    agentMessages.push(errorMsg);
    appendAgentMessage(errorMsg);
  } finally {
    if (thread) thread.messages = agentMessages;
    saveAgentThreads();
    button.disabled = false;
    button.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i>发送';
    toggleStreamingIndicator(false);
    renderAgentThreads();
    initIcons(button);
  }
}
