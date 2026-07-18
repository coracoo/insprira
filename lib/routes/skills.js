// 路由组：Skill 中心（列表/详情/绑定/分类/社区更新）
// 依赖通过 ctx 注入：listSkills/getSkill/getSkillSourceBinding/bindSkillToSource/
// classifyAllSkills/communitySkillUpdateStatus/updateCommunitySkills
const { db } = require('../db');
const { json } = require('../http');

async function tryRoute(req, res, url, ctx) {
  const {
    listSkills, getSkill, getSkillSourceBinding, bindSkillToSource,
    classifyAllSkills, communitySkillUpdateStatus, updateCommunitySkills,
  } = ctx;

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

  // POST /api/_/skills/{slug}/bind-source  把热点 skill 绑定到热榜
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
      const { readBody } = require('../http');
      const { data } = await readBody(req);
      // 前端传 {add, change, remove} 三个 slug 数组；不传或空数组 = 全量
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

  const skillMatch = url.pathname.match(/^\/api\/_\/skills\/([a-z0-9-]+)$/i);
  if (skillMatch && req.method === 'GET') {
    const skill = getSkill(skillMatch[1]);
    if (!skill) {
      json(res, 404, { ok: false, error: 'Skill 不存在' });
      return true;
    }
    json(res, 200, { ok: true, data: skill });
    return true;
  }

  return false;
}

module.exports = { tryRoute };
