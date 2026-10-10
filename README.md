# dave-agent

基于 Pi SDK 的本地生活售后客服 Agent，围绕餐饮团购券咨询、商家协商与退款，形成可运行、可追到源码和验证记录的面试项目。

订单、商家结果和资金使用合成数据；身份归属、状态流转、金额、确认、幂等及失败恢复由实际代码和 MySQL 执行。项目没有真实商业交易，不连接真实商家或支付渠道。

## 当前状态

| 模块 | 交付状态 |
| --- | --- |
| 稳定主线 | CLI / QQ 本人订单与规则查询，D1 持久协商、D2 精确确认与幂等模拟退款、D3 原会话通知已实现。 |
| 网页客服 | 本机只读问答、本人最近订单与选单续问、真实文本流、SQLite 会话记录、会话模型设置及评测导航已实现；使用两个合成客户，不执行协商或退款。 |
| 评测工作台 | 保存运行、逐轮检查、工具轨迹、配置与用量，支持对比和显式实验入口。 |
| 实验候选 | Controller / 知识接收（C1）、有界会话恢复（O4）有实现和对照记录；C1、完整 O4 与最终选型 O5 仍未完成准入。 |

默认为 `atomic + lexical + memory`，模型为 `deepseek/deepseek-flash`，未因候选实验切换。真实 QQ 验收记录来自 2026-10-02～03，稳定主线真实模型核心回归来自 2026-10-05；后续工程修复与历史验收分列，历史通过不代表当前环境已重验。最新进度见 [plan.md](./plan.md)。

## 稳定业务闭环

```text
可信身份 → 查本人订单与规则 → 用户完整确认联系商家 → 持久 pending 任务
  → 等待期间继续咨询 → 原会话通知或主动查询 → 用户请求退款
  → 重新取证并展示固定方案 → 用户精确确认 → 事务幂等模拟退款
  → 发送结果未知或重启后，按订单号查询持久结果
```

模型最多使用七项受限工具：本人最近订单、订单/规则查询、协商准备/查询、退款方案/结果查询。执行退款只允许宿主处理实际用户的精确确认；商家批准、模型话术和通知均不构成资金授权。方案成功展示后才开放确认，事务内重新核对身份、原会话、金额、审批和期限。

D3 绑定原任务与原回复路由，至多一次主动发送尝试；`claimed` / `unknown` 不自动重发，可能漏通知，保留查询恢复。完整流程、准备条件和成功/澄清/越权/失败演示见 [售后说明](./docs/after-sales.md#面试演示路线)。

## 实现与复用边界

| 部分 | 责任与源码 |
| --- | --- |
| 模型循环与生命周期 | 复用 Pi AgentSession SDK，不修改 Pi 核心；[会话入口](./src/agent.ts)。 |
| 可信身份与业务执行 | 项目实现每次订单授权、宿主确认、金额与事务幂等；[订单存储](./src/coupon-store.ts)、[退款入口](./src/refund-entry.ts)、[退款存储](./src/refunds.ts)。 |
| 异步接待与恢复 | 项目实现持久任务、领取状态、群/用户串行队列和固定回执；[协商存储](./src/after-sales.ts)、[通知调度](./src/merchant-notifications.ts)、[QQAgent](./src/qq-agent.ts)。 |
| 知识与评测 | 项目实现规则范围、检索/证据候选、固定分母与费用归因；[检索说明](./docs/retrieval.md)、[评测说明](./docs/evaluation.md)。 |

历史评测工作台与首版网页由 Kimi CLI（K3 / Max）实现；用户调整分工后，订单发现、网页连续交互、导航与持久历史由 Codex 完成，见[订单入口验收](./plan.md#订单发现与网页连续交互2026-10-09已验收)及[当前网页合同](./docs/web-chat.md#current-history)。宿主后端、契约、评测口径与最终联调由 Codex 负责。模型不开放 Pi 默认终端或文件工具。业务参考 [kefu-harness](https://github.com/wanglongze123/kefu-harness)，参考语料与本项目运行时规则分别保存。

## 本地启动

需要 Node.js ≥22.19.0、npm 和运行中的 Docker。Pi SDK 固定 `1.0.0`、QQ SDK `1.0.4`、MySQL `8.4.11`；完整依赖见 [package.json](./package.json) 和锁文件。

```sh
npm ci
cp -n .env.example .env
# 在本机 .env 填写 MYSQL_ROOT_PASSWORD、DB_PASSWORD 随机密码及 DEEPSEEK_API_KEY
npm run db:up
npm run validate
npm run check:business
```

`validate` 是无需数据库或 API key 的类型与离线检查；`check:business` 使用真实 MySQL 与 Pi/faux 检查只读业务，不调用远程模型。已有数据卷不会重新执行 seed，初始化和升级限制见 [数据库说明](./docs/database.md#启动与连接)。密钥、真实身份、运行数据与日志不入库。

### 网页客服与评测

两个服务在不同终端运行，默认只监听本机：

```sh
# 终端一：只读客服，要求上述 dave_agent_read 账号已就绪
node --env-file-if-exists=.env src/web-chat-server.ts
# 终端二：初始化评测账号后启动工作台
npm run eval:init
npm run eval:serve
```

打开 [网页客服 :3002](http://127.0.0.1:3002/) 或 [评测工作台 :3001](http://127.0.0.1:3001/)，可同标签页往返。普通问答调用真实模型；完整 `查询到账 银行卡` 由宿主处理。模型设置在“应用并新建对话”后生效；已受理对话、公开回复和请求回执保存在本机 `.runtime/web-chat/history.sqlite`，服务重启后可按浏览器归属回访，未完成请求不自动重发。角色选择是本机合成身份入口，不代表真实登录或跨设备账号。接口、设置与验收边界见 [当前网页说明](./docs/web-chat.md#current-history)。

### CLI 与售后演示

```sh
# 可选：增加售后结构/迁移及独立受限账号，密码保存在本机 .env
npm run after-sales:init
CLI_DEMO_USER=TEST_USER1 npm start
```

CLI 只支持 seed 中的 `TEST_APP + TEST_USER1/TEST_USER2`，分别对应两个合成客户；客户一可查询 `COUPON-1001`，查询客户二的 `COUPON-1002` 应拒绝。售后初始化保留旧数据，不重置已处理或过期订单。已有环境若遗留候选配置，先在同一终端执行 [稳定演示完整配置](./docs/after-sales.md#启动)，再启动 CLI 或 QQ。

### QQ 入口

保持数据库运行，在 `.env` 配置 `QQBOT_APP_ID`、`QQBOT_APP_SECRET` 与 `QQ_ALLOWED_GROUPS`。白名单填写群 OpenID；为空时不回复。真实 QQ 身份来自可信事件，经管理员核对绑定后才可查本人订单：

```sh
npm run qq
# 另一个终端：管理员依据本机记录的身份代号及客户归属执行
npm run qq:bind -- <12位identity代号> <对应演示客户ID>
```

本地默认 WebSocket，无需公网地址；`npm run qq:deploy` 默认 Webhook，另需公网 HTTPS 和平台配置。接入、绑定及历史平台证据见 [QQ 说明](./docs/qq-integration.md#当前启动与配置)。

## 能力与证据边界

- 当前写入主线限单门店、单张未核销券的整笔模拟退款；部分退款、真实转接、商家外呼与银行到账核验未实现。
- 默认 QQ / CLI 的 Pi 历史与焦点在内存；重启后可按明确订单号查询 MySQL 中的业务结果。网页用 SQLite 保存原文、公开回复与回执，回访仍须重新授权取证。Controller/MySQL 的 O4 有界引用恢复属于候选，三者均不等于通用长期记忆。
- 工程检查、真实模型、真实 QQ 和商业交易分别记录；小题集分数不代表生产效果，费用缺失保持未知。
- 公网 Webhook、完整手机端显示、共同业务验收及 C1/O4/O5 剩余项仍待完成。售后 DB 检查会扫描待处理任务，须按 [检查准备条件](./docs/after-sales.md#启动)在专用演示环境串行执行。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [计划与当前验收](./plan.md) | 已交付、候选与下一步停止条件。 |
| [售后闭环与源码讲解](./docs/after-sales.md) | 身份、确认、幂等、通知、恢复与演示路线。 |
| [网页](./docs/web-chat.md) / [QQ](./docs/qq-integration.md) / [数据库](./docs/database.md) | 启动、契约与各入口验收。 |
| [评测](./docs/evaluation.md) / [检索](./docs/retrieval.md) | 固定分母、数据、实际结果、失败与局限。 |
| [优化取舍](./docs/optimization-plan.md) / [实验复现](./docs/experiment-controls.md) / [会话恢复](./docs/conversation-recovery.md) | 候选假设、配置、成本与准入边界。 |
