// Skill 系统：本地 markdown 技能库 + GitHub 社区更新 + LLM 分类 + 热榜绑定
// make(...) 工厂注入路径/热榜/cron/local_data/llm 依赖，避免循环
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { gitBlobSha } = require('./utils');
const { logAction } = require('./observability');

const LLM_SKILL_CATEGORIES = ['热榜', '信息源', '检索', '创作', '分析', '媒体', '综合'];

// Slug 命名规则确定性分类：覆盖 ~80% skill，不调 LLM
// 顺序敏感：先匹配先返回。规则的 cat 必须在 LLM_SKILL_CATEGORIES 内
const SLUG_RULES = [
  // 热榜：排行榜、TOP、飙升、trending hub
  { re: /-daily-hot|-dailytop|-weeklytop|-lowtop|-10w-hot|-original-hot|hot-trend|content-surge|weekly-surge|fastest-growing|rise-ranking|top-account|big-accounts?|similar-account|trending-hub|astock-top/i, cat: '热榜' },
  // 信息源：主题 feed / 订阅 / A股 feed
  { re: /-ai-feed$|-feed$|subscribe$/i, cat: '信息源' },
  // 检索：搜索/爬取/关键词搜索
  { re: /-search$|-crawler$|-works-crawler$|websearch$|keywords-search|portfolio-search|account-search/i, cat: '检索' },
  // 创作：写作/改写/标题/违禁词
  { re: /-write$|-rewrite$|-title$|wordcheck|prohibited-word|copywrite|prompt-expert|ops-writer/i, cat: '创作' },
  // 分析：诊断/分析/评论/investigator/distiller/score
  { re: /account-diagnosis|account-analyzer|note-analyzer|-comment$|analyzer$|trend-|^stock-analysis|investigator|distiller|title-score|cn-last30days/i, cat: '分析' },
  // 媒体：图片/视频/封面（包括 -lite/-v2 后缀）
  { re: /-gen(-[\w]+)?$|^image-|^video-|cover$|-downloader$|seedream/i, cat: '媒体' },
  // 综合：skill 元工具、文档处理、others
  { re: /skill-|^optimize-|generator$|extractor$|^stock-feed|keywords-accounts/i, cat: '综合' },
];

// LLM 兜底用的 few-shot 样例（每类 3-5 个真实 slug）
const CATEGORY_EXAMPLES = {
  '热榜':   ['douyin-daily-hot', 'xiaohongshu-dailytop', 'wechat-10w-hot', 'douyin-content-surge', 'douyin-top-account', 'trending-hub-top10'],
  '信息源': ['gzh-ai-feed', 'bili-ai-feed', 'cultural-tourism-bili-feed', 'gzh-subscribe'],
  '检索':   ['douyin-search', 'douyin-works-crawler', 'kimi-websearch', 'tiktok-account-search'],
  '创作':   ['wechat-write', 'multi-rewrite', 'xiaohongshu-title', 'wechat-prohibited-word'],
  '分析':   ['douyin-account-diagnosis', 'xiaohongshu-note-analyzer', 'bilibili-comment', 'stock-analysis'],
  '媒体':   ['image-gen', 'seedance-video-gen', 'xiaohongshu-cover', 'video-downloader'],
  '综合':   ['optimize-skill-md', 'redfox-skill-generator', 'pdf-image-text-extractor'],
};

function classifyBySlug(slug) {
  for (const rule of SLUG_RULES) {
    if (rule.re.test(slug)) return rule.cat;
  }
  return null;
}

// Skill → 灵感熔炉 source 映射（"绑定到热榜"按钮用的）
const SKILL_TO_SOURCE = {
  'douyin-daily-hot':     { sourceKey: 'dy',          label: '抖音 TOP50',  cronId: 'hot-daily-dy' },
  'xiaohongshu-dailytop': { sourceKey: 'xhs',         label: '小红书 TOP50', cronId: 'hot-daily-xhs' },
  'wechat-original-hot':  { sourceKey: 'gzh',         label: '公众号热门',  cronId: 'hot-daily-gzh' },
  'gzh-ai-feed':          { sourceKey: 'ai-gzh',      label: 'AI 公众号',   cronId: 'hot-daily-ai-gzh' },
  'bili-ai-feed':         { sourceKey: 'ai-bili',     label: 'AI B站',      cronId: 'hot-daily-ai-bili' },
  'xiaohongshu-ai-feed':  { sourceKey: 'ai-xhs',      label: 'AI 小红书',   cronId: 'hot-daily-ai-xhs' },
  'douyin-ai-feed':       { sourceKey: 'ai-dy',       label: 'AI 抖音',     cronId: 'hot-daily-ai-dy' },
  'ks-ai-feed':           { sourceKey: 'ai-ks',       label: 'AI 快手',     cronId: 'hot-daily-ai-ks' },
  'wechat-channels-ai-feed': { sourceKey: 'ai-sph',   label: 'AI 视频号',   cronId: 'hot-daily-ai-sph' },
  'playlet-douyin-feed':  { sourceKey: 'playlet-dy',  label: '短剧抖音',    cronId: 'hot-daily-playlet-dy' },
  'playlet-wechat-feed':  { sourceKey: 'playlet-gzh', label: '短剧公众号',  cronId: 'hot-daily-playlet-gzh' },
  'playlet-bili-feed':       { sourceKey: 'playlet-bili', label: '短剧B站',     cronId: 'hot-daily-playlet-bili' },
  'playlet-xiaohongshu-feed': { sourceKey: 'playlet-xhs', label: '短剧小红书',  cronId: 'hot-daily-playlet-xhs' },
  'cultural-tourism-bilibili-feed':    { sourceKey: 'cultural-tourism-bili', label: '文旅B站',    cronId: 'hot-daily-cultural-tourism-bili' },
  'cultural-tourism-douyin-feed':      { sourceKey: 'cultural-tourism-dy',  label: '文旅抖音',    cronId: 'hot-daily-cultural-tourism-dy' },
  'cultural-tourism-wechat-feed':      { sourceKey: 'cultural-tourism-gzh', label: '文旅公众号',  cronId: 'hot-daily-cultural-tourism-gzh' },
  'cultural-tourism-xiaohongshu-feed': { sourceKey: 'cultural-tourism-xhs', label: '文旅小红书',  cronId: 'hot-daily-cultural-tourism-xhs' },
};

const SKILL_CACHE_TTL_MS = 60 * 1000;

function parseSkillFile(skillPath, rootDir) {
  let content = fs.readFileSync(skillPath, 'utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const metadata = {};
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (match && match[2]) metadata[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const slug = path.basename(path.dirname(skillPath));
  let title = metadata.title?.trim() || '';
  if (!title) {
    const bodyStart = frontmatter ? frontmatter[0].length : 0;
    const body = content.slice(bodyStart);
    const bodyNoCode = body.replace(/```[\s\S]*?```/g, '');
    const headingMatch = bodyNoCode.match(/^#\s+(.+)$/m);
    const rawTitle = headingMatch?.[1]?.trim() || '';
    title = /^#|export|追加到|\.sh\s*$|~\//i.test(rawTitle) ? '' : rawTitle;
  }
  if (!title) title = metadata.name || '';
  if (!title || title === slug) {
    const desc = metadata.description || '';
    let extracted = desc.split(/[。，！？；;]/)[0].trim();
    const cutIdx = Math.min(...['专注于', '是', '用于', '—', ' - ', '（', '：', ':'].map(marker => {
      const i = extracted.indexOf(marker);
      return i > 0 ? i : Infinity;
    }));
    if (cutIdx !== Infinity && cutIdx > 3) extracted = extracted.slice(0, cutIdx).trim();
    if (extracted && extracted.length >= 4 && extracted.length <= 40) title = extracted;
  }
  if (!title) title = slug;
  const text = `${slug} ${title} ${metadata.description || ''}`;
  let category = '综合';
  if (/douyin|抖音/i.test(text)) category = '抖音';
  else if (/xiaohongshu|小红书/i.test(text)) category = '小红书';
  else if (/wechat|gzh|公众号/i.test(text)) category = '公众号';
  else if (/hot|trend|热榜/i.test(text)) category = '热榜';
  else if (/write|rewrite|创作|改写/i.test(text)) category = '创作';
  return {
    slug,
    name: metadata.name || slug,
    title,
    description: metadata.description || '',
    category,
    path: path.relative(rootDir, skillPath),
    content,
  };
}

async function githubJson(apiPath) {
  const token = (process.env.GITHUB_API_TOKEN || '').trim();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'insprira',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`https://api.github.com${apiPath}`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`GitHub 网络请求失败：${e.message || e}`);
  }
  if (response.ok) return response.json();
  // 把 403/401/429 翻译成人话，否则裸出 HTTP 码
  const status = response.status;
  const hint = !token && (status === 403 || status === 429)
    ? '（未配置 GITHUB_API_TOKEN，匿名请求频率上限 60/hr；请到设置页 → 维护 .env 配置 Personal access token）'
    : (status === 403 || status === 401)
      ? '（Token 可能过期或权限被撤销；请到设置页 → 维护 .env 更新 GITHUB_API_TOKEN）'
      : '';
  let detail = '';
  try {
    const body = await response.json();
    if (body?.message) detail = ` · ${body.message}`;
  } catch {}
  throw new Error(`GitHub API ${status}${hint}${detail}`);
}

function compareSkillManifests(localFiles, remoteFiles) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [file, sha] of remoteFiles) {
    if (!localFiles.has(file)) added.push(file);
    else if (localFiles.get(file) !== sha) changed.push(file);
  }
  for (const file of localFiles.keys()) {
    if (!remoteFiles.has(file)) removed.push(file);
  }
  const slugsFrom = (files) => [...new Set(files.map(file => file.split('/')[0]).filter(Boolean))];
  const addedSlugs = slugsFrom(added);
  const changedSlugs = slugsFrom(changed);
  const removedSlugs = slugsFrom(removed);
  return {
    available: Boolean(added.length || changed.length || removed.length),
    added,
    changed,
    removed,
    addedSlugs,
    changedSlugs,
    removedSlugs,
  };
}

function make(deps) {
  const {
    SKILLS_ROOT, SKILLS_REPO_ROOT, SKILLS_GITHUB_REPO, SKILLS_NEW_BADGE_MS,
    rootDir, HOT_SOURCE_CONFIG, cronTimers, scheduleCronJob,
    getLocalData, setLocalData, callLlm, callLlmJson, execFileAsync,
  } = deps;

  let _skillCache = { fingerprint: '', skills: null, ts: 0 };
  let activeSkillUpdate = null;

  function skillUpdateState() {
    const state = getLocalData('skills', 'community-update') || {};
    const newSlugs = state.newUntil > Date.now() && Array.isArray(state.newSlugs)
      ? new Set(state.newSlugs)
      : new Set();
    return { ...state, newSlugs };
  }

  function getSkillSourceBinding(slug) {
    return SKILL_TO_SOURCE[slug] || null;
  }

  function bindSkillToSource(slug) {
    const binding = getSkillSourceBinding(slug);
    if (!binding) throw new Error(`Skill ${slug} 暂未配置绑定映射`);
    const HOT_SOURCE_CONFIG = deps.HOT_SOURCE_CONFIG();
    const cronTimers = deps.cronTimers();
    const cfg = HOT_SOURCE_CONFIG[binding.sourceKey];
    if (!cfg) throw new Error(`找不到热榜配置 ${binding.sourceKey}`);
    const cronRow = db.prepare('SELECT id, enabled FROM crontab WHERE id = ?').get(binding.cronId);
    if (cronRow) {
      db.prepare('DELETE FROM crontab WHERE id = ?').run(binding.cronId);
      const timer = cronTimers.get(binding.cronId);
      if (timer) { clearTimeout(timer); cronTimers.delete(binding.cronId); }
      return { sourceKey: binding.sourceKey, cronId: binding.cronId, enabled: false, wasEnabled: Boolean(cronRow.enabled) };
    }
    const now = Date.now();
    db.prepare(`
      INSERT INTO crontab (id, name, cron_expr, enabled, task_type, task_config, notify_on_failure, notify_on_success, created_at)
      VALUES (?, ?, ?, 1, 'hot-platform', ?, 1, 0, ?)
    `).run(
      binding.cronId,
      cfg.label,
      cfg.cronExpr,
      JSON.stringify({ platform: binding.sourceKey }),
      now,
    );
    scheduleCronJob(binding.cronId, cfg.cronExpr, 'hot-platform', { platform: binding.sourceKey });
    return { sourceKey: binding.sourceKey, cronId: binding.cronId, enabled: true, wasEnabled: false };
  }

  async function classifyAllSkills(skills, options = {}) {
    if (!skills.length) return 0;
    const force = options.force === true;
    const needsClassify = [];
    let slugHit = 0;
    for (const skill of skills) {
      const signature = `${skill.slug}|${skill.title}|${String(skill.description || '').slice(0, 200)}`;
      if (!force) {
        const existing = db.prepare('SELECT * FROM skill_classifications WHERE slug = ?').get(skill.slug);
        if (existing && existing.skill_signature === signature) continue;
      }
      // 第 1 层：slug 规则确定性分类
      const slugCat = classifyBySlug(skill.slug);
      if (slugCat) {
        const now = Date.now();
        db.prepare(`
          INSERT INTO skill_classifications (slug, llm_category, original_category, analyzed_at, skill_signature)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            llm_category = excluded.llm_category,
            original_category = excluded.original_category,
            analyzed_at = excluded.analyzed_at,
            skill_signature = excluded.skill_signature
        `).run(skill.slug, slugCat, skill.category, now, signature);
        slugHit++;
        continue;
      }
      needsClassify.push({ skill, signature });
    }
    console.log(`[skill] slug 规则覆盖 ${slugHit} 个，剩 ${needsClassify.length} 个走 LLM`);
    if (!needsClassify.length) return slugHit;

    const BATCH = 20;
    let saved = 0;
    const examplesBlock = LLM_SKILL_CATEGORIES.map(c =>
      `${c}: ${(CATEGORY_EXAMPLES[c] || []).join(', ')}`
    ).join('\n');

    for (let i = 0; i < needsClassify.length; i += BATCH) {
      const batch = needsClassify.slice(i, i + BATCH);
      const lines = batch.map(({ skill }) =>
        `【${skill.slug}】标题：${skill.title}；描述：${(skill.description || '无').slice(0, 100)}`
      ).join('\n');

      const messages = [
        {
          role: 'system',
          content: `你是一个 Skill 分类器。根据每个 skill 的 slug / 标题 / 描述，从以下七类中选择最合适的一个：
- 热榜：内容排行榜、TOP50、每日/每周/飙升榜、帐号榜单（top-account/similar-account）
- 信息源：按主题/标签聚合的内容 feed（AI/文旅/出海），订阅源
- 检索：按关键词/帐号/作品搜索、内容爬取
- 创作：文案写作、改写、标题生成、违禁词检测
- 分析：帐号诊断、内容/趋势/评论分析
- 媒体：图片/视频/封面生成、视频下载
- 综合：Skill 元工具（生成/优化 skill.md）、文档处理、其他

每类参考样例：
${examplesBlock}

严格只按以下格式输出（每行一个，无其他内容）：
<slug>:<类别>
禁止输出：解释、XML 标签、JSON。`,
        },
        { role: 'user', content: lines },
      ];

      let raw = '';
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          raw = await callLlm(messages, { temperature: 0, maxTokens: 4096 });
          break;
        } catch (e) {
          const isRateLimit = e.message.includes('速率限制') || e.message.includes('429') || e.message.includes('rate limit');
          if (isRateLimit && attempt < 3) {
            const delay = 15 * 1000 * (attempt + 1);
            console.warn(`[skill] 批量分类限速批次 ${i/BATCH+1}，${delay}ms 后重试…`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.warn(`[skill] 批量分类批次 ${i/BATCH+1} 失败:`, e.message);
          break;
        }
      }

      const resultMap = new Map();
      for (const line of raw.replace(/<[^>]+>/g, '').split('\n')) {
        const colonIdx = line.lastIndexOf(':');
        if (colonIdx < 0) continue;
        const slug = line.slice(0, colonIdx).trim();
        const cat = line.slice(colonIdx + 1).trim();
        if (slug) resultMap.set(slug, cat);
      }

      const now = Date.now();
      const upsert = db.prepare(`
        INSERT INTO skill_classifications (slug, llm_category, original_category, analyzed_at, skill_signature)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          llm_category = excluded.llm_category,
          original_category = excluded.original_category,
          analyzed_at = excluded.analyzed_at,
          skill_signature = excluded.skill_signature
      `);

      for (const { skill, signature } of batch) {
        let category = resultMap.get(skill.slug) || '';
        if (!LLM_SKILL_CATEGORIES.includes(category)) {
          for (const c of LLM_SKILL_CATEGORIES) {
            if (category.includes(c) || c.includes(category)) { category = c; break; }
          }
        }
        if (LLM_SKILL_CATEGORIES.includes(category)) {
          upsert.run(skill.slug, category, skill.category, now, signature);
          saved++;
        }
      }
      if (i + BATCH < needsClassify.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log(`[skill] LLM 兜底分类完成：${saved}/${needsClassify.length}`);
    return slugHit + saved;
  }

  function listSkills() {
    if (!fs.existsSync(SKILLS_ROOT)) return [];
    let fingerprint = '';
    try {
      const names = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true });
      for (const entry of names) {
        if (!entry.isDirectory()) continue;
        const p = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
        if (fs.existsSync(p)) {
          const st = fs.statSync(p);
          fingerprint += `${entry.name}:${st.mtimeMs}|`;
        }
      }
    } catch {}
    try {
      const lastClassify = db.prepare('SELECT MAX(analyzed_at) AS t FROM skill_classifications').get();
      fingerprint += `cls:${lastClassify?.t || 0}`;
    } catch {}
    const now = Date.now();
    if (_skillCache.skills && _skillCache.fingerprint === fingerprint && now - _skillCache.ts < SKILL_CACHE_TTL_MS) {
      return _skillCache.skills;
    }
    const state = skillUpdateState();
    const rows = db.prepare('SELECT slug, llm_category FROM skill_classifications').all();
    const cache = new Map(rows.map(r => [r.slug, r.llm_category]));
    const skills = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const skillPath = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillPath)) return null;
        const skill = parseSkillFile(skillPath, rootDir);
        const stat = fs.statSync(skillPath);
        return {
          ...skill,
          isNew: state.newSlugs.has(skill.slug),
          llmCategory: cache.get(skill.slug) || null,
          updatedAt: stat.mtimeMs || stat.ctimeMs || 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    _skillCache = { fingerprint, skills, ts: now };
    return skills;
  }

  function invalidateSkillCache() {
    _skillCache = { fingerprint: '', skills: null, ts: 0 };
  }

  function getSkill(slug) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
    const skillPath = path.join(SKILLS_ROOT, slug, 'SKILL.md');
    if (!skillPath.startsWith(`${SKILLS_ROOT}${path.sep}`) || !fs.existsSync(skillPath)) return null;
    const skill = parseSkillFile(skillPath, rootDir);
    return { ...skill, isNew: skillUpdateState().newSlugs.has(skill.slug) };
  }

  function localSkillManifest() {
    const files = new Map();
    if (!fs.existsSync(SKILLS_ROOT)) return files;
    const walk = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath, relative);
        else if (entry.isFile()) files.set(relative, gitBlobSha(fs.readFileSync(fullPath)));
      }
    };
    walk(SKILLS_ROOT);
    return files;
  }

  async function remoteSkillManifest() {
    const commit = await githubJson(`/repos/${SKILLS_GITHUB_REPO}/commits/main`);
    const treeSha = commit?.commit?.tree?.sha;
    if (!treeSha) throw new Error('无法读取 GitHub Skill 版本');
    const tree = await githubJson(`/repos/${SKILLS_GITHUB_REPO}/git/trees/${treeSha}?recursive=1`);
    const files = new Map();
    for (const entry of tree.tree || []) {
      if (entry.type !== 'blob' || !entry.path.startsWith('skills/')) continue;
      files.set(entry.path.slice('skills/'.length), entry.sha);
    }
    return {
      commitSha: commit.sha,
      commitTime: commit.commit?.committer?.date || commit.commit?.author?.date || '',
      message: String(commit.commit?.message || '').split('\n')[0],
      files,
    };
  }

  async function communitySkillUpdateStatus() {
    const remote = await remoteSkillManifest();
    const comparison = compareSkillManifests(localSkillManifest(), remote.files);
    const state = skillUpdateState();
    return {
      ...comparison,
      remoteSha: remote.commitSha,
      remoteTime: remote.commitTime,
      message: remote.message,
      localSha: state.remoteSha || '',
      localCount: listSkills().length,
      checkedAt: Date.now(),
    };
  }

  async function updateCommunitySkills() {
    if (activeSkillUpdate) return activeSkillUpdate;
    activeSkillUpdate = (async () => {
      invalidateSkillCache();
      const status = await communitySkillUpdateStatus();
      if (!status.available) return { ...status, updated: false, skills: listSkills() };
      const workRoot = path.join(SKILLS_REPO_ROOT, `.skill-update-${require('crypto').randomUUID()}`);
      const archivePath = path.join(workRoot, 'community.zip');
      const extractRoot = path.join(workRoot, 'extract');
      const backupPath = path.join(SKILLS_REPO_ROOT, `.skills-backup-${Date.now()}`);
      fs.mkdirSync(extractRoot, { recursive: true });
      try {
        const response = await fetch(
          `https://codeload.github.com/${SKILLS_GITHUB_REPO}/zip/${status.remoteSha}`,
          { signal: AbortSignal.timeout(60000) },
        );
        if (!response.ok) throw new Error(`Skill 下载失败：HTTP ${response.status}`);
        fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
        await execFileAsync('python3', ['-c', `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    z.extractall(sys.argv[2])
`, archivePath, extractRoot], {
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const extractedRepo = fs.readdirSync(extractRoot, { withFileTypes: true })
          .find(entry => entry.isDirectory());
        const nextSkills = extractedRepo
          ? path.join(extractRoot, extractedRepo.name, 'skills')
          : '';
        const nextCount = nextSkills && fs.existsSync(nextSkills)
          ? fs.readdirSync(nextSkills, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
          : 0;
        if (!nextCount || !fs.existsSync(path.join(nextSkills, 'trending-hub', 'SKILL.md'))) {
          throw new Error('下载包校验失败，未替换本地 Skill');
        }
        if (fs.existsSync(SKILLS_ROOT)) fs.renameSync(SKILLS_ROOT, backupPath);
        try {
          fs.renameSync(nextSkills, SKILLS_ROOT);
        } catch (error) {
          if (fs.existsSync(backupPath) && !fs.existsSync(SKILLS_ROOT)) {
            fs.renameSync(backupPath, SKILLS_ROOT);
          }
          throw error;
        }
        fs.rmSync(backupPath, { recursive: true, force: true });
        invalidateSkillCache();
        const updatedAt = Date.now();
        setLocalData('skills', 'community-update', {
          remoteSha: status.remoteSha,
          remoteTime: status.remoteTime,
          updatedAt,
          newSlugs: status.addedSlugs,
          newUntil: updatedAt + SKILLS_NEW_BADGE_MS,
        });
        try {
          const currentSkills = listSkills();
          const targets = status.addedSlugs.length
            ? currentSkills.filter(skill => status.addedSlugs.includes(skill.slug))
            : currentSkills;
          await classifyAllSkills(targets);
        } catch (e) {
          console.warn('[skill] 落库自动分类异常:', e.message);
        }
        const result = {
          ...status,
          updated: true,
          updatedAt,
          localCount: listSkills().length,
          skills: listSkills().map(({ content, ...skill }) => skill),
        };
        logAction('update-community-skills', 'button', 'github', {
          remoteSha: status.remoteSha,
          added: status.added.length,
          changed: status.changed.length,
          removed: status.removed.length,
          newSlugs: status.addedSlugs,
        });
        return result;
      } finally {
        try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch {}
        activeSkillUpdate = null;
      }
    })();
    return activeSkillUpdate;
  }

  return {
    parseSkillFile: (p) => parseSkillFile(p, rootDir),
    skillUpdateState,
    getSkillSourceBinding,
    bindSkillToSource,
    classifyAllSkills,
    listSkills,
    invalidateSkillCache,
    getSkill,
    localSkillManifest,
    remoteSkillManifest,
    compareSkillManifests,
    communitySkillUpdateStatus,
    updateCommunitySkills,
  };
}

module.exports = { make, LLM_SKILL_CATEGORIES, SLUG_RULES, CATEGORY_EXAMPLES, SKILL_TO_SOURCE, githubJson, compareSkillManifests };
