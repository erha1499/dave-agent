# 内置评测工作台

工作台和 Agent 使用同一个 MySQL `dave_agent`，由本项目的 Node 原生 HTTP 服务展示历史，不依赖外部评测平台。历史页面只读；新增“实验调试”可显式启动本机 v2 业务与离线检索实验，并保留 CLI，复用现有 Pi 会话和业务工具。配置与任务状态保存在本机 `.runtime/experiments/`，业务结果仍进入 MySQL，检索仍保存完整 JSON 报告。详见 [实验配置](./experiment-controls.md)。当前入口使用独立客观套件，下面的 D1/D2、D3 与 P1 记录保留为历史混合口径。

## 当前客观评测

三次真实模型重复与检索基线、失败定位见 [2026-10-05 结果记录](./objective-evaluation-results.md)。

本轮只检查工具选择、输入与顺序、数据库状态、固定卡片协议及运行指标。回复正文保留作诊断，不做正则措辞评分或 LLM judge。工程 gate、模型行为和离线检索分别展示，不能合成客服总分。

| CLI suite | 固定场景 / 轮次 / 检查 | 覆盖与边界 |
| --- | --- | --- |
| `readonly` | 20 / 26 / 218 | 八类订单、身份与作用域、澄清切单、未知政策取证；真实模型和 MySQL，只暴露两个只读工具 |
| `workflow` | 5 / 30 / 293 | 协商三终态、普通同意、伪称批准、等待期间 FAQ、通知、方案过期重建、确认幂等、重启及同用户跨单；六个工具，QQ 发信本地替代 |
| `engineering` | 15 / 15 / 15 | 既有数据库、脚本模型、QQ、并发恢复与评测完整性 gate；每 gate 一个检查单元，不把内部断言伪装成独立成绩 |
| `retrieval` | 290 / 290 / 854 | 选集 70 题、全量 212 题、范围隔离 4 题、无答案 4 题；原始排名计算 Recall/MRR，不调用模型 |

```sh
node scripts/objective-eval-check.ts
node --env-file-if-exists=.env scripts/evaluate.ts --suite engineering --label "工程基线"
node --env-file-if-exists=.env scripts/evaluate.ts --suite retrieval --label "检索基线"
node --env-file-if-exists=.env scripts/evaluate.ts --suite readonly --repeat 3 --label "只读客观基线"
node --env-file-if-exists=.env scripts/evaluate.ts --suite workflow --repeat 3 --label "售后客观基线"
npm run eval:serve
```

后两项调用已配置的真实模型，会产生费用。CLI 串行运行，每次使用独立 UUID，并保存批次和预定重复次数；不要并行运行会修改同一演示库的工程与售后套件。`--help` 不访问数据库。案例失败仍保存并继续计划内重复，最终命令返回非零；这与评测执行异常不同，不能因非零就删掉失败运行。开发题集不是盲测，重复成功也不证明所有问法都可靠。

新运行在开始前固定 `snapshot.content.evaluation` 的案例、轮次、检查 ID、客观依据与标签。分析始终使用计划分母，分别呈现失败、跳过与缺失；无模型请求属不适用，用量缺失和部分报告不补零。旧运行没有客观计划时标记为 `legacy`，不反推客观分数。

新增只读接口为单次 `/api/runs/<UUID>/analysis`、版本 `/api/compare?baseline=<UUID>&candidate=<UUID>` 和重复 `/api/batches/<UUID>`，保留原列表与详情。题集、检查器、业务初始条件或测量口径变化时禁止直接宣称提升；批次稳定性还要求模型、Prompt/Skill、工具、实现文件、运行环境和执行设置一致。完整契约见 [API 说明](./evaluation-api.md)。

售后评测的等待阶段由 fixture 控制：在耗时的 pending 咨询前，只把本次临时任务的 due/deadline 延后 180 秒；正式通知及确认入口照常执行。这验证等待状态下的行为，不证明生产 8 秒截止期限或 QQ 网络送达。具体状态与协议证据保存在每轮 `observations`，不参与自然语言评分。

检索 Recall@K 是该题相关文档进入 Top K 的比例，MRR 是第一篇相关文档的倒数排名；分别展示选集/全量及常规/难题。无答案非空仅是召回诊断，不是幻觉率。检索未命中和模型行为失败照实入库，本轮不据此改生产 Prompt、Skill 或检索策略；后续优化登记在 [计划](../plan.md#81-已完成全面客观评测与系统增强)。

## 评测分母与费用调用链审计（2026-10-08）

本片只审计已有评测证据，不优化模型或重跑业务题。**业务约束**是：退款取证失败后未执行的依赖轮次仍占计划分母，安全停止不自动等于业务成功，未采集用量不能声称免费。**面试追问**是：“运行已完成为何仍未通过？失败后的跳过、进程中断后的缺失和宿主确认无模型请求怎样区分？主Agent之外的费用如何计算？”**个人实现**是固定计划、采集、事务存储及分析/API；**复用**Pi事件、usage和模型目录估算、MySQL与现有执行器，不修改Pi循环。**验收**复用下述合成检查及历史结果；**预算/停止条件**为30分钟、0远程模型/真实QQ/数据库请求，链路和检查核对后收尾，不因失败分数或余量启动实验。

| 调用位置 | 实际行为与证据边界 |
| --- | --- |
| [CLI编排](../scripts/evaluate.ts) `executeEvaluationBatches` → [售后执行器](../scripts/objective-workflow.ts) | 执行前固定计划与重复次数。客观断言失败仍继续预定重复；基础设施异常停止后续运行。售后依赖失败用空步骤的`skipped`记录，不冒充模型调用；运行`completed`只表示流程结束。 |
| Pi订阅 → [采集器](../src/eval-capture.ts) `captureEvaluationTurn` | 模型消息和工具事件分别计步骤；Pi缺失usage的全零初始化在本项目非空请求中视为未报告。宿主精确确认可以没有模型步骤；模型流阶段耗时与整轮耗时分开，首次中间文本不当作最终答案首字。 |
| [持久化](../src/eval-store.ts) `startRun/saveCase/finishRun/getRun` | 开始写固定计划；案例、轮次和步骤同事务保存，回读用一致快照。执行器不重试提交结果未知的案例写入；未落盘项目由分析标`missing`。本轮只核对源码，未重新验收MySQL事务或真实进程中断。 |
| [分析器](../src/eval-analysis.ts) `objectivePlan/analyzeEvaluation/analyzeBatch` → [HTTP](../src/eval-server.ts) | 从计划ID重建分母；重复/未规划结果或伪称通过的缺检查记录标`invalid`，旧记录无计划标`legacy`。批次缺少预定重复则`missingRuns`增加、稳定性`incomplete`，完整用量留空；API直接返回这些分析，不按已执行成功项目重算分母。 |
| [归因分析](../src/support-evaluation.ts) `analyzeSupportSpans` | 旧模型步骤只统计Agent；已采集提供商span按Agent、问题解析、重排、支持判别分角色，USD/CNY分列。父子重复用量报告异常且不相加，已知小计与完整金额分开；没有历史span时归因为null，不追造费用。详见[增量API合同](./evaluation-api.md#v2-执行归因增量字段)。 |

一个可复现例子在[现有分析检查](../scripts/eval-analysis-check.ts)：两次模型步骤中只有一次报告12 tokens、USD 0.001，得到coverage=1/2、knownTokens=12、knownCostUsd=0.001，但completeTokens/completeCostUsd均为null。计划重复2次而只有1次记录时，第二次仍算缺失。另一个合成API例子保留1次Agent步骤与2个提供商请求：USD已知、解析请求CNY未知，两者不混算，也不把步骤再加到账本。这些数值是检查输入，不是本轮真实消费。

选择保留旧汇总并增量分析，便于兼容历史记录；相比直接把`metrics`当总分/总费用，多维护一层计划与采集完整性，但能解释缺失。旧`summarizeEvaluation`的数值可能只是已报告步骤之和，必须结合coverage与complete字段阅读。提供商完整金额也只覆盖已采集span，不证明覆盖所有原始HTTP、重试、账户请求或商业账单；取消/输出无效亦不证明供应商未计费。

最小复现入口（无env-file，不启动业务套件）：

```sh
node scripts/eval-check.ts
```

本轮源码基线`8b65de0`、Node `v26.10.0`；上述聚合检查退出0、外层10.202秒，覆盖事件采集、计划/缺失/跳过、费用分析、合成HTTP与编排负控。随后直接执行`eval-analysis-check.ts`和`objective-eval-check.ts`也退出0（0.189/0.800秒），但聚合入口已包含它们，此重复复核不计独立样本，后续只用聚合入口即可。Store/API由内存替代，Pi事件合成、提供商为替代传输；没有真实模型、QQ或数据库验收，也未修改源码、固定题/gold/原始结果或默认演示配置。历史真实售后失败仍见[205/293与292/293检查记录](./objective-evaluation-results.md)，本轮不重跑或追认通过；C1/O4/O5仍未完成。

## 开始使用

```sh
npm run db:up
npm run eval:init
npm run check:eval-db
node --env-file-if-exists=.env scripts/evaluate.ts --suite readonly --label "团购券客观基线"
npm run eval:serve
```

打开 [本地评测工作台](http://127.0.0.1:3001)。`eval:init` 幂等增加四张表和独立评测账户，本机缺少 `EVAL_DB_PASSWORD` 时生成随机密码写入被忽略的 `.env`。不重新 seed、不删除 volume、不更改现有订单或 QQ 绑定。更换现有数据库时，先确认 `DB_HOST/DB_PORT/DB_NAME` 指向本项目 Docker MySQL；此初始化脚本通过本项目容器管理员执行迁移。

`EVAL_DB_USER` 默认为 `dave_agent_eval`，只拥有四张评测表的 SELECT、INSERT、UPDATE 权限，没有业务表写权限；订单和规则工具继续使用 `dave_agent_read`，D1 协商与 D2 模拟退款各使用独立受限账户。`EVAL_PORT` 默认为 `3001`，页面服务只监听 `127.0.0.1`，与 QQ 公网回调入口分开。

`check:model` 调用已配置的真实模型，会产生模型费用。每次运行使用独立 UUID，不覆盖历史。评测题目、订单、知识和身份均为合成数据；实际 QQ 身份、密钥和线上对话不会采入本轮快照。旧 `.runtime/coupon-model-results.json` 没有完整断言、耗时和 usage，不导入并补造指标。

## D1/D2 模拟售后评测

```sh
npm run after-sales:init
npm run check:refund
npm run check:refund-model -- --label "D1 D2 售后基线"
```

`after-sales-refund-v1` 是独立真实模型套件，使用临时合成订单，执行 DeepSeek＋MySQL＋QQAgent；QQ 平台发送替换为本地函数。三场景为批准后确认退款、商家拒绝、商家超时；成功路径包括发送成功后开放确认、重复确认幂等和重建 Agent/数据库连接后查询。12 个用户轮次中，7 轮调用真实模型，5 轮由宿主处理精确确认；模型请求次数另按真实事件统计。

2026-10-02 已记录通过运行 `6349a275-946c-44bc-aac2-a8b9987f55d4`：**3/3 场景、12/12 轮、67/67 检查通过**，21 次模型请求、15 次工具调用、0 工具错误，21/21 请求报告 usage；80,971 Tokens，SDK 估算费用 $0.005344704。首次数据库权限错误、后续漏查 FAQ 的失败与修复后的通过记录均保留，失败依赖轮次记为跳过。真实 QQ 群也已另行完成同意退款、幂等、机器人重启查询和拒绝/超时验收；平台结果不计入本地模型套件的分母。

`check:merchant-model` 仍是独立 D1 CLI 检查，覆盖等待期间接待。D1/D2 持久评测由 `check:refund-model` 完成；历史只读 9/9 成绩不属于售后套件，也不与它直接比较通过率。

当时同版 Prompt/Skill 的只读回归 `8c921f5f-eb37-44c0-86e9-bedc23eb6727` 为 9/9 场景、10/10 轮、88/88 检查，26 次请求、16 次工具调用、2 次预期身份拒绝、0 次意外工具错误；与 D1/D2 套件分别计分，不作为本轮回归。

## D2/D3 联合评测

运行 `npm run check:notification-model -- --label "D2 D3 联合基线"`，当前套件为 `merchant-notification-v2`：3 场景、21 个处理轮次，由 18 次用户发言和 3 次 `[商家结果事件]` 组成。批准场景 13 轮：准备协商、精确确认、等待期间套餐咨询、主动通知、原会话请求退款、查询待确认方案、查询过期方案、明确请求重新生成、旧编号拒绝、新编号确认退款、重复确认、查询成功结果、重建 Agent/数据库连接查询；拒绝和超时各 4 轮，通知后同样追问退款并验证不生成方案或退款。6 个宿主确认轮不调用模型，首字和 usage 留空。历史 v2 有 15、17、20 轮版本，按题集/检查器快照区分。

真实 DeepSeek、MySQL、QQAgent 与正式通知 dispatcher 均参与，只有 QQ 发信被本地函数替代。事件轮仅查询原协商，不准备或执行退款；用户后续轮恢复正常工具并重新读取订单、规则及审批。2026-10-02 的 15 轮版本最终 run `2ba8c394-395e-421d-83eb-c48dcc2aa6ff` 为 **3/3 场景、15/15 处理轮、100/100 检查**，31 次模型请求均报告 usage、24 次工具调用、0 工具错误，已回读核对配置哈希。首次联合 run `3de89726-1d69-4c59-a236-2c946dcd7f88` 为 2/3 场景、14/15 轮、99/100 检查，暴露拒绝后追问漏查 FAQ；补充 Prompt/Skill 后复测，失败历史保留。窗口、并发、跨用户与网络失败仍由工程检查另外覆盖。

2026-10-02 联合链路复用现有运行时，该次未新增生产 TypeScript 逻辑、API 或表。真实 QQ 另行通过自动通知至退款、普通“同意”不执行、精确确认与重复确认、真正停止并重启后查询；客户端与平台验收不计入本地模型分母，详见 [QQ 接入记录](./qq-integration.md#d2d3-联合闭环)。

此前 Prompt/Skill 的只读套件 `coupon-support-v1`，run `19cffcc5-c734-47b2-8098-5c4a0cd89869` 达到 **9/9 场景、10/10 轮、88/88 检查**。前序回归暴露节假日政策缺失时遗漏核实途径，以及“尚未”等宽泛匹配和否定分句导致的检查器误判；分别补充 Prompt/Skill 与校准检查器，所有失败历史保留。只读套件仅注册 `get_order` / `search_faq`，退款执行表述检查限定于未核销订单场景，不作为通用语义判定；当时 `node scripts/coupon-model-check.ts --check-assertions` 的 11 项断言、类型检查及 `npm run validate` 通过。检查器哈希已改变，不能把新旧 88 项成绩直接视为同条件效果改善。

历史 `merchant-notification-v1` 仅覆盖通知，为 3 场景、9 处理轮（6 用户 + 3 事件），与 v2 题集和断言不同，不能直接比较通过率。

2026-10-02 运行 `7b788a77-865c-44ec-a6f7-d849a8b12540`：**3/3 案例、9/9 处理轮次、60/60 检查通过**；18 次模型请求、12 次工具调用、0 工具错误，65,844 Tokens，SDK 估算费用 $0.005407896。3 个宿主确认轮没有模型步骤、首字或 usage；事件轮走正常 prompt，不能与用户确认混淆。指标不包含事件前等待商家的时间，不代表 QQ 平台送达。首轮 `1308fa18-1fbb-4278-b1ed-bbdd7282bd8a` 同样通过且保留；最终运行记录慢通知不阻塞商家轮询和停机取消后的实现快照。

## P1 第一轮检索改进后的业务回归

2026-10-04，词项检索改进后的只读套件新增“有召回但过敏原未录入”案例，该轮为 10 场景、11 轮、101 项检查。最终 run `c2386b13-e29b-4caf-88f7-01be2455d75e` 为 **10/10、11/11、101/101**；检查实际规则证据、明确未知、套餐范围，以及有限的常见成分声明和虚构入口，不作为通用幻觉率。真实 MySQL＋Pi/faux 的 `check:business` 与完整 `validate` 也已通过。

首轮 run `435e7ae4-f177-4b87-89c2-4c45606e8c03` 为 **9/10 场景、10/11 轮、100/101 检查**，新增过敏原案例已通过。唯一失败是检查器把订单事实“历史已退 0.00 元”误判为本轮完成退款；答复同时明确申请资格不等于审批或到账、当前只能查询。修复仅校准这类历史零元表述并补正反例，未修改 Prompt/Skill，也未删除失败记录。新案例与检查器哈希均有变化，不能将当前 101 项和历史 88 项分数直接比较为效果提升。

同版检索的 D2/D3 联合回归 run `5b0b2e2e-9520-4097-9871-10b3913ea9d5` 为 **3/3 场景、15/15 处理轮、100/100 检查**。使用真实模型、MySQL 和 QQAgent，QQ 发信由本地函数替代；本轮没有重做真实 QQ 平台验收，也不涉及真实资金。P1 本轮未增加依赖、修改前端或更换 Harness，SQL 作用域和资金授权仍由原业务边界控制。

## P1 第二轮多轮业务回归

只读题集扩为 14 场景、22 轮，新增切换订单后省略单号、无上下文与多订单指代澄清、已核销券口语退款追问，以及私享套餐未知政策复述。D2/D3 新增待确认与成功后的“钱退了吗”两轮，要求实际调用 `get_refund`，共 3 场景、17 轮（14 用户 + 3 事件）。以下历史均保留；联合套件使用本地替代 QQ 发送，本轮没有重新验收真实 QQ。

该轮最终只读 run `5530f13a-d8c5-4c89-94f3-e7964782a6d6` 为 **14/14 场景、22/22 轮、205/205 检查**；同版业务配置的联合 run `4e9705ae-09ba-44c9-a613-d139a808ba89` 为 **3/3、17/17、114/114**。已回读确认两者的 Prompt/Skill、工具和实现文件哈希与当时版本相符。`validate`、真实 MySQL＋Pi/faux 的 `check:business` 和离线校准均通过。这是有限题集的验收结果，提示约束不构成确定性流程保证。

| 套件 / 改动阶段 | run | 场景 / 轮次 / 检查 | 结果说明 |
| --- | --- | --- | --- |
| 只读 / 新题首次运行 | `37ec1382-1074-404a-8ad2-11a6d9b81ace` | 10/14 · 18/22 · 186/205 | 三个退款追问漏查订单，一处静态政策检查过严 |
| 只读 / Skill 每轮取证 | `e2141e6c-707e-438c-befd-c0da36ac2be8` | 12/14 · 19/22 · 186/205 | 切单追问无工具；歧义时查询两单，后续一轮跳过 |
| 只读 / Prompt 入口优先级 | `12ba907e-5790-4405-9038-03c578b7c90a` | 14/14 · 22/22 · 205/205 | 此次通过 |
| 只读 / FAQ 参数提示 | `9da25e7c-7628-441e-98e3-86dd06de238c` | 13/14 · 21/22 · 199/205 | 切单追问再次无工具 |
| 只读 / 工具描述约束 | `7e162d22-9cec-4387-8b60-e982329ecc0e` | 13/14 · 20/22 · 192/205 | 正确的无问号澄清被误拒，后续一轮跳过 |
| 只读 / 祈使澄清句校准 | `5530f13a-d8c5-4c89-94f3-e7964782a6d6` | 14/14 · 22/22 · 205/205 | 最终版本通过 |
| 联合 / 新题首次运行 | `4dff6139-8331-41e9-9038-071e9dd6e6ec` | 3/3 · 17/17 · 114/114 | 此次通过 |
| 联合 / Skill 每轮取证 | `e736c9fe-bfec-4cf9-8d7f-1c6de10ee140` | 3/3 · 17/17 · 114/114 | 此次通过 |
| 联合 / Prompt 入口优先级 | `aee79fe1-8417-4a5b-ab8e-2c2c73395c63` | 2/3 · 16/17 · 113/114 | 超时追问 FAQ 多传 `orderId` 后自纠 |
| 联合 / FAQ 参数提示 | `eae9bd00-8019-4831-8173-c7679bb3e83d` | 2/3 · 16/17 · 113/114 | 拒绝追问 FAQ 多传 `orderId` 后自纠 |
| 联合 / 工具描述约束 | `4e9705ae-09ba-44c9-a613-d139a808ba89` | 3/3 · 17/17 · 114/114 | 最终业务配置通过 |

共性失败是复用历史订单事实跳过本轮取证、歧义时边追问边查单，以及 FAQ 多传参数。已在 Prompt 加入口优先级，并收紧 Skill：歧义先等待明确订单；即使否定退款、需核实或没有操作工具，也须本轮 `get_order → scoped search_faq`；退款状态使用 `get_refund`；FAQ 仅传 `query/shopId/productId`。两次多余 `orderId` 均被 schema 拒绝，模型随后自纠，严格工具检查仍记失败，未生成退款，授权边界没有失守。随后将每轮取证和允许参数要求同步写入 `get_order`、`search_faq` 的工具描述，未增加轮次消息或上下文 hook；工具快照哈希随描述变化，不算同配置复跑。

初次静态政策复述引用了真实旧证据，强制本轮 FAQ 属于检查过严。后续“请明确是 A 还是 B”也被误判，现允许明确请求词与订单二选一语法同时出现的祈使句，并保留双订单陈述、否定请求的拒绝检查。本轮新增 21 项离线校准（12 澄清、6 未知承诺、3 历史证据）通过。检查器认可历史 FAQ 仅限 `COUPON-1008` 静态政策重复追问，须有此前成功结果；本轮 FAQ 若为空、失败或范围错误，绝不回退。其他退款仍须本轮取证。`evidenceIds` 只记录本轮工具，旧规则在前轮轨迹回看，不伪装新调用。schema 与工具错误检查未放宽；题集、Prompt/Skill 和检查器的变化按各自快照比较。

## P1 第三轮核心业务收尾

2026-10-05，本轮修复整单读取的一致快照，以及已送达的过期方案卡仍尝试登记为可确认方案的问题。联合题集补充等待商家期间的套餐咨询、过期只读查询、明确重建、新旧编号区分与旧编号拒绝，扩为 21 轮；自然到期用测试 fixture 同步前移创建、截止和已有展示时间模拟，不修改系统时钟。状态查询不能生成新方案，重新生成仍需取证和再次确认。

| 套件 / 阶段 | run | 场景 / 轮次 / 检查 | 结果说明 |
| --- | --- | --- | --- |
| 只读 / 首次收尾回归 | `610b4c4e-d2a7-43ad-84c6-8998ec471283` | 13/14 · 21/22 · 200/205 | 过敏原题未查订单，只查通用 FAQ 得空结果；4 检查失败、1 前置证据不足跳过 |
| 只读 / 套餐范围说明 | `c46dd4b7-166d-45d6-b540-bf370653a0de` | 14/14 · 22/22 · 205/205 | Prompt 与工具说明明确先查订单范围，再查套餐政策；检查器未改 |
| 联合 / 增加过期恢复 | `43abc2f6-cb25-4bc8-a749-2ac11a63b355` | 3/3 · 20/20 · 133/133 | 当时版本通过，尚未增加 pending 咨询 |
| 联合 / 增加 pending 咨询 | `9c76bb28-3822-406e-9628-b9fb21396349` | 3/3 · 21/21 · 140/140 | 实际人数回答正确；复核发现人数断言可把否定或套餐名误算正确 |
| 联合 / 限定措辞校准 | `48435f9c-3a4f-4472-9c24-31a5a7e6bdd2` | 1/3 · 8/21 · 57/140 | 正确的“券一张对应两人”被语序检查误拒；前例 pending 通知干扰后例事件 |
| 联合 / 语序与案例隔离修复 | `513fe193-53e7-4452-91cf-fc6804c7cf82` | 3/3 · 21/21 · 140/140 | 最终版通过，6 个宿主确认轮无模型步骤或首字，40/40 模型请求报告 usage、0 工具错误 |

人数检查仅针对本题肯定的单张券与两人关系及证据引用，不作为通用语义判断。12 项限定正反例通过 `node scripts/merchant-notification-model-check.ts --check-assertions`，保留否定、条件句、人数未知、仅套餐名和矛盾人数的反例；不同案例使用独立群路由，防止前例失败遗留的通知混入后例，仍要求每事件恰好一条回执。失败与跳过均保留，不能把扩题或检查器变化当成同条件效果提升。

最终只读与联合运行均已从 MySQL 回读，无失败或跳过；Prompt/Skill 与共用工具定义一致，分别核对 6/19 个实现文件哈希匹配本轮代码。模型仍可能出现未覆盖表述或遗漏取证，有限样例通过不代表生产质量保证；授权、金额、有效期与幂等继续由业务服务确定性校验。

工程回归已通过 `validate`、`check:business`、`check:merchant`、`check:merchant-notifications`、`check:refund`、`check:eval-db` 和 `scripts/qq-isolation-check.ts`。覆盖读取快照、身份/作用域、三终态、通知原路由与恢复、发送未知、旧编号拒绝、并发幂等、双用户异额以及评测持久化与受限权限。QQ 发信在本地替代，本轮未重新验收真实平台；所有资金操作仍为模拟。

在单门店、单券整笔模拟退款的约定范围内，本轮核心 MVP 收尾完成。公网回调与完整手机显示按 P2 后置；真实商家/资金接口、部分退款、人工转接与长期对话持久化仍不在当前范围。

## 查看和对比

运行列表默认显示真实模型评测，工程数据库检查另行切换。详情包含每个案例的用户问题、模型回答、证据、检查结果及模型/工具步骤，可以筛选失败案例，展开工具参数和返回值。独立的数据库工程记录用于验证失败、跳过和未知用量展示，不能当成真实模型成绩。

首屏只展示场景通过数、P95、Tokens 和估算费用；调用统计、断言分类和指标口径在“指标明细与口径”中展开。场景内直接显示失败或跳过的断言，全部断言及执行步骤按需展开。版本对比把 A/B 状态和回复放在同一场景行，点击展开回复；切换 A/B 后需重新对比。

对比两个运行时，案例按固定 ID 对齐。先看题集、断言和业务快照是否一致，再看模型、Prompt、Skill、工具配置是否改变。相同配置复跑可用于观察随机波动；不能把一次更高的分数归因于并不存在的优化。题集、断言或业务条件不同的运行可以逐例查看，但通过率差值不能直接证明改动有效。

建议每次只调整一类因素，例如 Skill 中的未知政策说明，保留相同的合成业务条件与检查规则后重新运行：

```sh
npm run check:model -- --label "未知政策说明调整"
```

## 指标口径

| 展示项 | 含义与限制 |
| --- | --- |
| 案例/处理轮次通过 | 通过数 / 计划数；失败、跳过和未完成不当作通过。当前只读套件为 14 案例、22 轮，历史版本有 10/11 与 9/10；D1/D2 为 3 案例、12 用户轮；当前 D2/D3 v2 为 3 案例、21 处理轮（18 用户 + 3 事件），历史 v2 有 15/17/20 轮，D3 v1 为 9 轮，按各运行计划数分别计数 |
| 业务、安全、证据、执行检查 | 预定义确定性断言；失败保留原因，前置条件不足的检查跳过。不是完整忠实度、幻觉率或满意度 |
| P50/P95 | 本次有实际耗时的处理轮次，按 nearest-rank 计算；只读套件从 prompt 开始到结束；D1/D2 从 QQ handler 开始到本地发送成功 hook 完成；D3 事件轮从 dispatcher 开始计，含重复扫描验证。含宿主确认轮，不含等待商家/重启准备，也不代表真实 QQ 网络耗时。样本量很小 |
| 首次文本 | 该处理轮首次模型文本事件；可能是工具调用前的中间回答，不等同最终答案首字；不调用模型的宿主确认轮留空 |
| 模型请求 / 工具调用 | Pi 内部的请求和工具步骤，不能等同处理轮次；一轮可以有多次请求 |
| 模型步骤耗时 | Pi 模型消息开始至结束事件之间的响应流阶段，不包含请求等待；不作为完整模型 API 耗时。用户单轮总耗时包含等待 |
| 预期拒绝 / 意外工具错误 | 预期拒绝需要对应安全案例、订单参数和真实拒绝结果；归属拦截不会作为意外工具故障 |
| token / 缓存用量 | 来自实际模型消息 usage；缺失留空，并显示已报告请求 / 总请求。部分报告只代表已知部分 |
| 估算费用 USD / CNY | Agent步骤与提供商span分别统计，币种分列；已知小计与完整金额分开。SDK模型目录/价格估算不等于服务商账单，部分usage不代表全运行费用 |

运行状态的“已完成”表示评测流程结束，不表示所有案例通过。失败、超时和跳过都保留在实际成绩中；执行被强制终止可能留下“运行中”的历史，不能计为已验收成功。

## 历史与快照

- `eval_runs`：运行 ID、类型、起止时间、计划数、配置快照与汇总。
- `eval_case_results`：稳定案例 ID、名称、分类、结果。
- `eval_turn_results`：用户输入或业务事件/答复、断言、证据、错误、处理轮次耗时。
- `eval_steps`：模型/工具步骤、参数/结果、耗时、usage、预期拒绝标记。

案例落盘使用事务，历史不覆盖。快照保留 Git commit 与脏状态、模型配置、Prompt、Skill、实际工具定义、固定问题与检查版本、实际合成业务事实；哈希帮助定位变更，原内容帮助解释变更。业务快照包含评测日期与采集时间，不能只凭 seed 文件没改就认定数据条件一样。D1/D2 保存完整初始订单，同时对随机 fixture 编号、创建/付款时刻和有效期作注明的语义归一化，用于条件比较；另记录生成脚本、D1/D2 源码、数据库结构、QQ 入口及模板哈希。

网页历史 GET API：`/api/runs?kind=model&limit=50`、`/api/runs/<UUID>`。列表不携带大段快照正文；详情提供完整合成快照。历史接口限制只读；仅独立的 `POST /api/experiments` 可启动严格白名单配置的本机评测。HTTP 输入有范围检查、Host/Origin 校验和 CSP，正文按文本展示。网页不运行 Shell、不绑定 QQ 身份、不持有管理员操作入口。

前后端协作：Kimi 通过本机 CLI（K3 + Max）负责 `web/evaluation/`，Codex 负责后端、题集和联调。前端使用后端分析的固定分母、比较条件与完整性，不重算或写死成绩；详见 [API 合同](./evaluation-api.md) 与 [前端任务范围](./kimi-evaluation-handoff.md)。继续复用四张 JSON 表。

## 独立离线检索对比（P0 与 P1）

参考项目固定版本的原始 JSONL、许可证、NOTICE 与文件哈希已归档，未复制上游 Python 或运行其 CI。corpus 独立于 MySQL 业务规则：选集 11 篇文档、44 道 standard / 26 道 hard，全量对照 35 篇、136 / 76 道。检索评分不调用模型或 QQ，不能作为真实模型回答或业务闭环的通过率。

```sh
node scripts/retrieval-check.ts
node scripts/retrieval-baseline.ts
```

检查由 `scripts/check.ts` 纳入 `npm run validate`。报告输出 `.runtime/retrieval-baseline.json` 和 `.md`；schema 2 的 `algorithms` 保留冻结 tags-only 基线与当前同义归一、query 词项/完整标签、tags/title/body 加权排序，`comparison` 记录同题差值及改善/退步。第二轮仅补回已定义的同义规范词项，不改词典或权重。输入不用 ctx 或 gold 改写，SQL 作用域不变。

Recall@5 按 standard / hard：选集从 P0 的 **59.09% / 3.85%**，经 P1 第一轮 **84.09% / 30.77%**，到当前 **86.36% / 34.62%**；全量从 **55.88% / 11.84%**，经 **79.41% / 43.42%**，到 **80.15% / 44.74%**。第二轮仅两道外带题从未召回变为第一，其他排名不变；相对 P0 仍有 1 个 MRR 退步、无 Recall@5 退步。两算法均为未知问题 2/4 空返回、范围检查 4/4。固定集用于开发调优，没有独立留出集，不宣称泛化提升；MRR、逐题退步和限制见 [检索说明](./retrieval.md)。当时报告使用独立文件；本轮新增客观检索套件与 API 展示 Recall/MRR，原离线报告仍保留。

第二轮另在修复前固定了 5 篇无标签合成文档与 8 个新问法，8/8 问法及 18/18 已有规范词标题/正文工程检查通过。数据 SHA-256 为 `efc72bb3cc6587f4ddcbe5330666c0aafa93282229d4544dfa9cf59460b0d9ba`；已向实现者披露，不是盲测，不并入参考集分母。详见 [固定新问法验证](./retrieval.md#第二轮固定新问法验证)。

## 检查与后续

**validate 与实库门槛映射（2026-10-08）：** 以下按固定源码 `8d247e939351c72e71a1e4a92c914a2d08eeb2a0` 的 [npm 入口](../package.json)与 [聚合检查](../scripts/check.ts)追踪实际调用。运行改动须在最终版本执行受影响专项和完整 `validate`；涉及存储、事务、锁或进程恢复时，再执行对应实库入口，不能由聚合检查替代。提交规则见 [AGENTS.md](../AGENTS.md)。

| 受影响边界与入口 | 实际调用路径 | 条件、覆盖与未证明项 |
| --- | --- | --- |
| 工程回归：`npm run validate` | `typecheck` → `check.ts` 汇总配置/检索/Controller/Session 等确定性检查 → `check:qq` / `check:qq-agent` / `check:reply` → `check:eval`（[`eval-check.ts`](../scripts/eval-check.ts)与 UI 检查）→ [`refund-agent-check.ts`](../scripts/refund-agent-check.ts) → [`merchant-notification-agent-check.ts`](../scripts/merchant-notification-agent-check.ts)。 | 不需数据库或真实模型密钥；使用合成 Store、Pi/faux、替代提供商传输及本机 HTTP。检查类型、宿主/工具边界、评测口径和前端回归；不验证真实 SQL、事务、跨进程恢复、模型质量或 QQ 平台。 |
| 订单/身份存储：`npm run check:business` | [`coupon-db-check.ts`](../scripts/coupon-db-check.ts) → `CouponStore.resolveCustomer/getOrder/searchKnowledge`；成功后 [`coupon-agent-check.ts`](../scripts/coupon-agent-check.ts) → 实际 Store / Pi 工具回填。 | 基础 11 表、固定合成种子及只读账号 `DB_PASSWORD`。两段均查 MySQL，第二段用 faux；断言本人/App 隔离、订单关联/整数金额、规则作用域、只读权限与工具回填。没有退款事务或真实模型/QQ 验收。 |
| 协商存储/状态：`npm run check:merchant` | [`merchant-db-check.ts`](../scripts/merchant-db-check.ts) → `AfterSalesStore.prepare/request/applyResult/processDue/getTask`；成功后 [`merchant-agent-check.ts`](../scripts/merchant-agent-check.ts) → 实际 Store / Pi/faux / 宿主确认。 | 售后初始化、基础/协商受限账号及管理员 fixture。两段均连 MySQL；检查归属/来源、并发同任务、批准/拒绝/超时、事实不变及同进程 Store/连接重建。未专门验证锁等待跨截止，也不是进程退出或真实商家回调验收。 |
| 退款金额/事务/确认/幂等：`npm run check:refund` | [`refund-db-check.ts`](../scripts/refund-db-check.ts) → `RefundStore.prepare/markPresented/confirm/get`，末尾导入 [`coupon-snapshot-check.ts`](../scripts/coupon-snapshot-check.ts)；DB 成功后运行 `refund-agent-check.ts`。 | 基础/协商/退款独立受限账号及管理员 fixture。实库检查一致订单快照、展示/授权/金额/批准/期限复核、并发单笔退款及状态一致；后段是替代 Store 的 Pi/QQAgent 发送故障检查。重建连接不证明真实进程恢复，本地发送不证明 QQ 可见或真实支付。 |
| 通知持久化/领取恢复：`npm run check:merchant-notifications` | [`merchant-notification-db-check.ts`](../scripts/merchant-notification-db-check.ts) → `confirmMerchantReply` / `AfterSalesStore.request/listNotifications/claimNotification/finishNotification` / worker；成功后运行 `merchant-notification-agent-check.ts`。 | 基础/协商/退款账号及管理员 fixture。第一段 MySQL 检查原路由、并发唯一领取、重建后 pending 恢复/claimed 不重发、worker 收尾；第二段用替代 Store、Pi/faux 和本地发送记录。未证明真实进程恢复、平台接收/客户端展示或发送前重绑的实库竞争。 |
| 评测存储：`npm run check:eval-db` | [`eval-db-check.ts`](../scripts/eval-db-check.ts) → `EvalStore.startRun/saveCase/finishRun/getRun/getBatch` → 分析器及本机 HTTP 回读。 | `eval:init` 后的独立 `EVAL_DB_PASSWORD` 账号；写入并保留 `kind=engineering` 合成历史。检查失败保存回滚、失败/跳过/未知用量、客观计划/批次、类型隔离和受限权限；不验证业务退款或模型回答质量。 |
| 任务行锁跨截止：`node --env-file-if-exists=.env scripts/merchant-deadline-lock-db-check.ts` | [`专用库检查`](../scripts/merchant-deadline-lock-db-check.ts)锁行并观测 `data_lock_waits` → 正式 `AfterSalesStore.applyResult` 的事务/`FOR UPDATE`/锁后条件 UPDATE。 | 强制本机 `127.0.0.1:13306/dave_agent`，需 Compose 管理员及锁等待观测权限；复制任务表到随机库/账号，结束删除。检查截止后放锁仍拒绝及正常/边界调用；无 `--db` 开关，不跑全库 worker。专用表无外键，不证明身份/订单/退款链、精确提交时刻或批准/拒绝竞争。 |
| 真实进程退款结果恢复：`node --env-file-if-exists=.env scripts/atomic-refund-recovery-db-check.ts --db` | [`恢复脚本`](../scripts/atomic-refund-recovery-db-check.ts)的 `--db` → `checkAtomicRefundRecoveryDatabase` → 两个不同 PID：实际展示/宿主确认/重复幂等 → 新连接及 atomic Session 的 `get_order/get_refund` 查询。 | 三组账号配置强制本机 `127.0.0.1/localhost:13306/dave_agent`，使用管理员 fixture、Pi/faux 和本地发送，禁止远程 HTTP。父进程核对同一退款及九表查询前后相同、清理全零；证明明确订单号的持久结果查询，不证明聊天历史/省略指代、通知 dispatcher、真实模型/QQ或商业退款。 |

尤其不能按脚本名推断覆盖：`check.ts` 约第 57 行导入恢复脚本后仅调用 `checkAtomicRefundRecovery()`（约第 160 行），检查 JS 合成快照及输入/金额/批准/退款 ID 反例，不建连接或启动子进程；只有直接运行脚本的 `--db` 分支（约第 185 行）才执行上表实库合同。

实库执行前须按[售后启动合同](./after-sales.md#启动)核对专用合成环境、非本轮 pending 协商、`TEST_APP` 终态待发通知及常驻 CLI/QQ/商家 worker，串行运行并按各脚本处理自身 fixture；`processDue` 和通知扫描范围并不因随机 fixture 自动隔离。不要把两个专用脚本的本机强制校验推广为全部 DB 入口的保护。历史结果复用[稳定主线工程复核](./after-sales.md#本轮稳定主线工程复核2026-10-06)、[取锁后截止复核](./after-sales.md#取锁后截止复核2026-10-08)及[售后验证记录](./after-sales.md#验证记录)，不计为本次执行。

本题 P0 与收尾边界：

- **真实业务约束：** 身份、授权、金额、确认、事务幂等与持久恢复须由实际代码和存储执行，替代 Store 的通过不能代替这些合同。
- **面试追问：** “validate 全绿为何还不能证明退款事务、取锁后截止与跨进程恢复？改哪个边界应运行哪个实库入口？”按表定位调用及未证明项即可回答。
- **个人实现/复用：** 项目实现业务检查、fixture 隔离和持久化合同；复用 Pi 生命周期、Node 断言与 MySQL，不认领模型语义、QQ 平台或商业支付能力。
- **本轮验收/演示证据：** 固定源码和既有断言只读核对、两路独审通过；20 个链接/锚点、8 个入口、命令顺序及纯合同/`--db` 分支静态断言和文档差异检查均退出 0，节外正文保持不变。只补此映射，0 数据库/模型/QQ 请求，未执行 `validate` 或专项、不增加历史样本，也不改变稳定配置与 C1/O4/O5 状态。
- **预算/停止条件：** 30 分钟，预留至少 10 分钟核验、精确提交/推送与释放；映射和事实核验完成即收尾，不扩为全库审计或新实验。

工作台精简版本 `5d29347` 已完成桌面/窄屏、运行切换、失败筛选、A/B 对比及未知指标展示验收；此前浏览器访问受阻记录已由这次实际验收补齐。本轮浏览器已核对最终 D1/D2 运行的 3/3 场景、21/21 usage、80,971 Tokens，并保留可见的失败历史。

P1 核心 MVP 已收尾；当前迭代扩充客观评测覆盖与系统，不改生产业务来追求满分，真实失败进入后续优化计划。公网 Webhook 与完整手机验收保留为 P2；人工/Judge 标注、线上 QQ 抽样、页面启动任务与长期趋势分析仍待后续建立口径，不能用工程检查、检索评分或小样例通过率代替完整业务效果。
