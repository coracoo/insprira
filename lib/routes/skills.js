// 路由组：Skill 中心（RedFox 社区 / Hub / 自定义 / 模板 / 绑定 / 分类 / 社区更新）
// 依赖通过 ctx 注入：见 server.js 调用处
const { db } = require('../db');
const { json, readBody } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const {
    listSkills, getSkill, listAllAgentSkills, getSkillSourceBinding, bindSkillToSource,
    classifyAllSkills, communitySkillUpdateStatus, updateCommunitySkills,
    listCustomSkills, getCustomSkill, createCustomSkill, updateCustomSkill, deleteCustomSkill,
    listHubSkills, installHubSkill, uninstallHubSkill, listHubInstalled,
    listSkillTemplates, generateSkillFromTemplate,
  } = ctx;

  // 合并三目录（Agent / 命令补全用，去重）
  if (url.pathname === '/api/_/skills/all' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listAllAgentSkills().map(({ content, ...s }) => s) });
    return true;
  }

  // ========== RedFox 社区（现有）==========
  if (url.pathname === '/api/_/skills' && req.method === 'GET') {
    const skills = listSkills().map(({ content, ...skill }) => {
      const binding = getSkillSourceBinding(skill.slug);
      return {
        ...skill,
        sourceBinding: binding,
        cronEnabled: binding ? Boolean(db.prepare('SELECT enabled FROM crontab WHERE id = ?').get(binding.cronId)?.enabled) : false,
      };
    });
    json(res, 200, { ok: true, data: skills });
    return true;
  }

  const bindSkillMatch = url.pathname.match(/^\/api\/_\/skills\/([^/]+)\/bind-source$/);
  if (bindSkillMatch && req.method === 'POST') {
    const slug = decodeURIComponent(bindSkillMatch[1]);
    try {
      const result = bindSkillToSource(slug);
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  if (url.pathname === '/api/_/skills/classify' && req.method === 'POST') {
    const force = url.searchParams.get('force') === '1';
    const all = listSkills();
    const done = await classifyAllSkills(all, { force });
    json(res, 200, { ok: true, data: { total: all.length, done, force } });
    return true;
  }

  if (url.pathname === '/api/_/skills/status' && req.method === 'GET') {
    try {
      json(res, 200, { ok: true, data: await communitySkillUpdateStatus() });
    } catch (error) {
      json(res, 502, { ok: false, error: `检查 Skill 更新失败：${error.message}` });
    }
    return true;
  }

  if (url.pathname === '/api/_/skills/update' && req.method === 'POST') {
    try {
      const { data } = await readBody(req);
      const selection = data && (data.add || data.change || data.remove)
        ? {
            add: Array.isArray(data.add) ? data.add.filter(Boolean) : [],
            change: Array.isArray(data.change) ? data.change.filter(Boolean) : [],
            remove: Array.isArray(data.remove) ? data.remove.filter(Boolean) : [],
          }
        : undefined;
      json(res, 200, { ok: true, data: await updateCommunitySkills(selection) });
    } catch (error) {
      json(res, 500, { ok: false, error: `更新 Skill 失败：${error.message}` });
    }
    return true;
  }

  // ========== 自定义 Skill ==========
  if (url.pathname === '/api/_/skills/custom' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listCustomSkills().map(({ content, ...s }) => s) });
    return true;
  }

  if (url.pathname === '/api/_/skills/custom' && req.method === 'POST') {
    try {
      const { data } = await readBody(req);
      const result = createCustomSkill(data);
      json(res, 200, { ok: true, data: { ...result, content: undefined } });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  const customSlugMatch = url.pathname.match(/^\/api\/_\/skills\/custom\/([a-z0-9-]+)$/i);
  if (customSlugMatch) {
    const slug = customSlugMatch[1];
    if (req.method === 'GET') {
      const skill = getCustomSkill(slug);
      if (!skill) { json(res, 404, { ok: false, error: '自定义 Skill 不存在' }); return true; }
      json(res, 200, { ok: true, data: skill });
      return true;
    }
    if (req.method === 'PUT') {
      try {
        const { data } = await readBody(req);
        const result = updateCustomSkill(slug, data);
        json(res, 200, { ok: true, data: result });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (req.method === 'DELETE') {
      try {
        json(res, 200, { ok: true, data: deleteCustomSkill(slug) });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
  }

  // ========== Skill Hub (Anthropic 官方) ==========
  // 已安装的（默认展示）
  if (url.pathname === '/api/_/skills/hub/installed' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listHubInstalled().map(({ content, ...s }) => s) });
    return true;
  }

  // 搜索 Anthropic 全部（按需触发）
  if (url.pathname === '/api/_/skills/hub' && req.method === 'GET') {
    try {
      const force = url.searchParams.get('force') === '1';
      const all = await listHubSkills(force);
      // 可选过滤
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const data = q
        ? all.filter(s => (s.name + ' ' + s.slug + ' ' + s.description).toLowerCase().includes(q))
        : all;
      // 标记已安装
      const installed = new Set(listHubInstalled().map(s => s.slug));
      data.forEach(s => { s.installed = installed.has(s.slug); });
      json(res, 200, { ok: true, data });
    } catch (e) { json(res, 502, { ok: false, error: `拉取 Hub 失败：${e.message}` }); }
    return true;
  }

  const hubInstallMatch = url.pathname.match(/^\/api\/_\/skills\/hub\/([a-z0-9-]+)\/install$/i);
  if (hubInstallMatch && req.method === 'POST') {
    try {
      const { data } = await readBody(req);
      const result = await installHubSkill(hubInstallMatch[1], data || {});
      json(res, 200, { ok: true, data: result });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  const hubUninstallMatch = url.pathname.match(/^\/api\/_\/skills\/hub\/([a-z0-9-]+)\/uninstall$/i);
  if (hubUninstallMatch && req.method === 'POST') {
    try {
      json(res, 200, { ok: true, data: uninstallHubSkill(hubUninstallMatch[1]) });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  // ========== 模板 ==========
  if (url.pathname === '/api/_/skills/templates' && req.method === 'GET') {
    json(res, 200, { ok: true, data: listSkillTemplates() });
    return true;
  }

  if (url.pathname === '/api/_/skills/templates/generate' && req.method === 'POST') {
    try {
      const { data } = await readBody(req);
      const result = generateSkillFromTemplate(data);
      json(res, 200, { ok: true, data: { ...result, content: undefined } });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return true;
  }

  // ========== RedFox 单 skill 详情（兜底，放最后避免吃掉上面的 /custom /hub）==========
  const skillMatch = url.pathname.match(/^\/api\/_\/skills\/([a-z0-9-]+)$/i);
  if (skillMatch && req.method === 'GET') {
    const skill = getSkill(skillMatch[1]);
    if (!skill) { json(res, 404, { ok: false, error: 'Skill 不存在' }); return true; }
    json(res, 200, { ok: true, data: skill });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
