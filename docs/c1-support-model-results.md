# C1 支持判别模型开发对照

最新补充（2026-10-06）：typed v5 + Pro 的 8 问语言与事实边界开发诊断为 **7/8**，不是完整 C1 准入。周末续问仍被拒收；商品类别依据与普通词义蕴含需分开核对。下文保留各版本首次结果，v3 的 10 问对照不由新题重算。

2026-10-06：冻结的 typed v3 / 10 问直接支持判别中，`deepseek-flash` 通过 9/10，`deepseek-v4-pro` 通过 10/10。Pro 修正了本次 Flash 的一处误接收，单次总估算费用约为 3.96 倍，P50 约多 730 ms。该结果支持新增独立支持判别模型开关，**不代表 C1 新验证集、完整业务链路或生产效果通过**。业务 Agent 默认模型、QQ 默认架构和知识模式均未自动切换。

## 问题和候选

支持判别需要区分三个不同诉求：规则/流程前提、具体业务事实、文档覆盖或推断边界。原文说“未录入”，可以回答用户明确询问的“知识库是否记载”，但不能提供实际过敏原、使用资格、日期、批准或到账事实。

typed v3 明确了文档覆盖的否定回答，保留 typed v2 的规则前提合同；binary v1、typed v1/v2/v3 的完整 Prompt 和 hash 仍保存在 `src/evidence-support.ts`。这次两模型对照固定输入和 Prompt，仅比较本地 Pi 目录中实际存在的两个模型；后续版本另行记录，不归入该对照。

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

以上两模型对照只完成独立支持组件开发对照与开关工程检查，未做重复稳定性实验，未新建/读取下一版验证题，未用这 10 问替代知识检索、真实多轮动作链、14/24 业务回归或 QQ 验收。后续端到端运行在下文单独记录。

## 后续批量引文诊断（2026-10-06）

真实 Session 开发批次 `5dec8496-33c8-4708-81ed-6ccc08937637` 的预约场景，4 篇候选的 Pro 判断发生 `invalid_response`。该批次原始模型文本没有保存，因此无法直接确定原始错误的细分原因；原失败及随后跳过的续问继续保留，不能用其他请求的成功追认通过。

随后增加了有界诊断：生产 `KnowledgeTrace.supportFailure` 仅保存失败枚举 `code` 与 `outputHash`，不保存原始模型文本；仅合成测试可以显式注入 observer，将最多 20,000 字符的 text 块和 stopReason 保存到忽略目录。Prompt、请求 settings、精确引文合同和接收决定均不变，binary 请求 golden 检查继续通过。

根据原报告 query/scope、冻结语料、原始排名和阈值 0.5，重建 RS003/RF003/RF002/RS002 四候选；scoped corpus hash、settings、来源文件与原快照一致。原失败没有 requestHash，不能与不存在的原请求值比较。只额外请求一次，诊断 run `48d0432f-e07e-4931-8386-cd4620eb010a`，源码前后稳定，仍返回 `invalid_quote`：RS003 的直接规则引文正确，但 RF003（分类为 limitation_only）的引文将原文半角逗号 `U+002C` 改为全角 `U+FF0C`，从而使整批严格校验失败。这是此次复现的确定原因，不是对前次失败原因的追溯证明。

本次 1 请求、1,474 tokens、2,736 ms，目录估算 USD 0.001146288；没有重试、修改 Prompt 或自动修补标点。输出哈希 `602127f645d196e7a155537fcb2978e9be375a8c1042112a33579c6ef003d082`；报告及原始 text 仅在 `.runtime/c1-session/support-diagnostic-48d0432f-e07e-4931-8386-cd4620eb010a{,-raw}.json`。诊断脚本曾在导入阶段因相对路径错误停止，已单独保存 0 请求的启动错误记录，未消耗模型重试。

这说明单篇开发分类的 10/10 不能保证多篇引文格式稳定。当时选定的后续方案为**逐候选故障隔离**：整体 JSON/结构及未知、缺失、重复 ID 继续整批拒绝；可明确归属候选的引文、类别、理由错误单项标为 invalid，不能接收或算正确拒收。其余项仍需通过精确引文、语义判断和原文版本复检；全项无效仍 unavailable。以下记录其后续实现与执行证据。

备选的“模型选择原文片段 ID、宿主还原原文”可避免自由抄写标点，但需要分段、版本绑定及跨片段条件覆盖，还不能替代语义判别。当前先采用错误隔离，按收益决定是否增加分段协议。两种方案都不能追改原成绩。

## 隔离实现、零请求回放与后续边界

`typed-candidate-isolation-v1` 已实现：valid 与 invalid ID 的并集必须精确覆盖输入候选；invalid 不转换为 `supported=false`，apply 仍核验输入绑定和当前原文。全部 invalid 或只有有效负例加 invalid 时为 unavailable；一个候选的原文失效仍清空整组当前证据。历史 binary 和 typed 批量解析分支保留。

本地 `.runtime/c1-session/isolation-replay.json` 使用诊断 `48d0432f-e07e-4931-8386-cd4620eb010a` 保存的相同输出，**新增网络请求 0、估算费用 0**。旧解析器为 `invalid_quote`；新解析器为 partial，RS003 接收，RF002/RS002 有效拒收，RF003 单项 invalid。报告中的历史 attempts / usage 只为重放输入保留，不能重复计入新请求或费用。原始 outputHash 仍为 `602127f645d196e7a155537fcb2978e9be375a8c1042112a33579c6ef003d082`；回放报告 SHA-256 `d8ab9af0d4d4a362e591bdfd77817281998c17f8b578ea41b50b9197f42b7c52`，执行前后源码一致。这证明该输出的解析隔离，不证明模型分类已经更准确。

随后真实 Session run `9b14fe45-dbb1-4605-9a8c-c0bd784184e6` 仍使用 typed v3 / Pro / 0.5：严格 7/10 对话、业务合同 8/10；预约首轮 RS003 成功形成话题并续问，但 RF003 invalid 使完整性失败。另有当前单券资格误接收多券 / 已核销规则，以及缺话题轮未先澄清。实际回复保留了部分条件，并不等于已经发生事实捏造；逐案结论见 [Session 结果](./c1-session-results.md)。[MySQL 14/24 回归](./c1-business-results.md)同版本通过，但不能抵销这些失败。

根据上述开发失败新增 `fact-support-typed-v4`：区分本单资格与一般 / 假设规则，检查整篇规则的适用对象、数量和状态；依赖未解析指代的问题不能从候选中反向挑选数字或主体补齐，同时允许已核实前文解释续问。审批流程题不要求本次已获批。Controller 另补 fresh 券数量及四种现有状态计数，来源仅为本轮授权订单；不按知识 ID 或政策关键词筛选。

v4 的 schema、版本回放和工程检查已完成；factory 的内部 `typedPromptVersion` 显式选择实际 v3/v4 提示词，不能仅修改 settings 冒充历史回放。其后执行一次 v4 + fresh 券计数的完整 Session 开发回归，结果如下；未执行新 24 对话，也未用旧题的开发成绩替代新验证。

## typed v4 后续 Session 开发结果

run `4417a40f-87ae-44cf-babb-43129eca2e43` 使用 `fact-support-typed-v4`（hash `2f099bedc39fcaec9b3d40e7cd3c579c3b0e2f5577d72cae45d72909bf5fe722`）、Pro、阈值 0.5、逐候选隔离，以及新增 fresh 券计数和主业务提示。源码前后稳定。严格和业务合同均为 **8/10 对话**；20 轮中 17 通过、2 失败、1 未执行。

实际 6 次知识查询全部接收完整 gold，无额外证据、invalid 或 partial；另一单资格只接受 UNUSED，缺话题先澄清，预约前序与续问通过。但计划知识轮仍有 8 个，周末前序因商品名称匹配停止、后序跳过，不得用实际 6/6 覆盖未完成分母。另一个失败为模型只写澄清文本、未提交动作；这两处没有调用支持模型，不能归为 Pro 判别误拒。商品别称缺少可信映射，需先定业务消歧合同，不回改旧 gold，详见 [逐案结果](./c1-session-results.md)。

实际 HTTP 52：Agent 40、rerank 6、support 6；目录估算 Agent USD 0.011688396、support USD 0.010750872，合计 USD 0.022439268；rerank CNY 0.0096345，用量完整。多处实现同时变化且只运行一次，不能据此给出单一 Prompt 的因果收益。随后 v4 的独立 [MySQL 业务 run](./c1-business-results.md) `0227d537-761a-48f9-ae6f-3d0ed82f7a63` 通过 14/14 案例、24/24 轮、172/172 断言；实际 HTTP 56（Agent 44、rerank 6、support 6），USD 0.02500436 + CNY 0.003759，源码前后稳定，16 张测试订单清理后剩余 0。但该合同没有精确约束所有接收证据：单券咨询仍额外接收 PARTIAL 多券规则，invalid / partial 为 0 不能说明语义误接收为 0。Session 仍为 8/10，**C1 仍未准入**；原 v3 和首次报告保持原分数。

## typed v5：语言解释与业务事实边界（2026-10-06）

v4 首句禁止常识补足，容易同时压制正常语言解释。v5 允许同义表达、已明确指代、词义包含关系及确定性区间判断，同时保留商品类别、真实日期例外、营业接待、批准及到账事实的独立依据要求。没有增加模型阶段、重试或特殊问题分支；v4 原文、hash 和工厂显式回放入口保持不变。

冻结的新诊断为 `data/c1-language-support-development.json`，8 问 / 4 对，正负各 4；数据 SHA-256 `925c5ce543c40192d85a36f46df4cc1545a3c99250f2522b1923eba950169163`，来源 manifest SHA-256 `9a6bbe566aa756e259fe22334d8d94db746f690056bab93d727c4d271e246d48`。005 保留已曝光的原周末 query 和标签；这次每题只有一篇候选，不能称为原两候选输入的重放。旧 6/10 题与历史标签未修改。

单次运行 `831e2a6e-e7b4-46c4-9ca5-8443cf9bc986`：**7/8**，正例接受 3/4、负例误接收 0/4、错误 / invalid / partial 均为 0，8 次 support HTTP、13,168 tokens、估算 USD 0.00970992，无 rerank。codeStable=true；Prompt `fact-support-typed-v5`，hash `6f90373dc229648806bfa93957041bc7bb8ba7f50c76e61fe316827561b2453b`。原始 artifact SHA-256 `ce743f8b0cdcde49c680e3b9e6f22e69ad1668bdb9f96b3070b89c71d8f9c94a`。

退款去向同义表述、明确假设下 12 点属于 11–14 点区间、资料覆盖边界均通过，实际到账 / 当日接待 / 确切日期保证 / 私享套餐资格均正确拒收。005 仍为 limitation_only：模型给出的理由同时包含“未明确星期天是否属于普通周末”和“该券是否适用”。这是该次失败的原始理由，不能直接据此断言只有词义问题；用户前文的商品描述与已核实名称、规则类别是否对应必须单独审计。所有原始失败和分母保留，未按运行结果修改标签。

```sh
# schema-only，无网络
node scripts/c1-support-check.ts --language
# 上述单次真实运行命令；会产生费用
MODEL_ID=deepseek-v4-pro node --env-file-if-exists=.env scripts/c1-support-check.ts --language --live
```

这组结果只说明单篇证据判别开发表现，不代表商品实体解析、完整 Session、MySQL、QQ 或最终回复质量通过；也不能与不同题组 v3 的 10/10 直接计算改进率。

独立语义复核：星期天属于周末是词义关系，原规则可回答保留普通周末与特殊日期限制的条件式问题；但 `product-demo-1` / “双人午餐团购券”在 seed、fixture 和商品知识中没有明确的“常规套餐”类别字段。Controller 附加的前问仅用于指代，成功 topic 不能把用户的类别措辞升级为已验证事实。因此 005 混合了语言解释与业务前提，不能称为干净的纯语言误拒；原 7/8 不重标，也不以完整 Session 10/10 消除这项歧义。后续商品类别能力应采用版本化业务资料；新的固定验证使用事实依据明确的题目，并保留缺引用 / 竞争引用等全部原定分层。
