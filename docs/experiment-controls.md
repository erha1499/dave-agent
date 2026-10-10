# 实验配置与调试

统一入口使用方案预设和参数白名单，不修改 `.env` 或运行中的 QQ。身份、范围、金额、批准、确认和幂等约束始终生效。业务评测用隔离的模拟订单；M0–M6 与 A1 保留离线实验入口，C1 另提供 Controller 在线知识服务候选，默认配置不自动切换。

## 本轮工作台接线合同（2026-10-06，实施前）

- **业务约束：** 咨询问题出处v3只能显式用于Controller实验，默认v2和常驻QQ保持原配置。完整原始解析审计留在宿主，不进入主Agent工具上下文；身份、fresh范围、确认、幂等与失败关闭继续生效。解析失败和缺失用量不能显示为成功或免费。
- **面试追问：** 如何证明表单参数真的进入运行时？为什么Agent、问题解析、重排和证据判别需分角色记账？怎样避免父子span重复计费，以及历史未采集费用被补成零？
- **个人实现与复用：** 复用现有实验校验/执行器、Pi解析客户端、questionProviderSpans和工作台分析；只补三个候选参数、实际Session接线/快照与费用分析。前端由Kimi CLI K3 Max增量接入，不新建Harness、数据库表或观测平台。
- **验收与演示：** `questionContract`默认v2；v2的`questionModel/questionTimeoutMs`为null且非空值拒绝，v3缺省解析模型configured、超时10000ms（1000..15000且不超过整轮），atomic+v3启动前拒绝。原生Pi替代HTTP证明显式v3实际调用、v2不调用、失败/取消不发布旧结果及费用保留；CLI/HTTP catalog/config/job透传、快照、历史兼容、四角色分币种及未知费用经工程检查。前端下载/回填、组合修复与折叠费用展示使用合成API检查，不提交远程业务实验。
- **预算与停止：** 本片0付费业务模型、0数据库、0QQ调用；Kimi仅用于已授权的前端开发。定向检查、独审与全量validate通过后提交推送并收尾。原固定题/gold/manifest及9/12→11/12真实结果不改，不运行已关闭live预算；用户要求本轮完成后暂停目标，不启动后续实验或准入工作。

### 咨询问题出处候选参数

| 参数 | 默认值与边界 | 实际作用 |
| --- | --- | --- |
| `questionContract` | `v2` / `v3`，默认v2；v3仅Controller | v3使用原始当前问题或合法同范围前序解析咨询，再进行中性查询和重新取证；不改常驻QQ或业务授权。 |
| `questionModel` | v2为null；v3省略键时configured，也可固定现有模型选项 | 独立选择问题解析模型，不自动跟随`agentModel`或`knowledgeSupportModel`的固定选择。configured仍取全局环境配置；v3显式null/undefined拒绝。 |
| `questionTimeoutMs` | v2为null；v3省略键时10000；整数1000..15000且不超过整轮超时 | 解析阶段等待上限，失败关闭、无自动重试；取消不代表供应商未计费。v3显式null/undefined拒绝。 |

`support-question-contract-ab`保持Flash主Agent、Pro typed v6、declared-v2、separated、0.5阈值与60000ms知识等待，仅显式切换v2/v3整套咨询出处方案。v3增加问题解析请求与相应延迟/费用；该预设使用通用业务开发题，不能把它当成已关闭六场景探针的复跑入口或成绩。v3也允许Controller+lexical，用于分离知识检索方案；atomic+v3在运行前拒绝。v2中任何非null解析参数均拒绝，避免开关关闭后仍静默保留无效选项。

```sh
# 仅预览参数，不读取业务库或调用模型。
node scripts/experiment.ts --preset support-question-contract-ab --dry-run
```

实际解析settings和三个参数进入`snapshot.content.settings`，每轮精简提供商span和宿主解析记录用于回看；完整解析trace不进入主Agent工具上下文。Agent-only旧metrics继续保留，归因分析按Agent/解析/重排/支持判别分列，币种与未知费用见[评测API](./evaluation-api.md#v2-执行归因增量字段)。工程接线通过不等于新的真实模型效果或完整C1准入。

## 工作台接线收尾与暂停（2026-10-07）

三个参数已贯通共享校验、CLI/HTTP、实验任务配置和实际Session，新增`support-question-contract-ab`预设默认不允许远程调用。v2不创建解析客户端；v3独立使用实际解析模型和等待上限，保存安全settings快照。原生Pi替代HTTP检查使用与业务执行器相同的接线，覆盖成功、无效JSON、缺用量、取消后旧轮未知费用保留和晚结果不串轮。完整解析记录留在宿主，普通Agent工具结果不携带该审计。

后端提供`providerUsage/providerTotals`，按已采集提供商叶子记录区分Agent、问题解析、重排和支持判别；USD/CNY分列，已知小计与完整金额分开。未知用量或币种不补零，父子重复记账报告异常且不相加；没有历史span不重建费用。该分母是已采集提供商记录，不是所有原始HTTP或账户账单。旧Agent-only指标继续独立展示。

Kimi CLI实际请求为`model=k3`、`thinkingEffort=max`，完成既有页面的三个控件、配置下载/回填、非法组合修复和折叠费用表。两项UI回归分别18/17组通过；真实Chrome 1440px/390px以合成API验收费用、未知CNY、A/B控件和下载的v2/null、v3/configured参数，页面错误和横向溢出为0，实验POST为0。首个浏览器脚本等待折叠字段可见而超时，改为等待DOM存在并展开后通过，没有修改产品行为。

后端定向、类型、独审及最终`npm run validate`退出0。前两次全量分别发现旧Session默认值断言漏三个参数、历史源码冻结校验不容新增费用归因；已补严格默认值，并独立固定原业务oracle的7651字节/hash及审阅后的归因尾段/全文件hash，明确整文件不等价。业务评分、题集、gold、reviews、结果和闭合manifest未变，篡改负控仍拒绝。失败与最终日志分别留在忽略目录`.runtime/question-workbench-validate.log`、`question-workbench-validate-final.log`、`question-workbench-validate-final2.log`；Chrome截图在`.runtime/question-workbench-preview/`。

可复现的0远程入口：

```sh
node scripts/experiment.ts --preset support-question-contract-ab --dry-run
node scripts/support-question-experiment-check.ts
npm run validate
```

本片0付费业务模型、0数据库、0QQ调用；Kimi开发请求不计入业务评测成本。历史真实v2 9/12、v3 11/12不回写，不重新运行闭合预算。默认v2、atomic + lexical、memory/id、DeepSeek及QQ保持原配置；整体C1/O4/O5和共同业务验收仍未完成。按用户要求，本轮提交推送后暂停目标并冻结版本；后续开发或新付费实验待用户明确恢复后再定合同。

## 配置

`src/experiment-config.ts` 是 CLI 与工作台共享的校验入口。旧格式 version 1 保留原始排名语义：

```json
{
  "version": 1,
  "kind": "support",
  "label": "业务架构 A/B",
  "repeat": 1,
  "allowRemote": false,
  "variants": [
    { "id": "A", "architecture": "atomic", "parameters": {} },
    { "id": "B", "architecture": "controller", "parameters": {} }
  ]
}
```

每个实验含 1–2 个方案，每个方案重复 1–3 次，按 repetition → A/B 顺序串行执行。不同方案各有独立 batch。业务参数为 `timeoutMs`（10000–120000）、`repairBudget`（0–2，仅 Controller）、`merchantEvents`（architecture/host/model）。Controller 不支持 model 通知分支，配置时拒绝；atomic 可切 host 作通知消融。实际 QQ 配置不受实验影响。

`repairBudget`是同一轮共用的动作修复预算：格式/当前引用错误，以及[范围变化后的有限只读修复](./c1-policy-scope-repair.md)共享计数。设为0关闭修复；设为1或2也只允许一次范围修复，下一动作只能重新查询同订单的独立当前问题或澄清，不能转为写入。普通业务拒绝、服务失败及不确定的副作用继续锁定，不使用此预算重试。真实模型收益尚未验收，工程替代结果须单列。

检索方案改为 `kind: "retrieval"`，每个 variant 使用 `modes: ["M0", "M4"]` 替代 architecture。参数含 candidateTopK、bm25K1/bm25B、rrfK/rrfWindow、cache、timeoutMs、retries、maxRequests、consecutiveFailureLimit。默认及边界由共享校验器提供。M4 始终使用可见范围内全部候选；Recall@5 / MRR@5 固定。cache=refresh 不读取或写入持久结果缓存，复用缓存的运行不能声称为独立模型重复或生产延迟。

`retrieval-v2`注入typed隔离判别客户端时，缓存v2保存完整原`verification`及哈希，保留partial/invalid状态和原请求证明；本轮cache-hit账本仍为0新attempt，不重复汇总原费用。binary及旧非隔离缓存v1保持兼容；缺完整证明的旧typed缓存拒绝使用，不自动迁移、覆盖或远程重试。需重新有预算运行时使用独立`cacheDir`并保留旧记录；`refresh`仍不写持久缓存。本地哈希与结构/输入绑定不是远端真实性或语义正确性的证明，修复工程证据见[缓存合同](./optimization-plan.md#第十片typed判别缓存保留完整证明)。

`acceptance-report`区分可用原文和整题判别完整性：typed partial可在原报告保留有效候选，但重算证明中存在`invalid_support_decision`时，该题标failed/incomplete，不进入完整测量及有效误拒/无答案拒收分母，也不得通过准入门；完整计划与可答分母保留。冷/热回放同一口径，不撤销运行时有效原文、不重写历史报告，见[验收完整性修复](./optimization-plan.md#第十一片不完整判别的验收门核查)。

业务与判别模型限于已审阅的模型白名单，embedding与rerank固定为百炼text-embedding-v4 1024维、qwen3-rerank；没有任意API URL、系统提示词、命令、文件路径或环境变量表单。通用长期记忆与“模型改写后双路召回”的C2实验暂未实现。显式`questionContract=v3`已实现受约束的咨询问题解析及原问出处校验，与宿主构造的检索查询分开记录，见[候选参数](#咨询问题出处候选参数)；整体C1仍未准入，默认v2不增加解析调用。

### C1 业务知识服务开关

`support-knowledge-ab` 是 `kind: "support"`、version 1 业务预设，两个方案都使用 Controller：A 为 lexical，B 为 M4 全候选重排 + 事实支持判别。它调用真实业务模型和 MySQL 中隔离的模拟订单；预设下载与预览不产生模型调用。

| 参数 | 默认值与边界 | 实际作用 |
| --- | --- | --- |
| `knowledgeMode` | `lexical` / `m4-support`，默认 `lexical` | Controller 查询知识时采用词项排名或重排加支持性判别；atomic + m4-support 在启动前拒绝。 |
| `knowledgeSupport` | `binary` / `typed`，默认 `binary` | binary 保持 A1 的二元判断；typed 区分事实/规则、明确边界问题、仅信息缺失和无关证据。typed 仅适用于 Controller + m4-support，非法组合启动前拒绝。实际 Prompt 版本写入 trace，类别不代表已获业务授权。 |
| `knowledgeSupportModel` | 现有模型白名单，默认 `configured` | 仅 Controller + m4-support 可固定支持判别模型；configured 独立读取全局环境配置，固定模型使用各自凭据。业务 Agent 的固定选择不因此改变；实际执行模型以 `trace.settings.support` 为准。 |
| `knowledgeSupportPrompt` | `v5` / `v6`，默认 `v5` | v6 仅 Controller + m4-support + typed，增加先确定用户所问命题的合同；选择只影响 typed，binary 继续使用 `fact-support-v1`。实际支持调用须核对版本和内容哈希，未发生调用只记录配置。 |
| `knowledgeApplicability` | `model_only` / `declared` / `declared-v2`，默认 `model_only` | 声明模式仅 Controller + m4-support：在原分数 / Top5 后，用本轮可信事实检查必要前提，再交模型判断。`declared` 固定 v1 数量/状态规则，`declared-v2` 追加审阅的合成商品类别目录，未知类别不按名称猜测。匹配不证明全部适用或获批，不增加模型阶段。 |
| `knowledgeQueryMode` | `combined` / `separated`，默认 `combined` | 仅 Controller + m4-support 可启用 separated：排序使用原问、可信前文、商品与简短订单状态；支持判别仍使用完整券数、按券状态关联的日期和原问。两者均由宿主构造，不增加模型改写阶段。 |
| `knowledgeThreshold` | 0–1，默认 0.71 | 仅 m4-support 的相关性预筛；分数不是概率。变更后属于新实验配置。 |
| `knowledgeTimeoutMs` | 1000–60000，默认 15000 毫秒 | Controller 单次知识查询的总等待上限，含读取、重排、支持判别与来源复检；零自动重试。 |

旧业务配置省略新字段时仍使用 lexical。知识为空时返回未知/澄清，超时或调用失败标为不可用；不会把未经验证的 lexical 结果作为 m4-support 失败后的可信证据。当前查询在读取和异步处理后复检语料，记录原始问题、实际检索问题、可信范围、配置、原文版本、拒收原因及实际用量。超时停止宿主等待和后续阶段；已经发出的提供商请求可能继续至其请求超时，未收到的用量显示未知。

```sh
node scripts/experiment.ts --preset support-knowledge-ab --dry-run
node --env-file-if-exists=.env scripts/experiment.ts --preset support-knowledge-ab --run --allow-remote
```

`support-knowledge-profile-ab` 在相同 Controller / m4-support / 0.71 下只对照 binary 与 typed，适合分离判别方案本身的收益。可以通过工作台调整阈值并下载完整 JSON；不应一边改阈值、一边改判别方案后把全部收益归给单一组件。预设是对照入口，不表示其中的值已经是最终推荐。已曝光开发题上的选择与新固定验证分别见 [C1 上下文结果](./c1-context-results.md)，端到端业务证据见 [C1 业务结果](./c1-business-results.md)。

`support-knowledge-model-ab` 固定 Controller / m4-support / typed / 0.5，仅比较 configured 与 Pro。只有环境中的 configured 实际为 Flash 时，才构成 Flash/Pro 对照；界面允许预览、修改、下载和运行，非法组合可在原控件修复而不暗改参数。该预设不代表当前候选已准入。开发对照与费用见 [支持模型结果](./c1-support-model-results.md)。

2026-10-06 新增 `agentModel` 与扩展 `knowledgeSupportModel`，两者分别支持 `configured`、`deepseek-flash`、`deepseek-v4-pro`、`qwen3.7-plus-2026-05-26`。`configured` 始终沿用原全局模型配置，两个角色各自的固定选择互不改写。固定 DeepSeek 使用 DeepSeek 独立凭据，不能借用另一全局 provider 的 `MODEL_API_KEY`；固定千问只使用 `DASHSCOPE_API_KEY` 和已审阅的北京普通百炼接口。完整接入、币种限制及选型依据见 [模型候选说明](./model-selection.md)。

新预设 `support-knowledge-qwen-ab` 固定主 Agent 为 Flash，在相同 typed v6 / declared-v2 / separated / 0.5 / 60000ms 下仅改变判别模型 Pro / Qwen。预设默认 `allowRemote=false`，该通用Session预设尚未执行真实模型。另一个独立typed v7组件对照已收尾、未证明千问收益，见[模型结果](./model-selection.md#单次真实结果与选型决定)；题集与角色不同，不合并成绩。以后执行Session对照仍需新问题与单次预算，不使用已结束的C1 manifest续跑千问或重算旧成绩。工作台非法组合应保留可修复控件，CLI/JSON与实际后端使用同一校验入口。

```sh
# 仅配置预览，0 模型与数据库请求。
node scripts/experiment.ts --preset support-knowledge-qwen-ab --dry-run
```

业务 live runner 新增 `--agent-model`；知识判别仍用 `--knowledge-support-model`。实际角色选择、Agent endpoint/价格、知识服务判别 settings 与源码均进入运行快照。百炼费用记录 CNY，USD 保持未知，不换汇；原始单价仅适用于北京输入不超过 256000 Token 的普通实时请求，缓存按全价保守估计，超档或用量缺失为未知。知识 trace 的 USD=0 表示该币种桶没有调用，不能据此声称百炼免费。旧 USD 记录保持原形状，身份、确认、幂等及默认配置不变。

CLI / QQ 读取 `KNOWLEDGE_MODE`、`KNOWLEDGE_SUPPORT`、`KNOWLEDGE_SUPPORT_MODEL`、`KNOWLEDGE_SUPPORT_PROMPT`、`KNOWLEDGE_APPLICABILITY`、`KNOWLEDGE_QUERY_MODE`、`KNOWLEDGE_THRESHOLD`、`KNOWLEDGE_TIMEOUT_MS`；未配置仍为 lexical / binary / configured / v5 / model_only / combined。Controller 通过 `SUPPORT_ARCHITECTURE=controller` 显式选择。环境变量只在进程启动时读取；实验表单只控制本次评测，不修改环境文件或运行中的 QQ。确认、身份与金额边界不受上述开关影响。

`support-knowledge-prompt-ab` 固定 Controller / m4-support / typed / Pro / 0.5 / declared / combined，仅比较 v5 与 v6，知识查询超时均为 60000 毫秒。v6 强调先确定原问命题：对象属性、组成或具体清单也是事实请求；资料缺失不能把该请求变成资料覆盖问题；原问明确询问覆盖、推断或核实去向时才按元边界判断，规则要求的核实流程仍可直接回答流程问题。没有新增模型层、类别或解析器，默认仍为 v5。

```sh
node scripts/experiment.ts --preset support-knowledge-prompt-ab --dry-run
# 显式真实 MySQL 开发运行；会产生模型和数据库调用。
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture controller --repeat 1 --knowledge-mode m4-support --knowledge-support typed --knowledge-support-model deepseek-v4-pro --knowledge-support-prompt v6 --applicability declared --query-mode combined --knowledge-threshold .5 --knowledge-timeout-ms 60000
```

运行参数和 `trace.supportPrompt` 标记本次配置；发生支持判别请求时，通用业务审计将 `trace.settings.support.promptVersion` 和 `promptHash` 与预期原文双重比对，输出 `supportPrompt=matched|mismatched`。没有支持请求则标 `not_called`，不能将空候选或数据库故障当作已验证 v6。既有报告和 v5 字节保持，候选收益以独立开发记录为准，开关本身不代表 C1 已准入。

独立重评新业务报告时，`scripts/c1-business-evidence-check.ts --file <报告路径> --support-settings=<冻结配置路径>` 必须提供执行前保存的完整 `EvidenceSupportSettings` JSON；不能从待评分报告自取配置充当独立依据。旧报告未记录该参数时保留原评分合同。Session 验证执行器则直接使用冻结 manifest 中的支持配置，交叉版本、缺失标记及自洽但被改写的配置均不能通过。

`declared` 使用独立的 [`data/knowledge-applicability.json`](../data/knowledge-applicability.json)，保持 v1 数量和券状态声明。`declared-v2` 实际加载新增 [`data/knowledge-applicability-v2.json`](../data/knowledge-applicability-v2.json)：完整审阅现有8篇来源，只给门店常规套餐规则追加类别前提，并按 seed 的精确门店/商品 ID 定义午餐、晚餐合成类别。目录是作者新增的模拟业务定义，不能称为外部商家认证，也不能按同名商品外推。旧语料、v1字节及gold不覆盖，模式与快照版本错配在支持判别前拒绝。

每个服务实例在首次使用时加载一次不可变快照；文件变更需新建服务 / 重启进程生效。v2规范内容哈希与原始文件SHA分列，文档全文 / scope / 状态、依据引文和本轮事实分别绑定。一般 / 假设规则咨询不套用当前订单条件；当前商品需要类别而目录缺失时阻断该来源。没有声明的前提不等于已经证明，缺失事实也不等于不符合。原始排名不重排、不补位，因此第六名有效证据仍可能未被接收；这属于本候选的召回取舍。

`support-knowledge-category-ab` 只比较 `declared` / `declared-v2`，共同使用 Controller、m4-support、Pro typed v6、0.5阈值及 separated。该预设是通用业务开发入口；[六场景Session开发合同](./c1-category-session-development.md)使用单独的冻结探针和总预算，不把通用预设运行当成此批成绩。当前支持模型的完整query尚未直接附审阅类别事实；门控matched不能代替语义通过，候选未准入。

```sh
# 参数预览，不连接数据库或模型。
node scripts/experiment.ts --preset support-knowledge-category-ab --dry-run
```

工作台的“已声明必要前提 A/B”预设比较 model_only 与 declared，只有当前运行使用的参数才代表实际生效。C1 开发 Session 可用 `node --env-file-if-exists=.env scripts/c1-session-live.ts --live --applicability declared` 运行一次完整开发批次；命令会产生真实模型请求，保留新运行的完整分母和费用。旧报告不重算。

`support-knowledge-query-ab` 固定 Controller / m4-support / typed / Pro / 0.5 / declared，以及 60000 毫秒知识查询超时，只比较 combined 与 separated。combined 保持完整事实用于排序和支持判别；separated 的排序输入不附券数零项和逐状态日期统计，完整事实仍交支持判别。假设解释保留原始依据且不混入现实状态；跨订单续问只延续已验证意图和新订单事实，不复制旧订单状态。两种模式均保留原问与真实前序，不通过截断问题减少长度。此预设是开发对照入口，尚不能据工程通过宣称召回或业务成功率提高。

```sh
# 只预览，不连接数据库或模型。
node scripts/experiment.ts --preset support-knowledge-query-ab --dry-run
# 显式执行一次真实 MySQL 开发集；需要已授权的模型/数据库环境。
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture controller --repeat 1 --knowledge-mode m4-support --knowledge-support typed --knowledge-support-model deepseek-v4-pro --applicability declared --query-mode separated --knowledge-threshold .5 --knowledge-timeout-ms 60000
```

运行快照记录 `knowledgeQueryMode` 和相关源码哈希。当前 trace 使用 `queries.version=knowledge-query-plan-v1`，分别记录 `queries.retrieval`（实际排序输入）和 `queries.evidence`（完整判别输入）；`trace.query` 仍表示实际排序输入。Controller 的 `search_faq.input.query` 保留完整问题，`input.retrievalQuery` 是交给服务的排序候选，combined 可以选择不用该候选。没有注入新服务的旧 lexical fallback 仍调用完整问题，并在 span 与 trace 记录实际输入。

通用业务审计核对外部模式参数、上述字段与宿主 context，输出 `queryPlan` 完整性和 `queryPlanHash` 输入指纹；指纹用于区分查询方案，不能替代基于冻结原文重算的 provider 请求哈希证明。后者由独立语义证据审计完成。预期数据库读取故障仍须保留正确查询记录，并证明未调用提供商；已声明前提门控在该故障下标为未评估。旧报告缺少新字段时保持历史口径，不回填为已完成分离查询。

### A1 配置 version 2

仅适用于 `kind: "retrieval"`。每个 variant 显式增加 `dataset` 和 `acceptance`：

```json
{
  "version": 2,
  "kind": "retrieval",
  "label": "A1 开发策略对照",
  "repeat": 1,
  "allowRemote": false,
  "variants": [
    { "id": "A", "modes": ["M4"], "parameters": {}, "dataset": "acceptance-development", "acceptance": { "mode": "off" } },
    { "id": "B", "modes": ["M4"], "parameters": {}, "dataset": "acceptance-development", "acceptance": { "mode": "score", "threshold": 0.8 } }
  ]
}
```

示例的 0.8 仅展示参数写法，不代表已选定或合格阈值。数据集枚举为 `legacy`、`acceptance-development`（48 题）、`acceptance-validation`（原 60 题，已曝光，6 道待 C1）、`acceptance-support-validation`（新 60 题：30 可回答、18 无答案、12 范围题，无 C1 延期）。`off` 是范围内原始 Top5 的诊断基线，`score` 接收分数不低于 threshold 的原文，最多 5 条；`support` 在相同分数筛选后增加事实支持判别。score/support 的 threshold 必须显式提供有限数值 0–1，仅支持 M4/M5/M6。策略开关始终保留 active/门店/套餐过滤。非适用模式、未知参数及 version 1 偷带新字段在执行前拒绝。旧 JSON 不自动迁移或套用新阈值。

策略不读取 gold；gold 仅由评分器在策略执行后读取。缺失分数、失效/越权文档和 provider 错误不会成为已接受证据；失败时的 lexical 结果只用于诊断。每轮快照保存实际阈值、策略版本、模型/指令、文本格式及 corpus hashes，原始排名保持不变。改模型、语料或格式后必须重新校准，rerank 分数不是答案正确概率。

先用开发集校准，冻结后再运行固定验证。只看验证结果改阈值后，该题集不再能提供新的独立验证结论。数据来源与 24 个业务对话准备情况见 [数据说明](./acceptance-data.md)。

### 事实支持模式

工作台 catalog 提供 `support-development` 和 `support-validation` 两个 version 2 预设，均为 `kind: "retrieval"`，对照 `score` 与 `support`。固定的重排阈值 **0.71 是开发配置中的相关性筛选值，不是 71% 的答案正确概率，也不表示已达到上线要求**。预设使用 60 秒请求超时、百炼重试 0 次、单方案单次运行最多 160 个实际远程请求；原配置的 `kind: "support"` 继续表示业务架构评测。

```json
{
  "version": 2,
  "kind": "retrieval",
  "label": "事实支持固定配置对照",
  "repeat": 1,
  "allowRemote": false,
  "variants": [
    {
      "id": "A",
      "modes": ["M4"],
      "dataset": "acceptance-support-validation",
      "parameters": { "timeoutMs": 60000, "retries": 0, "maxRequests": 160 },
      "acceptance": { "mode": "score", "threshold": 0.71 }
    },
    {
      "id": "B",
      "modes": ["M4"],
      "dataset": "acceptance-support-validation",
      "parameters": { "timeoutMs": 60000, "retries": 0, "maxRequests": 160 },
      "acceptance": { "mode": "support", "threshold": 0.71 }
    }
  ]
}
```

每个通过分数筛选的非空候选集，使用项目已配置的 Pi DeepSeek chat 模型发起 **一次批量请求，最多 5 篇原文**。判别器无工具调用，逐篇返回支持与否、连续原文引文和简短理由；所有输入 ID 都必须恰好返回一次，原始排名和重排分数保持不变。候选集为空时不发此请求。support 内部 `maxRetries` 固定为 0，失败不会暗中重试；表单里的 `retries` 控制百炼请求。60 秒是上述预设值，运行时 support 使用该方案实际 `timeoutMs`，快照保存实际配置。

`maxRequests` 是每次运行共用的请求预算，包含 embedding、rerank 和 support 的实际网络尝试；A/B 各自独立，不能把 160 理解为整组上限或金额预算。support 有独立连续失败计数，也使用 `consecutiveFailureLimit`：中间 rerank 成功不会清掉 support 失败，达到限制后以 `consecutive_support_failures` 停止后续请求。缓存命中不消耗新网络预算，缓存键绑定问题、可信范围、原文、模型与判别配置；刷新缓存会重新请求，缓存复用不能算独立模型重复。

比较时使用同版代码、同一冻结配置，按 [新验证集说明](./acceptance-data.md#新一轮事实支持固定验证) 保留非盲测和验证曝光边界。执行记录与结论见 [事实支持结果记录](./a1-support-results.md)；本配置说明不预告成绩，也不改变线上 QQ 知识服务。

CLI 默认仅预览，不调用模型或数据库：

```sh
node scripts/experiment.ts --list
node scripts/experiment.ts --preset support-ab --dry-run
node scripts/experiment.ts --config configs/experiments/retrieval-local.json --run
node --env-file-if-exists=.env scripts/experiment.ts --preset support-ab --run --allow-remote
node scripts/experiment.ts --preset acceptance-development --dry-run
node --env-file-if-exists=.env scripts/experiment.ts --preset acceptance-development --run --allow-remote
node scripts/experiment.ts --preset support-development --dry-run
node scripts/experiment.ts --preset support-validation --dry-run
node --env-file-if-exists=.env scripts/experiment.ts --preset support-validation --run --allow-remote
```

配置文件可来自工作台下载或 `configs/experiments/` 示例。CLI 和网页执行共用目录锁及任务记录，执行中的配置不会随表单更改而改变。

## 工作台接口（本机）

- `GET /api/experiments/catalog` → `{presets:[{id,name,config}],fields:{support:[],retrieval:[]},modes:[{value,label}],datasets:[{value,label}],acceptanceFields:[],limits,notes}`。field 含 key/label/type(number|select)/min/max/step/options/note。接收字段独立于 ranking parameters；config 已填默认参数，allowRemote 默认 false。
- `GET /api/experiments` → `{jobs: ExperimentJob[]}`，最新 30 项。
- `GET /api/experiments/<uuid>` → `ExperimentJob`。
- `POST /api/experiments`，Content-Type application/json、`X-Experiment-Request: 1`，body 为配置本身 → 202 `ExperimentJob`。400 参数/组合/远程调用未允许，409 已有活动实验，503 启动不可用。错误响应 `{error:string}`。

```ts
type ExperimentJob = {
  id: string;
  status: "running" | "completed" | "completed_with_failures" | "failed" | "interrupted";
  createdAt: string; finishedAt: string | null;
  config: ExperimentConfig; configHash: string;
  plannedRuns: number;
  current: {variantId:string; repetition:number} | null;
  error: string | null;
  results: Array<{
    variantId: string; repetition: number;
    kind: "support" | "retrieval";
    status: string;
    runId: string;
    summary: unknown;
  }>;
};
```

support 的 runId 是现有 MySQL 评测记录，summary 为 `RunAnalysis`（counts/usage/timing/issues 等，合同见 evaluation-api.md），可在现有页面查看或对比。检索 runId 对应已有 `.runtime/retrieval-v2/<id>.json`，summary 是该报告的真实 summary（groups 按 mode/corpus/suite 分列，usage 按 operation 分列；含缺失、失败、缓存命中和部分用量），工作台只展示实验关联结果，不扫描导入历史离线报告。不能把 USD/CNY 合并或把各种语料和题集合成单一通过率。

新报告每行另有 `acceptance`（接收原文、拒收原因、分数诊断）与 `acceptedMetrics`；summary.groups[].acceptance 包含成功及计划分母的 Recall、覆盖率、`noAnswerFalseAcceptCases/noAnswerDenominator/noAnswerPlanned`、`answerableFalseRejectCases/answerableFalseRejectDenominator`，以及 `abstentionFalseAcceptCases/abstentionDenominator/abstentionPlanned`。最后一项包括范围题的预期拒答，区别于权限范围违规。误拒分母仅含原始 Top5 已有有效证据的可回答题；缺少观测时 rate 为 null。`deferred/failed/missing` 分列，6 道上下文题留在计划且不发模型请求，不能算通过或成功拒答。旧报告没有接收字段时显示未记录。任务 completed 只说明执行结束，不证明策略达到准入门槛。

support 报告另保存逐行 `supportVerification` 和独立 `supportCalls` 账本。若 rerank 成功但支持判别超时、返回无效或请求预算不足，原始 ranking/metrics 仍保留成功结果，接收阶段为 `acceptance.status: "unavailable"`、`acceptedMetrics: null`，`summary.groups[].acceptance.failed` 增加；不能将其当成功拒答或从计划分母删除。可回答题的计划 Recall 仍承担该失败，成功观测的误拒/误接收分母不混入未完成判别。

`summary.usage` 按 operation 分行：embedding/rerank 的费用在适用区域使用 `knownEstimatedCostCny` / `completeEstimatedCostCny`；support 按实际 attempt 分别汇总已有 USD/CNY 字段，价格来源与固定版本在 `snapshot.settings.acceptance.support.pricing`，是估算而非账单。`costCoverage` 是有任一币种已知费用的请求数/实际请求数；每个 `completeEstimatedCost*` 只有全部实际请求均报告该币种费用时才有值，混合币种不能成为单币种完整费用。USD 与 CNY 独立展示，已知零费用保留为0，未知费用是 null；缓存命中无新请求/用量，零实际请求的完整费用与覆盖率仍为null。格式无效的模型输出也可能已经产生用量，不能把未接收证据当作免费调用。2026-10-09补齐support的CNY汇总；历史保存报告不自动重写或补算。

事实支持效果必须基于实际 verifier 记录评分：

```sh
node scripts/acceptance-report.ts --report .runtime/retrieval-v2/RUN_ID.json
```

该入口核验记录与输入/配置的绑定、原文和实际接收结果。`acceptance-calibrate.ts` 可以重放原始分数来校准 score 阈值，**不能从原始分数生成或重放 support 判断**；不能用纯分数校准结果冒充“事实支持模式已验证”。修改候选范围或判别配置后，应取得相匹配的实际判别记录，再用固定验证报告评价。

HTTP 不接受命令或密钥；仅本机 Host/Origin，严格 JSON、请求体上限 32 KiB。任务执行状态和完整配置保存在忽略的 `.runtime/experiments/`。[HTTP 的 POST/GET](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/src/eval-server.ts#L57-L88)分别调用 `start/list/get`；[CLI 实际运行](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/scripts/experiment.ts#L47-L56)为 `start → await close → get`，`--list` 仅列预设。互斥只覆盖使用同一实验目录的 `ExperimentJobs` 入口，不约束直接调用 runner 的脚本或其它数据库 worker。

**本机实验锁审计（2026-10-08）：** 售后评测可写合成订单，不能在前一任务尚未收尾时撞入现场；面试追问是“为何只准一个实验、关闭为何等待、PID 能证明什么”。个人实现为配置快照、目录互斥、落盘和中断记录；复用 Node 标准库及现有 runner/Pi，不扩建调度器。固定源码 `63f376ed`，验收为调用链、既有断言及文档差异/链接静态核验；预算30分钟，材料补齐即停，0运行样本，不启动实验/数据库/模型/QQ或清理实际锁。

| 调用与源码定位（固定上述版本） | 行为与既有检查定位 |
| --- | --- |
| [`serialized/start`](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/src/experiment-jobs.ts#L36-L45)，`start` 第192–223行 | 同进程按目录串行处理元数据，跨进程以 `mkdir active.lock` 和 `wx` 创建元数据拒绝竞争；在串行区内登记 `active`，避免关闭漏等已进入的启动。[检查第79–103、185–191行](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/scripts/experiment-jobs-check.ts#L79-L103)包含第二实例拒绝、串行重复及两个并发启动只成功一个。 |
| [`readLock/recoverLock/interrupt/get/list`](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/src/experiment-jobs.ts#L117-L191) | `get/list/start` 也会触发恢复写入；完整锁元数据的 PID 判死后才尝试回收该代次，恢复 owner 仍活则拒绝抢占。任务另按 `ownerPid` 判断，死进程的 `running` 记录转 `interrupted`、清空 `current`，保留计划和已保存结果，不自动补跑。[检查第193–222、232–240行](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/scripts/experiment-jobs-check.ts#L193-L240)包含死PID、缺失主元数据、活恢复owner、半写及活PID保护。 |
| [`run/close`](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/src/experiment-jobs.ts#L225-L251) → [工作台信号关闭](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/src/eval-server.ts#L160-L170) | `run` 最终保存并释放自己的锁；执行异常停止后续运行，保留分母与已存结果。`close` 封闭本实例启动、经过元数据串行区后等待本实例 `active`，无取消/超时，不等待其它实例实验。工作台 `SIGINT/SIGTERM` 先关HTTP连接，再等待实验、关闭历史Store；CLI未注册该信号处理。[检查第89–101、172–183行](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/scripts/experiment-jobs-check.ts#L89-L101)分别检查等待与失败后 `plannedRuns=4/results=1`，不代表真实数据库清理成功。 |

[`alive(pid)`](https://github.com/erha1499/dave-agent/blob/63f376ed17c313edefc3aa693195ebec2eeed7b6/src/experiment-jobs.ts#L32-L35)仅以 `process.kill(pid, 0)` 探测，只有 `ESRCH` 视为死亡，其它错误保守视为存活；PID复用可能阻止恢复，不提供强进程身份或跨机器保障。正常释放指执行器的 `finally`，强杀/掉电不能保证订单清理；恢复锁也不清理遗留数据库fixture。`active` 吸收运行拒绝，`close` 返回本身不证明落盘或清理成功，仍须回读状态/结果；`completed` 不等于业务准入，也不授权重跑已关闭预算。仅在确认没有实验进程运行后，手动检查并清理 `active.json` 和 `active.lock/`；不要删除历史任务JSON，本轮不执行清理。

独立复现入口为 `node scripts/experiment-jobs-check.ts`（无env-file，临时目录、注入runner及人工构造dead-PID元数据，本轮未运行）。上述断言不是实际子进程终止、HTTP信号关闭、PID复用或真实fixture清理验收；本片仅静态补材料，不增加历史工程/模型/QQ样本。中断和未执行重复不能算通过，分母与准入另见[评测口径](./evaluation.md#评测分母与费用调用链审计2026-10-08)。

## 对比口径

执行前解析完整配置，执行时将同一参数传入 runner 并保存实际 settings。架构、通知模式、修复预算和检索参数差异可追溯；实验 ID 单独记录，不污染重复兼容哈希。原有共同业务条件与检查器资格门控继续生效。runner 源码变化可能导致新记录与旧历史不可比，应使用当前同版代码重跑基线/候选，不放宽 checker 来制造提升。

请求上限按每次检索运行计，不是整组实验的金额预算；重试也计请求。缓存复用可能显著减少请求，但不能据此假设某次调用免费或已取消远程授权要求。付费业务或 M2–M6 必须显式设置 allowRemote=true 才能启动。

## 既有工作台验收记录

2026-10-05，此前本地 CLI 运行 M0/M1 完成 580 项；工作台配置 A/B（BM25 b 为 0.75 / 0.25）分别完成 580 项，配置下载与载入后参数一致，远程请求均为 0。这份历史记录只证明配置与执行、展示的闭环，不声称调参提高了泛化效果。当时未调用付费业务模型或百炼服务，也未重验真实 QQ；后续事实支持实验按其独立结果记录说明。

确定性检查覆盖参数实际改变排序/候选/缓存/修复预算，错误组合在凭据读取前拒绝，配置快照不可被表单修改，串行重复与失败缺项，跨进程死锁恢复的活锁保护，HTTP 同源/请求体/非法 URL 边界。前端检查覆盖懒加载、远程调用门控、任务状态竞态、连续参数编辑与统计口径；浏览器验证宽窄屏、JSON 下载、参数复现及本地 A/B。完整检查入口为 `npm run validate`。
