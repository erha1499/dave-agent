# C1 引用选择：19 轮开发探针

状态：执行器与零 API 工程检查阶段，尚未真实执行。数据是基于已曝光问题设计的开发对话，不是新的独立 C1 验证集，不据此宣布准入。

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
