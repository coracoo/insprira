import { localApi } from '../api.js';
import { LS } from '../state.js';
import { esc } from '../utils.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';
import { gotoPage } from '../navigation.js';
import { clearHotPlatforms } from './hotlist.js';

let skillCache = [];
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
    // 分类下拉固定使用 LLM 七类
    document.getElementById('skillCategory').innerHTML = [
      '<option value="all">全部分类</option>',
      '<option value="热点">热点</option>',
      '<option value="帐号">帐号</option>',
      '<option value="信息源">信息源</option>',
      '<option value="创作">创作</option>',
      '<option value="分析">分析</option>',
      '<option value="检索">检索</option>',
      '<option value="生成工具">生成工具</option>',
    ].join('');
    filterSkills();
    checkSkillUpdates(false);
  } catch (e) {
    document.getElementById('skill-grid').innerHTML = `<div class="text-red-400 text-sm">${esc(e.message)}</div>`;
  }
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
    const catColor = { '热点': 'pill-hot', '帐号': 'pill-rose', '信息源': 'pill-cyan', '创作': 'pill-brand', '分析': 'pill-sky', '检索': 'pill-green', '生成工具': 'pill-amber' }[cat] || 'pill-gray';
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

export async function classifySkills() {
  if (!confirm('将调用 LLM 给所有 skill 自动分类（耗时约 30-90 秒），确认开始？')) return;
  toast('正在用 LLM 分类所有 skill…', 'info');
  try {
    const result = await localApi('skills/classify', { method: 'POST' });
    toast(`分类完成：${result.done}/${result.total} 成功${result.failed ? `，失败 ${result.failed}` : ''}`, 'success');
    await loadSkills(true);
    filterSkills();
  } catch (e) { toast(e.message, 'error'); }
}

export async function forceReclassifySkills() {
  if (!confirm('强制重新分析所有 skill（忽略缓存签名），耗时约 1-3 分钟，确认开始？')) return;
  toast('正在强制重新分类所有 skill…', 'info');
  try {
    const result = await localApi('skills/classify?force=1', { method: 'POST' });
    toast(`强制重分类完成：${result.done}/${result.total} 成功`, 'success');
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
    host.textContent = `发现更新：新增 ${skillUpdateStatus.added.length}、修改 ${skillUpdateStatus.changed.length}、删除 ${skillUpdateStatus.removed.length}`;
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
  const button = document.getElementById('skill-update-button');
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" class="w-3.5 h-3.5 animate-spin"></i>更新中…';
    initIcons(button);
  }
  try {
    const result = await localApi('skills/update', { method: 'POST', body: {} });
    skillUpdateStatus = { ...result, available: false };
    await loadSkills(true);
    document.getElementById('skill-local-count').textContent = `${skillCache.length} 个已下载`;
    filterSkills();
    renderSkillUpdateStatus();
    toast(result.updated ? `Skill 更新完成，新增 ${result.addedSlugs.length} 个` : 'Skill 已是最新版本', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = '<i data-lucide="download" class="w-3.5 h-3.5"></i>一键更新';
      initIcons(button);
    }
  }
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
  const thread = { id, agentId, agentName, name: '新对话', messages: [], createdAt: Date.now() };
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
    <div class="group flex items-center gap-1 px-2.5 py-2 rounded-lg border cursor-pointer text-xs ${thread.id === currentAgentThreadId ? 'border-purple-500/25 bg-purple-500/10 text-white' : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-white/10 hover:bg-white/[0.04]'}" data-action="switchAgentThread" data-id="${thread.id}">
      <span class="flex-1 truncate">${esc(thread.name)}</span>
      <button class="hidden group-hover:flex btn btn-ghost py-0 px-0.5" data-action="deleteAgentThread" data-id="${thread.id}" title="删除">
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
      loadSkills(),
      localApi('agents'),
    ]);
    if (agentsResult.status === 'rejected') throw agentsResult.reason;
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
  const matches = skillCache.filter(skill =>
    !keyword || skill.slug.includes(keyword) || skill.title.toLowerCase().includes(keyword)
  ).slice(0, 12);
  host.innerHTML = matches.map(skill => `
    <button class="w-full text-left rounded-lg px-3 py-2 hover:bg-white/[0.06]" data-action="insertSkillCommand" data-slug="${skill.slug}">
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
  if (thread && thread.name === '新对话') {
    thread.name = message.slice(0, 20).replace(/\n/g, ' ') || '新对话';
    document.getElementById('agent-thread-name').textContent = thread.name;
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
  try {
    const result = await localApi('agent/chat', {
      method: 'POST',
      body: { message, mode, agent },
    });
    const assistantMsg = { role: 'assistant', content: result.answer, agentName: result.agentName, timestamp: Date.now() };
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
