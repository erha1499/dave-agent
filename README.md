# dave-agent

基于 Pi SDK 的本地生活售后客服 Agent，以餐饮团购券/到店套餐的咨询、模拟商家协商和模拟退款为目标，通过 QQ 服务测试群的 `@机器人` 消息。本地默认 WebSocket，部署默认 HTTP Webhook，两种模式共用处理逻辑。业务参考 [kefu-harness](https://github.com/wanglongze123/kefu-harness)，实现顺序以本项目计划为准。

实现顺序、责任边界和分阶段验收见 [plan.md](./plan.md)。

独立应用仓库，通过 npm 依赖复用 [Pi AgentSession SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)，无需 fork Pi。只有确认现有扩展点无法覆盖需求时，才修改上游框架。

## 当前业务版本

- Docker MySQL：基础业务 11 张关联表、8 个只读合成订单案例、8 篇带稳定证据 ID 的规则文档；查询账户仅有 SELECT 权限。
- QQ → Pi → 模型 → QQ 入口：腾讯 SDK 接收测试群 `@` 文本，按群和发送者隔离 Pi 会话，支持 WebSocket / Webhook 切换。
- CLI 与 QQ 共用团购券 Prompt、一个宿主预加载的 Skill，以及 `get_order` / `search_faq` 两个只读工具；配置 D1 后增加协商准备/查询，配置 D2 后再增加 `prepare_refund` / `get_refund`，最多六项业务工具；退款执行只由宿主确认入口调用。默认读取 `DEEPSEEK_API_KEY`，模型为 `deepseek/deepseek-flash`。
- 工具白名单；模型不能使用 Pi 默认的终端和文件工具。
- QQ 客户身份由宿主按可信 AppID＋发送者映射，每次查询重新检查订单归属；未绑定用户可问通用规则，不能查询订单。
- 订单、规则和绑定保存在 MySQL；对话会话暂存内存，退出后不保留历史。自动压缩关闭，长会话需先适配并验证业务摘要提示。
- 内置只读评测工作台：同库保存真实模型运行、逐例检查和模型/工具步骤，查看失败样例、配置快照并比较两个运行；工程检查另行展示。
- D1 模拟商家协商：同库两张专用表、三张独立演示订单；宿主识别用户精确确认后登记任务，同进程 worker 写入同意、拒绝或超时结果。使用独立受限账户，保留原订单与退款事实。
- D2 模拟退款：独立受限账户和 `refund_operations` 表；订单/金额方案成功发送后才开放确认，15 分钟有效，精确确认后事务内幂等更新演示退款、订单和券。
- D3 原会话通知：复用商家 worker 和 QQ 会话队列，结果通过原确认消息回复；同库保存通知状态。业务事件仅能查询协商，不能代替用户确认退款；窗口过期或发送结果不明时由用户查询。
- QQ 固定模板 Markdown：按本轮成功工具结果或宿主数据选择回答、订单、协商/退款确认及结果、通知模板；支持固定确认按钮和纯文本。

2026-10-02 已在真实测试群跑通“咨询退款 → 追问订单号 → 管理员绑定可信身份 → 查询本人订单与适用规则 → 回复申请条件”，并验证他人订单查询被拒绝、私享套餐节假日政策缺失时明确未知。D1 已通过数据库、Pi/faux、真实 DeepSeek＋本地 QQ handler 检查，并在真实 QQ 群跑通准备、用户精确确认、pending 与同意结果查询。D2 已通过工程、真实模型＋本地 QQ handler 和真实 QQ 群验收，覆盖用户确认、重复确认、机器人重启查询及拒绝/超时；协商同意仍不代表已退款。机器人凭据和群白名单仅保存于被 Git 忽略的本机 `.env`；全部业务数据均为演示数据。

2026-10-03 同群两个真实 QQ 账户已验证独立身份、原路通知、79.80/59.90 元方案、互换退款指令拒绝及各自重复确认仅一笔退款；第二账户实际重启后仍查到原退款，第一账户本轮为重启后首次退款。临时订单已清理，公开演示单未消费，详见 [双用户验收](./docs/qq-integration.md#双用户隔离与异额退款)。完整手机端显示与公网 Webhook 仍待验收。

## 本地运行

v2 候选已提供 `SUPPORT_ARCHITECTURE=controller npm start`（QQ 同样支持），将六项模型工具收敛为 `support_action`，由宿主核验并执行内部依赖；精确确认继续走既有事务入口，商家通知使用固定卡且不调用模型。默认仍为 `atomic`。百炼目前用于离线检索选型，未替换在线知识服务；实测结果和待完成门槛见 [v2 实施记录](./docs/v2-implementation-results.md)。

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

`npm run validate` 是不需要数据库或 API key 的类型与离线工程检查，包含可单独运行的 `npm run check:reply` 模板检查与 `node scripts/retrieval-check.ts` 检索检查。`npm run check:business` 使用真实 MySQL 和 Pi 的离线 faux 模型，检查数据关系、工具循环、归属、作用域、证据和拒绝路径，不证明真实模型的语义效果。`npm run check:model` 使用真实数据库与配置的真实模型，验证固定业务样例并保存评测历史；先执行下方 `eval:init`，真实运行可能产生模型费用。数据库结构、案例、只读授权和初始化限制见 [数据库说明](./docs/database.md)。

双用户工程检查运行 `node --env-file-if-exists=.env scripts/qq-isolation-check.ts`：真实 MySQL、Pi 脚本模型与单个 QQAgent，QQ 发信由本地记录替代，验证同群两个客户的并发、上下文、原路通知、异额方案、越权确认及各自幂等；不调用真实模型或 QQ 平台。检查发现并修复了不同订单并发准备方案时的空范围锁死锁，详见 [模拟售后说明](./docs/after-sales.md#确认与持久化边界)。

CLI 只支持预置合成身份 `TEST_APP + TEST_USER1/TEST_USER2`，`.env` 的 `CLI_DEMO_USER` 默认 `TEST_USER1`，对应 `customer-demo-1`。可连续提问“我的团购券还能退吗？”、“订单号是 COUPON-1001”；应查到实付 79.80 元、未核销券及适用规则。`COUPON-1002` 属于第二客户，首客户查询应拒绝。修改模型配置即可换用 Pi 支持的模型；凭据仅来自应用运行时环境。

## 模拟售后（D1 / D2 / D3）

```sh
npm run after-sales:init
npm run check:merchant
npm run check:refund
npm run check:merchant-notifications
npm start
# 或使用已配置的真实 QQ 入口
npm run qq
```

初始化为已有 MySQL 增加协商、退款操作与通知表，分别建立 D1/D2 受限账户，并将 `AFTER_SALES_DB_PASSWORD`、`REFUND_DB_PASSWORD` 写入本机 `.env`；不重置已有数据。升级已有安装也需重跑此幂等命令，再重启 QQ。配置后 CLI/QQ 自动开启对应工具，未配置则保留原有能力。三张新订单均属于客户一、实付 79.80 元：`COUPON-2001` 约 5 秒后模拟同意，`COUPON-2002` 约 5 秒后模拟拒绝，`COUPON-2003` 约 8 秒后超时。处理时间以数据库状态和 worker 实际调度为准。

真实模型检查命令为 `npm run check:merchant-model`，需要模型凭据并可能产生费用；已通过 3 轮真实模型回复与 1 轮宿主确认，使用临时合成订单和本地替代发送函数，不向 QQ 平台发送。另已用临时合成订单完成真实 QQ 群协商同意路径，演示单 `COUPON-2001` 至 `COUPON-2003` 未被该次 D1 验收消费；本轮另已完成真实群拒绝/超时验收；2026-10-03 双用户协商与异额退款已另行验收。

先发“帮我联系商家协商 COUPON-2001，原因是行程变化”，模型读取订单、规则并返回只读确认建议；再由用户完整发送 `确认联系商家 COUPON-2001 原因：行程变化`。宿主立即返回任务号，可继续咨询或问“COUPON-2001 的协商进度”。D3 在原确认消息的本地 4 分 30 秒回复窗口内自动通知终态；窗口过期或发送不明时保留结果供查询。每个任务最多主动尝试一次，已领取后进程异常不自动重发。CLI 和升级前没有 QQ 路由的任务仍需主动查询。每个演示订单只有一个持久任务，重复确认返回原任务；QQ 任务限定同一用户和原群，CLI 的任务不能移到 QQ 群继续处理。收到商家同意通知后，可在原会话发送“那就帮我退款”，Agent 重新查询原订单、规则及审批并生成方案；通知本身不准备或执行退款。核对订单、金额和操作编号，再点击确认按钮并发送，或完整输入 `确认退款 <操作编号>`。QQ API 接受方案后才开放确认；普通“同意”不执行退款，重复精确确认返回同一退款结果，过期或金额变更需要重新获取并确认新编号。完整边界见 [模拟售后说明](./docs/after-sales.md)。

`npm run check:refund-model` 使用真实 DeepSeek＋MySQL＋QQAgent，QQ 发送由本地函数替代，并保存独立 `after-sales-refund-v1` 套件。历史本地验收为 3/3 场景、12/12 用户轮次、67/67 检查，run `6349a275-946c-44bc-aac2-a8b9987f55d4`；覆盖批准后的确认、重复确认和重启查询，以及拒绝/超时不生成方案。当时同版 Skill 的只读回归 run `8c921f5f-eb37-44c0-86e9-bedc23eb6727` 为 9/9 场景、10/10 轮、88/88 检查。真实 QQ 群另已通过完整闭环：按钮填入后由用户发送，API 200 和 `host_reply` 确认由宿主执行；重复确认保持同一退款 UUID，仅一笔 7980 分，订单与券均为 `refunded`。机器人真正重启后仍查到同一结果；拒绝/超时返回固定终态卡，数据库无退款方案、无退款记录，已退金额为零，券仍未核销。验收使用带随机标记的临时合成订单，未消耗 100x 或 2001–2003 演示单，详见 [QQ 接入记录](./docs/qq-integration.md)。

## 评测工作台

当前客观评测入口为 `node --env-file-if-exists=.env scripts/evaluate.ts --suite readonly --repeat 3 --label "客观基线"`；还可选 `workflow`、`engineering`、`retrieval`。四套固定分母分别为 20/26/218、5/30/293、15/15/15、290/290/854（场景/轮次/检查）。只检查真实工具、状态和协议，**本轮不评自然语言回答效果**；旧措辞断言结果标记为历史口径。运行前可执行 `node scripts/objective-eval-check.ts` 离线验证。新 API、重复批次与指标定义见 [客观评测说明](./docs/evaluation.md#当前客观评测)。

2026-10-05 核心 MVP 回归：只读客服 **14/14 场景、22/22 轮、205/205 检查**，通知与模拟退款 **3/3 场景、21/21 轮、140/140 检查**。补齐等待商家期间咨询、过期方案查询/重建、旧编号拒绝及新编号幂等；修复并发查询的一致快照与过期卡登记，并明确套餐政策取证范围。工程检查与源码快照核对通过，失败历史见 [本轮评测记录](./docs/evaluation.md#p1-第三轮核心业务收尾)。QQ 发信本地替代，本轮未重验真实平台；前端继续由 Kimi 维护。

`npm run check:notification-model` 运行 D2/D3 联合套件 `merchant-notification-v2`：真实模型、MySQL 与正式通知 dispatcher，QQ 发信本地替代。当前 21 轮为 18 次用户发言和 3 次商家事件，其中 6 次精确确认由宿主执行、无模型用量。事件通知不授权退款；用户明确请求生成方案并再次精确确认后才执行，拒绝和超时不能生成退款。真实 QQ 的历史联合链路另有验收，当前分母与历史 15/17/20 轮版本按快照区分，详见 [评测说明](./docs/evaluation.md)。复用现有运行时、API 和表。

此前只读回归 run `19cffcc5-c734-47b2-8098-5c4a0cd89869` 为 9/9 场景、10/10 轮、88/88 检查。P1 第一轮新增过敏原案例后的最终 run `c2386b13-e29b-4caf-88f7-01be2455d75e` 为 **10/10 场景、11/11 轮、101/101 检查**；同版 D2/D3 联合 run `5b0b2e2e-9520-4097-9871-10b3913ea9d5` 为 **3/3、15/15、100/100**，QQ 发信本地替代，未重验真实 QQ，资金仍为模拟。首轮 100/101 的历史零元表述误判和限定检查器校准均保留，不能与旧 88 项直接比较分数，详见 [评测说明](./docs/evaluation.md)。

```sh
npm run eval:init
npm run check:eval-db
node --env-file-if-exists=.env scripts/evaluate.ts --suite readonly --label "团购券客观基线"
npm run eval:serve
```

打开 [http://127.0.0.1:3001](http://127.0.0.1:3001)，查看运行记录、逐轮回答、检查结果、证据和工具轨迹，或选择两个运行逐例对比。工作台使用现有 MySQL 的四张 `eval_*` 表和专用账户，不重置业务数据、不修改 Pi 核心、不增加依赖。服务仅监听本机，网页只读，命令行启动真实评测。快照保留模型、Git、Prompt/Skill、工具、题集/检查器和合成业务数据，token 缺失不记成零，SDK 估算费用与安全拒绝单独说明。使用方式与指标限制见 [评测说明](./docs/evaluation.md)。

P0 参考语料与基线、P1 词项检索改进已实现，第二轮补回被分词过滤丢失的已有同义规范词项。固定原文、许可和哈希归档于 `data/reference/kefu-harness/`，独立于 MySQL 的 8 篇业务规则。当前排序使用少量同义归一、query 词项/完整标签及 tags/title/body 罕见词加权；此次检索修复不改词典、权重或 SQL 门店/套餐边界，也未增加依赖或修改前端。

运行 `node scripts/retrieval-baseline.ts`，schema 2 报告会在相同题集上比较冻结的 tags-only 基线与当前算法。选集 11 篇、44/26 道题的 Recall@5 从 P0 的 59.09%/3.85%，经 P1 第一轮 84.09%/30.77%，到当前 **86.36%/34.62%**；全量 35 篇、136/76 道从 55.88%/11.84%，经 79.41%/43.42%，到 **80.15%/44.74%**（常规/难题）。第二轮仅改善两道外带题，其余排名不变。另有修复前固定的 8/8 新问法与 18/18 规范词工程检查通过；该数据已披露，不是盲测。无 ctx/gold 查询改写或独立留出集，不代表真实模型效果与泛化提升。MRR、固定数据哈希和业务验收见 [检索说明](./docs/retrieval.md)。JSON/Markdown 报告保存在 `.runtime/`，尚未接入工作台 Recall/MRR 展示。

上下文检索另有独立离线对照：`node scripts/retrieval-context.ts`。结果包含原问题、扩写输入、逐题退步及无答案诊断；增加上下文虽改善部分开发题，也会产生无关召回，因此暂不接线上。说明与结果见 [上下文比较](./docs/retrieval.md#上下文检索对照离线)。

v2 新增共同业务合同与百炼 M0–M6 对照。以下 `--live`、`--smoke`、`--run` 会连接真实服务并可能产生费用；业务验收使用临时合成订单和本地 QQ 发送替身，结果进入同库 `support-business-v2` 套件。检索报告及缓存保存在忽略目录 `.runtime/retrieval-v2*`，未接入前端 Recall/MRR 展示。

```sh
# 仅检查题集，不调用数据库和模型
node scripts/support-v2-live.ts
# 两套架构共用相同业务合同，各跑三次
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture atomic --repeat 3
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture controller --repeat 3
# 需 DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL
node --env-file-if-exists=.env scripts/retrieval-v2.ts --smoke
node --env-file-if-exists=.env scripts/retrieval-v2.ts --run
```

## QQ → Pi 联调

先保持数据库运行，在 `.env` 填写 `QQBOT_APP_ID`、`QQBOT_APP_SECRET` 和 `QQ_ALLOWED_GROUPS`，模型默认使用 `DEEPSEEK_API_KEY`。后台的 AppSecret「查看」入口仅提供重置。群白名单填写逗号分隔的 **群 OpenID**，不是 QQ 群号；为空时不回复，仅记录被拦截群的 OpenID，便于补齐配置。OpenID 与 AppID 相关，更换机器人后需重新取得。只处理白名单群的 `@` 纯文本，由 Pi 调用业务工具和模型后发送完整回复；精确协商/退款确认在同一串行入口由宿主处理并按实际持久状态直接回复，模型不能代为授权。

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
| `QQ_REPLY_FORMAT` | 默认 `markdown`；显式 `text` 使用纯文本，CLI 始终保持纯文本 |
| `QQ_REPLY_BUTTONS` | 默认 `false`；设为 `true` 后，群聊 Markdown 的模拟协商确认、等待进度与退款确认回复附带固定按钮；本机测试配置已启用 |
| `QQBOT_WEBHOOK_PORT` | `8080`；Webhook 的本地 HTTP 监听端口 |
| `QQBOT_WEBHOOK_PATH` | `/qq/callback`；Webhook 接收路径 |
| `DEEPSEEK_API_KEY` | 默认模型的运行时密钥；`MODEL_PROVIDER`、`MODEL_ID`、`MODEL_API_KEY` 可显式覆盖 |

Webhook 需要公网 HTTPS 入口，将请求反向代理到本地 HTTP 服务。Webhook 请求体上限为 64 KiB。WebSocket 由程序主动连接 QQ 网关，不需要公网入口；两种模式都需要进程持续运行。后台设置服务器 IP 列表后，API 出口 IP 必须匹配；未设置时允许所有请求来源 IP。测试机器人使用 WebSocket，服务器 IP 列表为空，已添加到内部测试群；公开服务开关未开启。

QQ 使用本地 `Reply` 类型和固定策略模板控制格式，订单、金额、确认指令及任务状态来自实际工具或宿主结果，不由模型拼写。无需 QQ 平台模板 ID；群聊原生 Markdown 已开放，详见 [官方能力说明](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)。发送失败不自动切换格式或重发，避免重复消息。回答、订单、协商确认、协商状态、通知五类模板均已获真实 QQ API 200 并通过客户端显示验收。确认指令采用独立普通文本行，已验证从 QQ 复制后可精确发送，含隐形字符的确认在模板、入口及存储边界均拒绝。

同一群内不同用户使用独立会话，同一用户的消息串行处理。当前上限为 20 个内存会话、每会话 3 条在途消息（含正在处理的消息）；空闲 30 分钟清理、20 轮后换新上下文。模型处理限时 60 秒，输出最多 2048 token，模板中的模型正文最多 1000 个 Unicode 码点，渲染后应用输出上限为 4000 码点；这些是本应用限制，不是 QQ 官方上限。超过 4 分 30 秒的原消息不再回复，为平台 5 分钟窗口留出余量。退出后不保留历史。

此前 Markdown 版本的 `npm run validate`（含五种模板、转义、长度及真实 SDK HTTP 发送失败不重发）与 `check:merchant` 通过；该版本 Prompt 的只读真实 DeepSeek 回归为 9 场景、10 轮、88/88 项检查通过，run `419ed809-e366-4a1a-98b6-9c0a4e47448d` 已保存到评测工作台。覆盖多轮澄清/未核销、越权、未绑定、过期、历史退款、部分核销、待支付、已核销及节假日政策缺失；这是小型样例验收，不是外部完整评测集成绩，也不代表 D1 协商成绩。真实 QQ 另已验证鉴权、WebSocket READY、多轮追问、可信身份绑定、本人券单及规则查询、越权拒绝，以及 `COUPON-1008` 引用门店规则并明确未知节假日政策。公网 Webhook 和完整手机端显示仍待验收；双用户记录见下文链接。SDK 去重使用进程内状态，重启后丢失，不作为业务幂等或持久化保证。账号准备与验收记录见 [QQ 接入调研](./docs/qq-integration.md)。

## 开发顺序

1. 基座联调：QQ → 嵌入式 Pi SDK → DeepSeek/echo → QQ 的 WebSocket 真实群回复已验证；部署用 Webhook 另行验收。
2. 会话验证：隔离、串行、超时和生命周期离线检查已通过；同群双用户真实身份、订单、原路通知和确认边界已联调，阻塞并发与上下文标记隔离由工程集成覆盖。
3. 团购券只读业务：MySQL、身份映射、Prompt/Skill 与两个业务工具已接通；运行时仍用 8 篇原创演示规则。P0 基线和 P1 两轮检索改进、多轮指代与退款状态回归已完成，并据失败加强 Prompt 入口优先级、Skill 每轮取证及工具描述；回归结果见 [评测说明](./docs/evaluation.md#p1-第二轮多轮业务回归)。P1 核心范围已收尾；上下文检索实验保留离线，当前优先完善客观评测。
4. 内置评测：客观题集与工程 gate、检索结果统一入库，支持固定计划分母、覆盖、同条件比较与重复运行稳定性；自然语言回答效果本轮不评分，前端由 Kimi CLI（K3 + Max）维护。
5. 售后闭环：D1 持久协商、D2 确认与幂等模拟退款、D3 原会话通知已实现；联合真实模型与真实 QQ 已验证“自动通知 → 用户追问退款 → 精确确认 → 幂等 → 重启查询”。双用户业务边界已另行联调；2026-10-04 起核心业务优先，公网 Webhook 与完整手机端验收降为 P2，本地继续使用 WebSocket。
6. 回放与端到端验证：扩展已有检查，分别记录工程、真实模型和 QQ 验收，不使用参考项目的指标作为自己的成绩。

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
