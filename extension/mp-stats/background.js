// 后台 service worker：手动触发式同步
// 触发入口：① 灵感熔炉页面按钮（onMessageExternal）② 工具栏图标 ③ 选项页按钮
// 设计原则：这是用户自己浏览器里的真人会话，只有用户主动点击才抓取，不做定时轮询

const TAB_TIMEOUT_MS = 60000;
const MP_HOME = 'https://mp.weixin.qq.com/';

// 当前正在进行的同步任务（同一时刻只允许一个）
let pending = null; // { tabId, opts, timer, resolve, reject }

async function getOptions() {
  const opts = await chrome.storage.local.get(['serverUrl', 'token', 'mpName']);
  return {
    serverUrl: String(opts.serverUrl || '').trim().replace(/\/$/, ''),
    token: String(opts.token || '').trim(),
    mpName: String(opts.mpName || '').trim(),
  };
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// 打开公众号后台 → content.js 解析 → 上报。成功 resolve({ upserted, account })，失败 reject(Error)
async function runSync() {
  if (pending) throw new Error('同步进行中，请稍候');
  const opts = await getOptions();
  if (!opts.serverUrl || !opts.token || !opts.mpName) {
    setBadge('!', '#f59e0b');
    throw new Error('未配置服务器/令牌/公众号名，请打开插件选项页');
  }
  setBadge('…', '#3b82f6');
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: MP_HOME, active: false }).then(tab => {
      pending = {
        tabId: tab.id, opts, resolve, reject,
        timer: setTimeout(() => finishSync(null, '页面超时（可能未登录或结构变化）'), TAB_TIMEOUT_MS),
      };
    }).catch(reject);
  });
}

async function finishSync(result, error) {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  // 关掉我们打开的后台标签页
  try { await chrome.tabs.remove(p.tabId); } catch {}

  if (error) {
    setBadge('ERR', '#ef4444');
    console.warn('[mp-stats]', error);
    p.reject(new Error(error));
    return;
  }
  if (!result?.articles?.length) {
    setBadge('0', '#6b7280');
    p.resolve({ upserted: 0 });
    return;
  }

  try {
    const res = await fetch(`${p.opts.serverUrl}/api/_/ingest/mp-stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': p.opts.token },
      body: JSON.stringify({ mpName: p.opts.mpName, articles: result.articles }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
    setBadge(String(payload.data?.upserted ?? ''), '#10b981');
    console.log(`[mp-stats] 已上报 ${payload.data?.upserted} 篇到「${payload.data?.account}」`);
    p.resolve({ upserted: payload.data?.upserted ?? 0, account: payload.data?.account });
  } catch (e) {
    setBadge('ERR', '#ef4444');
    console.warn('[mp-stats] 上报失败:', e.message);
    p.reject(e);
  }
}

// 触发来源校验：只接受与选项页配置的服务器同源的页面
// localhost / 127.0.0.1 / ::1 互为别名，同端口视为同源（用户可能混用）
function originMatches(senderOrigin, serverUrl) {
  try {
    const sender = new URL(senderOrigin);
    const configured = new URL(serverUrl);
    if (sender.origin === configured.origin) return true;
    const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
    return LOOPBACK.has(sender.hostname) && LOOPBACK.has(configured.hostname)
      && String(sender.port) === String(configured.port);
  } catch { return false; }
}

// 灵感熔炉页面直接调用（externally_connectable）
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'mp-stats-sync-now') return;
  (async () => {
    try {
      const opts = await getOptions();
      // 未配置：直接帮用户打开配置页，别只丢一句报错
      if (!opts.serverUrl || !opts.token || !opts.mpName) {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: false, error: '插件还未配置，已为你打开配置页：填写服务器地址、INGEST_TOKEN、公众号名并保存后重试' });
        return;
      }
      const senderOrigin = sender.origin || sender.url || '(未知)';
      if (!originMatches(senderOrigin, opts.serverUrl)) {
        console.warn(`[mp-stats] 拒绝触发：来源=${senderOrigin}，配置的服务器=${opts.serverUrl}`);
        sendResponse({
          ok: false,
          error: `触发页面（${senderOrigin}）与选项页配置的服务器（${opts.serverUrl}）不一致，请核对选项页地址`,
        });
        return;
      }
      const result = await runSync();
      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // 异步 sendResponse
});

// content.js 回传解析结果；选项页手动触发
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'mp-stats-sync-now') {
    runSync()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (!pending || sender.tab?.id !== pending.tabId) return;
  if (msg?.type === 'mp-stats-result') finishSync({ articles: msg.articles });
  if (msg?.type === 'mp-stats-error') finishSync(null, msg.error);
});

chrome.action.onClicked.addListener(async () => {
  const opts = await getOptions();
  if (!opts.serverUrl || !opts.token || !opts.mpName) { chrome.runtime.openOptionsPage(); return; }
  runSync().catch(e => console.warn('[mp-stats]', e.message));
});

// 首次安装直接打开配置页，避免用户找不到入口
chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage();
});
