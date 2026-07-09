// 炉火线 · insprira 签名元素
// 横贯内容区顶部的 1px 状态条：闲置 = 暖铁余烬，工作 = 脉动橙色，完成 = 淬火青，错误 = 红色
const STATES = {
  idle: '',
  working: 'forge-working',
  done: 'forge-done',
  error: 'forge-error',
};

let resetTimer = null;

export function setForgeState(state, autoReset = 0) {
  const bar = document.getElementById('forge-bar');
  if (!bar) return;
  const cls = STATES[state] ?? '';
  bar.className = bar.className.replace(/forge-\w+/g, '').trim();
  if (cls) bar.classList.add(cls);
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  if (autoReset > 0 && state !== 'idle') {
    resetTimer = setTimeout(() => setForgeState('idle'), autoReset);
  }
}

// 自动检测：拦截全局 fetch，根据响应切状态
if (typeof window !== 'undefined' && window.fetch && !window.fetch.__forgeWrapped) {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = String(args[0]?.url || args[0] || '');
    // 跳过图片/字体/心跳/CSS/JS
    if (/\.(png|jpg|jpeg|webp|gif|svg|woff2?|ttf|eot)(\?|$)/i.test(url) ||
        url.includes('/api/_/status') ||
        url.includes('/api/_/version') ||
        url.includes('/api/_/heartbeat') ||
        url.includes('/vendor/') ||
        url.includes('/css/') ||
        url.includes('/js/')) {
      return origFetch(...args);
    }
    setForgeState('working');
    try {
      const res = await origFetch(...args);
      if (res.ok) setForgeState('done', 1400);
      else setForgeState('error', 2000);
      return res;
    } catch (e) {
      setForgeState('error', 2000);
      throw e;
    }
  };
  window.fetch.__forgeWrapped = true;
}

// 提供给其他模块在特定时刻显式触发（例如"开始生成"前手动设 working）
export function initForgeBar() {
  setForgeState('idle');
}

// 全局暴露，方便控制台调试和外部代码调用
if (typeof window !== 'undefined') {
  window.forgeBar = { setState: setForgeState };
}
