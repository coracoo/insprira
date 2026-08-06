// 进程执行 + 可执行文件查找（扩展 PATH 覆盖 npm/homebrew/volta 等）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // 裸命令名先解析为绝对路径（覆盖 npm/volta 等扩展 PATH），找不到立即报错，
    // 避免 spawn 时 PATH 查找结果不确定，也让报错信息更可读
    if (!path.isAbsolute(command)) {
      const resolved = resolveExecutable(command);
      if (!resolved) return reject(new Error(`未找到可执行文件：${path.basename(command)}`));
      command = resolved;
    }
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

module.exports = {
  EXTRA_BIN_DIRS,
  EXTENDED_PATH,
  runProcess,
  resolveExecutable,
  locateExecutable,
  findNestedString,
};
