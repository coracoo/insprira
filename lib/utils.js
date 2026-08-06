// 纯工具函数：无副作用，不依赖 db 或其他模块状态
const crypto = require('crypto');

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableObject(value[key]);
    return result;
  }, {});
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// 平台格式化计数："1.7万" → 17000、"10万+" → 100000、空串/无法解析 → null
function parseCountText(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim().replace(/\+$/, '');
  const match = str.match(/^([\d.]+)\s*(万|亿)?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1;
  return Math.round(base * unit);
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

// 周起点（周一，本地时区）→ 'YYYY-MM-DD'，用于周度行动/问题趋势归组
function weekStartKey(ts = Date.now()) {
  const d = new Date(ts);
  const offset = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - offset);
  return localDate(d);
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

function gitBlobSha(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
}

// 合并作品数据（old ← new）：指标取大只增不减；url/publishTime 已有值则保留
// （browser 插件/官方 API 的数据比 RedFox 新且精确，低时效同步不得冲刷）；其余字段新值非空才覆盖
const WORK_METRIC_KEYS = [
  'readCount', 'clicksCount', 'viewCount', 'playCount',
  'likeCount', 'diggCount', 'commentsCount', 'commentCount',
  'shareCount', 'wowCount', 'collectedCount',
];
function mergeWorkData(oldWork, newWork) {
  const merged = { ...(oldWork || {}) };
  for (const [k, v] of Object.entries(newWork || {})) {
    if (v === '' || v == null) continue;
    if (WORK_METRIC_KEYS.includes(k)) {
      merged[k] = Math.max(toNumber(merged[k]) || 0, toNumber(v) || 0);
    } else if ((k === 'url' || k === 'publishTime') && merged[k]) {
      // 保留已有：链接以插件抓取的文章页为准，publishTime 以先到者为准（保 content_key 稳定）
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function parseAgentJsonLines(output, role = 'assistant') {
  const events = String(output || '').split(/\r?\n/)
    .map(line => parseJson(line))
    .filter(Boolean);
  const messages = events.filter(event => event.role === role && typeof event.content === 'string');
  return messages.length ? messages[messages.length - 1].content.trim() : '';
}

module.exports = {
  parseJson,
  stableObject,
  toNumber,
  parseCountText,
  localDate,
  dateDaysAgo,
  dateFromYmd,
  weekStartKey,
  workPublishAt,
  workContentKey,
  mergeWorkData,
  gitBlobSha,
  parseAgentJsonLines,
};
