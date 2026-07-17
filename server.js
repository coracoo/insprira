// 灵感熔炉 · 本地服务、RedFox 代理、SQLite 数据仓库
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const Database = require('better-sqlite3');

const { scanVault, readEntry, writeNote, updateNote, deleteNote, listFolders, listAllTags } = require('./kb_obsidian');
const { searchPages, getPage, createPage, updatePage, deletePage } = require('./kb_notion');
const wersss = require('./kb_wersss');

const {
  parseJson, stableObject, toNumber, localDate, dateDaysAgo, dateFromYmd,
  workPublishAt, workContentKey, gitBlobSha, parseAgentJsonLines,
} = require('./lib/utils');
const { parseCronExpr, validateCronField, nextCronTime, matchesCronField } = require('./lib/cron-parser');
const {
  PASSWORD_SCRYPT_OPTIONS, hashPassword, verifyPassword, validateUsername, validatePassword,
} = require('./lib/password');
const {
  EDITABLE_ENV_KEYS, loadEnvFile, readEnvValues, publicEnvConfig, updateEnvConfig, restartCurrentService,
} = require('./lib/env');
const { serveStatic: serveStaticFromLib } = require('./lib/static');
const {
  REDFOX_HOST, REDFOX_PATH_PREFIX, API_KEY,
  REDFOX_ENDPOINTS, CACHE_TTL, AI_FEED_PLATFORMS,
  getCacheKey, getCached, isCacheableRedfoxResponse, setCache, logApiUsage,
  redfoxRequest, redfoxData, redfoxGetData,
} = require('./lib/redfox');
const {
  sessions, sessionSet, sessionDel, sessionGet, sessionClean,
  getCookies, publicUser, currentSession, isAuthorized,
  KB_ENC_INSECURE, encryptKb, decryptKb,
} = require('./lib/auth');
const {
  HOTSPOT_LISTS,
  normalizeSnapshotItems,
  normalizeHotspots,
  normalizeRealtimeHotspots,
} = require('./lib/normalize');
const { MAX_BODY_SIZE, json, readBody } = require('./lib/http');
const {
  getWersssConfigRow, getWersssConfig, getValidWersssToken,
  getWersssAuthStatus, syncWersssArticles, prefetchWersssContent,
} = require('./lib/wersss');
const notifLib = require('./lib/notifications');
const { NOTIFICATION_CHANNELS, sendNotification } = notifLib;
const { notificationConfigs, publicNotificationConfigs, saveNotificationConfigs } = notifLib.makeHelpers(
  () => getLocalData('settings', 'notifications') || {},
  (module, key, data, expiresAt) => setLocalData(module, key, data, expiresAt),
);
const { clamp, logAction, listActionLogs, usageSummary, getOfficialQuota: getOfficialQuotaRaw } = require('./lib/observability');
const getOfficialQuota = () => getOfficialQuotaRaw(REDFOX_HOST, REDFOX_WEB_COOKIE);
const llmLib = require('./lib/llm');
const { parseLlmJson, WEB_SEARCH_TOOL } = llmLib;
// doDoubaoWebSearch / formatDoubaoSearchResults 是 hoisted function declarations，
// 闭包在运行时解析；可在此处构造 TOOL_FUNCTIONS
const TOOL_FUNCTIONS = {
  web_search: async (args) => {
    const query = args?.query || args?.q || args?.search_query || '';
    if (!query) return JSON.stringify({ error: 'web_search 需要提供 query 参数' });
    try {
      const data = await doDoubaoWebSearch(query);
      logAction('web_search', 'function-call', 'redfox-api', { query }, 1, 0);
      return formatDoubaoSearchResults(data);
    } catch (e) {
      return JSON.stringify({ error: `web_search 失败: ${e.message}` });
    }
  },
};
const { callLlm, callLlmJson } = llmLib.make(TOOL_FUNCTIONS);
const { getLocalData, setLocalData } = require('./lib/local-data');
const {
  EXTRA_BIN_DIRS, EXTENDED_PATH, runProcess,
  resolveExecutable, locateExecutable, findNestedString,
} = require('./lib/exec');

const APP_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

const execFileAsync = promisify(execFile);

const ENV_FILE = path.join(__dirname, '.env');
loadEnvFile(ENV_FILE);

// 时区：必须放在最早期，影响所有 new Date()、cron 调度与 data_date 边界
// 必须在任何 Date 方法（getHours/getDate 等）被调用前执行
const USER_TIMEZONE = process.env.USER_TIMEZONE || 'Asia/Shanghai';
if (process.env.TZ !== USER_TIMEZONE) process.env.TZ = USER_TIMEZONE;

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== 'false';
const REDFOX_WEB_COOKIE = process.env.REDFOX_WEB_COOKIE || '';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const { db, ensureColumn, DATA_ROOT } = require('./lib/db');
const SKILLS_ROOT = path.join(DATA_ROOT, 'skills', 'redfox-community', 'skills');
const SKILLS_REPO_ROOT = path.dirname(SKILLS_ROOT);
const SKILLS_GITHUB_REPO = 'redfox-data/redfox-community';
const SKILLS_NEW_BADGE_MS = 7 * 24 * 60 * 60 * 1000;
// skills 模块工厂：HOT_SOURCE_CONFIG / cronTimers / scheduleCronJob 在后文声明，
// 通过 getter 注入避免 TDZ；其余依赖（SKILLS_* / getLocalData / setLocalData /
// callLlm / callLlmJson / execFileAsync）此时已可用（hoisted 或前文 const）
const skillsLib = require('./lib/skills').make({
  SKILLS_ROOT, SKILLS_REPO_ROOT, SKILLS_GITHUB_REPO, SKILLS_NEW_BADGE_MS,
  rootDir: __dirname,
  HOT_SOURCE_CONFIG: () => HOT_SOURCE_CONFIG,
  cronTimers: () => cronTimers,
  scheduleCronJob,
  getLocalData, setLocalData,
  callLlm, callLlmJson,
  execFileAsync,
});
const {
  parseSkillFile, skillUpdateState, getSkillSourceBinding, bindSkillToSource,
  classifyAllSkills, listSkills, invalidateSkillCache, getSkill,
  localSkillManifest, remoteSkillManifest, compareSkillManifests,
  communitySkillUpdateStatus, updateCommunitySkills,
} = skillsLib;
const agentLib = require('./lib/agent').make({
  rootDir: __dirname,
  SKILLS_ROOT,
  getSkill,
  bins: { CODEX_BIN, CLAUDE_BIN, KIMI_BIN, OPENCLAW_BIN, HERMES_BIN },
});
const { listLocalAgents, executeAgent, runLocalAgent } = agentLib;
const hotLib = require('./lib/hot');
const {
  HOT_SOURCE_CONFIG, hotBatchId, saveHotBatch, latestHotBatch,
  platformCronId, hotListPayload, normalizeDailyPlatformItems,
  latestAiGzhDataDate, recoverAiGzhFallbackBatches, localDateTime,
} = hotLib;
const {
  syncDailyPlatform, captureHotSnapshot, analyzeDailyHotKeywords,
  getHotTrends, analyzeHotTrendsLlm, buildDailyHotReport,
  sendDailyHotReport, syncRealtimeHotspots,
} = hotLib.make({
  callLlmJson,
  broadcastNotification: (title, message) => notifLib.broadcastNotification(notificationConfigs, title, message),
});
const { findRewriteHotspots, rewriteForPlatform } = require('./lib/rewrite').make({
  callLlmJson,
  getSkill,
  syncRealtimeHotspots,
  latestHotBatch,
});
recoverAiGzhFallbackBatches();
const WECHAT_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'wechat-account-analyzer');
const DOUYIN_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'douyin-account-diagnosis');
const XHS_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'xiaohongshu-account-analyzer');
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '123456';

// DB schema + ensureColumn 已移到 lib/db.js；DATA_ROOT / db 通过 require 获取
sessionClean();
db.transaction(() => {
  const update = db.prepare('UPDATE tracked_accounts SET raw_info = ? WHERE id = ?');
  for (const row of db.prepare("SELECT id, raw_info FROM tracked_accounts WHERE raw_info LIKE '%红狐指数%'").all()) {
    const raw = parseJson(row.raw_info) || {};
    if (!String(raw.authorFans || '').startsWith('红狐指数')) continue;
    delete raw.authorFans;
    update.run(JSON.stringify(raw), row.id);
  }
})();
db.transaction(() => {
  const rows = db.prepare(`
    SELECT account_id, plat, work_id, work_data, synced_at
    FROM account_works
    WHERE publish_at IS NULL OR content_key IS NULL
    ORDER BY synced_at DESC
  `).all();
  const seen = new Set();
  const update = db.prepare(`
    UPDATE account_works SET publish_at = ?, content_key = ?
    WHERE account_id = ? AND plat = ? AND work_id = ?
  `);
  const remove = db.prepare(`
    DELETE FROM account_works WHERE account_id = ? AND plat = ? AND work_id = ?
  `);
  for (const row of rows) {
    const work = parseJson(row.work_data);
    if (!work) continue;
    const contentKey = workContentKey(work);
    const uniqueKey = `${row.account_id}:${row.plat}:${contentKey}`;
    if (seen.has(uniqueKey)) {
      remove.run(row.account_id, row.plat, row.work_id);
      continue;
    }
    seen.add(uniqueKey);
    update.run(workPublishAt(work), contentKey, row.account_id, row.plat, row.work_id);
  }
})();

function migrateLegacyHotSnapshots() {
  if (getLocalData('hot', 'batch-migration-v1')) return;
  const groups = db.prepare(`
    SELECT platform, snapshot_date, captured_at
    FROM hot_snapshots
    GROUP BY platform, snapshot_date, captured_at
    ORDER BY captured_at ASC
  `).all();
  const insertBatch = db.prepare(`
    INSERT OR IGNORE INTO hot_batches
      (id, platform, data_date, snapshot_kind, endpoint, request_json, response_json,
       status, item_count, started_at, completed_at)
    VALUES (?, ?, ?, 'legacy', 'legacy/hot_snapshots', '{}', ?, 'success', ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO hot_batch_items
      (batch_id, rank, item_key, title, score, raw_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const group of groups) {
      const rows = db.prepare(`
        SELECT rank, item_key, title, score, raw_data
        FROM hot_snapshots
        WHERE platform = ? AND snapshot_date = ? AND captured_at = ?
        ORDER BY rank ASC
      `).all(group.platform, group.snapshot_date, group.captured_at);
      const batchId = `legacy-${crypto.createHash('sha1').update(
        `${group.platform}:${group.snapshot_date}:${group.captured_at}`,
      ).digest('hex').slice(0, 24)}`;
      insertBatch.run(
        batchId,
        group.platform,
        group.snapshot_date,
        JSON.stringify(rows.map(row => parseJson(row.raw_data))),
        rows.length,
        group.captured_at,
        group.captured_at,
      );
      for (const row of rows) {
        insertItem.run(batchId, row.rank, row.item_key, row.title, row.score, row.raw_data);
      }
    }
    setLocalData('hot', 'batch-migration-v1', { migratedAt: Date.now(), groups: groups.length });
  })();
}
migrateLegacyHotSnapshots();

// 注册默认定时任务
function registerDefaultCrons() {
  const defaults = [
    { id: 'hot-realtime', name: '全网实时热点刷新', cron_expr: '0 8,14,18,20 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-realtime', task_config: null },
    { id: 'hot-daily-dy', name: '抖音昨日 TOP50', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'dy' } },
    { id: 'hot-daily-xhs', name: '小红书昨日 TOP50', cron_expr: '0 12,20 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'xhs' } },
    { id: 'hot-daily-gzh', name: '公众号昨日 TOP50', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'gzh' } },
    { id: 'hot-trend-analysis', name: '昨日热点关键词趋势分析', cron_expr: '0 23 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-trend-analysis', task_config: null },
    { id: 'hot-daily-report', name: '每日热榜日报推送', cron_expr: '30 9 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'daily-hot-report', task_config: null },
    { id: 'tracked-account-daily', name: '勾选账号昨日数据刷新', cron_expr: '0 7 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'tracker-refresh', task_config: null },
    { id: 'cache-clean', name: 'API缓存清理', cron_expr: '*/10 * * * *', enabled: 1, task_type: 'cache-clean' },
    { id: 'usage-clean', name: 'API 用量日志清理', cron_expr: '0 0 * * *', enabled: 1, task_type: 'usage-clean' },
    { id: 'wersss-sync', name: 'WeRss 公众号文章同步', cron_expr: '0 8 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'wersss-sync', task_config: null },
  ];
  const now = Date.now();
  // 系统固定任务允许配置演进（UPSERT），基础热榜 tab 任务只在首次安装时初始化一次，
  // 之后用户可在 Skill 中心解绑/重新绑定；删除后重启不再自动恢复。
  const upsert = db.prepare(`
    INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_type = excluded.task_type,
      task_config = excluded.task_config,
      sort_order = CASE WHEN COALESCE(crontab.sort_order, 0) = 0 THEN excluded.sort_order ELSE crontab.sort_order END
  `);
  const hotTabInsert = db.prepare(`
    INSERT OR IGNORE INTO crontab (id, name, cron_expr, enabled, task_type, task_config, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const hotTabsInitialized = db.prepare("SELECT data_json FROM local_data WHERE module = 'system' AND data_key = 'default_hot_tabs_initialized'").get();
  const fixHotTabSort = db.prepare(`
    UPDATE crontab SET sort_order = ? WHERE id = ? AND COALESCE(sort_order, 0) = 0
  `);
  db.prepare("DELETE FROM crontab WHERE id = 'daily-snapshot'").run();
  defaults.forEach((d, idx) => {
    const isHotTab = d.task_type === 'hot-platform';
    if (isHotTab) {
      if (!hotTabsInitialized) {
        hotTabInsert.run(
          d.id,
          d.name,
          d.cron_expr,
          d.enabled,
          d.task_type,
          d.task_config ? JSON.stringify(d.task_config) : null,
          idx * 10,
          now,
        );
      }
      // 已存在但 sort_order 为 0 时补一个默认顺序（不覆盖用户拖拽结果）
      fixHotTabSort.run(idx * 10, d.id);
      return;
    }
    upsert.run(
      d.id,
      d.name,
      d.cron_expr,
      d.enabled,
      d.task_type,
      d.task_config ? JSON.stringify(d.task_config) : null,
      idx * 10,
      now,
    );
  });
  if (!hotTabsInitialized) {
    db.prepare(`
      INSERT INTO local_data (module, data_key, data_json, cached_at, expires_at)
      VALUES ('system', 'default_hot_tabs_initialized', ?, ?, ?)
      ON CONFLICT(module, data_key) DO UPDATE SET data_json = excluded.data_json, cached_at = excluded.cached_at
    `).run(JSON.stringify(true), now, now + 100 * 365 * 24 * 60 * 60 * 1000);
  }
}
registerDefaultCrons();

function initializeDefaultUser() {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count > 0) return;
  const now = Date.now();
  const result = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, username, display_name, password_hash, role, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)
  `).run(crypto.randomUUID(), DEFAULT_USERNAME, '管理员', hashPassword(DEFAULT_PASSWORD), now, now);
  if (result.changes) {
    console.warn('[auth] 已创建默认账号 admin，请首次登录后立即修改默认密码。');
  }
}
initializeDefaultUser();

function redfoxApplyUrl() {
  return String(process.env.REDFOX_APPLY_URL || '').trim();
}

// ============ WeRss 接入源（we-mp-rss） ============
// ============ 我的账号 + 风格档案 ============
function listMyAccounts() {
  return db.prepare('SELECT * FROM my_accounts ORDER BY created_at DESC').all().map(rowToMyAccount);
}

function getMyAccount(id) {
  const row = db.prepare('SELECT * FROM my_accounts WHERE id = ?').get(id);
  return row ? rowToMyAccount(row) : null;
}

function rowToMyAccount(row) {
  if (!row) return null;
  const tracks = parseJson(row.tracks);
  const profile = parseJson(row.style_profile);
  return {
    id: row.id,
    trackerId: row.tracker_id,
    name: row.name,
    plat: row.plat,
    avatar: row.avatar,
    tracks: Array.isArray(tracks) ? tracks : [],
    styleProfile: (profile && typeof profile === 'object' && Object.keys(profile).length) ? profile : null,
    styleSource: row.style_source || '',
    styleSourceRef: row.style_source_ref || '',
    styleUpdatedAt: row.style_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saveMyAccount(data) {
  const id = String(data.id || `my:${data.plat}:${data.name}:${Date.now()}`);
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM my_accounts WHERE id = ?').get(id);
  db.prepare(`
    INSERT INTO my_accounts (id, tracker_id, name, plat, avatar, tracks, style_profile, style_source, style_source_ref, style_updated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tracker_id = COALESCE(excluded.tracker_id, my_accounts.tracker_id),
      name = excluded.name,
      plat = excluded.plat,
      avatar = COALESCE(excluded.avatar, my_accounts.avatar),
      tracks = COALESCE(excluded.tracks, my_accounts.tracks),
      style_profile = COALESCE(excluded.style_profile, my_accounts.style_profile),
      style_source = COALESCE(excluded.style_source, my_accounts.style_source),
      style_source_ref = COALESCE(excluded.style_source_ref, my_accounts.style_source_ref),
      style_updated_at = COALESCE(excluded.style_updated_at, my_accounts.style_updated_at),
      updated_at = excluded.updated_at
  `).run(
    id,
    data.trackerId || existing?.tracker_id || null,
    String(data.name || '').trim(),
    String(data.plat || ''),
    data.avatar || existing?.avatar || null,
    data.tracks ? JSON.stringify(data.tracks) : (existing?.tracks || null),
    data.styleProfile ? JSON.stringify(data.styleProfile) : (existing?.style_profile || null),
    data.styleSource || existing?.style_source || null,
    data.styleSourceRef || existing?.style_source_ref || null,
    data.styleUpdatedAt || existing?.style_updated_at || null,
    existing?.created_at || now,
    now
  );
  return getMyAccount(id);
}

// 收集账号的风采素材（标题列表 + 正文片段 + 标签）
async function collectAccountSamples(account) {
  const samples = { titles: [], contents: [], tags: [], sourceDesc: '' };
  // 来源 1：tracked_accounts 里的作品（RedFox 抓取过）
  if (account.trackerId) {
    const works = db.prepare(`SELECT work_data FROM account_works WHERE account_id = ? ORDER BY publish_at DESC LIMIT 20`).all(account.trackerId);
    for (const w of works) {
      const data = parseJson(w.work_data);
      if (!data) continue;
      if (data.title) samples.titles.push(data.title);
      if (data.summary || data.desc) samples.titles.push(data.summary || data.desc);
    }
    samples.sourceDesc = `RedFox ${works.length} 篇作品`;
  }
  // 来源 2：知识库（style_source_ref='all' 表示整库；旧值是逗号分隔 entry key）
  if (account.styleSourceRef) {
    const cfg = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (cfg) {
      const isAll = account.styleSourceRef === 'all';
      const keys = isAll ? [] : account.styleSourceRef.split(',').map(s => s.trim()).filter(Boolean);
      // 整库模式：拉 Obsidian + Notion 各前 15 条作为样本
      const readObsidian = async (limit) => {
        if (!cfg.source_path || !fs.existsSync(cfg.source_path)) return [];
        const entries = scanVault(cfg.source_path, {});
        return entries.slice(0, limit);
      };
      const readNotion = async (limit) => {
        if (!cfg.notion_api_key || !cfg.notion_database_id) return [];
        const apiKey = decryptKb(cfg.notion_api_key);
        const pages = await searchPages(apiKey, cfg.notion_database_id, {});
        return pages.slice(0, limit);
      };
      try {
        let kbCount = 0;
        if (isAll) {
          const [obs, nt] = await Promise.all([readObsidian(15), readNotion(15)]);
          for (const e of obs) {
            if (e?.title) samples.titles.push(e.title);
            if (e?.content) samples.contents.push(e.content.slice(0, 1500));
            if (e?.tags?.length) samples.tags.push(...e.tags);
            kbCount++;
          }
          for (const page of nt) {
            const t = page?.title;
            if (t) samples.titles.push(t);
            if (page?.content) samples.contents.push(page.content.slice(0, 1500));
            kbCount++;
          }
        } else {
          for (const key of keys.slice(0, 5)) {
            try {
              if (cfg.notion_api_key && cfg.notion_database_id) {
                const apiKey = decryptKb(cfg.notion_api_key);
                const page = await getPage(apiKey, key);
                if (page?.title) samples.titles.push(page.title);
                if (page?.content) samples.contents.push(page.content.slice(0, 1500));
              } else if (cfg.source_path) {
                const entry = readEntry(cfg.source_path, key);
                if (entry?.title) samples.titles.push(entry.title);
                if (entry?.content) samples.contents.push(entry.content.slice(0, 1500));
                if (entry?.tags?.length) samples.tags.push(...entry.tags);
              }
              kbCount++;
            } catch (e) {
              console.warn(`[my-account] 读知识库条目 ${key} 失败:`, e.message);
            }
          }
        }
        if (kbCount) samples.sourceDesc += (samples.sourceDesc ? ' + ' : '') + `知识库 ${kbCount} 条`;
      } catch (e) {
        console.warn('[my-account] 知识库读取失败:', e.message);
      }
    }
  }
  return samples;
}

// LLM 提炼赛道（基于作品标题）
async function extractAccountTracks(account) {
  const samples = await collectAccountSamples(account);
  if (!samples.titles.length) throw new Error('该账号暂无作品数据，请先在「账号追踪」同步或关联知识库条目');
  const titles = samples.titles.slice(0, 30).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const messages = [
    { role: 'system', content: '你是创作赛道分析师。基于账号的作品标题列表，提炼出 3-5 个赛道标签。赛道标签应当是简短的中文短语（如"AI 教程"、"NAS 玩法"、"情感共鸣"），反映此账号主要创作主题。严格输出 JSON 对象：{"tracks": ["...", "..."]}' },
    { role: 'user', content: `账号名称：${account.name}（${account.plat}）\n\n作品标题：\n${titles}\n\n请提炼 3-5 个赛道标签，严格输出 JSON：{"tracks": ["...", "..."]}` },
  ];
  const result = await callLlmJson(messages);
  const tracks = Array.isArray(result) ? result
    : Array.isArray(result?.tracks) ? result.tracks
    : Array.isArray(result?.data) ? result.data
    : Array.isArray(result?.赛道) ? result.赛道
    : [];
  return tracks.slice(0, 5).map(t => String(t).trim()).filter(Boolean);
}

// LLM 提炼风格档案（基于作品 + 已知赛道）
async function extractAccountStyleProfile(account) {
  const samples = await collectAccountSamples(account);
  if (!samples.titles.length && !samples.contents.length) {
    throw new Error('该账号暂无作品数据，无法提炼风格');
  }
  const titles = samples.titles.slice(0, 20).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const contents = samples.contents.slice(0, 3).map((c, i) => `--- 作品 ${i + 1} 正文片段 ---\n${c}`).join('\n\n');
  const tracks = (account.tracks || []).join('、');
  const messages = [
    { role: 'system', content: '你是创作风格分析师。基于账号的作品素材，提炼出结构化的创作风格档案。返回严格 JSON 格式。' },
    { role: 'user', content: `账号名称：${account.name}（${account.plat}）
已知赛道：${tracks || '未提炼'}

【作品标题列表】
${titles}

【作品正文片段】
${contents || '（无）'}

【已知标签】
${samples.tags.slice(0, 20).join('、') || '（无）'}

请输出严格 JSON，结构如下：
{
  "创作心智": {"核心议题": ["..."], "独特视角": "...", "避免话题": ["..."]},
  "标题DNA": {"典型句式": ["..."], "数字偏好": "...", "情绪钩子": "..."},
  "表达风格": {"句式": "...", "词汇偏好": "...", "节奏": "...", "幽默度": "..."},
  "创作边界": ["..."],
  "诚实边界": "基于 N 篇作品提炼，不覆盖最新偏好"
}` },
  ];
  return await callLlmJson(messages);
}

// 基于赛道 + 热点生成预设选题
async function generatePresetInspirations(account) {
  const tracks = account.tracks || [];
  if (!tracks.length) throw new Error('请先提炼赛道');
  const keywordsRow = db.prepare(`SELECT data_json FROM local_data WHERE module = 'hot' AND data_key = 'keywords'`).get();
  let hotKeywords = [];
  if (keywordsRow) {
    try {
      const data = parseJson(keywordsRow.data_json);
      hotKeywords = (data?.keywords || data?.items || []).slice(0, 20).map(k => typeof k === 'string' ? k : (k.keyword || k.title || ''));
    } catch {}
  }
  const hasHot = hotKeywords.length > 0;
  const systemPrompt = hasHot
    ? `你是自媒体选题策划师。基于用户的赛道标签和当前热点关键词，生成 8 个适合的预设选题。每个选题包含标题、角度（一句话说明切入角度）、目标平台。严格输出 JSON：{"ideas": [{"title": "...", "angle": "...", "platform": "dy|xhs|gzh|all"}]}`
    : `你是自媒体选题策划师。基于用户的赛道标签，生成 8 个适合的预设选题（当前无热点数据，仅基于赛道）。每个选题包含标题、角度、目标平台。严格输出 JSON：{"ideas": [{"title": "...", "angle": "...", "platform": "dy|xhs|gzh|all"}]}`;
  const userPrompt = hasHot
    ? `我的赛道：${tracks.join('、')}\n\n当前热点关键词：\n${hotKeywords.join('、')}\n\n请基于「我的赛道 ∩ 当前热点」生成 8 个适合的选题。严格输出：{"ideas": [...]}`
    : `我的赛道：${tracks.join('、')}\n\n请基于赛道生成 8 个适合的选题。严格输出：{"ideas": [...]}`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const result = await callLlmJson(messages);
  const ideas = Array.isArray(result) ? result : (result?.ideas || result?.data || result?.items || []);
  return ideas.map(idea => ({
    title: String(idea?.title || '').trim(),
    angle: String(idea?.angle || '').trim(),
    platform: String(idea?.platform || 'all').trim(),
  })).filter(idea => idea.title);
}

// 基于账号赛道生成"自动选题配置"建议（关键词组合 + 推荐数据源）
async function suggestInspirationConfigs(account) {
  const tracks = account.tracks || [];
  if (!tracks.length) throw new Error('请先提炼赛道');
  const platformMap = { gzh: 'gzh', dy: 'dy', xhs: 'xhs' };
  const defaultPlatform = platformMap[account.plat] || '';
  const messages = [
    {
      role: 'system',
      content: `你是自媒体运营策略师。基于用户的赛道标签，生成 3 个"自动选题主题配置"建议。每个配置会作为定时任务，每天自动生成灵感选题入库。

每个配置包含：
- name：主题名称（10 字以内，如"AI 工具速递"、"NAS 折腾日记"）
- keywords：3-6 个关键词（用于检索证据 + LLM 推理）
- targetPlatforms：目标平台数组（可选：dy/xhs/gzh）
- sources：推荐数据源（可选：hot/dy/xhs/gzh/ai-gzh/ai-bili/ai-xhs/tracked/gzh-search/wersss）
- ideaCount：每次生成几条选题（3-8）

严格输出 JSON：{"configs": [{"name": "...", "keywords": [...], "targetPlatforms": [...], "sources": [...], "ideaCount": N}]}`,
    },
    {
      role: 'user',
      content: `我的赛道：${tracks.join('、')}
我的主平台：${account.plat === 'gzh' ? '公众号' : account.plat === 'dy' ? '抖音' : account.plat === 'xhs' ? '小红书' : account.plat}

请生成 3 个互补的自动选题配置建议。`,
    },
  ];
  const result = await callLlmJson(messages);
  const configs = Array.isArray(result) ? result : (result?.configs || []);
  return configs.map(c => ({
    name: String(c?.name || '').slice(0, 20).trim(),
    keywords: Array.isArray(c?.keywords) ? c.keywords.slice(0, 8).map(k => String(k).trim()).filter(Boolean) : [],
    targetPlatforms: Array.isArray(c?.targetPlatforms) ? c.targetPlatforms.filter(p => ['dy', 'xhs', 'gzh'].includes(p)) : (defaultPlatform ? [defaultPlatform] : []),
    sources: Array.isArray(c?.sources) ? c.sources.filter(s => getInspirationSourceKeys().has(s)) : DEFAULT_INSPIRATION_SOURCES.filter(s => getInspirationSourceKeys().has(s)),
    ideaCount: Math.min(8, Math.max(3, Number(c?.ideaCount) || 5)),
  })).filter(c => c.name && c.keywords.length);
}

// 把建议保存为真实的自动选题配置
function createInspirationConfigFromSuggestion(account, suggestion) {
  const name = `${suggestion.name}`;
  const config = {
    name,
    domain: (account.tracks || []).join('、'),
    targetPlatforms: suggestion.targetPlatforms,
    cronExpr: '0 9 * * *',  // 默认每天 9 点
    enabled: 1,
    sources: suggestion.sources,
    ideaCount: suggestion.ideaCount,
    evidenceLimit: 20,
    dailyApiBudget: 3,
    searchMode: 'combined',
  };
  return saveInspirationConfig(config);
}

const KB_CACHE_TTL = {
  obsidian: 5 * 60 * 1000,   // 5 分钟
  notion: 60 * 1000,          // 1 分钟（Notion API 限制更严）
};

function getKbEntriesFromCache(sourceType, query, tag, folder) {
  if (query || tag || folder) return null; // 搜索条件不命中缓存
  const cacheKey = `list:${sourceType}`;
  const row = db.prepare('SELECT * FROM kb_entries_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  const ttl = KB_CACHE_TTL[sourceType] || KB_CACHE_TTL.obsidian;
  if (Date.now() - row.scanned_at > ttl) return null;
  return JSON.parse(row.content || '[]');
}

function setKbEntriesToCache(sourceType, entries) {
  const cacheKey = `list:${sourceType}`;
  const now = Date.now();
  db.prepare(`INSERT INTO kb_entries_cache (cache_key, source_type, entry_key, content, scanned_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content, scanned_at=excluded.scanned_at`
  ).run(cacheKey, sourceType, '', JSON.stringify(entries), now);
}

function getKbEntryFromCache(sourceType, entryKey) {
  const cacheKey = `entry:${sourceType}:${entryKey}`;
  const row = db.prepare('SELECT * FROM kb_entries_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  const ttl = KB_CACHE_TTL[sourceType] || KB_CACHE_TTL.obsidian;
  if (Date.now() - row.scanned_at > ttl) return null;
  return {
    entry_key: row.entry_key,
    title: row.title,
    tags: parseJson(row.tags) || [],
    folder: row.folder,
    content: row.content,
    content_preview: row.content_preview,
    frontmatter: parseJson(row.frontmatter) || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function setKbEntryToCache(sourceType, entry) {
  const cacheKey = `entry:${sourceType}:${entry.entry_key}`;
  const now = Date.now();
  db.prepare(`INSERT INTO kb_entries_cache (cache_key, source_type, entry_key, title, tags, folder, content_preview, content, frontmatter, created_at, updated_at, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET title=excluded.title, tags=excluded.tags, folder=excluded.folder,
      content_preview=excluded.content_preview, content=excluded.content, frontmatter=excluded.frontmatter,
      updated_at=excluded.updated_at, scanned_at=excluded.scanned_at`
  ).run(cacheKey, sourceType, entry.entry_key, entry.title, JSON.stringify(entry.tags),
    entry.folder, entry.content_preview, entry.content, JSON.stringify(entry.frontmatter),
    entry.created_at, entry.updated_at, now);
}

function invalidateKbListCache(sourceType) {
  db.prepare('DELETE FROM kb_entries_cache WHERE cache_key = ?').run(`list:${sourceType}`);
}

function invalidateKbEntryCache(sourceType, entryKey) {
  db.prepare('DELETE FROM kb_entries_cache WHERE cache_key = ?').run(`entry:${sourceType}:${entryKey}`);
}




// 豆包 WebSearch：提交搜索任务后轮询等待结果，最多等 60s
async function doDoubaoWebSearch(query, source = 'insprira-rewrite') {
  if (!API_KEY) throw new Error('未配置 REDFOX_API_KEY');
  const submitResp = await redfoxRequest('doubaoSearch/submit', { inquiry_text: query, source });
  const submitPayload = parseJson(submitResp.body);
  if (submitResp.status >= 400 || !submitPayload || ![200, 2000].includes(submitPayload.code)) {
    throw new Error(submitPayload?.msg || submitPayload?.message || `豆包搜索提交失败 HTTP ${submitResp.status}`);
  }
  const taskId = submitPayload?.data?.taskId || submitPayload?.data?.task_id;
  if (!taskId) throw new Error('豆包搜索未返回 taskId');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const resultResp = await redfoxRequest('doubaoSearch/result', { taskId });
    const resultPayload = parseJson(resultResp.body);
    if (resultResp.status >= 400) continue;
    const data = resultPayload?.data || {};
    const status = String(data.status || resultPayload?.status || '').toLowerCase();
    if (status === 'completed' || status === 'success' || status === 'done') {
      logApiUsage('doubaoSearch/result', 200, false);
      return data;
    }
    if (status === 'failed' || status === 'error') {
      logApiUsage('doubaoSearch/result', 200, false);
      throw new Error(data.failReason || data.message || '豆包搜索任务失败');
    }
  }
  logApiUsage('doubaoSearch/result', 200, false);
  throw new Error('豆包搜索超时（已等待 60s），请稍后重试');
}

function formatDoubaoSearchResults(data) {
  // 兼容多种返回结构：{ answer, results: [{title, url, snippet}] } 或 { content } 或直接 { results: [...] }
  const results = Array.isArray(data?.results) ? data.results : (Array.isArray(data?.web_results) ? data.web_results : []);
  const answer = data?.answer || data?.summary || data?.content || '';
  let text = '';
  if (answer) text += `【AI 总结】\n${String(answer).slice(0, 1500)}\n\n`;
  if (results.length) {
    text += `【搜索结果】\n`;
    results.slice(0, 8).forEach((r, i) => {
      const title = r.title || r.name || '';
      const url = r.url || r.link || '';
      const snippet = r.snippet || r.content || r.description || '';
      if (title || snippet) {
        text += `${i + 1}. ${title}${url ? ` (${url})` : ''}\n${String(snippet).slice(0, 300)}\n\n`;
      }
    });
  }
  if (!text) text = JSON.stringify(data).slice(0, 2000);
  return text.slice(0, 4000);
}






async function handleLocalApi(req, res, url) {
  if (await require('./lib/routes/auth').tryRoute(req, res, url, { APP_VERSION, ENABLE_SCHEDULER, ENV_FILE })) {
    return true;
  }
  if (await require('./lib/routes/misc').tryRoute(req, res, url, {
    listActionLogs, usageSummary, getOfficialQuota,
    publicNotificationConfigs, saveNotificationConfigs, notificationConfigs,
    NOTIFICATION_CHANNELS, sendNotification,
    listLocalAgents, runLocalAgent,
    captureHotSnapshot, findRewriteHotspots, rewriteForPlatform,
  })) {
    return true;
  }
  if (await require('./lib/routes/skills').tryRoute(req, res, url, {
    listSkills, getSkill, getSkillSourceBinding, bindSkillToSource,
    classifyAllSkills, communitySkillUpdateStatus, updateCommunitySkills,
  })) {
    return true;
  }
  if (await require('./lib/routes/hot').tryRoute(req, res, url, {
    getHotTrends, analyzeHotTrendsLlm, hotListPayload,
    syncRealtimeHotspots, syncDailyPlatform, HOT_SOURCE_CONFIG,
  })) {
    return true;
  }
  if (await require('./lib/routes/inspiration').tryRoute(req, res, url, {
    getInspirationSourceMeta, listInspirationConfigs, saveInspirationConfig,
    getInspirationConfig, deleteInspirationConfig, runInspirationConfig,
    listInspirationRuns, listInspirations, generateInspirations,
    setInspirationFavorite, applyInspirationFeedback,
    trashInspiration, restoreInspiration, permanentlyDeleteInspiration,
    logAction,
  })) {
    return true;
  }
  if (await require('./lib/routes/trackers').tryRoute(req, res, url, {
    listTrackers, saveTracker, syncTracker, listTrackerWorks,
    diagnoseAndStoreTracker, listAccountSnapshots, getLocalData,
  })) {
    return true;
  }

  // ==========知识库 KB ==========
  if (await require('./lib/routes/kb').tryRoute(req, res, url, {
    callLlmJson, getHotTrends, hotListPayload,
    getKbEntryFromCache, setKbEntryToCache,
    invalidateKbListCache, invalidateKbEntryCache,
    getKbEntriesFromCache, setKbEntriesToCache,
    getLocalData, setLocalData,
  })) {
    return true;
  }

  if (await require('./lib/routes/wersss').tryRoute(req, res, url, {
    getWersssConfigRow, getWersssConfig, getValidWersssToken,
    getWersssAuthStatus, syncWersssArticles, prefetchWersssContent,
  })) {
    return true;
  }

  if (await require('./lib/routes/accounts').tryRoute(req, res, url, {
    listMyAccounts, saveMyAccount, getMyAccount,
    extractAccountTracks, extractAccountStyleProfile, generatePresetInspirations,
    suggestInspirationConfigs, createInspirationConfigFromSuggestion,
  })) {
    return true;
  }

  // ========== CRON ==========
  if (await require('./lib/routes/crons').tryRoute(req, res, url, {
    listCronJobs, saveCronJob, deleteCronJob, runCronJob, isInspirationCronId,
  })) {
    return true;
  }

  return false;
}

function serveStatic(res, pathname) {
  serveStaticFromLib(__dirname, res, pathname);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    const publicApi = url.pathname === '/api/_/login' || url.pathname === '/api/_/status' || url.pathname === '/api/_/version';
    if (url.pathname.startsWith('/api/') && !publicApi && !isAuthorized(req)) {
      json(res, 401, { ok: false, error: '请先登录' });
      return;
    }
    if (url.pathname.startsWith('/api/_/')) {
      const handled = await handleLocalApi(req, res, url);
      if (!handled) json(res, 404, { ok: false, error: '接口不存在' });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') {
        json(res, 405, { code: 405, msg: '仅支持 POST' });
        return;
      }
      const endpoint = decodeURIComponent(url.pathname.slice('/api/'.length));
      if (!REDFOX_ENDPOINTS.has(endpoint)) {
        json(res, 403, { code: 403, msg: '该端点未加入允许列表' });
        return;
      }
      const { text, data } = await readBody(req);
      const query = url.search;
      const cacheKey = getCacheKey(endpoint, query, data);
      const cached = getCached(cacheKey, endpoint);
      if (cached) {
        logApiUsage(endpoint, cached.status_code, true);
        res.writeHead(cached.status_code, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Cache': 'HIT',
        });
        res.end(cached.response);
        return;
      }
      const response = await redfoxRequest(endpoint, data, query);
      logApiUsage(endpoint, response.status, false);
      setCache(cacheKey, endpoint, data, response.status, response.body);
      res.writeHead(response.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Cache': 'MISS',
      });
      res.end(response.body);
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error);
    json(res, 500, { ok: false, error: error.message });
  }
});

setInterval(sessionClean, 60 * 60 * 1000).unref();

// ========== CRON 调度器 ==========
const cronTimers = new Map(); // id -> timeout ref
const activeCronRuns = new Map();

function describeCronResult(taskType, result) {
  if (!result || typeof result !== 'object') return '';
  if (taskType === 'hot-realtime' || taskType === 'hot-platform') {
    const count = result.count ?? result.itemCount;
    return count != null ? `\n抓取 ${count} 条热榜数据（数据日期 ${result.dataDate || '-'}）。` : '';
  }
  if (taskType === 'hot-trend-analysis') {
    const themes = Array.isArray(result?.themes) ? result.themes : null;
    return themes ? `\n本次分析聚合 ${themes.length} 个主题关键词。` : '';
  }
  if (taskType === 'inspiration-generate') {
    const ideas = Array.isArray(result?.ideas) ? result.ideas : null;
    return `\n本次生成 ${ideas ? ideas.length : 0} 条选题。`;
  }
  if (taskType === 'daily-hot-report') {
    return `\n已向 ${result?.platformCount || 0} 个平台推送热榜日报。`;
  }
  if (taskType === 'tracker-refresh') {
    return `\n勾选 ${result.selected || 0} 个账号，同步成功 ${result.synced || 0} 个，“自己”账号诊断 ${result.diagnosed || 0} 个，失败 ${result.failed?.length || 0} 个。`;
  }
  if (taskType === 'wersss-sync') {
    const status = result.ok ? '成功' : '部分失败';
    const tokenInfo = result.tokenRefreshed ? '（token 已刷新）' : '';
    const prefetchInfo = result.prefetch ? `，预抓取正文 ${result.prefetch.done || 0}/${result.prefetch.total || 0}` : '';
    return `\nWeRss 同步${status}${tokenInfo}：订阅 ${result.synced || 0} 个，新增文章 ${result.articles || 0} 条，失败 ${result.failed || 0} 个${prefetchInfo}。`;
  }
  if (taskType === 'cache-clean' || taskType === 'usage-clean') {
    return result?.deleted != null ? `\n本次清理 ${result.deleted} 条记录。` : '';
  }
  return '';
}

async function runCronTask(taskType, taskConfig = {}) {
  if (taskType === 'hot-realtime') {
    const batch = await syncRealtimeHotspots('灵感熔炉-定时实时热点');
    return { count: batch.itemCount, dataDate: batch.dataDate };
  }
  if (taskType === 'hot-platform') {
    const platform = String(taskConfig.platform || '');
    const batch = await syncDailyPlatform(platform, dateDaysAgo(1), '灵感熔炉-定时昨日榜');
    return { platform, count: batch.itemCount, dataDate: batch.dataDate };
  }
  if (taskType === 'hot-trend-analysis') {
    return analyzeDailyHotKeywords(dateDaysAgo(1));
  }
  if (taskType === 'inspiration-generate') {
    return runInspirationConfig(String(taskConfig.configId || ''), 'cron');
  }
  if (taskType === 'cache-clean') {
    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM api_cache WHERE updated_at < ?').run(threshold);
    if (result.changes) console.log(`[cron] 清理 ${result.changes} 条过期缓存`);
    try {
      const ck = db.pragma('wal_checkpoint(PASSIVE)');
      if (ck && ck.checkpointed > 0) console.log(`[cron] WAL checkpoint: ${ck.checkpointed} 页已写入主库`);
    } catch (e) {
      console.warn('[cron] WAL checkpoint 失败:', e.message);
    }
    return { deleted: result.changes };
  }
  if (taskType === 'usage-clean') {
    const result = db.prepare('DELETE FROM api_usage WHERE created_at < ?').run(Date.now() - 90 * 24 * 60 * 60 * 1000);
    console.log(`[cron] 清理 ${result.changes} 条90天前用量日志`);
    return { deleted: result.changes };
  }
  if (taskType === 'daily-hot-report') {
    return sendDailyHotReport();
  }
  if (taskType === 'tracker-refresh') {
    return refreshTrackedAccounts();
  }
  if (taskType === 'wersss-sync') {
    return runWersssSyncCron();
  }
  throw new Error(`不支持的任务类型：${taskType}`);
}

async function runCronJob(id, taskType, taskConfig = {}) {
  if (activeCronRuns.has(id)) return activeCronRuns.get(id);
  const promise = runCronTask(taskType, taskConfig);
  activeCronRuns.set(id, promise);
  try {
    return await promise;
  } finally {
    activeCronRuns.delete(id);
  }
}

function scheduleCronJob(id, cronExpr, taskType, taskConfig = {}) {
  const existing = cronTimers.get(id);
  if (existing) { clearTimeout(existing); cronTimers.delete(id); }
  if (!ENABLE_SCHEDULER) return;
  const next = nextCronTime(cronExpr);
  if (!next) return;
  const delay = next.getTime() - Date.now();
  console.log(`[cron] ${id} 下次运行: ${next.toLocaleString('zh-CN')} (${Math.round(delay / 60000)}分钟后)`);
  const timer = setTimeout(async () => {
    const cronRow = (() => {
      try {
        return db.prepare('SELECT name, notify_on_failure, notify_on_success FROM crontab WHERE id = ?').get(id);
      } catch { return null; }
    })();
    const cronName = cronRow?.name || id;
    const notifyFailure = cronRow?.notify_on_failure !== 0;
    const notifySuccess = cronRow?.notify_on_success === 1;
    try {
      const result = await runCronJob(id, taskType, taskConfig);
      db.prepare('UPDATE crontab SET last_run = ? WHERE id = ?').run(Date.now(), id);
      if (notifySuccess) {
        const summary = describeCronResult(taskType, result);
        notifLib.broadcastNotification(
          notificationConfigs,
          `定时任务执行成功：${cronName}`,
          `任务「${cronName}」于 ${new Date().toLocaleString('zh-CN')} 执行完成。${summary}`
        ).catch(err => console.warn('[notify] cron 成功通知异常:', err.message));
      }
    } catch (error) {
      console.error(`[cron] ${id} 执行失败:`, error.message);
      if (notifyFailure) {
        notifLib.broadcastNotification(
          notificationConfigs,
          `定时任务执行失败：${cronName}`,
          `任务「${cronName}」(${id}) 在 ${new Date().toLocaleString('zh-CN')} 执行失败：\n${error.message}`
        ).catch(err => console.warn('[notify] cron 失败通知异常:', err.message));
      }
    } finally {
      scheduleCronJob(id, cronExpr, taskType, taskConfig);
    }
  }, delay);
  cronTimers.set(id, timer);
}

function loadAllCronJobs() {
  const rows = db.prepare('SELECT id, cron_expr, enabled, task_type, task_config FROM crontab').all();
  for (const row of rows) {
    if (row.enabled) {
      scheduleCronJob(row.id, row.cron_expr, row.task_type, parseJson(row.task_config) || {});
    }
  }
}

function listCronJobs() {
  return db.prepare('SELECT id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, last_run, sort_order, created_at FROM crontab ORDER BY sort_order ASC, created_at ASC').all()
    .filter(row => !isInspirationCronId(row.id))
    .map(row => ({
      id: row.id, name: row.name, cronExpr: row.cron_expr, enabled: Boolean(row.enabled),
      taskType: row.task_type, taskConfig: row.task_config ? JSON.parse(row.task_config) : null,
      notifyOnFailure: row.notify_on_failure !== 0,
      notifyOnSuccess: Boolean(row.notify_on_success),
      lastRun: row.last_run, sortOrder: row.sort_order, createdAt: row.created_at,
    }));
}

async function saveCronJob(id, name, cronExpr, enabled, taskType, taskConfig, opts = {}) {
  const now = Date.now();
  const config = taskConfig ? JSON.stringify(taskConfig) : null;
  const notifyFailure = opts.notifyOnFailure === false ? 0 : 1;
  const notifySuccess = opts.notifyOnSuccess ? 1 : 0;
  const existing = db.prepare('SELECT sort_order FROM crontab WHERE id = ?').get(id);
  let sortOrder = existing ? existing.sort_order : 0;
  if (!existing) {
    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM crontab').get();
    sortOrder = (maxRow?.max_order || 0) + 1;
  }
  db.prepare(`INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cron_expr=excluded.cron_expr, enabled=excluded.enabled,
      task_type=excluded.task_type, task_config=excluded.task_config,
      notify_on_failure=excluded.notify_on_failure, notify_on_success=excluded.notify_on_success,
      sort_order=excluded.sort_order`
  ).run(id, name, cronExpr, enabled ?1 : 0, taskType, config, notifyFailure, notifySuccess, sortOrder, now);
  if (enabled) scheduleCronJob(id, cronExpr, taskType, taskConfig || {});
  else {
    const t = cronTimers.get(id);
    if (t) { clearTimeout(t); cronTimers.delete(id); }
  }
  return listCronJobs();
}

function deleteCronJob(id) {
  const t = cronTimers.get(id);
  if (t) { clearTimeout(t); cronTimers.delete(id); }
  db.prepare('DELETE FROM crontab WHERE id = ?').run(id);
  return listCronJobs();
}

// tracker 模块工厂：在 paths 声明后构造
const trackerLib = require('./lib/tracker').make({
  WECHAT_ANALYZER_ROOT, DOUYIN_ANALYZER_ROOT, XHS_ANALYZER_ROOT,
  EXTENDED_PATH, API_KEY, execFileAsync,
  callLlmJson,
  broadcastNotification: (title, message) => notifLib.broadcastNotification(notificationConfigs, title, message),
  getLocalData, setLocalData,
});
const {
  listTrackers, saveTracker, syncTracker, listTrackerWorks,
  diagnoseAndStoreTracker, listAccountSnapshots,
  refreshTrackedAccounts, restoreTrackerRetries,
  normalizeTrackerAccountId, trackerQuerySpec, trackerCollectionSpec,
  xhsTrackerAccounts, normalizeTrackerResult, trackerWorkId,
} = trackerLib;

// inspiration 模块工厂：在 saveCronJob/deleteCronJob 声明后构造
const inspirationLib = require('./lib/inspiration').make({
  HOT_SOURCE_CONFIG,
  hotListPayload,
  getHotTrends,
  saveHotBatch,
  callLlm,
  broadcastNotification: (title, message) => notifLib.broadcastNotification(notificationConfigs, title, message),
  saveCronJob,
  deleteCronJob,
});
const {
  getInspirationSourceMeta, getInspirationSourceKeys,
  listInspirationConfigs, getInspirationConfig, saveInspirationConfig,
  deleteInspirationConfig, isInspirationCronId,
  generateInspirations, listInspirations,
  trashInspiration, restoreInspiration, permanentlyDeleteInspiration,
  runInspirationConfig, listInspirationRuns,
  setInspirationFavorite, applyInspirationFeedback,
  getConfiguredHotPlatforms, getDynamicInspirationSources,
  DEFAULT_INSPIRATION_SOURCES,
} = inspirationLib;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`灵感熔炉已启动：http://${HOST}:${PORT}`);
    console.log(`RedFox API：${API_KEY ? '已配置' : '未配置 REDFOX_API_KEY'}`);
    console.log(`LLM：${process.env.LLM_API_KEY ? `已配置 ${process.env.LLM_MODEL || ''}` : '未配置，选题生成功能不可用'}`);
    console.log('访问控制：已启用 SQLite 账号登录');
    loadAllCronJobs();
    restoreTrackerRetries();
  });
}

module.exports = {
  server,
  db,
  getHotTrends,
  normalizeSnapshotItems,
  normalizeDailyPlatformItems,
  latestAiGzhDataDate,
  normalizeHotspots,
  normalizeRealtimeHotspots,
  stableObject,
  listSkills,
  parseCronExpr,
  validateCronField,
  nextCronTime,
  matchesCronField,
  getCacheKey,
  workPublishAt,
  workContentKey,
  isCacheableRedfoxResponse,
  gitBlobSha,
  compareSkillManifests,
  communitySkillUpdateStatus,
  updateCommunitySkills,
  normalizeTrackerAccountId,
  trackerQuerySpec,
  trackerCollectionSpec,
  xhsTrackerAccounts,
  normalizeTrackerResult,
  trackerWorkId,
  parseAgentJsonLines,
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
};
