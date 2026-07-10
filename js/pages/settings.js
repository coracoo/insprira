import { localApi } from '../api.js';
import { esc } from '../utils.js';
import { toast } from '../components.js';
import { initIcons } from '../icons.js';
import { NOTIFICATION_CHANNELS, LOCKED_CRONS, BUILTIN_CRONS, PROTECTED_CRONS } from '../config.js';

export async function renderSettings() {
  try {
    const [status, configs] = await Promise.all([
      localApi('status'),
      localApi('inspiration-configs'),
    ]);
    if (!document.getElementById('api-detail')) return;
    window._inspirationConfigs = configs;
    renderInspirationConfigs();
    const kbBanner = document.getElementById('kb-insecure-banner');
    if (kbBanner) kbBanner.classList.toggle('hidden', !status.kbEncryptionInsecure);
    const pill = document.getElementById('api-status-pill');
    if (!pill) return;
    pill.className = `pill ${status.redfoxConfigured ? 'pill-green' : 'pill-hot'}`;
    pill.innerHTML = `<i data-lucide="${status.redfoxConfigured ? 'check' : 'x'}" class="w-3 h-3"></i>${status.redfoxConfigured ? '已配置' : '未配置'}`;
    const llmPill = document.getElementById('llm-status-pill');
    if (!llmPill) return;
    llmPill.className = `pill ${status.llmConfigured ? 'pill-green' : 'pill-hot'}`;
    llmPill.innerHTML = `<i data-lucide="${status.llmConfigured ? 'check' : 'x'}" class="w-3 h-3"></i>${status.llmConfigured ? '已配置' : '未配置'}`;
    const githubPill = document.getElementById('github-status-pill');
    if (githubPill) {
      const on = !!status.githubConfigured;
      githubPill.className = `pill ${on ? 'pill-green' : 'pill-gray'}`;
      githubPill.innerHTML = `<i data-lucide="${on ? 'check' : 'minus'}" class="w-3 h-3"></i>${on ? '已配置' : '未配置'}`;
    }
    const notionPill = document.getElementById('notion-status-pill');
    if (notionPill) {
      const on = !!status.notionConfigured;
      notionPill.className = `pill ${on ? 'pill-green' : 'pill-gray'}`;
      notionPill.innerHTML = `<i data-lucide="${on ? 'check' : 'minus'}" class="w-3 h-3"></i>${on ? '已配置' : '未配置'}`;
    }
    document.getElementById('api-detail').textContent = '配置变更后需重启服务生效';
    await loadQuota();
    await renderCronList();
    await renderNotificationSettings();
    initIcons(document.getElementById('content-area'));
  } catch (e) {
    const detail = document.getElementById('api-detail');
    if (detail) detail.textContent = e.message;
  }
}

export async function openRedfoxApply() {
  try {
    const payload = await localApi('redfox/apply');
    const url = payload?.url;
    if (!url) { toast('申请入口未配置', 'error'); return; }
    window.open(url, '_blank', 'noopener');
  } catch (e) { toast(e.message, 'error'); }
}

export async function openEnvModal() {
  try {
    const config = await localApi('env');
    const fields = [
      ['REDFOX_API_KEY','RedFox API Key','password'],
      ['REDFOX_WEB_COOKIE','RedFox Web Cookie','password','用于登录 RedFox 官网并查询账户余额，不参与 API 数据调用。'],
      ['LLM_BASE_URL','LLM Base URL','text'],
      ['LLM_API_KEY','LLM API Key','password'],
      ['LLM_MODEL','LLM 模型','text'],
      ['KB_ENCRYPTION_KEY','知识库加密密钥','password','用于加密 Notion 凭证。已有数据请勿随意修改。'],
      ['GITHUB_API_TOKEN','GitHub API Token','password','可选。Skill 中心更新走 GitHub API，未配置时匿名请求频率 60/hr 容易 403；配置后提升到 5000/hr。Personal access token 即可，无需勾选任何权限。','https://github.com/settings/tokens'],
      ['ENABLE_SCHEDULER','启用调度器','text',''],
    ];
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:760px;max-height:90vh;overflow:auto">
      <div class="flex items-center justify-between mb-4"><div><h2 class="text-lg font-bold">维护 .env</h2><p class="text-[11px] text-gray-500 mt-1">敏感字段留空将保留当前值；保存后需要重启服务生效。</p></div><button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form id="env-config-form"><div class="grid grid-cols-1 md:grid-cols-2 gap-3">${fields.map(([key,label,type,tip='',link='']) => `
        <div><label class="text-xs text-gray-400 flex items-center gap-1.5 mb-1">${label}${tip ? `<span class="help-tip" data-tip="${esc(tip)}">?</span>` : ''}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener" class="text-cyan-300 hover:underline text-[11px]">申请</a>` : ''} ${config[key]?.configured ? '<span class="text-emerald-400">已配置</span>' : ''}</label><input class="input font-mono text-xs" type="${type}" autocomplete="${type === 'password' ? 'new-password' : 'off'}" data-env-key="${key}" placeholder="${config[key]?.secret && config[key]?.configured ? '留空保留原值' : ''}" /></div>
      `).join('')}</div>
      <div class="flex justify-end mt-5"><button type="submit" class="btn btn-primary" data-action="saveEnvConfig"><i data-lucide="save" class="w-3.5 h-3.5"></i>保存 .env</button></div></form>
    </div>`;
    document.body.appendChild(modal);
    fields.forEach(([key]) => {
      const input = modal.querySelector(`[data-env-key="${key}"]`);
      if (input) input.value = config[key]?.value || '';
    });
    window._envModal = modal;
    modal.querySelector('#env-config-form')?.addEventListener('submit', event => {
      event.preventDefault();
      saveEnvConfig();
    });
    initIcons(modal);
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveEnvConfig() {
  const body = Object.fromEntries([...document.querySelectorAll('[data-env-key]')].map(input => [input.dataset.envKey, input.value]));
  try {
    await localApi('env', { method: 'PUT', body });
    window._envModal?.remove();
    toast('.env 已保存，重启服务后生效', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

export async function restartService() {
  if (!confirm('确定重启灵感熔炉服务？页面会短暂断开数秒。')) return;
  try {
    await localApi('service/restart', { method: 'POST', body: {} });
    toast('服务正在重启…', 'info');
    const startedAt = Date.now();
    const wait = async () => {
      try {
        const response = await fetch('/api/_/status', { cache: 'no-store' });
        if (response.ok && Date.now() - startedAt > 1200) {
          location.reload();
          return;
        }
      } catch {}
      if (Date.now() - startedAt < 20000) setTimeout(wait, 800);
      else toast('服务重启超时，请手动刷新页面', 'error');
    };
    setTimeout(wait, 1000);
  } catch (e) { toast(`重启失败：${e.message}`, 'error'); }
}

export async function loadQuota() {
  const host = document.getElementById('quota-content');
  if (!host) return;
  host.textContent = '读取中…';
  try {
    const quota = await localApi('quota');
    const today = quota.usage.today || {};
    const month = quota.usage.last30Days || {};
    const points = quota.official?.data || null;
    // 8 个指标 · 4×2 紧凑网格，自用调用 + RedFox 额度合一，不分模块
    // 官方额度不可读时显示 "--"，不阻断自用调用数据
    const cells = [
      ['今日调用', today.calls ?? 0, ''],
      ['30天调用', month.calls ?? 0, ''],
      ['总点数', points?.totalAvailablePoints, 'text-emerald-300'],
      ['免费',     points?.freeAvailablePoints,  'text-purple-300'],
      ['付费',     points?.paidAvailablePoints,  'text-cyan-300'],
      ['今日消耗', points?.todayConsumption,     'text-amber-300'],
      ['本月消耗', points?.monthConsumption,     'text-orange-300'],
      ['累计消耗', points?.totalConsumption,     'text-pink-300'],
    ];
    const officialNote = !points && quota.official?.error
      ? `<div class="text-[10px] text-gray-500 mt-1.5 leading-relaxed">官方额度未读取：${esc(quota.official.error)}。在 .env 配 REDFOX_WEB_COOKIE 可解锁。</div>`
      : '';
    host.innerHTML = `
      <div class="grid grid-cols-4 gap-1.5">
        ${cells.map(([label, value, color]) => `
          <div class="bg-white/[0.035] rounded-md p-1.5 min-w-0">
            <div class="text-[10px] text-gray-500 whitespace-nowrap leading-tight">${label}</div>
            <div class="text-base font-bold mt-0.5 ${color} leading-tight">${value ?? '--'}</div>
          </div>`).join('')}
      </div>
      ${officialNote}`;
  } catch (e) {
    host.innerHTML = `<span class="text-red-400">${esc(e.message)}</span>`;
  }
}

export async function renderNotificationSettings() {
  const host = document.getElementById('notification-list');
  if (!host) return;
  try {
    const configs = await localApi('notifications');
    host.innerHTML = NOTIFICATION_CHANNELS.map(([key,label,placeholder]) => `
      <div class="bg-white/[0.025] rounded-lg p-3">
        <div class="flex items-center justify-between gap-3 mb-2">
          <label class="text-sm flex items-center gap-2"><input type="checkbox" data-notify-enabled="${key}" class="accent-purple-500" ${configs[key]?.enabled ? 'checked' : ''}>${label}</label>
          <span class="text-[10px] ${configs[key]?.configured ? 'text-emerald-400' : 'text-gray-600'}">${configs[key]?.configured ? '已配置' : '未配置'}</span>
        </div>
        <div class="flex gap-2 items-end">
          <div class="flex-1 grid ${key === 'telegram' ? 'grid-cols-2' : 'grid-cols-1'} gap-2">
            <input class="input font-mono text-xs" data-notify-url="${key}" type="${key === 'telegram' ? 'text' : 'url'}" autocomplete="off" placeholder="${placeholder}" value="${esc((key === 'telegram' ? configs[key]?.botToken : configs[key]?.url) || '')}" />
            ${key === 'telegram' ? `<input class="input font-mono text-xs" data-notify-chat="${key}" placeholder="Chat ID" value="${esc(configs[key]?.chatId || '')}" />` : ''}
          </div>
          <button type="button" class="btn btn-ghost py-2 text-xs" data-action="testNotification" data-key="${key}"><i data-lucide="send" class="w-3.5 h-3.5"></i>测试</button>
        </div>
      </div>`).join('');
    host.onsubmit = event => {
      event.preventDefault();
      saveNotificationSettings();
    };
    initIcons(host);
  } catch (e) { host.innerHTML = `<span class="text-red-400">${esc(e.message)}</span>`; }
}

export function notificationInput(channel) {
  const value = document.querySelector(`[data-notify-url="${channel}"]`)?.value.trim() || '';
  return {
    enabled: document.querySelector(`[data-notify-enabled="${channel}"]`)?.checked || false,
    ...(channel === 'telegram'
      ? { botToken: value, chatId: document.querySelector(`[data-notify-chat="${channel}"]`)?.value.trim() || '' }
      : { url: value }),
  };
}

export async function saveNotificationSettings() {
  const body = Object.fromEntries(NOTIFICATION_CHANNELS.map(([channel]) => [channel, notificationInput(channel)]));
  try {
    await localApi('notifications', { method: 'PUT', body });
    toast('通知配置已保存', 'success');
    await renderNotificationSettings();
  } catch (e) { toast(e.message, 'error'); }
}

export async function testNotification(channel) {
  try {
    await localApi('notifications/test', { method: 'POST', body: { channel, config: notificationInput(channel) } });
    toast('测试消息已发送', 'success');
  } catch (e) { toast(`发送失败：${e.message}`, 'error'); }
}

export function cronCostMeta(job) {
  if (job.taskType === 'hot-realtime' || job.taskType === 'hot-platform') {
    return { label: 'API', className: 'pill-amber', detail: '每次执行调用 1 次 RedFox API' };
  }
  if (job.taskType === 'hot-trend-analysis') {
    return { label: 'LLM', className: 'pill-brand', detail: '数据变化时调用 1 次 LLM；无变化复用结果' };
  }
  if (job.taskType === 'inspiration-generate') {
    const config = (window._inspirationConfigs || []).find(item => item.id === job.taskConfig?.configId);
    const budget = config?.dailyApiBudget ?? '--';
    const searchCost = config?.sources?.includes('gzh-search')
      ? config?.searchMode === 'deep'
        ? '；深度搜索最多逐词调用 5 次，例如 3 个词最多 3 次'
        : '；组合搜索最多 5 个词合并调用 1 次'
      : '';
    return { label: 'API + LLM', className: 'pill-hot', detail: `全部选题数据源共用每日硬预算 ${budget} 次${searchCost}；每轮 1 次 LLM，JSON 修复时增加 1 次` };
  }
  if (job.taskType === 'daily-hot-report') {
    return { label: '推送', className: 'pill-brand', detail: '从昨日热榜快照聚合 TOP 5，调用已启用通知渠道' };
  }
  if (job.taskType === 'tracker-refresh') {
    return { label: 'API + 可选 LLM', className: 'pill-hot', detail: '每个勾选账号 1 次 API；“自己”的公众号/抖音额外 1 次诊断 API，小红书复用同步数据；首个或无变化快照不调用 LLM' };
  }
  return { label: '本地', className: 'pill-green', detail: '不调用 RedFox API 或 LLM' };
}

export async function renderCronList() {
  try {
    const jobs = await localApi('crons');
    const el = document.getElementById('cron-list');
    if (!el) return;
    el.innerHTML = jobs.map(j => {
      const cost = cronCostMeta(j);
      const lastRunStr = j.lastRun ? new Date(j.lastRun).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '从未运行';
      // 通知标签：成功/失败/通知（两者都开）三选一
      const failureOn = j.notifyOnFailure !== false;
      const successOn = Boolean(j.notifyOnSuccess);
      const notifyBadge = (failureOn && successOn)
        ? '<span class="pill pill-brand !text-[10px] !py-0 !px-1.5" title="成功和失败都通知">通知</span>'
        : failureOn
          ? '<span class="pill pill-hot !text-[10px] !py-0 !px-1.5" title="失败时通知">失败通知</span>'
          : successOn
            ? '<span class="pill pill-green !text-[10px] !py-0 !px-1.5" title="成功时通知">成功通知</span>'
            : '<span class="pill pill-gray !text-[10px] !py-0 !px-1.5" title="无通知">静默</span>';
      // 按任务类型给图标和颜色 + 底色样式
      const typeIcon = {
        'hot-realtime': 'flame',
        'hot-platform': 'bar-chart-2',
        'hot-trend-analysis': 'trending-up',
        'inspiration-generate': 'lightbulb',
        'daily-hot-report': 'newspaper',
        'tracker-refresh': 'refresh-cw',
        'cache-clean': 'trash-2',
        'usage-clean': 'eraser',
        'wersss-sync': 'rss',
      }[j.taskType] || 'clock';
      const typeStyle = {
        'hot-realtime':       { color: 'text-orange-300',   bg: 'bg-orange-500/15 border-orange-500/30' },
        'hot-platform':       { color: 'text-sky-300',      bg: 'bg-sky-500/15 border-sky-500/30' },
        'hot-trend-analysis': { color: 'text-emerald-300',  bg: 'bg-emerald-500/15 border-emerald-500/30' },
        'inspiration-generate': { color: 'text-amber-300',  bg: 'bg-amber-500/15 border-amber-500/30' },
        'daily-hot-report':   { color: 'text-pink-300',     bg: 'bg-pink-500/15 border-pink-500/30' },
        'tracker-refresh':    { color: 'text-cyan-300',     bg: 'bg-cyan-500/15 border-cyan-500/30' },
        'cache-clean':        { color: 'text-gray-300',     bg: 'bg-gray-500/15 border-gray-500/30' },
        'usage-clean':        { color: 'text-gray-300',     bg: 'bg-gray-500/15 border-gray-500/30' },
        'wersss-sync':        { color: 'text-purple-300',   bg: 'bg-purple-500/15 border-purple-500/30' },
      }[j.taskType] || { color: 'text-gray-300', bg: 'bg-gray-500/15 border-gray-500/30' };
      return `
      <div class="bg-white/[0.02] border border-white/10 rounded-lg p-2.5 cursor-grab active:cursor-grabbing" draggable="true" data-drag-id="${esc(j.id)}">
        <div class="flex items-center gap-2 mb-1.5">
          <label class="cron-switch" title="${j.enabled ? '点击暂停' : '点击启用'}">
            <input type="checkbox" ${j.enabled ? 'checked' : ''} class="cron-toggle" data-cron-id="${j.id}" ${LOCKED_CRONS.includes(j.id) ? 'disabled' : ''}>
            <span class="track"></span>
            <span class="thumb"></span>
            <span class="lbl lbl-on">运行</span>
            <span class="lbl lbl-off">暂停</span>
          </label>
          <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${typeStyle.bg} ${typeStyle.color} text-xs font-medium flex-1 min-w-0" title="${esc(j.name)}">
            <i data-lucide="${typeIcon}" class="w-3.5 h-3.5 flex-shrink-0"></i>
            <span class="truncate">${esc(j.name)}</span>
          </span>
          <code class="text-[10px] text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded flex-shrink-0" title="Cron 表达式">${esc(j.cronExpr)}</code>
        </div>
        <div class="flex items-center gap-1 flex-wrap mb-1.5 ml-12">
          <span class="pill ${cost.className} !text-[10px] !py-0 !px-1.5" title="${esc(cost.detail)}">${cost.label}</span>
          ${notifyBadge}
          <span class="text-[10px] text-gray-500 ml-auto truncate" title="${esc(cost.detail)}">上次运行时间：${lastRunStr}</span>
        </div>
        <div class="flex items-center justify-end gap-0.5 ml-12 pt-1 border-t border-white/5">
          <button class="btn btn-ghost py-0.5 px-1.5 text-[11px]" data-action="runCronNow" data-id="${j.id}" title="立即执行"><i data-lucide="play" class="w-3 h-3"></i></button>
          ${!LOCKED_CRONS.includes(j.id) ? `<button class="btn btn-ghost py-0.5 px-1.5 text-[11px]" data-action="openCronModal" data-id="${j.id}" title="编辑"><i data-lucide="pencil" class="w-3 h-3"></i></button>` : ''}
          ${!PROTECTED_CRONS.includes(j.id) ? `<button class="btn btn-ghost py-0.5 px-1.5 text-[11px] text-red-400" data-action="deleteCron" data-id="${j.id}" title="删除"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
        </div>
      </div>`;
    }).join('');
    initIcons(el);
    bindCronDrag(el);
    const status = document.getElementById('scheduler-status');
    if (status) status.textContent = `共 ${jobs.length} 个任务`;
  } catch (e) {
    const list = document.getElementById('cron-list');
    const status = document.getElementById('scheduler-status');
    if (list) list.innerHTML = `<span class="text-red-400 text-xs">加载失败: ${esc(e.message)}</span>`;
    if (status) status.textContent = '';
  }
}

let cronDragSrcId = null;

export function bindCronDrag(listEl) {
  if (!listEl || listEl.dataset.dragBound) return;
  listEl.dataset.dragBound = '1';
  listEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-drag-id]');
    if (!card) return;
    // 避免按钮/开关触发拖拽
    if (e.target.closest('button, input, label')) { e.preventDefault(); return; }
    cronDragSrcId = card.dataset.dragId;
    card.classList.add('cron-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', cronDragSrcId); } catch {}
  });
  listEl.addEventListener('dragend', (e) => {
    const card = e.target.closest('[data-drag-id]');
    if (card) card.classList.remove('cron-dragging');
    listEl.querySelectorAll('.cron-drop-target').forEach(el => el.classList.remove('cron-drop-target'));
    cronDragSrcId = null;
  });
  listEl.addEventListener('dragover', (e) => {
    if (!cronDragSrcId) return;
    const card = e.target.closest('[data-drag-id]');
    if (!card || card.dataset.dragId === cronDragSrcId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    listEl.querySelectorAll('.cron-drop-target').forEach(el => el.classList.remove('cron-drop-target'));
    card.classList.add('cron-drop-target');
  });
  listEl.addEventListener('dragleave', (e) => {
    const card = e.target.closest('[data-drag-id]');
    if (card) card.classList.remove('cron-drop-target');
  });
  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!cronDragSrcId) return;
    const target = e.target.closest('[data-drag-id]');
    listEl.querySelectorAll('.cron-drop-target').forEach(el => el.classList.remove('cron-drop-target'));
    if (!target || target.dataset.dragId === cronDragSrcId) return;
    const srcCard = listEl.querySelector(`[data-drag-id="${CSS.escape(cronDragSrcId)}"]`);
    if (!srcCard) return;
    // 插入到目标卡片之前或之后
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (after) target.after(srcCard); else target.before(srcCard);
    const ids = Array.from(listEl.querySelectorAll('[data-drag-id]')).map(el => el.dataset.dragId);
    try {
      await localApi('crons/reorder', { method: 'POST', body: { ids } });
      toast('排序已保存', 'success');
      renderCronList();
    } catch (err) {
      toast('排序保存失败：' + err.message, 'error');
      renderCronList();
    }
  });
}

export async function toggleCron(id, enabled) {
  try {
    const jobs = await localApi('crons');
    const job = jobs.find(j => j.id === id);
    if (!job) return;
    await localApi('crons', { method: 'POST', body: { ...job, enabled } });
    toast(enabled ? '已启用' : '已停用', 'success');
  } catch (e) { toast('操作失败: ' + e.message, 'error'); renderCronList(); }
}

export async function runCronNow(id) {
  try {
    toast('执行中…', 'info');
    await localApi('crons/run', { method: 'POST', body: { id } });
    toast('执行完成', 'success');
    renderCronList();
  } catch (e) { toast('执行失败: ' + e.message, 'error'); }
}

export function openCronModal(editId) {
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `
    <div class="modal">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">${editId ? '编辑任务' : '新建任务'}</h2>
        <button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="space-y-3">
        <div>
          <label class="text-xs text-gray-400 mb-1 block">任务名称</label>
          <input class="input" id="cron-name" placeholder="例如：每晚同步数据" />
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Cron 表达式 <span class="text-gray-600">(分 时 日 月 周)</span></label>
          <input class="input font-mono" id="cron-expr" placeholder="0 2 * * *" />
          <div class="text-[10px] text-gray-600 mt-1">示例：<code>0 2 * * *</code> 每天凌晨2点 · <code>*/10 * * * *</code> 每10分钟 · <code>0 */1 * * *</code> 每小时</div>
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">任务类型</label>
          <select class="input" id="cron-task-type">
            <option value="hot-realtime">全网实时热点刷新</option>
            <option value="hot-platform">平台昨日榜刷新</option>
            <option value="hot-trend-analysis">昨日热点关键词分析</option>
            <option value="daily-hot-report">每日热榜日报推送</option>
            <option value="tracker-refresh">勾选账号昨日数据刷新</option>
            <option value="cache-clean">API缓存清理</option>
            <option value="usage-clean">API 用量日志清理</option>
          </select>
        </div>
        <div class="flex flex-col gap-2 text-sm">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cron-notify-failure" class="accent-[var(--accent-color,#fb923c)]" checked />
            <span>失败时通知</span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="cron-notify-success" class="accent-[var(--accent-color,#fb923c)]" />
            <span>成功时通知</span>
          </label>
        </div>
        <button class="btn btn-primary w-full mt-2" data-action="submitCron" data-id="${editId || ''}">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  initIcons(modal);
  if (editId) {
    localApi('crons').then(jobs => {
      const j = jobs.find(x => x.id === editId);
      if (j) {
        document.getElementById('cron-name').value = j.name;
        document.getElementById('cron-expr').value = j.cronExpr;
        document.getElementById('cron-task-type').value = j.taskType;
        document.getElementById('cron-task-type').disabled = BUILTIN_CRONS.includes(j.id) || j.taskType === 'hot-platform';
        document.getElementById('cron-notify-failure').checked = j.notifyOnFailure !== false;
        document.getElementById('cron-notify-success').checked = Boolean(j.notifyOnSuccess);
        window._cronEditConfig = j.taskConfig || null;
        window._cronEditEnabled = j.enabled;
      }
    }).catch(e => toast('加载任务失败: ' + e.message, 'error'));
  }
  window._cronModal = modal;
}

export async function submitCron(editId) {
  const name = document.getElementById('cron-name').value.trim();
  const cronExpr = document.getElementById('cron-expr').value.trim();
  const taskType = document.getElementById('cron-task-type').value;
  const notifyOnFailure = document.getElementById('cron-notify-failure').checked;
  const notifyOnSuccess = document.getElementById('cron-notify-success').checked;
  if (!name || !cronExpr) { toast('名称和 Cron表达式不能为空', 'error'); return; }
  const id = editId || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
  try {
    await localApi('crons', {
      method: 'POST',
      body: {
        id, name, cronExpr,
        enabled: editId ? window._cronEditEnabled !== false : true,
        taskType,
        taskConfig: editId ? window._cronEditConfig : null,
        notifyOnFailure,
        notifyOnSuccess,
      },
    });
    toast('已保存', 'success');
    window._cronModal?.remove();
    window._cronEditConfig = null;
    window._cronEditEnabled = null;
    renderCronList();
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}

export async function deleteCron(id) {
  if (!confirm('确定删除这个定时任务？')) return;
  try {
    await localApi('crons/' + id, { method: 'DELETE' });
    toast('已删除', 'success');
    renderCronList();
  } catch (e) { toast('删除失败: ' + e.message, 'error'); }
}

// ============= Inspiration Config =============
export function renderInspirationConfigs() {
  const host = document.getElementById('inspiration-config-list');
  if (!host) return;
  const configs = window._inspirationConfigs || [];
  host.innerHTML = configs.map(config => `
    <div class="bg-white/[0.025] rounded-xl p-4 cursor-pointer hover:bg-white/[0.045] transition" data-action="openInspirationConfigDetail" data-id="${config.id}">
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap"><span class="font-medium">${esc(config.name)}</span><span class="pill ${config.enabled ? 'pill-green' : 'pill-gray'}">${config.enabled ? '运行中' : '已暂停'}</span></div>
          <div class="text-[11px] text-gray-500 mt-1">${esc(config.domain || '未设置赛道')} · <code class="text-purple-300">${esc(config.cronExpr)}</code> · 每次 ${config.ideaCount} 条 · ${config.searchMode === 'deep' ? '深度搜索' : '组合搜索'}</div>
          <div class="flex flex-wrap gap-1.5 mt-2">${config.terms.slice(0,8).map(term => `<span class="tag ${term.type === 'black' ? 'text-red-300' : term.type === 'white' ? 'text-emerald-300' : ''}">${esc(term.term)} ${term.weight ? `(${term.weight > 0 ? '+' : ''}${term.weight})` : ''}</span>`).join('')}</div>
        </div>
        <div class="flex gap-1">
          <button class="btn btn-ghost py-1 px-2 text-xs" title="${config.enabled ? '暂停 Cron' : '恢复 Cron'}" data-action="toggleInspirationConfig" data-id="${config.id}"><i data-lucide="${config.enabled ? 'pause' : 'play'}" class="w-3 h-3"></i></button>
          <button class="btn btn-ghost py-1 px-2 text-xs" title="立即执行" data-action="runInspirationConfig" data-id="${config.id}"><i data-lucide="zap" class="w-3 h-3"></i></button>
          <button class="btn btn-ghost py-1 px-2 text-xs" title="编辑配置" data-action="openInspirationConfigModal" data-id="${config.id}"><i data-lucide="settings" class="w-3 h-3"></i></button>
        </div>
      </div>
    </div>`).join('') || '<div class="lg:col-span-2 text-center text-gray-500 text-sm py-4">尚未配置自动选题主题</div>';
  initIcons(document.getElementById('inspiration-config-list'));
}

export function openInspirationConfigDetail(id) {
  const config = (window._inspirationConfigs || []).find(item => item.id === id);
  if (!config) return;
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" style="max-width:720px">
    <div class="flex items-center justify-between mb-4"><h2 class="text-lg font-bold">${esc(config.name)}</h2><button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button></div>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div class="bg-white/[0.025] rounded-lg p-3"><div class="text-xs text-gray-500">赛道</div><div class="mt-1">${esc(config.domain || '未设置')}</div></div>
      <div class="bg-white/[0.025] rounded-lg p-3"><div class="text-xs text-gray-500">CRON</div><code class="text-purple-300 mt-1 block">${esc(config.cronExpr)}</code></div>
      <div class="bg-white/[0.025] rounded-lg p-3"><div class="text-xs text-gray-500">每次生成</div><div class="mt-1">${config.ideaCount} 条选题 / ${config.evidenceLimit} 条证据</div></div>
      <div class="bg-white/[0.025] rounded-lg p-3"><div class="text-xs text-gray-500">API 硬预算</div><div class="mt-1">每日最多 ${config.dailyApiBudget} 次</div><div class="text-[10px] text-gray-600 mt-1">榜单与关键词搜索共用</div></div>
      <div class="bg-white/[0.025] rounded-lg p-3 col-span-2"><div class="text-xs text-gray-500">公众号关键词模式</div><div class="mt-1">${config.searchMode === 'deep' ? '深度搜索：每个关键词分别请求' : '组合搜索：最多 5 个关键词合并为一次请求'}</div><div class="text-[10px] text-gray-600 mt-1">${config.searchMode === 'deep' ? '例如 3 个关键词最多调用 3 次 API；缓存命中或预算不足时更少。' : '例如 3 个关键词只调用 1 次 API；赛道不增加调用次数。'}</div></div>
    </div>
    <div class="mt-4"><div class="text-xs text-gray-500 mb-2">数据来源</div><div class="flex flex-wrap gap-2">${config.sources.map(source => `<span class="tag">${esc(source)}</span>`).join('')}</div></div>
    <div class="mt-4"><div class="text-xs text-gray-500 mb-2">关键词与权重</div><div class="flex flex-wrap gap-2">${config.terms.map(term => `<span class="tag ${term.type === 'black' ? 'text-red-300' : term.type === 'white' ? 'text-emerald-300' : ''}">${esc(term.term)} · ${esc(term.type)} · ${term.weight > 0 ? '+' : ''}${term.weight}</span>`).join('')}</div></div>
    <div class="flex justify-end gap-2 mt-5"><button class="btn btn-ghost ${config.enabled ? 'text-amber-400' : 'text-emerald-400'}" data-action="closeModalAndToggleInspirationConfig" data-id="${config.id}"><i data-lucide="${config.enabled ? 'pause' : 'play'}" class="w-3.5 h-3.5"></i>${config.enabled ? '暂停生成' : '恢复生成'}</button><button class="btn btn-ghost" data-action="closeModalAndOpenInspirationConfigModal" data-id="${config.id}"><i data-lucide="settings" class="w-3.5 h-3.5"></i>编辑配置</button><button class="btn btn-primary" data-action="closeModalAndRunInspirationConfig" data-id="${config.id}"><i data-lucide="zap" class="w-3.5 h-3.5"></i>立即执行</button></div>
  </div>`;
  document.body.appendChild(modal);
  initIcons(modal);
}

let _inspirationSources = null;

export async function loadInspirationSources() {
  if (!_inspirationSources) {
    _inspirationSources = await localApi('inspiration-sources');
  }
  return _inspirationSources;
}

export async function openInspirationConfigModal(id = '') {
  const config = (window._inspirationConfigs || []).find(item => item.id === id);
  try {
  const termText = type => (config?.terms || []).filter(term => term.type === type).map(term => term.term).join('，');
  const sources = new Set(config?.sources || ['hot','dy','xhs','gzh','ai-gzh','ai-bili','ai-xhs','tracked']);
  const sourceOptions = await loadInspirationSources();
  const modal = document.createElement('div');
  modal.className = 'modal-mask';
  modal.innerHTML = `<div class="modal" style="max-width:760px">
    <div class="flex items-center justify-between mb-4"><h2 class="text-lg font-bold">${config ? '编辑自动主题' : '新建自动主题'}</h2><button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button></div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div><label class="text-xs text-gray-400 block mb-1">名称</label><input class="input" id="ic-name" value="${esc(config?.name || '')}" placeholder="例如：AI Agent 选题" /></div>
      <div><label class="text-xs text-gray-400 block mb-1">账号赛道</label><input class="input" id="ic-domain" value="${esc(config?.domain || '')}" placeholder="AI 工具、NAS" /></div>
      <div class="md:col-span-2"><label class="text-xs text-gray-400 block mb-1">核心关键词</label><input class="input" id="ic-core" value="${esc(termText('core'))}" placeholder="Agent，AI 编程" /></div>
      <div><label class="text-xs text-gray-400 block mb-1">白名单（升权）</label><input class="input" id="ic-white" value="${esc(termText('white'))}" placeholder="Codex，Claude Code" /></div>
      <div><label class="text-xs text-gray-400 block mb-1">黑名单（排除）</label><input class="input" id="ic-black" value="${esc(termText('black'))}" placeholder="招聘，课程广告" /></div>
      <div><label class="text-xs text-gray-400 block mb-1">CRON</label><input class="input font-mono" id="ic-cron" value="${esc(config?.cronExpr || '0 9 * * *')}" /></div>
      <div class="grid grid-cols-3 gap-2">
        <div><label class="text-xs text-gray-400 block mb-1 flex items-center gap-1">选题数<i data-lucide="help-circle" class="w-3 h-3 text-gray-500 cursor-help" title="每次 CRON 运行时最多生成几条选题"></i></label><input class="input" type="number" id="ic-count" min="1" max="12" value="${config?.ideaCount || 6}" /></div>
        <div><label class="text-xs text-gray-400 block mb-1 flex items-center gap-1">证据数<i data-lucide="help-circle" class="w-3 h-3 text-gray-500 cursor-help" title="生成每条选题时最多参考多少条证据；证据越多，选题越贴合数据源"></i></label><input class="input" type="number" id="ic-evidence" min="6" max="60" value="${config?.evidenceLimit || 20}" /></div>
        <div><label class="text-xs text-gray-400 block mb-1 flex items-center gap-1">每日 API 硬预算<i data-lucide="help-circle" class="w-3 h-3 text-gray-500 cursor-help" title="每天为自动选题最多消耗的 RedFox API 调用次数；本地数据源与 LLM 不占用此预算"></i></label><input class="input" type="number" id="ic-budget" min="0" max="30" value="${config?.dailyApiBudget ?? 3}" /></div>
      </div>
      <div>
        <label class="text-xs text-gray-400 block mb-1">公众号关键词搜索模式</label>
        <select class="input" id="ic-search-mode">
          <option value="combined" ${config?.searchMode !== 'deep' ? 'selected' : ''}>组合搜索（推荐）</option>
          <option value="deep" ${config?.searchMode === 'deep' ? 'selected' : ''}>深度搜索</option>
        </select>
      </div>
      <div class="text-[11px] text-gray-500 self-end pb-2">
        组合搜索：最多 5 个词合并为 1 次 API。深度搜索：逐词请求，3 个词最多 3 次 API。赛道只交给 LLM，不增加 API 次数。
      </div>
      <div class="md:col-span-2 text-[11px] text-gray-500">所有选题数据源共用每日硬预算。关键词结果落库复用 3 天，不会因结果少自动补查；深度搜索也不能突破预算。</div>
      <div class="md:col-span-2">
        <label class="text-xs text-gray-400 block mb-2">数据源</label>
        <div class="flex flex-wrap gap-3">${sourceOptions.map(source => `<label class="text-xs flex items-center gap-1.5" title="${esc(source.description || '')}"><input type="checkbox" class="accent-purple-500" data-ic-source="${esc(source.key)}" ${sources.has(source.key)?'checked':''}>${esc(source.label)}</label>`).join('')}</div>
      </div>
      <label class="text-xs flex items-center gap-2"><input type="checkbox" class="accent-purple-500" id="ic-enabled" ${config?.enabled !== false ? 'checked' : ''}>启用自动生成</label>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      ${config ? `<button class="btn btn-ghost text-red-400" data-action="deleteInspirationConfigUi" data-id="${config.id}">删除</button>` : ''}
      <button class="btn btn-primary" data-action="submitInspirationConfig" data-id="${config?.id || ''}">保存</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  window._inspirationConfigModal = modal;
  initIcons(modal);
  } catch (e) { toast('加载数据源失败: ' + e.message, 'error'); }
}

export function parseTermInput(id, type) {
  return document.getElementById(id).value.split(/[,，、\n]/).map(term => term.trim()).filter(Boolean).map(term => ({ term, type, manualWeight: type === 'white' ? 3 : 0 }));
}

export async function submitInspirationConfig(id) {
  const body = {
    name: document.getElementById('ic-name').value.trim(),
    domain: document.getElementById('ic-domain').value.trim(),
    cronExpr: document.getElementById('ic-cron').value.trim(),
    enabled: document.getElementById('ic-enabled').checked,
    ideaCount: Number(document.getElementById('ic-count').value),
    evidenceLimit: Number(document.getElementById('ic-evidence').value),
    dailyApiBudget: Number(document.getElementById('ic-budget').value),
    searchMode: document.getElementById('ic-search-mode').value,
    sources: [...document.querySelectorAll('[data-ic-source]:checked')].map(input => input.dataset.icSource),
    terms: [...parseTermInput('ic-core','core'), ...parseTermInput('ic-white','white'), ...parseTermInput('ic-black','black')],
  };
  try {
    const saved = await localApi(id ? `inspiration-configs/${id}` : 'inspiration-configs', { method: id ? 'PUT' : 'POST', body });
    window._inspirationConfigModal?.remove();
    const skip = saved?.skipped;
    if (skip && (skip.sources?.length || skip.terms?.length)) {
      const parts = [];
      if (skip.sources?.length) parts.push(`忽略 ${skip.sources.length} 个未知数据源`);
      if (skip.terms?.length) parts.push(`忽略 ${skip.terms.length} 个非法关键词`);
      toast(`已保存，${parts.join('，')}`, 'warning');
    } else {
      toast('主题配置已保存', 'success');
    }
    await renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}

export async function deleteInspirationConfigUi(id) {
  if (!confirm('删除该自动主题及关键词配置？已生成选题会保留。')) return;
  await localApi(`inspiration-configs/${id}`, { method: 'DELETE' });
  window._inspirationConfigModal?.remove();
  await renderSettings();
}

export async function runInspirationConfig(id) {
  try {
    toast('正在收集证据并生成选题…', 'info');
    const result = await localApi(`inspiration-configs/${id}/run`, { method: 'POST', body: {} });
    toast(result.skipped ? '证据未变化，已跳过重复生成' : `已生成 ${result.ideas.length} 个选题`, 'success');
    await renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}

export async function toggleInspirationConfig(id) {
  const config = (window._inspirationConfigs || []).find(item => item.id === id);
  if (!config) return;
  try {
    await localApi(`inspiration-configs/${id}/toggle`, { method: 'POST', body: { enabled: !config.enabled } });
    toast(config.enabled ? '已暂停自动生成' : '已恢复自动生成', 'success');
    await renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}
