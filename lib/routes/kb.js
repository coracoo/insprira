// 路由组：知识库（Obsidian / Notion）
// 依赖通过 ctx 注入：callLlmJson/getHotTrends/hotListPayload/
// getKbEntryFromCache/setKbEntryToCache/invalidateKbListCache/invalidateKbEntryCache/
// getKbEntriesFromCache/setKbEntriesToCache/getLocalData/setLocalData
const fs = require('fs');
const { db } = require('../db');
const { encryptKb, decryptKb } = require('../auth');
const { json, readBody } = require('../http');
const { scanVault, readEntry, writeNote, deleteNote, listFolders, listAllTags } = require('../../kb_obsidian');
const { searchPages, getPage, createPage, deletePage } = require('../../kb_notion');

async function tryRoute(req, res, url, ctx) {
  const {
    callLlmJson, getHotTrends, hotListPayload,
    getKbEntryFromCache, setKbEntryToCache,
    invalidateKbListCache, invalidateKbEntryCache,
    getKbEntriesFromCache, setKbEntriesToCache,
    getLocalData, setLocalData,
  } = ctx;

  if (url.pathname === '/api/_/kb/config' && req.method === 'GET') {
    const row = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!row) {
      json(res, 200, { ok: true, data: {
        obsidian: { configured: false, sourcePath: '' },
        notion: { configured: false, databaseId: '' },
      } });
      return true;
    }
    json(res, 200, {
      ok: true,
      data: {
        // 兼容旧字段
        sourceType: row.provider || '',
        sourcePath: row.source_path || '',
        notionConfigured: Boolean(row.notion_api_key),
        notionDatabaseId: row.notion_database_id || '',
        // 新结构：两个源独立
        obsidian: {
          configured: Boolean(row.source_path) && fs.existsSync(row.source_path),
          sourcePath: row.source_path || '',
        },
        notion: {
          configured: Boolean(row.notion_api_key),
          databaseId: row.notion_database_id || '',
        },
      },
    });
    return true;
  }

  if (url.pathname === '/api/_/kb/config' && req.method === 'POST') {
    const { data } = await readBody(req);
    if (!data || !data.sourceType) {
      json(res, 400, { ok: false, error: '缺少 sourceType' }); return true;
    }
    const sourceType = String(data.sourceType);
    const now = Date.now();
    const current = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current') || {};
    if (!['obsidian', 'notion'].includes(sourceType)) {
      json(res, 400, { ok: false, error: '知识库类型无效' }); return true;
    }
    // 两个源独立保存：obsidian 只动 source_path，notion 只动 notion_*
    let newSourcePath = current.source_path || '';
    let encryptedApiKey = current.notion_api_key || '';
    let databaseId = current.notion_database_id || '';
    if (sourceType === 'obsidian') {
      const sourcePath = String(data.sourcePath || '');
      if (sourcePath && (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory())) {
        json(res, 400, { ok: false, error: 'Obsidian 路径不是有效目录' }); return true;
      }
      newSourcePath = sourcePath;
    } else {
      const notionApiKey = String(data.notionApiKey || '');
      const notionDbId = String(data.notionDatabaseId || '');
      if (notionApiKey) encryptedApiKey = encryptKb(notionApiKey);
      if (notionDbId) databaseId = notionDbId;
      if (!encryptedApiKey || !databaseId) {
        json(res, 400, { ok: false, error: 'Notion API Key 和 Database ID 不能为空' }); return true;
      }
    }
    db.prepare(`
      INSERT INTO kb_config (source_type, provider, source_path, notion_api_key, notion_database_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type) DO UPDATE SET
        provider = excluded.provider,
        source_path = excluded.source_path,
        notion_api_key = excluded.notion_api_key,
        notion_database_id = excluded.notion_database_id,
        updated_at = excluded.updated_at
    `).run('current', sourceType, newSourcePath, encryptedApiKey, databaseId, current.created_at || now, now);
    if (sourceType === 'obsidian') {
      db.prepare("DELETE FROM kb_entries_cache WHERE source_type = 'obsidian'").run();
    } else {
      db.prepare("DELETE FROM kb_entries_cache WHERE source_type = 'notion'").run();
    }
    json(res, 200, { ok: true });
    return true;
  }

  // POST /api/_/kb/entries/analyze — 读取文章并对比热榜
  if (url.pathname === '/api/_/kb/entries/analyze' && req.method === 'POST') {
    const { data } = await readBody(req);
    const entryKey = String(data.entryKey || '');
    const force = data.force === true;
    if (!entryKey) { json(res, 400, { ok: false, error: '缺少 entryKey' }); return true; }
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config || !config.provider) { json(res, 404, { ok: false, error: '未配置知识库' }); return true; }
    let entry;
    if (config.provider === 'obsidian') {
      if (!config.source_path || !fs.existsSync(config.source_path)) { json(res, 404, { ok: false, error: 'Vault路径无效' }); return true; }
      try { entry = readEntry(config.source_path, entryKey); } catch (e) { json(res, 404, { ok: false, error: e.message }); return true; }
    } else if (config.provider === 'notion') {
      const apiKey = decryptKb(config.notion_api_key);
      if (!apiKey) { json(res, 404, { ok: false, error: 'Notion未配置' }); return true; }
      try { entry = await getPage(apiKey, entryKey); } catch (e) { json(res, 404, { ok: false, error: e.message }); return true; }
    } else { json(res, 404, { ok: false, error: '未知知识库类型' }); return true; }
    const latestSnapshot = db.prepare('SELECT MAX(completed_at) AS value FROM hot_batches').get()?.value || '';
    const analysisKey = `${config.provider}:${entryKey}`;
    const fingerprint = `${entry.updated_at || 0}:${latestSnapshot}`;
    if (!force) {
      const cached = getLocalData('kb_analysis', analysisKey);
      if (cached?.fingerprint === fingerprint && cached.result) {
        json(res, 200, { ok: true, data: cached.result, cached: true });
        return true;
      }
    }
    const [trends, keywords] = await Promise.all([
      (async () => { try { return getHotTrends(7).themes; } catch { return []; } })(),
      (async () => {
        return hotListPayload('all').data.slice(0, 80);
      })(),
    ]);
    const articleText = `${entry.title}\n标签：${(entry.tags || []).join(', ')}\n\n${entry.content || ''}`.slice(0, 4000);
    const trendsSummary = trends.slice(0, 20).map(t => `[${t.trend}] ${t.name} (${t.reason})`).join('\n') || '（暂无热榜趋势数据）';
    const keywordsList = keywords.slice(0, 60).map(k => k.title || k.key || '').filter(Boolean).join('、') || '（暂无热词数据）';
    const prompt = `你是一位自媒体内容策划专家。给定一篇文章和当前热榜数据，分析这篇文章与热榜的关联度。

## 文章信息
标题：${entry.title}
标签：${(entry.tags || []).join(', ')}
内容预览：
${articleText}

## 近7天热榜趋势 TOP20
${trendsSummary}

## 当前热词 TOP60
${keywordsList}

请以 JSON 格式返回分析结果（不要任何 markdown）：
{
  "topMatches": [
    {
      "trendTitle": "热榜主题标题",
      "relevanceScore": 85,
      "matchReason": "匹配原因",
      "trendDirection": "增长|稳定|冷却",
      "platform": "主要平台"
    }
  ],
  "extractedKeywords": ["文章热词1","文章热词2"],
  "suggestedAngle": "内容切入角度建议（1-2句）",
  "trendOutlook": "趋势判断：增长中/趋于稳定/热度冷却",
  "platformSuggestion": "最适合发布的平台"
}

只返回最相关的3个热榜主题，按关联度从高到低。关联度0-100，只返回60以上的主题。如果没有明显关联，返回空数组。`;
    let analysisResult;
    try {
      analysisResult = await callLlmJson([{ role: 'user', content: prompt }]);
    } catch (e) { json(res, 500, { ok: false, error: 'AI分析失败：' + e.message }); return true; }
    setLocalData(
      'kb_analysis',
      analysisKey,
      { fingerprint, result: analysisResult },
      Date.now() + 24 * 60 * 60 * 1000,
    );
    json(res, 200, { ok: true, data: analysisResult, cached: false });
    return true;
  }

  // /api/_/kb/entries/{id} — GET read, DELETE delete
  const entryRouteMatch = url.pathname.match(/^\/api\/_\/kb\/entries\/([^/]+)$/);
  if (entryRouteMatch && entryRouteMatch[1] !== 'link') {
    const entryKey = decodeURIComponent(entryRouteMatch[1]);
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (req.method === 'GET') {
      if (!config || !config.provider) { json(res, 404, { ok: false, error: '未配置知识库' }); return true; }
      const refresh = url.searchParams.get('refresh') === '1';
      if (!refresh) {
        const cached = getKbEntryFromCache(config.provider, entryKey);
        if (cached) { json(res, 200, { ok: true, data: cached, cached: true }); return true; }
      }
      if (config.provider === 'obsidian') {
        if (!config.source_path || !fs.existsSync(config.source_path)) { json(res, 404, { ok: false, error: 'Vault路径无效' }); return true; }
        try {
          const entry = readEntry(config.source_path, entryKey);
          setKbEntryToCache('obsidian', entry);
          json(res, 200, { ok: true, data: entry });
        } catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      if (config.provider === 'notion') {
        const apiKey = decryptKb(config.notion_api_key);
        try {
          const entry = await getPage(apiKey, entryKey);
          setKbEntryToCache('notion', entry);
          json(res, 200, { ok: true, data: entry });
        } catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      json(res, 404, { ok: false, error: '未知类型' }); return true;
    }
    if (req.method === 'DELETE') {
      if (!config || !config.provider) { json(res, 400, { ok: false, error: '未配置知识库' }); return true; }
      if (config.provider === 'obsidian') {
        try {
          deleteNote(config.source_path, entryKey);
          invalidateKbListCache('obsidian');
          invalidateKbEntryCache('obsidian', entryKey);
          db.prepare(`DELETE FROM local_data WHERE module = 'kb_analysis' AND data_key = ?`).run(`obsidian:${entryKey}`);
          json(res, 200, { ok: true });
        }
        catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      if (config.provider === 'notion') {
        const apiKey = decryptKb(config.notion_api_key);
        try {
          await deletePage(apiKey, entryKey);
          invalidateKbListCache('notion');
          invalidateKbEntryCache('notion', entryKey);
          db.prepare(`DELETE FROM local_data WHERE module = 'kb_analysis' AND data_key = ?`).run(`notion:${entryKey}`);
          json(res, 200, { ok: true });
        }
        catch (e) { json(res, 404, { ok: false, error: e.message }); }
        return true;
      }
      json(res, 400, { ok: false, error: '未知类型' }); return true;
    }
    return false;
  }

  // GET /api/_/kb/entries?q=&tag=&folder=&limit=50&offset=0
  if (url.pathname === '/api/_/kb/entries' && req.method === 'GET') {
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config) { json(res, 200, { ok: true, data: [] }); return true; }
    const source = String(url.searchParams.get('source') || config.provider || '');
    if (!['obsidian', 'notion'].includes(source)) { json(res, 200, { ok: true, data: [] }); return true; }
    if (source === 'obsidian' && (!config.source_path || !fs.existsSync(config.source_path))) {
      json(res, 200, { ok: true, data: { entries: [], folders: [], tags: [], total: 0 } });
      return true;
    }
    if (source === 'notion' && (!config.notion_api_key || !config.notion_database_id)) {
      json(res, 200, { ok: true, data: { entries: [], folders: [], tags: [], total: 0 } });
      return true;
    }
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    const folder = url.searchParams.get('folder') || '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
    const offset = Number(url.searchParams.get('offset') || 0);
    const refresh = url.searchParams.get('refresh') === '1';

    if (!q && !tag && !folder && !refresh) {
      const cached = getKbEntriesFromCache(source, q, tag, folder);
      if (cached) {
        const entries = cached.slice(offset, offset + limit);
        const folders = source === 'obsidian'
          ? listFolders(config.source_path)
          : [...new Set(cached.map(entry => entry.folder).filter(Boolean))].sort();
        const tags = source === 'obsidian'
          ? listAllTags(config.source_path)
          : [...new Set(cached.flatMap(entry => entry.tags || []))].sort();
        json(res, 200, { ok: true, data: { entries, folders, tags, total: cached.length, cached: true } });
        return true;
      }
    }

    if (source === 'obsidian') {
      const vaultPath = config.source_path;
      if (!vaultPath || !fs.existsSync(vaultPath)) { json(res, 200, { ok: true, data: [] }); return true; }
      const allEntries = scanVault(vaultPath, {});
      const matched = allEntries.filter(e => {
        if (q) {
          const lower = q.toLowerCase();
          if (!e.title.toLowerCase().includes(lower) && !(e.content_preview || '').toLowerCase().includes(lower) && !e.tags.some(t => t.toLowerCase().includes(lower))) return false;
        }
        if (tag && !e.tags.some(t => t.toLowerCase() === tag.toLowerCase())) return false;
        if (folder && e.folder !== folder) return false;
        return true;
      });
      const filtered = matched.slice(offset, offset + limit);
      const folders = listFolders(vaultPath);
      const tags = listAllTags(vaultPath);
      if (!q && !tag && !folder) setKbEntriesToCache('obsidian', allEntries);
      json(res, 200, { ok: true, data: { entries: filtered, folders, tags, total: matched.length } });
      return true;
    }
    if (source === 'notion') {
      const apiKey = decryptKb(config.notion_api_key);
      if (!apiKey) { json(res, 200, { ok: true, data: [] }); return true; }
      const allEntries = await searchPages(apiKey, config.notion_database_id, { query: q, tag, folder });
      if (!q && !tag && !folder) setKbEntriesToCache('notion', allEntries);
      const entries = allEntries.slice(offset, offset + limit);
      const folders = [...new Set(allEntries.map(entry => entry.folder).filter(Boolean))].sort();
      const tags = [...new Set(allEntries.flatMap(entry => entry.tags || []))].sort();
      json(res, 200, { ok: true, data: { entries, folders, tags, total: allEntries.length } });
      return true;
    }
    json(res, 200, { ok: true, data: [] });
    return true;
  }

  // POST /api/_/kb/entries  新建条目
  if (url.pathname === '/api/_/kb/entries' && req.method === 'POST') {
    const { data } = await readBody(req);
    const title = String(data.title || '').trim();
    if (!title) { json(res, 400, { ok: false, error: '标题不能为空' }); return true; }
    const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [];
    const folder = String(data.folder || '');
    const content = String(data.content || '');
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config || !config.provider) { json(res, 400, { ok: false, error: '未配置知识库' }); return true; }
    const target = ['obsidian', 'notion'].includes(data.target) ? data.target : config.provider;
    if (target === 'obsidian') {
      if (!config.source_path || !fs.existsSync(config.source_path)) { json(res, 400, { ok: false, error: 'Obsidian Vault 路径无效，请在知识库配置中设置' }); return true; }
      try {
        const entryKey = writeNote(config.source_path, folder, title, tags, content);
        const entry = readEntry(config.source_path, entryKey);
        invalidateKbListCache('obsidian');
        setKbEntryToCache('obsidian', entry);
        json(res, 200, { ok: true, data: entry });
      } catch (e) { json(res, 500, { ok: false, error: e.message }); }
      return true;
    }
    if (target === 'notion') {
      const apiKey = decryptKb(config.notion_api_key);
      const dbId = config.notion_database_id;
      if (!apiKey || !dbId) { json(res, 400, { ok: false, error: 'Notion 未配置，请在知识库配置中设置' }); return true; }
      try {
        const entryKey = await createPage(apiKey, dbId, title, tags, folder, content);
        const entry = await getPage(apiKey, entryKey);
        invalidateKbListCache('notion');
        setKbEntryToCache('notion', entry);
        json(res, 200, { ok: true, data: entry });
      } catch (e) { json(res, 500, { ok: false, error: e.message }); }
      return true;
    }
    json(res, 400, { ok: false, error: '未知类型' });
    return true;
  }

  // POST /api/_/kb/entries/link 关联到选题
  if (url.pathname === '/api/_/kb/entries/link' && req.method === 'POST') {
    const { data } = await readBody(req);
    const inspirationId = String(data.inspirationId || '');
    const entryKey = String(data.entryKey || '');
    const sourceType = String(data.sourceType || 'obsidian');
    if (!inspirationId || !entryKey) { json(res, 400, { ok: false, error: '缺少参数' }); return true; }
    const inspiration = db.prepare('SELECT id FROM inspirations WHERE id = ?').get(inspirationId);
    if (!inspiration) { json(res, 404, { ok: false, error: '选题不存在' }); return true; }
    const config = db.prepare('SELECT provider FROM kb_config WHERE source_type = ?').get('current');
    if (!config || config.provider !== sourceType) {
      json(res, 400, { ok: false, error: '知识库来源与当前配置不一致' }); return true;
    }
    const kbLink = JSON.stringify({ source_type: sourceType, entry_key: entryKey });
    db.prepare('UPDATE inspirations SET kb_link = ? WHERE id = ?').run(kbLink, inspirationId);
    json(res, 200, { ok: true });
    return true;
  }

  // GET /api/_/kb/export
  if (url.pathname === '/api/_/kb/export' && req.method === 'GET') {
    const format = url.searchParams.get('format') || 'json';
    const ids = url.searchParams.getAll('id');
    if (!ids.length && url.searchParams.get('ids')) ids.push(...url.searchParams.get('ids').split(','));
    const config = db.prepare('SELECT * FROM kb_config WHERE source_type = ?').get('current');
    if (!config || !config.provider) { json(res, 400, { ok: false, error: '未配置知识库' }); return true; }
    const results = [];
    if (config.provider === 'obsidian') {
      for (const entryKey of ids) {
        try { results.push(readEntry(config.source_path, entryKey)); } catch {}
      }
    } else {
      const apiKey = decryptKb(config.notion_api_key);
      for (const entryKey of ids) {
        try { results.push(await getPage(apiKey, entryKey)); } catch {}
      }
    }
    if (format === 'md') {
      const md = results.map(e => `# ${e.title}\n\nTags: ${e.tags.join(', ')}\n\n${e.content}`).join('\n\n---\n\n');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
      res.end(md);
      return true;
    }
    json(res, 200, { ok: true, data: results });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
