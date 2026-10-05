# C1 引用选择：19 轮开发探针

状态：2026-10-06 已在冻结提交 `3b4f2b1` 单次真实执行，严格合同 12/19 通过、1 轮失败、6 轮依赖跳过；本轮推进条件未满足。数据基于已曝光问题设计，不是新的独立 C1 验证集，默认不变，C1 仍未准入。

## 固定范围

| 场景 | 轮数 | 要验证的业务合同 |
| --- | ---: | --- |
| 单一政策连续追问 | 3 | 信用卡到账时限 → 最长等待时间后未到账 → 核账后向谁查询；每次指向实际上一轮，保留真实原问链。 |
| 竞争政策选择后恢复 | 7 | 银行卡、信用卡两个问题即使共用 RF005 也不能合并；澄清后插入完整预约问题，不清除旧 pending，再用曾真实显示的银行卡话题令牌恢复。 |
| 三单竞争 | 6 | 查询 A/B/C → “另一笔”澄清 → 用户精确选择实际显示的 A → 省略查询 A 当前状态，重新授权读取。 |
| 唯一另一单 | 3 | 查询 A/B → 完整询问另一笔退款条件；目标为 A，不能搬用 B 已核销状态。 |

[开发数据](../data/c1-reference-selection-development.json)固定 4 个场景、19 轮及每轮动作、实际调用顺序、引用来源轮、证据 gold、回复审阅条件。RF005、RS003 以及其他候选原文复制自已有隔离语料；数据记录原始文件及两个 corpus 的 SHA-256。合成订单 A 为已支付、单张未核销且未过期，B/C 为已核销。数据只用于内存受控存储，不写线上知识库、MySQL 或 QQ。

首次冻结前的静态审阅发现：“超过七个工作日”本身可独立回答，不适合强制考察 previous。因此将单一政策第 2 问改为“如果过了刚才说的最长等待时间还没到账，接下来怎么办？”。首轮信用卡 3–7 工作日及答案 gold 保持；这次修改没有使用模型结果。

本轮假设是：有界候选、实际展示绑定及成功续问的分支更新，能使模型完成澄清后的连续恢复，同时保留单一话题和两单切换能力。推进条件预先固定为 19/19 业务、知识及引用合同通过，逐轮实际回复独立审阅通过，且 `runIntegrityPassed`、`executionComplete`、`usageComplete` 均为真；满足时只进入后续完整 Session 验证，不切 QQ 默认或宣布 C1 准入。不满足时保留原始记录，分开定位协议选择、检索/支持判别、来源证明与回复问题；达到预算后收尾，不重复本批取得最好成绩。

## 执行与证据

使用生产 `createSupportSession` 和知识服务，复用现有真实 HTTP guard、受控身份存储、Pi 事件采集、知识原文证明和引用证据评分。固定配置为 Controller、Flash 主 Agent、Pro 支持判别、typed v6、阈值 0.5、declared 必要前提、separated 查询。provider 重试为 0；Pi Session 既有最多 2 次自动重试保留，每次真实 HTTP 都计数。

选择轮不向 Session 直接注入 token 或引用。执行器从预声明展示轮的**实际可见回复**取得完整选择指令，并交叉检查该轮候选、来源轮真实 requestId、版本及有效期；再把这条指令作为新的用户消息送入生产 Session。没有实际展示或来源不匹配时该轮失败，不能凭预期答案补造令牌。

每场景严格按顺序执行；任一前置合同失败，该场景后续轮次保留为 skipped，其他独立场景继续。始终保留 19 个计划行。上限为 Agent 60、rerank 20、support 20 次真实 HTTP（合计最多 100），总时限 10 分钟，单轮 60 秒。已返回用量的美元估值累计达 0.25 或人民币估值达 0.1 后停止下一次请求；在途最后一次可能超出软费用线，缺失用量保持 unknown，估值不是实际账单。

报告分开记录：

- `engineeringPassed`：动作、调用、可信入口、订单及来源轮是否符合预声明合同。协议偏差不能直接解释成越权或答案错误。
- `knowledgePassed`：独立重建查询、范围、原文版本、gate、实际 support proof，要求完整 gold 且没有额外接收；invalid 单列，不能算正确拒收。
- `referenceEvidencePassed`：从完整实际历史重建候选与选择来源；政策来源调用已有 `knowledgeProofPassed`，不信 trace 自报。
- `runIntegrityPassed`：版本、记录分母、实际配置、入口关联、清理是否可核对；合法依赖跳过可保持记录完整，不冒充业务通过。`executionComplete` 单独表示全部 19 轮已执行，`usageComplete` 单独表示无未知费用请求。
- 回复质量：另行按 `actualReply`（含订单卡字段）逐条审阅，与 reply hash、criteria hash 绑定；执行器只导出 unreviewed 模板，不自行判自然语言全部正确。初始 `admitted` 固定 false。

## 零 API 检查、冻结和实测

```sh
node scripts/c1-reference-selection-live.ts --check
node --env-file-if-exists=.env scripts/c1-reference-selection-live.ts --freeze data/c1-reference-selection-development-manifest.json
node --env-file-if-exists=.env scripts/c1-reference-selection-live.ts --inspect data/c1-reference-selection-development-manifest.json
```

`--check` 使用真实 Pi 加 fake HTTP，验证订单查询 → 实际候选展示 → 从回复提取选择 → 宿主零模型回执 → fresh 读取恢复，以及未知费用、请求硬限和 19 行分母。它不证明模型能理解真实歧义。

`--freeze` / `--inspect` 仅读取本地模型目录、端点和依赖信息，不发模型请求。manifest 用独占新建方式写入，冻结数据、所有生产模块、Prompt/Skill、执行与评分代码、配置和核心依赖。当前 package 文件额外按实际字节记录运行前后哈希，不将无关依赖变化伪装成模型效果。

只有在主线明确授权后才运行一次：

```sh
node --env-file-if-exists=.env scripts/c1-reference-selection-live.ts --live data/c1-reference-selection-development-manifest.json
```

每个 manifest 只允许一次显式执行，并保留 attempt 标记；失败也不自动重跑。新结果写入 `.runtime/c1-reference-selection/<runId>.json`，不覆盖既有报告。执行后核对源码、manifest、依赖和 package 字节未漂移，释放各个 Session 并清空合成订单；再做回复审阅和成本分析。

## 单次真实结果（2026-10-06）

run `2e8c6c72-9ca9-4b9f-b4dc-16554dc1629a`；[固定 manifest](../data/c1-reference-selection-development-manifest.json)、[完整分母结果](../data/c1-reference-selection-development-results.json)。原始现场保存在忽略目录 `.runtime/c1-reference-selection/`，SHA-256 为 `c4855cb6176f7d31f41c43ece7e00a1eca463a12f5d022f369da6e71d3574e4a`；原始报告不回写审阅结果。

| 场景 | 严格通过 / 计划 | 实际情况 |
| --- | ---: | --- |
| 单一政策连续追问 | 3/3 | 信用卡时限 → 超时核账 → 联系平台，实际来源链正确。第2轮首次拼接了不存在的原文依据，被宿主拒绝后在既定一次修复额度内完成。 |
| 竞争政策选择后恢复 | 0/7 | 第1轮收到 RF005 和额外 RF001，违反固定证据 gold；其后6轮按依赖合同未执行，双渠道选择恢复仍缺真实模型证据。 |
| 三单竞争 | 6/6 | 真实候选展示 → 用户选择 A → 重新读取 A 成功；选择轮0模型调用、耗时2ms。恢复轮首次误用 explicit，被拒后改为 focus；没有执行错误订单读取。 |
| 唯一另一单 | 3/3 | 正确定位 A，并重新读取其支付、券和有效期，按未核销规则说明资格；不沿用 B 的已核销事实。 |

共13轮实际执行，3/4场景完成，严格业务/知识/来源合同12/19通过。已执行轮的引用来源证明13/13通过，但该指标只证明来源链和选择，不等于原文语义足够回答；5轮知识取证中4轮符合全部固定 gold。2轮发生纯动作校验错误并在预先允许的一次修复内完成，不表述为首次调用全部正确。原始逐轮步骤及额外模型请求均保留。

实际36次HTTP：Agent 26、rerank 5、support 5，全部用量可核对；估算 **USD 0.018298248 + CNY 0.011552**，币种分列，不是实际账单。主 Agent 228037 tokens、support 10992 tokens、rerank 23104 tokens；价格含缓存计费，不能从低金额推断上下文很短。12个实际模型轮 P50/P95 为1799/5292ms（不含2ms宿主选择与6个未执行轮）；整批36.204秒，无预算停止。源码、依赖、package前后字节及清理核验通过，`runIntegrityPassed=true`、`usageComplete=true`、`executionComplete=false`。

本次没有使用 QQ 传输、MySQL 或资金接口；不能把该结果替代真实平台联调或完整C1准入。

## 实际回复审阅与失败诊断

[独立回复审阅](../data/c1-reference-selection-development-reviews.json)按冻结的27项答复标准核对13个真实 `reply`，含7次订单卡字段，结果13通过、0失败；6个未执行轮保持 `unreviewed`。每条绑定实际 reply hash 和 criteria hash，文件绑定原始现场 SHA-256；这是 Codex 审阅、供人核验，不是真人验收，也不覆盖严格证据失败。原始执行报告中的 `answersReviewed=0` 保留，审阅结果独立存放。

失败轮实际答复的“银行卡1–3个工作日”有 RF005 支持。问题在于 RF001 同时被接收和引用：其完整规则针对未核销券，泛称“一般1–3个工作日”，又明确把具体时限留给支付渠道；它未独立给出银行卡时限。Pro 的理由明确承认“虽未区分银行卡”，仍将其判为 `direct_fact`。相同批次的信用卡题却因 RF001 缺少信用卡区分而拒收它。原问为一般规则咨询，`rule_only` 合理，不应强迫查订单；`no_current_order_context` 仅表示 applicability 未做当前订单校验，不是文章已覆盖全部问题条件。

因此保留 RF005-only 的原 gold。本次不是答案数值错误、RF001 与 RF005 冲突、来源哈希失效或越权；它暴露了逐篇支持判别对关键条件覆盖不一致。可以提出“数字相同使判别放松”的假设，但一次结果不能证明模型内部原因。更换阈值来滤掉 RF001 会掩盖此问题，不作为修复。

## 下一轮：条件覆盖的单变量开发对照

先验证 Prompt 条件合同增量，复用现有支持判别接口和 A/B 执行方式，不增加 slot schema、第二次模型调用或通用框架。typed v5 默认、已冻结 v6 和本次19轮题目/gold/结果均保持。新候选明确以下原则：

> 一般或假设规则也须由该篇原文独立覆盖原问的关键限定。允许原文明示的通用规则覆盖其子类，不要求逐字匹配；但原文明确将结果留给子类规则决定时，不能用通用数字替代该子类结论。不得补入原问未给出的限定，以便让候选成立。

下一轮冻结12个开发输入，v6与候选各执行一次，共24次support请求；Pro、参数、完整原文不变，provider重试0、5分钟、USD 0.06软预算，未执行和未知费用保留。6个目标输入覆盖原银行卡题、银行卡分别只有RF001/只有RF005、信用卡、余额、明确询问未核销券一般退款时限；6个回归输入覆盖RF001原路退款、审批流程/已获批对照、既有019具体属性缺失、023资料覆盖、周日语言蕴含。具体输入与gold仍须在执行前独立静态审阅、冻结，不复用本次run作为新的独立验收。

候选推进要求：去掉银行卡问题对RF001的误接收，保留RF005及合法RF001正例，且不增加v6同批回归失败；旧周日失败照实保留，记录费用/延迟增量。有证据收益后，才以新manifest单次验证完整19轮链路；本次12/19与6个skip永久保留。若条件缺口仍反复出现，再评估结构化条件证据映射的额外收益与成本。O4/O5及C1独立准入继续待做。
