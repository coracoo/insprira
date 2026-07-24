// 本地 Agent 客户端：Codex / Claude Code / Kimi / OpenClaw / Hermes
// make(deps) 工厂注入 paths + getSkill（避免与 skills 模块循环）
//
// Adapter 选择：
//   默认本地 spawn（直接 spawn CLI 二进制）。
//   Docker 部署模式下（容器内 /.dockerenv 存在 或 INSPRIRA_DEPLOYMENT=docker）
//   自动切到 SbxAdapter，调用 sbx CLI 在 microVM 里跑 agent。
//   AGENT_ADAPTER=local|sbx 强制 override。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseAgentJsonLines } = require('./utils');
const { runProcess, resolveExecutable, locateExecutable, findNestedString } = require('./exec');

let agentBusy = false;

const IS_DOCKER = fs.existsSync('/.dockerenv') || process.env.INSPRIRA_DEPLOYMENT === 'docker';
const ADAPTER_OVERRIDE = String(process.env.AGENT_ADAPTER || '').toLowerCase();
const USE_SBX = ADAPTER_OVERRIDE ? ADAPTER_OVERRIDE === 'sbx' : IS_DOCKER;

// sbx 内置模板（见 https://docs.docker.com/ai/sandboxes/agents/）
// insprira 里 agentId → sbx template 名映射
const SBX_TEMPLATES = {
  claude: 'claude',
  codex: 'codex',
};

function make(deps) {
  const { rootDir, SKILLS_ROOT, getSkill, bins } = deps;
  const { CODEX_BIN, CLAUDE_BIN, KIMI_BIN, OPENCLAW_BIN, HERMES_BIN } = bins;

  // ============ Local spawn adapter（原逻辑） ============

  async function listLocalSpawnAgents() {
    const agents = [];
    for (const [id, name, family, bin] of [
      ['codex', 'Codex', 'Codex CLI', CODEX_BIN],
      ['claude', 'Claude Code', 'Claude Code', CLAUDE_BIN],
      ['kimi', 'Kimi', 'Kimi Code CLI', KIMI_BIN],
    ]) {
      const located = locateExecutable(bin);
      agents.push({
        id, name, family,
        available: Boolean(located.path),
        reason: located.reason,
        path: located.path || '',
      });
    }
    const openclawPath = resolveExecutable(OPENCLAW_BIN);
    if (openclawPath) {
      try {
        const { stdout } = await runProcess(openclawPath, ['agents', 'list', '--json'], {
          cwd: rootDir,
          timeout: 15000,
          maxBuffer: 2 * 1024 * 1024,
        });
        const profiles = JSON.parse(stdout || 'null');
        if (Array.isArray(profiles) && profiles.length) {
          for (const profile of profiles) {
            agents.push({
              id: `openclaw:${profile.id}`,
              name: `OpenClaw · ${profile.identityName || profile.name || profile.id}`,
              family: 'OpenClaw',
              model: profile.model || '',
              available: true,
            });
          }
        } else {
          agents.push({ id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw', available: true });
        }
      } catch (error) {
        agents.push({
          id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw',
          available: false, reason: error.message,
        });
      }
    } else {
      agents.push({ id: 'openclaw', name: 'OpenClaw', family: 'OpenClaw', available: false, reason: '未检测到 CLI' });
    }
    const hermesLocated = locateExecutable(HERMES_BIN);
    agents.push({
      id: 'hermes', name: 'Hermes', family: 'Hermes',
      available: Boolean(hermesLocated.path),
      reason: hermesLocated.reason || '',
    });
    return agents;
  }

  async function executeLocalSpawnAgent(agentId, prompt, mode, outputFile) {
    if (agentId === 'codex') {
      const executable = resolveExecutable(CODEX_BIN);
      if (!executable) throw new Error('未检测到 Codex CLI');
      await runProcess(executable, [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        mode === 'workspace' ? 'workspace-write' : 'read-only',
        '-C', rootDir,
        '-o', outputFile,
        prompt,
      ], { cwd: rootDir, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
      return fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').trim() : '';
    }
    if (agentId === 'claude') {
      const executable = resolveExecutable(CLAUDE_BIN);
      if (!executable) throw new Error('未检测到 Claude Code CLI');
      // 不加 --no-session-persistence：让 claude 把 session 写到
      // ~/.claude/projects/-app/（容器内 HOME 重定向后跟 data 卷走）
      const { stdout } = await runProcess(executable, [
        '-p',
        '--permission-mode',
        mode === 'workspace' ? 'acceptEdits' : 'plan',
        prompt,
      ], { cwd: rootDir, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
      return stdout.trim();
    }
    if (agentId === 'kimi') {
      const executable = resolveExecutable(KIMI_BIN);
      if (!executable) throw new Error('未检测到 Kimi CLI');
      const args = ['--prompt', prompt, '--output-format', 'stream-json'];
      if (mode === 'workspace') args.push('--yolo');
      const { stdout } = await runProcess(executable, args, {
        cwd: rootDir,
        timeout: 180000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return parseAgentJsonLines(stdout)
        || stdout.replace(/\nTo resume this session:[\s\S]*$/i, '').trim();
    }
    if (agentId === 'openclaw' || agentId.startsWith('openclaw:')) {
      const executable = resolveExecutable(OPENCLAW_BIN);
      if (!executable) throw new Error('未检测到 OpenClaw CLI');
      const profile = agentId.includes(':') ? agentId.slice(agentId.indexOf(':') + 1) : '';
      const args = ['agent'];
      if (profile) args.push('--agent', profile);
      args.push('--message', prompt, '--json', '--timeout', '180');
      const { stdout } = await runProcess(executable, args, {
        cwd: rootDir,
        timeout: 200000,
        maxBuffer: 10 * 1024 * 1024,
      });
      let payload = null;
      try { payload = JSON.parse(stdout); } catch {}
      return findNestedString(payload, 'finalAssistantVisibleText')
        || findNestedString(payload, 'finalAssistantRawText')
        || findNestedString(payload, 'text');
    }
    if (agentId === 'hermes') {
      if (!resolveExecutable(HERMES_BIN)) throw new Error('当前机器未安装 Hermes CLI');
      throw new Error('已检测到 Hermes，但尚未识别其非交互调用协议，请配置兼容适配器');
    }
    throw new Error('不支持的本地 Agent');
  }

  // ============ Sbx adapter（Docker 模式用） ============

  async function listSbxAgents() {
    const located = locateExecutable('sbx');
    const sbxAvailable = Boolean(located.path);
    const reason = located.reason || '';
    const agents = [
      { id: 'claude', name: 'Claude Code (sbx)', family: 'Claude Code' },
      { id: 'codex', name: 'Codex (sbx)', family: 'Codex CLI' },
    ].map(a => ({
      ...a,
      available: sbxAvailable,
      reason: sbxAvailable ? '' : (reason || 'sbx CLI 未安装，参考 https://docs.docker.com/ai/sandboxes/get-started/'),
    }));
    // kimi/openclaw/hermes 没有 sbx 模板，列出但标灰，让用户知道为什么不能用
    for (const [id, name, family] of [
      ['kimi', 'Kimi', 'Kimi Code CLI'],
      ['openclaw', 'OpenClaw', 'OpenClaw'],
      ['hermes', 'Hermes', 'Hermes'],
    ]) {
      agents.push({
        id, name, family,
        available: false,
        reason: 'sbx 未提供该 Agent 的模板',
      });
    }
    return agents;
  }

  async function executeSbxAgent(agentId, prompt, mode, outputFile) {
    const template = SBX_TEMPLATES[agentId];
    if (!template) {
      throw new Error(`Agent "${agentId}" 没有 sbx 模板，仅支持 claude/codex`);
    }
    const sbxBin = resolveExecutable('sbx');
    if (!sbxBin) {
      throw new Error('sbx CLI 未安装；容器内自动启用 sbx adapter 需要 Docker Sandboxes。本地启动请设置 AGENT_ADAPTER=local');
    }
    // sbx run claude --name <random> -- "<prompt>"
    // microVM 启动 ~秒级，给充足超时
    const sandboxName = `insprira-${crypto.randomUUID().slice(0, 8)}`;
    const args = [
      'run', template,
      '--name', sandboxName,
      '--', prompt,
    ];
    const { stdout } = await runProcess(sbxBin, args, {
      cwd: rootDir,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout || '').trim();
  }

  // ============ 对外接口（adapter 自动选择） ============

  async function listLocalAgents() {
    return USE_SBX ? listSbxAgents() : listLocalSpawnAgents();
  }

  async function executeAgent(agentId, prompt, mode, outputFile) {
    return USE_SBX
      ? executeSbxAgent(agentId, prompt, mode, outputFile)
      : executeLocalSpawnAgent(agentId, prompt, mode, outputFile);
  }

  // —— session-id 提取（resume 用）——
  // 调用前快照、调用后比对，找出本次新生成的 session 文件
  const SESSION_DIRS = {
    claude: () => {
      const dir = path.join(os.homedir(), '.claude', 'projects', '-app');
      return fs.existsSync(dir) ? dir : null;
    },
    kimi: () => {
      const dir = path.join(os.homedir(), '.kimi-code', 'sessions');
      return fs.existsSync(dir) ? dir : null;
    },
  };

  function snapshotLatestSession(agentId) {
    const dir = SESSION_DIRS[agentId]?.();
    if (!dir) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && /\.jsonl$/.test(e.name))
        .map(e => {
          const full = path.join(dir, e.name);
          return { name: e.name, mtime: fs.statSync(full).mtimeMs };
        });
      if (!entries.length) return null;
      entries.sort((a, b) => b.mtime - a.mtime);
      return entries[0];
    } catch { return null; }
  }

  function pickLatestSessionId(agentId, before) {
    const dir = SESSION_DIRS[agentId]?.();
    if (!dir) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && /\.jsonl$/.test(e.name))
        .map(e => {
          const full = path.join(dir, e.name);
          return { name: e.name, mtime: fs.statSync(full).mtimeMs };
        });
      if (!entries.length) return null;
      entries.sort((a, b) => b.mtime - a.mtime);
      const latest = entries[0];
      if (!before || latest.name !== before.name || latest.mtime !== before.mtime) {
        return latest.name.replace(/\.jsonl$/, '');
      }
      return null;
    } catch { return null; }
  }

  async function runLocalAgent(body) {
    if (agentBusy) throw new Error('Agent 正在处理上一条消息，请稍后重试');
    let message = String(body.message || '').trim();
    if (!message) throw new Error('请输入对话内容');
    if (message.length > 10000) throw new Error('单次消息不能超过 10000 字');
    const slashCommand = message.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    const skill = slashCommand ? getSkill(slashCommand[1]) : null;
    if (slashCommand && !skill) throw new Error(`Skill /${slashCommand[1]} 不存在`);
    if (slashCommand) {
      message = String(slashCommand[2] || '').trim();
      if (!message) throw new Error(`请在 /${skill.slug} 后输入具体任务`);
    }
    const agentId = String(body.agent || 'codex');
    const agents = await listLocalAgents();
    const selectedAgent = agents.find(agent => agent.id === agentId);
    if (!selectedAgent) throw new Error('选择的 Agent 不存在');
    if (!selectedAgent.available) throw new Error(selectedAgent.reason || `${selectedAgent.name} 当前不可用`);
    const mode = body.mode === 'workspace' ? 'workspace' : 'read';
    const outputFile = path.join(os.tmpdir(), `insprira-agent-${crypto.randomUUID()}.txt`);
    // sbx 模式下 microVM 看不到 SKILLS_ROOT 路径，把 skill 内容内联到 prompt
    let skillInstruction;
    if (skill) {
      const skillMdPath = path.join(SKILLS_ROOT, skill.slug, 'SKILL.md');
      if (USE_SBX && fs.existsSync(skillMdPath)) {
        const skillContent = fs.readFileSync(skillMdPath, 'utf8');
        skillInstruction = `用户选择了本地 Skill：${skill.title}。SKILL.md 内容如下，按其中工作流执行：\n\n---\n${skillContent}\n---`;
      } else {
        skillInstruction = `用户选择了本地 Skill：${skill.title}。你必须先读取 ${skillMdPath}，并按其中工作流执行。`;
      }
    } else {
      const skillsRootHint = USE_SBX
        ? `用户未指定 Skill。如需参考 SKILL.md，请向用户询问具体 Skill 名称。`
        : `用户未指定 Skill。请先判断是否需要读取 ${SKILLS_ROOT} 下的相关 SKILL.md。`;
      skillInstruction = skillsRootHint;
    }
    const prompt = [
      '你是"灵感熔炉"的本地开发与自媒体数据 Agent。',
      USE_SBX ? `当前在 Docker sbx microVM 内执行，宿主项目目录已挂载到工作目录。` : `当前项目目录：${rootDir}`,
      skillInstruction,
      mode === 'workspace'
        ? '当前允许修改项目文件。修改后应执行必要验证，并在回答中列出改动。'
        : '当前为只读模式。不要修改任何文件，只进行查询、分析和回答。',
      '使用中文回答，结论要具体。不要泄露环境变量、API Key、Cookie 或其他密钥。',
      `用户请求：${message}`,
    ].join('\n\n');
    agentBusy = true;
    let sessionBefore = null;
    try {
      sessionBefore = snapshotLatestSession(agentId);
      const answer = await executeAgent(agentId, prompt, mode, outputFile);
      if (!answer) throw new Error(`${selectedAgent.name} 未返回内容`);
      const sessionId = pickLatestSessionId(agentId, sessionBefore);
      return { answer, agent: agentId, agentName: selectedAgent.name, skill: skill?.slug || null, mode, sessionId };
    } catch (error) {
      if (/usage limit|rate limit|credits|quota|额度|限额/i.test(error.message)) {
        throw new Error(`${selectedAgent.name} 当前额度已用尽，请稍后重试或切换其他 Agent`);
      }
      if (/auth|login|credential|api key/i.test(error.message)) {
        throw new Error(`${selectedAgent.name} 尚未完成登录或凭证配置`);
      }
      throw error;
    } finally {
      agentBusy = false;
      fs.rmSync(outputFile, { force: true });
    }
  }

  return { listLocalAgents, executeAgent, runLocalAgent };
}

module.exports = { make };
