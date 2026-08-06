// 选项页：保存/读取配置、测试连接、手动触发同步
const $ = id => document.getElementById(id);
const status = (text, ok = true) => {
  $('status').textContent = text;
  $('status').style.color = ok ? '#10b981' : '#ef4444';
};

async function load() {
  const opts = await chrome.storage.local.get(['serverUrl', 'token', 'mpName']);
  $('serverUrl').value = opts.serverUrl || 'http://localhost:8080';
  $('token').value = opts.token || '';
  $('mpName').value = opts.mpName || '';
}

async function save() {
  await chrome.storage.local.set({
    serverUrl: $('serverUrl').value.trim().replace(/\/$/, ''),
    token: $('token').value.trim(),
    mpName: $('mpName').value.trim(),
  });
  status('已保存');
}

async function testConnection() {
  await save();
  const serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  if (!serverUrl || !token) { status('请先填写地址和 INGEST_TOKEN', false); return; }
  try {
    const res = await fetch(`${serverUrl}/api/_/ingest/mp-stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({ ping: true }),
    });
    const payload = await res.json().catch(() => null);
    if (res.ok && payload?.ok) status('连接成功，令牌有效');
    else status(`连接失败：${payload?.error || `HTTP ${res.status}`}`, false);
  } catch (e) {
    status(`无法连接服务器：${e.message}`, false);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', testConnection);
$('syncNow').addEventListener('click', async () => {
  await save();
  status('同步中…（最长约 1 分钟）');
  chrome.runtime.sendMessage({ type: 'mp-stats-sync-now' }, resp => {
    if (chrome.runtime.lastError) { status(`触发失败：${chrome.runtime.lastError.message}`, false); return; }
    if (!resp?.ok) { status(`同步失败：${resp?.error || '未知错误'}`, false); return; }
    status(resp.upserted ? `已上报 ${resp.upserted} 篇到「${resp.account}」` : '未解析到文章数据');
  });
});
load();
