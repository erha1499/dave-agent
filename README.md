# dave-agent

基于 Pi SDK 的本地生活售后客服 Agent，以餐饮团购券/到店套餐的咨询、模拟商家协商和模拟退款为目标，计划通过 QQ Webhook 服务测试群的 `@机器人` 消息。业务参考 [kefu-harness](https://github.com/wanglongze123/kefu-harness)，实现顺序以本项目计划为准。

实现顺序、责任边界和分阶段验收见 [plan.md](./plan.md)。

独立应用仓库，通过 npm 依赖复用 [Pi AgentSession SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)，无需 fork Pi。只有确认现有扩展点无法覆盖需求时，才修改上游框架。

## 当前起步版本

- 本地 CLI：店铺 FAQ、模拟订单查询。
- 专用客服 Prompt，以及唯一的电商 Skill；首版由宿主加载 Skill，避免开放任意文件读取。
- 工具白名单；模型不能使用 Pi 默认的终端和文件工具。
- 工具从宿主获取当前用户身份，订单归属检查在工具内执行。
- 会话和模拟数据用于本地演示；会话暂存内存，退出后不保留历史。首版关闭自动压缩，长会话需先适配并验证业务摘要提示。

当前 CLI 仍是通用电商的旧演示，尚未适配团购券业务，也未实现商家异步协商、模拟退款或 QQ 接入。模拟数据不代表任何实际店铺或客户。

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

1. QQ 通信：复用腾讯 SDK 接收回调并发送固定回复，验证握手、验签、去重和快速 ACK。
2. Pi 集成：跑通 QQ → Pi → 模型/无副作用测试工具 → QQ，验证会话隔离、串行和模拟后台回调续接。
3. 团购券业务：适配数据、Prompt/Skill 与业务工具，再引入参考知识与评测，建立检索基线。
4. 售后闭环：接入模拟商家协商、可信审批、用户确认和幂等模拟退款。
5. 回放与端到端验证：扩展已有检查，分别记录工程、真实模型和 QQ 验收，不使用参考项目的指标作为自己的成绩。

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
