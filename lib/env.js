// .env 文件读写 + 服务重启逻辑
// 不持有运行时状态，纯文件 + 进程操作
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const EDITABLE_ENV_KEYS = [
  'REDFOX_API_KEY', 'REDFOX_WEB_COOKIE', 'REDFOX_HOST', 'REDFOX_APPLY_URL',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_FALLBACK_MODEL',
  'KB_ENCRYPTION_KEY', 'GITHUB_API_TOKEN', 'ENABLE_SCHEDULER', 'USER_TIMEZONE',
  'CODEX_BIN', 'CLAUDE_BIN', 'KIMI_BIN', 'OPENCLAW_BIN', 'HERMES_BIN',
  'MP_APP_ID', 'MP_APP_SECRET', 'MP_ACCOUNT_NAME', 'CHROME_PATH',
];

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

function readEnvValues(envFile) {
  const values = {};
  if (!fs.existsSync(envFile)) return values;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function publicEnvConfig(envFile) {
  const values = readEnvValues(envFile);
  return Object.fromEntries(EDITABLE_ENV_KEYS.map(key => [key, {
    configured: Boolean(values[key]),
    value: /KEY|PASSWORD|COOKIE|TOKEN|SECRET/.test(key) ? '' : (values[key] || ''),
    secret: /KEY|PASSWORD|COOKIE|TOKEN|SECRET/.test(key),
  }]));
}

function updateEnvConfig(envFile, input) {
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
  const updates = new Map();
  for (const key of EDITABLE_ENV_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = String(input[key] ?? '').trim();
    // 空值一律 skip：保留 .env 已有值，避免前端空 input 误清空
    if (!value) continue;
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
  fs.writeFileSync(envFile, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  // 同步到 process.env，让运行中的服务立即生效（无需重启）
  for (const [key, value] of updates) {
    process.env[key] = value;
  }
  return publicEnvConfig(envFile);
}

function restartCurrentService() {
  setTimeout(() => {
    if (process.env.FURNACE_RESTART_CMD) {
      const [cmd, ...args] = process.env.FURNACE_RESTART_CMD.split(/\s+/);
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    // Docker 容器：直接 exit，Docker restart 策略自动拉起
    const isDocker = fs.existsSync('/.dockerenv');
    if (isDocker) {
      console.log('[restart] Docker 容器内重启：进程退出，Docker restart 策略自动拉起');
      process.exit(0);
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
    console.warn('[restart] 未检测到 systemd / Docker，进程将退出。请用外层管理器（pm2 / npm start / nohup）重启。');
    process.exit(0);
  }, 500);
}

module.exports = {
  EDITABLE_ENV_KEYS,
  loadEnvFile,
  readEnvValues,
  publicEnvConfig,
  updateEnvConfig,
  restartCurrentService,
};
