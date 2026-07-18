// SQLite 单例：Database 实例 + schema + ensureColumn 迁移
// 其他模块 require('./lib/db') 取 { db, ensureColumn, DATA_ROOT, DB_PATH }
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch {}

const DB_PATH = process.env.CACHE_DB_PATH
  ? path.resolve(process.env.CACHE_DB_PATH)
  : path.join(DATA_ROOT, 'cache.db');

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
    sort_order INTEGER NOT NULL DEFAULT 0,
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

  -- 小红书 MCP 接入（xpzouying/xiaohongshu-mcp）
  -- base_url: HTTP API 入口（如 http://localhost:18060）
  -- mcp_url:  MCP 协议入口（如 http://localhost:18060/mcp），给 Agent CLI 用
  -- login_status: unknown / logged_in / logged_out（health check 后更新）
  CREATE TABLE IF NOT EXISTS xhs_mcp_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    mcp_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    login_status TEXT NOT NULL DEFAULT 'unknown',
    health_checked_at INTEGER,
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

  CREATE TABLE IF NOT EXISTS skill_classifications (
    slug TEXT PRIMARY KEY,
    llm_category TEXT NOT NULL,
    original_category TEXT,
    analyzed_at INTEGER NOT NULL,
    skill_signature TEXT
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
ensureColumn('crontab', 'notify_on_failure', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('crontab', 'notify_on_success', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('crontab', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');

db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_account_works_publish
  ON account_works(account_id, publish_at DESC, synced_at DESC);
  CREATE INDEX IF NOT EXISTS idx_account_works_content
  ON account_works(account_id, content_key);
`);

module.exports = { db, ensureColumn, DATA_ROOT, DB_PATH };
