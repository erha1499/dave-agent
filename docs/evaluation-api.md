# 客观评测 API 合同

本机工作台继续使用四张 `eval_*` JSON 表，本文的历史与分析接口保持只读。原 `/api/runs?kind=model&limit=50` 和 `/api/runs/<UUID>` 响应不变；新增字段均为可选。独立的实验配置与启动接口见 [实验调试合同](./experiment-controls.md)，不改变既有历史记录。新接口不评回答质量、不使用 LLM judge，也不把历史措辞检查转换为客观检查。

## 计划与批次元数据

新客观运行将如下对象写入 `run.snapshot.content.evaluation`，执行前固定并计入 dataset 哈希：

```ts
type EvalObjectivePlan = {
  version: 1 | 2;
  scope: "objective";
  answerQuality: "not_evaluated";
  cases: Array<{
    id: string;
    tags: string[];
    turns: Array<{
      index: number;
      source: "user" | "host" | "event" | "engineering";
      checks: Array<{
        id: string;
        category: "business" | "safety" | "evidence" | "execution";
        basis: "trace" | "state" | "protocol" | "execution";
      }>;
    }>;
  }>;
};
// 可选，存入 run（而非 snapshot）
type EvalBatch = { id: string; repetition: number; plannedRepetitions: number };
```

案例 ID、轮次索引、当轮检查 ID 必须唯一。计划案例/轮次总数必须与 `plannedCases/plannedTurns` 一致。tags 是本题集定义的覆盖范围，不代表业务全集。批次 UUID、重复序号从 1 起、计划重复数为 1–20；相同批次只能包含同套件同配置。未创建的运行也保留在批次计划分母中。

原详情中的 `EvalTurn` 可带 `observations?: { before?: unknown; after?: unknown; protocol?: unknown }`，保存工作流检查的精简真实状态与固定卡片协议证据。前端可原样展开这些合成诊断数据。通过与否仍由确定性 oracle 生成的计划 checks 决定，分析 API 不根据 observations 猜测得分，也不评模型回复质量；旧记录没有此字段时无需补造。

## 单次运行分析

`GET /api/runs/<UUID>/analysis`

```ts
type Counts = {
  planned: number; passed: number; failed: number; skipped: number; missing: number;
  passRate: number | null; // passed / planned，0–1；分母为 0 则 null
};
type Usage = {
  modelRequests: number; reportedRequests: number; missingRequests: number;
  coverage: number | null; // 无模型请求为 null，不是缺失 usage
  knownTokens: number | null; completeTokens: number | null;
  knownCostUsd: number | null; completeCostUsd: number | null;
};
type CaseAnalysis = { id: string; tags: string[]; status: "passed" | "failed" | "skipped" | "missing"; turns: Counts; checks: Counts };
type RunAnalysis = {
  runId: string;
  scope: "objective" | "legacy" | "invalid";
  answerQuality: "not_evaluated";
  issues: string[];
  counts: { cases: Counts; turns: Counts; checks: Counts } | null;
  categories: Array<{ category: string; checks: Counts }>;
  coverage: Array<{ tag: string; cases: Counts }>;
  cases: CaseAnalysis[];
  usage: Usage;
  execution: { toolCalls: number; toolErrors: number; expectedDenials: number; modelErrors: number };
  timing: { samples: number; durationP50Ms: number | null; durationP95Ms: number | null; measurement: string | null };
  retrieval: RetrievalAnalysis | null;
  attribution: SupportTraceAnalysis | null;
};

// 仅 engineering + retrieval-objective-v1 + 有效客观计划提供
type RetrievalAnalysis = {
  groups: Array<{
    corpus: "selected" | "full"; suite: "standard" | "hard"; samples: number;
    recallAt1: number; recallAt5: number; mrr: number; mrrAt5: number;
  }>;
  noAnswer: { samples: number; empty: number; nonempty: number };
  scope: { samples: number; passed: number; failed: number };
};
```

## v2 执行归因（增量字段）

`support-business-v2` 使用 version 2 的共同业务计划。评分仍取 `analysis.counts`，`turn.steps` 仍保留模型与工具记录。新增 `turn.spans` 和 `analysis.attribution` 是同一次执行的另一视角，**不能与 steps 的调用量、Tokens、费用重复相加**。旧记录返回 `attribution:null` 或省略字段时显示未采集，不能补成 0。

```ts
type EvalSpan = {
  id: string; parentSpanId: string | null;
  actor: "agent" | "host";
  trigger: "user" | "event" | "confirmation";
  component: string; name: string; observedAt: string; durationMs: number | null;
  outcome: "ok" | "denied" | "error";
  input?: unknown; output?: unknown;
  knowledge?: { context: SupportKnowledgeContext; trace: KnowledgeTrace };
  usage?: {
    provider: string; model: string; kind: "llm" | "embedding" | "rerank";
    inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
    cost: { currency: "USD" | "CNY"; amount: number; source: "sdk_estimate" | "provider" | "price_estimate" } | null;
  };
};
type SupportTraceAnalysis = {
  spans: number;
  groups: Array<{ actor: string; trigger: string; component: string;
    calls: number; denied: number; errors: number }>;
  providers: Array<{ provider: string; model: string; kind: string;
    requests: number; usageReported: number; knownTokens: number | null;
    costs: Array<{ currency: string; source: string; reportedRequests: number; knownAmount: number }> }>;
  issues: string[];
};
```

当前组件为 `qq-ingress`（入口）、`model`（模型）、`agent-tool`（模型选择的工具）、`business-service`（宿主业务服务）、`confirmation-service`（宿主确认/展示登记），C1 增加 `knowledge-rerank`、`knowledge-support`（知识服务的提供商调用）。`groups.calls` 包括入口和嵌套服务，不是可相加的“总工具数”。旧 `parentSpanId` 只有轮级归属；C1 知识提供商调用才明确以所属 `search_faq` 为父节点，不能替历史记录补造嵌套关系。

C1 的 `business-service/search_faq` 保留 `output: documents[]`，附加 `knowledge`：`context` 记录用户原始问题、模型建议问题、宿主实际检索问题、订单来源、重新授权后的范围和事实，以及可用的可信话题/对象引用；模型建议问题只用于审计，不构成业务身份或范围。`trace` 记录实际模式、阈值、范围、原始排名、接收/拒收原文及版本、语料前后哈希、失败原因、配置、阶段时间与用量。完整类型以 `src/support-controller.ts`、`src/knowledge-service.ts` 为准。

`trace.supportProfile` 记录 binary / typed；`settings.support.promptVersion` 标识实际判别 Prompt 版本。成功返回的 `supportVerification.value[]` 包含 `id/supported/quote/reason`，typed 另有 `category`：`direct_fact`（事实或适用规则）、`boundary_answer`（明确边界问题的答案）、`limitation_only`（仅说明信息缺失或需核实）、`unrelated`（无关）。宿主只接收前两类，并校验实际原文引文。没有发请求、失败或旧记录没有字段均不等于 `supported:false`；不能从历史 binary 判断反推 typed 分类。接收规则证据也不代表本单已批准、退款已执行或资金已到账。

`trace.status` 的 `accepted`、`rejected`、`unavailable` 分别表示接收到证据、未接收到证据、服务未完成；拒收本身不能证明案例通过。`stages` 可选，旧记录缺少时显示未采集。`sources` 记录本次实际接受文档的 sourceId 和规范文档 SHA-256，不能以历史话题中的同 ID 版本替代；拒收或不可用时为空。`supportVerification` 仅在真实判别完成时保存输入/请求绑定及 supported/quote/reason，失败或未调用不补造；若随后原文变化，该旧输入判别仍可审计，但最终 sources 为空且状态不可用。工作台按逐次查询展示来源与原文、实际 scope 和 original/effective query；金额事实与退款授权仍分别检查。

`trace.supportModel` 是配置选择（configured / deepseek-v4-pro），`trace.settings.support.provider/model` 才是判别客户端实际配置；没有真实请求时不得用所选项补造模型调用。`trace.supportFailure` 可包含失败枚举 `code` 与 `outputHash`，不包含原始模型文本。类别/引文的成功记录仍在 `supportVerification.value` 数组中。v2.2 `paid_amount_compare` 只读取授权订单和金额引用，正常没有知识 trace，不应显示为检索失败。

知识提供商请求只在相应子 span 填 `usage`，其父 `search_faq` 不重复填，且不加入 Agent 的 `steps`。人民币 `price_estimate` 按适用区域与版本价目估算，美元 `sdk_estimate` 按 Pi 模型目录估算；超时未回传的用量保留 null。旧 `analysis.usage` 继续只代表 Agent 模型步骤，业务总成本比较应使用带知识调用的归因明细，按币种分别报告。

轮次类型优先依据可信入口 span 的 `trigger`：`event` 是商家事件，`confirmation` 是用户精确确认经宿主执行，`user` 是普通用户请求。v2 的事件和确认回执应标为宿主；其他轮不因含 host 服务 span 就改标宿主。这里标的是最终回执生成方：atomic 商家事件仍可能调用模型，但发送的是宿主固定状态卡，模型步骤仍保留展示。旧轮无 spans 时保留原展示。spans 为空表示显式没有归因记录，不等于模型调用必为零；零模型需依据该轮实际 `steps`。无效归因记录应保留原始文本与诊断，不能让页面崩溃或显示为正常执行。

`denied` 是服务的已知业务拒绝，`error` 是执行错误；两者不决定案例得分。Controller 的正常 `blocked` 不一定产生 denied，不要将 denied 数当全部拦截数。provider 的 requests 只覆盖带有效 usage 对象的 span，缺整个 usage 的 span 不在该分母；宜标“归因中已记录请求”，不可据此声称所有请求用量完整。Tokens 与 costs 都是已知部分，USD/CNY 及 `sdk_estimate`/`provider` 分别显示、不换汇合计，缺价格显示未知。首屏继续使用原 `analysis.usage` 口径，归因明细默认折叠。

M0–M6 的完整百炼检索报告位于 `.runtime/retrieval-v2/`，未导入旧历史运行 API。新实验入口仅在任务结果中提供其关联报告的实际摘要；不扫描导入旧离线报告，不凭开发报告写死 Recall/MRR，也不暗示在线业务已使用 rerank。

`missing` 是计划存在但没有记录，`skipped` 是明确跳过。两者均不通过。只统计计划中的检查；额外、重复、错类别或不完整计划会返回 `scope: invalid`、`counts: null` 和原因。没有计划的旧记录返回 `legacy`，不生成客观通过率。模型请求/用量/执行耗时是步骤遥测，可在 legacy 页面显示。

只报告部分 usage 时保留 known 值，complete 值为 null；全部 usage 已知但部分价格缺失时完整费用仍为 null。没有模型请求的宿主轮不算漏报。时延按原采集范围显示，不代表 QQ 平台端到端送达。

检索由工程执行的 `retrieval_rank` 步骤记录全正分排名、相关文档标签和首条相关文档位置，后端复核排名与指标公式后，按 `corpus/suite` 四组分别算均值，不合并成一个召回率。单题 Recall@K 为相关标签中进入前 K 位的比例（多相关文档时不能用“命中任一条”替代），MRR 取首条相关文档倒数。`retrieval_no_answer` 仅统计空/非空召回，不认定最终回答错误；`retrieval_scope` 单独统计范围隔离。检索记录格式错误时 `retrieval:null` 并在 issues 说明，不静默丢弃后继续给分；样本为空的分组不返回。检索指标评的是检索器，不是回答质量。

示例：计划 3 个检查，1 通过、1 失败、1 没有结果，返回 `{planned:3,passed:1,failed:1,skipped:0,missing:1,passRate:0.3333333333333333}`。

## 两次运行对比

`GET /api/compare?baseline=<UUID>&candidate=<UUID>`，两个 ID 必须不同。

```ts
type Condition = { key: string; status: "equal" | "different" | "unknown" };
type Comparison = {
  baseline: string; candidate: string;
  comparable: boolean; repeatCompatible: boolean;
  conditions: Condition[]; configuration: Condition[];
  issues: string[];
  analyses: { baseline: RunAnalysis; candidate: RunAnalysis };
  cases: Array<{ id: string; baseline: string; candidate: string; change: "same" | "improved" | "regressed" | "incomplete" }>;
};
```

`conditions` 核对 scope、suite、kind、dataset、checker、business、manifest、measurement；全部明确相等才 `comparable: true`。`configuration` 核对 model、prompt、skill、tools、implementation.files、runtime、settings；两组都相等才 `repeatCompatible: true`。settings 必须是明确保存的对象，不适用时使用 `{}`；超时、重试、compaction 等真实运行设置由 runner 固定。缺失元数据一律 unknown。git commit/dirty 不替代实际源码快照。只有可比且两侧案例均有明确 passed/failed 结果时才标 improved/regressed；跨题集或未执行时标 incomplete。

## 同配置批次稳定性

`GET /api/batches/<UUID>`

```ts
type BatchAnalysis = {
  batchId: string; compatible: boolean; issues: string[];
  plannedRepetitions: number | null;
  startedRuns: number; completedRuns: number; missingRuns: number | null;
  runIds: string[];
  cases: Array<{
    id: string; planned: number; passed: number; failed: number; skipped: number; missing: number;
    status: "always_passed" | "always_failed" | "mixed" | "incomplete";
  }>;
  usage: Usage;
};
```

所有已启动运行需同 suite、同完整配置与计划重复数；重复序号冲突、缺配置或不兼容时 `compatible:false` 且 `cases:[]`，不算稳定率。即使已落库运行全部通过，缺任何一次计划运行、运行尚未完成或案例跳过，场景仍为 incomplete。这里的 mixed 只是观察到通过/失败波动，不估计统计置信区间。只聚合库中保存的已知遥测，缺运行时完整批次用量为 null。

## HTTP 与前端约束

- 非 GET 为 405，非法/重复/额外 query 或 ID 为 400，记录不存在为 404，数据库不可用为 503。
- 延续 loopback、Host/Origin、CSP 和文本展示。API 不启动模型、不运行 Shell、不修改业务记录。
- 前端使用返回分母、scope 和比较结论，不重新计算口径；null 显示“未采集/不适用”，不能显示 0。
- Kimi 负责 `web/evaluation/`；后端负责合同、计划、断言和聚合。先展示覆盖标签、失败分布、重复稳定性，再按需展开原始轨迹。

## CLI 串行运行

```sh
node scripts/evaluate.ts --help
node scripts/objective-eval-check.ts
node --env-file-if-exists=.env scripts/evaluate.ts --suite engineering --repeat 1 --label '工程客观基线'
node --env-file-if-exists=.env scripts/evaluate.ts --suite retrieval --repeat 1 --label '逐题检索基线'
node --env-file-if-exists=.env scripts/evaluate.ts --suite readonly --repeat 3 --label '只读行为复跑'
node --env-file-if-exists=.env scripts/evaluate.ts --suite workflow --repeat 3 --label '售后协议复跑'
```

必须显式选择 suite；`all` 按 engineering、retrieval、readonly、workflow 顺序运行四套，每套独立批次 UUID。默认 repeat 为 1，允许 1–20；每次独立运行保留 UUID、重复序号及计划次数。label 去首尾空格后为 1–120 字符。`readonly`、`workflow` 和 `all` 会调用真实模型并产生费用；engineering/retrieval 不调用付费模型，但会使用本机数据库。

全部执行串行。客观检查失败仍完成其余预定重复，再以退出码 1 结束；参数或基础设施失败以 2 结束并停止，不自动重跑结果未知的运行。完整通过才退出 0。失败和未执行都不从计划分母移除；已保存运行可由批次 API 回读。每套独立输出后端分析，检索输出分语料/题型指标，不合成跨套件总分。

无参数、非法参数、重复选项不会启动 runner；`--help` 不读取数据库配置。离线 `objective-eval-check.ts` 校验固定题集与负例 oracle、参数边界和串行编排，不调用真实模型或数据库。
