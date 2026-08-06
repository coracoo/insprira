// 微信公众平台官方数据统计接口（datacube）：认证服务号/订阅号的权威阅读数据
// 时效 T+1（官方口径：上午 8 点后出前一天数据），比 RedFox 更准更稳但同样不是实时；
// 当日数据仍靠浏览器插件（extension/mp-stats）
// .make({ ENV_FILE, fetchImpl }) 工厂：fetchImpl 注入便于单测
const crypto = require('crypto');
const { db } = require('./db');
const { getLocalData, setLocalData } = require('./local-data');
const { readEnvValues } = require('./env');
const { recordWorkStats } = require('./work-stats');
const { parseJson, toNumber, workContentKey } = require('./utils');

const TOKEN_MODULE = 'wechat-official';
const TOKEN_KEY = 'access_token';
const API_BASE = 'https://api.weixin.qq.com';
const SYNC_DAYS = 7; // 默认回补最近 7 天

// 微信 datacube 要求 YYYY-MM-DD（补零）；lib/utils 的 localDate 不补零，单独实现
function dateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 把微信错误结构化：errcode + 40164 时提取被拒 IP（errmsg 形如 "invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4, not in whitelist"）
function mpError(prefix, data) {
  const err = new Error(`${prefix}：${data.errmsg || `errcode ${data.errcode}`}`);
  err.errcode = data.errcode;
  const ipMatch = String(data.errmsg || '').match(/invalid ip ([\d.]+)/);
  if (ipMatch) err.ip = ipMatch[1];
  return err;
}

function make({ ENV_FILE, fetchImpl = fetch }) {
  function getMpConfig() {
    const file = readEnvValues(ENV_FILE);
    const appId = (file.MP_APP_ID || process.env.MP_APP_ID || '').trim();
    const appSecret = (file.MP_APP_SECRET || process.env.MP_APP_SECRET || '').trim();
    const accountName = (file.MP_ACCOUNT_NAME || process.env.MP_ACCOUNT_NAME || '').trim();
    if (!appId || !appSecret) return null;
    return { appId, appSecret, accountName };
  }

  // access_token 有效期 7200s，缓存到 local_data，提前 5 分钟过期
  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = getLocalData(TOKEN_MODULE, TOKEN_KEY);
      if (cached?.token && cached.expiresAt > Date.now() + 60000) return cached.token;
    }
    const cfg = getMpConfig();
    if (!cfg) throw new Error('未配置 MP_APP_ID / MP_APP_SECRET');
    const url = `${API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.appId)}&secret=${encodeURIComponent(cfg.appSecret)}`;
    const res = await fetchImpl(url);
    const data = await res.json();
    if (!data.access_token) {
      throw mpError('获取 access_token 失败（40164 请把报错 IP 加进公众平台 IP 白名单）', data);
    }
    setLocalData(TOKEN_MODULE, TOKEN_KEY, {
      token: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in || 7200) - 300) * 1000,
    });
    return data.access_token;
  }

  // datacube 调用；token 失效（40001/40014/42001）自动刷新重试一次
  async function datacube(path, body, retry = true) {
    const token = await getAccessToken();
    const res = await fetchImpl(`${API_BASE}/datacube/${path}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if ([40001, 40014, 42001].includes(data.errcode) && retry) {
      await getAccessToken(true);
      return datacube(path, body, false);
    }
    if (data.errcode) throw mpError(`datacube/${path} 失败`, data);
    return data;
  }

  // AppID 对应哪个「我的账号」：配了 MP_ACCOUNT_NAME 按名匹配；没配则唯一 gzh 账号兜底
  function findMpAccount(cfg, account) {
    if (account) {
      // 调用方指定账号时校验一致性，避免给别的公众号写数据
      if (account.plat !== 'gzh') return null;
      if (cfg.accountName && account.name !== cfg.accountName) return null;
      return account;
    }
    const rows = db.prepare("SELECT * FROM my_accounts WHERE plat = 'gzh'").all();
    if (cfg.accountName) return rows.find(r => r.name === cfg.accountName) || null;
    return rows.length === 1 ? rows[0] : null;
  }

  // 同步最近 days 天的「发表内容每日阅读数据」到 account_works，并留指标历史点
  // 每日数据幂等合并进 work.official_daily[date]，重复同步同一日期不会重复累计
  async function syncMpOfficialStats({ account = null, days = SYNC_DAYS, now = Date.now() } = {}) {
    const cfg = getMpConfig();
    if (!cfg) return { synced: 0, reason: '未配置 MP_APP_ID/MP_APP_SECRET' };
    const target = findMpAccount(cfg, account);
    if (!target) {
      return { synced: 0, reason: account ? '该账号不是 AppID 对应的公众号' : '未找到匹配的公众号账号（检查 MP_ACCOUNT_NAME）' };
    }
    // account 可能来自 getMyAccount（camelCase）或 DB 行（snake_case），两种口径都兼容
    const accountId = target.tracker_id || target.trackerId || target.id;

    const findStmt = db.prepare(
      "SELECT work_data, publish_at FROM account_works WHERE account_id = ? AND plat = 'gzh' AND work_id = ?"
    );
    const upsert = db.prepare(`
      INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
      VALUES (?, 'gzh', ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, plat, work_id) DO UPDATE SET
        work_data = excluded.work_data,
        synced_at = excluded.synced_at,
        publish_at = COALESCE(account_works.publish_at, excluded.publish_at),
        content_key = excluded.content_key
    `);

    const statsMap = new Map(); // workId → 最终累计指标，同一作品多天只留一个历史点
    const errors = [];
    let synced = 0;
    for (let i = 1; i <= days; i++) {
      const date = dateStr(new Date(now - i * 86400000));
      let list;
      try {
        const data = await datacube('getarticleread', { begin_date: date, end_date: date });
        list = data.list || [];
      } catch (e) {
        // token/权限类错误（40164 白名单、48001 无权限等）每天必现，直接中止并结构化上抛
        if (e.errcode) {
          return { account: target.name, synced, errcode: e.errcode, ...(e.ip ? { ip: e.ip } : {}), error: e.message };
        }
        errors.push(`${date}: ${e.message}`);
        continue;
      }
      const saveDay = db.transaction(() => {
        for (const item of list) {
          const title = String(item.title || '').trim();
          const msgid = String(item.msgid || '');
          if (!title && !msgid) continue;
          const workId = msgid || crypto.createHash('sha1').update(title).digest('hex');
          const existing = findStmt.get(accountId, workId);
          const work = existing ? (parseJson(existing.work_data) || {}) : {};
          if (title && !work.title) work.title = title;
          // 当日指标（阅读=中间页+原文页阅读次数）：按日期幂等覆盖
          const daily = work.official_daily || {};
          daily[date] = {
            reads: (toNumber(item.int_page_read_count) || 0) + (toNumber(item.ori_page_read_count) || 0),
            readUsers: (toNumber(item.int_page_read_user) || 0) + (toNumber(item.ori_page_read_user) || 0),
            shares: toNumber(item.share_count) || 0,
            favs: toNumber(item.add_to_fav_count) || 0,
          };
          work.official_daily = daily;
          // 官方累计（仅含已同步日期）与其他来源取大，只增不减
          const officialTotal = Object.values(daily).reduce((s, d) => s + (d.reads || 0), 0);
          work.readCount = Math.max(toNumber(work.readCount) || 0, officialTotal);
          work.shareCount = Object.values(daily).reduce((s, d) => s + (d.shares || 0), 0);
          work.source = work.source === 'mp-extension' ? work.source : 'mp-official';
          upsert.run(accountId, workId, JSON.stringify(work), now, existing?.publish_at ?? null, workContentKey(work));
          statsMap.set(workId, { workId, reads: work.readCount, likes: null, comments: null });
          synced++;
        }
      });
      saveDay();
    }
    if (statsMap.size) recordWorkStats(accountId, 'gzh', [...statsMap.values()], now);
    return { account: target.name, synced, days, ...(errors.length ? { errors } : {}) };
  }

  return { getMpConfig, getAccessToken, datacube, syncMpOfficialStats };
}

module.exports = { make, dateStr };
