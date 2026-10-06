# 百炼千问候选与模型选型建议

调研日期：2026-10-06。状态：普通百炼候选接入、工程验证与首个真实判别组件对照已完成；千问未进入Session候选、未切换默认配置。

结论：有必要用不同模型家族核对收益，当前不建议替换DeepSeek。本轮同typed v7新题中，Pro接收集合12/12正确、负例0误收；Qwen接收集合10/12、负例3误收，延迟也更高。Qwen保留为可配置候选，按本轮停止条件不推进Session对照。主Agent尚无千问实际对照，不能从组件结果推导其多轮能力。旧话题选择、漏动作属于主Agent；原文虽真实但未覆盖渠道、类别或限定条件仍被接收，属于证据判别与宿主输入合同。身份、范围、资金、确认和幂等仍由宿主执行，不随模型开关移除。

## P0与验证安排

- **业务约束：** 无资料要说明未知，有条件的规则须保留条件；多轮指代和办理动作必须按当前原文及fresh订单，不能因换成更强模型而用历史答案代替授权。
- **面试追问：** 如何分辨模型问题和Harness问题？为何单独选择Agent与判别模型？怎样用任务指标而不是榜单决定效果、延迟与费用？
- **实现与复用：** 继续使用Pi provider注册、工具循环和已有评测；个人实现为受限模型配置、角色独立凭据、请求兼容、费用与冻结快照。普通百炼按量API与Token Plan区分，不修改Pi核心。
- **验收证据：** 同源码、同Prompt、同可信输入和预算，分别比较无答案误收、有答案误拒、来源覆盖、首次动作正确、修复/澄清、全轮业务完成、P50/P95、真实HTTP与每成功轮费用。新题包含正负控制，完整分母及未执行项保留；开发集用于诊断，不能重跑曝光题冒称独立验收。
- **预算与停止：** 初始调研与接入为0远程请求，随后另冻结12输入/两臂单次合同并完成24次判别请求，结果见下文。本轮预算已收尾，不启动第三模型或重跑同题追分；未证明净收益，保留DeepSeek与原默认。

## 候选与费用

### 本轮接入合同（2026-10-06）

本轮只交付候选接入和工程验证，预算为 **0 远程模型、QQ 与数据库请求**；不切换默认模型或候选准入状态。业务仍执行原有身份、fresh 范围、确认及幂等检查。面试追问聚焦“为何模型按角色选择、如何防止错误凭据路由，以及多币种费用为何不能直接相加”。

复用 Pi 的 provider 注册、OpenAI 兼容适配与原生循环；项目实现有界的模型选择、普通百炼地址规范化、角色选择快照、非思考请求以及人民币估算。先接入固定 `qwen3.7-plus-2026-05-26`，不增加自动模型路由或故障时跨模型回退。`configured` 保持全局环境配置的既有语义；两个角色各自可以显式固定模型，不因主 Agent 选择而暗改判别模型。百炼固定选择只使用 `DASHSCOPE_API_KEY`，不能把 DeepSeek 的 `MODEL_API_KEY` 发送给百炼。

验收使用原生 SDK 的本地替代 HTTP：核对实际地址、模型、凭据、非思考参数、动作与无工具判别请求、取消、usage 和币种；已有配置与历史记录兼容。未知费用保持未知，Pi USD 费用不能用百炼 CNY 原价填充，也不能把 Token Plan 的 0 当普通调用免费。工程通过后执行全量 validate、审阅差异、提交推送即结束本片；真实模型对照另冻结新题、源码、价格和单次预算。

官方目前将Qwen3.7-Plus定位为能力与成本均衡的通用模型。首轮选择固定`qwen3.7-plus-2026-05-26`快照，减少别名升级带来的漂移；该候选由此提出，随后判别组件结果见下文，主Agent多轮质量仍未测试。[文本模型选择](https://help.aliyun.com/zh/model-studio/text-generation-model/)。

以下为官方模型信息页的华北2北京原价，单位为元/百万Token，普通实时调用、不含缓存折扣和优惠；Plus按输入≤256K档，具体授权、地域及执行时价格仍需核对。

| 候选 | 输入 / 输出 | 项目用途建议 |
| --- | --- | --- |
| Qwen3.7-Plus | 2 / 8 | 首个质量对照，独立测试判别和动作能力 |
| Qwen3.8-Flash | 0.8 / 2.7 | Plus形成收益后，再研究成本候选 |
| Qwen3.8-Max | 12 / 36 | 前两者仍有明确语义瓶颈时再做小量能力上限实验 |

价格来源：[Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)、[Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)。不能据单价推出整轮更便宜；多次动作修复、长输入、思考和误拒都会改变每成功轮成本。Pi当前DeepSeek估算为USD，百炼为CNY，保持分列；需要总额比较时另冻结汇率和价格版本。

## 接入方式与边界

本机Pi 1.0.0目录包含Qwen Token Plan专属provider，不能用其价格0或专属endpoint冒充普通百炼免费按量服务。`createModelRuntime`使用`modelsPath:null`；本轮使用扩展注册普通百炼候选，不加载外部模型文件，不改Pi核心。

已使用`runtime.registerProvider`注册固定百炼模型，通过OpenAI兼容接口调用，key只在进程中绑定到相应provider。接受已审阅的北京原点、`/api/v1`和`/compatible-mode/v1`后规范化；拒绝其他地域、路径、URL凭据、端口、查询和片段。生成模型base URL需与key地域一致；真实账号地域仍待首次联调核对。[官方兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)。

主Agent与证据判别分别选模型。`agentModel`和`knowledgeSupportModel`可独立固定；fixed Pro不再要求主provider为DeepSeek，但不能借用其他provider凭据。`scripts/support-v2-live.ts`逐variant使用实际Agent选择并记录endpoint/价格，知识服务记录判别settings。判别对照时主Agent保持Flash，主Agent对照时判别保持Pro，检索模式与类别参数保持同版。

首轮关闭思考，判别请求显式`enable_thinking:false`、无工具、JSON输出、temperature=0/maxRetries=0。Agent继续Pi原生循环与原修复预算，hook识别Qwen思考字段。百炼官方规定思考模式不能同时使用required/object形式的tool_choice；Qwen的required也不能当稳定工具调用保证。[Function Calling合同](https://help.aliyun.com/zh/model-studio/qwen-function-calling)。是否最终替换主Agent由真实业务对照决定。

Pi的cost字段原生假设USD，本轮仅在原生内存中使用NaN表示未知；项目序列化记录USD null及审阅CNY价格合同。工程检查直接核对原生SSE消息的NaN，防止仅在展示层隐藏零价。CNY按北京低档全价保守估算，缓存不享折扣；超过256000输入Token或用量缺失时未知，不能当账单或已计入全部请求。新百炼证据重建同时绑定固定模型、北京endpoint、币种、价格版本/单价及实际tokens，拒绝重算哈希后的虚构USD零价或地域变更。

## 本轮工程结果与复现

- `node scripts/model-selection-check.ts`：默认与显式配置兼容、角色凭据隔离、北京地址正负控、原生provider注册及价格范围检查通过。
- `node scripts/bailian-model-wire-check.ts`：7次替代HTTP，原生Pi SSE、判别JSON、named动作/auto续轮、fresh订单读取、取消与无重试失败通过；直接证明原生USD NaN与项目USD null/CNY估算分离。两项费用篡改及6项重算hash后的价格/地域/endpoint篡改均拒绝；缺失请求仍在费用分母。固定回复由fixture提供，不能证明模型理解或自然语言质量。
- `node scripts/knowledge-service-check.ts`：实际lazy加载拒绝另一provider密钥，0支持模型HTTP；真实verifier的注入completion验证CNY重排与判别合计，缺usage保持未知。
- `node scripts/experiment-check.ts`：严格角色参数、固定Flash/Pro-Qwen单变量预设、原接口边界及无凭据dry-run通过。`npm run validate`最终退出0，包含原业务/QQ替代与工作台回归；本轮0远程模型、数据库与QQ请求。

独立审阅先发现lazy调用改写全局provider绕过凭据隔离、Bailian价格合同未强绑定，以及缺usage请求从CNY费用分母消失；修复与对应负控完成后再全量验证。保留这些失败原因用于说明“OpenAI兼容”不等于可直接换模型；本轮个人贡献是角色与宿主接线、可信价格和评测完整性，工具循环/SSE仍来自Pi。

源码入口：[模型选择与费用](../src/model-selection.ts)、[Pi注册与凭据](../src/agent.ts)、[判别请求与证据绑定](../src/evidence-support.ts)、[知识服务](../src/knowledge-service.ts)、[原生wire检查](../scripts/bailian-model-wire-check.ts)。工作台前端跨模式选项清理和主Agent CNY汇总展示仍待Kimi适配，CLI/JSON和provider span已可核对。本片按0远程预算收尾；下一片先冻结新的12输入、两臂判别对照及总请求/费用上限，再运行一次。没有真实效果证据时，不宣布优于DeepSeek或切换线上配置。

## 真实判别对照合同（2026-10-06，执行前冻结，已单次执行）

- **业务约束：** 针对支付渠道、审批主体、适用商品/条件及具体事实缺失的新合成问法，证据必须逐篇覆盖当前诉求；一般说明不能代替具体渠道承诺，其他主体/商品信息不能补齐目标原文。只读组件实验不产生退款批准，不改在线业务资料。
- **面试追问：** 为什么采用独立判别模型？在候选原文不变、最优现成提示词不变时，换模型能否降低误接收，而不是靠拒绝所有证据换取安全分？怎样比较不同币种费用、错误率与延迟？
- **个人实现与复用：** 复用原生Pi完整请求、现有typed v7判别和证据重建；新增单次对照执行与真实HTTP账本。选择v7而不是再调v6，因为v7已有来源适用性失败证据，比较当前最强现成判别方案更能区分模型收益。本文先前通用预设继续使用v6，两者用途与成绩分列。
- **验收及演示：** 新固定12输入、两臂DeepSeek Pro / Qwen固定快照、同v7原文/输入/超时/2048输出/temperature0/retry0；题集和gold由独立子任务编写并在执行前审阅、冻结。按输入交替两臂顺序，报告完整24分母、逐候选误收误拒/分类错误/无效缺失、P50/P95、成功输入费用和真实请求。组件通过不代表Session/C1准入；新题由已知失败类型设计，明确非盲测，不推广生产效果。
- **预算与停止：** 单次对照最多24个真实support HTTP，Agent/rerank/SQL/QQ均0；DeepSeek USD上限0.08，Qwen CNY上限0.20，整体10分钟、每请求60秒。按实际币种分别计数，金额是请求前软停止，单个已发请求可能超限；未知用量/费用、重试、身份/endpoint/冻结快照不符后停止后续发送，完整保留未执行。manifest只允许一次执行；不启第三模型、不重跑本题追分。只有完整执行、费用/完整性可信、负例0误收且无新增正例误拒并提高精确集合正确数时，才推进Qwen到新Session候选对照；不满足则归档原因、保留现有默认，回到可定位的业务缺口。

执行前原生wire检查发现普通百炼provider默认被Pi推断成developer角色；本轮显式固定system角色。输出字段也显式注册：DeepSeek原接口使用max_tokens，Qwen使用max_completion_tokens，均设置2048并关闭思考。百炼最新Chat API推荐max_completion_tokens，并明确支持Qwen3.5-Plus及之后模型；旧max_tokens即将废弃。实际输出计数可能有最多10 Token的误差，所以费用预算仍按真实usage执行软停止。[官方参数合同](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。两臂业务文本/非思考/输出预算相同，provider字段差异进入manifest，不能为让检查通过而暗改实际wire。

## 单次真实结果与选型决定

运行`bd85183b-a59c-4c09-a0c6-dcc38f14bfef`于2026-10-06完成，82.185秒。两臂各12次真实support HTTP，全部24行/48候选执行；Agent、rerank、SQL、QQ及业务写入均0。原始SSE用量与Pi attempts逐条一致，模型身份、原生请求、Prompt、数据、源码及实际依赖前后稳定；完整性、记录、执行、用量四项均通过。JSON格式、引文无效或缺失均0，SDK重试0。CLI退出0表示执行器完成，不能当作24题业务全通过。

| 指标 | DeepSeek Pro | Qwen3.7-Plus固定快照 |
| --- | ---: | ---: |
| 完整计划 / 实际输入 | 12 / 12 | 12 / 12 |
| 每输入精确接收集合正确 | 12/12 | 10/12 |
| 每输入分类与接收同时正确 | 9/12 | 9/12 |
| 逐候选分类与接收同时正确 | 20/24 | 19/24 |
| 负例误接收 | 0/12 | 3/12 |
| 正例接受 / 新增误拒 | 12/12 / 0 | 12/12 / 0 |
| 全无答案输入完整正确拒收 | 4/4 | 2/4 |
| 无效 / 缺失 / 未执行 | 0 / 0 / 0 | 0 / 0 / 0 |
| 真实HTTP / 总tokens | 12 / 26,878 | 12 / 27,036 |
| P50 / P95单请求 | 2,298 / 3,128 ms | 4,427 / 4,958 ms |
| 目录费率估算总费用 | USD 0.013868976 | CNY 0.069084 |
| 每次实际HTTP估算费用 | USD 0.001155748 | CNY 0.005757 |
| 每个完整分类正确输入估算费用 | USD 0.001540997 | CNY 0.007676 |

费用由真实usage按冻结费率估算，不是账单；百炼未计缓存折扣，USD/CNY不折算或相加。缓存、网络和provider差异未独立控制，一次12输入不能证明稳定延迟或生产费用优势。“每个完整分类正确输入”以9为分母；不能用它代替整个客服会话成功成本。

失败及区分：

- 千问`model-004`把两篇“未列平台退款批准角色”都标为`boundary_answer`并接收。用户问谁签发批准，且明确不是预约能否取消；模型将实际主体问题改解释为资料覆盖问题。`model-010`同样把“未收录过敏原”当作配料清单的可接收回答，用户已明确缺失声明不能代替清单。3条误收的引文均为真实原文，说明精确引文校验仍不能替代语义覆盖判断。
- Pro的`model-001/MODEL-D002`及`model-008/MODEL-D015`把其他渠道、缺少关键条件的规则归为`unrelated`，gold为`limitation_only`；两条均正确拒收。两家在`model-012`均把带核实对象的资料缺失回答归为`direct_fact`，gold为`boundary_answer`；两条均正确接收。保留严格分类错误及原gold，不把这些类别差异等同于误收或误拒，也不倒改分数。
- 千问的主要问题仍是“未知事实”与“明确问资料边界”的区分，Pro在这次接收决定上全部正确。不能把此次0误收覆盖先前v7环境诊断中的3误收；题集与候选不同，旧失败继续保留。

决定：`nextSessionCandidateEligible=false`，不采用千问替换当前判别模型，也不扩大为主Agent/Session付费对照。普通百炼接入和独立角色配置保留为后续明确假设的实验入口；默认atomic + lexical、memory/id与DeepSeek均不切换。这不是否定千问一般能力，而是在本项目现有v7合同、非思考配置及本次输入下未证明收益。下一步回到已实现的有限只读范围修复及待完成的C1/O4/O5业务缺口，另定Session合同，不以同题重跑或继续换模型追分。

## 冻结证据与复核入口

- 执行前实现、gold、合同与manifest已提交推送`b8e8b4b`。数据：[12输入](../data/c1-model-support-comparison.json)，SHA-256 `e46afaaf46234d57205611c3de8ead68023595b7bb575ce8a45a7e0bcd1d3549`；[manifest](../data/c1-model-support-comparison-manifest.json)的内容hash为`707e3a0ddda8a7ab2207c82551fd4961dcb191b1efc720322b39dc962d265106`，冻结50个文件及实际依赖。
- [公开结果摘要](../data/c1-model-support-comparison-results.json)保留全部合成输入的真实typed输出、逐候选分数、用量、身份与请求摘要；不含凭据或真实客户数据。本地原始artifact为`.runtime/c1-model-support-comparison/bd85183b-a59c-4c09-a0c6-dcc38f14bfef.json`，文件SHA-256 `12474f74a281a73a8dccd6193f5fb61cc2fdc56ce883dc341b23896f16f14022`。完整原生请求body和SSE摘要留在忽略目录；公开摘要不能单独重建HTTP完整body，不能冒称其具备完整原始审计能力。
- 独立审阅在执行前发现预算到线仍创建零发送attempt、空reported模型未拒绝、只改verified决策而保持raw输出可影响评分三个缺口；已修复并加入负控，最终纯检查/类型检查及完整`npm run validate`通过后才冻结。执行后按raw typed输出、gold、request用量及费用重建，同原summary一致。
- `node scripts/c1-model-support-comparison.ts --check`及`npm run validate`均为工程回归，0远程/DB/QQ。`--freeze/--inspect`检查实际环境配置但不请求模型；`--live`需要匹配manifest且同manifest本地attempt锁只允许一次。本轮已经执行完毕，不再运行该命令。本文结果更新发生在执行结束后，故当前本文hash与执行前manifest不同；历史实验绑定`b8e8b4b`，不能在当前文件上重新冻结去追认旧成绩。

新增脚本只负责这次有界对照，复用Pi原生完整请求和现有判别/验证；没有建立新的transport框架或修改Pi核心。可讲述的个人贡献是受控模型选择、provider兼容、真实HTTP预算、币种与未知用量合同、预冻结题集和错误收尾；没有真实商业交易，也未验证千问主Agent多轮行为。
