// 账号追踪：订阅管理 + RedFox 数据同步 + 平台账号诊断
// make(deps) 工厂注入 paths/keys/llm/notify 等
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');
const { parseJson, toNumber, localDate, dateDaysAgo, workPublishAt, workContentKey } = require('./utils');
const { redfoxData, logApiUsage } = require('./redfox');
const { runProcess } = require('./exec');
const { logAction } = require('./observability');

const TRACKER_COLLECTION_WAIT_MS = 30 * 60 * 1000;

function make(deps) {
  const {
    WECHAT_ANALYZER_ROOT, DOUYIN_ANALYZER_ROOT, XHS_ANALYZER_ROOT,
    EXTENDED_PATH, API_KEY, execFileAsync,
    callLlmJson, broadcastNotification,
    getLocalData, setLocalData,
  } = deps;

  let diagnosisBusy = false;
  const activeTrackerSyncs = new Map();
  const trackerRetryTimers = new Map();

  function normalizeTrackerAccountId(plat, value) {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
      const url = new URL(input);
      if (plat === 'dy') {
        const match = url.pathname.match(/\/user\/([^/]+)/);
        if (match) return decodeURIComponent(match[1]);
      }
      if (plat === 'xhs') {
        const match = url.pathname.match(/\/user\/profile\/([^/]+)/);
        if (match) return decodeURIComponent(match[1]);
      }
    } catch {}
    return input;
  }

  function xhsTrackerAccounts(data) {
    return Array.isArray(data)
      ? data
      : Array.isArray(data?.list) ? data.list
        : data && typeof data === 'object' ? [data] : [];
  }

  function listTrackers() {
    return db.prepare('SELECT * FROM tracked_accounts ORDER BY created_at DESC').all().map(row => {
      const raw = parseJson(row.raw_info) || {};
      if (String(raw.authorFans || '').startsWith('红狐指数')) delete raw.authorFans;
      return {
        ...raw,
        id: row.id,
        plat: row.plat,
        name: row.name,
        group: row.group_name,
        syncedAt: row.synced_at,
        createdAt: row.created_at,
      };
    });
  }

  function saveTracker(body) {
    const plat = String(body.plat || '');
    const name = String(body.name || '').trim();
    if (!['dy', 'xhs', 'gzh'].includes(plat) || !name) throw new Error('平台或账号名称无效');
    const accountId = normalizeTrackerAccountId(plat, body.accountId || '');
    if (['dy', 'xhs'].includes(plat) && !accountId) {
      throw new Error(plat === 'dy' ? '请填写抖音号或账号 ID' : '请填写小红书号（redId）');
    }
    const id = String(body.id || `${plat}:${accountId || name}`);
    const now = Date.now();
    const raw = { ...body, accountId };
    if (String(raw.authorFans || '').startsWith('红狐指数')) delete raw.authorFans;
    const existing = db.prepare('SELECT name, plat, raw_info FROM tracked_accounts WHERE id = ?').get(id);
    const existingRaw = parseJson(existing?.raw_info) || {};
    const identifierChanged = Boolean(existing) && (
      existing.plat !== plat
      || normalizeTrackerAccountId(existing.plat, existingRaw.accountId || '') !== accountId
    );
    // 公众号改名字时清掉旧 gzhAccount，让下次同步按新名字重新解析
    // （gzhAccount 是 gh_xxx 唯一 ID，属于旧账号；新名字对应不同账号）
    let nameChangedGzh = false;
    if (existing && existing.plat === 'gzh' && existing.name && existing.name !== name && existingRaw.gzhAccount) {
      raw.gzhAccount = '';
      nameChangedGzh = true;
    }
    delete raw.id;
    delete raw.plat;
    delete raw.name;
    delete raw.group;
    delete raw.syncedAt;
    delete raw.createdAt;
    db.prepare(`
      INSERT INTO tracked_accounts (id, plat, name, group_name, raw_info, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plat = excluded.plat,
        name = excluded.name,
        group_name = excluded.group_name,
        raw_info = excluded.raw_info
    `).run(id, plat, name, body.group || '其他', JSON.stringify(raw), now);
    if (identifierChanged || nameChangedGzh) {
      db.prepare('DELETE FROM account_works WHERE account_id = ?').run(id);
      db.prepare('UPDATE tracked_accounts SET synced_at = NULL WHERE id = ?').run(id);
    }
    return listTrackers().find(item => item.id === id);
  }

  function trackerQuerySpec(tracker) {
    const accountId = normalizeTrackerAccountId(tracker.plat, tracker.accountId || '');
    if (tracker.plat === 'gzh') {
      return {
        endpoint: 'gzhData/queryWorkList',
        body: {
          account: tracker.gzhAccount || undefined,
          accountName: tracker.name,
          offset: 0,
          sortType: '_2',
          publishTimeStart: dateDaysAgo(90),
          publishTimeEnd: localDate(),
          source: '灵感熔炉-账号追踪',
        },
      };
    }
    if (tracker.plat === 'dy') {
      if (!accountId) throw new Error('该订阅缺少抖音号或账号 ID，请先编辑账号信息');
      return {
        endpoint: 'dyData/queryUserWithWorks',
        body: { accountId, source: '灵感熔炉-账号追踪' },
      };
    }
    if (tracker.plat === 'xhs') {
      if (!accountId) throw new Error('该订阅缺少小红书号（redId），请先编辑账号信息');
      return {
        endpoint: 'xhsUser/query',
        body: { userIds: [accountId], source: '灵感熔炉-账号追踪' },
      };
    }
    throw new Error(`不支持的平台：${tracker.plat}`);
  }

  function trackerCollectionSpec(tracker) {
    const accountId = normalizeTrackerAccountId(tracker.plat, tracker.accountId || '');
    if (tracker.plat === 'xhs') {
      return {
        endpoint: 'xhsUser/syncUserNotes',
        body: { redId: accountId, source: '灵感熔炉-账号追踪' },
      };
    }
    throw new Error(`当前不支持提交 ${tracker.plat} 账号采集`);
  }

  function normalizeTrackerResult(tracker, data) {
    if (tracker.plat === 'gzh') {
      return { works: data?.list || data?.articles || [], trackerPatch: {} };
    }
    if (tracker.plat === 'dy') {
      if (!data || !data.nickname) {
        throw new Error('未查询到该抖音账号，请检查抖音号；未收录账号需先在 RedFox 同步');
      }
      const accountId = data.accountId || data.uniqueId || tracker.accountId;
      const works = (Array.isArray(data.workList) ? data.workList : []).map(work => ({
        ...work,
        accountName: work.accountName || data.nickname,
        accountId: work.accountId || accountId,
        avatarUrl: work.avatarUrl || data.avatar,
        followerCount: work.followerCount ?? data.followerCount,
      }));
      return {
        works,
        trackerPatch: {
          name: data.nickname || tracker.name,
          accountId,
          avatar: data.avatar || tracker.avatar,
          authorFans: data.followerCount ?? tracker.authorFans,
          redfoxIndex: data.redfoxIndex ?? tracker.redfoxIndex,
          secUid: data.secUid || tracker.secUid,
        },
      };
    }
    const accounts = xhsTrackerAccounts(data);
    const expectedId = normalizeTrackerAccountId('xhs', tracker.accountId || '');
    const account = accounts.find(item => String(item.redId || item.userId || '') === expectedId)
      || accounts[0];
    if (!account || !account.nickname) {
      throw new Error('未查询到该小红书账号，请检查小红书号（redId）；昵称不能用于稳定追踪');
    }
    const accountId = account.redId || account.userId || expectedId;
    const works = (Array.isArray(account.works) ? account.works : []).map(work => ({
      ...work,
      accountNickname: work.accountNickname || account.nickname,
      authorNickname: work.authorNickname || account.nickname,
      accountUserid: work.accountUserid || accountId,
      authorId: work.authorId || accountId,
      authorFans: work.authorFans ?? account.fans,
      cover: work.cover || work.coverUrl,
    }));
    return {
      works,
      trackerPatch: {
        name: account.nickname || tracker.name,
        accountId,
        avatar: account.avatar || tracker.avatar,
        description: account.desc || tracker.description,
        authorFans: account.fans ?? tracker.authorFans,
        redfoxIndex: account.recentIndex ?? tracker.redfoxIndex,
      },
    };
  }

  function trackerWorkId(work) {
    return work.workId || work.workUuid || work.id || work.awemeId
      || crypto.createHash('sha1').update([
        String(work.title || work.desc || ''),
        String(work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''),
        String(work.workUrl || work.url || ''),
      ].join('\n')).digest('hex');
  }

  function trackerPendingResult(tracker, message) {
    return {
      tracker, works: [], count: 0, newCount: 0, pending: true,
      retryAt: tracker.syncRetryAt || null,
      message: message || tracker.syncMessage || 'RedFox 正在采集账号数据',
    };
  }

  function scheduleTrackerRetry(id, retryAt) {
    const existing = trackerRetryTimers.get(id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(1000, Number(retryAt) - Date.now());
    const timer = setTimeout(async () => {
      trackerRetryTimers.delete(id);
      try {
        await syncTracker(id, { automatic: true });
      } catch (error) {
        console.warn(`[tracker] 自动回查 ${id} 失败:`, error.message);
      }
    }, delay);
    timer.unref?.();
    trackerRetryTimers.set(id, timer);
  }

  function restoreTrackerRetries() {
    for (const tracker of listTrackers()) {
      if (tracker.plat === 'xhs' && tracker.syncStatus === 'pending' && tracker.syncRetryAt) {
        scheduleTrackerRetry(tracker.id, tracker.syncRetryAt);
      }
    }
  }

  async function submitTrackerCollection(tracker) {
    const request = trackerCollectionSpec(tracker);
    await redfoxData(request.endpoint, request.body);
    const now = Date.now();
    const retryAt = now + TRACKER_COLLECTION_WAIT_MS;
    const updated = saveTracker({
      ...tracker,
      syncStatus: 'pending',
      syncRequestedAt: now,
      syncRetryAt: retryAt,
      syncMessage: '已提交 RedFox 采集，预计约 30 分钟后可查询',
      syncAttempts: Number(tracker.syncAttempts || 0) + 1,
    });
    scheduleTrackerRetry(tracker.id, retryAt);
    logAction('tracker-collection-submit', 'sync-button', 'redfox', {
      trackerId: tracker.id,
      platform: tracker.plat,
      accountId: tracker.accountId,
      retryAt,
    }, 1, 0);
    return trackerPendingResult(updated);
  }

  async function syncTracker(id, options = {}) {
    if (activeTrackerSyncs.has(id)) return activeTrackerSyncs.get(id);
    const promise = syncTrackerOnce(id, options);
    activeTrackerSyncs.set(id, promise);
    try {
      return await promise;
    } finally {
      activeTrackerSyncs.delete(id);
    }
  }

  async function syncTrackerOnce(id, options = {}) {
    let tracker = listTrackers().find(item => item.id === id);
    if (!tracker) throw new Error('账号不存在');
    if (
      tracker.plat === 'xhs'
      && tracker.syncStatus === 'pending'
      && Number(tracker.syncRetryAt) > Date.now()
      && !options.automatic
    ) {
      return trackerPendingResult(tracker);
    }
    const query = trackerQuerySpec(tracker);
    const data = await redfoxData(query.endpoint, query.body);
    if (tracker.plat === 'xhs' && !xhsTrackerAccounts(data).some(account => account?.nickname)) {
      if (!tracker.syncRequestedAt) return submitTrackerCollection(tracker);
      const updated = saveTracker({
        ...tracker,
        syncStatus: 'waiting',
        syncRetryAt: null,
        syncCheckedAt: Date.now(),
        syncMessage: 'RedFox 已接受采集，但暂未返回账号数据。请稍后再次同步；也请确认填写的是主页显示的小红书号。',
      });
      logAction('tracker-collection-pending', options.automatic ? 'automatic-retry' : 'sync-button', 'redfox', {
        trackerId: tracker.id,
        platform: tracker.plat,
        accountId: tracker.accountId,
      }, 1, 0);
      return trackerPendingResult(updated);
    }
    const normalized = normalizeTrackerResult(tracker, data);
    if (tracker.plat === 'xhs' && !normalized.works.length) {
      if (!tracker.syncRequestedAt) return submitTrackerCollection(tracker);
      const updated = saveTracker({
        ...tracker,
        ...normalized.trackerPatch,
        syncStatus: 'waiting',
        syncRetryAt: null,
        syncCheckedAt: Date.now(),
        syncMessage: '账号资料已匹配，但作品仍在 RedFox 入库中，请稍后再次同步。',
      });
      return trackerPendingResult(updated);
    }
    if (Object.keys(normalized.trackerPatch).length) {
      tracker = saveTracker({
        ...tracker,
        ...normalized.trackerPatch,
        syncStatus: 'ready',
        syncRetryAt: null,
        syncCheckedAt: Date.now(),
        syncMessage: '',
      });
    }
    const works = normalized.works.sort((a, b) => workPublishAt(b) - workPublishAt(a));
    const now = Date.now();
    const existingStmt = db.prepare(`
      SELECT 1 FROM account_works WHERE account_id = ? AND plat = ? AND work_id = ?
    `);
    const newWorks = works.filter(work => {
      const workId = trackerWorkId(work);
      if (!workId) return false;
      return !existingStmt.get(id, tracker.plat, String(workId));
    });
    const upsertWork = db.prepare(`
      INSERT INTO account_works (account_id, plat, work_id, work_data, synced_at, publish_at, content_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, plat, work_id) DO UPDATE SET
        work_data = excluded.work_data,
        synced_at = excluded.synced_at,
        publish_at = excluded.publish_at,
        content_key = excluded.content_key
    `);
    db.transaction(() => {
      for (const work of works) {
        const workId = trackerWorkId(work);
        if (!workId) continue;
        const key = workContentKey(work);
        db.prepare(`
          DELETE FROM account_works
          WHERE account_id = ? AND plat = ? AND content_key = ? AND work_id <> ?
        `).run(id, tracker.plat, key, String(workId));
        upsertWork.run(
          id, tracker.plat, String(workId),
          JSON.stringify(work), now, workPublishAt(work), key,
        );
      }
      db.prepare('UPDATE tracked_accounts SET synced_at = ? WHERE id = ?').run(now, id);
    })();
    if (newWorks.length) {
      const top = newWorks.slice(0, 3).map(work => {
        const title = (work.title || work.desc || '').toString().slice(0, 60);
        return `· ${title || '(无标题)'}`;
      }).join('\n');
      broadcastNotification(
        `追踪账号「${tracker.name}」有新作品`,
        `本次同步新增 ${newWorks.length} 条作品${newWorks.length > 3 ? '（仅显示前 3 条）' : ''}：\n${top}`
      ).catch(err => console.warn('[notify] 追踪账号新作品通知异常:', err.message));
    }
    return {
      tracker: { ...tracker, syncedAt: now },
      works, count: works.length, newCount: newWorks.length,
      ...(options.includeSourceData ? { _sourceData: data } : {}),
    };
  }

  function listTrackerWorks(id) {
    const seen = new Set();
    return db.prepare(`
      SELECT work_data, publish_at, synced_at
      FROM account_works
      WHERE account_id = ?
      ORDER BY COALESCE(publish_at, 0) DESC, synced_at DESC
      LIMIT 200
    `).all(id).map(row => parseJson(row.work_data)).filter(work => {
      if (!work) return false;
      const key = `${String(work.title || '').trim().toLowerCase()}\n${
        work.publishTime || work.workPublishTime || work.createTime || work.publicTime || ''
      }`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 100);
  }

  async function runWechatDiagnosis(accountName) {
    if (diagnosisBusy) throw new Error('已有公众号诊断正在执行，请稍后重试');
    diagnosisBusy = true;
    try {
      const script = path.join(WECHAT_ANALYZER_ROOT, 'scripts', 'wechat_analyzer.py');
      if (!fs.existsSync(script)) throw new Error('本地公众号诊断 Skill 未安装');
      await execFileAsync('python3', [
        script, 'query', '--account_names', accountName,
      ], {
        cwd: WECHAT_ANALYZER_ROOT,
        env: { ...process.env, PATH: EXTENDED_PATH, REDFOX_API_KEY: API_KEY },
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      });
      logApiUsage('gzhUser/query', 200, false);
      const reportPath = path.join(WECHAT_ANALYZER_ROOT, 'output', 'report_data.json');
      const report = parseJson(fs.readFileSync(reportPath, 'utf8'));
      if (!report?.header) throw new Error('诊断 Skill 未返回有效报告');
      return report;
    } finally {
      diagnosisBusy = false;
    }
  }

  async function runPythonDiagnosis(root, code, input) {
    const { stdout } = await runProcess('python3', ['-c', code], {
      cwd: root,
      input: JSON.stringify(input),
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = parseJson(stdout.trim());
    if (!result) throw new Error('本地诊断 Skill 未返回有效结果');
    return result;
  }

  async function runDouyinDiagnosis(tracker) {
    const data = await redfoxData('dyUser/query', {
      accountIds: [tracker.accountId],
      source: '灵感熔炉-抖音账号诊断',
    });
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw?.nickname) throw new Error('RedFox 未返回该抖音账号的诊断数据');
    const result = await runPythonDiagnosis(DOUYIN_ANALYZER_ROOT, [
      'import json,sys',
      'sys.path.insert(0, "scripts")',
      'from generate_diagnosis_report import DouyinDiagnosisReportV3',
      'd=json.load(sys.stdin)',
      'g=DouyinDiagnosisReportV3(d)',
      'a=g._score_body()[0]; b=g._score_content()[0]; c=g._score_operation()[0]; e=g._score_platform()[0]',
      'total=a+b+c+e',
      'grade=g._get_grade(total)',
      'print(json.dumps({"score":total,"grade":grade[2]+" "+grade[1],"dimensions":[["账号体量",a,35],["内容表现",b,35],["运营活跃度",c,20],["平台指数",e,10]],"markdown":g.generate_report()},ensure_ascii=False))',
    ].join(';'), raw);
    return {
      platform: 'dy',
      header: {
        '账号名': raw.nickname,
        '账号标识': raw.uniqueId || raw.accountId || tracker.accountId,
        '账号类型': raw.category || '',
        '红狐指数': raw.redfoxIndex,
        '粉丝数': raw.followerCount,
        '数据更新时间': raw.crawlTime || '',
      },
      scores: { '综合评分': result.score, '综合等级': result.grade },
      dimensions: result.dimensions.map(([name, score, max]) => ({ name, score, max })),
      works: (raw.works || []).map(work => ({
        '标题': work.desc || work.title || '(无标题)',
        '发布时间': work.createTime || work.publishTime || '',
        '阅读数': work.playCount,
        '点赞数': work.diggCount,
        '评论数': work.commentCount,
        '链接': work.shareUrl || work.url || '',
      })),
      markdown: result.markdown,
      _raw: raw,
    };
  }

  async function runXhsDiagnosis(tracker, sourceData = null) {
    const data = sourceData || await redfoxData('xhsUser/query', {
      userIds: [tracker.accountId],
      source: '灵感熔炉-小红书账号诊断',
    });
    const raw = xhsTrackerAccounts(data)[0];
    if (!raw?.nickname) throw new Error('RedFox 未返回该小红书账号的诊断数据');
    const result = await runPythonDiagnosis(XHS_ANALYZER_ROOT, [
      'import json,sys',
      'sys.path.insert(0, "scripts")',
      'from xiaohongshu_analyzer import _analyze_single_account',
      'd=json.load(sys.stdin)',
      'print(json.dumps(_analyze_single_account(d, bool(d.get("works"))),ensure_ascii=False))',
    ].join(';'), raw);
    const scores = result.scores || {};
    const names = [
      ['账号定位', 10], ['粉丝画像与需求', 15], ['选题体系', 15], ['封面风格', 10],
      ['爆文能力', 15], ['互动规模', 20], ['更新产能', 15],
    ];
    return {
      ...result,
      platform: 'xhs',
      header: {
        ...(result.header || {}),
        '账号名': raw.nickname,
        '账号标识': raw.redId || tracker.accountId,
        '红狐指数': raw.recentIndex,
        '粉丝数': raw.fans,
        '数据更新时间': raw.gmtCreate || '',
      },
      dimensions: names.map(([name, max]) => ({
        name,
        score: scores[`${name}得分`],
        max: scores[`${name}满分`] || max,
      })),
      works: (raw.works || []).map(work => ({
        '标题': work.title || work.desc || '(无标题)',
        '发布时间': work.publishTime || work.createTime || '',
        '阅读数': work.viewCount,
        '点赞数': work.likedCount,
        '评论数': work.commentCount,
        '链接': work.url || work.workUrl || '',
      })),
      _raw: raw,
    };
  }

  function normalizeWechatDiagnosis(report) {
    const scores = report.scores || {};
    return {
      ...report,
      platform: 'gzh',
      dimensions: [
        ['内容健康度', scores['内容健康度得分']],
        ['用户活跃度', scores['用户活跃度得分']],
        ['核心数据表现', scores['内容核心数据表现得分']],
        ['运营规范性', scores['运营规范性得分']],
      ].map(([name, score]) => ({ name, score, max: 100 })),
    };
  }

  async function runPlatformDiagnosis(tracker, sourceData = null) {
    if (tracker.plat === 'gzh') return normalizeWechatDiagnosis(await runWechatDiagnosis(tracker.name));
    if (tracker.plat === 'dy') return runDouyinDiagnosis(tracker);
    if (tracker.plat === 'xhs') return runXhsDiagnosis(tracker, sourceData);
    throw new Error('当前平台不支持账号诊断');
  }

  function diagnosisMetrics(report) {
    const raw = report._raw || {};
    const header = report.header || {};
    return {
      followerCount: toNumber(raw.followerCount ?? raw.fans ?? header['粉丝数']),
      redfoxIndex: toNumber(raw.redfoxIndex ?? raw.recentIndex ?? header['红狐指数']),
      score: toNumber(report.scores?.['综合评分']),
      workCount: toNumber(raw.awemeCount ?? raw.totalWork ?? raw.workCount) || (report.works || []).length,
    };
  }

  function listAccountSnapshots(accountId, limit = 30) {
    return db.prepare(`
      SELECT snapshot_date, follower_count, redfox_index, work_count, score, analysis, raw_data, captured_at
      FROM account_snapshots
      WHERE account_id = ?
      ORDER BY snapshot_date DESC, captured_at DESC
      LIMIT ?
    `).all(accountId, limit).map(row => ({
      snapshotDate: row.snapshot_date,
      followerCount: row.follower_count,
      redfoxIndex: row.redfox_index,
      workCount: row.work_count,
      score: row.score,
      analysis: parseJson(row.analysis) || row.analysis || null,
      report: parseJson(row.raw_data) || null,
      capturedAt: row.captured_at,
    }));
  }

  async function buildAccountTrendAnalysis(tracker, report, snapshotDate) {
    const history = listAccountSnapshots(tracker.id, 14).reverse().map(item => ({
      date: item.snapshotDate,
      followers: item.followerCount,
      redfoxIndex: item.redfoxIndex,
      score: item.score,
      works: item.workCount,
    }));
    const current = diagnosisMetrics(report);
    if (!history.length) {
      return {
        summary: `已建立 ${snapshotDate} 的首个账号基线快照，后续刷新后可比较趋势。`,
        changes: [], risks: [],
        actions: ['保持每日快照，至少积累 7 天后再判断稳定趋势。'],
        generatedBy: '基线规则',
      };
    }
    const previous = history.at(-1);
    const currentValues = [current.followerCount, current.redfoxIndex, current.score, current.workCount];
    const previousValues = [previous.followers, previous.redfoxIndex, previous.score, previous.works];
    if (currentValues.every((value, index) => value === previousValues[index])) {
      return {
        summary: `与 ${previous.date} 相比，粉丝、红狐指数、综合评分和作品数均无变化。`,
        changes: ['核心指标无变化，本次未调用 LLM。'],
        risks: [],
        actions: ['继续观察下一次数据更新。'],
        generatedBy: '无变化规则',
      };
    }
    if (!process.env.LLM_API_KEY) {
      return {
        summary: `截至 ${snapshotDate}，综合评分 ${current.score ?? '--'}，红狐指数 ${current.redfoxIndex ?? '--'}。`,
        changes: [
          `粉丝变化：${(current.followerCount ?? 0) - (previous.followers ?? 0)}`,
          `红狐指数变化：${(current.redfoxIndex ?? 0) - (previous.redfoxIndex ?? 0)}`,
        ],
        actions: ['保持每日快照，至少积累 7 天后再判断稳定趋势。'],
        generatedBy: '规则分析',
      };
    }
    try {
      return await callLlmJson([
        {
          role: 'system',
          content: '你是自媒体账号数据分析师。只基于给定的真实快照和本次 Skill 评分做趋势解读，不得编造。输出 JSON：{"summary":"","changes":[""],"risks":[""],"actions":[""]}。',
        },
        {
          role: 'user',
          content: `平台：${tracker.plat}\n账号：${tracker.name}\n当前日期：${snapshotDate}\n历史快照：${JSON.stringify(history)}\n本次指标：${JSON.stringify(current)}\n本次维度评分：${JSON.stringify(report.dimensions || [])}`,
        },
      ]);
    } catch (error) {
      return {
        summary: `评分已保存，但 LLM 趋势解读失败：${error.message}`,
        changes: [], risks: [],
        actions: ['可在 LLM 服务恢复后重新运行评分详情。'],
        generatedBy: '规则降级',
      };
    }
  }

  async function diagnoseAndStoreTracker(tracker, options = {}) {
    const report = await runPlatformDiagnosis(tracker, options.sourceData);
    const metrics = diagnosisMetrics(report);
    const snapshotDate = options.snapshotDate || localDate();
    const analysis = tracker.group === '自己'
      ? await buildAccountTrendAnalysis(tracker, report, snapshotDate)
      : null;
    const raw = report._raw || {};
    const updated = saveTracker({
      ...tracker,
      // 用户手动设的名字优先；API 返回的名字只在没有名字时兜底（避免覆盖）
      name: tracker.name ?? report.header?.['账号名'] ?? tracker.name,
      avatar: raw.avatar || raw.avatarUrl || tracker.avatar,
      gzhAvatar: tracker.plat === 'gzh' ? (raw.avatar || tracker.gzhAvatar) : tracker.gzhAvatar,
      authorFans: metrics.followerCount ?? tracker.authorFans,
      redfoxIndex: metrics.redfoxIndex ?? tracker.redfoxIndex,
      gzhRedfoxIndex: tracker.plat === 'gzh' ? (metrics.redfoxIndex ?? tracker.gzhRedfoxIndex) : tracker.gzhRedfoxIndex,
    });
    db.prepare(`
      INSERT INTO account_snapshots
        (account_id, snapshot_date, follower_count, redfox_index, work_count, raw_data, captured_at, score, analysis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
        follower_count = excluded.follower_count,
        redfox_index = excluded.redfox_index,
        work_count = excluded.work_count,
        raw_data = excluded.raw_data,
        captured_at = excluded.captured_at,
        score = excluded.score,
        analysis = excluded.analysis
    `).run(
      tracker.id, snapshotDate,
      metrics.followerCount, metrics.redfoxIndex, metrics.workCount,
      JSON.stringify(report), Date.now(),
      metrics.score,
      analysis ? JSON.stringify(analysis) : null,
    );
    setLocalData('diagnosis', tracker.id, report, Date.now() + 7 * 24 * 60 * 60 * 1000);
    return { report, tracker: updated, analysis };
  }

  async function refreshTrackedAccounts() {
    const trackers = listTrackers().filter(tracker => tracker.autoSync === true);
    const result = { selected: trackers.length, synced: 0, diagnosed: 0, apiCalls: 0, failed: [] };
    for (const tracker of trackers) {
      try {
        const synced = await syncTracker(tracker.id, {
          automatic: true,
          includeSourceData: tracker.plat === 'xhs',
        });
        result.synced += 1;
        result.apiCalls += 1;
        await diagnoseAndStoreTracker(listTrackers().find(item => item.id === tracker.id) || tracker, {
          snapshotDate: dateDaysAgo(1),
          sourceData: tracker.plat === 'xhs' ? synced._sourceData : null,
        });
        result.diagnosed += 1;
        if (tracker.plat !== 'xhs') result.apiCalls += 1;
      } catch (error) {
        result.failed.push({ id: tracker.id, name: tracker.name, error: error.message });
      }
    }
    logAction('tracker-refresh', 'cron', 'redfox+llm', result, result.apiCalls, 0);
    return result;
  }

  // 每日诊断「自己」账号（不管 autoSync，只看 group）
  async function diagnoseMyAccounts() {
    const mine = listTrackers().filter(t => t.group === '自己' || t.group_name === '自己');
    const result = { total: mine.length, done: 0, failed: 0, details: [] };
    for (const tracker of mine) {
      try {
        await diagnoseAndStoreTracker(tracker, {
          snapshotDate: dateDaysAgo(1),
        });
        result.done++;
      } catch (error) {
        result.failed++;
        result.details.push({ id: tracker.id, name: tracker.name, error: error.message });
        console.warn(`[cron] 我的账号诊断失败 ${tracker.name}:`, error.message);
      }
    }
    logAction('my-account-diagnosis', 'cron', 'redfox', result, result.done, 0);
    return result;
  }

  return {
    listTrackers, saveTracker, syncTracker, listTrackerWorks,
    diagnoseAndStoreTracker, listAccountSnapshots,
    refreshTrackedAccounts, diagnoseMyAccounts, restoreTrackerRetries,
    normalizeTrackerAccountId, trackerQuerySpec, trackerCollectionSpec,
    xhsTrackerAccounts, normalizeTrackerResult, trackerWorkId,
  };
}

module.exports = { make };
