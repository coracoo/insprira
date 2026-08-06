// 公众号 IP 白名单自动配置：puppeteer-core + 系统 Chrome 驱动公众平台控制台
// 思路移植自 luashiping/weixin-mp-api-ip-whitelist（MIT）：追加合并不覆盖、管理员扫码核验、出口 IP 自动发现
// 与上游 skill 的差异：不依赖 OpenCLI，浏览器由 insprira 自驱动；二维码截图经 Web UI 回传，手机扫码即可
// 注意：家宽/动态 IP 场景，每次出口 IP 变更需重新扫码一次（微信强制管理员核验，无法跳过）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_ROOT } = require('./db');

const CONSOLE_URL = (appId) => `https://developers.weixin.qq.com/console/product/mp/${appId}?tab1=basicInfo&tab2=dev`;
const JOB_TTL_MS = 10 * 60 * 1000;      // 终态任务保留 10 分钟供前端查询
const JOB_TIMEOUT_MS = 5 * 60 * 1000;   // 单次任务最长 5 分钟（含两次扫码）
const IP_SOURCES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://4.ipw.cn'];
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome', '/snap/bin/chromium',
];
const PROFILE_DIR = path.join(DATA_ROOT, 'mp-console-profile'); // 持久登录态，减少重复扫码

function findChrome() {
  const fromEnv = (process.env.CHROME_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

// 探测本机出口公网 IPv4（多源容灾）；不可猜 IP
async function detectOutboundIp(fetchImpl = fetch) {
  for (const src of IP_SOURCES) {
    try {
      const res = await fetchImpl(src);
      const text = await res.text();
      const m = text.match(/\b(\d{1,3}\.){3}\d{1,3}\b/);
      if (m) return m[0];
    } catch { /* 换下一个源 */ }
  }
  throw new Error('出口 IP 探测失败（网络受限？），请手动提供 IP');
}

// 白名单合并：每行一个 IP/CIDR，追加去重不覆盖（纯函数）
function mergeWhitelistEntries(oldValue, addEntries) {
  const norm = (v) => String(v || '').split(/[\n,;，；\s]+/).map(s => s.trim()).filter(Boolean);
  return [...new Set([...norm(oldValue), ...norm(addEntries || [])])].join('\n');
}

// ============ 浏览器内执行的自包含函数（puppeteer evaluate 序列化，不能引用闭包）============

// 页面状态探针：是否已进入目标 AppID 控制台 / 是否出现成功提示 / 是否有管理员确认弹窗
function probeConsolePage(expectedAppId) {
  const bodyText = document.body ? document.body.innerText : '';
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const dialogs = [...document.querySelectorAll('[class*=dialog], [class*=modal], [class*=Dialog], [class*=Modal]')]
    .filter(visible);
  const confirmModal = dialogs.some(d => /扫码|管理员|身份核验|验证/.test(d.innerText || ''));
  return {
    appIdVisible: Boolean(expectedAppId && bodyText.includes(expectedAppId)),
    saved: /设置成功|修改成功|保存成功/.test(bodyText),
    confirmModal,
  };
}

// JS Fast Path（移植自上游 skill）：定位白名单编辑器 → 读出旧值 → 合并 → 写回 → 提交
async function whitelistFastPath(expectedAppId, targetEntries) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node && (node.innerText || node.textContent || node.value) || '').trim();
  const visible = (node) => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const normList = (value) => String(value || '')
    .split(/[\n,;，；\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const uniq = (items) => Array.from(new Set(items));
  const click = (node) => {
    node.scrollIntoView({ block: 'center', inline: 'center' });
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (expectedAppId && !document.body.innerText.includes(expectedAppId)) {
    return { ok: false, reason: 'appid_mismatch_or_not_visible', expectedAppId };
  }
  const labels = ['IP白名单', 'IP 白名单', '服务器IP', '服务器 IP', '接口权限'];
  const buttons = [...document.querySelectorAll('button, a, [role=button], .weui-desktop-btn')].filter(visible);
  const editButton = buttons.find((btn) => {
    const btnText = text(btn);
    if (!/(修改|配置|设置|编辑|查看|详情)/.test(btnText)) return false;
    const scope = btn.closest('tr, li, section, .weui-desktop-form__item, .weui-desktop-panel, .weui-desktop-card') || btn.parentElement;
    return labels.some((label) => text(scope).includes(label));
  });
  if (editButton) {
    click(editButton);
    await sleep(800);
  }
  const fields = [...document.querySelectorAll('textarea, input[type=text], input:not([type])')].filter(visible);
  const field = fields.find((el) => {
    const current = el.value || '';
    const scope = el.closest('.weui-desktop-dialog, .weui-desktop-form__item, form, section, tr, li') || el.parentElement;
    return labels.some((label) => text(scope).includes(label)) || /^\s*(\d{1,3}\.){3}\d{1,3}/.test(current);
  }) || fields.find((el) => (el.placeholder || '').includes('IP'));
  if (!field) return { ok: false, reason: 'whitelist_field_not_found' };
  const oldValue = field.value || '';
  const merged = uniq([...normList(oldValue), ...normList((targetEntries || []).join('\n'))]).join('\n');
  if (merged.trim() === oldValue.trim()) {
    return { ok: true, noChange: true, oldValue, mergedValue: merged };
  }
  setValue(field, merged);
  await sleep(200);
  if ((field.value || '').trim() !== merged.trim()) {
    return { ok: false, reason: 'value_write_failed', oldValue, attemptedValue: merged, actualValue: field.value };
  }
  const submitButton = [...document.querySelectorAll('button, a, [role=button], .weui-desktop-btn')]
    .filter(visible)
    .find((btn) => /^(确定|保存|提交|确认)$/.test(text(btn)) || /(确定|保存|提交|确认)/.test(text(btn)));
  if (!submitButton) return { ok: false, reason: 'submit_button_not_found', oldValue, mergedValue: merged };
  click(submitButton);
  await sleep(1000);
  return { ok: true, oldValue, mergedValue: merged, added: targetEntries };
}

// ============ 任务管理 ============

const jobs = new Map();
let activeJobId = null;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (['done', 'error'].includes(job.status) && now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function getJob(id) {
  pruneJobs();
  const job = jobs.get(id);
  if (!job) return null;
  return { id: job.id, status: job.status, ips: job.ips, added: job.added, message: job.message, qr: job.qr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapQr(job, page, status, message) {
  try {
    job.qr = await page.screenshot({ encoding: 'base64' });
  } catch { /* 截图失败不致命，状态照样推进 */ }
  job.status = status;
  job.message = message;
  job.updatedAt = Date.now();
}

async function runJob(job, appId, chromePath) {
  // 懒加载：未安装/无浏览器环境不影响其他模块与测试
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900', '--lang=zh-CN'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    job.status = 'working';
    job.message = '正在打开公众平台控制台…';
    job.updatedAt = Date.now();
    await page.goto(CONSOLE_URL(appId), { waitUntil: 'domcontentloaded', timeout: 60000 });

    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let submitted = false;
    while (Date.now() < deadline) {
      const state = await page.evaluate(probeConsolePage, appId).catch(() => null);
      if (!state) { await sleep(3000); continue; } // 页面跳转中，下轮再探
      if (state.saved) {
        job.status = 'done';
        job.added = job.ips;
        job.message = `白名单已更新：${job.ips.join('、')}`;
        return;
      }
      if (!state.appIdVisible) {
        await snapQr(job, page, 'waiting_login', '请用公众号管理员微信扫码登录（手机扫描下方二维码）');
        await sleep(3000);
        continue;
      }
      if (!submitted) {
        job.status = 'working';
        job.message = '已登录，正在合并白名单…';
        job.qr = null;
        job.updatedAt = Date.now();
        const r = await page.evaluate(whitelistFastPath, appId, job.ips);
        if (r.ok && r.noChange) {
          job.status = 'done';
          job.added = [];
          job.message = '目标 IP 已在白名单中，无需修改';
          return;
        }
        if (!r.ok) {
          job.status = 'error';
          job.message = `未能自动定位白名单编辑器（${r.reason}）。请手动到公众平台「设置与开发 → 基本配置 → IP 白名单」添加：${job.ips.join('、')}`;
          return;
        }
        submitted = true;
        await sleep(1500);
        continue;
      }
      if (state.confirmModal) {
        await snapQr(job, page, 'waiting_confirm', '保存需要管理员扫码确认，请再次扫码');
        await sleep(3000);
        continue;
      }
      await sleep(2500);
    }
    job.status = 'error';
    job.message = '操作超时（5 分钟）。若已完成扫码，白名单可能已生效，可直接重试官方数据同步';
  } finally {
    await browser.close().catch(() => {});
    if (activeJobId === job.id) activeJobId = null;
    job.updatedAt = Date.now();
  }
}

async function startAutoWhitelist({ appId, ips = [] } = {}) {
  if (!appId) throw new Error('缺少目标公众号 AppID');
  if (activeJobId && jobs.has(activeJobId)) throw new Error('已有白名单配置任务进行中，请等待完成');
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Chromium，请安装 google-chrome 或配置 CHROME_PATH 环境变量');
  const targetIps = ips.length ? ips : [await detectOutboundIp()];

  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    status: 'starting',
    ips: targetIps,
    added: [],
    message: '',
    qr: null,
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  runJob(job, appId, chromePath).catch((e) => {
    job.status = 'error';
    job.message = e.message;
    job.updatedAt = Date.now();
    if (activeJobId === job.id) activeJobId = null;
  });
  return job;
}

module.exports = {
  CHROME_CANDIDATES,
  findChrome,
  detectOutboundIp,
  mergeWhitelistEntries,
  startAutoWhitelist,
  getJob,
};
