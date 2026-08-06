// OpenAI 兼容 chat.completions 调用 + JSON 解析容错
// make(toolFunctions) 工厂注入工具分发，避免硬耦合业务函数
const WEB_SEARCH_TOOL = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Use Doubao WebSearch to look up latest information. Call this whenever you need current data, product features, news, user reviews, or anything the LLM training data may not cover or that may be outdated.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords; be specific (e.g. product name + feature)' },
      },
      required: ['query'],
    },
  },
}];

function parseLlmJson(content) {
  let cleaned = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/<think>[\s\S]*?<think>/gi, '')
    .trim();
  // 容忍围栏/说明文字/零宽字符等杂质：从首个 JSON 起始符截取，并去掉尾部残留围栏
  const start = cleaned.search(/[[{]/);
  if (start > 0) cleaned = cleaned.slice(start);
  cleaned = cleaned.replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    if (err.message.includes('Unterminated') || err.message.includes('Unexpected end')) {
      for (let i = cleaned.length - 1; i >= 0; i--) {
        if (cleaned[i] === '}') {
          try {
            const r = JSON.parse(cleaned.slice(0, i + 1));
            console.warn('[parseLlmJson] JSON 截断修复 pos=' + i);
            return r;
          } catch {}
        }
      }
    }
    throw new Error('JSON 解析失败: ' + err.message + ' | 内容片段: ' + cleaned.slice(0, 200));
  }
}

function make(toolFunctions = {}) {
  async function callLlm(messages, options = {}) {
    const apiKey = process.env.LLM_API_KEY;
    const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const primaryModel = process.env.LLM_MODEL || 'gpt-4.1-mini';
    const fallbackModel = process.env.LLM_FALLBACK_MODEL || '';
    if (!apiKey) throw new Error('未配置 LLM_API_KEY');
    const tools = Array.isArray(options.tools) && options.tools.length ? options.tools : null;
    const maxToolRounds = options.maxToolRounds ?? 3;
    const baseTimeoutMs = tools ? 60000 : 30000;
    const timeoutMs = options.timeoutMs ?? baseTimeoutMs;

    const doCall = async (modelName, tMs) => {
      const body = {
        model: modelName,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
      };
      if (tools) {
        body.tools = tools;
        body.tool_choice = options.toolChoice || 'auto';
      } else if (options.json) {
        body.response_format = { type: 'json_object' };
      }
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(tMs),
      });
      const payload = await response.json();
      if (!response.ok) {
        const errMsg = payload?.error?.message || `LLM HTTP ${response.status}`;
        const err = new Error(errMsg);
        err.status = response.status;
        err.isLlmError = true;
        throw err;
      }
      return payload.choices?.[0]?.message || {};
    };

    if (!tools) {
      try {
        const msg = await doCall(primaryModel, timeoutMs);
        return msg.content || '';
      } catch (primaryErr) {
        if (!fallbackModel || fallbackModel === primaryModel) throw primaryErr;
        const retriable = primaryErr.name === 'TimeoutError' || primaryErr.name === 'AbortError'
          || /network|ECONN|fetch failed|429|rate/i.test(primaryErr.message);
        if (!retriable) throw primaryErr;
        console.warn(`[callLlm] 主模型失败切 fallback: ${primaryModel} -> ${fallbackModel}: ${primaryErr.message}`);
        const msg = await doCall(fallbackModel, timeoutMs * 2);
        return msg.content || '';
      }
    }

    const currentMessages = [...messages];
    for (let round = 0; round <= maxToolRounds; round++) {
      let msg;
      try {
        msg = await doCall(primaryModel, timeoutMs);
      } catch (err) {
        console.warn(`[callLlm] tool round 失败 round=${round} model=${primaryModel}: ${err.message}`);
        throw err;
      }
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!toolCalls.length) {
        return msg.content || '';
      }
      currentMessages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function?.name, arguments: tc.function?.arguments },
        })),
      });
      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const handler = toolFunctions[fnName];
        let result;
        if (!handler) {
          result = JSON.stringify({ error: `未知工具 ${fnName}` });
        } else {
          try { result = await handler(args); } catch (e) { result = JSON.stringify({ error: e.message }); }
        }
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, name: fnName, content: result });
      }
    }
    throw new Error('工具调用轮次超限');
  }

  async function callLlmJson(messages, options = {}) {
    const callOptions = { ...options, json: true };
    if (callOptions.tools) delete callOptions.json;
    const content = await callLlm(messages, callOptions);
    return parseLlmJson(content);
  }

  return { callLlm, callLlmJson };
}

module.exports = { make, parseLlmJson, WEB_SEARCH_TOOL };
