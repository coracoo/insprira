// 公众号后台页面脚本：在「首页/发表记录」解析近期发表列表（按时间排序、实时数据）
//
// ⚠️ 这是整个插件唯一依赖 MP 后台页面结构的地方，页面改版只需改这里。
// 结构（2026-08 实测）：
//   .weui-desktop-mass__content        每条发表记录
//     .weui-desktop-mass__time         时间（今天 20:55 / 昨天 21:01 / 星期一 20:39 / 07月29日）
//     a.weui-desktop-mass-appmsg__title  文章链接（首个 <span> 为完整标题，含 &nbsp; 需归一化）
//     .appmsg-view/.appmsg-like/.appmsg-share/.appmsg-haokan/.appmsg-comment  阅读/点赞/分享/推荐/留言
//     a[href*="send_time="]            划线链接，query 里的 send_time 是精确发表时间戳（秒）

// ============ 可调配置（页面改版改这里） ============
const CONFIG = {
  loginHintText: ['扫码登录', '使用微信扫码'],
  itemSelector: '.weui-desktop-mass__content',
  titleLinkSelector: 'a.weui-desktop-mass-appmsg__title',
  timeSelector: '.weui-desktop-mass__time',
  // 指标 class → 字段
  metricClasses: {
    reads: '.appmsg-view',
    likes: '.appmsg-like',
    shares: '.appmsg-share',
    wow: '.appmsg-haokan',
    comments: '.appmsg-comment',
  },
  maxArticles: 10,   // 近期发表取最近 10 条（DOM 顺序即时间倒序）
  waitMs: 30000,
  pollMs: 800,
};
// ==================================================

// 平台格式化计数："1.7万" → 17000，"3,114" → 3114
function parseCount(text) {
  if (!text) return null;
  const str = String(text).trim().replace(/[,\s]/g, '').replace(/\+$/, '');
  const match = str.match(/^([\d.]+)(万|亿)?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  return Math.round(base * (match[2] === '亿' ? 1e8 : match[2] === '万' ? 1e4 : 1));
}

// 相对时间文字 → 绝对日期字符串（"2026/8/5 20:55"），供服务端 Date.parse
function parseMassTime(text, now = new Date()) {
  const t = (text || '').trim();
  if (!t) return '';
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const hm = t.match(/(\d{1,2}:\d{2})\s*$/)?.[1] || '';
  let d = null;
  if (t.startsWith('今天')) {
    d = now;
  } else if (t.startsWith('昨天')) {
    d = new Date(now); d.setDate(d.getDate() - 1);
  } else {
    const wk = t.match(/^星期([一二三四五六日天])/);
    if (wk) {
      const map = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
      const target = map[wk[1]];
      d = new Date(now);
      const diff = (d.getDay() - target + 7) % 7 || 7; // 最近过去的一个星期 X（今天同名按一周前算）
      d.setDate(d.getDate() - diff);
    } else {
      const md = t.match(/(\d{1,2})月(\d{1,2})日/);
      if (md) {
        d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]));
        if (d > now) d = new Date(now.getFullYear() - 1, Number(md[1]) - 1, Number(md[2])); // 跨年回退
      }
    }
  }
  return d ? `${fmt(d)}${hm ? ` ${hm}` : ''}` : t;
}

// 短链 /s/xxx 剥掉 ?token=...&lang=...（token 每会话变化，会破坏主键稳定性）；长链（/s?__biz=…）保留完整 query
function stableArticleUrl(href) {
  try {
    const u = new URL(href);
    if (u.hostname === 'mp.weixin.qq.com' && /^\/s\/[^?]+$/.test(u.pathname)) return u.origin + u.pathname;
    return href;
  } catch { return href; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await sleep(CONFIG.pollMs);
  }
  return null;
}

function reportError(error) {
  chrome.runtime.sendMessage({ type: 'mp-stats-error', error });
}

function looksLikeLoginPage() {
  const text = document.body?.innerText || '';
  return CONFIG.loginHintText.some(hint => text.includes(hint));
}

function extractHomeArticles() {
  const items = [...document.querySelectorAll(CONFIG.itemSelector)];
  if (!items.length) return null;
  const articles = [];
  const seen = new Set();
  for (const item of items) {
    if (articles.length >= CONFIG.maxArticles) break;
    const a = item.querySelector(CONFIG.titleLinkSelector);
    if (!a?.href || !a.href.includes('mp.weixin.qq.com/s')) continue;
    const url = stableArticleUrl(a.href);
    if (seen.has(url)) continue;
    seen.add(url);
    // 首个 <span> 是纯标题；&nbsp;（\u00a0）必须归一化为普通空格，否则和已有数据对不上
    // 用 textContent 而非 innerText：折叠状态下长标题尾部被 CSS 隐藏（视觉截断 ~40 字），
    // innerText 会丢掉尾部，textContent 拿 DOM 全量文本
    const titleEl = a.querySelector('span');
    const title = ((titleEl || a).textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 2) continue;
    const metric = sel => parseCount(item.querySelector(sel)?.innerText) ?? 0;
    // 精确发表时间优先取划线链接里的 send_time（epoch 秒），取不到再解析相对时间文字
    const sendTime = item.querySelector('a[href*="send_time="]')?.href.match(/send_time=(\d+)/)?.[1];
    const publishTime = sendTime
      ? new Date(Number(sendTime) * 1000).toLocaleString('zh-CN', { hour12: false })
      : parseMassTime(item.querySelector(CONFIG.timeSelector)?.innerText);
    articles.push({
      title,
      url,
      reads: metric(CONFIG.metricClasses.reads),
      likes: metric(CONFIG.metricClasses.likes),
      shares: metric(CONFIG.metricClasses.shares),
      wow: metric(CONFIG.metricClasses.wow),
      comments: metric(CONFIG.metricClasses.comments),
      publishTime,
    });
  }
  return articles.length ? articles : null;
}

async function main() {
  await sleep(2000); // 等 SPA 首屏
  if (looksLikeLoginPage()) {
    reportError('公众号后台未登录，请在此浏览器中扫码登录后再同步');
    return;
  }
  const articles = await waitFor(extractHomeArticles, CONFIG.waitMs);
  if (articles) {
    chrome.runtime.sendMessage({ type: 'mp-stats-result', articles });
  } else {
    reportError('未解析到「近期发表」文章列表（页面结构可能已变化）');
  }
}

main().catch(e => reportError(`插件脚本异常：${e.message}`));
