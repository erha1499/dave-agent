# dave-agent

基于 Pi SDK 的本地生活售后客服 Agent，以餐饮团购券/到店套餐的咨询、模拟商家协商和模拟退款为目标，通过 QQ 服务测试群的 `@机器人` 消息。本地默认 WebSocket，部署默认 HTTP Webhook，两种模式共用处理逻辑。业务参考 [kefu-harness](https://github.com/wanglongze123/kefu-harness)，实现顺序以本项目计划为准。

实现顺序、责任边界和分阶段验收见 [plan.md](./plan.md)。

独立应用仓库，通过 npm 依赖复用 [Pi AgentSession SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)，无需 fork Pi。只有确认现有扩展点无法覆盖需求时，才修改上游框架。

## 当前起步版本

- 本地 CLI：店铺 FAQ、模拟订单查询。
- QQ → Pi → 模型 → QQ 入口：腾讯 SDK 接收测试群 `@` 文本，按群和发送者隔离 Pi 会话，支持 WebSocket / Webhook 切换。
- QQ 联调使用独立的简短 Prompt，仅开放无副作用的 `echo` 工具；默认读取 `DEEPSEEK_API_KEY`，模型为 `deepseek/deepseek-flash`。
- 专用客服 Prompt，以及唯一的电商 Skill；首版由宿主加载 Skill，避免开放任意文件读取。
- 工具白名单；模型不能使用 Pi 默认的终端和文件工具。
- 工具从宿主获取当前用户身份，订单归属检查在工具内执行。
- 会话和模拟数据用于本地演示；会话暂存内存，退出后不保留历史。首版关闭自动压缩，长会话需先适配并验证业务摘要提示。

当前 CLI 仍是通用电商的旧演示，尚未适配团购券业务，也未实现商家异步协商或模拟退款。QQ 已接入嵌入式 Pi SDK 和模型，暂不开放业务工具。2026-10-02 已在真实测试群验证 DeepSeek 中文回答与 `echo → 结果回填 → 群内可见回复`，基础链路目标完成。机器人凭据和群白名单仅保存于被 Git 忽略的本机 `.env`。模拟数据不代表任何实际店铺或客户。

## 本地运行

需要 Node.js >=22.19.0、npm。Pi 直接依赖固定为 `1.0.0`，完整依赖树见 `package-lock.json`。

当前 `npm audit` 报告 Pi `1.0.0` 间接依赖 `brace-expansion@5.0.9` 存在 [资源耗尽漏洞](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)。Pi 发布包的 `npm-shrinkwrap.json` 固定了这个版本，本轮 `npm audit fix` 未能更新它；本应用不提供用户可控的 glob/文件搜索工具。升级 Pi 时需重新检查，当前不宣称依赖审计全通过。

```sh
npm ci
npm run validate
cp -n .env.example .env
# 已有 DEEPSEEK_API_KEY 环境变量即可；其他模型按 .env.example 显式覆盖
npm start
```

`npm run validate` 使用离线模型检查，不需要 API key。CLI 的真实模型调用可能产生所选服务商的费用。

默认演示用户是 `demo-customer-1`。可以提问“店铺多久发货？”或“查一下订单 DEMO-1001”。查询其他用户的 `DEMO-1002` 应返回不可查询结果。修改 `.env` 中模型配置即可换用 Pi 支持的其他模型；凭据仅来自这个应用的运行时环境。

## QQ → Pi 联调

在 `.env` 填写 `QQBOT_APP_ID`、`QQBOT_APP_SECRET` 和 `QQ_ALLOWED_GROUPS`，模型默认使用环境变量中的 `DEEPSEEK_API_KEY`。当前后台的 AppSecret「查看」入口仅提供重置，平台不再保存可查看的明文；需要取得重置后生成的新密钥。群白名单填写逗号分隔的 **群 OpenID**，不是 QQ 群号；为空时不回复，仅记录被拦截群的 OpenID，便于补齐配置。OpenID 与 AppID 相关，更换机器人后需重新取得。只处理白名单群的 `@` 纯文本，由 Pi 调用模型后发送完整回复。可用“请调用 echo 回显：dave-agent 基座联调成功”验证工具循环。

```sh
# 本地默认 WebSocket，无需公网回调地址
npm run qq

# 部署默认 Webhook，NODE_ENV=production
npm run qq:deploy
```

| 配置 | 默认 / 用途 |
| --- | --- |
| `QQ_TRANSPORT` | 未设置时，本地为 `websocket`，`NODE_ENV=production` 为 `webhook`；显式 `websocket` / `webhook` 覆盖默认 |
| `QQBOT_WEBHOOK_PORT` | `8080`；Webhook 的本地 HTTP 监听端口 |
| `QQBOT_WEBHOOK_PATH` | `/qq/callback`；Webhook 接收路径 |
| `DEEPSEEK_API_KEY` | 默认模型的运行时密钥；`MODEL_PROVIDER`、`MODEL_ID`、`MODEL_API_KEY` 可显式覆盖 |

Webhook 需要公网 HTTPS 入口，将请求反向代理到本地 HTTP 服务。Webhook 请求体上限为 64 KiB。WebSocket 由程序主动连接 QQ 网关，不需要公网入口；两种模式都需要进程持续运行。后台设置服务器 IP 列表后，API 出口 IP 必须匹配；未设置时允许所有请求来源 IP。测试机器人使用 WebSocket，服务器 IP 列表为空，已添加到内部测试群；公开服务开关未开启。

同一群内不同用户使用独立会话，同一用户的消息串行处理。当前上限为 20 个内存会话、每会话 3 条在途消息（含正在处理的消息）；空闲 30 分钟清理、20 轮后换新上下文。模型处理限时 60 秒，输出最多 2048 token，最终发送最多 1000 个 Unicode 码点；超过 4 分 30 秒的原消息不再回复，为平台 5 分钟窗口留出余量。退出后不保留历史。

`npm run validate` 已通过，包含类型检查、原有 Pi 检查、`check:qq` 协议检查和 `check:qq-agent` 会话检查。会话检查覆盖真实 Pi/离线模型的 echo 循环、专用上下文、工具白名单、隔离、串行、队列上限、失败与超时恢复及退出清理，均无需真实密钥。真实 QQ 联调另已验证鉴权、WebSocket READY、群消息接收、DeepSeek 回答和 echo 可见回复；公网 Webhook 与两用户真实隔离尚未实测。SDK 去重使用进程内状态，重启后丢失，不作为业务幂等或持久化保证。账号准备与验收记录见 [QQ 接入调研](./docs/qq-integration.md)。

## 开发顺序

1. 基座联调：QQ → 嵌入式 Pi SDK → DeepSeek/echo → QQ 的 WebSocket 真实群回复已验证；部署用 Webhook 另行验收。
2. 会话验证：隔离、串行、超时和生命周期离线检查已通过，两用户真实隔离留后续联调；进入异步业务时再补模拟后台任务回调续接。
3. 团购券业务：适配数据、Prompt/Skill 与业务工具，再引入参考知识与评测，建立检索基线。
4. 售后闭环：接入模拟商家协商、可信审批、用户确认和幂等模拟退款。
5. 回放与端到端验证：扩展已有检查，分别记录工程、真实模型和 QQ 验收，不使用参考项目的指标作为自己的成绩。

QQ 阶段准备：开放平台机器人 AppID/AppSecret、具备群聊权限的测试账号和群；配置服务器 IP 列表时核对 API 出口 IP。Webhook 模式另需公网 HTTPS 回调地址，并在后台订阅 `GROUP_AT_MESSAGE_CREATE`。密钥保存在本地环境中。API 使用事件里的 `group_openid`，不是界面显示的 QQ 群号。

接入复用腾讯独立 SDK [qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs)，已固定安装 `@tencent-connect/qqbot-nodejs@1.0.4`。SDK 提供 [Webhook 验签与 ACK](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/transport/webhook.ts)；不要等模型推理结束才应答回调。快速 ACK 只说明事件已接收，恢复与业务幂等仍由应用负责。

## 版本控制

远程仓库：[erha1499/dave-agent](https://github.com/erha1499/dave-agent)。默认分支 `main`；双模式通信提交 `cc38570`、QQ → Pi 提交 `7265519` 已分步推送。每个通过检查的小闭环分步 commit + push，密钥和运行数据不进入公开仓库。

```sh
git switch -c codex/qq-transport
# 修改并通过 npm run validate 后
git add <明确要提交的文件>
git commit -m "feat: add QQ dual transport ingress"
# 通过检查后推送当前步骤
git push -u origin codex/qq-transport
```

`.env`、运行数据、日志和 `node_modules` 已被忽略；提交依赖锁文件，不提交密钥。
