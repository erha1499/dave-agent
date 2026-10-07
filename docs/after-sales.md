# D1 / D2 / D3 模拟售后

已实现“准备协商 → 用户精确确认 → 持久任务 → 模拟结果 → 原 QQ 会话通知或查询 → 用户请求退款 → 固定退款方案 → 用户精确确认 → 幂等模拟退款 → 重启查询”。复用 QQ/CLI、Pi SDK 和同一 MySQL，不改 Pi 核心；商家与退款均为演示，不连接真实商家或支付渠道。D2/D3 已完成联合真实模型与真实 QQ 同意退款链路验收；三终态通知另有历史验收。

本页平台验收来自 **2026-10-02 至 10-03**，默认主线的后续真实模型核心回归来自 **2026-10-05**。2026-10-06 的 O4-4 MySQL 工程回归见[恢复证据](./conversation-recovery.md#o4-4-工程验证与面试演示)；同日 O4 候选的真实模型实验也不替代默认主线或真实 QQ 重验。历史通过不等于当前环境已重验。默认 `atomic + lexical + memory` 的售后材料与 [C1 Controller 候选](./c1-implementation-results.md) 分开，C1 尚未准入。

## 启动

数据库检查会创建并清理各自的临时合成数据，但 `processDue` 会扫描全库待处理协商，通知检查也会扫描 `TEST_APP` 的终态待发通知。请使用专用演示库，确认没有其他待处理协商或 `TEST_APP` 终态待发通知，停止已运行的 CLI/QQ 及商家 worker，再串行执行检查；临时数据隔离不等于扫描范围隔离。

稳定演示在同一新终端先固定以下参数。环境变量优先于Node加载的`.env`；空值覆盖遗留解析参数和通用模型密钥，模型使用`.env`中的`DEEPSEEK_API_KEY`。这只固定演示进程，不修改`.env`或常驻服务。

```sh
export SUPPORT_ARCHITECTURE=atomic SUPPORT_CONTEXT_MODE=memory
export KNOWLEDGE_MODE=lexical KNOWLEDGE_SUPPORT=binary
export KNOWLEDGE_SUPPORT_MODEL=configured KNOWLEDGE_SUPPORT_PROMPT=v5
export KNOWLEDGE_APPLICABILITY=model_only KNOWLEDGE_QUERY_MODE=combined
export KNOWLEDGE_THRESHOLD=0.71 KNOWLEDGE_TIMEOUT_MS=15000
export CLI_QUESTION_CONTRACT=v2 CLI_QUESTION_MODEL= CLI_QUESTION_TIMEOUT_MS=
export MODEL_PROVIDER=deepseek MODEL_ID=deepseek-flash MODEL_API_KEY=
export CLI_DEMO_USER=TEST_USER1

npm run db:up
npm run after-sales:init
npm run check:merchant
npm run check:refund
npm run check:merchant-notifications
npm start
# QQ 凭据、白名单和身份绑定已配置时：
# npm run qq
```

`after-sales:init` 保留已有数据、任务和 QQ 绑定，补充协商表、退款操作表、通知表、有界上下文表与三张演示订单，并建立两个独立受限账户。`AFTER_SALES_DB_USER` 默认 `dave_agent_after_sales`，`REFUND_DB_USER` 默认 `dave_agent_refund`；密码只保存于忽略的 `.env`。D3 复用协商账户，不增加数据库或账户。重启 QQ/CLI 后启用相应能力；未配置时不注册相应工具，已配置但连接失败时报错退出。

已有售后账号升级 O4-4 时可单独运行 `node --env-file-if-exists=.env scripts/merchant-references-setup.ts`，再重启 CLI/QQ；已有 volume 的 `db:up` 不执行该迁移。新字段 `merchant_requests.identity_id` 记录创建时绑定代次，memory/atomic 下的自动通知也会核验；启动检查会拒绝缺字段的环境。旧 NULL 任务不回填，其待发通知不再自动领取，仍可按原订单查询；任务 worker、既有审批及退款规则继续生效。引用的 15 分钟有效期不撤销批准，也不代表用户已读，细节见[任务恢复边界](./conversation-recovery.md#o4-4异步任务恢复不改变当前订单)。

| 演示订单 | 客户 / 金额 | 模拟结果 |
| --- | --- | --- |
| COUPON-2001 | 客户一 / 79.80 元 | 约 5 秒后同意 |
| COUPON-2002 | 客户一 / 79.80 元 | 约 5 秒后拒绝 |
| COUPON-2003 | 客户一 / 79.80 元 | 约 8 秒后超时 |

三单首次初始化时均为单张未核销券，有效期 30 天；再次初始化不会重置已完成的业务或刷新有效期。原 COUPON-1001 至 1008 保留只读。CLI 使用 TEST_USER1；QQ 使用管理员绑定到客户一的可信发信人。

## 演示一单

1. 发送“帮我联系商家协商 COUPON-2001，原因是行程变化”。QQ 每条消息都需在白名单群中 `@机器人`。
2. Agent 查询订单、规则，调用 `prepare_merchant_request` 返回只读建议与确认文字，此时未创建任务。
3. 用户本人完整发送 `确认联系商家 COUPON-2001 原因：行程变化`，宿主直接返回任务号与实际状态，不调用模型代为确认。
4. 等待期间可继续咨询；QQ 在原确认消息有效窗口内尝试通知同意、拒绝或超时结果。未收到通知也可按订单号查询。收到同意通知后，在原会话发送“那就帮我退款”，Agent 根据上下文确定订单并重新查询订单、规则及审批，再准备方案；结果通知本身不会生成或提交退款。拒绝或超时后追问也不会生成方案；同意只表示商家审批通过，不代表退款。
5. Agent 调用 `prepare_refund`，固定模板展示订单、79.80 元金额、操作编号与有效期。QQ API 明确接受这条方案后，宿主调用 `markPresented` 开放确认；发送失败或结果未知时不开启确认，也不盲目重发。API 接受不等于用户已阅读。
6. 核对方案后，点击“确认模拟退款”按钮并发送，或完整发送 `确认退款 <操作编号>`。只有这条实际用户消息能进入宿主退款入口，模型没有执行退款工具。
7. 宿主事务内校验并保存模拟退款结果；重复发送同一确认返回同一退款记录。重启后提供订单号，Agent 可用 `get_refund` / `get_order` 查询持久结果。

启用 D1/D2 后最多有六项模型工具：`get_order`、`search_faq`、`prepare_merchant_request`、`get_merchant_request`、`prepare_refund`、`get_refund`。`prepare_refund` 只登记方案，不执行退款。确认解析仅容忍指令首尾的 ASCII 空格和制表符，换行、附加文本及零宽等隐形字符仍拒绝；单独“确认”“同意”、引用/JSON 中的确认、模型生成的确认均不授权。

## 面试演示路线

准备使用上面的启动步骤；依赖版本以 [`package.json`](../package.json) 和锁文件为准，当前固定 Pi `1.0.0`、QQ SDK `1.0.4`。本机 `.env` 需具备模型、基础只读库、协商库和退款库配置；QQ 另外需要白名单和管理员核对后的[身份绑定](./qq-integration.md#接收与回复协议)。演示历史默认路径时先在同一终端执行[启动配置](#启动)的完整export清单，再使用 `npm start` 或 `npm run qq`；只覆盖atomic/memory/lexical不足以清除遗留typed、declared-v2、解析或模型候选设置。CLI 与 QQ 是不同来源，协商、方案和确认须在同一入口及原会话继续。

先查询 `COUPON-2001` 的状态与有效期；只有本人、仍有效、单张未核销且尚未退款时，才适合从头演示成功路径。初始化不会重置旧单。已处理或已过期时展示实际状态与查询恢复，完整新流程可用下表会自行建立临时合成订单的现有检查脚本；不要为了演示删除历史任务或重置已退款事实。

| 顺序与业务问题 | 演示输入或可复现命令 | 检查点与证据层级 |
| --- | --- | --- |
| 1. 对象不明，先澄清 | 新会话先说“我想退款”，明确订单后再继续；多单可问“COUPON-2001 和 COUPON-2002，我想退一笔”。 | 应询问订单/具体对象，不能替用户猜单或提交退款。默认路径依赖模型选择，历史[多轮业务回归](./evaluation.md#p1-第二轮多轮业务回归)保留成功与失败；本次不宣称这些新输入已实测。C1 的确定性候选恢复另见[引用演示](./c1-reference-selection.md#已实现与可复现演示)。 |
| 2. 等待商家仍能接待 | 按[演示一单](#演示一单)完成准备和精确确认，等待时问套餐问题，再查 `COUPON-2001` 协商进度。 | 准备不创建任务，完整用户确认才返回任务；通知仍绑定原任务且不自动退款。历史真实模型联合套件包含等待期间咨询，真实 QQ 已验证原会话通知；[验证记录](#验证记录)分别列出。 |
| 3. 同意后仍需展示、确认、幂等 | 取得 approved 后请求退款；复制本轮实际方案的 `确认退款 <操作编号>`，成功后再发送同一条。 | 方案成功展示后才开放确认；普通“同意”不执行。重复精确确认返回同一退款记录，不增加金额。真实事务可运行 `npm run check:refund`；真实模型套件可运行 `npm run check:refund-model -- --label "面试售后演示"`，后者调用模型并写入隔离的临时合成数据。 |
| 4. 相同入口下拒绝他人订单 | 独立终端先执行[同一完整export清单](#启动)，再运行 `CLI_DEMO_USER=TEST_USER2 npm start`，查询客户一的 `COUPON-2001`。 | 应拒绝读取他人订单；不能因为知道订单号或复制确认文字就获得权限。`node --env-file-if-exists=.env scripts/qq-isolation-check.ts` 用真实 MySQL、Pi 脚本模型和本地发送检查双用户交叉确认后数据库不变；[真实双用户 QQ 记录](./qq-integration.md#双用户隔离与异额退款)另行提供客户端证据。 |
| 5. 失败后恢复，不盲目重做 | 收不到回执时在原入口询问“查询 COUPON-2001 的退款状态”；重启后也明确提供该订单号。查看拒绝/超时可沿主线使用 `COUPON-2002` / `COUPON-2003`。 | 查询持久结果，不把发送未知解释为未退款；拒绝/超时不生成退款方案。`node scripts/refund-agent-check.ts` 演示发送后登记、失败不重发、过期卡只读和丢失回执后查询；`node scripts/merchant-notification-agent-check.ts` 演示通知 unknown/claimed 后不重发。这两条为真实 Pi/faux、合成服务及本地发送，0 远程模型、0 数据库，不能替代平台验收。 |

需要重跑完整联合真实模型路径时，先按[评测准备](./evaluation.md#d1d2-模拟售后评测)初始化评测表，再运行 `npm run check:notification-model -- --label "面试异步售后复现"`。当前脚本是 3 场景 / 21 处理轮的版本；它调用真实模型和 MySQL，QQ 发送仍由本地函数替代。逐轮结果、失败与用量会进入现有工作台，不能把它称为真实 QQ 重验；不要并行运行修改同一演示库的售后套件。

## 面试讲解的源码入口

实际默认调用链为 `QQ 可信事件 → QQAgent 群/用户串行队列 → 用户确认 hook 或 Pi Session → 六项受限工具 → Store`；模拟 worker 的 `processDue → dispatchMerchantNotifications → resumeMerchant` 复用同一队列，出队后再次读取原任务。源码入口分别为 [`qq.ts`](../src/qq.ts)、[`QQAgent.enqueue`](../src/qq-agent.ts)、[`createCouponSession`](../src/agent.ts)、[`startMockMerchant`](../src/after-sales.ts)、[`dispatchMerchantNotifications`](../src/merchant-notifications.ts)。Controller 候选将模型工具收敛为 `support_action`，不改确认与事务服务，不能沿用默认架构的真实 QQ 验收结论。

| 面试追问 | 个人实现、复用边界与取舍 | 可定位证据 |
| --- | --- | --- |
| 为什么模型不能直接退款？ | Pi 复用模型请求、工具循环和生命周期；项目实现可信身份、受限工具、`confirmMerchantReply` / `confirmRefundReply` 的原文确认入口。确认函数不注册为模型工具，用户文本之外的模型输出不能授权。 | [`after-sales-entry.ts`](../src/after-sales-entry.ts)、[`refund-entry.ts`](../src/refund-entry.ts)、上面的成功与越权演示。 |
| 如何避免重复执行和检查后状态变化？ | `RefundStore` 在同一事务锁订单、方案、券和审批，复核金额/期限/归属，再插入退款并更新状态；唯一约束与已有结果实现幂等。单笔 `READ COMMITTED` 来自实际跨订单死锁回归，不以关闭校验换取并发。 | [`refunds.ts`](../src/refunds.ts)、[确认与持久化边界](#确认与持久化边界)、[`refund-db-check.ts`](../scripts/refund-db-check.ts)。 |
| 为什么不用消息中间件或无限重试？ | 当前小规模演示采用同库任务/通知和同进程 worker，复用服务与队列。通知至多一次主动尝试，付出的是可能漏通知；保留订单查询作为恢复途径。 | [D3 原会话通知](#d3-原会话通知)、[`merchant-notification-db-check.ts`](../scripts/merchant-notification-db-check.ts)、[`merchant-notification-agent-check.ts`](../scripts/merchant-notification-agent-check.ts)。 |
| 重启恢复了什么？ | 默认 atomic/memory 路径可查询持久订单、商家任务和退款结果，并恢复尚未领取的通知；Pi 聊天和可信焦点仍在内存。明确订单号查询成功不等于省略续问恢复，后者属于 O4 候选。 | [历史平台记录](./qq-integration.md)、[核心业务收尾](./evaluation.md#p1-第三轮核心业务收尾)、[上下文恢复边界](./conversation-recovery.md)。 |

可引用的历史数字是 D1/D2 **3/3 场景、12/12 用户轮、67/67 检查**，以及 2026-10-05 联合最终 run `513fe193-53e7-4452-91cf-fc6804c7cf82` 的 **3/3 场景、21/21 处理轮、140/140 检查**；后者 6 个宿主确认轮不调用模型，40/40 模型请求报告 usage。分数来自[实际评测记录](./evaluation.md#p1-第三轮核心业务收尾)，QQ 发送本地替代，不是生产成功率。本次未重新计时或核算费用，缺少统一成本的历史结果不补零；当前成本取舍示例可看 [C1 同批模型对照](./c1-agent-model-ablation.md#实际结果与选型)。

[O4-8 新问法对照](./o4-recovery-validation.md#当前任务引用新问法真实对照合同2026-10-06已执行未准入)保留了 `current` 78/80、`id` 79/80 与总计 USD 0.1388397 的结果；未确认 `current` 的整体收益，候选未准入，也未改变本页默认演示路径。

### 本轮稳定主线工程复核（2026-10-06）

本轮补齐两个可追问的缺口：**确认前的入口预处理是否改变原文，以及真实进程退出后能否读取同一退款结果。** CLI原来先 `trim()`，会把U+00A0/U+FEFF包装的指令变成合法确认；新[输入分类](../src/cli.ts)只对空行和 `/exit` 判断做trim，业务文本原样进入既有确认函数及Session。测试先复现错误的确认调用，再验证两类指令的不可见字符/换行包装不授权，ASCII空格/tab仍兼容；检查已纳入 `npm run validate`。修复不增加退款工具或改变身份、金额及事务校验。

| 命令/路径 | 本轮实际证据 |
| --- | --- |
| `node scripts/support-host-entry-check.ts` | 旧预处理断言失败（确认次数1而期望0），修复后通过；保留模型错误后的固定宿主回执回归。 |
| 默认CLI启动后输入 `/exit` | 显式atomic/lexical/memory，实际启动并退出0；只验证初始化和退出，不评价自然语言咨询。 |
| `node --env-file-if-exists=.env scripts/qq-isolation-check.ts` | 双用户原路通知、异额方案、交叉确认拒绝、各自确认/重复幂等及新Session查询通过。 |
| `npm run check:refund` | 真实事务与一致快照、发送门槛、金额/批准/期限复核、并发幂等及离线发送故障通过。 |
| `npm run check:merchant-notifications` | 路由/并发领取/持久状态及Pi通知失败不重发通过；此套件仍是同进程对象/连接重建。 |
| `node --env-file-if-exists=.env scripts/atomic-refund-recovery-db-check.ts --db` | 首个子进程完成实际展示、宿主确认和重复幂等后退出；第二个不同PID用全新连接、Pi atomic Session及工具重新查库。 |
| `npm run validate` | 最终退出0；包含新进程检查的纯合同反例，DB部分仍需显式 `--db`。 |

新[进程检查](../scripts/atomic-refund-recovery-db-check.ts)的实际PID为 **35380 → 35432**，同一模拟退款 `53890118-b7e2-4663-9896-ab0f714fdf7b`、**7980分**。第二进程仅接收可信合成身份、群和订单定位，不接收首进程答案；返回事实来自真实 `get_order` / `get_refund` toolResult。父进程独立核对任务批准、金额、退款UUID及单笔记录；查询前后九张fixture表的hash一致，清理后九表均为0。它证明明确订单号的持久结果查询，不证明聊天历史或省略指代恢复。

三组既有检查执行前均确认无待处理商家任务、无 `TEST_APP` 终态待发通知和常驻CLI/QQ worker，串行各执行一次。其后及新进程检查结束，11张业务/绑定/上下文表数量和内容hash与执行前一致；不能据这一环境条件把全库扫描说成天然隔离。新进程脚本只对本任务应用合成商家批准，不使用全库worker或通知dispatcher；确认命令来自实际显示的回复。子进程非零退出、超时/信号及主流程/清理失败分别保留，不因清理覆盖原错误。

本轮**0远程模型、0真实QQ请求**：模型选择由Pi/faux脚本提供，商家结果合成、发送由本地适配器接受；真实执行的是Pi循环、QQAgent/确认hook、MySQL授权与事务、Node退出/重启及独立数据库断言。工程通过不追加为真实模型分数、QQ客户端验收或商业退款。默认不切换，C1/O4/O5剩余准入项保留；O4-8[未采用理由与成本](./o4-recovery-validation.md#当前任务引用新问法真实对照合同2026-10-06已执行未准入)可作为取舍材料。

本机证据为 `.runtime/p0-stable-check-review.json`、`p0-stable-final-review.json`、`p0-atomic-refund-process-db.log`、`p0-stable-final-validate.log` 和CLI修复前后日志，不入库。最终进程脚本SHA-256：`249dc8c787b8135047dad4ee3913b46fd79a55445edea02673741fe6263d5fdb`；DB日志SHA-256：`a5fe4cbee178b140afb86c71f3c7b910a07c9c3d16ca5107d462873698577b48`。复现按[启动前提](#启动)准备，纯合同用 `node scripts/atomic-refund-recovery-db-check.ts --check`；无需新应用、依赖或额外付费实验。

### 退款确认调用链审计（2026-10-08）

本轮只核验默认 atomic 主线的确认入口、展示门槛和事务，不扩展能力。真实约束是本人在原会话确认已展示的有效方案，金额来自存储，重复消息最多完成一笔模拟退款；面试追问是“模型输出确认文字、发送结果未知或两个进程同时确认，谁能决定执行”。个人实现为入口解析、固定回执和 RefundStore 授权/事务，复用 Pi 循环、QQ SDK 与 MySQL。预算为30分钟、既有两条离线检查各一次，0远程模型/QQ/数据库请求；源码和定向结果核对后收尾，不重跑历史实验。

以已展示的79.80元方案及其实际操作编号为例，逐层跟踪：

| 环节 | 实际调用与检查 |
| --- | --- |
| 原文进入宿主 | [`cli.ts`](../src/cli.ts) 的 `parseCliInput → confirmRefundReply` 保留业务原文；[`qq.ts`](../src/qq.ts) 只去掉开头的传输 @，在 [`QQAgent.enqueue`](../src/qq-agent.ts) 队列内调用确认 hook。[`refund-entry.ts`](../src/refund-entry.ts) 仅容忍首尾ASCII空格/tab，完整单行UUID才调用 Store；模型输出或通知事件不能进入此入口。 |
| 方案开放确认 | [`agent.ts`](../src/agent.ts) 的 `prepare_refund` 只有订单参数，身份/会话由宿主闭包提供，金额由 Store 计算。`replyFromTools → renderReply → QQAgent.deliver` 展示当前工具结果的固定方案；`send → markRefundReplyPresented → markPresented` 成功后才开放确认。API接受不代表用户已读；首次方案发送/登记未成功时不开放确认，过期卡不尝试重新登记，两种失败均不自动重发。 |
| 确认事务 | [`RefundStore.withOperation`](../src/refunds.ts) 先从编号定位订单，再 `lockOrder → current` 重新校验当前身份绑定、客户和原会话；UUID不是权限凭证。`confirm → eligible → decisionTime` 在锁内复核批准、金额、单券、付款及等待锁后的有效期，才写退款、订单、券和操作结果。同订单行锁让并发请求串行，后者读到 succeeded 后返回同一结果；[`refund_operations`](../db/06-refunds.sql) 每单唯一约束配合这一流程。应用内消息去重无法替代跨进程事务，也没有为此增加分布式锁。 |
| 结果未知时恢复 | `confirmRefundReply` 捕获提交异常后提示在原会话按订单查询，不断言“未退款”；成功结果的发送失败不自动重发。明确订单查询读取持久结果，不能据此声称恢复了聊天历史、省略指代或真实银行到账。 |

**本轮结果：** 基于源码基线 `4509d36` 审阅完整调用方，未发现需要修改生产代码的有证据缺陷。`node scripts/support-host-entry-check.ts` 与 `node scripts/refund-agent-check.ts` 各执行一次，均退出0；前者核验CLI原文与确认解析，后者用实际Pi/faux和本地发送核验六工具合同、排队确认、发送/登记失败不重发、过期卡、宿主重复幂等及丢失回执后查询。Store在该离线检查中由合成实现替代，不能把通过结果说成当前MySQL并发验收；真实事务、身份/群隔离与进程退出证据仍引用[2026-10-06工程复核](#本轮稳定主线工程复核2026-10-06)，本轮未重跑数据库、模型或QQ。仅补材料与计划状态，默认配置和C1/O4/O5准入状态不变。

## 确认与持久化边界

每张演示订单只有一个协商任务和一个当前退款操作；重复协商保留原任务与原因。操作绑定可信 AppID、发送者、客户及原会话：QQ 必须由原用户在原群确认或查询，CLI 使用独立会话，不能换入口接管。

退款方案从生成起有效 15 分钟；过期或审批/金额变化后重新准备会轮换操作编号，旧指令永久失效，新方案必须重新成功展示并确认。确认时再次检查归属、原审批、单券未核销且有效、全额支付、无历史退款和整笔金额。拿齐事务锁后复核有效期，在同一事务中插入退款记录、更新订单及券、保存确认时间和结果；并发确认最多产生一笔退款。首版不支持部分退款。

仅查询过期方案时，返回原编号的过期状态卡，不显示确认按钮，也不尝试登记为可确认方案。用户明确要求重新生成后，Agent 重新查询订单、适用规则及原商家批准，再展示新编号；旧编号不能用于确认新方案。发送与登记间跨过有效期时，业务服务仍会拒绝登记或确认。

2026-10-03 双用户并发准备方案的工程检查复现 `ER_LOCK_DEADLOCK`：默认 `REPEATABLE READ` 下，查询尚不存在的 `refund_operations.order_id` 所持空范围锁与另一订单插入相互等待。退款入口现仅对下一笔事务设置 `READ COMMITTED`，不修改连接会话或全局隔离级别；同订单仍先锁订单行，并保留身份、审批、金额、期限复核及唯一幂等约束。双用户集成和既有退款数据库检查均已通过。

D1 账户可读写协商任务、D3 通知及 `conversation_state`（SELECT/INSERT/UPDATE）；有界上下文表仅在显式启用 Controller/mysql 时使用，D1 不能写订单或退款。D2 使用独立账户，仅能写退款操作、插入退款记录、更新订单的状态/已退金额和券状态，不能修改身份、支付或商家审批。基础订单/规则工具继续使用 SELECT 账户。

商家 worker 与 QQ/CLI 同进程、默认每 500 毫秒扫描；停机时不执行，重启后继续检查，已过截止时间进入超时。业务状态跨重启保存，Pi 对话仍在内存中，重启后查询需提供订单号。

### 协商终态与截止时间调用链审计（2026-10-08）

**本轮唯一目标与合同：** 客户等待商家结果时，重复、迟到或乱序结果不能覆盖已落库终态，商家批准也不能直接写退款。面试追问是“500毫秒轮询如何与8秒截止配合，停机和并发时以什么作为接受时点”。个人实现为宿主确认、持久任务、条件状态迁移及同进程worker；复用Pi工具循环、MySQL和既有D2校验，不接真实商家。预算30分钟、0远程模型/真实QQ/数据库请求，仅追踪正式调用方、既有断言及官方时间函数语义，核对文档差异/链接后收尾；不增加调度系统或重跑历史模型题。

| 环节 | 源码、实际行为与取舍 |
| --- | --- |
| 先确认再创建 | [`confirmMerchantReply`](../src/after-sales-entry.ts)只解析实际用户原文，模型工具[`prepare_merchant_request`](../src/agent.ts)只读。`AfterSalesStore.request`重新授权后以订单唯一键创建任务；重复确认保留原任务、原因及期限，不开启第二次尝试。 |
| 两种时间各有用途 | [`request`](../src/after-sales.ts)约第134行按数据库UTC时间保存`due_at=创建语句时间+场景延迟`、`deadline_at=同一语句时间+8秒`。[场景及状态约束](../db/05-merchant.sql)限制延迟1–5000ms、时间顺序和状态/金额/完成时间的组合；CHECK不负责禁止终态被任意UPDATE改写。 |
| 先过期，再处理到期结果 | `processDue`约第256行先将全库已过截止的pending改为timed_out，再选全库due已到、deadline未到、非timeout的pending，每批最多100条。逐条调用`applyResult`，不是直接写SELECT得到的结果；两条语句和整批处理不在同一事务中，单条失败前已写入的结果不回滚。 |
| 接收边界集中在UPDATE | `applyResult`约第240行只接收合法任务/订单及approved/rejected；批准必须为正整数分，拒绝必须无批准金额。条件UPDATE再核对taskId、orderId、pending、截止时间和金额不超过申请额，只有affectedRows=1才算本次迁移成功；已批准、拒绝或超时的任务不能被此入口再次覆盖。正式`src/`调用方只有worker，没有网络商家回调端点或模型回调工具。 |
| 调度与业务决定分开 | [`CLI`](../src/cli.ts)初始化、[`QQ ready`](../src/qq.ts)启动`startMockMerchant`，默认立即扫描并每500ms再尝试，分别最多一个轮询和一个通知Promise；该限制属于单个worker实例，多个进程仍可能并发。最终状态由数据库条件UPDATE裁决；慢通知不阻塞期限推进，停机/积压/数据库故障仍可能使原本approve的任务超时，5秒/8秒不是完成SLA。 |

例如任务due在第5秒、deadline在第8秒：第7.9秒被扫描选出、结果UPDATE到第8.1秒才开始时，未过截止条件不成立；任务可暂留pending，下一次成功扫描才写timed_out。`getTask`仅重新授权并读取持久状态，不在查询中补写超时；worker停机期间过期也可能仍显示pending。批准状态与通知sent均不等于退款，D2仍在[`RefundStore.eligible`](../src/refunds.ts)复核当前订单、审批和金额，并要求展示及用户精确确认。

**时间语义与未验证项：** MySQL 8.4的`UTC_TIMESTAMP()`在每条查询开始时求值一次，不能称为取得行锁或提交时的实时钟；依据[官方时间函数说明](https://dev.mysql.com/doc/refman/8.4/en/date-and-time-functions.html)（查阅2026-10-08；适用MySQL 8.4，[compose](../compose.yaml)声明8.4.11，本轮未连接核验实例）。因此“UPDATE在截止前开始，却等行锁到截止后”的情况，不由现有材料证明拿锁后拒绝；这与D2取锁后另查`decisionTime`的实现不同。现有合同未明确要求按提交时点判截止，本轮不据未复现推断修改接收语义。随后专用库的[单条复现](#行锁跨截止定向复现2026-10-08)已确认此窗口会接受，该审计当轮的取锁后拒绝尚未实现/未准入；后续修复与新证据见[取锁后截止复核](#取锁后截止复核2026-10-08)。

**可复现入口与本轮结果：** 复用`node --env-file-if-exists=.env scripts/merchant-db-check.ts`，须先满足[全库扫描准备条件](#启动)。该脚本第98–113行检查错误任务/订单、金额、重复及反向结果，第124–131行先过期再提交结果，证明历史验收中worker未扫描也拒绝已经迟到的调用；第133–148行仅重建Store/连接，不能称为真实进程重启。它没有专门验证锁等待跨截止、approve/reject并发或扫描间恰好跨截止。本轮基于`cdeaf9e`完成源码与这些断言审阅，未执行SQL、Pi或模型检查；历史MySQL/真实QQ记录见[验证记录](#验证记录)，不追加新成绩。仅补本文和计划，默认atomic/lexical/memory/id与C1/O4/O5状态不变。

### 行锁跨截止定向复现（2026-10-08）

**本轮合同：** 只核验商家结果UPDATE的接受时点：截止前开始，但等待行锁到截止后是否仍接收。面试追问是“条件UPDATE用的是语句时间还是取锁后的时间，`completed_at`能否当提交时间”。个人实现仍为`AfterSalesStore.applyResult`，复用MySQL行锁/时间函数和标准库，不改Pi或生产逻辑。30分钟内只执行一次专用库检查；同步前提不满足即记失败/未完成，不临时追加批次。0远程模型/QQ/业务资金写入。

复现入口：`node --env-file-if-exists=.env scripts/merchant-deadline-lock-db-check.ts`。仅允许本机Compose的`127.0.0.1:13306/dave_agent`；管理员复制当前`merchant_requests`表结构到随机专用库，创建随机受限账号，只插入一条合成pending任务，检查窗口压缩为4秒（生产创建窗口仍为8秒）。`CREATE TABLE LIKE`保留列、索引与CHECK，但不复制外键，本检查不证明订单归属/确认/退款或完整授权链。正式Store使用该专用库；不调用`processDue`，不扫或写主业务库。结束关闭连接并删除本轮库/账号；清理失败须显式报告残留。

同步条件为：独立连接先持有该行`FOR UPDATE`锁，正式`applyResult`连接启动后，服务器`data_lock_waits`确认它被此连接阻塞，且此时数据库UTC仍早于deadline；再等数据库UTC超过deadline至少300ms后才释放锁。释放前时间是取得锁的下界，不冒称精确取锁或提交时刻；检查输出包含实际服务器版本、事务隔离级别、源码SHA-256、deadline、锁等待观察时间、释放前时间、完成字段及最终接受状态。重放旧结果/模型固定回答不能代替此SQL执行证据。[锁等待关系](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-lock-waits-table.html)与[表结构复制范围](https://dev.mysql.com/doc/refman/8.4/en/create-table-like.html)依据MySQL8.4官方文档（查阅2026-10-08）。

**唯一批次结果（北京时间03:09，已收尾）：** Node `v26.10.0`、实际MySQL `8.4.11`、`REPEATABLE-READ`；生产源码基线`8ea3d64`，`src/after-sales.ts` SHA-256为`1100a2158af2e368e4e13706fc850c901bda647e3b874850f1c4d593c3a3a5d1`，生产逻辑未改。同步断言与连接/库/账号清理通过，脚本退出0，独立TypeScript检查通过。只执行1/1条合成工程样本；运行后独审仅修正检查脚本的writer等待超时设置与主异常/清理异常合并，最终版本再做类型检查，未追加DB批次或故障注入，不把收尾修订追认为新版DB成绩。退出0说明行为刻画和前提核验完成，不代表过期拒绝通过。0远程模型/真实QQ/主业务库写入；该专用库只含协商表，不存在订单/券/支付/退款写入权限或表，不证明完整售后链。

| 数据库UTC记录（2026-10-07） | 实际值与含义 |
| --- | --- |
| 语句时间 `completed_at` | `19:09:46.133`，早于deadline；不能作为提交完成时间。 |
| 已观察到对应连接锁等待 | `19:09:46.261`，仍在截止前。 |
| 任务deadline | `19:09:49.995`。 |
| 释放行锁前时间下界 | `19:09:50.310`，已晚于deadline **315ms**。 |
| 等待UPDATE完成后再读取 | `19:09:50.318`；`applyResult=true`、`approved`、批准7980分。 |

**决定与下一步：** 已证实当轮基线接收采用语句开始时间；本轮不扩成生产修复或重复样本，保留单次结果与默认配置。8秒是模拟结果接收窗口，不是完成SLA；该复现基线不能承诺取得行锁后已过期必拒绝，也不能用`completed_at`证明截止前完成。当时严格的取锁后过期拒绝性质尚未准入：下个独立P0修复点须先明确接受时点，复用D2的“锁后另查数据库时间”方案及这条竞争窗口作拒绝回归，比较额外事务/查询成本；无需改Pi、题集或追加远程模型。未重验approve/reject并发、worker全库扫描或QQ，C1/O4/O5未完成状态不变。后续修复见下节，旧结果保留。

### 取锁后截止复核（2026-10-08）

**本轮P0合同（实施前固定）：** 真实约束是商家结果不能靠截止前排队获得过期批准，批准仍不等于资金授权；面试追问是“语句开始、拿锁、提交哪个时点决定接收，如何处理迟到和重复结果”。接受时点固定为同一事务取得任务行锁后，结果UPDATE开始时的数据库UTC；`deadline_at > 决策时间`才可接收，等于截止也拒绝，不要求提交在截止前。拒绝返回false并保持pending，超时落库仍由既有worker负责。

个人实现只修改共享`AfterSalesStore.applyResult`：复用已有`transaction`，先按任务/订单`FOR UPDATE`，再执行原条件UPDATE；复用MySQL和D2的锁后新语句取时思想，不改Pi、调度或业务权限。对照为上节已经归档的旧源码接受样本，旧结果不回填；验收复用同一真实服务器锁等待窗口，新增严格拒绝断言并检查正常批准/拒绝、错误任务/订单、超额和重复终态。固定30分钟、仅一组专用库回归，同步或清理失败就保留失败收尾；随后执行项目`validate`及独审，修复失败只重跑受影响工程检查。0远程模型/真实QQ/主业务库写入，不追加实验。

**取舍：** 原路径1条autocommit UPDATE，修复为BEGIN、锁定SELECT、条件UPDATE、COMMIT，共4条命令；多一次查询和事务边界，连接及行锁持有至事务结束。保持原UPDATE的任务、订单、pending和金额校验，避免在锁定语句里提前冻结截止判断。没有测量生产吞吐或延迟收益，不增加事务框架或消息中间件。专用表不含外键、订单/身份/退款链，结果只能证明这个接收边界；C1/O4/O5和历史QQ/模型成绩不随之升级。

**实施与验证结果（北京时间03:27，单次专用库回归通过）：** 生产基线`85ac798`，改动仅为[`applyResult`](../src/after-sales.ts)复用事务、锁行、再执行原UPDATE；源码SHA-256为`a26db542010fb3471215ff63295fc3d0dbbb7ce6d2be7ba8fe8550b008148cd1`。[`merchant-deadline-lock-db-check.ts`](../scripts/merchant-deadline-lock-db-check.ts)现为严格拒绝回归，旧刻画版本/结果保留在`85ac798`和上节；同一随机专用库完成1/1条竞争窗口及8/8次正常/边界调用，退出0、连接/库/账号清理成功。Node `v26.10.0`、实际MySQL `8.4.11`、`REPEATABLE-READ`；不使用全库worker，主业务库无写入。

| 数据库UTC记录（2026-10-07） | 新版实际值与结论 |
| --- | --- |
| 截止前已观察对应连接锁等待 | `19:27:16.858`。 |
| 任务deadline | `19:27:20.592`。 |
| 释放行锁前时间下界 | `19:27:20.914`，晚于deadline **322ms**。 |
| 返回后读取 | `19:27:20.924`；`accepted=false`、`pending`，批准金额和`completed_at`均为NULL。 |
| 同专用行的8次调用 | 错任务、错订单、超额均false；正常批准true、重复/反向结果false；重置合成前置后正常拒绝true、再次批准false，最终持久状态为rejected、空批准金额、有完成字段。 |

原v2源码合同不覆盖新语义，新增[`v3实现合同`](../data/support-v2-validation-contract-v3.json)引用并固定旧v2字节；[`合同检查`](../scripts/support-validation-data-check.ts)固定新源码哈希、原24题/79轮与业务oracle，保留未执行/4项deferred，不能将源码更新当新模型成绩。合同检查、预检typecheck及最终`npm run validate`均退出0（完整检查外层22.400秒），只读独审无阻断；合同直接检查与validate中的重复核验不计独立样本。验证使用当前工作区依赖，用户已有package变更保持原样、不纳入提交；没有业务远程模型/真实QQ或完整MySQL售后重验。

**收尾与边界：** 本片“持有任务锁后新UPDATE开始时已过期则拒绝”的工程性质已通过；没有测量精确取锁/commit时间，没有补测截止瞬间相等、approve/reject并发、全库worker或真实渠道。拒绝后pending等待后续扫描改timed_out是原有语义；不改C1/O4/O5准入或固定题结果。后续若追问并发裁决，另立同任务approve/reject竞争的一组定向合同，本轮不追加。

**提交收尾核对（2026-10-08）：** 独立15分钟片只核对并提交上述六文件，防止已验证修复与归档证据脱节；源码及数据库检查脚本SHA-256与前轮记录相同，v3与旧合同/题集/迁移引用及本节4处文件链接通过。Node `v26.10.0`下仅执行一次`node scripts/support-validation-data-check.ts`，退出0；当前校验脚本SHA-256为`a34166077f4190726487fd646a167a1b11ac9f2c53e66759a665e7bc3f4a9eba`。数据库样本及完整`validate`沿用前轮归档，本次未重跑或追加为独立样本；无新模型/DB/QQ调用，无生产逻辑改动。差异核对后只精确提交本片六文件，保留用户package与IDE改动，完成即收尾。

## D3 原会话通知

新建 QQ 协商任务时，宿主在同一事务中保存原确认消息的 AppID、发送者、群 OpenID、消息 ID 和时间；不保存用户正文。`task_id` 唯一，重复确认不会改向、刷新时间或重新开启已处理通知。CLI 和迁移前没有路由的任务继续由用户查询，不补造通知目标。

QQ 就绪后启动原有商家 worker：先更新到期任务，再扫描当前 AppID 已终态且通知为 `pending` 的记录。业务事件与用户消息进入同一个“群＋发送者”串行队列，队列满时暂留 `pending`。出队后原子领取通知、重新检查任务归属与终态，通过 Pi 的普通 `prompt` 路径续接客服上下文；事件处理期间仅开放 `get_merchant_request`，不进入用户确认入口，也不开放退款准备或执行。最终使用对应任务的固定状态卡，不能由模型改换订单或宣称已退款。

通知只回复原确认消息，保留其消息 ID 和时间，不借用后来其他问题的消息延长窗口。应用在排队和发送前检查原消息是否仍在 **4 分 30 秒**内，这是本项目留出余量的本地限制。过期或当前群不在白名单时记为 `deferred`，不再主动发送，业务结果仍可查询。

每条通知最多领取一次：`pending → claimed → sent / deferred / unknown`。`sent` 表示 QQ API 明确接受，不能证明用户已读。发送失败或结果不明记为 `unknown`，不自动重发；进程在领取后退出，记录保留 `claimed`，重启也不重发，避免已送达但未落库的消息重复出现。重启只恢复尚未领取的 `pending` 通知；这保证至多一次主动尝试，不保证每个结果都主动送达，用户按订单号查询是恢复途径。商家轮询与通知各自只保留一个进行中的 Promise，慢模型不会阻塞其他任务到期处理。停机先停定时器并关闭 Agent、取消未发送的模型处理，再等待当前处理收尾；已开始的 HTTP 发送仍可能完成。未增加独立定时器或消息中间件。

### 通知领取与失败恢复调用链审计（2026-10-08）

本轮核验默认 atomic 的 D3 通知链。业务约束是原客户、原会话、原任务和原回复窗口不能被后续消息替换，商家批准不等于退款授权；面试追问是“为什么先排队再领取，发送成功但登记失败后如何恢复”。个人实现为路由保存、串行调度、领取状态和固定卡，复用 Pi 请求/取消、QQ SDK 和 MySQL；Controller 的零模型通知另作候选，不混用验收。预算30分钟，既有 `node scripts/merchant-notification-agent-check.ts` 离线检查一次，0远程模型/QQ/数据库请求；核对源码、检查和链接后收尾，不加消息中间件或重跑历史题集。

以客户确认 `COUPON-2001` 后等待商家、期间继续咨询另一单为例，沿正式调用方追踪：

| 环节 | 源码与实际行为 |
| --- | --- |
| 保存原路由 | [`qq.ts`](../src/qq.ts) 的用户确认 hook → [`confirmMerchantReply`](../src/after-sales-entry.ts) → [`AfterSalesStore.request`](../src/after-sales.ts)。任务和通知路由同事务创建；仅首次任务插入保存消息ID/时间，重复确认不刷新窗口，CLI不补造路由。 |
| 到期与通知分开推进 | `qq.ts` 的 ready → `startMockMerchant → store.processDue → afterProcess` → [`dispatchMerchantNotifications`](../src/merchant-notifications.ts)。worker分别限制一个在途轮询和一个通知批次，慢Pi请求不阻塞商家期限推进；`listNotifications` 只选当前App的终态任务及pending通知，按创建时身份绑定代次和订单归属联查，批次上限20。 |
| 排队后才领取 | dispatcher → [`QQAgent.resumeMerchant → enqueue`](../src/qq-agent.ts)。与用户共用“群＋发送者”队列；满队列返回busy且不领取。出队再次检查原消息窗口后才调用 `claimNotification`，条件UPDATE重新校验绑定/归属和pending状态，只有一个竞争者能领取；随后 `getTask(referenceTaskId)` 再读原任务。应用队列不替代数据库原子领取。 |
| 通知不能变成确认 | 默认atomic只开放 `get_merchant_request`，跳过用户确认hook；即使模型查另一单或输出退款成功，发送仍使用出队后核验的原任务构造固定 `merchant_status`。终态卡没有退款确认按钮。Pi结果事件以不触发新轮的custom message写入内存，不能据此声称持久焦点或重启后聊天恢复。 |
| 发送与登记有间隙 | `QQAgent.deliver → sendQQReply` 接受后，dispatcher才 `finishNotification`。窗口失效/禁用群/无有效任务为deferred；发送或交付后hook异常为unknown；落库失败则可能留在claimed并报状态不明。`qq.ts` 停机先停止worker新调度，再关闭/取消Agent并等候收尾；已开始的网络发送可能完成。 |

例如QQ已经接受卡片、但写sent前进程退出，存储仍为claimed；重启扫描不会领取它，也不会用客户后来发的消息续原窗口。unknown同样不自动重发，尚未领取的pending仍可在有效窗口内尝试。由此保证的是本应用至多一次主动发送尝试，代价是可能漏通知；它不保证平台恰好一次送达或用户已读。客户可在原会话明确查询 `COUPON-2001` 协商进度，再重新读取订单/规则/批准并请求退款；通知状态本身不授权资金操作。改成超时重领会引入重复发送，只有业务明确要求送达重试且能处理重复时才考虑。

**本轮结果：** 基于源码基线 `72e9f7d` 核对正式调用方，未发现需要修改生产代码的有证据缺陷。上述离线检查执行一次、退出0，覆盖队列满不领取、排队过期、固定原任务/路由、确认隔离、并发领取、unknown/claimed不重发、模型失败兜底及关闭中断。它使用实际Pi/faux和QQAgent，但Store状态由合成实现替代，所谓重启是重建Agent并保留合成状态；不能证明当前SQL原子性或真实进程退出。数据库条件UPDATE、连接重建和worker并发证据复用[2026-10-06工程复核](#本轮稳定主线工程复核2026-10-06)及[通知DB检查](../scripts/merchant-notification-db-check.ts)，本轮均未重跑。仅补本文和计划，0远程模型/真实QQ/数据库请求，默认配置与C1/O4/O5准入不变。

### 通知发送前身份复核（2026-10-08）

业务约束：创建任务时绑定的身份代次与订单归属在通知发送前仍须有效，出队读取不能授权随后整段模型等待。面试追问是“商家通知已经领取，模型等待期间解绑或重绑，旧客户结果会不会发出”。本轮先以实际 Pi/faux、dispatcher 和 QQAgent 的受控等待复现，再只在现有发送路径复用 `getTask(referenceTaskId)` 复核；个人贡献是复核时点与拒发边界，复用 Pi 生命周期、现有身份联查和领取状态，不增加数据库表或模型角色。

验收覆盖正常模型结果、模型失败兜底和零模型宿主通知；在首次授权读取后改变合成授权结果，断言不发送、不重复领取、不执行资金操作。身份读取异常也须拒发；正常通知仍使用原任务和原路由。预算30分钟、0远程模型/真实QQ/数据库请求：一次修复前定向复现、一次修复后定向回归及项目要求的最终 `validate`；失败只修受影响代码，不重跑模型题集。复核时点定义为发送前最后一次授权读取的快照；数据库读取与QQ网络发送不在同一事务，不能承诺发送已开始后撤销立即生效。


**实现与取舍：** [`QQAgent.enqueue`](../src/qq-agent.ts) 的局部 `deliverMerchant` 覆盖普通模型、模型失败兜底和零模型宿主通知；[`dispatchMerchantNotifications`](../src/merchant-notifications.ts) 的同一 resolver 仅首次领取，第二次只复用 [`AfterSalesStore.getTask`](../src/after-sales.ts) 的精确任务/创建时身份代次/当前订单归属联查。复核拒收、异常、错任务或非终态都返回 deferred；渲染使用第二次读取的任务，拒发时丢弃当前 Pi Session，避免保留本轮旧事实。未改变确认/退款边界、状态表或默认 atomic + lexical + memory + id。相对原路径，每次走到发送边界增加1条授权 SELECT（任务读取1→2），并增加数据库不可用时的漏通知概率；查询延迟未测量。不持有数据库锁等待QQ网络，最后读取快照之后的解绑仍不能原子撤回已开始发送。

**实际证据：** 源码基线 `fc0fe64`；Node v26.10.0，复用 Pi 1.0.0。修复前 `node scripts/merchant-notification-agent-check.ts` 单次在首个 model 场景断言失败：已领取、首次读取后受控等待，合成授权失效却仍 sent；退出1、外层0.702秒，后五项未执行，不能算六项失败。修复后同入口一次退出0、外层0.375秒，新增6/6拒发场景覆盖正常模型、空回复兜底、Session创建后host通知、读取异常、错任务及pending；均读取两次、仅领取一次、无发送/准备，deferred再次调度不重试。正常发送及并发领取、unknown/claimed不重发等原断言仍通过。前置typecheck发现新增测试变量的TS7022推断错误，显式类型修正后最终 `npm run validate` 退出0，包含宿主通知回归；聚合重复同一用例不算独立样本。独立只读审阅无阻断。

源码SHA256：`src/qq-agent.ts=febde3ea659e30ecc21f289fe1df734ea4cee309268de32dd3bd42513e0ac225`；`src/merchant-notifications.ts=63fa4fea4ba027b883e48ac4ce8b90822b729a59bac0c0b8666f01f93b62eb1b`。检查入口：[merchant-notification-agent-check.ts](../scripts/merchant-notification-agent-check.ts)（SHA256 `29d46b5ba648dd68e355301cf66afc4f23fa4404fa2b46f8ff352c741c0fae21`）；[support-notification-check.ts](../scripts/support-notification-check.ts)（`e8a971875f056193fabe261a465dc151663638fd21d803464f578e83b2317259`）。

本轮为实际Pi/dispatcher/QQAgent与合成Store授权、脚本模型及本地发送记录；0远程模型/真实QQ/数据库/真实资金请求，不证明实际MySQL重绑并发或平台接受时刻。拒发后的Session清理由源码与独审核对，未单独验收后续普通请求重建。旧固定manifest/gold、原始成绩及O4历史合同未改；O4 rotation原严格调用序列只有一次任务读取，新源码若启动新批次须先版本化该实现合同，不能据本次validate冒称新O4集成通过。C1/O4/O5仍未完成；按预声明次数收尾，不追加模型或DB批次。下一步若补实库证据，只为末次精确任务读取单立隔离重绑合同；真实QQ须用户参与。

## 验证记录

以下先说明各脚本的覆盖范围；历史通过记录不作为本次执行结果。同一进程内重建 Store、数据库连接或 QQAgent，只证明对象重建后的持久查询；真实进程退出后查询的本轮工程证据见[双子进程检查](#本轮稳定主线工程复核2026-10-06)，历史真实QQ机器人重启记录在后文单列。

- `npm run check:merchant`：真实 MySQL＋Pi/faux，覆盖协商归属、精确确认、重复申请/回调、同意/拒绝/超时、同进程重建 Store/连接后查询及 D1 不写退款。
- `npm run check:refund`：真实 MySQL 与离线 Pi/QQ handler，覆盖发送门槛、未确认/越权/跨群、15 分钟有效期、金额或审批变化、并发幂等、事务结果和同进程重建 Store/连接后查询。工程检查不计作真实模型成绩。
- `node --env-file-if-exists=.env scripts/qq-isolation-check.ts`：真实 MySQL＋Pi 脚本模型＋单个 QQAgent，复用正式通知 dispatcher 和确认/发送成功 hook，QQ 发送由本地记录替代。同群两客户分别使用 79.80/59.90 元临时订单，验证一人阻塞时另一人完成、上下文标记隔离、互查拒绝、原路通知、并发方案、交换确认后数据库不变、各自合法及重复确认仅一笔退款、新 Agent 查询；这是工程集成，不计为真实模型或 QQ 客户端验收。
- `npm run check:merchant-model`：独立 D1 真实模型检查，验证准备、宿主确认、等待期间继续 FAQ、原任务查询；QQ 发送在本地替代。
- `npm run check:refund-model`：真实 DeepSeek＋MySQL＋QQAgent，QQ 发送在本地替代；保存独立 `after-sales-refund-v1` 套件到评测工作台。运行前执行 `npm run eval:init`，需要模型凭据，可能产生费用。
- `node --env-file-if-exists=.env scripts/merchant-notification-db-check.ts` 的历史工程记录已通过：原确认路由、重复确认不改向、CLI 不补路由、身份/来源检查、三种商家终态、并发唯一领取、同进程重建 Store 后 pending 恢复与 claimed 不重发、worker 串行收尾和数据库权限。创建并清理带随机标记的临时订单，订单与退款事实未改变；执行仍须满足[启动](#启动)中的全库扫描前提。
- `npm run check:merchant-notifications` 运行 D3 数据库与离线 Agent 检查；`npm run check:notification-model` 现运行联合套件 `merchant-notification-v2`。历史 15 轮版本 run `2ba8c394-395e-421d-83eb-c48dcc2aa6ff` 为 3/3 场景、15/15 处理轮（12 用户 + 3 事件）、100/100 检查，31 次模型请求均报告 usage、24 次工具调用、0 工具错误。批准场景共 7 轮，覆盖通知后原会话省略订单请求退款、方案、精确确认、重复确认及重建 Agent/数据库连接查询；拒绝、超时各 4 轮，通知后追问仍不生成退款。当前 21 轮版本及失败历史见[核心业务收尾](./evaluation.md#p1-第三轮核心业务收尾)；不同题集分母不混算。QQ 发送在本地替代，历史 v1 与 D1/D2 分别保留。

D1/D2 已记录的本地端到端通过记录为 `6349a275-946c-44bc-aac2-a8b9987f55d4`：**3/3 场景、12/12 用户轮次、67/67 检查通过**。覆盖批准后的方案/精确确认/重复确认/同进程重建后查询，以及拒绝和超时不生成方案；5 个宿主确认轮不调用模型，usage 不补零。数据库权限错误、漏查 FAQ 的失败及修复后通过记录均保留。

2026-10-02 至 10-03 的历史真实 QQ 群验收使用带随机标记的临时合成订单，另行验证了以下结果；当时未消耗 100x 或 2001–2003 演示单，不能据此推定当前库仍未使用这些订单：

- 联合同意路径：准备协商、用户精确确认、自动同意通知，原会话不带订单请求退款后收到固定 79.80 元方案。普通“同意”后数据库仍无退款；按钮填字并由用户发送完整指令后才执行，API 200 与 `host_reply` 证明确认由宿主处理。
- 幂等与持久化：重复确认返回同一退款 UUID；数据库仅一笔 7980 分退款，订单与券均为 `refunded`。机器人真正重启后，`get_order` / `get_refund` 仍读取同一结果。
- 拒绝与超时：真实群分别显示固定终态卡；数据库退款方案为 NULL、退款记录为 0、已退金额为 0，券仍为 `unused`。

客户端显示、平台响应与数据库核对分别记录在 [QQ 接入记录](./qq-integration.md)。D3 真实 QQ 同意、拒绝、超时均无需追问自动送达，通知记录为 sent，未生成退款方案/退款记录。2026-10-03 同群两个真实账户各自完成 79.80/59.90 元通知、方案与幂等退款，互换退款指令被宿主拒绝，第二账户点击第一账户协商/退款按钮被 QQ 拦截。实际重启后第二账户查询到原退款；第一账户本轮为重启后首次退款，未计作退款后的重启查询。临时订单已清理，公开 2001–2003 状态与已退金额未变；完整手机样式/`modal` 和公网 Webhook 仍待验收。

2026-10-02 Prompt/Skill 的只读回归 `19cffcc5-c734-47b2-8098-5c4a0cd89869` 为 9/9 场景、10/10 轮、88/88 检查；检查器已校准且哈希改变，与历史分数不能作同条件改善比较。该轮联合链路复用已有运行时，仅调整 Prompt/Skill 与评测脚本，未增加生产 TypeScript 逻辑、API 或表；失败记录与检查器变更见 [评测说明](./evaluation.md)。真实商家外呼、网络商家回调和真实资金操作尚未实现。
