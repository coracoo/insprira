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

const execFileAsync = promisify(execFile);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] != null) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const ENV_FILE = path.join(__dirname, '.env');
loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.REDFOX_API_KEY || '';
const REDFOX_HOST = process.env.REDFOX_HOST || 'redfox.hk';
const REDFOX_PATH_PREFIX = '/story/api/';
const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== 'false';
const MAX_BODY_SIZE = 2 * 1024 * 1024;
const REDFOX_WEB_COOKIE = process.env.REDFOX_WEB_COOKIE || '';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const SKILLS_ROOT = path.join(__dirname, 'skills', 'redfox-community', 'skills');
const SKILLS_REPO_ROOT = path.dirname(SKILLS_ROOT);
const SKILLS_GITHUB_REPO = 'redfox-data/redfox-community';
const SKILLS_NEW_BADGE_MS = 7 * 24 * 60 * 60 * 1000;
const WECHAT_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'wechat-account-analyzer');
const DOUYIN_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'douyin-account-diagnosis');
const XHS_ANALYZER_ROOT = path.join(SKILLS_ROOT, 'xiaohongshu-account-analyzer');
const sessions = new Map();
const EDITABLE_ENV_KEYS = [
  'REDFOX_API_KEY', 'REDFOX_WEB_COOKIE', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'KB_ENCRYPTION_KEY', 'ENABLE_SCHEDULER',
];
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = '123456';
const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function readEnvValues() {
  const values = {};
  if (!fs.existsSync(ENV_FILE)) return values;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function publicEnvConfig() {
  const values = readEnvValues();
  return Object.fromEntries(EDITABLE_ENV_KEYS.map(key => [key, {
    configured: Boolean(values[key]),
    value: /KEY|PASSWORD|COOKIE/.test(key) ? '' : (values[key] || ''),
    secret: /KEY|PASSWORD|COOKIE/.test(key),
  }]));
}

function updateEnvConfig(input) {
  const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const updates = new Map();
  for (const key of EDITABLE_ENV_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = String(input[key] ?? '').trim();
    if (!value && /KEY|PASSWORD|COOKIE/.test(key)) continue;
    updates.set(key, value);
  }
  const seen = new Set();
  const lines = existing.map(line => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match || !updates.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates.get(match[1]).replace(/\r?\n/g, '')}`;
  });
  for (const [key, value] of updates) {
    if (!seen.has(key)) lines.push(`${key}=${value.replace(/\r?\n/g, '')}`);
  }
  fs.writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  return publicEnvConfig();
}

function restartCurrentService() {
  setTimeout(() => {
    if (process.env.FURNACE_RESTART_CMD) {
      const [cmd, ...args] = process.env.FURNACE_RESTART_CMD.split(/\s+/);
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    const isSystemd = fs.existsSync('/run/systemd/system') || fs.existsSync(path.join(os.homedir(), '.config/systemd/user/insprira.service'));
    if (isSystemd) {
      spawn('systemctl', ['--user', 'restart', 'insprira.service'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }
    console.warn('[restart] 未检测到 systemd 服务，进程将退出。请用外层管理器（pm2 / systemd / npm start / nohup）重启。');
    process.exit(0);
  }, 500);
}

function sessionSet(token, userId, expiresAt) {
  const session = { userId, expiresAt };
  sessions.set(token, session);
  db.prepare(`
    INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, expiresAt, Date.now());
}
function sessionDel(token) {
  sessions.delete(token);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function sessionGet(token) {
  if (sessions.has(token)) return sessions.get(token);
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (row?.user_id) {
    const session = { userId: row.user_id, expiresAt: row.expires_at };
    sessions.set(token, session);
    return session;
  }
  return null;
}
function sessionClean() {
  const now = Date.now();
  sessions.forEach((value, token) => {
    if (value.expiresAt < now) sessions.delete(token);
  });
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR user_id IS NULL').run(now);
}
let agentBusy = false;
let diagnosisBusy = false;

const REDFOX_ENDPOINTS = new Set([
  'hotKeyword/list',
  'hotSpot/getListByPlatform',
  'hotSpot/getListByPlatformWithKeyword',
  'dy/search/likesRank',
  'dy/search/hotContentRank',
  'dyData/query',
  'dyData/queryWork',
  'dyData/queryUser',
  'dyData/queryUserWithWorks',
  'dyData/searchUser',
  'dyData/searchArticle',
  'dyUser/query',
  'xhs/search/search',
  'xhs/crawl/work',
  'xhsData/query',
  'xhsUser/query',
  'xhsUser/queryAccountDetail',
  'xhsUser/queryWorkDetail',
  'xhsUser/searchUser',
  'xhsUser/searchArticle',
  'xhsUser/syncUserNotes',
  'xhsUser/querySimilarAccounts',
  'cozeSkill/getXhsCozeSkillData',
  'cozeSkill/getXhsCozeSkillDataOne',
  'cozeSkill/getXhsCozeSkillDataSeven',
  'cozeSkill/getXhsCozeSkillDataLowFans',
  'cozeSkill/getWxDataByCategoryAndTime',
  'cozeSkill/getGzhCozeSkillDataRaise',
  'gzh/search/hotArticle',
  'gzhData/searchUser',
  'gzhData/searchArticle',
  'gzhData/queryUser',
  'gzhData/queryWork',
  'gzhData/queryWorkList',
  'gzhData/queryArticleDetail',
  'gzhUser/query',
  'cozeSkill/sensitiveWordSearch',
  'parseWork/queryAiMsgs',
  'parseWork/queryBiliAiMsgs',
  'parseWork/queryXhsAiMsgs',
  'parseWork/parse',
  'parseWork/imageGen/submitSkill',
  'parseWork/imageGen/result',
  'parseWork/imageGen/uploadImage',
  'skill/record/save',
]);

const CACHE_TTL = {
  'hotKeyword/list': 10 * 60 * 1000,
  'hotSpot/getListByPlatform': 30 * 60 * 1000,
  'hotSpot/getListByPlatformWithKeyword': 30 * 60 * 1000,
  'dy/search/likesRank': 60 * 60 * 1000,
  'dy/search/hotContentRank': 60 * 60 * 1000,
  'dyData/queryUserWithWorks': 60 * 60 * 1000,
  'xhs/search/search': 30 * 60 * 1000,
  'xhsUser/searchArticle': 30 * 60 * 1000,
  'gzh/search/hotArticle': 60 * 60 * 1000,
  'gzhData/searchArticle': 30 * 60 * 1000,
  'gzhData/searchUser': 24 * 60 * 60 * 1000,
  'gzhData/queryWorkList': 60 * 60 * 1000,
  'parseWork/queryAiMsgs': 60 * 60 * 1000,
  'parseWork/queryBiliAiMsgs': 60 * 60 * 1000,
  'parseWork/queryXhsAiMsgs': 60 * 60 * 1000,
  default: 60 * 60 * 1000,
};

const DB_PATH = process.env.CACHE_DB_PATH
  ? path.resolve(process.env.CACHE_DB_PATH)
  : path.join(__dirname, 'cache.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    request_body TEXT NOT NULL,
    response TEXT NOT NULL,
    status_code INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_endpoint ON api_cache(endpoint);
  CREATE INDEX IF NOT EXISTS idx_updated ON api_cache(updated_at);

  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    status_code INTEGER,
    cached INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON api_usage(endpoint);

  CREATE TABLE IF NOT EXISTS action_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    data_source TEXT NOT NULL,
    api_calls INTEGER NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    detail_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_action_logs_created ON action_logs(created_at DESC);

  CREATE TABLE IF NOT EXISTS tracked_accounts (
    id TEXT PRIMARY KEY,
    plat TEXT NOT NULL,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL DEFAULT '其他',
    raw_info TEXT,
    synced_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS account_works (
    account_id TEXT NOT NULL,
    plat TEXT NOT NULL,
    work_id TEXT NOT NULL,
    work_data TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, plat, work_id)
  );

  CREATE TABLE IF NOT EXISTS account_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    follower_count REAL,
    redfox_index REAL,
    work_count REAL,
    raw_data TEXT,
    captured_at INTEGER NOT NULL,
    UNIQUE(account_id, snapshot_date)
  );

  CREATE TABLE IF NOT EXISTS hot_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    platform TEXT NOT NULL,
    rank INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    title TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    raw_data TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    UNIQUE(snapshot_date, platform, item_key)
  );
  CREATE INDEX IF NOT EXISTS idx_hot_snapshot_date ON hot_snapshots(snapshot_date);
  CREATE INDEX IF NOT EXISTS idx_hot_item ON hot_snapshots(platform, item_key);

  CREATE TABLE IF NOT EXISTS hot_batches (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    data_date TEXT NOT NULL,
    snapshot_kind TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT,
    status TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hot_batch_lookup
    ON hot_batches(platform, snapshot_kind, data_date DESC, completed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hot_batch_status
    ON hot_batches(status, completed_at DESC);

  CREATE TABLE IF NOT EXISTS hot_batch_items (
    batch_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    title TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    raw_data TEXT NOT NULL,
    PRIMARY KEY(batch_id, item_key),
    FOREIGN KEY(batch_id) REFERENCES hot_batches(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_hot_batch_items_rank
    ON hot_batch_items(batch_id, rank);

  CREATE TABLE IF NOT EXISTS hot_daily_keywords (
    data_date TEXT PRIMARY KEY,
    source_fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    generated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inspirations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    angle TEXT,
    target_platform TEXT,
    source_keywords TEXT NOT NULL,
    source_items TEXT,
    status TEXT NOT NULL DEFAULT '待研究',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inspiration_created ON inspirations(created_at DESC);

  CREATE TABLE IF NOT EXISTS inspiration_keyword_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    target_platforms TEXT NOT NULL DEFAULT '[]',
    cron_expr TEXT NOT NULL DEFAULT '0 9 * * *',
    enabled INTEGER NOT NULL DEFAULT 1,
    sources TEXT NOT NULL DEFAULT '[]',
    source_weights TEXT NOT NULL DEFAULT '{}',
    idea_count INTEGER NOT NULL DEFAULT 6,
    evidence_limit INTEGER NOT NULL DEFAULT 20,
    daily_api_budget INTEGER NOT NULL DEFAULT 3,
    search_mode TEXT NOT NULL DEFAULT 'combined',
    last_run_at INTEGER,
    last_success_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inspiration_keyword_terms (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL,
    term TEXT NOT NULL,
    term_type TEXT NOT NULL,
    manual_weight REAL NOT NULL DEFAULT 0,
    learned_weight REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(config_id, term),
    FOREIGN KEY(config_id) REFERENCES inspiration_keyword_configs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_inspiration_terms_config
    ON inspiration_keyword_terms(config_id, term_type);

  CREATE TABLE IF NOT EXISTS inspiration_runs (
    id TEXT PRIMARY KEY,
    config_id TEXT,
    trigger_type TEXT NOT NULL,
    evidence_fingerprint TEXT,
    status TEXT NOT NULL,
    idea_count INTEGER NOT NULL DEFAULT 0,
    api_calls INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    FOREIGN KEY(config_id) REFERENCES inspiration_keyword_configs(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inspiration_runs_config
    ON inspiration_runs(config_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS inspiration_feedback (
    id TEXT PRIMARY KEY,
    inspiration_id TEXT NOT NULL,
    feedback_type TEXT NOT NULL,
    affected_terms TEXT NOT NULL DEFAULT '[]',
    weight_delta REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    FOREIGN KEY(inspiration_id) REFERENCES inspirations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kb_config (
    source_type TEXT PRIMARY KEY,
    provider TEXT,
    source_path TEXT,
    notion_api_key TEXT,
    notion_database_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS crontab (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    task_type TEXT NOT NULL,
    task_config TEXT,
    last_run INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_entries_cache (
    cache_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    title TEXT,
    tags TEXT,
    folder TEXT,
    content_preview TEXT,
    content TEXT,
    frontmatter TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    scanned_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kb_cache_source ON kb_entries_cache(source_type);
  CREATE INDEX IF NOT EXISTS idx_kb_cache_updated ON kb_entries_cache(scanned_at);

  CREATE TABLE IF NOT EXISTS wersss_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    token TEXT,
    token_expires_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wersss_subscriptions (
    mp_id TEXT PRIMARY KEY,
    mp_name TEXT NOT NULL,
    mp_alias TEXT,
    avatar TEXT,
    last_synced_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS wersss_articles (
    id TEXT PRIMARY KEY,
    mp_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT,
    url TEXT,
    cover TEXT,
    publish_time INTEGER,
    synced_at INTEGER NOT NULL,
    FOREIGN KEY (mp_id) REFERENCES wersss_subscriptions(mp_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_wersss_articles_mp ON wersss_articles(mp_id, publish_time DESC);
  CREATE INDEX IF NOT EXISTS idx_wersss_articles_recent ON wersss_articles(publish_time DESC);

  CREATE TABLE IF NOT EXISTS local_data (
    module TEXT NOT NULL,
    data_key TEXT NOT NULL,
    data_json TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY(module, data_key)
  );
  CREATE INDEX IF NOT EXISTS idx_local_data_module ON local_data(module);

  CREATE TABLE IF NOT EXISTS my_accounts (
    id TEXT PRIMARY KEY,
    tracker_id TEXT,
    name TEXT NOT NULL,
    plat TEXT NOT NULL,
    avatar TEXT,
    tracks TEXT,
    style_profile TEXT,
    style_source TEXT,
    style_source_ref TEXT,
    style_updated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS style_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT,
    template TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    must_change_password INTEGER NOT NULL DEFAULT 1,
    last_login_at INTEGER,
    password_changed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function workPublishAt(work) {
  const raw = work.publishTime || work.workPublishTime || work.createTime || work.publicTime || '';
  const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
  const value = Number.isFinite(numeric) && String(raw).trim() !== ''
    ? numeric
    : Date.parse(String(raw).replace(/-/g, '/'));
  if (!Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

function workContentKey(work) {
  return crypto.createHash('sha1').update([
    String(work.title || '').trim().toLowerCase(),
    String(work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''),
  ].join('\n')).digest('hex');
}

ensureColumn('tracked_accounts', 'group_name', "TEXT NOT NULL DEFAULT '其他'");
ensureColumn('inspirations', 'source_items', 'TEXT');
ensureColumn('inspirations', 'kb_link', 'TEXT');
ensureColumn('inspirations', 'config_id', 'TEXT');
ensureColumn('inspirations', 'run_id', 'TEXT');
ensureColumn('inspirations', 'generation_type', "TEXT DEFAULT 'manual'");
ensureColumn('inspirations', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('inspirations', 'feedback_state', 'TEXT');
ensureColumn('inspirations', 'deleted_at', 'INTEGER');
ensureColumn('inspirations', 'source_mode', "TEXT NOT NULL DEFAULT 'legacy'");
ensureColumn('inspirations', 'generation_note', 'TEXT');
ensureColumn('inspirations', 'generated_by', 'TEXT');
ensureColumn('kb_config', 'provider', 'TEXT');
ensureColumn('account_works', 'publish_at', 'INTEGER');
ensureColumn('account_works', 'content_key', 'TEXT');
ensureColumn('account_snapshots', 'score', 'REAL');
ensureColumn('account_snapshots', 'analysis', 'TEXT');
ensureColumn('inspiration_keyword_configs', 'search_mode', "TEXT NOT NULL DEFAULT 'combined'");
ensureColumn('wersss_subscriptions', 'updated_at', 'INTEGER');
ensureColumn('sessions', 'user_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
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
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_account_works_publish
  ON account_works(account_id, publish_at DESC, synced_at DESC);
  CREATE INDEX IF NOT EXISTS idx_account_works_content
  ON account_works(account_id, content_key);
`);
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
ensureColumn('crontab', 'notify_on_failure', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('crontab', 'notify_on_success', 'INTEGER NOT NULL DEFAULT 0');

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
    { id: 'hot-daily-ai-gzh', name: 'AI 公众号昨日榜', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'ai-gzh' } },
    { id: 'hot-daily-ai-bili', name: 'AI B站昨日榜', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'ai-bili' } },
    { id: 'hot-daily-ai-xhs', name: 'AI 小红书昨日榜', cron_expr: '0 12 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-platform', task_config: { platform: 'ai-xhs' } },
    { id: 'hot-trend-analysis', name: '昨日热点关键词趋势分析', cron_expr: '0 23 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'hot-trend-analysis', task_config: null },
    { id: 'hot-daily-report', name: '每日热榜日报推送', cron_expr: '30 9 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'daily-hot-report', task_config: null },
    { id: 'tracked-account-daily', name: '勾选账号昨日数据刷新', cron_expr: '0 7 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'tracker-refresh', task_config: null },
    { id: 'cache-clean', name: 'API缓存清理', cron_expr: '*/10 * * * *', enabled: 1, task_type: 'cache-clean' },
    { id: 'usage-clean', name: 'API 用量日志清理', cron_expr: '0 0 * * *', enabled: 1, task_type: 'usage-clean' },
    { id: 'wersss-sync', name: 'WeRss 公众号文章同步', cron_expr: '0 8 * * *', enabled: ENABLE_SCHEDULER ? 1 : 0, task_type: 'wersss-sync', task_config: null },
  ];
  const upsert = db.prepare(`
    INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      task_type = excluded.task_type,
      task_config = excluded.task_config
  `);
  const now = Date.now();
  db.prepare("DELETE FROM crontab WHERE id = 'daily-snapshot'").run();
  for (const d of defaults) {
    upsert.run(
      d.id,
      d.name,
      d.cron_expr,
      d.enabled,
      d.task_type,
      d.task_config ? JSON.stringify(d.task_config) : null,
      now,
    );
  }
}
registerDefaultCrons();

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function getCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex');
  const derived = crypto.scryptSync(String(password), saltBuffer, 64, PASSWORD_SCRYPT_OPTIONS);
  return `scrypt$${PASSWORD_SCRYPT_OPTIONS.N}$${PASSWORD_SCRYPT_OPTIONS.r}$${PASSWORD_SCRYPT_OPTIONS.p}$${saltBuffer.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  const [scheme, n, r, p, saltHex, hashHex] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PASSWORD_SCRYPT_OPTIONS.maxmem,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw new Error('用户名需为 3-32 位字母、数字、中文、点、下划线或短横线');
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 6 || password.length > 128) {
    throw new Error('密码长度需为 6-128 位');
  }
  return password;
}

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
function getWersssConfigRow() {
  return db.prepare('SELECT * FROM wersss_config WHERE id = 1').get();
}

function getWersssConfig() {
  const row = getWersssConfigRow();
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    username: row.username,
    password: decryptKb(row.password_enc),
    token: row.token,
    tokenExpiresAt: row.token_expires_at,
    enabled: Boolean(row.enabled),
  };
}

async function getValidWersssToken() {
  const config = getWersssConfig();
  if (!config || !config.enabled) throw new Error('WeRss 接入未配置');
  const now = Date.now();
  if (config.token && config.tokenExpiresAt && config.tokenExpiresAt - now > 60 * 1000) {
    return { token: config.token, config };
  }
  const result = await wersss.login(config.baseUrl, config.username, config.password);
  if (!result?.access_token) throw new Error('WeRss 登录未返回 token');
  const expiresIn = result.expires_in ? Number(result.expires_in) * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = now + expiresIn;
  db.prepare(`UPDATE wersss_config SET token = ?, token_expires_at = ?, updated_at = ? WHERE id = 1`)
    .run(result.access_token, expiresAt, now);
  return { token: result.access_token, config: { ...config, token: result.access_token, tokenExpiresAt: expiresAt } };
}

async function syncWersssArticles() {
  const cfgRow = getWersssConfigRow();
  if (!cfgRow) throw new Error('WeRss 未配置');
  if (!cfgRow.enabled) throw new Error('WeRss 接入已禁用');
  const { token, config } = await getValidWersssToken();
  const tokenRefreshed = !cfgRow.token || cfgRow.token !== token;
  const subs = db.prepare('SELECT * FROM wersss_subscriptions WHERE enabled = 1').all();
  if (!subs.length) return { ok: true, tokenStatus: 'valid', tokenRefreshed, synced: 0, articles: 0, perMp: [] };
  const now = Date.now();
  // 刷新订阅公众号元信息（名称、头像等可能变化）
  try {
    const freshSubs = await wersss.listSubscriptions(config.baseUrl, token, { limit: 100 });
    const updateSubMeta = db.prepare(`
      UPDATE wersss_subscriptions
      SET mp_name = COALESCE(NULLIF(?, ''), mp_name),
          mp_alias = COALESCE(NULLIF(?, ''), mp_alias),
          avatar = COALESCE(NULLIF(?, ''), avatar),
          updated_at = ?
      WHERE mp_id = ?
    `);
    for (const mp of freshSubs) {
      updateSubMeta.run(mp.mpName, mp.mpAlias, mp.avatar, now, mp.mpId);
    }
  } catch (e) {
    console.warn('[wersss] 刷新订阅元信息失败:', e.message);
  }
  const upsertArticle = db.prepare(`
    INSERT INTO wersss_articles (id, mp_id, title, summary, content, url, cover, publish_time, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(NULLIF(?, ''), wersss_articles.title),
      summary = COALESCE(NULLIF(?, ''), wersss_articles.summary),
      url = COALESCE(NULLIF(?, ''), wersss_articles.url),
      cover = COALESCE(NULLIF(?, ''), wersss_articles.cover),
      publish_time = COALESCE(?, wersss_articles.publish_time),
      synced_at = ?
  `);
  const updateSub = db.prepare('UPDATE wersss_subscriptions SET last_synced_at = ? WHERE mp_id = ?');
  let totalArticles = 0;
  const perMp = [];
  for (const sub of subs) {
    try {
      // 先触发 we-mp-rss 去微信抓取最新文章（同步等待返回）
      try {
        await wersss.updateMp(config.baseUrl, token, sub.mp_id);
      } catch (e) {
        console.warn(`[wersss] updateMp ${sub.mp_name} 失败:`, e.message);
      }
      let offset = 0;
      let count = 0;
      let batch;
      do {
        batch = await wersss.listArticles(config.baseUrl, token, { mpId: sub.mp_id, limit: 100, offset, hasContent: false });
        if (!batch.length) break;
        const tx = db.transaction((items) => {
          for (const a of items) {
            if (!a.id) continue;
            upsertArticle.run(
            a.id, sub.mp_id, a.title || '', a.summary || '', a.content || '', a.url || '', a.cover || '', a.publishTime || null, now,
            a.title || '', a.summary || '', a.url || '', a.cover || '', a.publishTime || null, now,
          );
            count++;
          }
        });
        tx(batch);
        offset += batch.length;
      } while (batch.length === 100 && offset < 1000);
      updateSub.run(now, sub.mp_id);
      totalArticles += count;
      perMp.push({ mpId: sub.mp_id, mpName: sub.mp_name, count, ok: true });
      console.log(`[wersss] 同步公众号 ${sub.mp_name}(${sub.mp_id}) 完成，新增/更新 ${count} 条`);
    } catch (e) {
      console.warn(`[wersss] 同步公众号 ${sub.mp_name}(${sub.mp_id}) 失败:`, e.message);
      perMp.push({ mpId: sub.mp_id, mpName: sub.mp_name, count: 0, ok: false, error: e.message });
    }
  }
  const failed = perMp.filter(m => !m.ok);
  return {
    ok: failed.length === 0,
    tokenStatus: 'valid',
    tokenRefreshed,
    synced: subs.length,
    articles: totalArticles,
    failed: failed.length,
    perMp,
  };
}

async function runWersssSyncCron() {
  const syncResult = await syncWersssArticles();
  let prefetchResult = null;
  if (syncResult.ok && syncResult.articles > 0) {
    try {
      prefetchResult = await prefetchWersssContent();
    } catch (e) {
      console.warn('[wersss] 预抓取正文失败:', e.message);
      prefetchResult = { error: e.message };
    }
  }
  return { ...syncResult, prefetch: prefetchResult };
}

// 批量预抓取正文（4 并发，避免压垮 we-mp-rss）
async function prefetchWersssContent() {
  const { token, config } = await getValidWersssToken();
  const pending = db.prepare(`SELECT id FROM wersss_articles WHERE content IS NULL OR length(content) < 100`).all();
  if (!pending.length) return { total: 0, done: 0, failed: 0 };
  const CONCURRENCY = 4;
  const update = db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?');
  let done = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(a => wersss.getArticle(config.baseUrl, token, a.id))
    );
    const tx = db.transaction(() => {
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value?.content && r.value.content.length >= 100) {
          update.run(r.value.content, batch[idx].id);
          done++;
        } else {
          failed++;
        }
      });
    });
    tx();
  }
  return { total: pending.length, done, failed };
}

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
    sources: Array.isArray(c?.sources) ? c.sources.filter(s => INSPIRATION_SOURCE_KEYS.has(s)) : DEFAULT_INSPIRATION_SOURCES,
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

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function currentSession(req) {
  const token = getCookies(req).furnace_session;
  const session = token ? sessionGet(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessionDel(token);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.userId);
  if (!user) {
    sessionDel(token);
    return null;
  }
  return { token, session, user };
}

function isAuthorized(req) {
  return Boolean(currentSession(req));
}

const KB_ENC_ALGO = 'aes-256-gcm';
const KB_ENC_KEY_SRC = process.env.KB_ENCRYPTION_KEY;
if (!KB_ENC_KEY_SRC) {
  console.warn('[security] 未配置 KB_ENCRYPTION_KEY，知识库凭证使用内置默认密钥加密，安全性不足。请在 .env 设置 KB_ENCRYPTION_KEY（生成命令：openssl rand -hex 32；已有数据库设置后请勿修改）');
}
const KB_ENC_KEY = crypto.createHash('sha256').update(String(KB_ENC_KEY_SRC || 'furnace-kb-key')).digest();

function encryptKb(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(KB_ENC_ALGO, KB_ENC_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + enc;
}

function decryptKb(text) {
  if (!text) return '';
  const parts = text.split(':');
  if (parts.length !== 3) return '';
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const enc = parts[2];
  const decipher = crypto.createDecipheriv(KB_ENC_ALGO, KB_ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
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

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
        reject(new Error('请求体超过 2MB'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const parsed = parseJson(body);
      if (parsed == null) reject(new Error('请求体不是有效 JSON'));
      else resolve({ text: body, data: parsed });
    });
    req.on('error', reject);
  });
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableObject(value[key]);
    return result;
  }, {});
}

function getCacheKey(endpoint, query, body) {
  return `${endpoint}?${query}&${JSON.stringify(stableObject(body))}`;
}

function getCached(cacheKey, endpoint) {
  const row = db.prepare('SELECT response, status_code, updated_at FROM api_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  const ttl = CACHE_TTL[endpoint] || CACHE_TTL.default;
  if (Date.now() - row.updated_at > ttl) return null;
  return row;
}

function isCacheableRedfoxResponse(status, response) {
  if (status < 200 || status >= 300) return false;
  const payload = parseJson(response);
  if (payload && Object.hasOwn(payload, 'code') && ![200, 2000].includes(payload.code)) return false;
  return true;
}

function setCache(cacheKey, endpoint, body, status, response) {
  if (!isCacheableRedfoxResponse(status, response)) return;
  const now = Date.now();
  db.prepare(`
    INSERT INTO api_cache (cache_key, endpoint, request_body, response, status_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      response = excluded.response,
      status_code = excluded.status_code,
      updated_at = excluded.updated_at
  `).run(cacheKey, endpoint, JSON.stringify(body), response, status, now, now);
}

function logApiUsage(endpoint, status, cached = false) {
  db.prepare(`
    INSERT INTO api_usage (endpoint, status_code, cached, created_at)
    VALUES (?, ?, ?, ?)
  `).run(endpoint, status, cached ? 1 : 0, Date.now());
}

function logAction(action, triggerSource, dataSource, detail = {}, apiCalls = 0, llmCalls = 0) {
  db.prepare(`
    INSERT INTO action_logs
      (action, trigger_source, data_source, api_calls, llm_calls, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(action, triggerSource, dataSource, apiCalls, llmCalls, JSON.stringify(detail || {}), Date.now());
}

function listActionLogs(limit = 100) {
  return db.prepare(`
    SELECT * FROM action_logs ORDER BY created_at DESC LIMIT ?
  `).all(clamp(limit, 1, 200)).map(row => ({
    id: row.id,
    action: row.action,
    triggerSource: row.trigger_source,
    dataSource: row.data_source,
    apiCalls: row.api_calls,
    llmCalls: row.llm_calls,
    detail: parseJson(row.detail_json) || {},
    createdAt: row.created_at,
  }));
}

function redfoxRequest(endpoint, body = {}, query = '', method = 'POST') {
  if (!API_KEY) return Promise.reject(new Error('未配置 REDFOX_API_KEY'));
  if (!REDFOX_ENDPOINTS.has(endpoint)) return Promise.reject(new Error('不允许访问该 RedFox 端点'));
  const requestBody = method === 'GET' ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: REDFOX_HOST,
      port: 443,
      path: `${REDFOX_PATH_PREFIX}${endpoint}${query}`,
      method,
      headers: {
        'X-API-KEY': API_KEY,
        'REDFOX_API_KEY': API_KEY,
        ...(requestBody ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        } : {}),
      },
      timeout: 30000,
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 502, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('RedFox 请求超时')));
    req.on('error', reject);
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

async function redfoxData(endpoint, body = {}) {
  const response = await redfoxRequest(endpoint, body);
  logApiUsage(endpoint, response.status, false);
  const payload = parseJson(response.body);
  if (response.status < 200 || response.status >= 300 || !payload || ![200, 2000].includes(payload.code)) {
    throw new Error(payload?.msg || payload?.message || `RedFox HTTP ${response.status}`);
  }
  return payload.data;
}

async function redfoxGetData(endpoint, queryParams = {}) {
  const query = `?${new URLSearchParams(queryParams).toString()}`;
  const response = await redfoxRequest(endpoint, {}, query, 'GET');
  logApiUsage(endpoint, response.status, false);
  const payload = parseJson(response.body);
  if (response.status < 200 || response.status >= 300 || !payload || ![200, 2000].includes(payload.code)) {
    throw new Error(payload?.msg || payload?.message || `RedFox HTTP ${response.status}`);
  }
  return payload.data;
}

function parseSkillFile(skillPath) {
  const content = fs.readFileSync(skillPath, 'utf8');
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const metadata = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (match && match[2]) metadata[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || metadata.name || path.basename(path.dirname(skillPath));
  const slug = path.basename(path.dirname(skillPath));
  const text = `${slug} ${title} ${metadata.description || ''}`;
  let category = '综合工具';
  if (/douyin|抖音/i.test(text)) category = '抖音';
  else if (/xiaohongshu|小红书/i.test(text)) category = '小红书';
  else if (/wechat|gzh|公众号/i.test(text)) category = '公众号';
  else if (/hot|trend|热榜|热点/i.test(text)) category = '热点';
  else if (/write|rewrite|创作|改写/i.test(text)) category = '内容创作';
  return {
    slug,
    name: metadata.name || slug,
    title,
    description: metadata.description || '',
    category,
    path: path.relative(__dirname, skillPath),
    content,
  };
}

function skillUpdateState() {
  const state = getLocalData('skills', 'community-update') || {};
  const newSlugs = state.newUntil > Date.now() && Array.isArray(state.newSlugs)
    ? new Set(state.newSlugs)
    : new Set();
  return { ...state, newSlugs };
}

function listSkills() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  const state = skillUpdateState();
  return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(SKILLS_ROOT, entry.name, 'SKILL.md'))
    .filter(file => fs.existsSync(file))
    .map(file => {
      const skill = parseSkillFile(file);
      return { ...skill, isNew: state.newSlugs.has(skill.slug) };
    })
    .sort((a, b) => a.category.localeCompare(b.category, 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'));
}

function getSkill(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  const skillPath = path.join(SKILLS_ROOT, slug, 'SKILL.md');
  if (!skillPath.startsWith(`${SKILLS_ROOT}${path.sep}`) || !fs.existsSync(skillPath)) return null;
  const skill = parseSkillFile(skillPath);
  return { ...skill, isNew: skillUpdateState().newSlugs.has(skill.slug) };
}

function gitBlobSha(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
}

function localSkillManifest() {
  const files = new Map();
  if (!fs.existsSync(SKILLS_ROOT)) return files;
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath, relative);
      else if (entry.isFile()) files.set(relative, gitBlobSha(fs.readFileSync(fullPath)));
    }
  };
  walk(SKILLS_ROOT);
  return files;
}

async function githubJson(apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'insprira',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

async function remoteSkillManifest() {
  const commit = await githubJson(`/repos/${SKILLS_GITHUB_REPO}/commits/main`);
  const treeSha = commit?.commit?.tree?.sha;
  if (!treeSha) throw new Error('无法读取 GitHub Skill 版本');
  const tree = await githubJson(`/repos/${SKILLS_GITHUB_REPO}/git/trees/${treeSha}?recursive=1`);
  const files = new Map();
  for (const entry of tree.tree || []) {
    if (entry.type !== 'blob' || !entry.path.startsWith('skills/')) continue;
    files.set(entry.path.slice('skills/'.length), entry.sha);
  }
  return {
    commitSha: commit.sha,
    commitTime: commit.commit?.committer?.date || commit.commit?.author?.date || '',
    message: String(commit.commit?.message || '').split('\n')[0],
    files,
  };
}

function compareSkillManifests(localFiles, remoteFiles) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [file, sha] of remoteFiles) {
    if (!localFiles.has(file)) added.push(file);
    else if (localFiles.get(file) !== sha) changed.push(file);
  }
  for (const file of localFiles.keys()) {
    if (!remoteFiles.has(file)) removed.push(file);
  }
  const addedSlugs = [...new Set(added.map(file => file.split('/')[0]).filter(Boolean))];
  return {
    available: Boolean(added.length || changed.length || removed.length),
    added,
    changed,
    removed,
    addedSlugs,
  };
}

async function communitySkillUpdateStatus() {
  const remote = await remoteSkillManifest();
  const comparison = compareSkillManifests(localSkillManifest(), remote.files);
  const state = skillUpdateState();
  return {
    ...comparison,
    remoteSha: remote.commitSha,
    remoteTime: remote.commitTime,
    message: remote.message,
    localSha: state.remoteSha || '',
    localCount: listSkills().length,
    checkedAt: Date.now(),
  };
}

let activeSkillUpdate = null;

async function updateCommunitySkills() {
  if (activeSkillUpdate) return activeSkillUpdate;
  activeSkillUpdate = (async () => {
    const status = await communitySkillUpdateStatus();
    if (!status.available) return { ...status, updated: false, skills: listSkills() };
    const workRoot = path.join(SKILLS_REPO_ROOT, `.skill-update-${crypto.randomUUID()}`);
    const archivePath = path.join(workRoot, 'community.zip');
    const extractRoot = path.join(workRoot, 'extract');
    const backupPath = path.join(SKILLS_REPO_ROOT, `.skills-backup-${Date.now()}`);
    fs.mkdirSync(extractRoot, { recursive: true });
    try {
      const response = await fetch(
        `https://codeload.github.com/${SKILLS_GITHUB_REPO}/zip/${status.remoteSha}`,
        { signal: AbortSignal.timeout(60000) },
      );
      if (!response.ok) throw new Error(`Skill 下载失败：HTTP ${response.status}`);
      fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
      await execFileAsync('unzip', ['-q', archivePath, '-d', extractRoot], {
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const extractedRepo = fs.readdirSync(extractRoot, { withFileTypes: true })
        .find(entry => entry.isDirectory());
      const nextSkills = extractedRepo
        ? path.join(extractRoot, extractedRepo.name, 'skills')
        : '';
      const nextCount = nextSkills && fs.existsSync(nextSkills)
        ? fs.readdirSync(nextSkills, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
        : 0;
      if (!nextCount || !fs.existsSync(path.join(nextSkills, 'trending-hub', 'SKILL.md'))) {
        throw new Error('下载包校验失败，未替换本地 Skill');
      }
      if (fs.existsSync(SKILLS_ROOT)) fs.renameSync(SKILLS_ROOT, backupPath);
      try {
        fs.renameSync(nextSkills, SKILLS_ROOT);
      } catch (error) {
        if (fs.existsSync(backupPath) && !fs.existsSync(SKILLS_ROOT)) {
          fs.renameSync(backupPath, SKILLS_ROOT);
        }
        throw error;
      }
      fs.rmSync(backupPath, { recursive: true, force: true });
      const updatedAt = Date.now();
      setLocalData('skills', 'community-update', {
        remoteSha: status.remoteSha,
        remoteTime: status.remoteTime,
        updatedAt,
        newSlugs: status.addedSlugs,
        newUntil: updatedAt + SKILLS_NEW_BADGE_MS,
      });
      const result = {
        ...status,
        updated: true,
        updatedAt,
        localCount: listSkills().length,
        skills: listSkills().map(({ content, ...skill }) => skill),
      };
      logAction('update-community-skills', 'button', 'github', {
        remoteSha: status.remoteSha,
        added: status.added.length,
        changed: status.changed.length,
        removed: status.removed.length,
        newSlugs: status.addedSlugs,
      });
      return result;
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  })();
  try {
    return await activeSkillUpdate;
  } finally {
    activeSkillUpdate = null;
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { PATH: EXTENDED_PATH, ...options.env } : { ...process.env, PATH: EXTENDED_PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const maxBuffer = options.maxBuffer || 5 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      settled = true;
      reject(new Error(`${path.basename(command)} 执行超时`));
    }, options.timeout || 180000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxBuffer) child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxBuffer) child.kill('SIGTERM');
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} 退出码 ${code}`));
    });
    child.stdin.end(options.input || '');
  });
}

const EXTRA_BIN_DIRS = (() => {
  const home = os.homedir();
  return [
    path.join(home, '.npm-global/bin'),
    path.join(home, '.npm-global/lib/node_modules/.bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.kimi-code/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.yarn/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);
})();

const EXTENDED_PATH = [
  ...String(process.env.PATH || '').split(path.delimiter),
  ...EXTRA_BIN_DIRS,
].filter(Boolean).join(path.delimiter);

function resolveExecutable(command) {
  if (!command) return null;
  if (command.includes(path.sep)) {
    return fs.existsSync(command) ? command : null;
  }
  const directories = [
    ...String(process.env.PATH || '').split(path.delimiter),
    ...EXTRA_BIN_DIRS,
  ];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function locateExecutable(command) {
  const resolved = resolveExecutable(command);
  if (resolved) return { path: resolved, reason: '' };
  const home = os.homedir();
  const checkedDirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...EXTRA_BIN_DIRS,
  ];
  return {
    path: null,
    reason: `未在 PATH 中找到「${command}」。已检查：${checkedDirs.slice(0, 8).join('、')}${checkedDirs.length > 8 ? ` 等 ${checkedDirs.length} 个目录` : ''}`,
  };
}

function findNestedString(value, key) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  for (const child of Object.values(value)) {
    const found = findNestedString(child, key);
    if (found) return found;
  }
  return '';
}

function parseAgentJsonLines(output, role = 'assistant') {
  const events = String(output || '').split(/\r?\n/)
    .map(line => parseJson(line))
    .filter(Boolean);
  const messages = events.filter(event => event.role === role && typeof event.content === 'string');
  return messages.length ? messages[messages.length - 1].content.trim() : '';
}

async function listLocalAgents() {
  const agents = [];
  for (const [id, name, family, bin] of [
    ['codex', 'Codex', 'Codex CLI', CODEX_BIN],
    ['claude', 'Claude Code', 'Claude Code', CLAUDE_BIN],
    ['kimi', 'Kimi', 'Kimi Code CLI', KIMI_BIN],
  ]) {
    const located = locateExecutable(bin);
    agents.push({
      id,
      name,
      family,
      available: Boolean(located.path),
      reason: located.reason,
      path: located.path || '',
    });
  }
  const openclawPath = resolveExecutable(OPENCLAW_BIN);
  if (openclawPath) {
    try {
      const { stdout } = await runProcess(openclawPath, ['agents', 'list', '--json'], {
        cwd: __dirname,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const profiles = parseJson(stdout);
      if (Array.isArray(profiles) && profiles.length) {
        for (const profile of profiles) {
          agents.push({
            id: `openclaw:${profile.id}`,
            name: `OpenClaw · ${profile.identityName || profile.name || profile.id}`,
            family: 'OpenClaw',
            model: profile.model || '',
            available: true,
          });
        }
      } else {
        agents.push({ id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw', available: true });
      }
    } catch (error) {
      agents.push({
        id: 'openclaw',
        name: 'OpenClaw',
        family: 'OpenClaw',
        available: false,
        reason: error.message,
      });
    }
  } else {
    agents.push({ id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw', available: false, reason: '未检测到 CLI' });
  }
  const hermesLocated = locateExecutable(HERMES_BIN);
  agents.push({
    id: 'hermes',
    name: 'Hermes',
    family: 'Hermes Agent',
    available: Boolean(hermesLocated.path),
    reason: hermesLocated.path ? '' : hermesLocated.reason || '未检测到 Hermes CLI',
  });
  return agents;
}

async function executeAgent(agentId, prompt, mode, outputFile) {
  if (agentId === 'codex') {
    const executable = resolveExecutable(CODEX_BIN);
    if (!executable) throw new Error('未检测到 Codex CLI');
    await runProcess(executable, [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      mode === 'workspace' ? 'workspace-write' : 'read-only',
      '-C',
      __dirname,
      '-o',
      outputFile,
      prompt,
    ], { cwd: __dirname, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
    return fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').trim() : '';
  }
  if (agentId === 'claude') {
    const executable = resolveExecutable(CLAUDE_BIN);
    if (!executable) throw new Error('未检测到 Claude Code CLI');
    const { stdout } = await runProcess(executable, [
      '-p',
      '--no-session-persistence',
      '--permission-mode',
      mode === 'workspace' ? 'acceptEdits' : 'plan',
      prompt,
    ], { cwd: __dirname, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.trim();
  }
  if (agentId === 'kimi') {
    const executable = resolveExecutable(KIMI_BIN);
    if (!executable) throw new Error('未检测到 Kimi CLI');
    const args = ['--prompt', prompt, '--output-format', 'stream-json'];
    if (mode === 'workspace') args.push('--yolo');
    const { stdout } = await runProcess(executable, args, {
      cwd: __dirname,
      timeout: 180000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return parseAgentJsonLines(stdout)
      || stdout.replace(/\nTo resume this session:[\s\S]*$/i, '').trim();
  }
  if (agentId === 'openclaw' || agentId.startsWith('openclaw:')) {
    const executable = resolveExecutable(OPENCLAW_BIN);
    if (!executable) throw new Error('未检测到 OpenClaw CLI');
    const profile = agentId.includes(':') ? agentId.slice(agentId.indexOf(':') + 1) : '';
    const args = ['agent'];
    if (profile) args.push('--agent', profile);
    args.push('--message', prompt, '--json', '--timeout', '180');
    const { stdout } = await runProcess(executable, args, {
      cwd: __dirname,
      timeout: 200000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = parseJson(stdout);
    return findNestedString(payload, 'finalAssistantVisibleText')
      || findNestedString(payload, 'finalAssistantRawText')
      || findNestedString(payload, 'text');
  }
  if (agentId === 'hermes') {
    if (!resolveExecutable(HERMES_BIN)) throw new Error('当前机器未安装 Hermes CLI');
    throw new Error('已检测到 Hermes，但尚未识别其非交互调用协议，请配置兼容适配器');
  }
  throw new Error('不支持的本地 Agent');
}

async function runWechatDiagnosis(accountName) {
  if (diagnosisBusy) throw new Error('已有公众号诊断正在执行，请稍后重试');
  diagnosisBusy = true;
  try {
    const script = path.join(WECHAT_ANALYZER_ROOT, 'scripts', 'wechat_analyzer.py');
    if (!fs.existsSync(script)) throw new Error('本地公众号诊断 Skill 未安装');
    await execFileAsync('python3', [
      script,
      'query',
      '--account_names',
      accountName,
    ], {
      cwd: WECHAT_ANALYZER_ROOT,
      env: { ...process.env, PATH: EXTENDED_PATH, REDFOX_API_KEY: API_KEY },
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    logApiUsage('gzhUser/query', 200, false);
    const reportPath = path.join(WECHAT_ANALYZER_ROOT, 'output', 'report_data.json');
    const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
    if (!report?.header) throw new Error('诊断 Skill 未返回有效报告');
    return report;
  } finally {
    diagnosisBusy = false;
  }
}

async function runPythonDiagnosis(root, code, input) {
  const { stdout } = await runProcess('python3', ['-c', code], {
    cwd: root,
    input: JSON.stringify(input),
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const result = parseJson(stdout.trim());
  if (!result) throw new Error('本地诊断 Skill 未返回有效结果');
  return result;
}

async function runDouyinDiagnosis(tracker) {
  const data = await redfoxData('dyUser/query', {
    accountIds: [tracker.accountId],
    source: '灵感熔炉-抖音账号诊断',
  });
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw?.nickname) throw new Error('RedFox 未返回该抖音账号的诊断数据');
  const result = await runPythonDiagnosis(DOUYIN_ANALYZER_ROOT, [
    'import json,sys',
    'sys.path.insert(0, "scripts")',
    'from generate_diagnosis_report import DouyinDiagnosisReportV3',
    'd=json.load(sys.stdin)',
    'g=DouyinDiagnosisReportV3(d)',
    'a=g._score_body()[0]; b=g._score_content()[0]; c=g._score_operation()[0]; e=g._score_platform()[0]',
    'total=a+b+c+e',
    'grade=g._get_grade(total)',
    'print(json.dumps({"score":total,"grade":grade[2]+" "+grade[1],"dimensions":[["账号体量",a,35],["内容表现",b,35],["运营活跃度",c,20],["平台指数",e,10]],"markdown":g.generate_report()},ensure_ascii=False))',
  ].join(';'), raw);
  return {
    platform: 'dy',
    header: {
      '账号名': raw.nickname,
      '账号标识': raw.uniqueId || raw.accountId || tracker.accountId,
      '账号类型': raw.category || '',
      '红狐指数': raw.redfoxIndex,
      '粉丝数': raw.followerCount,
      '数据更新时间': raw.crawlTime || '',
    },
    scores: { '综合评分': result.score, '综合等级': result.grade },
    dimensions: result.dimensions.map(([name, score, max]) => ({ name, score, max })),
    works: (raw.works || []).map(work => ({
      '标题': work.desc || work.title || '(无标题)',
      '发布时间': work.createTime || work.publishTime || '',
      '阅读数': work.playCount,
      '点赞数': work.diggCount,
      '评论数': work.commentCount,
      '链接': work.shareUrl || work.url || '',
    })),
    markdown: result.markdown,
    _raw: raw,
  };
}

async function runXhsDiagnosis(tracker, sourceData = null) {
  const data = sourceData || await redfoxData('xhsUser/query', {
    userIds: [tracker.accountId],
    source: '灵感熔炉-小红书账号诊断',
  });
  const raw = xhsTrackerAccounts(data)[0];
  if (!raw?.nickname) throw new Error('RedFox 未返回该小红书账号的诊断数据');
  const result = await runPythonDiagnosis(XHS_ANALYZER_ROOT, [
    'import json,sys',
    'sys.path.insert(0, "scripts")',
    'from xiaohongshu_analyzer import _analyze_single_account',
    'd=json.load(sys.stdin)',
    'print(json.dumps(_analyze_single_account(d, bool(d.get("works"))),ensure_ascii=False))',
  ].join(';'), raw);
  const scores = result.scores || {};
  const names = [
    ['账号定位', 10], ['粉丝画像与需求', 15], ['选题体系', 15], ['封面风格', 10],
    ['爆文能力', 15], ['互动规模', 20], ['更新产能', 15],
  ];
  return {
    ...result,
    platform: 'xhs',
    header: {
      ...(result.header || {}),
      '账号名': raw.nickname,
      '账号标识': raw.redId || tracker.accountId,
      '红狐指数': raw.recentIndex,
      '粉丝数': raw.fans,
      '数据更新时间': raw.gmtCreate || '',
    },
    dimensions: names.map(([name, max]) => ({
      name,
      score: scores[`${name}得分`],
      max: scores[`${name}满分`] || max,
    })),
    works: (raw.works || []).map(work => ({
      '标题': work.title || work.desc || '(无标题)',
      '发布时间': work.publishTime || work.createTime || '',
      '阅读数': work.viewCount,
      '点赞数': work.likedCount,
      '评论数': work.commentCount,
      '链接': work.url || work.workUrl || '',
    })),
    _raw: raw,
  };
}

function normalizeWechatDiagnosis(report) {
  const scores = report.scores || {};
  return {
    ...report,
    platform: 'gzh',
    dimensions: [
      ['内容健康度', scores['内容健康度得分']],
      ['用户活跃度', scores['用户活跃度得分']],
      ['核心数据表现', scores['内容核心数据表现得分']],
      ['运营规范性', scores['运营规范性得分']],
    ].map(([name, score]) => ({ name, score, max: 100 })),
  };
}

async function runPlatformDiagnosis(tracker, sourceData = null) {
  if (tracker.plat === 'gzh') return normalizeWechatDiagnosis(await runWechatDiagnosis(tracker.name));
  if (tracker.plat === 'dy') return runDouyinDiagnosis(tracker);
  if (tracker.plat === 'xhs') return runXhsDiagnosis(tracker, sourceData);
  throw new Error('当前平台不支持账号诊断');
}

async function runLocalAgent(body) {
  if (agentBusy) throw new Error('Agent 正在处理上一条消息，请稍后重试');
  let message = String(body.message || '').trim();
  if (!message) throw new Error('请输入对话内容');
  if (message.length > 10000) throw new Error('单次消息不能超过 10000 字');
  const slashCommand = message.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
  const skill = slashCommand ? getSkill(slashCommand[1]) : null;
  if (slashCommand && !skill) throw new Error(`Skill /${slashCommand[1]} 不存在`);
  if (slashCommand) {
    message = String(slashCommand[2] || '').trim();
    if (!message) throw new Error(`请在 /${skill.slug} 后输入具体任务`);
  }
  const agentId = String(body.agent || 'codex');
  const agents = await listLocalAgents();
  const selectedAgent = agents.find(agent => agent.id === agentId);
  if (!selectedAgent) throw new Error('选择的 Agent 不存在');
  if (!selectedAgent.available) throw new Error(selectedAgent.reason || `${selectedAgent.name} 当前不可用`);
  const mode = body.mode === 'workspace' ? 'workspace' : 'read';
  const outputFile = path.join(os.tmpdir(), `insprira-agent-${crypto.randomUUID()}.txt`);
  const skillInstruction = skill
    ? `用户选择了本地 Skill：${skill.title}。你必须先读取 ${path.join(SKILLS_ROOT, skill.slug, 'SKILL.md')}，并按其中工作流执行。`
    : '用户未指定 Skill。请先判断是否需要读取 skills/redfox-community/skills 下的相关 SKILL.md。';
  const prompt = [
    '你是“灵感熔炉”的本地开发与自媒体数据 Agent。',
    `当前项目目录：${__dirname}`,
    skillInstruction,
    mode === 'workspace'
      ? '当前允许修改项目文件。修改后应执行必要验证，并在回答中列出改动。'
      : '当前为只读模式。不要修改任何文件，只进行查询、分析和回答。',
    '使用中文回答，结论要具体。不要泄露环境变量、API Key、Cookie 或其他密钥。',
    `用户请求：${message}`,
  ].join('\n\n');
  agentBusy = true;
  try {
    const answer = await executeAgent(agentId, prompt, mode, outputFile);
    if (!answer) throw new Error(`${selectedAgent.name} 未返回内容`);
    return { answer, agent: agentId, agentName: selectedAgent.name, skill: skill?.slug || null, mode };
  } catch (error) {
    if (/usage limit|rate limit|credits|quota|额度|限额/i.test(error.message)) {
      throw new Error(`${selectedAgent.name} 当前额度已用尽，请稍后重试或切换其他 Agent`);
    }
    if (/auth|login|credential|api key/i.test(error.message)) {
      throw new Error(`${selectedAgent.name} 尚未完成登录或凭证配置`);
    }
    throw error;
  } finally {
    agentBusy = false;
    fs.rmSync(outputFile, { force: true });
  }
}

async function getOfficialQuota() {
  if (!REDFOX_WEB_COOKIE) return { configured: false, error: '未配置 REDFOX_WEB_COOKIE' };
  try {
    const response = await fetch(`https://${REDFOX_HOST}/story/web/points/overview`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: REDFOX_WEB_COOKIE,
      },
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    if (!response.ok || ![0, 200, 2000].includes(payload?.code)) {
      throw new Error(payload?.msg || `HTTP ${response.status}`);
    }
    return { configured: true, data: payload.data ?? payload };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

function usageSummary() {
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const summarize = since => db.prepare(`
    SELECT COUNT(*) AS requests,
      SUM(CASE WHEN cached = 0 THEN 1 ELSE 0 END) AS calls,
      SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cache_hits,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
    FROM api_usage WHERE created_at >= ?
  `).get(since);
  return {
    today: summarize(dayStart.getTime()),
    last30Days: summarize(now - 30 * 24 * 60 * 60 * 1000),
    topEndpoints: db.prepare(`
      SELECT endpoint, COUNT(*) AS calls
      FROM api_usage WHERE created_at >= ? AND cached = 0
      GROUP BY endpoint ORDER BY calls DESC LIMIT 8
    `).all(now - 30 * 24 * 60 * 60 * 1000),
  };
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function dateFromYmd(value, offsetDays) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  date.setDate(date.getDate() + offsetDays);
  return localDate(date);
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSnapshotItems(platform, data) {
  if (platform === 'all') {
    return (Array.isArray(data) ? data : []).map(item => ({
      key: item.keyword,
      title: item.keyword,
      score: Array.isArray(item.plats) ? item.plats.length : 0,
      raw: item,
    }));
  }
  if (['ai-gzh', 'ai-bili', 'ai-xhs'].includes(platform)) {
    const list = Array.isArray(data) ? data : data?.list || [];
    return list.map(item => ({
      key: String(item.photoId || item.id || item.title),
      title: item.title || '(无标题)',
      score: platform === 'ai-gzh'
        ? toNumber(item.readCount) || 0
        : (toNumber(item.likeCount) || 0)
          + (toNumber(item.shareCount) || 0)
          + (toNumber(item.commentCount) || 0),
      raw: item,
    }));
  }
  const list = Array.isArray(data) ? data : data?.list || data?.articles || [];
  return list.map(item => {
    if (platform === 'dy') {
      return {
        key: String(item.workId || item.id || item.title),
        title: item.title || item.content || '(无标题)',
        score: toNumber(item.likeCount) || 0,
        raw: item,
      };
    }
    if (platform === 'xhs') {
      return {
        key: String(item.workId || item.id || item.workTitle || item.title),
        title: item.workTitle || item.title || item.workDesc || item.desc || '(无标题)',
        score: toNumber(item.workLikedCount ?? item.likedCount ?? item.interactiveCount) || 0,
        raw: item,
      };
    }
    return {
      key: String(item.workUuid || item.id || item.title),
      title: item.title || item.summary || '(无标题)',
      score: toNumber(item.readCount ?? item.clicksCount) || 0,
      raw: item,
    };
  });
}

function hotBatchId(platform, dataDate, startedAt) {
  return `${platform}-${dataDate}-${startedAt}-${crypto.randomBytes(4).toString('hex')}`;
}

function saveHotBatch({
  platform,
  dataDate,
  snapshotKind,
  endpoint,
  request,
  response = null,
  items = [],
  status,
  error = null,
  startedAt,
  completedAt: providedCompletedAt = null,
}) {
  const completedAt = providedCompletedAt || Date.now();
  const batchId = hotBatchId(platform, dataDate, startedAt);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO hot_batches
        (id, platform, data_date, snapshot_kind, endpoint, request_json, response_json,
         status, item_count, started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      platform,
      dataDate,
      snapshotKind,
      endpoint,
      JSON.stringify(request || {}),
      response == null ? null : JSON.stringify(response),
      status,
      items.length,
      startedAt,
      completedAt,
      error,
    );
    const insertItem = db.prepare(`
      INSERT INTO hot_batch_items
        (batch_id, rank, item_key, title, score, raw_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    items.forEach((item, index) => {
      insertItem.run(
        batchId,
        index + 1,
        String(item.key || `${index + 1}`),
        String(item.title || '(无标题)'),
        Number(item.score) || 0,
        JSON.stringify(item.raw || {}),
      );
    });
    db.prepare("DELETE FROM local_data WHERE module = 'hot' AND data_key LIKE 'trends:%'").run();
  })();
  return {
    id: batchId,
    platform,
    dataDate,
    status,
    itemCount: items.length,
    completedAt,
    error,
  };
}

function latestHotBatch(platform, expectedDate, snapshotKind) {
  const kindWhere = snapshotKind ? 'AND snapshot_kind = ?' : '';
  const params = snapshotKind ? [platform, snapshotKind] : [platform];
  const expectedAttemptParams = snapshotKind
    ? [platform, snapshotKind, expectedDate]
    : [platform, expectedDate];
  const latestAttempt = db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = ? ${kindWhere} AND data_date = ?
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...expectedAttemptParams) || db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = ? ${kindWhere}
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...params);
  const expectedSuccessParams = snapshotKind
    ? [platform, snapshotKind, expectedDate]
    : [platform, expectedDate];
  let selected = db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = ? ${kindWhere}
      AND data_date = ? AND status = 'success'
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...expectedSuccessParams);
  if (!selected) {
    selected = db.prepare(`
      SELECT *
      FROM hot_batches
      WHERE platform = ? ${kindWhere}
        AND status = 'success' AND data_date <= ?
      ORDER BY data_date DESC, completed_at DESC
      LIMIT 1
    `).get(...params, expectedDate);
  }
  if (!selected && snapshotKind) {
    selected = db.prepare(`
      SELECT *
      FROM hot_batches
      WHERE platform = ? AND status = 'success' AND data_date <= ?
      ORDER BY data_date DESC, completed_at DESC
      LIMIT 1
    `).get(platform, expectedDate);
  }
  if (!selected) return { batch: null, latestAttempt };
  const items = db.prepare(`
    SELECT rank, item_key, title, score, raw_data
    FROM hot_batch_items
    WHERE batch_id = ?
    ORDER BY rank ASC
  `).all(selected.id).map(row => ({
    rank: row.rank,
    key: row.item_key,
    title: row.title,
    score: row.score,
    raw: parseJson(row.raw_data),
    snapshotDate: selected.data_date,
  }));
  const current = selected.data_date === expectedDate
    && selected.snapshot_kind !== 'legacy'
    && latestAttempt?.id === selected.id
    && latestAttempt.status === 'success';
  return {
    batch: selected,
    latestAttempt,
    items,
    sourceMode: current ? 'api' : 'local-cache',
  };
}

function platformCronId(platform) {
  return platform === 'all' ? 'hot-realtime' : `hot-daily-${platform}`;
}

function hotListPayload(platform) {
  const realtime = platform === 'all';
  const expectedDate = realtime ? localDate() : dateDaysAgo(1);
  const snapshotKind = realtime ? 'realtime' : 'daily';
  const result = latestHotBatch(platform, expectedDate, snapshotKind);
  const cron = db.prepare('SELECT enabled, cron_expr, last_run FROM crontab WHERE id = ?')
    .get(platformCronId(platform));
  return {
    data: result.items || [],
    sourceMode: result.sourceMode || 'local-cache',
    sourceLabel: result.sourceMode === 'api'
      ? (realtime ? 'API 实时数据' : 'API 昨日日榜')
      : '本地缓存数据',
    dataDate: result.batch?.data_date || null,
    capturedAt: result.batch?.completed_at || null,
    expectedDate,
    latestAttempt: result.latestAttempt ? {
      status: result.latestAttempt.status,
      dataDate: result.latestAttempt.data_date,
      completedAt: result.latestAttempt.completed_at,
      error: result.latestAttempt.error,
    } : null,
    cronEnabled: Boolean(cron?.enabled),
    cronExpr: cron?.cron_expr || null,
    lastRun: cron?.last_run || null,
  };
}

function normalizeDailyPlatformItems(platform, data, dataDate) {
  let items = normalizeSnapshotItems(platform, data);
  if (platform === 'xhs') {
    const list = Array.isArray(data) ? data : data?.list || data?.records || data?.articles || [];
    items = list.map((item, index) => ({
      key: String(item.photoId || item.workId || item.id || item.photoJumpUrl || `${dataDate}-${index}`),
      title: item.title || item.workTitle || item.desc || '(无标题)',
      score: toNumber(item.anaAdd?.addInteractiveount ?? item.addInteractiveount
        ?? item.anaAdd?.interactiveCount ?? item.interactiveCount
        ?? item.anaAdd?.useLikeCount ?? item.useLikeCount) || 0,
      raw: item,
    }));
  }
  if (['ai-gzh', 'ai-bili', 'ai-xhs'].includes(platform)) {
    items = items.filter(item => {
      const rawDate = item.raw?.gmtCreate || item.raw?.publishTime || item.raw?.publicTime || '';
      return String(rawDate).startsWith(dataDate);
    });
  }
  return items.slice(0, 50);
}

function latestAiGzhDataDate(data, expectedDate) {
  const list = Array.isArray(data) ? data : data?.list || data?.records || data?.articles || [];
  return list
    .map(item => String(item.gmtCreate || item.publishTime || item.publicTime || '').slice(0, 10))
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= expectedDate)
    .sort()
    .at(-1) || null;
}

function recoverAiGzhFallbackBatches() {
  const attempts = db.prepare(`
    SELECT *
    FROM hot_batches
    WHERE platform = 'ai-gzh' AND snapshot_kind = 'daily'
      AND status = 'empty' AND response_json IS NOT NULL
    ORDER BY completed_at DESC
  `).all();
  for (const attempt of attempts) {
    const response = parseJson(attempt.response_json);
    const actualDate = latestAiGzhDataDate(response, attempt.data_date);
    if (!actualDate || actualDate === attempt.data_date) continue;
    const existing = db.prepare(`
      SELECT id FROM hot_batches
      WHERE platform = 'ai-gzh' AND snapshot_kind = 'daily'
        AND data_date = ? AND status = 'success'
      LIMIT 1
    `).get(actualDate);
    if (existing) continue;
    const items = normalizeDailyPlatformItems('ai-gzh', response, actualDate);
    if (!items.length) continue;
    saveHotBatch({
      platform: 'ai-gzh',
      dataDate: actualDate,
      snapshotKind: 'daily',
      endpoint: attempt.endpoint,
      request: parseJson(attempt.request_json) || {},
      response,
      items,
      status: 'success',
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
    });
  }
}

recoverAiGzhFallbackBatches();

const activePlatformSyncs = new Map();

async function syncDailyPlatform(platform, dataDate = dateDaysAgo(1), source = '灵感熔炉-平台昨日榜') {
  const lockKey = `${platform}:${dataDate}`;
  if (activePlatformSyncs.has(lockKey)) return activePlatformSyncs.get(lockKey);
  const promise = (async () => {
    const startedAt = Date.now();
    let endpoint;
    let request;
    try {
      let response;
      if (platform === 'dy') {
        endpoint = 'dy/search/likesRank';
        request = { source, type: '全部', startTime: dataDate, endTime: dataDate };
        response = await redfoxData(endpoint, request);
      } else if (platform === 'xhs') {
        endpoint = 'cozeSkill/getXhsCozeSkillDataOne';
        request = { rankDate: dataDate, source: '小红书单日数据爆款文章-GitHub', category: '综合全部' };
        response = await redfoxGetData(endpoint, request);
      } else if (platform === 'gzh') {
        endpoint = 'gzh/search/hotArticle';
        request = { source, keyword: '', startDate: dataDate, endDate: dataDate, pageNum: 1, pageSize: 50 };
        response = await redfoxData(endpoint, request);
      } else if (platform === 'ai-gzh') {
        endpoint = 'parseWork/queryAiMsgs';
        request = { source: 'AI公众号信息源-GitHub', keyword: 'AI', pageNum: 1, pageSize: 100, startDate: dataDate, endDate: dataDate };
        response = await redfoxData(endpoint, request);
      } else if (platform === 'ai-bili') {
        endpoint = 'parseWork/queryBiliAiMsgs';
        request = {
          source: 'B站AI信息源-GitHub',
          keyword: 'AI',
          pageNum: 1,
          pageSize: 100,
          startTime: `${dataDate} 00:00:00`,
          endTime: `${dataDate} 23:59:59`,
        };
        response = await redfoxData(endpoint, request);
      } else if (platform === 'ai-xhs') {
        endpoint = 'parseWork/queryXhsAiMsgs';
        request = {
          source: 'AI小红书信息源-GitHub',
          keyword: 'AI',
          pageNum: 1,
          pageSize: 100,
          startTime: dataDate,
          endTime: dateFromYmd(dataDate, 1),
        };
        response = await redfoxData(endpoint, request);
      } else {
        throw new Error(`不支持的平台：${platform}`);
      }
      const items = normalizeDailyPlatformItems(platform, response, dataDate);
      if (['ai-gzh', 'ai-bili', 'ai-xhs'].includes(platform) && !items.length) {
        const actualDate = latestAiGzhDataDate(response, dataDate);
        const fallbackItems = actualDate && actualDate !== dataDate
          ? normalizeDailyPlatformItems(platform, response, actualDate)
          : [];
        if (fallbackItems.length) {
          const fallbackBatch = saveHotBatch({
            platform,
            dataDate: actualDate,
            snapshotKind: 'daily',
            endpoint,
            request,
            response,
            items: fallbackItems,
            status: 'success',
            startedAt,
          });
          saveHotBatch({
            platform,
            dataDate,
            snapshotKind: 'daily',
            endpoint,
            request,
            response,
            items: [],
            status: 'empty',
            error: `${dataDate} 暂无榜单数据；API 最新返回 ${actualDate}`,
            startedAt,
          });
          return fallbackBatch;
        }
      }
      const status = items.length ? 'success' : 'empty';
      const batch = saveHotBatch({
        platform,
        dataDate,
        snapshotKind: 'daily',
        endpoint,
        request,
        response,
        items,
        status,
        error: items.length ? null : `${dataDate} 暂无榜单数据`,
        startedAt,
      });
      if (!items.length) throw new Error(`${dataDate} 暂无榜单数据，继续使用本地缓存`);
      return batch;
    } catch (error) {
      const alreadySaved = db.prepare(`
        SELECT id FROM hot_batches
        WHERE platform = ? AND started_at = ?
      `).get(platform, startedAt);
      if (!alreadySaved) {
        saveHotBatch({
          platform,
          dataDate,
          snapshotKind: 'daily',
          endpoint: endpoint || 'unknown',
          request: request || {},
          status: 'failed',
          error: error.message,
          startedAt,
        });
      }
      throw error;
    }
  })();
  activePlatformSyncs.set(lockKey, promise);
  try {
    return await promise;
  } finally {
    activePlatformSyncs.delete(lockKey);
  }
}

async function captureHotSnapshot() {
  const dataDate = dateDaysAgo(1);
  const platforms = [];
  for (const platform of ['dy', 'xhs', 'gzh', 'ai-gzh', 'ai-bili', 'ai-xhs']) {
    try {
      const batch = await syncDailyPlatform(platform, dataDate, '灵感熔炉-手动昨日榜');
      platforms.push({ platform, count: batch.itemCount, ok: true });
    } catch (error) {
      platforms.push({ platform, count: 0, ok: false, error: error.message });
    }
  }
  return { date: dataDate, platforms };
}

function getLocalData(module, key) {
  const row = db.prepare('SELECT data_json, expires_at FROM local_data WHERE module = ? AND data_key = ?').get(module, key);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare('DELETE FROM local_data WHERE module = ? AND data_key = ?').run(module, key);
    return null;
  }
  return parseJson(row.data_json);
}

function setLocalData(module, key, data, expiresAt = null) {
  db.prepare(`
    INSERT INTO local_data (module, data_key, data_json, cached_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(module, data_key) DO UPDATE SET
      data_json = excluded.data_json,
      cached_at = excluded.cached_at,
      expires_at = excluded.expires_at
  `).run(module, key, JSON.stringify(data), Date.now(), expiresAt);
}

const NOTIFICATION_CHANNELS = new Set(['discord', 'bark', 'webhook', 'dingtalk', 'feishu', 'telegram']);

function notificationConfigs() {
  return getLocalData('settings', 'notifications') || {};
}

function publicNotificationConfigs() {
  return Object.fromEntries(Object.entries(notificationConfigs()).map(([channel, config]) => [
    channel,
    {
      enabled: Boolean(config.enabled),
      configured: Boolean(config.url || (config.botToken && config.chatId)),
      url: config.url || '',
      botToken: config.botToken || '',
      chatId: config.chatId || '',
    },
  ]));
}

function saveNotificationConfigs(input) {
  const current = notificationConfigs();
  for (const channel of NOTIFICATION_CHANNELS) {
    if (!input[channel]) continue;
    const value = input[channel];
    current[channel] = {
      enabled: Boolean(value.enabled),
      url: String(value.url || '').trim() || current[channel]?.url || '',
      botToken: String(value.botToken || '').trim() || current[channel]?.botToken || '',
      chatId: String(value.chatId || '').trim() || current[channel]?.chatId || '',
    };
  }
  setLocalData('settings', 'notifications', current);
  return publicNotificationConfigs();
}

function postJsonUrl(rawUrl, payload) {
  const target = new URL(rawUrl);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = transport.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 300) reject(new Error(`通知 HTTP ${response.statusCode}`));
        else resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error('通知请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendNotification(channel, config, title, message) {
  if (!NOTIFICATION_CHANNELS.has(channel)) throw new Error('不支持的通知渠道');
  if (channel === 'telegram') {
    if (!config.botToken || !config.chatId) throw new Error('请配置 Bot Token 和 Chat ID');
    return postJsonUrl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      chat_id: config.chatId,
      text: `${title}\n${message}`,
    });
  }
  if (!config.url) throw new Error('请配置通知地址');
  if (channel !== 'bark' && !config.url.startsWith('https:')) throw new Error('该通知地址必须使用 HTTPS');
  const payload = channel === 'discord'
    ? { content: `**${title}**\n${message}` }
    : channel === 'dingtalk'
      ? { msgtype: 'text', text: { content: `${title}\n${message}` } }
      : channel === 'feishu'
        ? { msg_type: 'text', content: { text: `${title}\n${message}` } }
        : channel === 'bark'
          ? { title, body: message }
          : { title, message, text: `${title}\n${message}` };
  return postJsonUrl(config.url, payload);
}

async function broadcastNotification(title, message) {
  const configs = notificationConfigs();
  const targets = [];
  for (const [channel, config] of Object.entries(configs)) {
    if (!config?.enabled) continue;
    if (channel === 'telegram') {
      if (config.botToken && config.chatId) targets.push([channel, config]);
    } else if (config.url) {
      targets.push([channel, config]);
    }
  }
  if (!targets.length) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  await Promise.all(targets.map(async ([channel, config]) => {
    try {
      await sendNotification(channel, config, title, message);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[notify] ${channel} 推送失败:`, error.message);
    }
  }));
  return { sent, failed };
}

function normalizeTrendKey(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function dailyHotSourceRows(dataDate) {
  return db.prepare(`
    SELECT b.platform, i.rank, i.title, i.score, i.raw_data
    FROM hot_batches b
    JOIN hot_batch_items i ON i.batch_id = b.id
    WHERE b.data_date = ?
      AND b.status = 'success'
      AND b.snapshot_kind IN ('realtime', 'daily')
    ORDER BY b.platform ASC, b.completed_at ASC, i.rank ASC
  `).all(dataDate).map(row => {
    const raw = parseJson(row.raw_data) || {};
    const platforms = row.platform === 'all' && Array.isArray(raw.plats) && raw.plats.length
      ? raw.plats.map(name => platCodeByDisplayName(name))
      : [row.platform];
    return { ...row, platforms: platforms.filter(Boolean) };
  });
}

function platCodeByDisplayName(name) {
  return {
    百度: 'bd', 知乎: 'zh', 微博: 'wb', 抖音: 'dy',
    B站: 'bz', 快手: 'ks', 头条: 'tt',
  }[name] || String(name || '');
}

async function analyzeDailyHotKeywords(dataDate = dateDaysAgo(1), force = false) {
  const rows = dailyHotSourceRows(dataDate);
  if (rows.length < 10) throw new Error(`${dataDate} 的真实热榜数据不足，暂不生成趋势`);

  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.platforms.join(',')}:${normalizeTrendKey(row.title)}`;
    if (!normalizeTrendKey(row.title) || seen.has(key)) continue;
    seen.add(key);
    uniqueRows.push(row);
  }
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(uniqueRows)).digest('hex');
  const cached = db.prepare('SELECT * FROM hot_daily_keywords WHERE data_date = ?').get(dataDate);
  if (!force && cached?.source_fingerprint === fingerprint) return parseJson(cached.result_json);
  const indexed = uniqueRows.slice(0, 320).map((row, index) => ({
    id: index + 1,
    platforms: row.platforms,
    rank: row.rank,
    title: row.title,
  }));
  const extracted = await callLlmJson([
    {
      role: 'system',
      content: `你负责从真实热榜标题中提取可跨天比较的实体或事件关键词。不得编造，不得输出泛词（热点、网友、视频、今日、宣布等）。每个主题必须引用输入标题 id。输出严格 JSON：
{"keywords":[{"name":"稳定且简短的主题名","aliases":["标题中出现的同义写法"],"titleIds":[1,2]}],"summary":"当天热点概述"}
最多20个主题；titleIds 必须真实存在；相同事件合并。`,
    },
    { role: 'user', content: `数据日期：${dataDate}\n${JSON.stringify(indexed)}` },
  ]);
  const keywords = (Array.isArray(extracted.keywords) ? extracted.keywords : []).slice(0, 20).map(keyword => {
    const titleIds = [...new Set((keyword.titleIds || []).map(Number))]
      .filter(id => id >= 1 && id <= indexed.length);
    const matched = titleIds.map(id => indexed[id - 1]);
    const platforms = [...new Set(matched.flatMap(item => item.platforms || []))];
    const rankScore = matched.reduce((sum, item) => sum + Math.max(1, 51 - item.rank), 0);
    return {
      name: String(keyword.name || '').trim(),
      aliases: [...new Set([keyword.name, ...(keyword.aliases || [])]
        .map(String)
        .map(v => v.trim())
        .filter(value => value && value.length <= 20))].slice(0, 8),
      mentions: matched.length,
      platforms,
      strength: matched.length * 10 + platforms.length * 15 + rankScore,
      topTitles: matched.sort((a, b) => a.rank - b.rank).slice(0, 4).map(item => item.title),
    };
  }).filter(item => item.name && item.mentions);
  const result = {
    dataDate,
    keywords,
    summary: String(extracted.summary || ''),
    sourceCount: indexed.length,
    generatedAt: Date.now(),
  };
  db.prepare(`
    INSERT INTO hot_daily_keywords (data_date, source_fingerprint, result_json, generated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(data_date) DO UPDATE SET
      source_fingerprint = excluded.source_fingerprint,
      result_json = excluded.result_json,
      generated_at = excluded.generated_at
  `).run(dataDate, fingerprint, JSON.stringify(result), result.generatedAt);
  return result;
}

function trendKeys(keyword) {
  return [...new Set([keyword.name, ...(keyword.aliases || [])].map(normalizeTrendKey).filter(Boolean))];
}

function getHotTrends(days) {
  const safeDays = days === 7 ? 7 : 14;
  const reports = db.prepare(`
    SELECT data_date, result_json, generated_at
    FROM hot_daily_keywords
    WHERE data_date >= ?
    ORDER BY data_date ASC
  `).all(dateDaysAgo(safeDays)).map(row => ({
    date: row.data_date,
    generatedAt: row.generated_at,
    report: parseJson(row.result_json),
  }));
  if (!reports.length) return { themes: [], summary: '', analyzedThrough: null, generatedAt: null };
  if (reports.length < 2) {
    return {
      themes: [],
      summary: `已完成 ${reports[0].date} 的真实关键词提取；至少积累 2 天后才计算增长或冷却趋势。`,
      analyzedThrough: reports[0].date,
      generatedAt: reports[0].generatedAt,
    };
  }
  const groups = [];
  for (const daily of reports) {
    for (const keyword of daily.report?.keywords || []) {
      const keys = trendKeys(keyword);
      let group = groups.find(candidate => candidate.keys.some(key =>
        keys.some(next => key === next || (key.length >= 3 && next.length >= 3 && (key.includes(next) || next.includes(key)))),
      ));
      if (!group) {
        group = { name: keyword.name, keys: [], points: [], titles: new Set(), platforms: new Set() };
        groups.push(group);
      }
      group.keys = [...new Set([...group.keys, ...keys])];
      group.points.push({
        date: daily.date,
        strength: Number(keyword.strength) || 0,
        mentions: Number(keyword.mentions) || 0,
      });
      (keyword.topTitles || []).forEach(title => group.titles.add(title));
      (keyword.platforms || []).forEach(platform => group.platforms.add(platform));
    }
  }
  const dates = reports.map(item => item.date);
  const latestDate = dates[dates.length - 1];
  const previousDate = dates[dates.length - 2] || null;
  const themes = groups.map(group => {
    const byDate = new Map(group.points.map(point => [point.date, point]));
    const latest = byDate.get(latestDate)?.strength || 0;
    const previous = previousDate ? byDate.get(previousDate)?.strength || 0 : 0;
    const change = previous ? ((latest - previous) / previous) * 100 : (latest ? 100 : 0);
    const trend = !previousDate ? '稳定'
      : latest === 0 && previous > 0 ? '冷却'
      : change >= 20 ? '增长'
      : change <= -20 ? '冷却'
      : '稳定';
    return {
      name: group.name,
      keywords: group.keys.slice(0, 6),
      trend,
      reason: `${latestDate} 强度 ${Math.round(latest)}，${previousDate || '前期'} ${Math.round(previous)}；按真实标题出现次数、平台覆盖和榜单排名计算`,
      daysSeen: new Set(group.points.map(point => point.date)).size,
      platforms: [...group.platforms],
      scoreChange: `${change >= 0 ? '+' : ''}${Math.round(change)}%`,
      topTitles: [...group.titles].slice(0, 4),
      history: dates.map(date => ({ date, strength: byDate.get(date)?.strength || 0 })),
      latestStrength: latest,
    };
  }).filter(item => item.daysSeen >= 2 || item.latestStrength > 0)
    .sort((a, b) => {
      const order = { 增长: 0, 稳定: 1, 冷却: 2 };
      return order[a.trend] - order[b.trend] || b.latestStrength - a.latestStrength;
    })
    .slice(0, 15);
  return {
    themes,
    summary: `趋势基于 ${reports.length} 个已完成的每日 LLM 关键词报告，数据截至 ${latestDate}。`,
    analyzedThrough: latestDate,
    generatedAt: Math.max(...reports.map(item => item.generatedAt || 0)),
  };
}

async function analyzeHotTrendsLlm() {
  await analyzeDailyHotKeywords(dateDaysAgo(1), true);
  return getHotTrends(14);
}

function buildDailyHotReport(dataDate = dateDaysAgo(1)) {
  const rows = dailyHotSourceRows(dataDate);
  const PLAT_LABEL = { dy: '抖音', xhs: '小红书', gzh: '公众号' };
  const byPlatform = new Map();
  for (const row of rows) {
    for (const plat of row.platforms) {
      if (!PLAT_LABEL[plat]) continue;
      if (!byPlatform.has(plat)) byPlatform.set(plat, new Map());
      const titleMap = byPlatform.get(plat);
      if (!titleMap.has(row.title)) titleMap.set(row.title, { title: row.title, rank: row.rank, score: row.score });
    }
  }
  const platformSummary = ['dy', 'xhs', 'gzh']
    .filter(plat => byPlatform.has(plat))
    .map(plat => {
      const items = [...byPlatform.get(plat).values()].sort((a, b) => (a.rank || 999) - (b.rank || 999)).slice(0, 5);
      if (!items.length) return null;
      const list = items.map((item, idx) => `${idx + 1}. ${String(item.title || '').slice(0, 40)}`).join('\n');
      return `【${PLAT_LABEL[plat]}】\n${list}`;
    })
    .filter(Boolean);
  let trendsSection = '';
  try {
    const trends = getHotTrends(7);
    const top = (trends.themes || []).slice(0, 5);
    if (top.length) {
      const list = top.map(item => `· ${item.name}（${item.trend || '-'}）`).join('\n');
      trendsSection = `\n\n【7 日趋势关键词】\n${list}`;
    }
  } catch {}
  const summary = platformSummary.length
    ? `${dataDate} 热榜速览\n\n${platformSummary.join('\n\n')}${trendsSection}`
    : `${dataDate} 暂无可用的热榜快照数据`;
  return { dataDate, platformCount: platformSummary.length, summary };
}

async function sendDailyHotReport() {
  const report = buildDailyHotReport(dateDaysAgo(1));
  await broadcastNotification('灵感熔炉 · 每日热榜日报', report.summary);
  return report;
}

function inspirationSearchTerms(config, keywords, limit = 2) {
  const typePriority = { white: 4, core: 3, alias: 2 };
  const configured = [...(config?.terms || [])]
    .filter(term => term.type !== 'black')
    .sort((a, b) =>
      (typePriority[b.type] || 0) - (typePriority[a.type] || 0)
      || b.weight - a.weight
    )
    .map(term => term.term) || [];
  return normalizeTerms([...configured, ...(keywords || [])]).slice(0, Math.max(0, limit));
}

function inspirationSearchPlan(config, keywords) {
  const mode = config?.searchMode === 'deep' ? 'deep' : 'combined';
  const terms = inspirationSearchTerms(config, keywords, 5);
  if (!terms.length) return [];
  if (mode === 'deep') {
    return terms.map(term => ({
      mode,
      query: term,
      terms: [term],
    }));
  }
  return [{
    mode,
    query: terms.join(','),
    terms,
  }];
}

function keywordSearchPlatform(keyword) {
  return `gzh-search:${crypto.createHash('sha1').update(keyword.toLowerCase()).digest('hex').slice(0, 12)}`;
}

function cachedKeywordHotArticles(keyword) {
  const row = db.prepare(`
    SELECT response_json, data_date, completed_at
    FROM hot_batches
    WHERE platform = ? AND snapshot_kind = 'inspiration-search'
      AND status = 'success' AND data_date >= ?
    ORDER BY data_date DESC, completed_at DESC
    LIMIT 1
  `).get(keywordSearchPlatform(keyword), dateDaysAgo(3));
  if (!row) return null;
  return {
    data: parseJson(row.response_json) || {},
    dataDate: row.data_date,
    completedAt: row.completed_at,
  };
}

function normalizeKeywordSearchItems(data) {
  const candidates = [...(data?.articles || []), ...(data?.latestHotArticles || [])];
  return candidates.map(article => ({
    key: String(article.id || article.url || article.title),
    title: article.title || '(无标题)',
    score: toNumber(article.totalScore) || toNumber(article.clicksCount) || 0,
    raw: article,
  }));
}

async function fetchKeywordHotArticles(keywords, options = {}) {
  const endDate = localDate();
  const maxApiCalls = Math.max(0, Math.min(Number(options.maxApiCalls) || 0, 5));
  const searchPlan = inspirationSearchPlan(options.config, keywords);
  const unique = new Map();
  const searched = [];
  let apiCalls = 0;
  for (const search of searchPlan) {
    const cached = cachedKeywordHotArticles(search.query);
    let data = cached?.data || null;
    let source = cached ? 'database' : '';
    if (!data && apiCalls < maxApiCalls) {
      const startedAt = Date.now();
      const request = {
        keyword: search.query,
        startDate: dateDaysAgo(14),
        endDate,
        source: '公众号爆款文章洞察-GitHub',
      };
      apiCalls += 1;
      if (typeof options.onApiCall === 'function') options.onApiCall(1);
      try {
        data = await redfoxData('gzh/search/hotArticle', request);
        source = 'api';
        saveHotBatch({
          platform: keywordSearchPlatform(search.query),
          dataDate: endDate,
          snapshotKind: 'inspiration-search',
          endpoint: 'gzh/search/hotArticle',
          request,
          response: data,
          items: normalizeKeywordSearchItems(data),
          status: 'success',
          startedAt,
        });
      } catch (error) {
        source = 'api-failed';
        saveHotBatch({
          platform: keywordSearchPlatform(search.query),
          dataDate: endDate,
          snapshotKind: 'inspiration-search',
          endpoint: 'gzh/search/hotArticle',
          request,
          status: 'failed',
          error: error.message,
          startedAt,
        });
        searched.push({
          keyword: search.query,
          keywords: search.terms,
          mode: search.mode,
          days: 14,
          count: 0,
          source,
          error: error.message,
          relatedSearches: [],
        });
        continue;
      }
    }
    if (!data) {
      searched.push({
        keyword: search.query,
        keywords: search.terms,
        mode: search.mode,
        days: 14,
        count: 0,
        source: 'skipped-budget',
        relatedSearches: [],
      });
      continue;
    }
    searched.push({
      keyword: search.query,
      keywords: search.terms,
      mode: search.mode,
      days: 14,
      count: (data?.articles || []).length,
      source,
      dataDate: cached?.dataDate || endDate,
      relatedSearches: data?.relatedSearches || [],
    });
    const candidates = [...(data?.articles || []), ...(data?.latestHotArticles || [])];
    for (const article of candidates) {
      const key = String(article.id || article.url || article.title);
      if (!unique.has(key)) unique.set(key, article);
    }
  }
  const articles = Array.from(unique.values()).sort((a, b) =>
    (toNumber(b.totalScore) || 0) - (toNumber(a.totalScore) || 0)
    || (toNumber(b.clicksCount) || 0) - (toNumber(a.clicksCount) || 0)
  );
  return { articles, searched, apiCalls };
}

async function callLlm(messages, options = {}) {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4.1-mini';
  if (!apiKey) throw new Error('未配置 LLM_API_KEY');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      response_format: options.json ? { type: 'json_object' } : undefined,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `LLM HTTP ${response.status}`);
  return payload.choices?.[0]?.message?.content || '';
}

function parseLlmJson(content) {
  const cleaned = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function callLlmJson(messages) {
  const content = await callLlm(messages, { json: true });
  try {
    return parseLlmJson(content);
  } catch {
    const repaired = await callLlm([
      {
        role: 'system',
        content: '你是 JSON 修复器。只修复语法并输出合法 JSON，不改变字段含义，不输出 Markdown。',
      },
      { role: 'user', content },
    ], { json: true, temperature: 0, maxTokens: 4096 });
    return parseLlmJson(repaired);
  }
}

const HOTSPOT_LISTS = {
  bdList: ['bd', '百度'],
  bzList: ['bz', 'B站'],
  dyList: ['dy', '抖音'],
  ksList: ['ks', '快手'],
  ttList: ['tt', '头条'],
  wbList: ['wb', '微博'],
  zhList: ['zh', '知乎'],
};

function normalizeHotspots(data) {
  const items = [];
  for (const [key, [platform, platformName]] of Object.entries(HOTSPOT_LISTS)) {
    for (const item of data?.[key] || []) {
      const title = String(item.title || '').trim();
      if (!title) continue;
      items.push({
        id: crypto.createHash('sha1').update(`${platform}:${title}`).digest('hex').slice(0, 16),
        title,
        platform,
        platformName,
        hotCount: String(item.hotCount || '0'),
        rank: Number(item.index) || 0,
        createdAt: item.gmtCreate || '',
        url: item.url || '',
      });
    }
  }
  const hotNumber = value => Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
  return items.sort((a, b) => hotNumber(b.hotCount) - hotNumber(a.hotCount) || a.rank - b.rank);
}

function normalizeRealtimeHotspots(data, snapshotDate = localDate()) {
  const groups = new Map();
  for (const item of normalizeHotspots(data)) {
    if (item.createdAt && !String(item.createdAt).startsWith(snapshotDate)) continue;
    const canonical = item.title.toLowerCase().replace(/[\s·,，。！？!?：:、"'“”‘’（）()【】[\]-]/g, '');
    const key = canonical || `${item.platform}:${item.title}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: item.title,
        score: 0,
        bestRank: item.rank || 50,
        platforms: new Set(),
        sources: [],
        latestAt: '',
      });
    }
    const group = groups.get(key);
    group.platforms.add(item.platformName);
    group.score += Math.max(1, 51 - (item.rank || 50));
    group.bestRank = Math.min(group.bestRank, item.rank || 50);
    if (item.createdAt > group.latestAt) group.latestAt = item.createdAt;
    group.sources.push(item);
  }
  return Array.from(groups.values())
    .sort((a, b) =>
      b.platforms.size - a.platforms.size
      || b.score - a.score
      || a.bestRank - b.bestRank
      || b.latestAt.localeCompare(a.latestAt)
    )
    .slice(0, 20)
    .map(group => ({
      key: group.key,
      title: group.title,
      score: group.score,
      raw: {
        realtime: true,
        plats: Array.from(group.platforms),
        bestRank: group.bestRank,
        latestAt: group.latestAt,
        sources: group.sources,
      },
    }));
}

function localDateTime(date = new Date()) {
  return `${localDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

let activeRealtimeHotspots = null;

async function syncRealtimeHotspots(source = '灵感熔炉-实时热榜') {
  if (activeRealtimeHotspots) return activeRealtimeHotspots;
  activeRealtimeHotspots = (async () => {
    const today = localDate();
    const startedAt = Date.now();
    const endpoint = 'hotSpot/getListByPlatformWithKeyword';
    const request = {
      source,
      platforms: [],
      keywords: [],
      startDate: `${today} 00:00:00`,
      endDate: localDateTime(),
    };
    try {
      const data = await redfoxData(endpoint, request);
      const items = normalizeRealtimeHotspots(data, today);
      const status = items.length ? 'success' : 'empty';
      const batch = saveHotBatch({
        platform: 'all',
        dataDate: today,
        snapshotKind: 'realtime',
        endpoint,
        request,
        response: data,
        items,
        status,
        error: items.length ? null : '当前时段暂无实时热点',
        startedAt,
      });
      if (!items.length) throw new Error('当前时段暂无实时热点，继续使用本地缓存');
      return batch;
    } catch (error) {
      const alreadySaved = db.prepare(`
        SELECT id FROM hot_batches WHERE platform = 'all' AND started_at = ?
      `).get(startedAt);
      if (!alreadySaved) {
        saveHotBatch({
          platform: 'all',
          dataDate: today,
          snapshotKind: 'realtime',
          endpoint,
          request,
          status: 'failed',
          error: error.message,
          startedAt,
        });
      }
      throw error;
    }
  })();
  try {
    return await activeRealtimeHotspots;
  } finally {
    activeRealtimeHotspots = null;
  }
}

async function findRewriteHotspots(body) {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('请输入需要分析的文章');
  const today = localDate();
  let localItems = latestHotBatch('all', today, 'realtime');
  let dataSource = 'database';
  let apiCalls = 0;
  if (!localItems.batch || localItems.batch.data_date !== today || !localItems.items?.length) {
    if (!body.allowApi) {
      logAction('rewrite-hotspots', 'button', 'no-today-data', { dataDate: today }, 0, 0);
      return { needsApiConfirmation: true, dataDate: today, hotspots: [], keywords: [], source: 'none' };
    }
    await syncRealtimeHotspots('灵感熔炉-创作助手确认刷新');
    localItems = latestHotBatch('all', today, 'realtime');
    dataSource = 'redfox-api';
    apiCalls = 1;
  }
  const analysis = await callLlmJson([
    {
      role: 'system',
      content: '你是中文内容编辑。提取适合搜索实时热榜的短关键词，必须包含文章里的核心实体或行业词，避免完整长句和“介绍、方法、分享”等空词。中文词控制在2-8字，英文词控制在1-3个单词。例如“NAS本地AI Agent”应拆成“NAS”“AI Agent”“本地AI”。输出严格 JSON：{"topic":"","keywords":[""]}，关键词 3-5 个。',
    },
    { role: 'user', content: text.slice(0, 12000) },
  ]);
  const keywords = Array.isArray(analysis.keywords)
    ? [...new Set(analysis.keywords.map(value => String(value).trim()).filter(Boolean))].slice(0, 5)
    : [];
  if (!keywords.length) return { topic: analysis.topic || '', keywords: [], hotspots: [] };
  const searchKeywords = [...new Set(keywords.flatMap(keyword => {
    const englishTokens = keyword.match(/[a-z][a-z0-9.+#-]*/gi) || [];
    return [keyword, ...englishTokens.filter(token => token.length >= 2)];
  }))].slice(0, 8);
  const uniqueCandidates = new Map();
  for (const row of localItems.items || []) {
    const raw = row.raw || {};
    const sources = Array.isArray(raw.sources) ? raw.sources : [];
    const base = sources[0] || raw;
    const item = {
      id: row.key,
      title: row.title,
      hotCount: row.score,
      platform: base.platform || 'all',
      platformName: base.platformName || (raw.plats || []).join('、') || '全网',
      rank: row.rank,
      createdAt: base.createdAt || raw.latestAt || localItems.batch?.completed_at,
      raw,
    };
    const matched = searchKeywords.some(keyword =>
      item.title.toLowerCase().includes(keyword.toLowerCase())
    );
    if (matched && !uniqueCandidates.has(item.id)) uniqueCandidates.set(item.id, item);
  }
  const candidates = Array.from(uniqueCandidates.values()).slice(0, 50);
  if (!candidates.length) {
    logAction('rewrite-hotspots', 'button', dataSource, { keywords, candidates: 0, dataDate: today }, apiCalls, 1);
    return { topic: analysis.topic || '', keywords, hotspots: [], source: dataSource, apiCalls, llmCalls: 1 };
  }

  let matches = [];
  try {
    const ranked = await callLlmJson([
      {
        role: 'system',
        content: '判断热点能否自然用于文章标题和前言。禁止只因共享“AI”等宽泛词就强行关联。输出严格 JSON：{"matches":[{"index":1,"relevance":0,"angle":""}]}。只保留相关度不低于60的项目，最多12项。',
      },
      {
        role: 'user',
        content: `文章主题：${analysis.topic || ''}\n文章摘要：${text.slice(0, 2500)}\n\n候选热点：\n${candidates.map((item, index) => `${index + 1}. [${item.platformName}] ${item.title}（热度 ${item.hotCount}）`).join('\n')}`,
      },
    ]);
    matches = Array.isArray(ranked.matches) ? ranked.matches : [];
  } catch (error) {
    console.warn('热点相关度分析失败，使用关键词匹配：', error.message);
    matches = candidates.map((item, index) => ({
      index: index + 1,
      relevance: keywords.some(keyword => item.title.toLowerCase().includes(keyword.toLowerCase())) ? 70 : 0,
      angle: '',
    }));
  }
  const hotspots = matches
    .filter(match => Number(match.relevance) >= 60)
    .map(match => {
      const item = candidates[Number(match.index) - 1];
      return item ? { ...item, relevance: Number(match.relevance), angle: String(match.angle || '') } : null;
    })
    .filter(Boolean)
    .slice(0, 12);
  logAction('rewrite-hotspots', 'button', dataSource, {
    keywords, candidates: candidates.length, matches: hotspots.length, dataDate: today,
  }, apiCalls, 2);
  return {
    topic: String(analysis.topic || ''), keywords, hotspots,
    source: dataSource, apiCalls, llmCalls: 2, dataDate: today,
  };
}

async function rewriteForPlatform(body) {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('请输入原文');
  const platform = String(body.platform || '小红书');
  const tone = String(body.tone || '专业、清晰、有观点');
  const mode = String(body.mode || 'rewrite');  // create / rewrite / adapt
  const hotspot = body.hotspot && typeof body.hotspot === 'object' ? {
    title: String(body.hotspot.title || '').slice(0, 200),
    platformName: String(body.hotspot.platformName || '').slice(0, 30),
    angle: String(body.hotspot.angle || '').slice(0, 300),
  } : null;
  const hotspotInstruction = hotspot?.title
    ? `选定热点：${hotspot.title}（${hotspot.platformName}）。可用关联角度：${hotspot.angle || '自行判断'}。热点主要用于标题和前言，正文不得为了关联而篡改原文事实；若关联牵强，应在标题和前言中弱化处理。`
    : '未选择热点，不要虚构或强行加入热点。';
  // 平台对应的 rewrite skill 映射
  const skillSlugMap = { '小红书': 'xiaohongshu-rewrite', '公众号': 'wechat-rewrite', '知乎': 'zhihu-rewrite' };
  const skillSlug = skillSlugMap[platform];
  let skillInstruction = '';
  if (skillSlug) {
    const skill = getSkill(skillSlug);
    if (skill?.description) {
      // 取 description 前 300 字作为方法论提示
      skillInstruction = `\n\n参考 RedFox ${skillSlug} skill 方法论（按此风格输出）：\n${String(skill.description).slice(0, 400)}`;
    }
  }
  // 风格档案（来自「我的」账号）
  let styleInstruction = '';
  if (body.styleProfile && typeof body.styleProfile === 'object') {
    const p = body.styleProfile;
    const bits = [];
    if (p['标题DNA']?.典型句式?.length) bits.push(`标题参考句式：${p['标题DNA'].典型句式.slice(0, 3).join('；')}`);
    if (p['标题DNA']?.情绪钩子) bits.push(`标题情绪钩子：${p['标题DNA'].情绪钩子}`);
    if (p['表达风格']?.句式) bits.push(`句式偏好：${p['表达风格'].句式}`);
    if (p['表达风格']?.词汇偏好) bits.push(`词汇偏好：${p['表达风格'].词汇偏好}`);
    if (p['表达风格']?.节奏) bits.push(`节奏：${p['表达风格'].节奏}`);
    if (p['表达风格']?.幽默度) bits.push(`幽默度：${p['表达风格'].幽默度}`);
    if (p['创作边界']?.length) bits.push(`避免：${p['创作边界'].join('、')}`);
    if (bits.length) styleInstruction = `\n\n参考风格档案（仅作为风格指引，不得编造新事实）：\n${bits.join('\n')}`;
  }
  // 模式不同，system prompt 不同
  const modeInstruction = mode === 'create'
    ? `基于给定主题/大纲创作一篇全新的${platform}内容，可以适当发挥但要遵守事实底线。`
    : mode === 'adapt'
      ? `直接把素材改写为${platform}风格（不补充新事实，仅风格转换、句式重组）。`
      : `将素材重构为${platform}内容（在原素材基础上扩展结构和打磨）。`;
  const result = await callLlmJson([
    {
      role: 'system',
      content: `你是中文自媒体编辑。${modeInstruction}风格：${tone}。只能改写原始素材和所选热点明确提供的信息，不得补充原文没有的功能细节、原因、监管结论、时间表、数据或品牌案例；素材较短时正文也应保持简短。热点只用于标题和前言的自然切入，不能借热点编造正文事实。输出严格 JSON：{"title":"","intro":"","content":""}。title 是成稿标题，intro 是独立前言，content 是不重复标题和前言的正文。${skillInstruction}${styleInstruction}`,
    },
    {
      role: 'user',
      content: `${hotspotInstruction}\n\n原始素材：\n${text}`,
    },
  ]);
  let validated = result;
  try {
    validated = await callLlmJson([
      {
        role: 'system',
        content: '你是严格的事实校对编辑。逐句检查草稿，只保留能从“原始素材”或“允许使用的热点标题”直接推出的内容。删除所有新增的原因、功能细节、时间判断、法规推测、产品示例和数据，不得用常识补全。素材信息少时允许成稿很短。保持 JSON 字段不变，只输出 {"title":"","intro":"","content":""}。',
      },
      {
        role: 'user',
        content: `原始素材：\n${text}\n\n允许使用的热点标题：\n${hotspot?.title || '无'}\n\n待校对草稿：\n${JSON.stringify(result)}`,
      },
    ]);
  } catch (error) {
    console.warn('重构事实校对失败，返回初稿：', error.message);
  }
  return {
    title: String(validated.title || '').trim(),
    intro: String(validated.intro || '').trim(),
    content: String(validated.content || '').trim(),
    model: process.env.LLM_MODEL || 'LLM',
    hotspot,
  };
}

const DEFAULT_INSPIRATION_SOURCES = [
  'hot', 'dy', 'xhs', 'gzh', 'ai-gzh', 'ai-bili', 'ai-xhs', 'tracked',
];

const INSPIRATION_SOURCE_META = [
  { key: 'hot', label: '全网热榜', category: 'hotlist', description: '综合各平台实时热榜' },
  { key: 'dy', label: '抖音 TOP50', category: 'hotlist', description: '抖音热门内容' },
  { key: 'xhs', label: '小红书 TOP50', category: 'hotlist', description: '小红书热门内容' },
  { key: 'gzh', label: '公众号 TOP50', category: 'hotlist', description: '公众号热门文章' },
  { key: 'ai-gzh', label: 'AI 公众号', category: 'hotlist', description: 'AI 筛选公众号信息源' },
  { key: 'ai-bili', label: 'AI B站', category: 'hotlist', description: 'AI 筛选 B 站信息源' },
  { key: 'ai-xhs', label: 'AI 小红书', category: 'hotlist', description: 'AI 筛选小红书信息源' },
  { key: 'tracked', label: '关注账号', category: 'local', description: '已追踪账号的最新作品' },
  { key: 'gzh-search', label: '公众号关键词搜索', category: 'search', description: '按关键词搜索公众号文章（占用 API 预算）' },
  { key: 'wechat-10w', label: '公众号 10W+', category: 'external', description: '公众号 10W+ 阅读榜' },
  { key: 'wechat-growth', label: '公众号黑马', category: 'external', description: '公众号阅读增长榜' },
  { key: 'xhs-low', label: '小红书低粉爆款', category: 'external', description: '小红书低粉账号爆款' },
  { key: 'dy-surge', label: '抖音点赞飙升', category: 'external', description: '抖音每日点赞飙升榜' },
  { key: 'wersss', label: 'WeRss（we-mp-rss）', category: 'local', description: '本地同步的 we-mp-rss 公众号文章' },
];

const INSPIRATION_SOURCE_KEYS = new Set(INSPIRATION_SOURCE_META.map(s => s.key));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeTerms(values) {
  return [...new Set((Array.isArray(values) ? values : String(values || '').split(/[,，、\n]/))
    .map(value => String(value).trim())
    .filter(Boolean))];
}

function listInspirationConfigs() {
  const configs = db.prepare(`
    SELECT * FROM inspiration_keyword_configs ORDER BY created_at DESC
  `).all();
  const termQuery = db.prepare(`
    SELECT id, term, term_type, manual_weight, learned_weight
    FROM inspiration_keyword_terms WHERE config_id = ?
    ORDER BY term_type, created_at
  `);
  return configs.map(row => ({
    id: row.id,
    name: row.name,
    domain: row.domain || '',
    targetPlatforms: parseJson(row.target_platforms) || [],
    cronExpr: row.cron_expr,
    enabled: Boolean(row.enabled),
    sources: parseJson(row.sources) || [],
    sourceWeights: parseJson(row.source_weights) || {},
    ideaCount: row.idea_count,
    evidenceLimit: row.evidence_limit,
    dailyApiBudget: row.daily_api_budget,
    searchMode: row.search_mode === 'deep' ? 'deep' : 'combined',
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terms: termQuery.all(row.id).map(term => ({
      id: term.id,
      term: term.term,
      type: term.term_type,
      manualWeight: term.manual_weight,
      learnedWeight: term.learned_weight,
      weight: clamp(term.manual_weight + term.learned_weight, -5, 5),
    })),
  }));
}

function getInspirationConfig(id) {
  return listInspirationConfigs().find(config => config.id === id) || null;
}

function saveInspirationConfig(input, existingId = null) {
  const id = existingId || crypto.randomUUID();
  const name = String(input.name || '').trim();
  const cronExpr = String(input.cronExpr || '0 9 * * *').trim();
  if (!name) throw new Error('配置名称不能为空');
  if (!parseCronExpr(cronExpr)) throw new Error('Cron 表达式无效');
  const now = Date.now();
  const current = db.prepare('SELECT created_at FROM inspiration_keyword_configs WHERE id = ?').get(id);
  const sources = (Array.isArray(input.sources) ? input.sources : DEFAULT_INSPIRATION_SOURCES)
    .filter(source => INSPIRATION_SOURCE_KEYS.has(source));
  const sourceWeights = Object.fromEntries(Object.entries(input.sourceWeights || {})
    .map(([key, value]) => [key, clamp(value, 0, 3)]));
  db.transaction(() => {
    db.prepare(`
      INSERT INTO inspiration_keyword_configs
        (id, name, domain, target_platforms, cron_expr, enabled, sources, source_weights,
         idea_count, evidence_limit, daily_api_budget, search_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, domain=excluded.domain, target_platforms=excluded.target_platforms,
        cron_expr=excluded.cron_expr, enabled=excluded.enabled, sources=excluded.sources,
        source_weights=excluded.source_weights, idea_count=excluded.idea_count,
        evidence_limit=excluded.evidence_limit, daily_api_budget=excluded.daily_api_budget,
        search_mode=excluded.search_mode,
        updated_at=excluded.updated_at
    `).run(
      id, name, String(input.domain || '').trim(),
      JSON.stringify(normalizeTerms(input.targetPlatforms)),
      cronExpr, input.enabled === false ? 0 : 1,
      JSON.stringify(sources), JSON.stringify(sourceWeights),
      clamp(input.ideaCount || 6, 1, 12),
      clamp(input.evidenceLimit || 20, 6, 60),
      clamp(input.dailyApiBudget ?? 3, 0, 30),
      input.searchMode === 'deep' ? 'deep' : 'combined',
      current?.created_at || now, now,
    );
    if (Array.isArray(input.terms)) {
      const previous = new Map(db.prepare(`
        SELECT term, learned_weight FROM inspiration_keyword_terms WHERE config_id = ?
      `).all(id).map(row => [row.term, row.learned_weight]));
      db.prepare('DELETE FROM inspiration_keyword_terms WHERE config_id = ?').run(id);
      const insert = db.prepare(`
        INSERT INTO inspiration_keyword_terms
          (id, config_id, term, term_type, manual_weight, learned_weight, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const term of input.terms) {
        const value = String(term.term || '').trim();
        const type = String(term.type || 'core');
        if (!value || !['core', 'alias', 'white', 'black'].includes(type)) continue;
        insert.run(
          crypto.randomUUID(), id, value, type,
          clamp(term.manualWeight, -5, 5),
          clamp(previous.get(value) || term.learnedWeight, -5, 5),
          now, now,
        );
      }
    }
  })();
  syncInspirationConfigCron(id);
  return getInspirationConfig(id);
}

function effectiveConfigTerms(config) {
  const black = new Set(config.terms.filter(term => term.type === 'black').map(term => term.term.toLowerCase()));
  const typePriority = { white: 4, core: 3, alias: 2 };
  return config.terms
    .filter(term => term.type !== 'black' && !black.has(term.term.toLowerCase()))
    .map(term => ({
      term: term.term,
      type: term.type,
      weight: term.type === 'white' ? Math.max(3, term.weight) : term.weight,
    }))
    .sort((a, b) =>
      (typePriority[b.type] || 0) - (typePriority[a.type] || 0)
      || b.weight - a.weight
    );
}

function evidenceMatches(title, terms) {
  const normalized = String(title || '').toLowerCase();
  const matches = terms.filter(term => normalized.includes(term.term.toLowerCase()));
  return {
    matches,
    score: matches.reduce((sum, term) => sum + 10 + term.weight * 4, 0),
  };
}

function evidenceIdentity(item) {
  return normalizeTrendKey(item.title).slice(0, 80);
}

const EXTERNAL_INSPIRATION_SOURCES = {
  'wechat-10w': {
    platform: 'wechat-10w',
    endpoint: 'cozeSkill/getWxDataByCategoryAndTime',
    method: 'GET',
    request: date => ({
      type: '总排名',
      source: '公众号10w+阅读文章推荐',
      startDate: date,
      endDate: localDate(new Date(new Date(`${date}T12:00:00+08:00`).getTime() + 86400000)),
    }),
  },
  'wechat-growth': {
    platform: 'wechat-growth',
    endpoint: 'cozeSkill/getGzhCozeSkillDataRaise',
    method: 'GET',
    request: date => ({ rankDate: date, source: '公众号阅读增长榜-GitHub' }),
  },
  'xhs-low': {
    platform: 'xhs-low',
    endpoint: 'cozeSkill/getXhsCozeSkillDataLowFans',
    method: 'GET',
    request: date => ({ rankDate: date, source: '小红书冷门账号爆款文章', category: '综合全部' }),
  },
  'dy-surge': {
    platform: 'dy-surge',
    endpoint: 'dy/search/hotContentRank',
    method: 'POST',
    request: date => ({ source: '抖音每日点赞飙升榜', startTime: date }),
  },
};

function normalizeExternalInspirationItems(source, data) {
  let list = Array.isArray(data) ? data : data?.list || [];
  if (source === 'wechat-10w') list = data?.tenWReadingRank || list;
  if (source === 'wechat-growth') {
    return list.map(item => {
      const work = item.maxWork || {};
      return {
        key: String(work.photoId || item.accountId || item.userName),
        title: work.title || `${item.userName || '公众号'}阅读增长`,
        score: toNumber(item.growthRate) || toNumber(work.clicksCount) || 0,
        raw: { ...work, userName: item.userName, growthRate: item.growthRate, rankPosition: item.rankPosition },
      };
    });
  }
  return list.map(item => ({
    key: String(item.photoId || item.workId || item.id || item.title),
    title: item.title || item.content || item.desc || '(无标题)',
    score: toNumber(
      item.interactiveCount ?? item.likeCount ?? item.useLikeCount
      ?? item.clicksCount ?? item.pred_readnum
    ) || (String(item.clicksCount || '').toLowerCase().includes('10w') ? 100000 : 0),
    raw: item,
  }));
}

async function syncExternalInspirationSources(
  config,
  maxApiCalls = config.dailyApiBudget,
  onApiCall = null,
) {
  const dataDate = dateDaysAgo(1);
  const selected = config.sources.filter(source => EXTERNAL_INSPIRATION_SOURCES[source]);
  const budget = Math.max(0, Math.min(Number(maxApiCalls) || 0, selected.length));
  let apiCalls = 0;
  for (const source of selected) {
    const definition = EXTERNAL_INSPIRATION_SOURCES[source];
    const existing = db.prepare(`
      SELECT id FROM hot_batches
      WHERE platform = ? AND data_date = ? AND snapshot_kind = 'inspiration-source'
        AND status = 'success'
      ORDER BY completed_at DESC LIMIT 1
    `).get(definition.platform, dataDate);
    if (existing) continue;
    if (apiCalls >= budget) break;
    const request = definition.request(dataDate);
    const startedAt = Date.now();
    apiCalls += 1;
    if (typeof onApiCall === 'function') onApiCall(1);
    try {
      const data = definition.method === 'GET'
        ? await redfoxGetData(definition.endpoint, request)
        : await redfoxData(definition.endpoint, request);
      const items = normalizeExternalInspirationItems(source, data);
      saveHotBatch({
        platform: definition.platform,
        dataDate,
        snapshotKind: 'inspiration-source',
        endpoint: definition.endpoint,
        request,
        response: data,
        items,
        status: 'success',
        startedAt,
      });
    } catch (error) {
      saveHotBatch({
        platform: definition.platform,
        dataDate,
        snapshotKind: 'inspiration-source',
        endpoint: definition.endpoint,
        request,
        status: 'failed',
        error: error.message,
        startedAt,
      });
    }
  }
  return apiCalls;
}

function collectLocalInspirationEvidence(config) {
  const terms = effectiveConfigTerms(config);
  if (!terms.length) return [];
  const sources = new Set(config.sources);
  const platformMap = {
    hot: 'all', dy: 'dy', xhs: 'xhs', gzh: 'gzh', 'ai-gzh': 'ai-gzh',
    'ai-bili': 'ai-bili', 'ai-xhs': 'ai-xhs',
    'wechat-10w': 'wechat-10w', 'wechat-growth': 'wechat-growth',
    'xhs-low': 'xhs-low', 'dy-surge': 'dy-surge', wersss: 'wersss',
  };
  const evidence = [];
  for (const [source, platform] of Object.entries(platformMap)) {
    if (!sources.has(source)) continue;
    const rows = db.prepare(`
      SELECT b.id AS batch_id, b.data_date, b.completed_at, i.rank, i.item_key,
             i.title, i.score, i.raw_data
      FROM hot_batches b
      JOIN hot_batch_items i ON i.batch_id = b.id
      WHERE b.platform = ? AND b.status = 'success'
        AND b.data_date >= ?
      ORDER BY b.data_date DESC, b.completed_at DESC, i.rank ASC
      LIMIT 300
    `).all(platform, dateDaysAgo(7));
    for (const row of rows) {
      const match = evidenceMatches(row.title, terms);
      if (!match.matches.length) continue;
      const raw = parseJson(row.raw_data) || {};
      const weight = clamp(config.sourceWeights[source] ?? 1, 0, 3);
      evidence.push({
        id: `${source}:${row.batch_id}:${row.item_key}`,
        sourceType: source,
        platform,
        articleKey: row.item_key,
        title: row.title,
        author: raw.author || raw.userName || raw.accountName || raw.sourceUsernickname || '',
        url: raw.url || raw.oriUrl || raw.workUrl || raw.photoJumpUrl || '',
        readCount: toNumber(raw.readCount ?? raw.clicksCount ?? raw.likeCount ?? raw.useLikeCount ?? raw.interactiveCount) || 0,
        publishTime: raw.publishTime || raw.publicTime || raw.gmtCreate || row.data_date,
        dataDate: row.data_date,
        rank: row.rank,
        matchedTerms: match.matches.map(term => term.term),
        score: match.score * weight + Math.max(1, 51 - row.rank),
        batchId: row.batch_id,
      });
    }
  }
  if (sources.has('tracked')) {
    const rows = db.prepare(`
      SELECT w.account_id, w.plat, w.work_id, w.work_data, w.publish_at, a.name
      FROM account_works w
      JOIN tracked_accounts a ON a.id = w.account_id
      ORDER BY w.publish_at DESC, w.synced_at DESC
      LIMIT 500
    `).all();
    for (const row of rows) {
      const raw = parseJson(row.work_data) || {};
      const title = raw.title || raw.content || '';
      const match = evidenceMatches(`${title} ${row.name}`, terms);
      if (!match.matches.length) continue;
      evidence.push({
        id: `tracked:${row.account_id}:${row.work_id}`,
        sourceType: 'tracked',
        platform: row.plat,
        articleKey: row.work_id,
        title,
        author: row.name,
        url: raw.url || raw.workUrl || '',
        readCount: toNumber(raw.readCount ?? raw.clicksCount ?? raw.likeCount) || 0,
        publishTime: raw.publishTime || raw.publicTime || '',
        dataDate: row.publish_at ? localDate(new Date(row.publish_at)) : '',
        rank: 0,
        matchedTerms: match.matches.map(term => term.term),
        score: match.score * clamp(config.sourceWeights.tracked ?? 1, 0, 3) + 15,
        batchId: null,
      });
    }
  }
  if (sources.has('wersss')) {
    const rows = db.prepare(`
      SELECT a.id, a.title, a.summary, a.url, a.cover, a.publish_time, s.mp_name, s.mp_alias
      FROM wersss_articles a
      JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE a.publish_time >= ?
      ORDER BY a.publish_time DESC
      LIMIT 500
    `).all(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (const row of rows) {
      const title = row.title || '';
      const match = evidenceMatches(`${title} ${row.summary || ''} ${row.mp_name || ''} ${row.mp_alias || ''}`, terms);
      if (!match.matches.length) continue;
      evidence.push({
        id: `wersss:${row.id}`,
        sourceType: 'wersss',
        platform: 'wersss',
        articleKey: row.id,
        title,
        author: row.mp_name || row.mp_alias || '',
        url: row.url || '',
        readCount: 0,
        publishTime: row.publish_time || '',
        dataDate: row.publish_time ? localDate(new Date(row.publish_time)) : '',
        rank: 0,
        matchedTerms: match.matches.map(term => term.term),
        score: match.score * clamp(config.sourceWeights.wersss ?? 1, 0, 3) + 10,
        batchId: null,
      });
    }
  }
  const unique = new Map();
  for (const item of evidence) {
    const key = `${item.platform}:${item.articleKey || evidenceIdentity(item)}`;
    if (!unique.has(key) || unique.get(key).score < item.score) unique.set(key, item);
  }
  return [...unique.values()];
}

function groupInspirationEvidence(items) {
  const groups = [];
  for (const item of items.sort((a, b) => b.score - a.score)) {
    const key = evidenceIdentity(item);
    let group = groups.find(candidate => {
      if (!key || !candidate.key) return false;
      return key === candidate.key
        || (key.length >= 6 && candidate.key.length >= 6 && (key.includes(candidate.key) || candidate.key.includes(key)));
    });
    if (!group) {
      group = { id: crypto.randomUUID(), key, topic: item.title, items: [], platforms: new Set(), authors: new Set(), score: 0 };
      groups.push(group);
    }
    group.items.push(item);
    group.platforms.add(item.platform);
    if (item.author) group.authors.add(item.author);
    group.score = Math.max(group.score, item.score);
  }
  return groups.map(group => ({
    ...group,
    platformCount: group.platforms.size,
    authorCount: group.authors.size,
    score: group.score + Math.log2(1 + group.platforms.size) * 15 + Math.log2(1 + group.authors.size) * 8,
  })).sort((a, b) => b.score - a.score);
}

function selectDiverseEvidence(groups, limit) {
  const selected = [];
  const platformCounts = new Map();
  const authors = new Set();
  for (const group of groups) {
    const representative = group.items.find(item =>
      (!item.author || !authors.has(item.author))
      && (platformCounts.get(item.platform) || 0) < Math.max(2, Math.ceil(limit * 0.4)),
    ) || group.items[0];
    if (!representative) continue;
    selected.push({ ...representative, groupId: group.id, groupScore: group.score, platformCount: group.platformCount, authorCount: group.authorCount });
    if (representative.author) authors.add(representative.author);
    platformCounts.set(representative.platform, (platformCounts.get(representative.platform) || 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function normalizeInspirationTitle(value) {
  return normalizeTrendKey(value)
    .replace(/[一壹]/g, '1')
    .replace(/[二两贰]/g, '2')
    .replace(/[三叁]/g, '3')
    .replace(/[四肆]/g, '4')
    .replace(/[五伍]/g, '5')
    .replace(/[六陆]/g, '6')
    .replace(/[七柒]/g, '7')
    .replace(/[八捌]/g, '8')
    .replace(/[九玖]/g, '9')
    .replace(/[的了]/g, '')
    .replace(/第[一二三四五六七八九十\d]+期/g, '')
    .replace(/\d+天/g, '');
}

function inspirationTitleBigrams(value) {
  const normalized = normalizeInspirationTitle(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function inspirationTitleSimilarity(left, right) {
  const a = normalizeInspirationTitle(left);
  const b = normalizeInspirationTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 8 && longer.includes(shorter) && shorter.length / longer.length >= 0.72) return 0.9;
  const aPairs = inspirationTitleBigrams(a);
  const bPairs = inspirationTitleBigrams(b);
  let overlap = 0;
  for (const pair of aPairs) if (bPairs.has(pair)) overlap += 1;
  return (2 * overlap) / Math.max(1, aPairs.size + bPairs.size);
}

function recentInspirationTitles(configId, limit = 100) {
  const rows = configId
    ? [
      ...db.prepare(`
      SELECT title FROM inspirations
      WHERE deleted_at IS NULL AND config_id = ?
      ORDER BY created_at DESC LIMIT ?
      `).all(configId, limit),
      ...db.prepare(`
        SELECT title FROM inspirations
        WHERE deleted_at IS NULL AND (config_id IS NULL OR config_id <> ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(configId, limit),
    ]
    : db.prepare(`
      SELECT title FROM inspirations
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  return [...new Set(rows.map(row => row.title).filter(Boolean))].slice(0, limit * 2);
}

function dedupeInspirationIdeas(ideas, historicalTitles) {
  const accepted = [];
  const rejected = [];
  const comparisonTitles = [...historicalTitles];
  for (const idea of ideas || []) {
    const title = String(idea?.title || '').trim();
    if (!title) {
      rejected.push({ title: '', reason: '标题为空' });
      continue;
    }
    const duplicate = comparisonTitles.find(existing =>
      inspirationTitleSimilarity(title, existing) >= 0.84
    );
    if (duplicate) {
      rejected.push({ title, reason: `与已有选题相似：${duplicate}` });
      continue;
    }
    accepted.push(idea);
    comparisonTitles.push(title);
  }
  return { accepted, rejected };
}

async function generateInspirations(body) {
  const count = Math.max(1, Math.min(Number(body.count) || 6, 12));
  let config = body.configId ? getInspirationConfig(String(body.configId)) : null;
  const domain = String(body.domain || config?.domain || '').trim();
  let keywords = Array.isArray(body.keywords) ? body.keywords.map(String).filter(Boolean).slice(0, 12) : [];
  const adHocSources = !config && Array.isArray(body.sources) && body.sources.length ? body.sources : null;
  if (adHocSources) {
    config = {
      id: null,
      domain,
      sources: adHocSources.filter(source => INSPIRATION_SOURCE_KEYS.has(source)),
      terms: keywords.map(term => ({ term, type: 'core', weight: 0 })),
      dailyApiBudget: 3,
      evidenceLimit: 20,
      searchMode: 'combined',
      sourceWeights: {},
    };
  }
  if (!keywords.length && config) keywords = effectiveConfigTerms(config).map(term => term.term).slice(0, 12);
  if (!keywords.length) {
    keywords = getHotTrends(7).themes.slice(0, 8).map(item => item.name);
  }
  if (!keywords.length) {
    keywords = hotListPayload('all').data.slice(0, 8).map(item => item.title);
  }

  const totalBudget = config ? config.dailyApiBudget : 2;
  const usedBudget = Math.max(0, Number(body.usedApiCalls) || 0);
  const externalApiCalls = config && !body.externalSourcesSynced
    ? await syncExternalInspirationSources(
      config,
      Math.max(0, totalBudget - usedBudget),
      body.onApiCall,
    )
    : Number(body.externalApiCalls) || 0;
  const localGroups = config ? groupInspirationEvidence(collectLocalInspirationEvidence(config)) : [];
  const localEvidence = selectDiverseEvidence(localGroups, config?.evidenceLimit || 20);
  let hotResearch = { articles: [], searched: [], apiCalls: 0 };
  if (keywords.length && (!config || config.sources.includes('gzh-search'))) {
    const remainingBudget = Math.max(0, totalBudget - usedBudget - externalApiCalls);
    hotResearch = await fetchKeywordHotArticles(keywords, {
      config,
      maxApiCalls: Math.min(config?.searchMode === 'deep' ? 5 : 1, remainingBudget),
      onApiCall: body.onApiCall,
    });
  }
  const sourceItems = [
    ...localEvidence,
    ...hotResearch.articles.slice(0, 30).map(article => ({
    id: article.id,
    sourceType: 'gzh-search',
    platform: 'gzh',
    title: article.title,
    author: article.author || article.sourceUsernickname,
    readCount: article.clicksCount,
    publishTime: article.publicTime,
    relevanceScore: article.relevanceScore,
    popularityScore: article.popularityScore,
    recencyScore: article.recencyScore,
    totalScore: article.totalScore,
    url: article.url,
    score: article.totalScore || article.relevanceScore || 0,
  })),
  ].sort((a, b) => (b.groupScore || b.score || 0) - (a.groupScore || a.score || 0)).slice(0, config?.evidenceLimit || 30);
  const evidenceText = sourceItems.map((article, index) =>
    `${index + 1}. ${article.title}｜${article.author || '未知作者'}｜阅读${article.readCount || 0}｜总分${article.totalScore || 0}｜${article.publishTime || ''}`
  ).join('\n');

  if (!process.env.LLM_API_KEY) {
    throw new Error('未配置 LLM_API_KEY；系统不再使用内置选题模板，无法生成选题');
  }
  if (!keywords.length) throw new Error('没有可用于生成选题的关键词');

  const sourceMode = sourceItems.length ? 'hot-evidence' : 'llm-reasoning';
  const generationNote = sourceMode === 'hot-evidence'
    ? '基于本地热榜、平台榜单、关注账号或关键词搜索证据生成。'
    : '本轮未检索到可用热点信息；选题仅来自大模型结合赛道与关键词的推理，不代表当前热点或事实趋势。';
  const historicalTitles = recentInspirationTitles(config?.id || null);
  const historyText = historicalTitles.length
    ? historicalTitles.slice(0, 80).map((title, index) => `${index + 1}. ${title}`).join('\n')
    : '（暂无历史选题）';
  let llmCalls = 0;
  let parsed;
  try {
    const systemContent = sourceMode === 'hot-evidence'
      ? '你是中文自媒体选题编辑。必须基于提供的真实证据归纳，不得脱离证据编造热点。输出严格 JSON：{"ideas":[{"title":"","summary":"","angle":"","targetPlatform":"","sourceKeywords":[""],"sourceIndexes":[1]}]}。sourceIndexes 必须引用输入证据序号，不输出 Markdown。'
      : '你是中文自媒体选题编辑。本轮没有可用热点证据，只能根据账号赛道、关键词和通用内容方法进行大模型推理。不得声称某话题正在爆发、属于当前热点、未来必然上涨或引用不存在的数据。输出严格 JSON：{"ideas":[{"title":"","summary":"","angle":"","targetPlatform":"","sourceKeywords":[""],"sourceIndexes":[]}]}。sourceIndexes 必须为空数组，不输出 Markdown。';
    const userContent = sourceMode === 'hot-evidence'
      ? `账号赛道：${domain || '未指定'}\n搜索关键词：${keywords.join('、')}\n真实证据：\n${evidenceText}\n\n近期已有选题，禁止重复或近义改写：\n${historyText}\n\n跨平台数和独立作者数越多，信号越强。生成 ${count} 个彼此不重复、可执行的选题，摘要必须说明引用了哪些证据信号。`
      : `账号赛道：${domain || '未指定'}\n关键词：${keywords.join('、')}\n\n近期已有选题，禁止重复或近义改写：\n${historyText}\n\n生成 ${count} 个彼此不重复、可执行的常青型或方法型选题。每条摘要必须明确写出“无热点证据，本选题为模型推理”，并说明推理角度。不要使用“突然爆发”“最近大火”“接下来几天会怎样”等暗示实时趋势的表达。`;
    llmCalls += 1;
    const content = await callLlm([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ], { json: true });
    try {
      parsed = parseLlmJson(content);
    } catch {
      llmCalls += 1;
      const repaired = await callLlm([
        {
          role: 'system',
          content: '你是 JSON 修复器。只修复语法并输出合法 JSON，不改变字段含义，不输出 Markdown。',
        },
        { role: 'user', content },
      ], { json: true, temperature: 0, maxTokens: 4096 });
      parsed = parseLlmJson(repaired);
    }
  } catch (error) {
    throw new Error(`LLM 选题生成失败：${error.message}`);
  }
  if (!Array.isArray(parsed?.ideas) || !parsed.ideas.length) {
    throw new Error('LLM 未返回有效选题，且系统不再使用内置模板');
  }
  const deduped = dedupeInspirationIdeas(parsed.ideas, historicalTitles);
  const ideas = deduped.accepted;

  const insert = db.prepare(`
    INSERT INTO inspirations
      (id, title, summary, angle, target_platform, source_keywords, source_items, status,
       config_id, run_id, generation_type, source_mode, generation_note, generated_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '待研究', ?, ?, ?, ?, ?, ?, ?)
  `);
  const runId = body.runId || null;
  const created = ideas.slice(0, count).map(idea => {
    const indexes = Array.isArray(idea.sourceIndexes) ? idea.sourceIndexes : [];
    const referencedItems = indexes
      .map(index => sourceItems[Number(index) - 1])
      .filter(Boolean)
      .slice(0, 5);
    const record = {
      id: crypto.randomUUID(),
      title: String(idea.title || '').trim(),
      summary: String(idea.summary || '').trim(),
      angle: String(idea.angle || '').trim(),
      targetPlatform: String(idea.targetPlatform || '').trim(),
      sourceKeywords: Array.isArray(idea.sourceKeywords) ? idea.sourceKeywords.map(String) : keywords.slice(0, 1),
      sourceItems: referencedItems.length ? referencedItems : sourceItems.slice(0, 3),
      status: '待研究',
      configId: config?.id || null,
      runId,
      generationType: config ? (body.triggerType || 'manual') : 'manual',
      sourceMode,
      generationNote,
      generatedBy: process.env.LLM_MODEL || 'LLM',
      createdAt: Date.now(),
    };
    insert.run(
      record.id,
      record.title,
      record.summary,
      record.angle,
      record.targetPlatform,
      JSON.stringify(record.sourceKeywords),
      JSON.stringify(record.sourceItems),
      record.configId,
      record.runId,
      record.generationType,
      record.sourceMode,
      record.generationNote,
      record.generatedBy,
      record.createdAt,
    );
    return record;
  });
  return {
    ideas: created,
    generatedBy: process.env.LLM_MODEL || 'LLM',
    sourceMode,
    generationNote,
    duplicateCount: deduped.rejected.length,
    duplicates: deduped.rejected,
    keywords,
    research: {
      articleCount: sourceItems.length,
      apiCalls: externalApiCalls + (hotResearch.apiCalls || 0),
      sources: config?.sources || [],
      apiBudget: {
        limit: totalBudget,
        usedBeforeRun: usedBudget,
        usedThisRun: externalApiCalls + (hotResearch.apiCalls || 0),
        remaining: Math.max(0, totalBudget - usedBudget - externalApiCalls - (hotResearch.apiCalls || 0)),
      },
      searches: hotResearch.searched,
      articles: sourceItems,
      localGroupCount: localGroups.length,
      llmCalls,
    },
  };
}

function listInspirations(includeDeleted = false) {
  return db.prepare(`
    SELECT * FROM inspirations
    WHERE deleted_at IS ${includeDeleted ? 'NOT NULL' : 'NULL'}
    ORDER BY ${includeDeleted ? 'deleted_at' : 'created_at'} DESC
    LIMIT 200
  `).all().map(row => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    targetPlatform: row.target_platform,
    sourceKeywords: parseJson(row.source_keywords) || [],
    sourceItems: parseJson(row.source_items) || [],
    kbLink: parseJson(row.kb_link) || null,
    status: row.status,
    isFavorite: Boolean(row.is_favorite),
    feedbackState: row.feedback_state || '',
    configId: row.config_id || null,
    runId: row.run_id || null,
    generationType: row.generation_type || 'manual',
    sourceMode: row.source_mode || 'legacy',
    generationNote: row.generation_note || '',
    generatedBy: row.generated_by || '',
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
  }));
}

function trashInspiration(id) {
  const result = db.prepare('UPDATE inspirations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(Date.now(), id);
  if (!result.changes) throw new Error('选题不存在或已在回收站');
}

function restoreInspiration(id) {
  const result = db.prepare('UPDATE inspirations SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    .run(id);
  if (!result.changes) throw new Error('回收站中没有该选题');
}

function permanentlyDeleteInspiration(id) {
  const result = db.prepare('DELETE FROM inspirations WHERE id = ? AND deleted_at IS NOT NULL').run(id);
  if (!result.changes) throw new Error('只能永久删除回收站中的选题');
}

function inspirationCronId(configId) {
  return `inspiration-config:${configId}`;
}

function isInspirationCronId(id) {
  return typeof id === 'string' && id.startsWith('inspiration-config:');
}

function syncInspirationConfigCron(configId) {
  const config = getInspirationConfig(configId);
  const cronId = inspirationCronId(configId);
  if (!config) {
    deleteCronJob(cronId);
    return;
  }
  saveCronJob(
    cronId,
    `自动选题：${config.name}`,
    config.cronExpr,
    config.enabled,
    'inspiration-generate',
    { configId },
    { notifyOnFailure: true, notifyOnSuccess: true },
  );
}

function deleteInspirationConfig(id) {
  const result = db.prepare('DELETE FROM inspiration_keyword_configs WHERE id = ?').run(id);
  deleteCronJob(inspirationCronId(id));
  return result.changes > 0;
}

const activeInspirationRuns = new Set();

function inspirationApiBudget(config) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const used = db.prepare(`
    SELECT COALESCE(SUM(api_calls), 0) AS count
    FROM inspiration_runs
    WHERE config_id = ? AND started_at >= ?
  `).get(config.id, dayStart.getTime()).count;
  return {
    limit: config.dailyApiBudget,
    used,
    remaining: Math.max(0, config.dailyApiBudget - used),
  };
}

async function runInspirationConfig(configId, triggerType = 'manual') {
  const config = getInspirationConfig(configId);
  if (!config) throw new Error('主题配置不存在');
  if (activeInspirationRuns.has(configId)) throw new Error('该主题已有生成任务正在运行');
  activeInspirationRuns.add(configId);
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  db.prepare(`
    INSERT INTO inspiration_runs
      (id, config_id, trigger_type, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).run(runId, configId, triggerType, startedAt);
  db.prepare('UPDATE inspiration_keyword_configs SET last_run_at = ?, updated_at = ? WHERE id = ?')
    .run(startedAt, startedAt, configId);
  let runApiCalls = 0;
  const recordApiCall = count => {
    runApiCalls += Math.max(0, Number(count) || 0);
    db.prepare('UPDATE inspiration_runs SET api_calls = ? WHERE id = ?').run(runApiCalls, runId);
  };
  try {
    const budget = inspirationApiBudget(config);
    const externalApiCalls = await syncExternalInspirationSources(
      config,
      budget.remaining,
      recordApiCall,
    );
    const localEvidence = selectDiverseEvidence(
      groupInspirationEvidence(collectLocalInspirationEvidence(config)),
      config.evidenceLimit,
    );
    const fingerprint = crypto.createHash('sha1').update(JSON.stringify({
      config: {
        id: config.id,
        domain: config.domain,
        sources: config.sources,
        sourceWeights: config.sourceWeights,
        ideaCount: config.ideaCount,
        evidenceLimit: config.evidenceLimit,
        searchMode: config.searchMode,
        terms: config.terms.map(term => [term.term, term.type, term.weight]),
      },
      evidence: localEvidence.map(item => [item.id, item.batchId, item.score]),
    })).digest('hex');
    const previous = db.prepare(`
      SELECT id FROM inspiration_runs
      WHERE config_id = ? AND status = 'success' AND evidence_fingerprint = ?
      ORDER BY completed_at DESC LIMIT 1
    `).get(configId, fingerprint);
    if (previous && triggerType === 'cron') {
      db.prepare(`
        UPDATE inspiration_runs
        SET evidence_fingerprint = ?, status = 'skipped', completed_at = ?
        WHERE id = ?
      `).run(fingerprint, Date.now(), runId);
      return { runId, skipped: true, ideas: [] };
    }
    db.prepare('UPDATE inspiration_runs SET evidence_fingerprint = ? WHERE id = ?').run(fingerprint, runId);
    const result = await generateInspirations({
      configId,
      count: config.ideaCount,
      runId,
      triggerType,
      externalSourcesSynced: true,
      externalApiCalls,
      usedApiCalls: budget.used,
      onApiCall: recordApiCall,
    });
    const completedAt = Date.now();
    db.prepare(`
      UPDATE inspiration_runs
      SET status = ?, idea_count = ?, api_calls = ?, completed_at = ?
      WHERE id = ?
    `).run(
      result.ideas.length ? 'success' : 'empty',
      result.ideas.length,
      runApiCalls,
      completedAt,
      runId,
    );
    db.prepare(`
      UPDATE inspiration_keyword_configs
      SET last_success_at = ?, updated_at = ?
      WHERE id = ?
    `).run(completedAt, completedAt, configId);
    broadcastNotification(
      '灵感选题生成完成',
      `主题「${config.name}」生成完成，本次新增 ${result.ideas.length} 条选题。`
        + (result.generatedBy ? `\n生成方式：${result.generatedBy}` : '')
        + (result.sourceMode === 'llm-reasoning' ? '\n数据依据：无热点信息，仅大模型推理' : '\n数据依据：热点证据')
        + (result.duplicateCount ? `\n去重过滤：${result.duplicateCount} 条` : '')
        + (runApiCalls ? `\n消耗 API 调用：${runApiCalls}` : '')
    ).catch(err => console.warn('[notify] 灵感选题完成通知异常:', err.message));
    logAction('generate-inspirations', triggerType, 'database+api', {
      configId,
      configName: config.name,
      keywords: result.keywords,
      articleCount: result.research?.articleCount || 0,
      searches: result.research?.searches || [],
      apiBudget: {
        limit: budget.limit,
        usedBeforeRun: budget.used,
        usedThisRun: runApiCalls,
        remaining: Math.max(0, budget.limit - budget.used - runApiCalls),
      },
    }, runApiCalls, result.research?.llmCalls || 1);
    return { runId, skipped: false, ...result };
  } catch (error) {
    db.prepare(`
      UPDATE inspiration_runs
      SET status = 'failed', api_calls = ?, completed_at = ?, error = ?
      WHERE id = ?
    `).run(runApiCalls, Date.now(), error.message, runId);
    throw error;
  } finally {
    activeInspirationRuns.delete(configId);
  }
}

function listInspirationRuns(configId = null) {
  const rows = configId
    ? db.prepare('SELECT * FROM inspiration_runs WHERE config_id = ? ORDER BY started_at DESC LIMIT 100').all(configId)
    : db.prepare('SELECT * FROM inspiration_runs ORDER BY started_at DESC LIMIT 100').all();
  return rows.map(row => ({
    id: row.id,
    configId: row.config_id,
    triggerType: row.trigger_type,
    status: row.status,
    ideaCount: row.idea_count,
    apiCalls: row.api_calls,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  }));
}

function setInspirationFavorite(id, favorite) {
  const result = db.prepare('UPDATE inspirations SET is_favorite = ? WHERE id = ?')
    .run(favorite ? 1 : 0, id);
  if (!result.changes) throw new Error('选题不存在');
}

function applyInspirationFeedback(id, feedbackType) {
  if (!['like', 'dislike', 'block', 'none'].includes(feedbackType)) throw new Error('反馈类型无效');
  const inspiration = db.prepare('SELECT * FROM inspirations WHERE id = ?').get(id);
  if (!inspiration) throw new Error('选题不存在');
  const now = Date.now();
  const active = db.prepare(`
    SELECT * FROM inspiration_feedback
    WHERE inspiration_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(id);
  db.transaction(() => {
    if (active) {
      db.prepare('UPDATE inspiration_feedback SET revoked_at = ? WHERE id = ?').run(now, active.id);
      const terms = parseJson(active.affected_terms) || [];
      for (const term of terms) {
        db.prepare(`
          UPDATE inspiration_keyword_terms
          SET learned_weight = MAX(-5, MIN(5, learned_weight - ?)), updated_at = ?
          WHERE config_id = ? AND term = ?
        `).run(active.weight_delta, now, inspiration.config_id, term);
      }
    }
    if (feedbackType === 'none') {
      db.prepare('UPDATE inspirations SET feedback_state = NULL WHERE id = ?').run(id);
      return;
    }
    const terms = normalizeTerms(parseJson(inspiration.source_keywords) || []).slice(0, 8);
    const delta = feedbackType === 'like' ? 0.5 : feedbackType === 'dislike' ? -0.5 : -2;
    db.prepare(`
      INSERT INTO inspiration_feedback
        (id, inspiration_id, feedback_type, affected_terms, weight_delta, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, feedbackType, JSON.stringify(terms), delta, now);
    if (inspiration.config_id) {
      for (const term of terms) {
        const existing = db.prepare(`
          SELECT id FROM inspiration_keyword_terms WHERE config_id = ? AND term = ?
        `).get(inspiration.config_id, term);
        if (existing) {
          db.prepare(`
            UPDATE inspiration_keyword_terms
            SET term_type = CASE WHEN ? = 'block' THEN 'black' ELSE term_type END,
                learned_weight = MAX(-5, MIN(5, learned_weight + ?)),
                updated_at = ?
            WHERE id = ?
          `).run(feedbackType, delta, now, existing.id);
        } else {
          db.prepare(`
            INSERT INTO inspiration_keyword_terms
              (id, config_id, term, term_type, manual_weight, learned_weight, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)
          `).run(
            crypto.randomUUID(), inspiration.config_id, term,
            feedbackType === 'block' ? 'black' : 'alias',
            clamp(delta, -5, 5), now, now,
          );
        }
      }
    }
    db.prepare('UPDATE inspirations SET feedback_state = ? WHERE id = ?').run(feedbackType, id);
  })();
  return getInspirationConfig(inspiration.config_id);
}

function listTrackers() {
  return db.prepare('SELECT * FROM tracked_accounts ORDER BY created_at DESC').all().map(row => {
    const raw = parseJson(row.raw_info) || {};
    if (String(raw.authorFans || '').startsWith('红狐指数')) delete raw.authorFans;
    return {
      ...raw,
      id: row.id,
      plat: row.plat,
      name: row.name,
      group: row.group_name,
      syncedAt: row.synced_at,
      createdAt: row.created_at,
    };
  });
}

function saveTracker(body) {
  const plat = String(body.plat || '');
  const name = String(body.name || '').trim();
  if (!['dy', 'xhs', 'gzh'].includes(plat) || !name) throw new Error('平台或账号名称无效');
  const accountId = normalizeTrackerAccountId(plat, body.accountId || '');
  if (['dy', 'xhs'].includes(plat) && !accountId) {
    throw new Error(plat === 'dy' ? '请填写抖音号或账号 ID' : '请填写小红书号（redId）');
  }
  const id = String(body.id || `${plat}:${accountId || name}`);
  const now = Date.now();
  const raw = { ...body, accountId };
  if (String(raw.authorFans || '').startsWith('红狐指数')) delete raw.authorFans;
  const existing = db.prepare('SELECT plat, raw_info FROM tracked_accounts WHERE id = ?').get(id);
  const existingRaw = parseJson(existing?.raw_info) || {};
  const identifierChanged = Boolean(existing) && (
    existing.plat !== plat
    || normalizeTrackerAccountId(existing.plat, existingRaw.accountId || '') !== accountId
  );
  delete raw.id;
  delete raw.plat;
  delete raw.name;
  delete raw.group;
  delete raw.syncedAt;
  delete raw.createdAt;
  db.prepare(`
    INSERT INTO tracked_accounts (id, plat, name, group_name, raw_info, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      plat = excluded.plat,
      name = excluded.name,
      group_name = excluded.group_name,
      raw_info = excluded.raw_info
  `).run(id, plat, name, body.group || '其他', JSON.stringify(raw), now);
  if (identifierChanged) {
    db.prepare('DELETE FROM account_works WHERE account_id = ?').run(id);
    db.prepare('UPDATE tracked_accounts SET synced_at = NULL WHERE id = ?').run(id);
  }
  return listTrackers().find(item => item.id === id);
}

const activeTrackerSyncs = new Map();
const trackerRetryTimers = new Map();
const TRACKER_COLLECTION_WAIT_MS = 30 * 60 * 1000;

function normalizeTrackerAccountId(plat, value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    if (plat === 'dy') {
      const match = url.pathname.match(/\/user\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    if (plat === 'xhs') {
      const match = url.pathname.match(/\/user\/profile\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  } catch {}
  return input;
}

function trackerQuerySpec(tracker) {
  const accountId = normalizeTrackerAccountId(tracker.plat, tracker.accountId || '');
  if (tracker.plat === 'gzh') {
    return {
      endpoint: 'gzhData/queryWorkList',
      body: {
        account: tracker.gzhAccount || undefined,
        accountName: tracker.name,
        offset: 0,
        sortType: '_2',
        publishTimeStart: dateDaysAgo(90),
        publishTimeEnd: localDate(),
        source: '灵感熔炉-账号追踪',
      },
    };
  }
  if (tracker.plat === 'dy') {
    if (!accountId) throw new Error('该订阅缺少抖音号或账号 ID，请先编辑账号信息');
    return {
      endpoint: 'dyData/queryUserWithWorks',
      body: { accountId, source: '灵感熔炉-账号追踪' },
    };
  }
  if (tracker.plat === 'xhs') {
    if (!accountId) throw new Error('该订阅缺少小红书号（redId），请先编辑账号信息');
    return {
      endpoint: 'xhsUser/query',
      body: { userIds: [accountId], source: '灵感熔炉-账号追踪' },
    };
  }
  throw new Error(`不支持的平台：${tracker.plat}`);
}

function trackerCollectionSpec(tracker) {
  const accountId = normalizeTrackerAccountId(tracker.plat, tracker.accountId || '');
  if (tracker.plat === 'xhs') {
    return {
      endpoint: 'xhsUser/syncUserNotes',
      body: { redId: accountId, source: '灵感熔炉-账号追踪' },
    };
  }
  throw new Error(`当前不支持提交 ${tracker.plat} 账号采集`);
}

function xhsTrackerAccounts(data) {
  return Array.isArray(data)
    ? data
    : Array.isArray(data?.list) ? data.list
      : data && typeof data === 'object' ? [data] : [];
}

function normalizeTrackerResult(tracker, data) {
  if (tracker.plat === 'gzh') {
    return { works: data?.list || data?.articles || [], trackerPatch: {} };
  }
  if (tracker.plat === 'dy') {
    if (!data || !data.nickname) {
      throw new Error('未查询到该抖音账号，请检查抖音号；未收录账号需先在 RedFox 同步');
    }
    const accountId = data.accountId || data.uniqueId || tracker.accountId;
    const works = (Array.isArray(data.workList) ? data.workList : []).map(work => ({
      ...work,
      accountName: work.accountName || data.nickname,
      accountId: work.accountId || accountId,
      avatarUrl: work.avatarUrl || data.avatar,
      followerCount: work.followerCount ?? data.followerCount,
    }));
    return {
      works,
      trackerPatch: {
        name: data.nickname || tracker.name,
        accountId,
        avatar: data.avatar || tracker.avatar,
        authorFans: data.followerCount ?? tracker.authorFans,
        redfoxIndex: data.redfoxIndex ?? tracker.redfoxIndex,
        secUid: data.secUid || tracker.secUid,
      },
    };
  }
  const accounts = xhsTrackerAccounts(data);
  const expectedId = normalizeTrackerAccountId('xhs', tracker.accountId || '');
  const account = accounts.find(item => String(item.redId || item.userId || '') === expectedId)
    || accounts[0];
  if (!account || !account.nickname) {
    throw new Error('未查询到该小红书账号，请检查小红书号（redId）；昵称不能用于稳定追踪');
  }
  const accountId = account.redId || account.userId || expectedId;
  const works = (Array.isArray(account.works) ? account.works : []).map(work => ({
    ...work,
    accountNickname: work.accountNickname || account.nickname,
    authorNickname: work.authorNickname || account.nickname,
    accountUserid: work.accountUserid || accountId,
    authorId: work.authorId || accountId,
    authorFans: work.authorFans ?? account.fans,
    cover: work.cover || work.coverUrl,
  }));
  return {
    works,
    trackerPatch: {
      name: account.nickname || tracker.name,
      accountId,
      avatar: account.avatar || tracker.avatar,
      description: account.desc || tracker.description,
      authorFans: account.fans ?? tracker.authorFans,
      redfoxIndex: account.recentIndex ?? tracker.redfoxIndex,
    },
  };
}

function trackerWorkId(work) {
  return work.workId || work.workUuid || work.id || work.awemeId
    || crypto.createHash('sha1').update([
      String(work.title || work.desc || ''),
      String(work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''),
      String(work.workUrl || work.url || ''),
    ].join('\n')).digest('hex');
}

function trackerPendingResult(tracker, message) {
  return {
    tracker,
    works: [],
    count: 0,
    newCount: 0,
    pending: true,
    retryAt: tracker.syncRetryAt || null,
    message: message || tracker.syncMessage || 'RedFox 正在采集账号数据',
  };
}

function scheduleTrackerRetry(id, retryAt) {
  const existing = trackerRetryTimers.get(id);
  if (existing) clearTimeout(existing);
  const delay = Math.max(1000, Number(retryAt) - Date.now());
  const timer = setTimeout(async () => {
    trackerRetryTimers.delete(id);
    try {
      await syncTracker(id, { automatic: true });
    } catch (error) {
      console.warn(`[tracker] 自动回查 ${id} 失败:`, error.message);
    }
  }, delay);
  timer.unref?.();
  trackerRetryTimers.set(id, timer);
}

function restoreTrackerRetries() {
  for (const tracker of listTrackers()) {
    if (tracker.plat === 'xhs' && tracker.syncStatus === 'pending' && tracker.syncRetryAt) {
      scheduleTrackerRetry(tracker.id, tracker.syncRetryAt);
    }
  }
}

async function submitTrackerCollection(tracker) {
  const request = trackerCollectionSpec(tracker);
  await redfoxData(request.endpoint, request.body);
  const now = Date.now();
  const retryAt = now + TRACKER_COLLECTION_WAIT_MS;
  const updated = saveTracker({
    ...tracker,
    syncStatus: 'pending',
    syncRequestedAt: now,
    syncRetryAt: retryAt,
    syncMessage: '已提交 RedFox 采集，预计约 30 分钟后可查询',
    syncAttempts: Number(tracker.syncAttempts || 0) + 1,
  });
  scheduleTrackerRetry(tracker.id, retryAt);
  logAction('tracker-collection-submit', 'sync-button', 'redfox', {
    trackerId: tracker.id,
    platform: tracker.plat,
    accountId: tracker.accountId,
    retryAt,
  }, 1, 0);
  return trackerPendingResult(updated);
}

async function syncTracker(id, options = {}) {
  if (activeTrackerSyncs.has(id)) return activeTrackerSyncs.get(id);
  const promise = syncTrackerOnce(id, options);
  activeTrackerSyncs.set(id, promise);
  try {
    return await promise;
  } finally {
    activeTrackerSyncs.delete(id);
  }
}

async function syncTrackerOnce(id, options = {}) {
  let tracker = listTrackers().find(item => item.id === id);
  if (!tracker) throw new Error('账号不存在');
  if (
    tracker.plat === 'xhs'
    && tracker.syncStatus === 'pending'
    && Number(tracker.syncRetryAt) > Date.now()
    && !options.automatic
  ) {
    return trackerPendingResult(tracker);
  }
  const query = trackerQuerySpec(tracker);
  const data = await redfoxData(query.endpoint, query.body);
  if (tracker.plat === 'xhs' && !xhsTrackerAccounts(data).some(account => account?.nickname)) {
    if (!tracker.syncRequestedAt) return submitTrackerCollection(tracker);
    const updated = saveTracker({
      ...tracker,
      syncStatus: 'waiting',
      syncRetryAt: null,
      syncCheckedAt: Date.now(),
      syncMessage: 'RedFox 已接受采集，但暂未返回账号数据。请稍后再次同步；也请确认填写的是主页显示的小红书号。',
    });
    logAction('tracker-collection-pending', options.automatic ? 'automatic-retry' : 'sync-button', 'redfox', {
      trackerId: tracker.id,
      platform: tracker.plat,
      accountId: tracker.accountId,
    }, 1, 0);
    return trackerPendingResult(updated);
  }
  const normalized = normalizeTrackerResult(tracker, data);
  if (tracker.plat === 'xhs' && !normalized.works.length) {
    if (!tracker.syncRequestedAt) return submitTrackerCollection(tracker);
    const updated = saveTracker({
      ...tracker,
      ...normalized.trackerPatch,
      syncStatus: 'waiting',
      syncRetryAt: null,
      syncCheckedAt: Date.now(),
      syncMessage: '账号资料已匹配，但作品仍在 RedFox 入库中，请稍后再次同步。',
    });
    return trackerPendingResult(updated);
  }
  if (Object.keys(normalized.trackerPatch).length) {
    tracker = saveTracker({
      ...tracker,
      ...normalized.trackerPatch,
      syncStatus: 'ready',
      syncRetryAt: null,
      syncCheckedAt: Date.now(),
      syncMessage: '',
    });
  }
  const works = normalized.works.sort((a, b) => workPublishAt(b) - workPublishAt(a));
  const now = Date.now();
  const existingStmt = db.prepare(`
    SELECT 1 FROM account_works WHERE account_id = ? AND plat = ? AND work_id = ?
  `);
  const newWorks = works.filter(work => {
    const workId = trackerWorkId(work);
    if (!workId) return false;
    return !existingStmt.get(id, tracker.plat, String(workId));
  });
  const upsertWork = db.prepare(`
    INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, plat, work_id) DO UPDATE SET
      work_data = excluded.work_data,
      synced_at = excluded.synced_at,
      publish_at = excluded.publish_at,
      content_key = excluded.content_key
  `);
  db.transaction(() => {
    for (const work of works) {
      const workId = trackerWorkId(work);
      if (!workId) continue;
      const key = workContentKey(work);
      db.prepare(`
        DELETE FROM account_works
        WHERE account_id = ? AND plat = ? AND content_key = ? AND work_id <> ?
      `).run(id, tracker.plat, key, String(workId));
      upsertWork.run(
        id,
        tracker.plat,
        String(workId),
        JSON.stringify(work),
        now,
        workPublishAt(work),
        key,
      );
    }
    db.prepare('UPDATE tracked_accounts SET synced_at = ? WHERE id = ?').run(now, id);
  })();
  if (newWorks.length) {
    const top = newWorks.slice(0, 3).map(work => {
      const title = (work.title || work.desc || '').toString().slice(0, 60);
      return `· ${title || '(无标题)'}`;
    }).join('\n');
    broadcastNotification(
      `追踪账号「${tracker.name}」有新作品`,
      `本次同步新增 ${newWorks.length} 条作品${newWorks.length > 3 ? '（仅显示前 3 条）' : ''}：\n${top}`
    ).catch(err => console.warn('[notify] 追踪账号新作品通知异常:', err.message));
  }
  return {
    tracker: { ...tracker, syncedAt: now },
    works,
    count: works.length,
    newCount: newWorks.length,
    ...(options.includeSourceData ? { _sourceData: data } : {}),
  };
}

function listTrackerWorks(id) {
  const seen = new Set();
  return db.prepare(`
    SELECT work_data, publish_at, synced_at
    FROM account_works
    WHERE account_id = ?
    ORDER BY COALESCE(publish_at, 0) DESC, synced_at DESC
    LIMIT 200
  `).all(id).map(row => parseJson(row.work_data)).filter(work => {
    if (!work) return false;
    const key = `${String(work.title || '').trim().toLowerCase()}\n${
      work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 100);
}

function diagnosisMetrics(report) {
  const raw = report._raw || {};
  const header = report.header || {};
  return {
    followerCount: toNumber(raw.followerCount ?? raw.fans ?? header['粉丝数']),
    redfoxIndex: toNumber(raw.redfoxIndex ?? raw.recentIndex ?? header['红狐指数']),
    score: toNumber(report.scores?.['综合评分']),
    workCount: toNumber(raw.awemeCount ?? raw.totalWork ?? raw.workCount) || (report.works || []).length,
  };
}

function listAccountSnapshots(accountId, limit = 30) {
  return db.prepare(`
    SELECT snapshot_date, follower_count, redfox_index, work_count, score, analysis, raw_data, captured_at
    FROM account_snapshots
    WHERE account_id = ?
    ORDER BY snapshot_date DESC, captured_at DESC
    LIMIT ?
  `).all(accountId, limit).map(row => ({
    snapshotDate: row.snapshot_date,
    followerCount: row.follower_count,
    redfoxIndex: row.redfox_index,
    workCount: row.work_count,
    score: row.score,
    analysis: parseJson(row.analysis) || row.analysis || null,
    report: parseJson(row.raw_data) || null,
    capturedAt: row.captured_at,
  }));
}

async function buildAccountTrendAnalysis(tracker, report, snapshotDate) {
  const history = listAccountSnapshots(tracker.id, 14).reverse().map(item => ({
    date: item.snapshotDate,
    followers: item.followerCount,
    redfoxIndex: item.redfoxIndex,
    score: item.score,
    works: item.workCount,
  }));
  const current = diagnosisMetrics(report);
  if (!history.length) {
    return {
      summary: `已建立 ${snapshotDate} 的首个账号基线快照，后续刷新后可比较趋势。`,
      changes: [],
      risks: [],
      actions: ['保持每日快照，至少积累 7 天后再判断稳定趋势。'],
      generatedBy: '基线规则',
    };
  }
  const previous = history.at(-1);
  const currentValues = [current.followerCount, current.redfoxIndex, current.score, current.workCount];
  const previousValues = [previous.followers, previous.redfoxIndex, previous.score, previous.works];
  if (currentValues.every((value, index) => value === previousValues[index])) {
    return {
      summary: `与 ${previous.date} 相比，粉丝、红狐指数、综合评分和作品数均无变化。`,
      changes: ['核心指标无变化，本次未调用 LLM。'],
      risks: [],
      actions: ['继续观察下一次数据更新。'],
      generatedBy: '无变化规则',
    };
  }
  if (!process.env.LLM_API_KEY) {
    return {
      summary: `截至 ${snapshotDate}，综合评分 ${current.score ?? '--'}，红狐指数 ${current.redfoxIndex ?? '--'}。`,
      changes: [
        `粉丝变化：${(current.followerCount ?? 0) - (previous.followers ?? 0)}`,
        `红狐指数变化：${(current.redfoxIndex ?? 0) - (previous.redfoxIndex ?? 0)}`,
      ],
      actions: ['保持每日快照，至少积累 7 天后再判断稳定趋势。'],
      generatedBy: '规则分析',
    };
  }
  try {
    return await callLlmJson([
      {
        role: 'system',
        content: '你是自媒体账号数据分析师。只基于给定的真实快照和本次 Skill 评分做趋势解读，不得编造。输出 JSON：{"summary":"","changes":[""],"risks":[""],"actions":[""]}。',
      },
      {
        role: 'user',
        content: `平台：${tracker.plat}\n账号：${tracker.name}\n当前日期：${snapshotDate}\n历史快照：${JSON.stringify(history)}\n本次指标：${JSON.stringify(current)}\n本次维度评分：${JSON.stringify(report.dimensions || [])}`,
      },
    ]);
  } catch (error) {
    return {
      summary: `评分已保存，但 LLM 趋势解读失败：${error.message}`,
      changes: [],
      risks: [],
      actions: ['可在 LLM 服务恢复后重新运行评分详情。'],
      generatedBy: '规则降级',
    };
  }
}

async function diagnoseAndStoreTracker(tracker, options = {}) {
  const report = await runPlatformDiagnosis(tracker, options.sourceData);
  const metrics = diagnosisMetrics(report);
  const snapshotDate = options.snapshotDate || localDate();
  const analysis = tracker.group === '自己'
    ? await buildAccountTrendAnalysis(tracker, report, snapshotDate)
    : null;
  const raw = report._raw || {};
  const updated = saveTracker({
    ...tracker,
    name: report.header?.['账号名'] || tracker.name,
    avatar: raw.avatar || raw.avatarUrl || tracker.avatar,
    gzhAvatar: tracker.plat === 'gzh' ? (raw.avatar || tracker.gzhAvatar) : tracker.gzhAvatar,
    authorFans: metrics.followerCount ?? tracker.authorFans,
    redfoxIndex: metrics.redfoxIndex ?? tracker.redfoxIndex,
    gzhRedfoxIndex: tracker.plat === 'gzh' ? (metrics.redfoxIndex ?? tracker.gzhRedfoxIndex) : tracker.gzhRedfoxIndex,
  });
  db.prepare(`
    INSERT INTO account_snapshots
      (account_id, snapshot_date, follower_count, redfox_index, work_count, raw_data, captured_at, score, analysis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
      follower_count = excluded.follower_count,
      redfox_index = excluded.redfox_index,
      work_count = excluded.work_count,
      raw_data = excluded.raw_data,
      captured_at = excluded.captured_at,
      score = excluded.score,
      analysis = excluded.analysis
  `).run(
    tracker.id,
    snapshotDate,
    metrics.followerCount,
    metrics.redfoxIndex,
    metrics.workCount,
    JSON.stringify(report),
    Date.now(),
    metrics.score,
    analysis ? JSON.stringify(analysis) : null,
  );
  setLocalData('diagnosis', tracker.id, report, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return { report, tracker: updated, analysis };
}

async function refreshTrackedAccounts() {
  const trackers = listTrackers().filter(tracker => tracker.autoSync === true);
  const result = { selected: trackers.length, synced: 0, diagnosed: 0, apiCalls: 0, failed: [] };
  for (const tracker of trackers) {
    try {
      const synced = await syncTracker(tracker.id, {
        automatic: true,
        includeSourceData: tracker.group === '自己' && tracker.plat === 'xhs',
      });
      result.synced += 1;
      result.apiCalls += 1;
      if (tracker.group === '自己') {
        await diagnoseAndStoreTracker(listTrackers().find(item => item.id === tracker.id) || tracker, {
          snapshotDate: dateDaysAgo(1),
          sourceData: tracker.plat === 'xhs' ? synced._sourceData : null,
        });
        result.diagnosed += 1;
        if (tracker.plat !== 'xhs') result.apiCalls += 1;
      }
    } catch (error) {
      result.failed.push({ id: tracker.id, name: tracker.name, error: error.message });
    }
  }
  logAction('tracker-refresh', 'cron', 'redfox+llm', result, result.apiCalls, 0);
  return result;
}

async function handleLocalApi(req, res, url) {
  if (url.pathname === '/api/_/login' && req.method === 'POST') {
    const { data } = await readBody(req);
    const username = String(data.username || '').trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user || !verifyPassword(data.password || '', user.password_hash)) {
      json(res, 401, { ok: false, error: '用户名或密码错误' });
      return true;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = 7 * 24 * 60 * 60;
    const now = Date.now();
    sessionSet(token, user.id, now + maxAge * 1000);
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    json(res, 200, { ok: true, data: { authenticated: true, user: publicUser(updatedUser) } }, {
      'Set-Cookie': `furnace_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
    });
    return true;
  }
  if (url.pathname === '/api/_/logout' && req.method === 'POST') {
    const token = getCookies(req).furnace_session;
    if (token) sessionDel(token);
    json(res, 200, { ok: true }, {
      'Set-Cookie': 'furnace_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    return true;
  }
  if (url.pathname === '/api/_/status' && req.method === 'GET') {
    const auth = currentSession(req);
    json(res, 200, {
      ok: true,
      redfoxConfigured: Boolean(API_KEY),
      llmConfigured: Boolean(process.env.LLM_API_KEY),
      schedulerEnabled: ENABLE_SCHEDULER,
      authRequired: true,
      authenticated: Boolean(auth),
      user: auth ? publicUser(auth.user) : null,
    });
    return true;
  }
  if (url.pathname === '/api/_/redfox/apply' && req.method === 'GET') {
    json(res, 200, { ok: true, url: redfoxApplyUrl() });
    return true;
  }
  if (url.pathname === '/api/_/account' && req.method === 'GET') {
    const auth = currentSession(req);
    json(res, 200, { ok: true, data: publicUser(auth.user) });
    return true;
  }
  if (url.pathname === '/api/_/account' && req.method === 'PATCH') {
    const auth = currentSession(req);
    const { data } = await readBody(req);
    let username;
    try {
      username = validateUsername(data.username ?? auth.user.username);
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
      return true;
    }
    const displayName = String(data.displayName ?? auth.user.display_name).trim();
    if (!displayName || displayName.length > 50) {
      json(res, 400, { ok: false, error: '显示名称需为 1-50 个字符' });
      return true;
    }
    const duplicate = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?')
      .get(username, auth.user.id);
    if (duplicate) {
      json(res, 409, { ok: false, error: '用户名已存在' });
      return true;
    }
    const now = Date.now();
    db.prepare('UPDATE users SET username = ?, display_name = ?, updated_at = ? WHERE id = ?')
      .run(username, displayName, now, auth.user.id);
    json(res, 200, {
      ok: true,
      data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id)),
    });
    return true;
  }
  if (url.pathname === '/api/_/account/password' && req.method === 'POST') {
    const auth = currentSession(req);
    const { data } = await readBody(req);
    if (!verifyPassword(data.currentPassword || '', auth.user.password_hash)) {
      json(res, 400, { ok: false, error: '当前密码错误' });
      return true;
    }
    let newPassword;
    try {
      newPassword = validatePassword(data.newPassword);
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
      return true;
    }
    if (verifyPassword(newPassword, auth.user.password_hash)) {
      json(res, 400, { ok: false, error: '新密码不能与当前密码相同' });
      return true;
    }
    const now = Date.now();
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(hashPassword(newPassword), now, now, auth.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(auth.user.id, auth.token);
    })();
    for (const [token, session] of sessions) {
      if (session.userId === auth.user.id && token !== auth.token) sessions.delete(token);
    }
    json(res, 200, {
      ok: true,
      data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id)),
    });
    return true;
  }
  if (url.pathname === '/api/_/env' && req.method === 'GET') {
    json(res, 200, { ok: true, data: publicEnvConfig() });
    return true;
  }
  if (url.pathname === '/api/_/env' && req.method === 'PUT') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: updateEnvConfig(data || {}), restartRequired: true });
    return true;
  }
  if (url.pathname === '/api/_/service/restart' && req.method === 'POST') {
    json(res, 200, { ok: true, data: { restarting: true } });
    restartCurrentService();
    return true;
  }
  if (url.pathname === '/api/_/stats' && req.method === 'GET') {
    json(res, 200, {
      cache: db.prepare('SELECT COUNT(*) AS n FROM api_cache').get().n,
      accounts: db.prepare('SELECT COUNT(*) AS n FROM tracked_accounts').get().n,
      works: db.prepare('SELECT COUNT(*) AS n FROM account_works').get().n,
      snapshots: db.prepare("SELECT COUNT(*) AS n FROM hot_batches WHERE status = 'success'").get().n,
      inspirations: db.prepare('SELECT COUNT(*) AS n FROM inspirations').get().n,
    });
    return true;
  }
  if (url.pathname === '/api/_/action-logs' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listActionLogs(Number(url.searchParams.get('limit')) || 100) });
    return true;
  }
  if (url.pathname === '/api/_/quota' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      data: {
        usage: usageSummary(),
        official: await getOfficialQuota(),
      },
    });
    return true;
  }
  if (url.pathname === '/api/_/notifications' && req.method === 'GET') {
    json(res, 200, { ok: true, data: publicNotificationConfigs() });
    return true;
  }
  if (url.pathname === '/api/_/notifications' && req.method === 'PUT') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: saveNotificationConfigs(data || {}) });
    return true;
  }
  if (url.pathname === '/api/_/notifications/test' && req.method === 'POST') {
    const { data } = await readBody(req);
    const channel = String(data.channel || '');
    if (!NOTIFICATION_CHANNELS.has(channel)) {
      json(res, 400, { ok: false, error: '不支持的通知渠道' });
      return true;
    }
    const saved = notificationConfigs()[channel] || {};
    const incoming = data.config || {};
    const config = {
      ...saved,
      ...incoming,
      url: String(incoming.url || '').trim() || saved.url || '',
      botToken: String(incoming.botToken || '').trim() || saved.botToken || '',
      chatId: String(incoming.chatId || '').trim() || saved.chatId || '',
    };
    await sendNotification(channel, config, '灵感熔炉测试通知', '通知渠道配置成功。');
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/api/_/image' && req.method === 'GET') {
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) throw new Error('缺少图片地址');
    const target = new URL(rawUrl);
    const allowed = [
      'qpic.cn',
      'qlogo.cn',
      'redfox.hk',
    ].some(host => target.hostname === host || target.hostname.endsWith(`.${host}`));
    if (!allowed || !['http:', 'https:'].includes(target.protocol)) {
      json(res, 403, { ok: false, error: '不允许代理该图片地址' });
      return true;
    }
    target.protocol = 'https:';
    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 insprira/0.1.0',
        Referer: 'https://mp.weixin.qq.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.startsWith('image/')) {
      json(res, 502, { ok: false, error: `图片获取失败 HTTP ${response.status}` });
      return true;
    }
    const content = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(content);
    return true;
  }
  if (url.pathname === '/api/_/skills' && req.method === 'GET') {
    const skills = listSkills().map(({ content, ...skill }) => skill);
    json(res, 200, { ok: true, data: skills });
    return true;
  }
  if (url.pathname === '/api/_/skills/status' && req.method === 'GET') {
    try {
      json(res, 200, { ok: true, data: await communitySkillUpdateStatus() });
    } catch (error) {
      json(res, 502, { ok: false, error: `检查 Skill 更新失败：${error.message}` });
    }
    return true;
  }
  if (url.pathname === '/api/_/skills/update' && req.method === 'POST') {
    try {
      json(res, 200, { ok: true, data: await updateCommunitySkills() });
    } catch (error) {
      json(res, 500, { ok: false, error: `更新 Skill 失败：${error.message}` });
    }
    return true;
  }
  const skillMatch = url.pathname.match(/^\/api\/_\/skills\/([a-z0-9-]+)$/i);
  if (skillMatch && req.method === 'GET') {
    const skill = getSkill(skillMatch[1]);
    if (!skill) {
      json(res, 404, { ok: false, error: 'Skill 不存在' });
      return true;
    }
    json(res, 200, { ok: true, data: skill });
    return true;
  }
  if (url.pathname === '/api/_/agents' && req.method === 'GET') {
    json(res, 200, { ok: true, data: await listLocalAgents() });
    return true;
  }
  if (url.pathname === '/api/_/agent/chat' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: await runLocalAgent(data) });
    return true;
  }
  if (url.pathname === '/api/_/snapshot/run' && req.method === 'POST') {
    json(res, 200, { ok: true, data: await captureHotSnapshot() });
    return true;
  }
  if (url.pathname === '/api/_/hot/trends' && req.method === 'GET') {
    const days = Number(url.searchParams.get('days')) || 14;
    const result = getHotTrends(days);
    json(res, 200, { ok: true, data: result, analyzed: true });
    return true;
  }
  if (url.pathname === '/api/_/hot/trends/analyze' && req.method === 'POST') {
    const result = await analyzeHotTrendsLlm();
    json(res, 200, { ok: true, data: result });
    return true;
  }
  if (url.pathname === '/api/_/hot/keywords' && req.method === 'GET') {
    const result = hotListPayload('all');
    json(res, 200, { ok: true, ...result });
    return true;
  }
  if (url.pathname === '/api/_/hot/keywords/sync' && req.method === 'POST') {
    await syncRealtimeHotspots('灵感熔炉-手动刷新');
    json(res, 200, { ok: true, ...hotListPayload('all') });
    return true;
  }
  if (url.pathname === '/api/_/hot/list' && req.method === 'GET') {
    const platform = url.searchParams.get('platform') || 'dy';
    if (!['dy', 'xhs', 'gzh', 'ai-gzh', 'ai-bili', 'ai-xhs'].includes(platform)) {
      json(res, 400, { ok: false, error: '不支持的平台' });
      return true;
    }
    json(res, 200, { ok: true, ...hotListPayload(platform) });
    return true;
  }
  if (url.pathname === '/api/_/hot/list/sync' && req.method === 'POST') {
    const platform = url.searchParams.get('platform') || 'all';
    if (platform === 'all') {
      await syncRealtimeHotspots('灵感熔炉-手动刷新');
      json(res, 200, { ok: true, ...hotListPayload('all') });
      return true;
    }
    if (!['dy', 'xhs', 'gzh', 'ai-gzh', 'ai-bili', 'ai-xhs'].includes(platform)) {
      json(res, 400, { ok: false, error: '不支持的平台' });
      return true;
    }
    await syncDailyPlatform(platform, dateDaysAgo(1), '灵感熔炉-手动昨日榜');
    json(res, 200, { ok: true, ...hotListPayload(platform) });
    return true;
  }
  if (url.pathname === '/api/_/inspiration-sources' && req.method === 'GET') {
    json(res, 200, { ok: true, data: INSPIRATION_SOURCE_META });
    return true;
  }
  if (url.pathname === '/api/_/inspiration-configs' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listInspirationConfigs() });
    return true;
  }
  if (url.pathname === '/api/_/inspiration-configs' && req.method === 'POST') {
    const { data } = await readBody(req);
    try {
      json(res, 200, { ok: true, data: saveInspirationConfig(data) });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }
  const configMatch = url.pathname.match(/^\/api\/_\/inspiration-configs\/([^/]+)(?:\/(run|toggle))?$/);
  if (configMatch) {
    const id = decodeURIComponent(configMatch[1]);
    const action = configMatch[2] || '';
    if (!action && req.method === 'GET') {
      const config = getInspirationConfig(id);
      json(res, config ? 200 : 404, config
        ? { ok: true, data: config }
        : { ok: false, error: '主题配置不存在' });
      return true;
    }
    if (!action && req.method === 'PUT') {
      const { data } = await readBody(req);
      try {
        json(res, 200, { ok: true, data: saveInspirationConfig(data, id) });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return true;
    }
    if (!action && req.method === 'DELETE') {
      const deleted = deleteInspirationConfig(id);
      json(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { ok: false, error: '主题配置不存在' });
      return true;
    }
    if (action === 'toggle' && req.method === 'POST') {
      const { data } = await readBody(req);
      const config = getInspirationConfig(id);
      if (!config) { json(res, 404, { ok: false, error: '主题配置不存在' }); return true; }
      json(res, 200, { ok: true, data: saveInspirationConfig({ ...config, enabled: Boolean(data.enabled) }, id) });
      return true;
    }
    if (action === 'run' && req.method === 'POST') {
      try {
        json(res, 200, { ok: true, data: await runInspirationConfig(id, 'manual') });
      } catch (error) {
        json(res, 500, { ok: false, error: error.message });
      }
      return true;
    }
  }
  if (url.pathname === '/api/_/inspiration-runs' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listInspirationRuns(url.searchParams.get('configId')) });
    return true;
  }
  if (url.pathname === '/api/_/inspirations' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listInspirations(url.searchParams.get('deleted') === '1') });
    return true;
  }
  if (url.pathname === '/api/_/inspirations/count' && req.method === 'GET') {
    const active = db.prepare('SELECT COUNT(*) AS n FROM inspirations WHERE deleted_at IS NULL').get().n;
    const favorite = db.prepare('SELECT COUNT(*) AS n FROM inspirations WHERE deleted_at IS NULL AND is_favorite = 1').get().n;
    const trash = db.prepare('SELECT COUNT(*) AS n FROM inspirations WHERE deleted_at IS NOT NULL').get().n;
    json(res, 200, { ok: true, data: { active, favorite, trash } });
    return true;
  }
  if (url.pathname === '/api/_/inspirations' && req.method === 'POST') {
    const { data } = await readBody(req);
    const title = String(data.title || '').trim();
    if (!title) { json(res, 400, { ok: false, error: '标题必填' }); return true; }
    const id = data.id || `insp:${crypto.randomUUID()}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO inspirations (id, title, summary, angle, target_platform, source_keywords, source_items, status, created_at, updated_at, generation_type, source_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, summary = excluded.summary, updated_at = excluded.updated_at
    `).run(
      id, title, String(data.summary || ''), String(data.angle || '预设'),
      String(data.targetPlatform || ''), JSON.stringify(data.sourceKeywords || []),
      JSON.stringify(data.sourceItems || []), String(data.status || '待研究'),
      now, now, String(data.generationType || 'manual'),
      String(data.sourceMode || 'llm-reasoning')
    );
    json(res, 200, { ok: true, data: { id } });
    return true;
  }
  if (url.pathname === '/api/_/inspirations/generate' && req.method === 'POST') {
    const { data } = await readBody(req);
    const result = await generateInspirations(data);
    logAction('generate-inspirations', 'button', result.research?.localGroupCount ? 'database+api' : 'api', {
      keywords: result.keywords,
      searches: result.research?.searches || [],
      articleCount: result.research?.articleCount || 0,
    }, result.research?.apiCalls || 0, result.research?.llmCalls || 1);
    json(res, 200, { ok: true, data: result });
    return true;
  }
  if (url.pathname.startsWith('/api/_/inspirations/') && req.method === 'PATCH') {
    const id = decodeURIComponent(url.pathname.slice('/api/_/inspirations/'.length));
    const { data } = await readBody(req);
    db.prepare('UPDATE inspirations SET status = ? WHERE id = ?').run(String(data.status || '待研究'), id);
    json(res, 200, { ok: true });
    return true;
  }
  const inspirationActionMatch = url.pathname.match(/^\/api\/_\/inspirations\/([^/]+)\/(favorite|feedback|trash|restore|permanent)$/);
  if (inspirationActionMatch && req.method === 'POST') {
    const id = decodeURIComponent(inspirationActionMatch[1]);
    const { data } = await readBody(req);
    try {
      if (inspirationActionMatch[2] === 'favorite') {
        setInspirationFavorite(id, Boolean(data.favorite));
        json(res, 200, { ok: true });
      } else if (inspirationActionMatch[2] === 'feedback') {
        json(res, 200, { ok: true, data: applyInspirationFeedback(id, String(data.type || 'none')) });
      } else if (inspirationActionMatch[2] === 'trash') {
        trashInspiration(id);
        json(res, 200, { ok: true });
      } else if (inspirationActionMatch[2] === 'restore') {
        restoreInspiration(id);
        json(res, 200, { ok: true });
      } else {
        permanentlyDeleteInspiration(id);
        json(res, 200, { ok: true });
      }
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return true;
  }
  if (url.pathname === '/api/_/rewrite/hotspots' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: await findRewriteHotspots(data) });
    return true;
  }
  if (url.pathname === '/api/_/rewrite' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: await rewriteForPlatform(data) });
    return true;
  }
  if (url.pathname === '/api/_/trackers' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listTrackers() });
    return true;
  }
  if (url.pathname === '/api/_/trackers' && req.method === 'POST') {
    const { data } = await readBody(req);
    json(res, 200, { ok: true, data: saveTracker(data) });
    return true;
  }
  const trackerMatch = url.pathname.match(/^\/api\/_\/trackers\/([^/]+)(?:\/(sync|works|diagnose|trend))?$/);
  if (trackerMatch) {
    const id = decodeURIComponent(trackerMatch[1]);
    const action = trackerMatch[2];
    if (!action && req.method === 'DELETE') {
      db.prepare('DELETE FROM tracked_accounts WHERE id = ?').run(id);
      db.prepare('DELETE FROM account_works WHERE account_id = ?').run(id);
      db.prepare('DELETE FROM account_snapshots WHERE account_id = ?').run(id);
      json(res, 200, { ok: true });
      return true;
    }
    if (action === 'sync' && req.method === 'POST') {
      json(res, 200, { ok: true, data: await syncTracker(id) });
      return true;
    }
    if (action === 'works' && req.method === 'GET') {
      const tracker = listTrackers().find(item => item.id === id);
      if (!tracker) throw new Error('账号不存在');
      const stale = !tracker.syncedAt || Date.now() - tracker.syncedAt > 24 * 60 * 60 * 1000;
      json(res, 200, { ok: true, data: listTrackerWorks(id), stale, syncedAt: tracker.syncedAt || null });
      return true;
    }
    if (action === 'diagnose' && req.method === 'GET') {
      const tracker = listTrackers().find(item => item.id === id);
      if (!tracker) throw new Error('账号不存在');
      const cached = getLocalData('diagnosis', id);
      if (cached) {
        json(res, 200, { ok: true, data: { report: cached, cached: true } });
        return true;
      }
      json(res, 200, { ok: true, data: { report: null, cached: false, stale: true } });
      return true;
    }
    if (action === 'diagnose' && req.method === 'POST') {
      const tracker = listTrackers().find(item => item.id === id);
      if (!tracker) throw new Error('账号不存在');
      json(res, 200, { ok: true, data: await diagnoseAndStoreTracker(tracker) });
      return true;
    }
    if (action === 'trend' && req.method === 'GET') {
      const tracker = listTrackers().find(item => item.id === id);
      if (!tracker) throw new Error('账号不存在');
      json(res, 200, {
        ok: true,
        data: {
          tracker,
          snapshots: listAccountSnapshots(id, Math.min(Number(url.searchParams.get('limit')) || 30, 90)),
        },
      });
      return true;
    }
  }

  // ==========知识库 KB ==========
  if (url.pathname === '/api/_/kb/config' && req.method === 'GET') {
    const row = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!row) {
      json(res, 200, { ok: true, data: {
        obsidian: { configured: false, sourcePath: '' },
        notion: { configured: false, databaseId: '' },
      } });
      return true;
    }
    json(res, 200, {
      ok: true,
      data: {
        // 兼容旧字段
        sourceType: row.provider || '',
        sourcePath: row.source_path || '',
        notionConfigured: Boolean(row.notion_api_key),
        notionDatabaseId: row.notion_database_id || '',
        // 新结构：两个源独立
        obsidian: {
          configured: Boolean(row.source_path) && fs.existsSync(row.source_path),
          sourcePath: row.source_path || '',
        },
        notion: {
          configured: Boolean(row.notion_api_key),
          databaseId: row.notion_database_id || '',
        },
      },
    });
    return true;
  }
  if (url.pathname === '/api/_/kb/config' && req.method === 'POST') {
    const { data } = await readBody(req);
    const sourceType = String(data.sourceType || 'obsidian');
    const now = Date.now();
    const current = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current') || {};
    if (!['obsidian', 'notion'].includes(sourceType)) {
      json(res, 400, { ok: false, error: '知识库类型无效' }); return true;
    }
    // 两个源独立保存：obsidian 只动 source_path，notion 只动 notion_*
    let newSourcePath = current.source_path || '';
    let encryptedApiKey = current.notion_api_key || '';
    let databaseId = current.notion_database_id || '';
    if (sourceType === 'obsidian') {
      const sourcePath = String(data.sourcePath || '');
      if (sourcePath && (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory())) {
        json(res, 400, { ok: false, error: 'Obsidian 路径不是有效目录' }); return true;
      }
      newSourcePath = sourcePath;
    } else {
      const notionApiKey = String(data.notionApiKey || '');
      const notionDbId = String(data.notionDatabaseId || '');
      if (notionApiKey) encryptedApiKey = encryptKb(notionApiKey);
      if (notionDbId) databaseId = notionDbId;
      if (!encryptedApiKey || !databaseId) {
        json(res, 400, { ok: false, error: 'Notion API Key 和 Database ID 不能为空' }); return true;
      }
    }
    db.prepare(`
      INSERT INTO kb_config (source_type, provider, source_path, notion_api_key, notion_database_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type) DO UPDATE SET
        source_path = excluded.source_path,
        notion_api_key = excluded.notion_api_key,
        notion_database_id = excluded.notion_database_id,
        updated_at = excluded.updated_at
    `).run('current', current.provider || sourceType, newSourcePath, encryptedApiKey, databaseId, current.created_at || now, now);
    // 仅清掉对应源的缓存（不清全部，让另一源保留）
    if (sourceType === 'obsidian') {
      db.prepare("DELETE FROM kb_entries_cache WHERE source_type = 'obsidian'").run();
    } else {
      db.prepare("DELETE FROM kb_entries_cache WHERE source_type = 'notion'").run();
    }
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/_/kb/entries/analyze — 读取文章并对比热榜
  if (url.pathname === '/api/_/kb/entries/analyze' && req.method === 'POST') {
    const { data } = await readBody(req);
    const entryKey = String(data.entryKey || '');
    const force = data.force === true;
    if (!entryKey) { json(res, 400, { ok: false, error: '缺少 entryKey' }); return true; }
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config || !config.provider) { json(res, 404, { ok: false, error: '未配置知识库' }); return true; }
    let entry;
    if (config.provider === 'obsidian') {
      if (!config.source_path || !fs.existsSync(config.source_path)) { json(res, 404, { ok: false, error: 'Vault路径无效' }); return true; }
      try { entry = readEntry(config.source_path, entryKey); } catch (e) { json(res, 404, { ok: false, error: e.message }); return true; }
    } else if (config.provider === 'notion') {
      const apiKey = decryptKb(config.notion_api_key);
      if (!apiKey) { json(res, 404, { ok: false, error: 'Notion未配置' }); return true; }
      try { entry = await getPage(apiKey, entryKey); } catch (e) { json(res, 404, { ok: false, error: e.message }); return true; }
    } else { json(res, 404, { ok: false, error: '未知知识库类型' }); return true; }
    const latestSnapshot = db.prepare('SELECT MAX(completed_at) AS value FROM hot_batches').get()?.value || '';
    const analysisKey = `${config.provider}:${entryKey}`;
    const fingerprint = `${entry.updated_at || 0}:${latestSnapshot}`;
    if (!force) {
      const cached = getLocalData('kb_analysis', analysisKey);
      if (cached?.fingerprint === fingerprint && cached.result) {
        json(res, 200, { ok: true, data: cached.result, cached: true });
        return true;
      }
    }
    const [trends, keywords] = await Promise.all([
      (async () => { try { return getHotTrends(7).themes; } catch { return []; } })(),
      (async () => {
        return hotListPayload('all').data.slice(0, 80);
      })(),
    ]);
    const articleText = `${entry.title}\n标签：${(entry.tags || []).join(', ')}\n\n${entry.content || ''}`.slice(0, 4000);
    const trendsSummary = trends.slice(0, 20).map(t => `[${t.trend}] ${t.name} (${t.reason})`).join('\n') || '（暂无热榜趋势数据）';
    const keywordsList = keywords.slice(0, 60).map(k => k.title || k.key || '').filter(Boolean).join('、') || '（暂无热词数据）';
    const prompt = `你是一位自媒体内容策划专家。给定一篇文章和当前热榜数据，分析这篇文章与热榜的关联度。

## 文章信息
标题：${entry.title}
标签：${(entry.tags || []).join(', ')}
内容预览：
${articleText}

## 近7天热榜趋势 TOP20
${trendsSummary}

## 当前热词 TOP60
${keywordsList}

请以 JSON 格式返回分析结果（不要任何 markdown）：
{
  "topMatches": [
    {
      "trendTitle": "热榜主题标题",
      "relevanceScore": 85,
      "matchReason": "匹配原因",
      "trendDirection": "增长|稳定|冷却",
      "platform": "主要平台"
    }
  ],
  "extractedKeywords": ["文章热词1","文章热词2"],
  "suggestedAngle": "内容切入角度建议（1-2句）",
  "trendOutlook": "趋势判断：增长中/趋于稳定/热度冷却",
  "platformSuggestion": "最适合发布的平台"
}

只返回最相关的3个热榜主题，按关联度从高到低。关联度0-100，只返回60以上的主题。如果没有明显关联，返回空数组。`;
    let analysisResult;
    try {
      analysisResult = await callLlmJson([{ role: 'user', content: prompt }]);
    } catch (e) { json(res, 500, { ok: false, error: 'AI分析失败：' + e.message }); return true; }
    setLocalData(
      'kb_analysis',
      analysisKey,
      { fingerprint, result: analysisResult },
      Date.now() + 24 * 60 * 60 * 1000,
    );
    json(res, 200, { ok: true, data: analysisResult, cached: false });
    return true;
  }

  // /api/_/kb/entries/{id} — GET read, DELETE delete
  const entryRouteMatch = url.pathname.match(/^\/api\/_\/kb\/entries\/([^/]+)$/);
  if (entryRouteMatch && entryRouteMatch[1] !== 'link') {
    const entryKey = decodeURIComponent(entryRouteMatch[1]);
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (req.method === 'GET') {
      if (!config || !config.provider) { json(res, 404, { ok: false, error: '未配置知识库' }); return true; }
      const refresh = url.searchParams.get('refresh') === '1';
      if (!refresh) {
        const cached = getKbEntryFromCache(config.provider, entryKey);
        if (cached) { json(res, 200, { ok: true, data: cached, cached: true }); return true; }
      }
      if (config.provider === 'obsidian') {
        if (!config.source_path || !fs.existsSync(config.source_path)) { json(res, 404, { ok: false, error: 'Vault路径无效' }); return true; }
        try {
          const entry = readEntry(config.source_path, entryKey);
          setKbEntryToCache('obsidian', entry);
          json(res, 200, { ok: true, data: entry });
        } catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      if (config.provider === 'notion') {
        const apiKey = decryptKb(config.notion_api_key);
        try {
          const entry = await getPage(apiKey, entryKey);
          setKbEntryToCache('notion', entry);
          json(res, 200, { ok: true, data: entry });
        } catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      json(res, 404, { ok: false, error: '未知类型' }); return true;
    }
    if (req.method === 'DELETE') {
      if (!config || !config.provider) { json(res, 400, { ok: false, error: '未配置知识库' }); return true; }
      if (config.provider === 'obsidian') {
        try {
          deleteNote(config.source_path, entryKey);
          invalidateKbListCache('obsidian');
          invalidateKbEntryCache('obsidian', entryKey);
          db.prepare(`DELETE FROM local_data WHERE module = 'kb_analysis' AND data_key = ?`).run(`obsidian:${entryKey}`);
          json(res, 200, { ok: true });
        }
        catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      if (config.provider === 'notion') {
        const apiKey = decryptKb(config.notion_api_key);
        try {
          await deletePage(apiKey, entryKey);
          invalidateKbListCache('notion');
          invalidateKbEntryCache('notion', entryKey);
          db.prepare(`DELETE FROM local_data WHERE module = 'kb_analysis' AND data_key = ?`).run(`notion:${entryKey}`);
          json(res, 200, { ok: true });
        }
        catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      json(res, 400, { ok: false, error: '未知类型' }); return true;
    }
    return false;
  }

  // GET /api/_/kb/entries?q=&tag=&folder=&limit=50&offset=0
  if (url.pathname === '/api/_/kb/entries' && req.method === 'GET') {
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config) { json(res, 200, { ok: true, data: [] }); return true; }
    // 优先使用 ?source= 参数；否则用 provider 字段（兼容旧调用）
    const source = String(url.searchParams.get('source') || config.provider || '');
    if (!['obsidian', 'notion'].includes(source)) { json(res, 200, { ok: true, data: [] }); return true; }
    if (source === 'obsidian' && (!config.source_path || !fs.existsSync(config.source_path))) {
      json(res, 200, { ok: true, data: { entries: [], folders: [], tags: [], total: 0 } });
      return true;
    }
    if (source === 'notion' && (!config.notion_api_key || !config.notion_database_id)) {
      json(res, 200, { ok: true, data: { entries: [], folders: [], tags: [], total: 0 } });
      return true;
    }
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    const folder = url.searchParams.get('folder') || '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
    const offset = Number(url.searchParams.get('offset') || 0);
    const refresh = url.searchParams.get('refresh') === '1';

    // 无搜索条件时尝试从缓存读取
    if (!q && !tag && !folder && !refresh) {
      const cached = getKbEntriesFromCache(source, q, tag, folder);
      if (cached) {
        const entries = cached.slice(offset, offset + limit);
        const folders = source === 'obsidian'
          ? listFolders(config.source_path)
          : [...new Set(cached.map(entry => entry.folder).filter(Boolean))].sort();
        const tags = source === 'obsidian'
          ? listAllTags(config.source_path)
          : [...new Set(cached.flatMap(entry => entry.tags || []))].sort();
        json(res, 200, { ok: true, data: { entries, folders, tags, total: cached.length, cached: true } });
        return true;
      }
    }

    if (source === 'obsidian') {
      const vaultPath = config.source_path;
      if (!vaultPath || !fs.existsSync(vaultPath)) { json(res, 200, { ok: true, data: [] }); return true; }
      const allEntries = scanVault(vaultPath, {});
      const matched = allEntries.filter(e => {
        if (q) {
          const lower = q.toLowerCase();
          if (!e.title.toLowerCase().includes(lower) && !(e.content_preview || '').toLowerCase().includes(lower) && !e.tags.some(t => t.toLowerCase().includes(lower))) return false;
        }
        if (tag && !e.tags.some(t => t.toLowerCase() === tag.toLowerCase())) return false;
        if (folder && e.folder !== folder) return false;
        return true;
      });
      const filtered = matched.slice(offset, offset + limit);
      const folders = listFolders(vaultPath);
      const tags = listAllTags(vaultPath);
      // 更新列表缓存
      if (!q && !tag && !folder) setKbEntriesToCache('obsidian', allEntries);
      json(res, 200, { ok: true, data: { entries: filtered, folders, tags, total: matched.length } });
      return true;
    }
    if (config.provider === 'notion') {
      const apiKey = decryptKb(config.notion_api_key);
      if (!apiKey) { json(res, 200, { ok: true, data: [] }); return true; }
      const allEntries = await searchPages(apiKey, config.notion_database_id, { query: q, tag, folder });
      if (!q && !tag && !folder) setKbEntriesToCache('notion', allEntries);
      const entries = allEntries.slice(offset, offset + limit);
      const folders = [...new Set(allEntries.map(entry => entry.folder).filter(Boolean))].sort();
      const tags = [...new Set(allEntries.flatMap(entry => entry.tags || []))].sort();
      json(res, 200, { ok: true, data: { entries, folders, tags, total: allEntries.length } });
      return true;
    }
    json(res, 200, { ok: true, data: [] });
    return true;
  }

  // POST /api/_/kb/entries  新建条目
  if (url.pathname === '/api/_/kb/entries' && req.method === 'POST') {
    const { data } = await readBody(req);
    const title = String(data.title || '').trim();
    if (!title) { json(res, 400, { ok: false, error: '标题不能为空' }); return true; }
    const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [];
    const folder = String(data.folder || '');
    const content = String(data.content || '');
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config || !config.provider) { json(res, 400, { ok: false, error: '未配置知识库' }); return true; }
    if (config.provider === 'obsidian') {
      if (!config.source_path || !fs.existsSync(config.source_path)) { json(res, 400, { ok: false, error: 'Vault 路径无效' }); return true; }
      try {
        const entryKey = writeNote(config.source_path, folder, title, tags, content);
        const entry = readEntry(config.source_path, entryKey);
        invalidateKbListCache('obsidian');
        setKbEntryToCache('obsidian', entry);
        json(res, 200, { ok: true, data: entry });
      } catch (e) { json(res, 500, { ok: false, error: e.message }); }
      return true;
    }
    if (config.provider === 'notion') {
      const apiKey = decryptKb(config.notion_api_key);
      const dbId = config.notion_database_id;
      if (!apiKey || !dbId) { json(res, 400, { ok: false, error: 'Notion 未配置' }); return true; }
      try {
        const entryKey = await createPage(apiKey, dbId, title, tags, folder, content);
        const entry = await getPage(apiKey, entryKey);
        invalidateKbListCache('notion');
        setKbEntryToCache('notion', entry);
        json(res, 200, { ok: true, data: entry });
      } catch (e) { json(res, 500, { ok: false, error: e.message }); }
      return true;
    }
    json(res, 400, { ok: false, error: '未知类型' });
    return true;
  }

  // POST /api/_/kb/entries/link关联到选题
  if (url.pathname === '/api/_/kb/entries/link' && req.method === 'POST') {
    const { data } = await readBody(req);
    const inspirationId = String(data.inspirationId || '');
    const entryKey = String(data.entryKey || '');
    const sourceType = String(data.sourceType || 'obsidian');
    if (!inspirationId || !entryKey) { json(res, 400, { ok: false, error: '缺少参数' }); return true; }
    const inspiration = db.prepare('SELECT id FROM inspirations WHERE id = ?').get(inspirationId);
    if (!inspiration) { json(res, 404, { ok: false, error: '选题不存在' }); return true; }
    const config = db.prepare('SELECT provider FROM kb_config WHERE source_type = ?').get('current');
    if (!config || config.provider !== sourceType) {
      json(res, 400, { ok: false, error: '知识库来源与当前配置不一致' }); return true;
    }
    const kbLink = JSON.stringify({ source_type: sourceType, entry_key: entryKey });
    db.prepare('UPDATE inspirations SET kb_link = ? WHERE id = ?').run(kbLink, inspirationId);
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/_/kb/export
  if (url.pathname === '/api/_/kb/export' && req.method === 'GET') {
    const format = url.searchParams.get('format') || 'json';
    const ids = url.searchParams.getAll('id');
    if (!ids.length && url.searchParams.get('ids')) ids.push(...url.searchParams.get('ids').split(','));
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config || !config.provider) { json(res, 400, { ok: false, error: '未配置知识库' }); return true; }
    const results = [];
    if (config.provider === 'obsidian') {
      for (const entryKey of ids) {
        try { results.push(readEntry(config.source_path, entryKey)); } catch {}
      }
    } else {
      const apiKey = decryptKb(config.notion_api_key);
      for (const entryKey of ids) {
        try { results.push(await getPage(apiKey, entryKey)); } catch {}
      }
    }
    if (format === 'md') {
      const md = results.map(e => `# ${e.title}\n\nTags: ${e.tags.join(', ')}\n\n${e.content}`).join('\n\n---\n\n');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(md);
      return true;
    }
    json(res, 200, { ok: true, data: results });
    return true;
  }

  // ========== WeRss 接入源（we-mp-rss） ==========
  // GET /api/_/wersss/config
  if (url.pathname === '/api/_/wersss/config' && req.method === 'GET') {
    const row = getWersssConfigRow();
    if (!row) { json(res, 200, { ok: true, data: { configured: false, enabled: false } }); return true; }
    json(res, 200, {
      ok: true,
      data: {
        configured: true,
        enabled: Boolean(row.enabled),
        baseUrl: row.base_url,
        username: row.username,
        hasToken: Boolean(row.token),
        tokenExpiresAt: row.token_expires_at,
        updatedAt: row.updated_at,
      },
    });
    return true;
  }
  // POST /api/_/wersss/config
  if (url.pathname === '/api/_/wersss/config' && req.method === 'POST') {
    const { data } = await readBody(req);
    const baseUrl = String(data.baseUrl || '').trim().replace(/\/$/, '');
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const enabled = data.enabled !== false;
    if (!baseUrl || !username) { json(res, 400, { ok: false, error: 'baseUrl 和 username 必填' }); return true; }
    if (!password) {
      const existing = getWersssConfigRow();
      if (!existing) { json(res, 400, { ok: false, error: '首次配置必须填写 password' }); return true; }
      db.prepare(`UPDATE wersss_config SET base_url = ?, username = ?, enabled = ?, updated_at = ? WHERE id = 1`)
        .run(baseUrl, username, enabled ? 1 : 0, Date.now());
      json(res, 200, { ok: true, data: { saved: true, tested: false } });
      return true;
    }
    let loginResult;
    try { loginResult = await wersss.login(baseUrl, username, password); }
    catch (e) { json(res, 400, { ok: false, error: `连接测试失败：${e.message}` }); return true; }
    if (!loginResult?.access_token) { json(res, 400, { ok: false, error: 'we-mp-rss 未返回 token' }); return true; }
    const expiresIn = loginResult.expires_in ? Number(loginResult.expires_in) * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = Date.now() + expiresIn;
    const enc = encryptKb(password);
    db.prepare(`
      INSERT INTO wersss_config (id, base_url, username, password_enc, token, token_expires_at, enabled, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        base_url = excluded.base_url,
        username = excluded.username,
        password_enc = excluded.password_enc,
        token = excluded.token,
        token_expires_at = excluded.token_expires_at,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(baseUrl, username, enc, loginResult.access_token, expiresAt, enabled ? 1 : 0, Date.now());
    json(res, 200, { ok: true, data: { saved: true, tested: true, tokenExpiresAt: expiresAt } });
    return true;
  }
  // GET /api/_/wersss/subscriptions
  if (url.pathname === '/api/_/wersss/subscriptions' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM wersss_subscriptions ORDER BY added_at DESC').all();
    json(res, 200, { ok: true, data: rows.map(r => ({
      mpId: r.mp_id, mpName: r.mp_name, mpAlias: r.mp_alias, avatar: r.avatar,
      lastSyncedAt: r.last_synced_at, enabled: Boolean(r.enabled), addedAt: r.added_at,
    })) });
    return true;
  }
  // POST /api/_/wersss/subscriptions
  if (url.pathname === '/api/_/wersss/subscriptions' && req.method === 'POST') {
    const { data } = await readBody(req);
    const mpId = String(data.mpId || '').trim();
    const mpName = String(data.mpName || '').trim();
    if (!mpId || !mpName) { json(res, 400, { ok: false, error: 'mpId 和 mpName 必填' }); return true; }
    db.prepare(`
      INSERT INTO wersss_subscriptions (mp_id, mp_name, mp_alias, avatar, enabled, added_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(mp_id) DO UPDATE SET mp_name = excluded.mp_name, mp_alias = excluded.mp_alias, avatar = excluded.avatar
    `).run(mpId, mpName, String(data.mpAlias || ''), String(data.avatar || ''), Date.now());
    json(res, 200, { ok: true });
    return true;
  }
  // DELETE /api/_/wersss/subscriptions/{mp_id}
  const wersssSubMatch = url.pathname.match(/^\/api\/_\/wersss\/subscriptions\/([^/]+)$/);
  if (wersssSubMatch && req.method === 'DELETE') {
    const mpId = decodeURIComponent(wersssSubMatch[1]);
    db.prepare('DELETE FROM wersss_subscriptions WHERE mp_id = ?').run(mpId);
    db.prepare('DELETE FROM wersss_articles WHERE mp_id = ?').run(mpId);
    json(res, 200, { ok: true });
    return true;
  }
  // GET /api/_/wersss/search?kw=
  if (url.pathname === '/api/_/wersss/search' && req.method === 'GET') {
    const kw = String(url.searchParams.get('kw') || '').trim();
    if (!kw) { json(res, 400, { ok: false, error: 'kw 必填' }); return true; }
    try {
      const { token, config } = await getValidWersssToken();
      const result = await wersss.searchMp(config.baseUrl, token, kw, { limit: 20 });
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // GET /api/_/wersss/subscriptions/available —— 列出 we-mp-rss 已订阅的公众号
  if (url.pathname === '/api/_/wersss/subscriptions/available' && req.method === 'GET') {
    try {
      const { token, config } = await getValidWersssToken();
      const result = await wersss.listSubscriptions(config.baseUrl, token, { limit: 100 });
      const subscribedHere = new Set(db.prepare('SELECT mp_id FROM wersss_subscriptions').all().map(r => r.mp_id));
      const data = result.map(mp => ({ ...mp, alreadySubscribed: subscribedHere.has(mp.mpId) }));
      json(res, 200, { ok: true, data });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // GET /api/_/wersss/articles?mp_id=&limit=&offset=
  if (url.pathname === '/api/_/wersss/articles' && req.method === 'GET') {
    const mpId = String(url.searchParams.get('mp_id') || '').trim();
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const rows = mpId
      ? db.prepare(`SELECT a.id, a.mp_id, s.mp_name, a.title, a.summary, a.url, a.cover, a.publish_time, a.synced_at
                    FROM wersss_articles a LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
                    WHERE a.mp_id = ? ORDER BY a.publish_time DESC, a.synced_at DESC LIMIT ? OFFSET ?`).all(mpId, limit, offset)
      : db.prepare(`SELECT a.id, a.mp_id, s.mp_name, a.title, a.summary, a.url, a.cover, a.publish_time, a.synced_at
                    FROM wersss_articles a LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
                    ORDER BY a.publish_time DESC, a.synced_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, mpId: r.mp_id, mpName: r.mp_name, title: r.title, summary: r.summary,
      url: r.url, cover: r.cover, publishTime: r.publish_time, syncedAt: r.synced_at,
    })) });
    return true;
  }
  // GET /api/_/wersss/articles/{id}（正文按需抓取并缓存）
  const wersssArtMatch = url.pathname.match(/^\/api\/_\/wersss\/articles\/([^/]+)$/);
  if (wersssArtMatch && req.method === 'GET') {
    const id = decodeURIComponent(wersssArtMatch[1]);
    const row = db.prepare(`
      SELECT a.*, s.mp_name FROM wersss_articles a
      LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE a.id = ?
    `).get(id);
    if (!row) { json(res, 404, { ok: false, error: '文章不存在，请先同步' }); return true; }
    // 本地 content 为空时，从 we-mp-rss 拉取并缓存
    if (!row.content || row.content.length < 100) {
      try {
        const { token, config } = await getValidWersssToken();
        const fresh = await wersss.getArticle(config.baseUrl, token, id);
        if (fresh && fresh.content) {
          db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?').run(fresh.content, id);
          row.content = fresh.content;
          if (fresh.title && !row.title) row.title = fresh.title;
        }
      } catch (e) {
        // 抓取失败时返回已有的 summary，不阻塞查看
        console.warn(`[wersss] 抓正文失败 ${id}:`, e.message);
      }
    }
    json(res, 200, { ok: true, data: {
      id: row.id, mpId: row.mp_id, mpName: row.mp_name, title: row.title, summary: row.summary,
      content: row.content, url: row.url, cover: row.cover,
      publishTime: row.publish_time, syncedAt: row.synced_at,
    } });
    return true;
  }
  // POST /api/_/wersss/articles/{id}/prefetch —— 强制重新抓正文
  const wersssPrefetchMatch = url.pathname.match(/^\/api\/_\/wersss\/articles\/([^/]+)\/prefetch$/);
  if (wersssPrefetchMatch && req.method === 'POST') {
    const id = decodeURIComponent(wersssPrefetchMatch[1]);
    const row = db.prepare('SELECT mp_id FROM wersss_articles WHERE id = ?').get(id);
    if (!row) { json(res, 404, { ok: false, error: '文章不存在' }); return true; }
    try {
      const { token, config } = await getValidWersssToken();
      const fresh = await wersss.getArticle(config.baseUrl, token, id);
      if (!fresh?.content) { json(res, 500, { ok: false, error: 'we-mp-rss 未返回正文' }); return true; }
      db.prepare('UPDATE wersss_articles SET content = ? WHERE id = ?').run(fresh.content, id);
      json(res, 200, { ok: true, data: { length: fresh.content.length } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // POST /api/_/wersss/sync
  if (url.pathname === '/api/_/wersss/sync' && req.method === 'POST') {
    try {
      const result = await syncWersssArticles();
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // POST /api/_/wersss/prefetch —— 批量预抓取所有文章正文
  if (url.pathname === '/api/_/wersss/prefetch' && req.method === 'POST') {
    try {
      const result = await prefetchWersssContent();
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // GET /api/_/wersss/search?q=&mp_id=
  if (url.pathname === '/api/_/wersss/search-local' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    const mpId = String(url.searchParams.get('mp_id') || '').trim();
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 30);
    if (!q) { json(res, 200, { ok: true, data: [] }); return true; }
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT a.id, a.mp_id, s.mp_name, a.title, a.summary, a.url, a.cover, a.publish_time, a.synced_at
      FROM wersss_articles a LEFT JOIN wersss_subscriptions s ON s.mp_id = a.mp_id
      WHERE (a.title LIKE ? OR a.summary LIKE ? OR a.content LIKE ?)
        ${mpId ? 'AND a.mp_id = ?' : ''}
      ORDER BY a.publish_time DESC LIMIT ?
    `).all(...(mpId ? [like, like, like, mpId, limit] : [like, like, like, limit]));
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, mpId: r.mp_id, mpName: r.mp_name, title: r.title, summary: r.summary,
      url: r.url, cover: r.cover, publishTime: r.publish_time, syncedAt: r.synced_at,
    })) });
    return true;
  }

  // ========== 我的账号 + 风格档案 ==========
  // GET /api/_/my-accounts
  if (url.pathname === '/api/_/my-accounts' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listMyAccounts() });
    return true;
  }
  // POST /api/_/my-accounts（新建/更新）
  if (url.pathname === '/api/_/my-accounts' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data.name || !data.plat) { json(res, 400, { ok: false, error: 'name 和 plat 必填' }); return true; }
    const saved = saveMyAccount(data);
    json(res, 200, { ok: true, data: saved });
    return true;
  }
  // DELETE /api/_/my-accounts/{id}
  const myAccDelMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)$/);
  if (myAccDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(myAccDelMatch[1]);
    db.prepare('DELETE FROM my_accounts WHERE id = ?').run(id);
    json(res, 200, { ok: true });
    return true;
  }
  // POST /api/_/my-accounts/{id}/extract-tracks
  const extractTracksMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/extract-tracks$/);
  if (extractTracksMatch && req.method === 'POST') {
    const id = decodeURIComponent(extractTracksMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const tracks = await extractAccountTracks(account);
      const saved = saveMyAccount({ ...account, tracks });
      json(res, 200, { ok: true, data: { tracks, account: saved } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // POST /api/_/my-accounts/{id}/extract-style
  const extractStyleMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/extract-style$/);
  if (extractStyleMatch && req.method === 'POST') {
    const id = decodeURIComponent(extractStyleMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const profile = await extractAccountStyleProfile(account);
      const saved = saveMyAccount({ ...account, styleProfile: profile, styleUpdatedAt: Date.now() });
      json(res, 200, { ok: true, data: { profile, account: saved } });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // POST /api/_/my-accounts/{id}/preset-inspirations
  const presetInspMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/preset-inspirations$/);
  if (presetInspMatch && req.method === 'POST') {
    const id = decodeURIComponent(presetInspMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const ideas = await generatePresetInspirations(account);
      json(res, 200, { ok: true, data: ideas });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // GET /api/_/my-accounts/{id}/suggest-configs  LLM 生成自动选题配置建议
  const suggestCfgMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/suggest-configs$/);
  if (suggestCfgMatch && req.method === 'GET') {
    const id = decodeURIComponent(suggestCfgMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    try {
      const suggestions = await suggestInspirationConfigs(account);
      json(res, 200, { ok: true, data: suggestions });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  // POST /api/_/my-accounts/{id}/create-config  基于建议创建真实配置
  const createCfgMatch = url.pathname.match(/^\/api\/_\/my-accounts\/([^/]+)\/create-config$/);
  if (createCfgMatch && req.method === 'POST') {
    const id = decodeURIComponent(createCfgMatch[1]);
    const account = getMyAccount(id);
    if (!account) { json(res, 404, { ok: false, error: '账号不存在' }); return true; }
    const { data } = await readBody(req);
    try {
      const config = createInspirationConfigFromSuggestion(account, data.suggestion || data);
      json(res, 200, { ok: true, data: config });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  // ========== 创作提示词模板 ==========
  // GET /api/_/style-templates
  if (url.pathname === '/api/_/style-templates' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM style_templates ORDER BY is_default DESC, created_at DESC').all();
    json(res, 200, { ok: true, data: rows.map(r => ({
      id: r.id, name: r.name, platform: r.platform, template: r.template,
      isDefault: Boolean(r.is_default), createdAt: r.created_at, updatedAt: r.updated_at,
    })) });
    return true;
  }
  // POST /api/_/style-templates
  if (url.pathname === '/api/_/style-templates' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data.name || !data.template) { json(res, 400, { ok: false, error: 'name 和 template 必填' }); return true; }
    const id = data.id || `tpl:${Date.now()}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO style_templates (id, name, platform, template, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, platform = excluded.platform, template = excluded.template,
        is_default = excluded.is_default, updated_at = excluded.updated_at
    `).run(id, String(data.name), String(data.platform || 'all'), String(data.template), data.isDefault ? 1 : 0, now, now);
    json(res, 200, { ok: true, data: { id } });
    return true;
  }
  // DELETE /api/_/style-templates/{id}
  const styleTplDelMatch = url.pathname.match(/^\/api\/_\/style-templates\/([^/]+)$/);
  if (styleTplDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(styleTplDelMatch[1]);
    db.prepare('DELETE FROM style_templates WHERE id = ?').run(id);
    json(res, 200, { ok: true });
    return true;
  }

  // ========== CRON ==========
  if (url.pathname === '/api/_/crons' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listCronJobs() });
    return true;
  }
  if (url.pathname === '/api/_/crons' && req.method === 'POST') {
    const { data } = await readBody(req);
    const id = String(data.id || '').trim();
    const name = String(data.name || '').trim();
    const cronExpr = String(data.cronExpr || '').trim();
    const enabled = Boolean(data.enabled);
    const taskType = String(data.taskType || 'custom');
    const taskConfig = data.taskConfig || null;
    const notifyOnFailure = data.notifyOnFailure !== false;
    const notifyOnSuccess = Boolean(data.notifyOnSuccess);
    if (!id || !name || !cronExpr) { json(res, 400, { ok: false, error: 'id、名称和 Cron表达式不能为空' }); return true; }
    if (isInspirationCronId(id)) { json(res, 400, { ok: false, error: '自动选题调度由灵感库页面管理，不能在此创建' }); return true; }
    if (!parseCronExpr(cronExpr)) { json(res, 400, { ok: false, error: 'Cron 表达式格式无效' }); return true; }
    if (!['hot-realtime', 'hot-platform', 'hot-trend-analysis', 'inspiration-generate', 'daily-hot-report', 'tracker-refresh', 'cache-clean', 'usage-clean', 'wersss-sync'].includes(taskType)) {
      json(res, 400, { ok: false, error: '不支持的任务类型' }); return true;
    }
    try {
      const jobs = await saveCronJob(id, name, cronExpr, enabled, taskType, taskConfig, { notifyOnFailure, notifyOnSuccess });
      json(res, 200, { ok: true, data: jobs });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  const cronDelMatch = url.pathname.match(/^\/api\/_\/crons\/([^/]+)$/);
  if (cronDelMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(cronDelMatch[1]);
    if (isInspirationCronId(id)) { json(res, 400, { ok: false, error: '自动选题调度由灵感库页面管理' }); return true; }
    if ([
      'hot-realtime', 'hot-daily-dy', 'hot-daily-xhs', 'hot-daily-gzh',
      'hot-daily-ai-gzh', 'hot-daily-ai-bili', 'hot-daily-ai-xhs',
      'hot-trend-analysis', 'hot-daily-report', 'cache-clean', 'usage-clean', 'wersss-sync',
    ].includes(id)) { json(res, 400, { ok: false, error: '内置任务不能删除' }); return true; }
    try { json(res, 200, { ok: true, data: deleteCronJob(id) }); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }
  if (url.pathname === '/api/_/crons/run' && req.method === 'POST') {
    const { data } = await readBody(req);
    const id = String(data.id || '');
    const job = db.prepare('SELECT * FROM crontab WHERE id = ?').get(id);
    if (!job) { json(res, 404, { ok: false, error: '任务不存在' }); return true; }
    try {
      await runCronJob(id, job.task_type, parseJson(job.task_config) || {});
      db.prepare('UPDATE crontab SET last_run = ? WHERE id = ?').run(Date.now(), id);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return true;
  }

  return false;
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(__dirname, relative);
  if (filePath !== __dirname && !filePath.startsWith(`${__dirname}${path.sep}`)) {
    json(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    const publicApi = url.pathname === '/api/_/login' || url.pathname === '/api/_/status';
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

function parseCronExpr(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const cron = {
    min: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4],
  };
  const specs = [
    [cron.min, 0, 59],
    [cron.hour, 0, 23],
    [cron.dom, 1, 31],
    [cron.month, 1, 12],
    [cron.dow, 0, 7],
  ];
  return specs.every(([field, min, max]) => validateCronField(field, min, max)) ? cron : null;
}

function validateCronField(field, min, max) {
  return field.split(',').every(part => {
    const pieces = part.split('/');
    if (pieces.length > 2) return false;
    const [base, rawStep] = pieces;
    if (rawStep !== undefined && (!/^\d+$/.test(rawStep) || Number(rawStep) < 1)) return false;
    if (base === '*') return true;
    if (/^\d+$/.test(base)) {
      const value = Number(base);
      return value >= min && value <= max;
    }
    const range = base.match(/^(\d+)-(\d+)$/);
    if (!range) return false;
    const start = Number(range[1]);
    const end = Number(range[2]);
    return start >= min && end <= max && start <= end;
  });
}

function nextCronTime(cron, from = new Date()) {
  const c = parseCronExpr(cron);
  if (!c) return null;
  let d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    const domMatches = matchesCronField(d.getDate(), c.dom);
    const dowMatches = matchesCronField(d.getDay(), c.dow, true);
    const dayMatches = c.dom !== '*' && c.dow !== '*' ? domMatches || dowMatches : domMatches && dowMatches;
    if (matchesCronField(d.getMinutes(), c.min) &&
        matchesCronField(d.getHours(), c.hour) &&
        dayMatches &&
        matchesCronField(d.getMonth() + 1, c.month)) {
      return d;
    }
  }
  return null;
}

function matchesCronField(val, field, sundaySeven = false) {
  const values = sundaySeven && val === 0 ? [0, 7] : [val];
  return field.split(',').some(part => {
    const [base, rawStep] = part.split('/');
    const step = rawStep ? Number(rawStep) : 1;
    if (base === '*') return values.some(value => value % step === 0);
    if (base.includes('-')) {
      const [start, end] = base.split('-').map(Number);
      return values.some(value => value >= start && value <= end && (value - start) % step === 0);
    }
    return values.includes(Number(base));
  });
}

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
        broadcastNotification(
          `定时任务执行成功：${cronName}`,
          `任务「${cronName}」于 ${new Date().toLocaleString('zh-CN')} 执行完成。${summary}`
        ).catch(err => console.warn('[notify] cron 成功通知异常:', err.message));
      }
    } catch (error) {
      console.error(`[cron] ${id} 执行失败:`, error.message);
      if (notifyFailure) {
        broadcastNotification(
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
  return db.prepare('SELECT id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, last_run, created_at FROM crontab ORDER BY created_at ASC').all()
    .filter(row => !isInspirationCronId(row.id))
    .map(row => ({
      id: row.id, name: row.name, cronExpr: row.cron_expr, enabled: Boolean(row.enabled),
      taskType: row.task_type, taskConfig: row.task_config ? JSON.parse(row.task_config) : null,
      notifyOnFailure: row.notify_on_failure !== 0,
      notifyOnSuccess: Boolean(row.notify_on_success),
      lastRun: row.last_run, createdAt: row.created_at,
    }));
}

async function saveCronJob(id, name, cronExpr, enabled, taskType, taskConfig, opts = {}) {
  const now = Date.now();
  const config = taskConfig ? JSON.stringify(taskConfig) : null;
  const notifyFailure = opts.notifyOnFailure === false ? 0 : 1;
  const notifySuccess = opts.notifyOnSuccess ? 1 : 0;
  db.prepare(`INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cron_expr=excluded.cron_expr, enabled=excluded.enabled,
      task_type=excluded.task_type, task_config=excluded.task_config,
      notify_on_failure=excluded.notify_on_failure, notify_on_success=excluded.notify_on_success`
  ).run(id, name, cronExpr, enabled ?1 : 0, taskType, config, notifyFailure, notifySuccess, now);
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
  nextCronTime,
  workPublishAt,
  workContentKey,
  normalizeExternalInspirationItems,
  groupInspirationEvidence,
  selectDiverseEvidence,
  normalizeInspirationTitle,
  inspirationTitleSimilarity,
  dedupeInspirationIdeas,
  isCacheableRedfoxResponse,
  inspirationSearchTerms,
  inspirationSearchPlan,
  inspirationApiBudget,
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
