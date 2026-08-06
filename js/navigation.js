import { setCurrentPage } from './state.js';
import { initIcons } from './icons.js';
import { cancelAllApi } from './api.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderHotlist } from './pages/hotlist.js';
import { renderInspiration } from './pages/inspiration.js';
import { renderSearch } from './pages/search.js';
import { renderTracker } from './pages/tracker.js';
import { renderKnowledgebase } from './pages/knowledgebase.js';
import { renderCreator } from './pages/creator.js';
import { renderSkills } from './pages/agent.js';
import { renderAgent } from './pages/agent.js';
import { renderSettings } from './pages/settings.js';

export const PAGES = {
  dashboard: { tpl: 'tpl-dashboard', init: renderDashboard },
  hotlist:   { tpl: 'tpl-hotlist',   init: () => renderHotlist() },
  inspiration: { tpl: 'tpl-inspiration', init: renderInspiration },
  search:    { tpl: 'tpl-search',    init: renderSearch },
  detail:    { tpl: 'tpl-detail' },
  tracker:   { tpl: 'tpl-tracker',   init: renderTracker },
  library:   { tpl: 'tpl-library',   init: renderKnowledgebase },
  knowledgebase: { tpl: 'tpl-library', init: renderKnowledgebase },
  creator:   { tpl: 'tpl-creator',   init: renderCreator },
  skills:    { tpl: 'tpl-skills',    init: renderSkills },
  agent:     { tpl: 'tpl-agent',     init: renderAgent },
  settings:  { tpl: 'tpl-settings',  init: renderSettings },
};

export function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
  const oldIcon = document.querySelector('.sidebar-collapse-icon');
  if (oldIcon && oldIcon.parentElement) {
    const name = document.body.classList.contains('sidebar-collapsed') ? 'panel-left-open' : 'panel-left-close';
    const newIcon = document.createElement('i');
    newIcon.setAttribute('data-lucide', name);
    newIcon.className = 'w-5 h-5 sidebar-collapse-icon';
    oldIcon.parentElement.replaceChild(newIcon, oldIcon);
    initIcons(newIcon.parentElement);
  }
}

export function openMobileSidebar() {
  document.body.classList.add('mobile-sidebar-open');
}

export function closeMobileSidebar() {
  document.body.classList.remove('mobile-sidebar-open');
}

export function gotoPage(page, options = {}) {
  const { updateHistory = true, replaceHistory = false } = options;
  const p = page === 'library' ? 'knowledgebase' : page;
  closeMobileSidebar();
  if (p === 'login') {
    document.getElementById('page-login').classList.add('active');
    document.getElementById('page-app').classList.remove('active');
    if (updateHistory) {
      const method = replaceHistory ? 'replaceState' : 'pushState';
      history[method]({ page: p }, '', '#' + p);
    }
    return;
  }
  const cfg = PAGES[p]; if (!cfg) return;
  cancelAllApi();
  document.getElementById('modal-host').innerHTML = '';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const nav = document.querySelector(`.nav-item[data-page="${p}"]`);
  if (nav) nav.classList.add('active');
  const tpl = document.getElementById(cfg.tpl);
  const host = document.getElementById('content-area');
  host.innerHTML = '';
  host.appendChild(tpl.content.cloneNode(true));
  setCurrentPage(p);
  if (cfg.init) cfg.init();
  initIcons(host);
  if (updateHistory) {
    const method = replaceHistory ? 'replaceState' : 'pushState';
    history[method]({ page: p }, '', '#' + p);
  }
}
