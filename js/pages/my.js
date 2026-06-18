import { localApi } from '../api.js';
import { esc, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';

export async function renderMyAccounts() {
  await loadMyAccounts();
}

async function loadMyAccounts() {
  const list = document.getElementById('my-account-list');
  const empty = document.getElementById('my-empty');
  const sub = document.getElementById('my-sub');
  if (!list) return;
  try {
    const accounts = await localApi('my-accounts');
    if (!accounts.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      if (sub) sub.textContent = '管理个人账号、提炼赛道与创作风格档案';
      return;
    }
    empty.classList.add('hidden');
    if (sub) sub.textContent = `共 ${accounts.length} 个账号`;
    list.innerHTML = accounts.map(renderAccountCard).join('');
    initIcons(list);
  } catch (e) {
    list.innerHTML = `<div class="text-red-400 text-sm">${esc(e.message)}</div>`;
  }
}

function renderAccountCard(a) {
  const tracks = (a.tracks || []);
  const profile = a.styleProfile;
  const profileHint = profile
    ? `✓ 已提炼（${a.styleUpdatedAt ? new Date(a.styleUpdatedAt).toLocaleDateString('zh-CN') : ''}）`
    : '未提炼';
  const avatar = proxyImage(a.avatar);
  // 数据源描述（支持多源）
  const sources = [];
  if (a.trackerId) sources.push('RedFox');
  if (a.styleSourceRef) sources.push(`知识库（${a.styleSourceRef.split(',').filter(Boolean).length} 条）`);
  const sourceDesc = sources.length ? sources.join(' + ') : '未指定数据源';
  return `
  <div class="glass rounded-xl p-4 flex flex-col gap-3" data-account-id="${esc(a.id)}">
    <div class="flex items-start gap-3">
      <div class="account-avatar" style="width:48px;height:48px;font-size:15px;">${esc((a.name || '?')[0])}${avatar ? `<img src="${avatar}" alt="" data-image-error="remove" />` : ''}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-semibold text-sm truncate">${esc(a.name)}</span>
          <span class="pill ${a.plat === 'dy' ? 'pill-hot' : a.plat === 'xhs' ? 'pill-brand' : 'pill-green'}">${platName(a.plat)}</span>
        </div>
        <div class="text-[11px] text-gray-500 mt-0.5 truncate">${esc(sourceDesc)}</div>
      </div>
      <button class="btn btn-ghost py-0.5 px-1.5 text-xs text-gray-500 hover:text-red-400" data-action="removeMyAccount" data-id="${esc(a.id)}" title="删除"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
    </div>

    <div>
      <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">赛道</div>
      <div class="flex items-center gap-1 flex-wrap">
        ${tracks.length ? tracks.map(t => `<span class="tag">${esc(t)}</span>`).join('') : '<span class="text-[11px] text-gray-600">未提炼</span>'}
        <button class="btn btn-ghost py-0.5 px-1.5 text-[10px] ml-auto" data-action="extractMyTracks" data-id="${esc(a.id)}" title="基于作品标题提炼赛道">
          <i data-lucide="sparkles" class="w-3 h-3"></i>${tracks.length ? '重提炼' : '提炼赛道'}
        </button>
      </div>
    </div>

    <div>
      <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">风格档案</div>
      <div class="flex items-center gap-2">
        <span class="text-[11px] ${profile ? 'text-emerald-400' : 'text-gray-600'}">${profileHint}</span>
        <div class="ml-auto flex gap-1">
          ${profile ? `<button class="btn btn-ghost py-0.5 px-1.5 text-[10px]" data-action="viewMyStyle" data-id="${esc(a.id)}" title="查看风格档案"><i data-lucide="eye" class="w-3 h-3"></i></button>` : ''}
          <button class="btn btn-ghost py-0.5 px-1.5 text-[10px]" data-action="extractMyStyle" data-id="${esc(a.id)}" title="${profile ? '重新提炼风格档案' : '提炼风格档案'}">
            <i data-lucide="wand-2" class="w-3 h-3"></i>${profile ? '重提炼' : '提炼'}
          </button>
        </div>
      </div>
    </div>

    <div class="pt-2 border-t border-white/5 flex items-center gap-1">
      <button class="btn btn-primary py-1 px-2 text-xs flex-1 justify-center" data-action="presetMyInspirations" data-id="${esc(a.id)}" title="基于赛道生成自动选题配置（cron 每天自动跑）">
        <i data-lucide="lightbulb" class="w-3 h-3"></i>创建自动选题
      </button>
      <button class="btn btn-ghost py-1 px-2 text-xs" data-action="editMyAccount" data-id="${esc(a.id)}" title="编辑">
        <i data-lucide="pencil" class="w-3 h-3"></i>
      </button>
    </div>
  </div>`;
}

export async function addMyAccount() {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal flex flex-col" style="max-width:520px;max-height:85vh" data-action="stopPropagation">
    <div class="flex items-center justify-between mb-4 flex-shrink-0">
      <h2 class="text-lg font-bold">添加我的账号</h2>
      <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="space-y-3 overflow-y-auto scrollbar-thin pr-1 flex-1 min-h-0">
      <label class="block">
        <span class="text-xs text-gray-400">平台</span>
        <select class="input mt-1" id="my-add-plat">
          <option value="gzh">公众号</option>
          <option value="dy">抖音</option>
          <option value="xhs">小红书</option>
        </select>
      </label>
      <label class="block">
        <span class="text-xs text-gray-400">账号名称</span>
        <input class="input mt-1" id="my-add-name" placeholder="账号昵称">
      </label>
      <div>
        <span class="text-xs text-gray-400">数据源（可多选）</span>
        <div class="mt-1 flex gap-2">
          <label class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/[0.03] cursor-pointer text-xs hover:bg-white/[0.06]">
            <input type="checkbox" name="my-source" value="redfox" checked>
            <i data-lucide="radar" class="w-3.5 h-3.5"></i> RedFox
          </label>
          <label class="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/[0.03] cursor-pointer text-xs hover:bg-white/[0.06]">
            <input type="checkbox" name="my-source" value="kb">
            <i data-lucide="book-open" class="w-3.5 h-3.5"></i> 知识库
          </label>
        </div>
        <div class="mt-2 space-y-2">
          <div id="my-add-source-redfox" class="space-y-1 p-2 rounded-md bg-white/[0.02]">
            <div class="text-[11px] text-gray-500">RedFox：从「账号追踪」选择已添加的账号，自动用其作品作为风格源</div>
            <select class="input py-1 text-xs" id="my-add-tracker">
              <option value="">（请先在「账号追踪」添加）</option>
            </select>
          </div>
          <div id="my-add-source-kb" class="space-y-1 p-2 rounded-md bg-white/[0.02] hidden">
            <div class="text-[11px] text-gray-500">使用已配置的 Obsidian + Notion 知识库作为风格源（自动读取全部条目）</div>
            <div id="my-add-kb-status" class="text-[10px] text-gray-500">检查中…</div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button class="btn btn-ghost py-1.5" data-action="closeModal">取消</button>
      <button class="btn btn-primary py-1.5" data-action="submitMyAccount">添加</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
  // 动态加载 tracker 列表
  try {
    const trackers = await localApi('trackers');
    const sel = modal.querySelector('#my-add-tracker');
    sel.innerHTML = '<option value="">（不关联）</option>' + trackers.map(t =>
      `<option value="${esc(t.id)}" data-name="${esc(t.name)}" data-plat="${esc(t.plat)}" data-avatar="${esc(t.gzhAvatar || t.avatar || '')}">${esc(t.name)} · ${platName(t.plat)}</option>`
    ).join('');
  } catch {}
  // 切换数据源时显示对应配置区
  const syncSourceSections = async () => {
    const checked = Array.from(modal.querySelectorAll('input[name="my-source"]:checked')).map(x => x.value);
    modal.querySelector('#my-add-source-redfox').classList.toggle('hidden', !checked.includes('redfox'));
    modal.querySelector('#my-add-source-kb').classList.toggle('hidden', !checked.includes('kb'));
    if (checked.includes('kb') && !modal.dataset.kbStatusLoaded) {
      modal.dataset.kbStatusLoaded = '1';
      await loadKbStatus(modal);
    }
  };
  modal.querySelectorAll('input[name="my-source"]').forEach(r => r.addEventListener('change', syncSourceSections));
  syncSourceSections();
}

async function loadKbStatus(modal) {
  const el = modal.querySelector('#my-add-kb-status');
  if (!el) return;
  el.textContent = '检查中…';
  try {
    const cfg = await localApi('kb/config');
    const obs = cfg.obsidian?.configured;
    const nt = cfg.notion?.configured;
    const parts = [];
    if (obs) parts.push(`Obsidian（${cfg.obsidian.sourcePath || '已配置'}）`);
    if (nt) parts.push(`Notion（database: ${cfg.notion.databaseId || '已配置'}）`);
    if (parts.length) {
      el.innerHTML = `<span class="text-emerald-300">✓ 已配置：</span> ${parts.join('、')}`;
    } else {
      el.innerHTML = `<span class="text-amber-400">⚠ 知识库尚未配置，请先到「知识库」页面配置 Obsidian 或 Notion</span>`;
    }
  } catch (e) {
    el.innerHTML = `<span class="text-red-400">读取配置失败：${esc(e.message)}</span>`;
  }
}

export async function submitMyAccount() {
  const plat = document.getElementById('my-add-plat').value;
  const name = document.getElementById('my-add-name').value.trim();
  if (!name) { toast('请填写账号名称', 'error'); return; }
  const checked = Array.from(document.querySelectorAll('input[name="my-source"]:checked')).map(x => x.value);
  if (!checked.length) { toast('至少选择一个数据源', 'error'); return; }
  const trackerSel = document.getElementById('my-add-tracker');
  const trackerId = trackerSel?.value || '';
  const trackerOpt = trackerSel?.selectedOptions[0];
  if (checked.includes('redfox') && !trackerId) { toast('RedFox 数据源需要选择关联的追踪账号', 'error'); return; }
  const body = {
    plat,
    name,
    trackerId: trackerId || null,
    avatar: trackerOpt?.dataset.avatar || '',
    styleSource: checked.join(','),
    styleSourceRef: checked.includes('kb') ? 'all' : '',  // 'all' = 整库
  };
  // 编辑模式：带上 id
  const editId = document.getElementById('my-add-plat')?.dataset.editId;
  if (editId) body.id = editId;
  try {
    await localApi('my-accounts', { method: 'POST', body });
    toast('已添加', 'success');
    document.querySelector('.modal-mask')?.remove();
    loadMyAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeMyAccount(el, d) {
  if (!confirm('删除此账号？关联的风格档案也会清除。')) return;
  try {
    await localApi(`my-accounts/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    toast('已删除', 'success');
    loadMyAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

export async function editMyAccount(el, d) {
  try {
    const accounts = await localApi('my-accounts');
    const a = accounts.find(x => x.id === d.id);
    if (!a) return;
    await addMyAccount();
    document.getElementById('my-add-plat').value = a.plat;
    document.getElementById('my-add-name').value = a.name;
    if (a.trackerId) {
      document.getElementById('my-add-tracker').value = a.trackerId;
    } else {
      document.querySelector('input[name="my-source"][value="redfox"]').checked = false;
    }
    const kbCheckbox = document.querySelector('input[name="my-source"][value="kb"]');
    kbCheckbox.checked = a.styleSourceRef === 'all' || a.styleSource === 'kb' || (a.styleSource || '').includes('kb');
    document.querySelectorAll('input[name="my-source"]').forEach(r => r.dispatchEvent(new Event('change')));
    document.getElementById('my-add-plat').dataset.editId = a.id;
  } catch (e) { toast(e.message, 'error'); }
}

export async function extractMyTracks(el, d) {
  toast('正在提炼赛道…', 'info');
  try {
    const result = await localApi(`my-accounts/${encodeURIComponent(d.id)}/extract-tracks`, { method: 'POST' });
    if (!result.tracks?.length) { toast('未能提炼出赛道，请确认数据源有作品', 'error'); return; }
    // 让用户编辑确认
    const confirmed = prompt(`已提炼出赛道（可编辑，逗号分隔）：`, result.tracks.join('、'));
    if (confirmed === null) return;
    const tracks = confirmed.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
    await localApi('my-accounts', { method: 'POST', body: { ...result.account, tracks } });
    toast(`已保存 ${tracks.length} 个赛道`, 'success');
    loadMyAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

export async function extractMyStyle(el, d) {
  if (!confirm('开始提炼风格档案？（会调用 LLM，约 5-15 秒）')) return;
  toast('正在提炼风格档案…', 'info');
  try {
    const result = await localApi(`my-accounts/${encodeURIComponent(d.id)}/extract-style`, { method: 'POST' });
    toast('已提炼完成', 'success');
    loadMyAccounts();
    viewMyStyle(d);
  } catch (e) { toast(e.message, 'error'); }
}

export async function viewMyStyle(el, d) {
  const id = d?.id || (typeof el === 'string' ? el : el?.id);
  try {
    const accounts = await localApi('my-accounts');
    const a = accounts.find(x => x.id === id);
    if (!a?.styleProfile) { toast('该账号尚未提炼风格档案', 'error'); return; }
    const p = a.styleProfile;
    const renderList = (items) => Array.isArray(items) ? items.map(i => `<div class="text-xs text-gray-300">• ${esc(String(i))}</div>`).join('') : '';
    const renderObj = (obj) => obj ? Object.entries(obj).map(([k, v]) => `<div class="text-xs"><span class="text-gray-500">${esc(k)}：</span><span class="text-gray-300">${esc(Array.isArray(v) ? v.join('、') : String(v))}</span></div>`).join('') : '';
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:640px;max-height:85vh;overflow:auto" data-action="stopPropagation">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">${esc(a.name)} · 风格档案</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="space-y-3 text-sm">
        ${p['创作心智'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">创作心智</div>${renderObj(p['创作心智'])}</div>` : ''}
        ${p['标题DNA'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">标题 DNA</div>${renderObj(p['标题DNA'])}</div>` : ''}
        ${p['表达风格'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">表达风格</div>${renderObj(p['表达风格'])}</div>` : ''}
        ${p['创作边界'] ? `<div><div class="text-[10px] uppercase tracking-wider text-purple-300 mb-1">创作边界</div>${renderList(p['创作边界'])}</div>` : ''}
        ${p['诚实边界'] ? `<div class="text-[10px] text-gray-500 italic">${esc(p['诚实边界'])}</div>` : ''}
      </div>
    </div>`;
    document.body.appendChild(modal);
    initIcons(modal);
  } catch (e) { toast(e.message, 'error'); }
}

export async function presetMyInspirations(el, d) {
  // 改名为"创建自动选题配置"
  const btn = document.querySelector(`[data-action="presetMyInspirations"][data-id="${CSS.escape(d.id)}"]`);
  const originalHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'pointer-events-none');
    btn.innerHTML = '<i data-lucide="loader-circle" class="w-3 h-3 animate-spin"></i>建议中…';
    initIcons(btn);
  }
  try {
    const suggestions = await localApi(`my-accounts/${encodeURIComponent(d.id)}/suggest-configs`);
    if (!suggestions?.length) {
      toast('未能生成建议，请确认赛道已提炼', 'error');
      return;
    }
    showAutoConfigModal(d.id, suggestions);
  } catch (e) {
    toast(`生成失败：${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'pointer-events-none');
      btn.innerHTML = originalHtml || '<i data-lucide="lightbulb" class="w-3 h-3"></i>生成预设选题';
      initIcons(btn);
    }
  }
}

function showAutoConfigModal(accountId, suggestions) {
  window._autoCfgSuggestions = suggestions;
  window._autoCfgAccountId = accountId;
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal flex flex-col" style="max-width:680px;max-height:85vh" data-action="stopPropagation">
    <div class="flex items-center justify-between mb-2 flex-shrink-0 px-1">
      <div>
        <h2 class="text-lg font-bold">创建自动选题配置</h2>
        <div class="text-[11px] text-gray-500 mt-0.5">勾选要创建的配置，cron 将按计划自动生成灵感入库</div>
      </div>
      <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
    <div class="overflow-y-auto scrollbar-thin flex-1 min-h-0 space-y-2 pr-1">
      ${suggestions.map((cfg, i) => `
        <label class="block p-3 bg-white/[0.02] rounded-lg cursor-pointer hover:bg-white/[0.04] border border-white/5">
          <div class="flex items-start gap-2">
            <input type="checkbox" class="auto-cfg-check mt-1" data-idx="${i}" checked>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm">${esc(cfg.name)}</div>
              <div class="text-[11px] text-gray-500 mt-1">关键词：${cfg.keywords.map(k => `<span class="tag">${esc(k)}</span>`).join(' ')}</div>
              <div class="text-[10px] text-gray-500 mt-1.5 flex items-center gap-2 flex-wrap">
                ${cfg.targetPlatforms?.length ? `<span>平台：${cfg.targetPlatforms.map(p => platName(p)).join('、')}</span>` : ''}
                <span>每次 ${cfg.ideaCount} 条</span>
                <span>源：${cfg.sources.length} 个</span>
              </div>
            </div>
          </div>
        </label>`).join('')}
    </div>
    <div class="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/5 flex-shrink-0">
      <div class="text-[11px] text-gray-500">已勾选 <span id="auto-cfg-count">${suggestions.length}</span> / ${suggestions.length}（每天 9:00 自动跑）</div>
      <div class="flex gap-2">
        <button class="btn btn-ghost py-1.5 text-xs" data-action="closeModal">取消</button>
        <button class="btn btn-primary py-1.5 text-xs" data-action="createAutoConfigs"><i data-lucide="plus" class="w-3 h-3"></i>创建配置</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
  modal.querySelectorAll('input.auto-cfg-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = modal.querySelectorAll('input.auto-cfg-check:checked').length;
      const countEl = modal.querySelector('#auto-cfg-count');
      if (countEl) countEl.textContent = checked;
    });
  });
}

export async function createAutoConfigs() {
  const checked = Array.from(document.querySelectorAll('input.auto-cfg-check:checked')).map(cb => Number(cb.dataset.idx));
  if (!checked.length) { toast('请至少勾选 1 个配置', 'error'); return; }
  const suggestions = (window._autoCfgSuggestions || []).filter((_, i) => checked.includes(i));
  const accountId = window._autoCfgAccountId;
  try {
    let created = 0;
    for (const suggestion of suggestions) {
      await localApi(`my-accounts/${encodeURIComponent(accountId)}/create-config`, {
        method: 'POST',
        body: { suggestion },
      });
      created++;
    }
    toast(`已创建 ${created} 个自动选题配置（每天 9:00 自动生成灵感）`, 'success');
    document.querySelector('.modal-mask')?.remove();
  } catch (e) {
    toast(`创建失败：${e.message}`, 'error');
  }
}
