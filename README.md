# dave-agent

基于 Pi SDK 的本地生活售后客服 Agent，以餐饮团购券/到店套餐的咨询、模拟商家协商和模拟退款为目标，通过 QQ 服务测试群的 `@机器人` 消息。本地默认 WebSocket，部署默认 HTTP Webhook，两种模式共用处理逻辑。业务参考 [kefu-harness](https://github.com/wanglongze123/kefu-harness)，实现顺序以本项目计划为准。

实现顺序、责任边界和分阶段验收见 [plan.md](./plan.md)。

独立应用仓库，通过 npm 依赖复用 [Pi AgentSession SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)，无需 fork Pi。只有确认现有扩展点无法覆盖需求时，才修改上游框架。

## 当前业务版本

- Docker MySQL：11 张关联表、8 个合成订单案例、8 篇带稳定证据 ID 的规则文档；应用账户仅有 SELECT 权限。
- QQ → Pi → 模型 → QQ 入口：腾讯 SDK 接收测试群 `@` 文本，按群和发送者隔离 Pi 会话，支持 WebSocket / Webhook 切换。
- CLI 与 QQ 共用团购券 Prompt、一个宿主预加载的 Skill，以及 `get_order` / `search_faq` 两个只读工具；默认读取 `DEEPSEEK_API_KEY`，模型为 `deepseek/deepseek-flash`。
- 工具白名单；模型不能使用 Pi 默认的终端和文件工具。
- QQ 客户身份由宿主按可信 AppID＋发送者映射，每次查询重新检查订单归属；未绑定用户可问通用规则，不能查询订单。
- 订单、规则和绑定保存在 MySQL；对话会话暂存内存，退出后不保留历史。自动压缩关闭，长会话需先适配并验证业务摘要提示。

2026-10-02 已在真实测试群跑通“咨询退款 → 追问订单号 → 管理员绑定可信身份 → 查询本人订单与适用规则 → 回复申请条件”，并验证他人订单查询被拒绝、私享套餐节假日政策缺失时明确未知。答复来自数据库事实与规则证据，不代表已联系商家、已申请或完成退款。商家异步协商和模拟退款仍未实现。机器人凭据和群白名单仅保存于被 Git 忽略的本机 `.env`；全部业务数据均为演示数据。

## 本地运行

需要 Node.js >=22.19.0、npm、运行中的 Docker。Pi 直接依赖固定为 `1.0.0`，MySQL 镜像固定为 `8.4.11` 与 digest，完整依赖树见 `package-lock.json`。

当前 `npm audit` 报告 Pi `1.0.0` 间接依赖 `brace-expansion@5.0.9` 存在 [资源耗尽漏洞](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)。Pi 发布包的 `npm-shrinkwrap.json` 固定了这个版本，本轮 `npm audit fix` 未能更新它；本应用不提供用户可控的 glob/文件搜索工具。升级 Pi 时需重新检查，当前不宣称依赖审计全通过。

```sh
npm ci
cp -n .env.example .env
# 在本机 .env 填写 MYSQL_ROOT_PASSWORD、DB_PASSWORD 两个随机密码
# 模型默认使用已有 DEEPSEEK_API_KEY；其他模型按 .env.example 显式覆盖
npm run db:up
npm run validate
npm run check:business
npm start
```

`npm run validate` 是不需要数据库或 API key 的类型与离线工程检查。`npm run check:business` 使用真实 MySQL 和 Pi 的离线 faux 模型，检查数据关系、工具循环、归属、作用域、证据和拒绝路径，不证明真实模型的语义效果。`npm run check:model` 使用真实数据库与配置的真实模型，验证固定业务样例，可能产生模型费用。数据库结构、案例、只读授权和初始化限制见 [数据库说明](./docs/database.md)。

CLI 只支持预置合成身份 `TEST_APP + TEST_USER1/TEST_USER2`，`.env` 的 `CLI_DEMO_USER` 默认 `TEST_USER1`，对应 `customer-demo-1`。可连续提问“我的团购券还能退吗？”、“订单号是 COUPON-1001”；应查到实付 79.80 元、未核销券及适用规则。`COUPON-1002` 属于第二客户，首客户查询应拒绝。修改模型配置即可换用 Pi 支持的模型；凭据仅来自应用运行时环境。

## QQ → Pi 联调

先保持数据库运行，在 `.env` 填写 `QQBOT_APP_ID`、`QQBOT_APP_SECRET` 和 `QQ_ALLOWED_GROUPS`，模型默认使用 `DEEPSEEK_API_KEY`。后台的 AppSecret「查看」入口仅提供重置。群白名单填写逗号分隔的 **群 OpenID**，不是 QQ 群号；为空时不回复，仅记录被拦截群的 OpenID，便于补齐配置。OpenID 与 AppID 相关，更换机器人后需重新取得。只处理白名单群的 `@` 纯文本，由 Pi 调用业务工具和模型后发送完整回复。

```sh
# 本地默认 WebSocket，无需公网回调地址
npm run qq

# 部署默认 Webhook，NODE_ENV=production
npm run qq:deploy
```

真实 QQ 不使用 `CLI_DEMO_USER` 或旧的 `CUSTOMER_ID`。未绑定发信人的可信标识保存于被忽略的 `.runtime/qq-identities/`，身份日志只打印匿名的 12 位代号。本机管理员核对实际发信人及测试客户归属后执行绑定：

```sh
npm run qq:bind -- <12位identity代号> <对应的演示客户ID>
```

客户 ID 只能由管理员选择，如 `customer-demo-1` 或 `customer-demo-2`；不能默认将所有群成员绑定到客户一。绑定脚本使用容器管理员权限，已有绑定不会被覆盖。绑定后无需重启已有 QQ 会话，再发 `@机器人 COUPON-1001` 即可验证订单与规则查询。身份校验在工具执行边界完成，不依赖模型记忆。

| 配置 | 默认 / 用途 |
| --- | --- |
| `QQ_TRANSPORT` | 未设置时，本地为 `websocket`，`NODE_ENV=production` 为 `webhook`；显式 `websocket` / `webhook` 覆盖默认 |
| `QQBOT_WEBHOOK_PORT` | `8080`；Webhook 的本地 HTTP 监听端口 |
| `QQBOT_WEBHOOK_PATH` | `/qq/callback`；Webhook 接收路径 |
| `DEEPSEEK_API_KEY` | 默认模型的运行时密钥；`MODEL_PROVIDER`、`MODEL_ID`、`MODEL_API_KEY` 可显式覆盖 |

Webhook 需要公网 HTTPS 入口，将请求反向代理到本地 HTTP 服务。Webhook 请求体上限为 64 KiB。WebSocket 由程序主动连接 QQ 网关，不需要公网入口；两种模式都需要进程持续运行。后台设置服务器 IP 列表后，API 出口 IP 必须匹配；未设置时允许所有请求来源 IP。测试机器人使用 WebSocket，服务器 IP 列表为空，已添加到内部测试群；公开服务开关未开启。

同一群内不同用户使用独立会话，同一用户的消息串行处理。当前上限为 20 个内存会话、每会话 3 条在途消息（含正在处理的消息）；空闲 30 分钟清理、20 轮后换新上下文。模型处理限时 60 秒，输出最多 2048 token，最终发送最多 1000 个 Unicode 码点；超过 4 分 30 秒的原消息不再回复，为平台 5 分钟窗口留出余量。退出后不保留历史。

最终 `npm run validate` 与 `npm run check:business` 均通过，覆盖协议、会话与真实 MySQL＋Pi/faux 工程检查。`npm run check:model` 在最终 Prompt 上调用真实 DeepSeek，通过 9 个固定场景、10 轮，覆盖多轮澄清/未核销、越权、未绑定、过期、历史退款、部分核销、待支付、已核销及节假日政策缺失；这是小型样例验收，不是外部完整评测集成绩。真实 QQ 另已验证鉴权、WebSocket READY、多轮追问、可信身份绑定、本人券单及规则查询、越权拒绝，以及 `COUPON-1008` 引用门店规则并明确未知节假日政策。公网 Webhook 与两用户真实隔离尚未实测。SDK 去重使用进程内状态，重启后丢失，不作为业务幂等或持久化保证。账号准备与验收记录见 [QQ 接入调研](./docs/qq-integration.md)。

## 开发顺序

1. 基座联调：QQ → 嵌入式 Pi SDK → DeepSeek/echo → QQ 的 WebSocket 真实群回复已验证；部署用 Webhook 另行验收。
2. 会话验证：隔离、串行、超时和生命周期离线检查已通过，两用户真实隔离留后续联调；进入异步业务时再补模拟后台任务回调续接。
3. 团购券只读业务：MySQL、身份映射、Prompt/Skill 与两个业务工具已接通；现用 8 篇原创演示规则，参考项目评测集导入与常规/难题检索基线留后续。
4. 售后闭环：接入模拟商家协商、可信审批、用户确认和幂等模拟退款。
5. 回放与端到端验证：扩展已有检查，分别记录工程、真实模型和 QQ 验收，不使用参考项目的指标作为自己的成绩。

QQ 阶段准备：开放平台机器人 AppID/AppSecret、具备群聊权限的测试账号和群；配置服务器 IP 列表时核对 API 出口 IP。Webhook 模式另需公网 HTTPS 回调地址，并在后台订阅 `GROUP_AT_MESSAGE_CREATE`。密钥保存在本地环境中。API 使用事件里的 `group_openid`，不是界面显示的 QQ 群号。

接入复用腾讯独立 SDK [qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs)，已固定安装 `@tencent-connect/qqbot-nodejs@1.0.4`。SDK 提供 [Webhook 验签与 ACK](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/transport/webhook.ts)；不要等模型推理结束才应答回调。快速 ACK 只说明事件已接收，恢复与业务幂等仍由应用负责。

## 版本控制

远程仓库：[erha1499/dave-agent](https://github.com/erha1499/dave-agent)。默认分支 `main`；双模式通信提交 `cc38570`、QQ → Pi 提交 `7265519` 已分步推送。当前团购券业务的 `b0440da`（MySQL 结构/seed/只读授权）和 `6acb7fd`（QQ 可信身份/MySQL 只读工具/Pi 检查）已推送至 `codex/coupon-business`。每个通过检查的小闭环分步 commit + push，密钥和运行数据不进入公开仓库。

```sh
git switch -c codex/qq-transport
# 修改并通过 npm run validate 后
git add <明确要提交的文件>
git commit -m "feat: add QQ dual transport ingress"
# 通过检查后推送当前步骤
git push -u origin codex/qq-transport
```

`.env`、运行数据、日志和 `node_modules` 已被忽略；提交依赖锁文件，不提交密钥。
