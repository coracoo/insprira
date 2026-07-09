import { API_CONF, PLATFORMS, platColor, platName, platCodeByName, NOTIFICATION_CHANNELS, BUILTIN_CRONS, LOCKED_CRONS } from './config.js';
import { api, localApi, setUnauthorizedHandler } from './api.js';
import { state, LS, currentPage, setCurrentPage } from './state.js';
import { esc, fmt, safeExternalUrl, renderMarkdown, renderWechatArticle, prepareMarkdownLinks, proxyImage, dateYmd, copyToClipboard } from './utils.js';
import { toast, skeleton, rankBadge, platformBadge, metrics, Modal } from './components.js';
import { initIcons } from './icons.js';
import { adaptDY, adaptXHS, adaptGZH, adaptAIGZH } from './core/adapters.js';
import { cacheItem, cacheKbEntry, addToLibraryByKey, sendToCreatorByKey, sendKbToCreatorByKey, registerItemCacheHandlers } from './core/itemCache.js';
import { renderListItem, renderCardItem } from './core/renderers.js';
import { renderSearch, doSearch, doSearchWith, showSearchHistory } from './pages/search.js';
import { renderHotlist, syncHotKeywords, renderHotTab, toggleHotPlatformCron, closeHotTab, syncHotTab, bindHotTabs, loadHotTrends, renderLlmTrends, analyzeTrends, runSnapshot, clearHotCache } from './pages/hotlist.js';
import { renderDashboard, renderFeedAndHistory } from './pages/dashboard.js';
import { renderTracker, bindTrackerGroups, syncTrackersFromServer, openAddAccountModal, submitAddAccount, addToTracker, editTracker, removeTracker, viewTracker, showTrackerWorksEmpty, syncTrackerWorks, showTrackerWorksModal, syncTrackerWorksInModal, diagnoseTracker, showDiagnosisEmpty, runDiagnosis, showDiagnosisModal, reRunDiagnosis, openGzhWork, viewTrackerTrend, toggleTrackerSortMode } from './pages/tracker.js';
import { showDetail } from './pages/detail.js';
import { renderSettings, openEnvModal, openRedfoxApply, saveEnvConfig, restartService, loadQuota, renderNotificationSettings, notificationInput, saveNotificationSettings, testNotification, cronCostMeta, renderCronList, toggleCron, runCronNow, openCronModal, submitCron, deleteCron, renderInspirationConfigs, openInspirationConfigDetail, openInspirationConfigModal, parseTermInput, submitInspirationConfig, deleteInspirationConfigUi, runInspirationConfig, toggleInspirationConfig } from './pages/settings.js';
import { renderInspiration, renderInspirationCards, onInspirationFilterChange, trashInspiration, restoreInspiration, permanentlyDeleteInspiration, updateInspirationListStatus, updateTrashSelection, toggleAllTrash, batchDeleteTrash, toggleInspirationFavorite, feedbackInspiration, generateInspirations, updateInspirationStatus, sendIdeaToCreator, clearInspirationSelection, batchFavoriteInspirations, batchTrashInspirations, toggleInspirationSourceDropdown } from './pages/inspiration.js';
import { renderKnowledgebase, renderLibrary, addToLibrary, removeFromLibrary, exportLibrary, switchKbTab, switchKbSource, renderKbLibrary, loadKbEntries, renderKbGrid, renderKbFolderTree, searchKb, openKbEntry, openKbEntryModal, analyzeKbEntry, showKbAnalysisResult, reanalyzeKbEntry, matchKbToInspirations, renderMatchedInspirations, linkKbMatchByIndex, openKbConfigModal, saveKbConfig, createKbEntry, submitKbEntry, linkKbToInspiration, linkKbPickerByIndex, sendKbToCreator, renderWersss, openWersssConfig, saveWersssConfig, addWersssSub, loadWersssAvailable, selectWersssMp, searchWersssMp, confirmAddWersssSub, removeWersssSub, syncWersss, prefetchWersss, openWersssArticle, closeWersssArticleModal, closeWersssQrModal, refreshWersssQr, forceWersssQr, selectKbFolder, toggleKbFolder } from './pages/knowledgebase.js';
import { renderCreator, sendToCreator, doCheckWord, inspectSensitiveHtml, analyzeRewriteHotspots, openActionLogs, renderRewriteHotspots, selectRewriteHotspot, clearSelectedHotspot, doRewrite, copyRewrite, exportToKb, generateCover, clearCreatorSource } from './pages/creator.js';
import { renderMyAccounts, addMyAccount, submitMyAccount, removeMyAccount, editMyAccount, extractMyTracks, extractMyStyle, viewMyStyle, presetMyInspirations, createAutoConfigs } from './pages/my.js';
import { renderSkills, filterSkills, openSkillDetail, openAgentWithSkill, checkSkillUpdates, updateCommunitySkillsUi, renderAgent, loadAgentThreads, saveAgentThreads, startNewAgentThread, switchAgentThread, clearCurrentAgentThread, deleteAgentThread, renderAgentThreads, onAgentProviderChange, formatTime, copyAgentMessage, deleteAgentMessage, regenerateAgentMessage, toggleStreamingIndicator, handleAgentInputKeydown, renderAgentMessages, showSkillCommands, insertSkillCommand, sendAgentMessage, loadSkills, clearSkillCache, bindSkillToSource, classifySkills, forceReclassifySkills } from './pages/agent.js';
import { gotoPage, refreshCurrent, doGlobalSearch, toggleSidebar, openMobileSidebar, closeMobileSidebar } from './router.js';
import { initErrorBoundary } from './errorBoundary.js';
import { loadCurrentAccount, openAccountModal, saveAccountProfile, changeAccountPassword, logoutAccount } from './account.js';
import { initTheme, toggleTheme } from './theme.js';
import { initForgeBar, setForgeState } from './forge-bar.js';

// ============= Item Cache handlers 注册 ============
registerItemCacheHandlers({
  addToLibrary,
  sendToCreator,
  sendKbToCreator,
});

initErrorBoundary();
initTheme();
initForgeBar();

// 页面加载即拉版本号，更新侧边栏（登录前也显示）
localApi('version').then(r => {
  if (r?.version) applyAppVersion(r.version);
}).catch(() => {});

window.addEventListener('popstate', (e) => {
  const hash = location.hash.replace('#', '') || 'dashboard';
  gotoPage(hash, { updateHistory: false });
});

// 在页面加载时立即拉版本号（侧边栏在登录前就显示）
function applyAppVersion(version) {
  const tag = document.querySelector('[data-app-version]');
  if (tag) tag.textContent = `v${version}`;
  const brandTitle = document.querySelector('.sidebar-brand-text .font-bold');
  if (brandTitle) brandTitle.setAttribute('title', `灵感熔炉 v${version}`);
}

function activateApp() {
  document.getElementById('page-login').classList.remove('active');
  document.getElementById('page-app').classList.add('active');
  const hashPage = location.hash.replace('#', '');
  const initialPage = !hashPage || hashPage === 'login' ? 'dashboard' : hashPage;
  gotoPage(initialPage, { replaceHistory: true });
  localApi('version').then(r => {
    if (r?.version) applyAppVersion(r.version);
  }).catch(() => {});
  syncTrackersFromServer().then(() => {
    const navCount = document.getElementById('nav-tracker-count');
    if (navCount) navCount.textContent = LS.get('trackers', []).length;
    if (currentPage === 'dashboard') renderFeedAndHistory();
    if (currentPage === 'tracker') renderTracker();
  });
  localApi('inspirations/count').then(summary => {
    const navCount = document.getElementById('nav-inspiration-count');
    if (navCount) navCount.textContent = summary.active || 0;
  }).catch(error => {
    if (error.name !== 'AbortError') console.warn('灵感统计加载失败：', error.message);
  });
  localApi('skills').then(skills => {
    const navCount = document.getElementById('nav-skill-count');
    if (navCount) navCount.textContent = Array.isArray(skills) ? skills.length : 0;
  }).catch(error => {
    if (error.name !== 'AbortError') console.warn('Skill 列表加载失败：', error.message);
  });
  loadCurrentAccount({ promptPasswordChange: true }).catch(error => {
    if (error.name !== 'AbortError') console.warn('账户信息加载失败：', error.message);
  });
  checkApi();
}

async function tryAutoLogin() {
  const savedUser = localStorage.getItem('furnace_user') || '';
  localStorage.removeItem('furnace_pass');
  document.getElementById('loginUser').value = savedUser;
  clearLoginPassword();
  try {
    const status = await localApi('status');
    if (!status?.authenticated) return false;
    activateApp();
    return true;
  } catch {
    return false;
  }
}

async function enterApp() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  try {
    await localApi('login', { method: 'POST', body: { username, password } });
    localStorage.setItem('furnace_user', username);
    localStorage.removeItem('furnace_pass');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  document.getElementById('loginPass').value = '';
  activateApp();
}

function clearLoginPassword() {
  const password = document.getElementById('loginPass');
  if (password && document.activeElement !== password) password.value = '';
}

// 检测 API 状态
async function checkApi() {
  let status = null;
  try { status = await localApi('status'); } catch {}
  const el = document.getElementById('api-status');
  const pill = document.getElementById('api-status-pill');
  if (status?.redfoxConfigured) {
    el.textContent = 'API 在线';
    if (pill) pill.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i>在线';
  } else {
    el.textContent = 'API 异常';
    if (pill) { pill.className = 'pill pill-hot'; pill.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>离线'; }
  }
  initIcons();
}

// ============= Action Registry ============
const actions = new Map();
function registerAction(name, fn) { actions.set(name, fn); }

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // 表单控件（checkbox/radio/select/input/textarea）让浏览器默认处理，不拦截
  const tag = e.target.tagName;
  if (['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(tag)) return;
  const handler = actions.get(el.dataset.action);
  if (!handler) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    Promise.resolve(handler(el, el.dataset)).catch(error => {
      console.error(`[action:${el.dataset.action}]`, error);
      toast(error?.message || '操作失败', 'error');
    });
  } catch (error) {
    console.error(`[action:${el.dataset.action}]`, error);
    toast(error?.message || '操作失败', 'error');
  }
});

// ============= 表单事件委托 ============
document.getElementById('globalSearch')?.addEventListener('keypress', e => {
  if (e.key === 'Enter') doGlobalSearch();
});
document.getElementById('login-form')?.addEventListener('submit', e => {
  e.preventDefault();
  enterApp();
});
window.addEventListener('pageshow', () => {
  clearLoginPassword();
  setTimeout(clearLoginPassword, 100);
});

document.addEventListener('change', e => {
  if (e.target.id === 'trendDays') { loadHotTrends(); return; }
  if (e.target.id === 'inspirationFilter') { onInspirationFilterChange(); return; }
  if (e.target.id === 'trash-select-all') { toggleAllTrash(e.target.checked); return; }
  if (e.target.id === 'kb-source-select') { switchKbSource(e.target.value); return; }
  if (e.target.id === 'kb-filter-folder' || e.target.id === 'kb-filter-tag') { searchKb(); return; }
  if (e.target.id === 'skillCategory') { filterSkills(); return; }
  if (e.target.id === 'agentProvider') { onAgentProviderChange(e.target.value); return; }
  const statusSel = e.target.closest('.inspiration-status-select');
  if (statusSel) { updateInspirationStatus(statusSel.dataset.id, statusSel.value); return; }
  const cronToggle = e.target.closest('.cron-toggle');
  if (cronToggle) { toggleCron(cronToggle.dataset.cronId, cronToggle.checked); return; }
  const trashSel = e.target.closest('.trash-select');
  if (trashSel) { updateTrashSelection(); }
});

document.addEventListener('input', e => {
  if (e.target.id === 'kb-search') searchKb();
  else if (e.target.id === 'skillSearch') filterSkills();
  else if (e.target.id === 'agentInput') showSkillCommands();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const masks = document.querySelectorAll('.modal-mask');
    const top = masks[masks.length - 1];
    if (top) top.remove();
  }
  if (e.target.id === 'agentInput') handleAgentInputKeydown(e);
  else if (e.target.id === 'searchInput' && e.key === 'Enter') {
    e.preventDefault();
    doSearch();
  }
});

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-mask')) {
    e.target.remove();
  }
});

document.addEventListener('error', e => {
  const image = e.target;
  if (!(image instanceof HTMLImageElement)) return;
  const strategy = image.dataset.imageError;
  if (!strategy) return;
  if (strategy === 'remove') {
    image.remove();
    return;
  }
  image.classList.add('hidden');
  if (strategy !== 'placeholder') return;
  const parent = image.parentElement;
  if (!parent || parent.querySelector('[data-image-fallback-icon]')) return;
  const fallbackText = image.dataset.fallbackText;
  if (fallbackText) {
    const label = document.createElement('span');
    label.className = image.dataset.fallbackClass || 'text-[10px] font-medium text-gray-300';
    label.textContent = fallbackText;
    parent.appendChild(label);
    return;
  }
  parent.classList.add('flex', 'items-center', 'justify-center');
  const icon = document.createElement('i');
  icon.dataset.lucide = image.dataset.fallbackIcon || 'image';
  icon.dataset.imageFallbackIcon = '';
  icon.className = image.dataset.fallbackIconClass || 'w-12 h-12 text-white/30';
  parent.appendChild(icon);
  initIcons(parent);
}, true);

// ============= 注册 data-action ============
registerAction('enterApp', () => enterApp());
registerAction('doGlobalSearch', () => doGlobalSearch());
registerAction('refreshCurrent', () => refreshCurrent());
registerAction('toggleSidebar', () => toggleSidebar());
registerAction('openMobileSidebar', () => openMobileSidebar());
registerAction('closeMobileSidebar', () => closeMobileSidebar());
registerAction('toggleTheme', () => { toggleTheme(); initIcons(document.body); });
registerAction('gotoPage', (el) => gotoPage(el.dataset.page));
registerAction('doSearch', () => doSearch());
registerAction('goBackOrFallback', (_, d) => history.length > 1 ? history.back() : gotoPage(d.fallbackPage || 'dashboard'));
registerAction('openAddAccountModal', () => openAddAccountModal());
registerAction('runSnapshot', () => runSnapshot());
registerAction('generateInspirations', () => generateInspirations());
registerAction('toggleInspirationSourceDropdown', (el) => toggleInspirationSourceDropdown(el));
registerAction('renderInspiration', () => renderInspiration());
registerAction('batchDeleteTrash', () => batchDeleteTrash());
registerAction('clearInspirationSelection', () => clearInspirationSelection());
registerAction('batchFavoriteInspirations', () => batchFavoriteInspirations());
registerAction('batchTrashInspirations', () => batchTrashInspirations());
registerAction('showDetail', (_, d) => showDetail(d.plat, d.workId));
registerAction('addToTracker', (_, d) => addToTracker(d.plat, d.author, d.authorId));
registerAction('addToLibraryByKey', (_, d) => addToLibraryByKey(d.key));
registerAction('sendToCreatorByKey', (_, d) => sendToCreatorByKey(d.key));
registerAction('doSearchWith', (_, d) => doSearchWith(d.kw));
registerAction('refreshSearch', () => {
  const kw = document.getElementById('searchInput')?.value.trim();
  if (kw) doSearchWith(kw, { refresh: true });
});
registerAction('removeTracker', (_, d) => removeTracker(d.id));
registerAction('editTracker', (_, d) => editTracker(d.id));
registerAction('syncHotKeywords', () => syncHotKeywords());
registerAction('syncHotTab', (_, d) => syncHotTab(d.tab));
registerAction('toggleHotPlatformCron', (_, d) => toggleHotPlatformCron(d.cronId, d.enabled === 'true', d.tab));
registerAction('closeHotTab', (_, d) => closeHotTab(d.cronId, d.tab));
registerAction('analyzeTrends', () => analyzeTrends());
registerAction('restoreInspiration', (_, d) => restoreInspiration(d.id));
registerAction('permanentlyDeleteInspiration', (_, d) => permanentlyDeleteInspiration(d.id));
registerAction('toggleInspirationFavorite', (_, d) => toggleInspirationFavorite(d.id, d.favorite === 'true'));
registerAction('feedbackInspiration', (_, d) => feedbackInspiration(d.id, d.state));
registerAction('trashInspiration', (_, d) => trashInspiration(d.id));
registerAction('sendIdeaToCreator', (_, d) => sendIdeaToCreator(d.id));
registerAction('viewTracker', (_, d) => viewTracker(d.id));
registerAction('diagnoseTracker', (_, d) => diagnoseTracker(d.id));
registerAction('viewTrackerTrend', (_, d) => viewTrackerTrend(d.id));
registerAction('toggleTrackerSortMode', () => toggleTrackerSortMode());
registerAction('submitAddAccount', () => submitAddAccount());
registerAction('syncTrackerWorksAndClose', (el, d) => { el.closest('.modal-mask')?.remove(); syncTrackerWorks(d.id); });
registerAction('syncTrackerWorksInModal', (_, d) => syncTrackerWorksInModal(d.id, d.plat));
registerAction('showDetailAndCloseModal', (el, d) => { showDetail(d.plat, d.workId); el.closest('.modal-mask')?.remove(); });
registerAction('runDiagnosisAndClose', (el, d) => { el.closest('.modal-mask')?.remove(); runDiagnosis(d.id); });
registerAction('reRunDiagnosis', (_, d) => reRunDiagnosis(d.id));
registerAction('openGzhWork', (_, d) => openGzhWork(d.workId, d.biz, d.mid, d.url));
registerAction('copyToClipboard', (_, d) => copyToClipboard(d.text, { onSuccess: () => toast('链接已复制', 'success'), onError: () => toast('复制失败', 'error') }));
registerAction('sendKbToCreatorByKey', (_, d) => sendKbToCreatorByKey(d.key));
registerAction('removeFromLibrary', (_, d) => removeFromLibrary(d.plat, d.workId));
registerAction('openKbEntry', (_, d) => openKbEntry(Number(d.index)));
registerAction('selectKbFolder', (el, d) => selectKbFolder(el, d));
registerAction('toggleKbFolder', (el, d) => toggleKbFolder(el, d));
registerAction('linkKbToInspiration', () => linkKbToInspiration());
registerAction('matchKbToInspirations', (el) => matchKbToInspirations(el));
registerAction('analyzeKbEntry', (el) => analyzeKbEntry(el));
registerAction('sendKbToCreatorActive', () => sendKbToCreator(window._activeKbEntry));
registerAction('clearCreatorSource', () => clearCreatorSource());
registerAction('addMyAccount', () => addMyAccount());
registerAction('submitMyAccount', () => submitMyAccount());
registerAction('removeMyAccount', (el, d) => removeMyAccount(el, d));
registerAction('editMyAccount', (el, d) => editMyAccount(el, d));
registerAction('extractMyTracks', (el, d) => extractMyTracks(el, d));
registerAction('extractMyStyle', (el, d) => extractMyStyle(el, d));
registerAction('viewMyStyle', (el, d) => viewMyStyle(el, d));
registerAction('presetMyInspirations', (el, d) => presetMyInspirations(el, d));
registerAction('createAutoConfigs', () => createAutoConfigs());
registerAction('reanalyzeKbEntry', () => reanalyzeKbEntry());
registerAction('linkKbMatchByIndex', (_, d) => linkKbMatchByIndex(Number(d.index)));
registerAction('saveKbConfig', () => saveKbConfig());
registerAction('submitKbEntry', () => submitKbEntry());
registerAction('linkKbPickerByIndex', (_, d) => linkKbPickerByIndex(Number(d.index)));
registerAction('switchKbTab', (el, d) => switchKbTab(el, d));
registerAction('loadKbEntries', (_, d) => loadKbEntries(null, null, null, d.reload === 'true'));
registerAction('createKbEntry', () => createKbEntry());
registerAction('openKbConfigModal', () => openKbConfigModal());
registerAction('openWersssConfig', () => openWersssConfig());
registerAction('saveWersssConfig', () => saveWersssConfig());
registerAction('addWersssSub', () => addWersssSub());
registerAction('loadWersssAvailable', () => loadWersssAvailable());
registerAction('selectWersssMp', (el, d) => selectWersssMp(el, d));
registerAction('searchWersssMp', () => searchWersssMp());
registerAction('confirmAddWersssSub', (el, d) => confirmAddWersssSub(el, d));
registerAction('removeWersssSub', (el, d) => removeWersssSub(el, d));
registerAction('syncWersss', (el, d) => syncWersss(el, d));
registerAction('prefetchWersss', () => prefetchWersss());
registerAction('forceWersssQr', () => forceWersssQr());
registerAction('openWersssArticle', (el, d) => openWersssArticle(el, d));
registerAction('closeWersssArticleModal', (el) => closeWersssArticleModal(el));
registerAction('closeWersssQrModal', () => closeWersssQrModal());
registerAction('refreshWersssQr', () => refreshWersssQr());
registerAction('doCheckWord', () => doCheckWord());
registerAction('analyzeRewriteHotspots', () => analyzeRewriteHotspots());
registerAction('openActionLogs', () => openActionLogs());
registerAction('clearSelectedHotspot', () => clearSelectedHotspot());
registerAction('doRewrite', () => doRewrite());
registerAction('copyRewrite', () => copyRewrite());
registerAction('exportToKb', () => exportToKb());
registerAction('generateCover', () => generateCover());
registerAction('selectRewriteHotspot', (_, d) => selectRewriteHotspot(Number(d.index)));
registerAction('openSkillDetail', (_, d) => openSkillDetail(d.slug));
registerAction('openAgentWithSkill', (_, d) => openAgentWithSkill(d.slug));
registerAction('bindSkillToSource', (el, d) => bindSkillToSource(el, d));
registerAction('classifySkills', () => classifySkills());
registerAction('forceReclassifySkills', () => forceReclassifySkills());
registerAction('checkSkillUpdates', () => checkSkillUpdates(true));
registerAction('updateCommunitySkills', () => updateCommunitySkillsUi());
registerAction('closeModalAndOpenAgentWithSkill', (el, d) => { el.closest('.modal-mask')?.remove(); openAgentWithSkill(d.slug); });
registerAction('switchAgentThread', (_, d) => switchAgentThread(d.id));
registerAction('deleteAgentThread', (_, d) => deleteAgentThread(d.id));
registerAction('copyAgentMessage', (_, d) => copyAgentMessage(Number(d.index)));
registerAction('regenerateAgentMessage', (_, d) => regenerateAgentMessage(Number(d.index)));
registerAction('deleteAgentMessage', (_, d) => deleteAgentMessage(Number(d.index)));
registerAction('insertSkillCommand', (_, d) => insertSkillCommand(d.slug));
registerAction('startNewAgentThread', () => startNewAgentThread());
registerAction('clearCurrentAgentThread', () => clearCurrentAgentThread());
registerAction('sendAgentMessage', () => sendAgentMessage());
registerAction('openInspirationConfigModal', (_, d) => openInspirationConfigModal(d.id || ''));
registerAction('openEnvModal', () => openEnvModal());
registerAction('openRedfoxApply', () => openRedfoxApply());
registerAction('restartService', () => restartService());
registerAction('openAccountModal', () => openAccountModal());
registerAction('saveAccountProfile', () => saveAccountProfile());
registerAction('changeAccountPassword', () => changeAccountPassword());
registerAction('logoutAccount', () => logoutAccount());
registerAction('loadQuota', () => loadQuota());
registerAction('openCronModal', (_, d) => openCronModal(d.id || ''));
registerAction('saveNotificationSettings', () => saveNotificationSettings());
registerAction('saveEnvConfig', () => saveEnvConfig());
registerAction('testNotification', (_, d) => testNotification(d.key));
registerAction('runCronNow', (_, d) => runCronNow(d.id));
registerAction('deleteCron', (_, d) => deleteCron(d.id));
registerAction('openInspirationConfigDetail', (_, d) => openInspirationConfigDetail(d.id));
registerAction('runInspirationConfig', (_, d) => runInspirationConfig(d.id));
registerAction('toggleInspirationConfig', (_, d) => toggleInspirationConfig(d.id));
registerAction('deleteInspirationConfigUi', (_, d) => deleteInspirationConfigUi(d.id));
registerAction('submitInspirationConfig', (_, d) => submitInspirationConfig(d.id || ''));
registerAction('submitCron', (_, d) => submitCron(d.id || ''));
registerAction('closeModalAndOpenInspirationConfigModal', (el, d) => { el.closest('.modal-mask')?.remove(); openInspirationConfigModal(d.id); });
registerAction('closeModalAndRunInspirationConfig', (el, d) => { el.closest('.modal-mask')?.remove(); runInspirationConfig(d.id); });
registerAction('closeModalAndToggleInspirationConfig', (el, d) => { el.closest('.modal-mask')?.remove(); toggleInspirationConfig(d.id); });
registerAction('closeModal', (el) => el.closest('.modal-mask')?.remove());
registerAction('stopPropagation', () => {});

// 启动
initIcons();
tryAutoLogin().then(() => checkApi());

// 401 统一处理
setUnauthorizedHandler(() => {
  toast('登录已过期，请重新登录', 'error');
  gotoPage('login', { replaceHistory: true });
});
