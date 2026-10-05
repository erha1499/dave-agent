# C1 支持判别模型开发对照

2026-10-06：冻结的 typed v3 / 10 问直接支持判别中，`deepseek-flash` 通过 9/10，`deepseek-v4-pro` 通过 10/10。Pro 修正了本次 Flash 的一处误接收，单次总估算费用约为 3.96 倍，P50 约多 730 ms。该结果支持新增独立支持判别模型开关，**不代表 C1 新验证集、完整业务链路或生产效果通过**。业务 Agent 默认模型、QQ 默认架构和知识模式均未自动切换。

## 问题和候选

支持判别需要区分三个不同诉求：规则/流程前提、具体业务事实、文档覆盖或推断边界。原文说“未录入”，可以回答用户明确询问的“知识库是否记载”，但不能提供实际过敏原、使用资格、日期、批准或到账事实。

typed v3 明确了文档覆盖的否定回答，保留 typed v2 的规则前提合同；binary v1、typed v1/v2 的完整 Prompt 和 hash 仍保存在 `src/evidence-support.ts`。本次没有继续追加 Prompt 来消除已看到的误接收，而是固定输入和 Prompt，仅比较本地 Pi 目录中实际存在的两个模型。

两模型均使用现有 Pi `openai-completions`、同一 DeepSeek endpoint、非思考模式、temperature 0、JSON 输出、maxTokens 2048、timeout 60000 ms、maxRetries 0。每问一篇原文、一次请求；判别输入只有 query 与文档，不含 gold。宿主继续校验完整 ID、精确引文、类别和输入绑定。直接支持单元中的 rank/score 固定为 1，仅满足接口，不构成检索或阈值实验。

## 冻结与复现

- 数据：`data/c1-support-development-v2.json`，SHA-256 `6b62723bb0497e09da5a3b509f20023e47036e24d0c51989fcf1f96f2a084b0d`；来源及预声明标签见同名 `-source.json`。
- 原 6 问逐字保留，新增 2 对“是否记载 / 具体事实”。共 5 对、10 问，正负各 5。新增正例预先允许 `boundary_answer` 或 `direct_fact`，但必须 supported=true；原 6 问类别要求不变。
- Prompt：`fact-support-typed-v3`，SHA-256 `5d976a03cd880350701f65b08b7fee0397e23891807c4ccf7c5598879e8c8395`。
- 两次实验的 `src/evidence-support.ts` SHA-256 均为 `09180dee446318eec234fd4af8915ce99368c34c3c4aed8e7c2505d113a50465`；runner SHA-256 均为 `7e92dafc60b6c2538543d3e9044426346b33b04147e3ca4fe7d9b29b9d3ba8ed`。独立开关在对照完成后接入，因此当前工厂源码 hash 已变化，历史结果仍绑定原快照。
- 两个 raw 报告的 source manifest、逐题输入、全部源码前后 hash、Prompt hash 已严格比对一致；各自 `codeStable=true`，错误和计划分母完整保存。

工程检查不调用模型：

```sh
node scripts/c1-support-check.ts --expanded
node scripts/evidence-support-check.ts
node scripts/knowledge-service-check.ts
node scripts/experiment-check.ts
npm run typecheck
```

以下命令会付费，实际每条仅执行过一次。临时环境变量只作用于该子进程，没有修改 `.env` 或业务默认模型：

```sh
MODEL_ID=deepseek-flash node --env-file-if-exists=.env scripts/c1-support-check.ts --expanded --live
MODEL_ID=deepseek-v4-pro node --env-file-if-exists=.env scripts/c1-support-check.ts --expanded --live
```

本次 Flash 使用已有配置（解析为 `deepseek-flash`）运行；上方显式写出 ID 是为了复现。精确的 Pro ID 为 `deepseek-v4-pro`；本地目录不存在 `deepseek-pro`，没有请求这个名称。

## 结果

| 指标 | Flash | Pro |
| --- | ---: | ---: |
| 完整计划 / 实际请求 | 10 / 10 | 10 / 10 |
| 类别与 supported 同时正确 | 9/10 | 10/10 |
| 正例接受 | 5/5 | 5/5 |
| 负例误接收 | 1/5 | 0/5 |
| 请求错误 / 用量缺失 | 0 / 0 | 0 / 0 |
| 总 tokens（含缓存输入） | 10,582 | 10,673 |
| SDK 目录估算 USD | 0.002158860 | 0.008555976 |
| P50 / P95 单请求延迟 | 750 / 1,299 ms | 1,480 / 2,141 ms |
| rerank 请求 / 估算 CNY | 0 / 0 | 0 / 0 |

五组中，确认主体/本单已批准、退款路径/本单已到账、从名称推断/实际到期日、是否记载使用限制/实际周六资格，两个模型都正确区分。过敏原这一组，两个模型都正确接受“知识库有没有列出过敏原信息”；但 Flash 将“具体含有哪些过敏原，请列出来”错误归为 `boundary_answer`，以“未录入”声明作为已接收证据。Pro 将后者归为 `limitation_only` 并拒收。失败标签、原文、引文和理由均未回改。

Flash run：`21d822f5-e9ea-43fd-8789-9eadcca1d975`。

Pro run：`5eff2af6-08d3-4bdd-b9df-d143d842410a`。

本地原始报告分别为 `.runtime/c1-context/support-development-<runId>.json`；汇总审计 `.runtime/c1-context/support-typed-v3-model-comparison.json` 记录两份报告 SHA、逐题类别、输入/源码一致性断言及成本。运行日志不入库，本文与冻结题集保留可公开复核口径。

## 成本口径与取舍

2026-10-06 核对的 [DeepSeek 官方模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) 将两模型分别标为 DeepSeek-V4.1-Flash、DeepSeek-V4-Pro-0813，并区分峰谷价格。当前 Pi 目录的每百万 tokens 费率与官方高峰费率一致：Flash 非缓存输入 / 输出 / 缓存输入为 USD 0.30 / 1.20 / 0.006；Pro 为 1.32 / 3.96 / 0.044。

表格费用是 SDK 按目录费率和返回 usage 计算的**估算值，不是实际账单**；未按运行时段反推、修订或倒填历史费用。两次缓存命中情况并未作为实验变量控制，因此 3.96 倍费用和延迟差只描述此次运行。10 问增量估算 USD 0.006397116；不能据此承诺所有在线请求的单位成本或尾延迟。

本次支持组件的能力改善有直接失败对照，而扩展点只需独立模型配置。相比马上引入第二层意图分类 LLM，它保留单次判别、现有引文校验和零重试，复杂度更小。后续应在冻结的新验收中检验 Pro 的泛化收益、误拒和端到端成本；不因为开发集 10/10 就认定分类问题已完全解决。

## 独立开关与边界

- 业务参数 `knowledgeSupportModel: "configured" | "deepseek-v4-pro"`，默认 `configured`；环境变量 `KNOWLEDGE_SUPPORT_MODEL`。service 对应 `supportModel`，factory 对应 `modelSelection`。
- 只有 Controller + `m4-support` 生效。lexical 与非默认模型组合直接拒绝；atomic 不允许 `m4-support`。Pro 固定选择只改变支持判别的 `MODEL_ID`，不改变业务 Agent 模型。
- 固定 Pro 先检查当前 `MODEL_PROVIDER` 为 DeepSeek，避免将其他 provider 的 `MODEL_API_KEY` 转交 DeepSeek。不硬编码凭据；原环境对象不变。注入 client 的 provider/model 必须匹配选择，否则初始化拒绝。
- trace 的 `supportModel` 记录选择，`settings.support.provider/model` 记录实际已创建的模型；没有请求的场景不伪造调用或 usage。类别不会带来退款、批准、身份或金额权限。
- 新预设 `support-knowledge-model-ab` 固定 typed、阈值 0.5、单查询超时 15000 ms，仅比较 configured 与 Pro。configured 跟随业务环境，只有当前 configured 实际为 Flash 时才构成 Flash/Pro 对照；实验报告以真实 settings 为准。原知识/判别类型预设和默认阈值 0.71 不改。

本次只完成独立支持组件开发对照与开关工程检查，未做重复稳定性实验，未新建/读取下一版验证题，未用这 10 问替代知识检索、真实多轮动作链、14/24 业务回归或 QQ 验收。

## 后续批量引文诊断（2026-10-06）

真实 Session 开发批次 `5dec8496-33c8-4708-81ed-6ccc08937637` 的预约场景，4 篇候选的 Pro 判断发生 `invalid_response`。该批次原始模型文本没有保存，因此无法直接确定原始错误的细分原因；原失败及随后跳过的续问继续保留，不能用其他请求的成功追认通过。

随后增加了有界诊断：生产 `KnowledgeTrace.supportFailure` 仅保存失败枚举 `code` 与 `outputHash`，不保存原始模型文本；仅合成测试可以显式注入 observer，将最多 20,000 字符的 text 块和 stopReason 保存到忽略目录。Prompt、请求 settings、精确引文合同和接收决定均不变，binary 请求 golden 检查继续通过。

根据原报告 query/scope、冻结语料、原始排名和阈值 0.5，重建 RS003/RF003/RF002/RS002 四候选；scoped corpus hash、settings、来源文件与原快照一致。原失败没有 requestHash，不能与不存在的原请求值比较。只额外请求一次，诊断 run `48d0432f-e07e-4931-8386-cd4620eb010a`，源码前后稳定，仍返回 `invalid_quote`：RS003 的直接规则引文正确，但 RF003（分类为 limitation_only）的引文将原文半角逗号 `U+002C` 改为全角 `U+FF0C`，从而使整批严格校验失败。这是此次复现的确定原因，不是对前次失败原因的追溯证明。

本次 1 请求、1,474 tokens、2,736 ms，目录估算 USD 0.001146288；没有重试、修改 Prompt 或自动修补标点。输出哈希 `602127f645d196e7a155537fcb2978e9be375a8c1042112a33579c6ef003d082`；报告及原始 text 仅在 `.runtime/c1-session/support-diagnostic-48d0432f-e07e-4931-8386-cd4620eb010a{,-raw}.json`。诊断脚本曾在导入阶段因相对路径错误停止，已单独保存 0 请求的启动错误记录，未消耗模型重试。

这说明单篇开发分类的 10/10 不能保证多篇引文格式稳定。已选定下一步方案为**逐候选故障隔离**：整体 JSON/结构及未知、缺失、重复 ID 继续整批拒绝；可明确归属候选的引文、类别、理由错误单项标为 invalid，不能接收或算正确拒收。其余项仍需通过精确引文、语义判断和原文版本复检；全项无效仍 unavailable。该方案不增加模型请求，需独立版本及工程回归，**目前未实施**。

备选的“模型选择原文片段 ID、宿主还原原文”可避免自由抄写标点，但需要分段、版本绑定及跨片段条件覆盖，还不能替代语义判别。当前先采用错误隔离，按收益决定是否增加分段协议。两种方案都不能追改原成绩；预约两轮及新业务回归尚未追加执行。
