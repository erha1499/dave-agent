# dave-agent

基于 Pi SDK 的电商客服 Agent。业务通过 Prompt、Skill 和受限工具实现，计划通过 QQ Webhook 服务测试群的 `@机器人` 消息。

独立应用仓库，通过 npm 依赖复用 [Pi AgentSession SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)，无需 fork Pi。只有确认现有扩展点无法覆盖需求时，才修改上游框架。

## 起步版本

- 本地 CLI：店铺 FAQ、模拟订单查询。
- 专用客服 Prompt，以及唯一的电商 Skill；首版由宿主加载 Skill，避免开放任意文件读取。
- 工具白名单；模型不能使用 Pi 默认的终端和文件工具。
- 工具从宿主获取当前用户身份，订单归属检查在工具内执行。
- 会话和模拟数据用于本地演示；会话暂存内存，退出后不保留历史。首版关闭自动压缩，长会话需先适配并验证业务摘要提示。

当前未实现 QQ 接入、真实电商 API、取消订单操作。模拟数据不代表任何实际店铺或客户。

## 本地运行

需要 Node.js >=22.19.0、npm。Pi 直接依赖固定为 `1.0.0`，完整依赖树见 `package-lock.json`。

当前 `npm audit` 报告 Pi `1.0.0` 间接依赖 `brace-expansion@5.0.9` 存在 [资源耗尽漏洞](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)。Pi 发布包的 `npm-shrinkwrap.json` 固定了这个版本，本轮 `npm audit fix` 未能更新它；本应用不提供用户可控的 glob/文件搜索工具。升级 Pi 时需重新检查，当前不宣称依赖审计全通过。

```sh
npm ci
npm run validate
cp .env.example .env
# 在 .env 中填写自己使用的模型 provider、model id 和 API key
npm start
```

`npm run validate` 使用离线模型检查，不需要 API key。CLI 的真实模型调用可能产生所选服务商的费用。

默认演示用户是 `demo-customer-1`。可以提问“店铺多久发货？”或“查一下订单 DEMO-1001”。查询其他用户的 `DEMO-1002` 应返回不可查询结果。修改 `.env` 中模型配置即可换用 Pi 支持的其他模型；凭据仅来自这个应用的运行时环境。

## 开发顺序

1. 本地问答和查询：先验证 Prompt、Skill、工具循环与订单权限。
2. QQ 群入口：用腾讯 SDK 接收回调，验签、去重、快速 ACK，再异步调用现有 Agent；按机器人、群、用户路由会话，串行处理同一会话的消息。
3. 取消未付款订单：先查询、展示操作摘要、收到用户确认，再由工具校验归属、状态和幂等键。

QQ 阶段准备：开放平台机器人 AppID/AppSecret、具备群聊权限的测试账号和群、公网 HTTPS 回调地址，并在后台订阅 `GROUP_AT_MESSAGE_CREATE`。密钥保存在本地环境中。API 使用事件里的 `group_openid`，不是界面显示的 QQ 群号。

接入时使用腾讯独立 SDK [qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs)，当前核实的 npm 版本为 `@tencent-connect/qqbot-nodejs@1.0.4`，本阶段尚未安装。SDK 提供 [Webhook 验签与 ACK](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/transport/webhook.ts)；不要等模型推理结束才应答回调。快速 ACK 只说明事件已接收，恢复与业务幂等仍由应用负责。

## 版本控制

远程仓库：[erha1499/dave-agent](https://github.com/erha1499/dave-agent)。默认分支 `main`；每个通过检查的小闭环提交一次。后续修改可以使用短期功能分支，例如 `feat/qq-webhook`。

```sh
git switch -c feat/qq-webhook
# 修改并通过 npm run validate 后
git add <明确要提交的文件>
git commit -m "feat: add QQ webhook ingress"
# 准备公开代码时再执行
git push -u origin feat/qq-webhook
```

`.env`、运行数据、日志和 `node_modules` 已被忽略；提交依赖锁文件，不提交密钥。
