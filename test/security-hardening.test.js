// lib/exec.js 与 lib/xhs-mcp/client.js 的安全加固测试
// - runProcess：裸命令名解析失败立即报错（不进入 spawn）
// - xhs-mcp client：仅允许 http/https 协议（内网地址属正常用法，不拦）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runProcess, resolveExecutable } = require('../lib/exec');
const xhsClient = require('../lib/xhs-mcp/client');

test('runProcess: 不存在的裸命令立即报错，不 spawn', async () => {
  await assert.rejects(
    () => runProcess('definitely-not-a-real-cmd-xyz', []),
    /未找到可执行文件/,
  );
});

test('runProcess: 裸命令 node 解析为绝对路径后正常执行', async () => {
  const resolved = resolveExecutable('node');
  assert.ok(resolved && require('path').isAbsolute(resolved));
  const { stdout } = await runProcess('node', ['-e', 'process.stdout.write("ok")']);
  assert.equal(stdout, 'ok');
});

test('runProcess: 绝对路径不存在时由 spawn error 兜底', async () => {
  await assert.rejects(() => runProcess('/nonexistent/bin/xyz-abc', []));
});

test('xhs-mcp client: 拒绝非 http/https 协议', async () => {
  await assert.rejects(() => xhsClient.health('file:///etc/passwd'), /仅支持 http\/https/);
  await assert.rejects(() => xhsClient.health('gopher://127.0.0.1/'), /仅支持 http\/https/);
});

test('xhs-mcp client: 非法 baseUrl 报清晰错误', async () => {
  await assert.rejects(() => xhsClient.health('not a url at all'), /baseUrl 非法/);
});

test('xhs-mcp client: 内网 http 地址不被拦（连接失败但不是协议错误）', async () => {
  // 127.0.0.1:1 必然连不上；断言报错不是协议拦截
  await assert.rejects(
    () => xhsClient.health('http://127.0.0.1:1'),
    (err) => !/仅支持 http\/https/.test(err.message),
  );
});
