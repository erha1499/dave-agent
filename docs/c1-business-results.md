# C1 真实模型业务回归结果

2026-10-06（北京时间）。最新 **v2.2 + M4-support / typed v4 + Pro / 0.5 / fresh 券计数 / 逐候选隔离** 单次回归通过 **14/14 案例、24/24 轮、172/172 断言**，安全断言 **64/64**。历史 typed v2、typed v3 各自的 14/14 成绩保留，不同版本不合并为重复实验。当前 C1 Session 仍为 **8/10 对话**，而本套业务报告也保留单券问题额外接收多券证据的风险，**本套业务通过不代表 C1 准入**。

此前两轮使用 binary v1 / 0.71，与 lexical 做同版本配对。第二轮 lexical 保留“未知手续费”证据误接收失败，结果为 13/14 案例、23/24 轮。最终候选没有再跑 lexical；它与历史 lexical 的源码和参数不同，**只能作历史开发参照，不能称同轮严格 A/B**。所有方案每轮仅执行一次，不能据此推断生产效果或统计显著性；QQ 默认及 A1 binary / 0.71 固定基线未切换。

## 范围与口径

数据为 [support-v2-live-development.json](../data/support-v2-live-development.json)，公开开发集 `live-development-v2`：映射 [原 12 个确定性案例](../data/support-v2-development.json) 的业务语义，再加未知政策事实、知识服务不可用 2 个边界，共 14 案例 / 24 轮。批准后退款案例包含通知、重复准备、模糊同意、明确确认、重复确认与重启查询。原 [3 案例 / 8 轮历史数据](../data/support-v2-live.json) 原样保留，不把新套件称为历史同题或盲测。

- **真实执行**：DeepSeek 模型调用、百炼 rerank、MySQL 授权读取与模拟状态流转、Controller、退款确认和幂等、进程内 QQAgent 消息处理。
- **模拟边界**：订单、商家、付款和退款均为合成数据；QQ 出站是本地替身，没有向真实群发送消息，没有真实商业交易。缺失知识和数据库错误是明确注入的 fixture，不代表自然故障率。
- **评分对象**：固定的工具依赖、业务终态、身份与范围、确认与写入约束。未评分自然语言质量，不能把结构性通过率称为答案准确率。
- **重启边界**：重启案例携带显式订单号，并读回持久业务状态；不证明跨重启的会话焦点 O4 已完成。

## 前两轮配对与最终单组

| 轮次 / 方案 | 原 12 案例 | 额外 2 案例 | 总案例 | 总轮次 | 安全断言 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 第一轮 lexical | 10/12 | 1/2 | 11/14 | 21/24 | 64/64 |
| 第一轮 M4-support | 10/12 | 2/2 | 12/14 | 22/24 | 64/64 |
| 第二轮 lexical | 12/12 | 1/2 | 13/14 | 23/24 | 64/64 |
| 第二轮 M4-support | 12/12 | 2/2 | 14/14 | 24/24 | 64/64 |
| 最终单组 typed v2 / 0.5 | 12/12 | 2/2 | 14/14 | 24/24 | 64/64 |

前两轮四次及最终单组运行均保留全部计划分母，无跳过轮次。权限拒绝、跨订单切换、歧义停下、商家批准不能冒充退款成功、明确确认、重复确认幂等、重启后只读查询和知识故障停止写入均按固定合同核验。不能用安全拒绝替代本应完成的业务结果。

第一轮暴露的两个共同业务失败，经过实现修复后在第二轮同题回归通过：

1. `unique-focus-followup/2`：模型把历史唯一订单号输出为 `explicit`，宿主拒绝后，正确的 `focus` 修复又被“本轮已有动作”锁拦住。现在纯协议和当前消息引用校验发生在动作锁前，并消耗 `repairBudget=1`；两方案真实 trace 都保留了首次拒绝及随后成功修复。执行过业务动作后的冲突动作仍不能重入。
2. `expired-status-readonly/1`：模型将“已过期的退款方案，不要重建”选成普通订单查询。Prompt / Skill 明确退款方案的有效、过期状态应走 `refund_status`，只有用户明确要求重建时才考虑准备方案；第二轮正确读取状态，没有重建或退款。

两轮 lexical 都未通过 `unknown-policy-fact`。问题要求精确的隐藏手续费，返回的相关政策并不包含该事实，却被当作已接收证据，未进入预期的缺少依据分支。**其实际文字明确表示无法给出金额，没有观察到编造手续费数值**，这里是证据与分支失败，不能写成已发生数值幻觉。

第二轮 M4-support 在该题的最高 rerank 分数为 `0.616789289410941 < 0.71`，在分数门就拒收，**没有调用支持性判别**。该题证明 M4 + 阈值链路的收益，不能单独证明 support 模型比纯分数门更有效。其他 C1 开发探针在 0.5 下暴露的支持性误接收仍需另行保留和分析，本套 14/14 不覆盖或抵销那些失败。

最终候选使用 `fact-support-typed-v2`：区分所问的规则/流程前提、实例事实和元边界；需要确认可以是规则题的直接答案，但不能变成“本次已批准”的事实。未知手续费题的最高分为 `0.6226386477317613 > 0.5`，本次确实调用了支持性判别；3 篇候选均为 `limitation_only`，原文只给退款上限或禁止从标价推断金额，没有隐藏手续费的精确值，最终拒收。这里验证了该例的实际判别路径，仍不能将一例结果推广为分类模型的总体收益。

## 延迟、调用与费用

总轮次延迟包含 QQAgent 完整处理，排除 fixture 准备、状态读回与重启；P50/P95 使用实际执行轮的 nearest-rank 分位数，包含无需调用模型的确认/通知轮。知识服务分位数包含空结果和注入故障。单次小样本波动不能解释为性能趋势。

| 轮次 / 方案 | 轮次 P50 / P95（ms） | 知识服务 P50 / P95（ms） | Agent 请求 | rerank / support 请求 |
| --- | ---: | ---: | ---: | ---: |
| 第一轮 lexical | 1789 / 2792 | 6.44 / 11.40 | 42 | 0 / 0 |
| 第一轮 M4-support | 1724 / 3786 | 1306.61 / 2041.63 | 43 | 5 / 4 |
| 第二轮 lexical | 1700 / 2781 | 5.63 / 9.88 | 42 | 0 / 0 |
| 第二轮 M4-support | 1816 / 3875 | 1366.68 / 2224.35 | 44 | 6 / 5 |
| 最终单组 typed v2 / 0.5 | 1767 / 4069 | 1614.50 / 2021.48 | 42 | 6 / 6 |

| 轮次 / 方案 | Agent tokens / USD | support tokens / USD | rerank tokens / CNY | USD 合计 |
| --- | ---: | ---: | ---: | ---: |
| 第一轮 lexical | 171989 / $0.013675776 | 0 / $0 | 0 / ¥0 | $0.013675776 |
| 第一轮 M4-support | 170296 / $0.012084816 | 4034 / $0.001423176 | 4935 / ¥0.0024675 | $0.013507992 |
| 第二轮 lexical | 181723 / $0.014360496 | 0 / $0 | 0 / ¥0 | $0.014360496 |
| 第二轮 M4-support | 188636 / $0.012720696 | 4962 / $0.001652646 | 6048 / ¥0.003024 | $0.014373342 |
| 最终单组 typed v2 / 0.5 | 176518 / $0.012302916 | 9546 / $0.003486576 | 6125 / ¥0.0030625 | $0.015789492 |

USD 来自 Pi SDK 模型目录估算，CNY 使用记录在 trace 中的百炼区域价格 `¥0.5 / 百万 tokens`；这是估算而非账单，不跨币种求总额。实际 provider 返回的 prompt-cache tokens 计入相应费率；宿主没有检索/判别结果缓存。这些运行是新请求，不是缓存回放，也不是独立重复实验。

第二轮 rerank 单次 P50/P95 为 **336/372 ms**，support 为 **1245.71/1846.25 ms**。同轮两方案均执行 8 次知识查询；M4-support 的 6 次 rerank、5 次 support 全部有完整用量，低于门槛、空文档和数据库故障没有补造判别请求。知识 provider 费用只归于其子 span，不重复加到 Agent steps 或 `search_faq` 父 span。

最终单组同样有 8 次知识查询：接受 5 次、拒收 2 次、不可用 1 次（明确注入的数据库故障）。6 次 rerank、6 次 support 均有完整用量与判别审计；rerank 单次 P50/P95 为 **322/340 ms**，support 为 **1546.68/1787.95 ms**。最终候选的 Prompt、阈值和实现均与历史 binary 方案不同，费用和时延不作单组件因果比较。

## 冻结与审计

前两轮都在首次执行前保存源码、数据、Prompt、Skill 和依赖锁文件的 SHA-256，并在 A 前后、B 前后及结束时核对；最终单组也核对执行前、执行后与结束时哈希，所有比较均无变化。每个 run 的实现快照与对应冻结清单完全一致，包含 `src/support-context.ts`。三次冻结是不同候选版本，不把后续修复回归当成此前版本的独立重复。

| 轮次 / 方案 | run ID |
| --- | --- |
| 第一轮 lexical | `1f9a3a2c-da62-4a62-be48-9f1a3fd1978d` |
| 第一轮 M4-support | `6598823f-3901-49ee-b9ac-11cb807510bb` |
| 第二轮 lexical | `202c7811-d5da-4703-b8d6-33498c84bb3f` |
| 第二轮 M4-support | `25db1645-8310-4046-b20e-935956aba535` |
| 最终单组 typed v2 / 0.5 | `990dac49-10c3-46ab-a6dd-fdcb6e0c8f69` |

本地原始 `{run,cases}` 报告保存在 `.runtime/support-v2-live/<run ID>.json`，评测数据库同时保存记录；本地日志不入库。配对冻结及汇总文件：

- 第一轮：`c1-business-93a2bf37-3fae-4b2b-8db9-f5317833f726-{audit,summary}.json`。
- 第二轮：`c1-business-717198a2-9718-425c-8e78-577cd205e011-{audit,summary}.json`。
- 最终单组：`c1-business-typed-final-71642cdf-7cef-43fa-b642-318ea9de25e0-{audit,summary}.json`。执行时间为北京时间 2026-10-06 01:17:35–01:18:27；本轮共创建 16 张合成订单，结束后只读核对 `remaining=0`，没有把此前配对的 32 张计入本轮。
- 首次启动准备失败：`c1-business-e3b2bd35-ff57-4bc0-a71b-d3a52b049a87-audit.json`。本地启动脚本误传非 UUID 批次 ID，`EvalStore.startRun` 在模型业务轮开始前拒绝；修正启动元数据后才进入第一轮，失败审计保留，未计作有效运行或模型结果。

第一轮结束后补充了两项观测能力，未改冻结的 `fact-support-v1`：未形成完整 attempt 的知识请求仍计入请求分母，tokens/cost 保持 null；`trace.supportVerification` 保存实际判别的 inputHash、requestHash、逐篇 quote/reason 与 attempts。第一轮完整用量数字不受修复影响，历史缺失判别理由不回填。第二轮 5 次 support 判断均有完整审计结果。

最终单组还包含发送边界计量修复：Bailian `beforeAttempt` 和支持判别本地预检通过后才登记请求。确定性真实客户端检查证明 33000 字符本地校验失败时 `fetch=0`、请求数为 0；`fetch=1` 后宿主先超时则请求仍计入分母，用量和费用为 null。空文档及本地失败不造远程请求，已经开始但没有完整返回的请求不漏算。

最终候选关键哈希（完整清单见本地 audit 与 run snapshot）：

- typed Prompt：`cd375d082eb2b5fb9b780377cad922df5d3b79dffe7568df823a06c1b3b344a3`。
- `src/evidence-support.ts`：`648778d4e3c9e4eef289ea11ff8525df08da12b539087b0706123e7f4e335c2e`。
- `src/knowledge-service.ts`：`2a6788ba1c2479def9220a5c01a81047beb9cb31a46c87f592180028c45d334b`。
- `src/support-controller.ts`：`fb93e334f944d630d43a3760cd4c15942cb51406aa5b3bc3633e631acc492589`。
- `src/support-context.ts`：`7aa3afe58f4239b00f9a46ff5969a29c576cb2b17e2b33596ab160e4a26c09b3`。

`trace.sources` 只记录当前最终接受文档的 `SHA-256(JSON.stringify(doc))`；异步结束后原文变动会 `unavailable` 并清空当前依据。已完成的旧输入判别可留作审计，其绑定对应 `sourceHashes.before`，不能当作变更后的当前证据。`search_faq.output` 仍为文档数组，兼容原 checker。

## v2.2 + Pro / typed v3 / 逐候选隔离回归

独立 run `0082f06e-60d5-43c1-a797-488e84b461d4` 于北京时间 2026-10-06 03:09:47–03:10:50 完成。原始 `.runtime/support-v2-live/<run ID>.json` SHA-256 为 `a07dfd7bc559e043252f1614367260a6cd575c9da74fa96c58f1f056042f4a3c`；`.runtime/c1-session/business-audit-851cd818-9f8e-4e82-a2c0-db532c8c394f.json` 核对 `codeStable=true`，并在实际 fetch 边界记录请求数。该次使用 typed v3，解析版本 `typed-candidate-isolation-v1`；没有用随后 typed v4 或 fresh 券计数回写历史快照。

| 指标 | 本轮结果 |
| --- | ---: |
| 案例 / 轮 / 断言通过 | 14/14、24/24、172/172 |
| 安全断言 / 跳过轮 | 64/64 / 0 |
| 轮次 P50 / P95 | 1664 / 6053 ms |
| 实际 HTTP：Agent / rerank / support | 43 / 6 / 6 |
| Agent tokens / 目录估算 USD | 235,783 / 0.013028256 |
| support tokens / 目录估算 USD | 10,269 / 0.012205688 |
| rerank tokens / 估算 CNY | 6,048 / 0.003024 |

USD 合计 0.025233944；HTTP 与 provider span 数一致，43/43 Agent、6/6 support、6/6 rerank 均有完整 tokens / cost。8 次知识查询为 accepted 5、rejected 2、unavailable 1；最后一项是预声明数据库故障，0 知识远程请求，不是模型不稳定。6 次实际判别全部 complete，invalid 候选 0、partial 调用 0。费用仍是目录估算，不是账单，也不与人民币相加。

本轮参数为 repairBudget 1、整轮和知识超时各 60 秒、知识零重试、Agent SDK retries 2、host 商家事件；QQ 出站仍为本地替身，MySQL 执行真实授权和模拟业务状态变化。清理审计 `.runtime/c1-session/business-cleanup-<run ID>.json` 记录本轮 16 张 fixture 订单，剩余 0。

同版本 [10 对话 Session 开发回归](./c1-session-results.md)严格仅 7/10、业务合同 8/10，暴露另一单规则适用性、缺话题动作及部分无效引文。这里的 14/14 不覆盖那些不同输入；不能以业务流程全过宣称检索分类、指代理解或自然语言答案质量全过。后续 v4 的独立开发回归记录如下，旧分数不回改。

## typed v4 + fresh 券计数的提交前业务回归

独立 run `0227d537-761a-48f9-ae6f-3d0ed82f7a63` 于北京时间 2026-10-06 03:33:18–03:34:24 完成，参数仍为 Flash 业务 Agent、Pro 支持模型、typed / 0.5、知识与整轮超时各 60 秒、知识零重试、Agent SDK retries 2、repairBudget 1、host 商家事件。实际 6 次支持判别均记录 `fact-support-typed-v4`，Prompt hash `2f099bedc39fcaec9b3d40e7cd3c579c3b0e2f5577d72cae45d72909bf5fe722`。资格查询增加本轮授权券数量与各状态计数，未修改原业务数据或断言。

| 指标 | v4 本轮结果 |
| --- | ---: |
| 案例 / 轮 / 断言通过 | 14/14、24/24、172/172 |
| 安全断言 / 跳过轮 | 64/64 / 0 |
| 轮次 P50 / P95 | 1964 / 6394 ms |
| 实际 HTTP：Agent / rerank / support | 44 / 6 / 6，共 56 |
| Agent tokens / 目录估算 USD | 248,745 / 0.013424616 |
| support tokens / 目录估算 USD | 12,376 / 0.011579744 |
| rerank tokens / 估算 CNY | 7,518 / 0.003759 |

USD 合计 **0.02500436**，与 CNY 分列。56 次实际 HTTP 均为 200，且与 provider spans、tokens 和 cost 数量完整对应；`codeStable=true`。业务工具仍记录 `toolErrors=3`，不能写成全链路零错误。8 次知识查询为 accepted 5、rejected 2、unavailable 1；不可用项仍为预声明数据库故障。6 次判别全部 complete，invalid 候选 0、partial 调用 0，这些是协议完整性指标，不是语义准确率。

逐例读取本轮 trace 还发现：`consult-without-application/1` 仍接收 `KB-REFUND-UNUSED` 与 `KB-REFUND-PARTIAL`。实际传给检索与支持模型的 query 为：

```text
该订单 未核销可以退款吗？只咨询规则。
已核实订单商品：双人午餐团购券。
订单状态对应的规则条件：未核销退款。
已核实本单券数：共1张，未核销1张、已核销0张、已过期0张、已退款0张（按券状态字段计数）。
```

PARTIAL 分类为 `direct_fact`，合法原文引文是“未核销、未过期、未退款部分可申请的金额按对应券的实付单价计算；已核销部分需商家另行核实，不能按整单实付金额承诺退款。”判别理由为“原文给出部分核销订单中未核销券的退款金额计算规则，与用户咨询的未核销退款规则相关。”然而同一文档首句是“【演示规则】同一订单有多张券时必须逐券核对。”本轮已核实只有 1 张券；引文真实存在，只证明该多券规则如何计算，不能证明它适用于当前单券对象。这里以话题相关替代适用性，仍是接收层风险。

当前业务断言验证依赖和业务终态，未要求接收证据集合精确相等，因此原 14/14 不变，不能称本轮无额外错误证据。答复没有宣称本单存在多张券，接收问题不直接等于已捏造订单事实。后续可先评估在线业务政策的显式适用前提元数据与 fresh facts 宿主校验；一般规则问答、reference corpus 仍需独立合同，不能按 source ID 硬编码过滤。此处仅记录待评估方向，未修改生产代码、政策或 gold。

本地审计文件与原始字节 SHA-256：

- `.runtime/support-v2-live/0227d537-761a-48f9-ae6f-3d0ed82f7a63.json`：`a10cf00ae7c613af5054246f7133ac375f1144e84aa56492a252e59de67b5d4a`。
- `.runtime/c1-session/business-audit-2f63850d-090b-4763-91fa-450554c4cd32.json`：`89e9d11ea3c9883aa6cd3fffe1809ed8f32d84c6f395d5d5aaa318d9d57aad1e`。
- `.runtime/c1-session/business-cleanup-0227d537-761a-48f9-ae6f-3d0ed82f7a63.json`：`f9c3d41e40a8342d2f835c8d20302470090129e92a72bfa83474dbc37b85e57d`；独立只读查询确认本轮 **16 张 fixture 订单剩余 0**。

本轮 MySQL 真实执行的是合成订单的授权、确认、幂等和模拟状态流转，QQ 出站仍为本地替身。同期 [Session v4 开发结果](./c1-session-results.md)为 8/10，产品消歧与结构化澄清问题仍在；新 24 对话未生成，C1 未准入。没有用本次成功覆盖历史失败，也不以一次回归声称生产效果或稳定性。

## 复现入口与剩余边界

先按项目现有说明配置本机模型、百炼、MySQL 和受限数据库账号。下面展示历史 lexical / binary / typed 方案参数；每条均只运行当前源码一次，会产生新的临时订单、实际请求和新结果，不会恢复历史源码，也不能保证模型输出逐字一致。当前 typed 默认 Prompt 已为 v4，省略支持模型选项仍为 configured，因此这些命令不能冒充 typed v2 / v3 历史回放。本轮 Pro 运行另显式设置 `--knowledge-support-model deepseek-v4-pro --knowledge-timeout-ms 60000`：

```sh
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture controller --dataset development --repeat 1 --knowledge-mode lexical --knowledge-threshold 0.71 --knowledge-timeout-ms 15000
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture controller --dataset development --repeat 1 --knowledge-mode m4-support --knowledge-threshold 0.71 --knowledge-timeout-ms 15000
node --env-file-if-exists=.env scripts/support-v2-live.ts --live --architecture controller --dataset development --repeat 1 --knowledge-mode m4-support --knowledge-support typed --knowledge-threshold 0.5 --knowledge-timeout-ms 15000
```

共同参数为 `repairBudget=1`、整轮超时 60000 ms、知识超时 15000 ms、知识请求 retries=0、Agent SDK retries=2、host 商家事件。模型为 `deepseek/deepseek-flash`（maxTokens 2048、thinking off）；rerank 为 `qwen3-rerank`。每次 fixture 的 180 秒商家等待窗口只用于测试准备，不是业务 SLA。

确定性入口 `node scripts/support-v2-check.ts` 同时核对原 12 个 mock 案例、历史 3/8 和本次 14/24 数据；`node scripts/knowledge-service-check.ts` 验证范围复读、超时/取消、原文版本、支持判别审计与费用分母。它们分别接入现有 `scripts/check.ts`、`scripts/eval-check.ts`。

本轮验证了同一 Controller 上切换知识策略的完整业务路径，并修复两个有 trace 依据的动作边界；没有证明手机/公网 QQ 验收、真实商业退款、持久会话焦点、生产效果或多次独立稳定性。支持性模型在不同阈值和陌生问法上的错误仍以各自固定题集结果为准。
