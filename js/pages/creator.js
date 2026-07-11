import { api, localApi } from '../api.js';
import { LS } from '../state.js';
import { esc, safeExternalUrl, proxyImage } from '../utils.js';
import { platName } from '../config.js';
import { toast } from '../components.js';
import { gotoPage } from '../navigation.js';
import { initIcons } from '../icons.js';

let rewriteHotspots = [];
let selectedRewriteHotspot = null;
let currentCreatorMode = 'create';  // create / rewrite / adapt
const MODE_META = {
  create:  { label: '开始创作', hint: '创作模式：基于主题/大纲从零写，可适当发挥但遵守事实底线' },
  rewrite: { label: '开始重构', hint: '重构模式：在原素材基础上扩展结构和打磨，保留事实' },
  adapt:   { label: '开始改写', hint: '改写模式：直接换风格，不补充新事实，仅风格转换、句式重组' },
};

function bindPlatformSkillBadge() {
  const sel = document.getElementById('rewritePlatform');
  const badge = document.getElementById('rewrite-skill-badge');
  if (!sel || !badge || sel.dataset.bound) return;
  sel.dataset.bound = '1';
  const update = async () => {
    const opt = sel.selectedOptions[0];
    const modeAttr = currentCreatorMode === 'create' ? 'data-skill-create' : 'data-skill-rewrite';
    const slug = opt?.getAttribute(modeAttr) || opt?.dataset?.skill;
    if (!slug) { badge.classList.add('hidden'); return; }
    badge.classList.remove('hidden');
    try {
      const { data } = await localApi(`skills/${slug}`);
      if (data?.description) {
        badge.innerHTML = `<i data-lucide="book-open" class="w-2.5 h-2.5"></i> ${esc(data.description.substring(0, 60))}${data.description.length > 60 ? '…' : ''}`;
      } else {
        badge.innerHTML = `<i data-lucide="blocks" class="w-2.5 h-2.5"></i> ${slug}`;
      }
    } catch {
      badge.innerHTML = `<i data-lucide="blocks" class="w-2.5 h-2.5"></i> ${slug}`;
    }
    initIcons(badge);
  };
  sel.addEventListener('change', update);
  // 模式切换时也要更新 badge
  document.querySelectorAll('.creator-mode-tab').forEach(btn => {
    btn.addEventListener('click', update);
  });
  update();
}

function bindCreatorModeTabs() {
  document.querySelectorAll('.creator-mode-tab').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      currentCreatorMode = mode;
      document.querySelectorAll('.creator-mode-tab').forEach(b => {
        const active = b.dataset.mode === mode;
        b.classList.toggle('bg-amber-500/20', active);
        b.classList.toggle('text-amber-300', active);
        b.classList.toggle('text-gray-400', !active);
      });
      const hint = document.getElementById('creator-mode-hint');
      if (hint) hint.textContent = MODE_META[mode]?.hint || '';
      const label = document.getElementById('doRewriteLabel');
      if (label) label.textContent = MODE_META[mode]?.label || '开始';
      const ph = document.getElementById('creatorInput');
      if (ph) {
        ph.placeholder = mode === 'create'
          ? '输入主题/大纲/关键词，AI 会基于此创作全新内容...'
          : mode === 'adapt'
            ? '粘贴要换风格的原文，AI 直接改写不补充事实...'
            : '粘贴一段爆款文案，或输入一个选题关键词...';
      }
    });
  });
}

export function renderCreator() {
  const source = LS.get('creatorSource', null);
  const sourceEl = document.getElementById('creator-source');
  if (source) {
    document.getElementById('creatorInput').value = source.title + '\n\n' + (source.desc || source.summary || '');
    const metaEl = document.getElementById('creator-source-meta');
    const titleEl = document.getElementById('creator-source-title');
    if (metaEl) {
      const platLabel = source.plat === 'idea' ? '选题库' : source.plat === 'kb' ? '知识库' : platName(source.plat);
      const extra = [];
      if (source.author) extra.push(source.author);
      if (source.like || source.read) extra.push(source.like || source.read);
      metaEl.textContent = `来源：${platLabel}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
    }
    if (titleEl) titleEl.textContent = source.title || '—';
    sourceEl.classList.remove('hidden');
  } else {
    sourceEl.classList.add('hidden');
  }
  initIcons(document.getElementById('content-area'));
  loadStyleProfiles();
  bindCreatorModeTabs();
  bindPlatformSkillBadge();
}

async function loadStyleProfiles() {
  const sel = document.getElementById('rewriteStyleProfile');
  if (!sel) return;
  try {
    const accounts = await localApi('my-accounts');
    const withProfile = accounts.filter(a => a.styleProfile);
    const current = sel.value;
    sel.innerHTML = '<option value="">（不使用风格档案）</option>' +
      withProfile.map(a => `<option value="${esc(a.id)}">${esc(a.name)}（${platName(a.plat)}）</option>`).join('');
    if (current) sel.value = current;
  } catch {}
}

async function getSelectedStyleProfile() {
  const id = document.getElementById('rewriteStyleProfile')?.value;
  if (!id) return null;
  try {
    const accounts = await localApi('my-accounts');
    return accounts.find(a => a.id === id)?.styleProfile || null;
  } catch { return null; }
}

export function clearCreatorSource() {
  LS.remove('creatorSource');
  document.getElementById('creator-source').classList.add('hidden');
  toast('已清除来源绑定', 'success');
}

export function sendToCreator(item) {
  LS.set('creatorSource', item);
  toast('已发送到 AI 创作助手', 'success');
  gotoPage('creator');
}

export async function doCheckWord() {
  const text = document.getElementById('creatorInput').value.trim();
  const platform = document.getElementById('checkPlatform').value;
  if (!text) { toast('请先输入文案', 'error'); return; }
  const resultEl = document.getElementById('checkResult');
  resultEl.innerHTML = '<span class="text-gray-500">检测中…</span>';
  let data;
  try {
    data = await api('sensitiveWord', {
      platform,
      content: text,
      source: '多平台违禁词查询-GitHub',
    });
  } catch (e) {
    resultEl.innerHTML = `<span class="text-red-400">检测失败：${esc(e.message || 'RedFox 未返回有效结果')}</span>`;
    return;
  }
  if (data) {
    const inspection = inspectSensitiveHtml(data.content || data.originalContent || text);
    const types = Array.isArray(data.prohibitedWordsType)
      ? data.prohibitedWordsType
      : Object.keys(data.prohibitedWordsType || {});
    if (inspection.words.length || types.length) {
      resultEl.innerHTML = `
        <div class="rounded-lg border border-red-500/25 bg-red-500/10 p-4">
          <div class="flex items-center gap-2 text-red-300 font-semibold text-sm"><i data-lucide="shield-alert" class="w-4 h-4"></i>发现违规词</div>
          <div class="flex flex-wrap gap-1.5 mt-3">${inspection.words.map(word => `<span class="pill pill-hot">${esc(word)}</span>`).join('') || types.map(type => `<span class="pill pill-hot">${esc(type)}</span>`).join('')}</div>
          <details class="mt-3">
            <summary class="cursor-pointer text-[11px] text-gray-500">查看原文命中位置</summary>
            <div class="mt-2 leading-6 text-gray-400 whitespace-pre-wrap">${inspection.html}</div>
          </details>
        </div>`;
    } else {
      resultEl.innerHTML = `
        <div class="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-4 flex items-center gap-2 text-emerald-300 font-semibold text-sm">
          <i data-lucide="shield-check" class="w-4 h-4"></i>未发现违规词
        </div>`;
    }
    initIcons(document.getElementById('checkResult'));
  } else {
    resultEl.innerHTML = '<span class="text-red-400">检测失败，RedFox 未返回有效结果</span>';
  }
}

export function inspectSensitiveHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const words = [];
  const render = node => {
    if (node.nodeType === Node.TEXT_NODE) return esc(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const content = Array.from(node.childNodes).map(render).join('');
    if (node.classList.contains('banned-word')) {
      words.push(node.textContent.trim());
      return `<span class="banned-hit">${content}</span>`;
    }
    if (node.classList.contains('sensitive-word')) {
      words.push(node.textContent.trim());
      return `<span class="sensitive-hit">${content}</span>`;
    }
    return content;
  };
  const rendered = Array.from(doc.body.firstElementChild?.childNodes || []).map(render).join('');
  return { html: rendered, words: [...new Set(words.filter(Boolean))] };
}

export async function analyzeRewriteHotspots() {
  const text = document.getElementById('creatorInput').value.trim();
  if (!text) { toast('请先输入文章素材', 'error'); return; }
  const button = document.getElementById('hotspotAnalyzeBtn');
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>分析中…';
  initIcons(button);
  try {
    let result = await localApi('rewrite/hotspots', { method: 'POST', body: { text, allowApi: false } });
    if (result.needsApiConfirmation) {
      const approved = confirm(`本地数据库没有 ${result.dataDate} 的实时热点。是否调用 RedFox API 刷新当天热点？`);
      if (!approved) {
        toast('已取消 API 调用', 'info');
        return;
      }
      button.innerHTML = '<i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>刷新热点并分析…';
      initIcons(button);
      result = await localApi('rewrite/hotspots', { method: 'POST', body: { text, allowApi: true } });
    }
    rewriteHotspots = result.hotspots || [];
    selectedRewriteHotspot = null;
    renderRewriteHotspots(result.keywords || []);
    const source = document.getElementById('rewriteHotspotSource');
    if (source) source.textContent = result.source === 'database'
      ? `数据来源：本地数据库（${result.dataDate || '当天'}） · API 0 次 · LLM ${result.llmCalls || 0} 次`
      : `数据来源：RedFox API 刷新后落库 · API ${result.apiCalls || 0} 次 · LLM ${result.llmCalls || 0} 次`;
    toast(rewriteHotspots.length ? `找到 ${rewriteHotspots.length} 个相关热点` : '当前没有适合自然关联的热点', rewriteHotspots.length ? 'success' : 'info');
  } catch (e) {
    toast('热点分析失败：' + e.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="trending-up" class="w-3.5 h-3.5"></i>分析可蹭热点';
    initIcons(document.getElementById('content-area'));
  }
}

export async function openActionLogs() {
  try {
    const logs = await localApi('action-logs?limit=100');
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal" style="max-width:900px;max-height:86vh;overflow:auto">
      <div class="flex items-center justify-between mb-4"><div><h2 class="text-lg font-bold">调用审计日志</h2><p class="text-[11px] text-gray-500 mt-1">记录按钮或定时任务使用了数据库、RedFox API 还是 LLM。</p></div><button class="btn btn-ghost py-1 px-2" data-action="closeModal"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <div class="space-y-2">${logs.map(log => `<div class="bg-white/[0.025] rounded-lg p-3">
        <div class="flex items-center gap-2 flex-wrap"><span class="font-medium text-sm">${esc(log.action)}</span><span class="pill pill-brand">${esc(log.triggerSource)}</span><span class="pill ${log.dataSource === 'database' ? 'pill-green' : 'pill-amber'}">${esc(log.dataSource)}</span><span class="text-[10px] text-gray-600 ml-auto">${new Date(log.createdAt).toLocaleString('zh-CN')}</span></div>
        <div class="text-[11px] text-gray-500 mt-1">API ${log.apiCalls} 次 · LLM ${log.llmCalls} 次${log.detail?.keywords?.length ? ` · 关键词：${esc(log.detail.keywords.join('、'))}` : ''}</div>
      </div>`).join('') || '<div class="text-center text-gray-500 py-10">暂无日志</div>'}</div>
    </div>`;
    document.body.appendChild(modal);
    initIcons(modal);
  } catch (e) { toast(e.message, 'error'); }
}

export function renderRewriteHotspots(keywords = []) {
  const panel = document.getElementById('rewriteHotspotPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  document.getElementById('rewriteKeywords').innerHTML = keywords.map(keyword => `<span class="tag">${esc(keyword)}</span>`).join('');
  document.getElementById('rewriteHotspotList').innerHTML = rewriteHotspots.length
    ? rewriteHotspots.map((hotspot, index) => {
        const active = selectedRewriteHotspot?.id === hotspot.id;
        const btnClass = active ? 'border-amber-400 bg-amber-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]';
        return `
      <button class="w-full text-left rounded-lg border p-3 transition ${btnClass}" data-action="selectRewriteHotspot" data-index="${index}">
        <div class="flex items-start gap-2">
          <span class="pill pill-hot">${esc(hotspot.platformName)}</span>
          <div class="flex-1">
            <div class="text-sm">${esc(hotspot.title)}</div>
            <div class="text-[11px] text-gray-500 mt-1">相关度 ${hotspot.relevance} · 热度 ${esc(hotspot.hotCount)}${hotspot.angle ? ` · ${esc(hotspot.angle)}` : ''}</div>
          </div>
        </div>
      </button>`;
      }).join('')
    : '<div class="text-xs text-gray-500 py-2">当前未找到能与文章自然结合的实时热点。</div>';
}

export function selectRewriteHotspot(index) {
  selectedRewriteHotspot = rewriteHotspots[index] || null;
  renderRewriteHotspots(Array.from(document.querySelectorAll('#rewriteKeywords .tag')).map(item => item.textContent));
}

export function clearSelectedHotspot() {
  selectedRewriteHotspot = null;
  renderRewriteHotspots(Array.from(document.querySelectorAll('#rewriteKeywords .tag')).map(item => item.textContent));
}

export async function doRewrite() {
  const text = document.getElementById('creatorInput').value.trim();
  const resultEl = document.getElementById('rewriteResult');
  if (!text) { toast('请先输入素材', 'error'); return; }
  document.getElementById('rewriteTitle').value = '正在生成标题…';
  document.getElementById('rewriteIntro').value = '正在生成前言…';
  resultEl.value = '正在调用 LLM 重构内容…';
  try {
    const styleProfile = await getSelectedStyleProfile();
    const result = await localApi('rewrite', {
      method: 'POST',
      body: {
        text,
        platform: document.getElementById('rewritePlatform').value,
        tone: document.getElementById('rewriteTone').value,
        hotspot: selectedRewriteHotspot,
        styleProfile,
        mode: currentCreatorMode,
      },
    });
    document.getElementById('rewriteTitle').value = result.title || '';
    document.getElementById('rewriteIntro').value = result.intro || '';
    resultEl.value = result.content;
    toast(`已使用 ${result.model} 完成重构${result.hotspot?.title ? '，标题和前言已结合热点' : ''}`, 'success');
  } catch (e) {
    document.getElementById('rewriteTitle').value = '';
    document.getElementById('rewriteIntro').value = '';
    resultEl.value = '';
    toast(e.message, 'error');
  }
}

export function copyRewrite() {
  const title = document.getElementById('rewriteTitle').value.trim();
  const intro = document.getElementById('rewriteIntro').value.trim();
  const content = document.getElementById('rewriteResult').value.trim();
  if (!title && !intro && !content) { toast('还没有成稿', 'error'); return; }
  navigator.clipboard.writeText([title, intro, content].filter(Boolean).join('\n\n'))
    .then(() => toast('成稿已复制', 'success'))
    .catch(() => toast('复制失败', 'error'));
}

export async function exportToKb() {
  const title = document.getElementById('rewriteTitle').value.trim();
  const intro = document.getElementById('rewriteIntro').value.trim();
  const content = document.getElementById('rewriteResult').value.trim();
  if (!title && !content) { toast('还没有成稿可导出', 'error'); return; }
  const fullContent = [intro, content].filter(Boolean).join('\n\n');
  const target = document.getElementById('exportKbTarget')?.value || 'obsidian';
  try {
    const result = await localApi('kb/entries', {
      method: 'POST',
      body: { title: title || '无标题', tags: [], folder: '', content: fullContent, target },
    });
    if (result?.entry_key) {
      toast(`已导出到 ${target === 'notion' ? 'Notion' : 'Obsidian'}`, 'success');
    } else if (result?.error) {
      toast('导出失败: ' + result.error, 'error');
    } else {
      toast('导出失败', 'error');
    }
  } catch (e) {
    toast('导出失败: ' + e.message, 'error');
  }
}

export async function generateCover() {
  const content = [
    document.getElementById('rewriteTitle').value.trim(),
    document.getElementById('rewriteIntro').value.trim(),
    document.getElementById('rewriteResult').value.trim(),
  ].filter(Boolean).join('\n\n') || document.getElementById('creatorInput').value.trim();
  if (!content) { toast('请先输入素材或生成成稿', 'error'); return; }
  const platform = document.getElementById('rewritePlatform').value;
  const prompt = `为${platform}内容生成一张高点击率但不过度夸张的中文自媒体封面。主题摘要：${content.slice(0, 500)}。画面主体明确，构图留出标题区域，不要生成水印。`;
  const resultEl = document.getElementById('coverResult');
  if (!confirm('生成一张封面会消耗 RedFox 图片生成点数，确定提交吗？')) return;
  resultEl.innerHTML = '<span class="text-amber-300">正在提交图片任务…</span>';
  try {
    const submitted = await api('imageSubmit', {
      prompt,
      operation: 'generate',
      parameters: {
        modelName: 'gpt-image-2',
        n: 1,
        size: document.getElementById('coverSize').value,
        background: 'opaque',
        quality: 'medium',
        outputFormat: 'png',
      },
    });
    if (!submitted?.taskId) throw new Error('RedFox 未返回 taskId');
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const result = await api('imageResult', { taskId: submitted.taskId });
      const urls = Array.isArray(result?.imagePaths) ? result.imagePaths : result?.imagePaths ? [result.imagePaths] : [];
      if (urls.length) {
        resultEl.innerHTML = urls.map(url => `<a href="${safeExternalUrl(url)}" target="_blank" rel="noopener noreferrer"><img src="${proxyImage(url)}" class="w-full rounded-lg border border-white/10" alt="AI 封面" /></a>`).join('');
        toast('封面生成完成', 'success');
        return;
      }
      if (['failed','error'].includes(String(result?.status).toLowerCase())) throw new Error(result.failReason || '图片生成失败');
      resultEl.innerHTML = `<span class="text-gray-400">图片生成中… ${i + 1}/30</span>`;
    }
    throw new Error('任务仍在处理中，请稍后通过 taskId 查询：' + submitted.taskId);
  } catch (e) {
    resultEl.innerHTML = `<span class="text-red-400">${esc(e.message)}</span>`;
  }
}
