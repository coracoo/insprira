// 小红书 MCP 模块统一出口
// 用法：const xhsMcp = require('./lib/xhs-mcp');
//       xhsMcp.getPublicConfig() / xhsMcp.searchFeeds(...) 等
const service = require('./service');
const client = require('./client');

module.exports = {
  ...service,
  client,
};
