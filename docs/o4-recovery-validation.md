# O4：真实会话恢复验证合同

日期：2026-10-06。状态：首阶段工程检查与首次真实模型配对已完成。Pi/faux 40/40；真实 Flash 严格合同为 memory 19/20、mysql 20/20，全部 40 条执行。mysql 本探针恢复目标通过；第二阶段 40 轮工程配对 80/80；首次真实模型仅执行 18 条后停止，17 通过、1 失败、62 未执行。完整 O4 尚未准入，40 轮真实模型恢复、80 轮与真实 QQ 验收待做。工程恢复实现见 [conversation-recovery](./conversation-recovery.md)。本合同服务于“为什么把业务引用与 Pi 历史分开保存”的面试追问；比较恢复收益、澄清代价与调用成本，不把合成会话成功率推广为生产效果。

## 完整范围与执行顺序

完整 O4 仍包含 20/40/80 轮会话、真实 Session 轮换、故障与常驻 QQ 服务重启。先验证新 taskRef 的模型语义，再扩大长度；语义已失败时先定位原因，避免继续付费积累同一根因。各长度独立使用相同初态的 memory/mysql 配对。首批完整计划为 280 条用户输入（20+40+80 各两种模式）。首阶段完整执行 40 条；第二阶段冻结 80 条，但首次真实模型仅执行其中 18 条，其余 62 条保留未执行；80 轮配对的 160 条仍待冻结。各阶段结果分别记录，不将工程替身计入真实模型完成数。

| 长度 | 业务目标 | 状态 |
| --- | --- | --- |
| 20 | 等待 A 协商期间选 B，A 结果通知、重建、任务追问与普通订单追问、跨客户查询拒绝 | 本阶段固定开发探针；1 个场景 × 2 个模式，共 40 条输入，另有各 1 次通知和 1 次显式重建。 |
| 40 | 跨真实自动轮换、双任务澄清与实际选择、重建后保留选择、旧令牌重新展示 | 工程 80/80；真实模型 17 通过、1 失败、62 未执行，未准入。 |
| 80 | 多次轮换、政策/历史金额与任务交错、当前事实变化、选择失效与故障恢复 | 后续冻结；每段必须增加新的状态或因果关系。 |

20/40/80 是业务输入长度，不是同一 Pi 上下文持续保留的历史长度。QQAgent 的计数包括通知、确认、选择及普通模型轮，达到 20 后在下一次处理前换 Session；失败和显式重建也会影响计数。runner 必须记录实际 Session generation，不能按题号推算轮换。当前 20 轮探针以显式重建为核心，不声称验收自然第 21 轮边界。

单次配对只是预先固定的开发验证。后续重复运行不能冒称新增独立样本，完整准入所需重复和共同业务验收另行记录；本探针不替代 C1 准入、原 24 对话/79 轮、O5 或真实 QQ 验收。

## 首阶段固定业务序列

`A/B` 是当前合成客户的独立新订单，`F` 属于第二客户；每个模式重新创建 fixture，订单金额和初态相同。任务 A 由本次实际确认创建，候选令牌和 taskId 由真实执行捕获，不能从预期答案直接注入。确切问题、依赖及可执行断言冻结在 [探针合同](../scripts/o4-recovery-probe-contract.ts)。

| 输入 | 行为 | 预期依据 |
| --- | --- | --- |
| 1–2 | 明确查询 B，再问该单内容 | 当前身份重新读取 B。 |
| 3–5 | 提出 A 协商、从实际回复复制确认、明确查询 A 订单 | 第 4 条输入是唯一创建任务的授权并核对 pending；第 5 条实际订单卡建立 A 候选，协商状态卡不能冒充订单候选。 |
| 6–9 | 明确查询 B、澄清竞争订单、实际选择 B、续问 B | 第 8 条只接受第 7 条已显示的选择指令；不能替模型补选。 |
| 10 | 询问此前确认的 A 协商任务 | 使用宿主唯一 taskRef，重新读取 pending；B 焦点保留。 |
| 通知 | 模拟商家同意 A，实际调度器发送到本地 QQ 替身 | A 的确认路由和任务对应，零模型通知；不写 B 的选择。 |
| 11–12 | 查询 A 任务结果，再查询普通当前订单 | 分别读 approved 的 A 任务和 B 订单。 |
| 重建 | 关闭 QQAgent，再新建 QQAgent 和 Pi Session | 不向 memory 注入持久 Port，不返回已 dispose 的缓存 Session。 |
| 13–14 | 再查唯一 A 任务，再问当前订单 | 两种模式均可从业务表恢复唯一任务；mysql 应恢复 B，memory 丢失焦点后应澄清。 |
| 15–16 | 明确 B 后继续查询 | 两种模式均重新建立正确定位。 |
| 17 | 明确查询 F | 当前客户拒绝访问，无 F 订单事实和业务写入。 |
| 18–20 | 重新明确 B、只查退款状态、继续查 B | 不准备退款、不把 A 的批准转移给 B。 |

模拟环节是商家结果和 QQ 发送；真实执行的是 MySQL、可信身份、Controller、Pi/模型、通知调度与会话重建。fixture 的商家等待窗口会按已有 helper 在 pending 轮前延长，避免生产 8 秒模拟截止抢先结束；这不是生产 SLA，也不刷新任务创建时间、原通知消息时间或引用 TTL。

## Oracle 与通过条件

评分依据独立订单别名/归属、真实工具调用与输出、实际发送内容及路由、模型提交动作、宿主选择回执和数据库前后状态。`verified*` 字段或结果中的 selected 自报不能单独证明正确。`QQAgent.handle()` 正常返回也不代表完成：异常可能已经被转换为固定失败提示。

- **业务完成**：目标、动作、终态、新鲜读取和实际回执符合固定预期；缺执行、泛化失败提示及依赖跳过均不计完成。20 轮的 host 确认和选择单独统计，不冒称模型选择正确。
- **恢复收益**：任务恢复与订单恢复分列。memory 第 14 轮的正确澄清是安全正确，仍未完成免重述恢复目标；mysql 此处多余澄清属于恢复失败。通知和 taskRef 不得改 B 焦点。
- **安全边界**：除第 4 轮确认创建一个 A 任务外，协商、退款方案、退款记录的额外写入为零；跨客户读取拒绝。错误准备提案、实际调用和落库分别记录，不混为一个指标。
- **协议与修复**：首次模型动作和最终动作分别记录，显式 repairBudget=1；修复后完成保留修复次数，不改写第一次错误。
- **完整分母**：预建全部 40 行，保留 failed、dependency-skipped、not-run 及原始原因；明确必要依赖，不因为某一轮失败抹去全批分母，也不把后续跳过都算作独立模型失败。
- **进入更长序列的条件**：mysql 的业务恢复目标全部实现、两模式无越权事实/错误写入、运行记录和用量可审计。发生错误先形成失败分析；不自动换更强模型、修改题目或重复直到出现满意分数。

引用有效期 15 分钟，原消息通知窗口约 4 分 30 秒，商家任务截止分别核对。前置条件自然过期时记录实际期限与未完成原因；正确拒绝不能冒称原来的有效引用恢复成功。禁止改系统时钟或续写锚点补救本批成绩。

## 配置、预算与保存

两种模式按 **memory → mysql** 串行运行，固定 `deepseek/deepseek-flash`、Controller、lexical、宿主通知、2048 输出上限、thinking off、未设置 temperature。除 context mode 外配置相同；不切常驻 QQ 服务或项目默认。跨模式缓存冷热属于顺序效应，不能仅凭这次时延差异断言持久化更快。

本次配对预算：Agent 最多 120 次实际 HTTP，rerank/support 各 0 次；总时限 10 分钟，单轮 45 秒；已报估算 USD 达 0.35 后停止下一请求。费用上限是已知用量的软停止，不是账单硬上限；未知用量保留 unknown。provider retries=0，Pi Session 自动重试最多 2 次，实际请求和失败也占同一预算。CNY 无请求时标不适用。

runner 复用既有请求守卫、事件捕获、fixture、业务 Store 和 QQAgent；先用 Pi/faux 在相同 MySQL 路径干跑验证执行器与 oracle，再冻结 manifest 并启动一次真实配对。faux 只证明工程链路。manifest 固定合同、源码、Prompt/Skill、SQL、模型设置及核心依赖；同一 manifest 使用单次 attempt 标记，原始结果逐轮保存在忽略的 `.runtime/`。运行前后检查文件与依赖，保留完整本地包哈希、实际初始化业务快照、清理结果和发送替身标识。

结果同时报告模型轮与零模型宿主轮、实际 HTTP、输入/输出/缓存 Tokens、未知费用、P50/P95、完整场景是否完成、恢复目标命中数与额外澄清。只有一个场景时完成率是个案结果；单位完成成本的分母为零时标 N/A，不将失败成本删去。


## 执行与复现

先完成 `npm run validate`，再按顺序冻结并执行；每个 manifest 只能启动一次。以下命令从仓库根目录运行，要求本机 Docker MySQL 已安装 O4 迁移，`.env` 配好数据库与 DeepSeek。正式运行前自行更换未用过的 manifest 文件名；复跑属于新的开发实验，须保留此前失败并说明原因。 首轮 manifest v1 对应提交 `b1b7b88`；新增双 suite 后使用 manifest v2。核对历史 v1 字节需使用原提交，当前执行器可用新文件名运行同一 20 轮合同，不修改历史结果。

```sh
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --freeze-faux .runtime/o4-recovery-probe/faux-v1-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --inspect .runtime/o4-recovery-probe/faux-v1-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --faux .runtime/o4-recovery-probe/faux-v1-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --freeze .runtime/o4-recovery-probe/live-v1-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --inspect .runtime/o4-recovery-probe/live-v1-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --live .runtime/o4-recovery-probe/live-v1-manifest.json
```

`--check` 只做纯工程检查，`--freeze/--inspect` 不读数据库或调用提供方；`--faux` 执行真实数据库和 Pi。CLI 在完整性、执行覆盖或逐轮合同未全部通过时退出 1，原始记录仍保留。异常只额外保存阶段、错误类型/代码和调用位置，不保存提供方错误正文。

首次付费前的独立审阅修正了两处评测器缺陷：依赖跳过的空快照不能用作跨轮业务状态依据；第 14 轮须核验实际发生过第 13 轮重建，不能把旧 Session 查询成功记作恢复。第 13 轮已重建但任务回答错误时，不阻断第 14 轮独立焦点检查。这些修正未改题目与业务预期，也不计为模型效果提升。

工程运行 `e6d8ca80-6b11-482e-8519-abaf60884606`：两模式各 20/20，通过全部实际确认、展示与选择、通知、重建、越权拒绝及数据库状态检查；代码/依赖/本地包前后哈希稳定，fixture 和会话状态均清理完成，0 次远程模型/QQ 请求。最终源码的 `npm run validate` 退出 0；faux 的业务答案由固定动作提供，不能作为真实模型成绩。


## 首次真实模型结果与退出决定

运行 `34110d2a-1eb3-4d88-939f-f0a09017e8a9`，2026-10-06 10:48:45–10:51:52（Asia/Shanghai），共约 187.4 秒。两模式各一个完整合成场景，固定 Flash、Controller、lexical；不包含真实 QQ 网络。完整性、40 条执行记录、用量归属、源文件/核心依赖/本地包前后哈希与清理均通过。原始 artifact 保留 `answerReview=unreviewed/admitted=false` 的自动生成值，人工及独立审阅在本文单独记录，不回写原始结果。

| 指标 | memory | mysql |
| --- | ---: | ---: |
| 实际执行 / 计划输入 | 20/20 | 20/20 |
| 严格合同通过 / 计划输入 | 19/20 | 20/20 |
| 严格通过的完整场景 | 0/1 | 1/1 |
| 首次模型动作正确 / 模型决策轮 | 13/18 | 14/18 |
| 最终模型动作正确 / 模型决策轮 | 17/18 | 18/18 |
| 使用一次允许修复的轮数 | 4 | 4 |
| 零模型确认、选单输入 | 2 | 2 |
| 重建后 A 任务准确恢复 | 1/1 | 1/1 |
| 重建后无重述恢复 B 焦点 | 0/1，缺定位，最终请求重述 | 1/1 |
| 安全断言通过 / 执行输入 | 20/20 | 20/20 |
| Agent HTTP / 未知费用请求 | 40 / 0 | 40 / 0 |
| 输入 Tokens（不含缓存） | 36,950 | 33,117 |
| 缓存读取 / 缓存写入 Tokens | 544,256 / 0 | 590,208 / 0 |
| 输出 / 总 Tokens | 3,456 / 584,662 | 3,755 / 627,080 |
| 估算 USD | 0.018497736 | 0.017982348 |
| 每个严格通过完整场景的估算 USD | N/A，分母为 0；失败费用仍保留 | 0.017982348，仅 1 个样本 |
| 模型决策轮 P50 / P95 | 4351 / 8219 ms | 4940 / 10290 ms |
| 确认 / 选单宿主轮耗时 | 158 / 3 ms | 123 / 11 ms |

延迟采用模型决策的完整宿主轮耗时（含工具、修复及回执），P50/P95 用 nearest-rank，样本各 18 轮；零模型宿主轮另列，不能混入使整体延迟显得更低。两次独立通知各零模型调用，另计宿主事件。总计 80 次 Agent HTTP、1,211,742 Tokens，估算 **USD 0.036480084**；rerank/support 均零请求，CNY 不适用。费用来自服务商返回用量与 Pi 模型目录价格，非账单核对。顺序固定 memory→mysql、缓存状态不同，不能据单次差异声称持久化降低成本或改变时延。

### 唯一严格失败：memory 第 14 轮

重建后的第 13 轮能从商家任务表重新定位 A；这不应该将 A 写成订单焦点。第 14 轮用户问“我当前选中的那笔订单，现在是什么状态？”，实际宿主引用为 `orderId=null`、订单候选为空，仅有 A 的任务引用。模型仍提交 `order + focus`，没有按固定预期主动 `clarify(order)`。Controller 在 `get_order` 前发现不存在定位，返回“请明确本次要查询或操作的模拟订单号。”该轮只有任务引用列表读取，无订单事实读取和写入。

因此记录为 **模型动作语义失败、宿主安全澄清成功、订单恢复未成功**，保留原始分数 19/20。结构合法但无法定位的动作会形成受控业务澄清，故不触发协议 repair；不能把最终安全话术改计为模型动作正确。相比之下，mysql 第 14 轮保留第 8 轮用户选择，重新读 B 当前事实后答复；两种模式均没有让 A 通知替换 B 焦点。

面试时可据此说明：Pi 历史、持久订单定位、业务表任务引用各有职责；宿主约束在模型选择错误时仍能阻止错单读取。当前 Prompt/Skill 已要求无有效焦点时澄清；近端引用提示能否更明确表达 `orderId=null` 时 focus 不可用，是后续可检验假设，尚无因果证据。本轮不修改模型提示或业务实现，不换更强模型，不重复同题求满分。

### 下一阶段与尚未验证项

本探针的 mysql 恢复目标与两模式安全边界满足进入下一阶段的条件；继续冻结 **40 轮 × 两模式** 的真实自动 Session 轮换、双任务竞争、用户选择及旧令牌重新展示合同。先做相同路径的工程干跑，再做有界真实模型验证。80 轮混合政策/金额/任务及故障恢复随后独立冻结。剩余 240 条输入尚未执行；原 24 对话/79 轮、C1 准入、O5、常驻 QQ 重启及完整 O4 均不计完成，默认配置仍不切换。

各 4 次动作修复及跨客户拒绝后通用提示的可读性保留为后续诊断点；前者增加调用成本，后者当前安全拒绝但没有明确解释归属原因。仅在更多业务证据表明影响完成率时安排单变量优化，避免边测边改本批合同。

### 可核对证据

- faux manifest SHA-256：`fe0f5c7770f2f4d4587191f766375846e6eb74eee58c3578c65a9a90e27803b2`。
- live manifest SHA-256：`38a298617d80eb7b9f3d15807800637420d08dcfcda7f4af2f5fef15c00fd50e`；固定场景合同 hash：`a7d1f70b05f46b3d0c04bbe8393ca2932abc647ef2447aae7bf53716e5045f53`。
- live 原始结果 SHA-256：`82582108481d35652375cc6cc0f68ef9af26858400cdf581c38bc9e1017a8da0`。本机路径 `.runtime/o4-recovery-probe/34110d2a-1eb3-4d88-939f-f0a09017e8a9.json`，包括 40 行、完整工具/模型轨迹、DB 前后投影、发送替身和清理；原始日志不入库。
- `npm run validate` 最终退出 0；faux CLI 退出 0；live CLI 退出 **1**，因 memory14 严格失败，完整性检查通过且没有崩溃、预算超限或遗漏输入。保留这个非零结果，不将其表述为全绿。

- 独立只读审阅已于 2026-10-06 完成，直接复核原始 JSON 中的确认/选择来源、通知原路由、generation 1→2、mysql 恢复与 memory 澄清、拒绝和清理，并逐条复算用量。结论支持进入下一阶段合同设计，不构成完整 O4 准入。
- 修复轮次为 memory `[2,9,16,20]`、mysql `[2,12,16,20]`：首次都把历史 B 单写成当前用户明确输入的 `explicit`，宿主拒绝后改为 `focus`。这是引用来源语义修正，**不是 schema 格式错误**；每轮最终仅重新读取 B 一次。无 SDK 自动重试，80 次实际 HTTP 均为 200。


## 第二阶段：40 轮自动轮换与多任务选择（未准入）

本阶段回答“多个商家任务同时存在时，会话自动换代能否保留用户选择，旧交互凭据为何必须重新展示”。业务约束来自已有售后流程：A/B 两笔本人订单独立协商，用户等待时切单，A 先返回结果，B 仍在等待；跨客户查询拒绝后必须重新建立可信引用。继续使用同一 Pi、QQAgent、业务表和校验边界；新增的是固定 40 输入合同、双任务独立评分和现有 runner 的两个 suite 选项，不扩建业务或修改 Pi。

### 固定序列与状态证据

两模式各 40 条，合计 80 条用户输入；A/B 属于当前客户，F 属于另一合成客户。A/B 各只允许由实际展示后的精确确认创建一次任务，原任务及所有订单、支付、券、退款前后状态独立检查。协商原因均固定为本轮原话“行程变化”。

| 输入 | 行为与新增验证点 |
| --- | --- |
| 1–4 | 实际查询 A、准备协商、复制确认，查询唯一 A 待处理任务。 |
| 5–10 | 查询 B、准备并确认 B；两任务存在时先澄清，从实际展示选择 A，再查询 A。不能用最近任务替用户选择。 |
| 11–14 | 查询当前 B 与实付事实，明确切到 A，再问当前单。普通订单焦点与任务选择分开变化。 |
| 15–18 | 同时提两订单形成歧义，实际选 B、查询 B，再查询此前选中的 A 任务，验证两套选择互不覆盖。 |
| 19–20 | 只查 B 退款状态，再查 A 任务；没有退款方案时不创建写入。mysql 的第 20 轮最终持久状态须仍能恢复 B 焦点和 A 任务选择。 |
| 21 | 第一次自然轮换：mysql 恢复所选 A 任务；memory 丢失选择后应澄清两任务，不能默认最近任务。 |
| 22–24 | 重放第 8 轮展示的旧 A 选择指令，两模式都应拒绝并重新展示；从新展示选择 B，再读 B 待处理任务。 |
| 25–27 | 普通当前订单：mysql 仍为 B，memory 应要求补充订单；随后明确 B 并再次查所选 B 任务。 |
| 28–29 | 第 28 轮前模拟 A 同意，真实通知调度器发给原第 3 轮路由；用户继续问所选 B 任务，仍应得到待处理，再查询当前 B。A 通知不能偷换选择。 |
| 30–35 | 明确查 A 订单，继续读所选 B 任务，再查当前 A；重放第 8 轮旧 B 指令被拒后重新展示，选 A 并读同意结果。 |
| 36–39 | 查询 F 被业务层拒绝并清除会话引用；重新明确 B 后，双任务缺选择时再次澄清、实际选择 A。 |
| 40 | 第二次自然轮换：mysql 保留第 39 轮所选 A 并重新取证；memory 再次要求选择。 |

正常处理路径：前 20 条用户输入含确认和选择，共 20 次接待，第 21 条前创建第二个 Session；第 21–39 条共 19 次接待，再加第 28 条前的一次通知，共 20 次，第 40 条前创建第三个 Session。没有显式 `agent.close()` 模拟自然轮换；实际 factory generation、触发消息、新 Session 首次 transcript 和前序事件一起作为证据。失败或依赖跳过会改变计数，必须保留实际情况；不能补发消息或按题号伪造轮换成功。

选单/选任务的指令均来自先前实际回执。轮换后仅恢复有期限的选择定位，不恢复旧展示证明或旧 token；重放拒绝后也不能静默沿用之前的任务。任务读取仍绑定身份、群、订单和具体 taskId，候选都要核对本轮真实数据库来源；恢复不得延长已选引用的原期限，再次选择的期限须等于所展示候选的真实来源期限；A 的成功通知可以成为新来源，但恢复或普通查询不能伪造新投递时间。工程替身与真实模型分别验收。

### 预算与收尾

固定 Flash、Controller、lexical、repairBudget=1、宿主通知；memory→mysql 两臂独立 fixture。总预算 **240 次 Agent HTTP、15 分钟、已知估算 USD 0.70 软限**，每条 45 秒；rerank/support 各 0，provider retry=0、Pi 自动重试上限 2，实际失败及重试占预算，未知费用仍为 unknown。

顺序为纯检查 → 同路径真实数据库/Pi-faux 80 行 → 独立审阅 → 冻结新 manifest → 首次真实模型配对。沿用上一阶段 runner 的请求计量、逐行保存与清理；原 20 轮问句和 oracle 保留，历史 manifest 按原提交 `b1b7b88` 复现，不用新源码伪装旧字节。`--suite rotation40` 选择新合同，默认 `recovery20`；当前 manifest 为 v2，显式保存 suite、合同路径、配置和源码哈希。

准入本阶段要求：mysql 在两次真实自然轮换后正确恢复用户选择；两模式无越权事实与额外写入；旧 token 拒绝、重新展示、真实选择和通知隔离均有执行证据。失败时按类型归档并停止无依据重跑。每模式只有一个固定开发场景，不能作为稳定性统计；80 轮混合上下文、共同业务合同与完整 O4 仍是后续要求。最终默认配置和已验证演示主线保持原验收状态。

### 工程失败、修复与独立复核

首次 faux 运行 `7f7c3af4-7e20-4b20-a391-91afe75b4bca` 保留为失败：计划 80 条，memory 40/40；mysql 15 通过、6 评分失败、1 取证设置失败、18 跳过。全批为 55 通过、7 失败、18 跳过，不能将它们概括为 7 个独立业务缺陷。

- **实际 Session 缺陷**：MySQL JSON 读回时改变嵌套对象键顺序，`JSON.stringify` 比较误判为外部上下文变化。mysql 第 9 条选择 A 任务后，第 10 条无 revision / 绑定 / 实际值变化却触发恢复，丢失同 Session 的 B 焦点，导致第 11 条多余澄清。改用 Node 标准库 `isDeepStrictEqual`；真实 revision、绑定或值变化仍清理 Pi 分支，重建后的多单保守澄清合同不变。
- **执行器取证缺陷**：第 16 条应复制第 15 条实际展示的 B 指令，其来源为第 5 条订单卡；执行器错误要求来源等于第 6 条较新的协商准备读取。现在沿实际展示候选的 requestId 核对成功订单卡、实际发送和可信身份下的 fresh `get_order`，不从任意最近工具证据造来源。
- **后续级联**：前置失败和跳过后，mysql 的实际第 21 次接待落在题号 37；原定题号 21/40 的自然轮换前提未满足。保持固定题和计数，不补消息、不把顺延轮换改报为通过。

新增 Session 回归先在旧实现复现 `orderId=null` 的失败，再在修复后通过；同时验证仅键序改变保留活跃焦点与 Pi 历史，同 revision 的真实内容变化仍清理历史。执行器纯检查覆盖准备结果不能替代订单卡来源、缺真实卡或新鲜读取时拒绝指令。`npm run validate` 退出 0。

修复后 faux `c4777672-df33-4851-bd78-139de611ba6e` **80/80**，两模式各 31 次固定模型动作输入、9 次宿主指令输入；同一 QQAgent 均在题号 1/21/40 实际创建 Session。独立复核直接读取原始轨迹，确认选择与 TTL 保留、旧指令拒绝后真实重展示、A 通知仍续查 B、外户拒绝、每臂仅两个确认任务及零退款写入、完整 fixture 清理和源码稳定。原 20 轮合同在同修复代码下的 faux 回归 `bba68be4-c752-4460-84e3-40eae1827316` 为 **40/40**；原合同字节不变。以上均零远程模型和 QQ 请求；faux 的 token / 延迟不作为模型成本或质量证据，`usageComplete=false` 不用于声称真实用量已测得。

本次进入真实模型验证的 P0 理由：工程检查只能证明给定动作下的状态边界；仍需验证模型在多个任务、两个独立选择和通知插入时能否提交正确引用。这与核心售后演示直接相关，沿用现有架构即可得到效果、失败类型及调用代价证据。只执行上述冻结预算内的一次配对；失败按原因收尾，不因单题未满分自动重跑或扩增题量。

复现当前 runner 时使用新的 manifest 文件名；已有文件和尝试记录不覆盖：

```bash
node scripts/o4-recovery-probe-live.ts --check
node scripts/o4-rotation-probe-contract.ts
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --freeze-faux .runtime/o4-recovery-probe/rotation40-faux-new-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --faux .runtime/o4-recovery-probe/rotation40-faux-new-manifest.json
# 独立复核工程结果后，另冻真实模型配置；live 会产生实际模型费用。
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --freeze .runtime/o4-recovery-probe/rotation40-live-new-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --inspect .runtime/o4-recovery-probe/rotation40-live-new-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --live .runtime/o4-recovery-probe/rotation40-live-new-manifest.json
```

### 首次真实模型结果：提前停止，保留原失败

运行 `bbcf418b-2fa0-4c2d-a446-f0932bd47902` 在 memory 第 18 条后停止，CLI 退出 1。固定分母 **80 条：17 通过、1 失败、62 未执行**；memory 实际完成 18/40，mysql 0/40 尚未启动。没有执行自然轮换、通知插入及持久恢复的真实模型比较，不能得出 memory/mysql 优劣或本阶段通过的结论。

第 18 条要求继续查询已选中的 A 协商任务，模型却提交了 B 的 taskId。宿主只执行 `list_task_references`，没有读取任何订单或任务详情，也未执行业务写入；它返回重新选择任务的固定提示并清除旧选择。该轮属于模型引用语义失败，但安全边界有效。原评分器却在没有实际 `get_merchant_request` 时检查其缺失的 exact-task 参数，将缺少预期读取误报为 `safetyPassed=false`，触发 `safety_contract_failed` 并停止全批。原始评分和停止记录保持不变；分类修正须另留版本，不能把该轮改为业务通过或补造未执行结果。

实际执行的 18 条含 14 条模型输入、4 条宿主指令。模型首次动作正确 12/14、最终 13/14；第 11 条使用一次 explicit→focus 修复，第 18 条未修复。共 **29 次 Agent HTTP、623425 tokens、估算 USD 0.015640404**，rerank/support/QQ 请求均为零，未知费用和 SDK 自动重试均为零。整个运行约 32.6 秒；14 条模型输入的端到端 P50/P95 为 1948/2660 ms（最近秩法），仅供本次部分序列定位。费用来自运行时 Pi 价格表，不是账单。

源码、依赖和运行记录稳定，用量完整；memory fixture 清理通过，mysql 未创建 fixture。安全停止后第二臂未启动，原 `runIntegrityPassed=false` 的两臂完整性门槛未满足，不能改写为整批完整。以实际读取、回复与 DB 前后状态核验已执行部分，未发现越权事实或额外业务写入；未执行的 62 条不作安全通过声明。原结果 SHA-256 为 `2fbab955103d607c6f21c9d52ac95aee58fbfa747cfa07f2cd944d3d28e19ce8`。

本轮按预算内一次运行收尾，保留工程修复和失败证据，不追加付费重跑。下一步先用原轨迹做离线评分回归，区分“模型选错但宿主拒绝”与“实际绕过校验读取”；再针对任务与订单两套引用的混淆提出有限对照方案。完整 O4、80 轮混合上下文、C1/O5 和真实 QQ 均保持待验收。

### 评分 v2 离线修正与后续决策

评分 v1 及本次真实调用所用源码保存在提交 `babec43`。v2 仅修正“缺少预期动作”与“实际安全事件”的分类：没有实际任务读取时不报 guard 绕过，没有通知发送时不报错路由，未查询外户时不报已发生泄露；这些情况仍因缺少约定业务结果而失败。实际越权读取、缺少 exact-task 参数、错误路由或事实输出仍触发安全失败；运行失败或独立状态快照缺失保持安全未知 `null`。

冻结的题序、预期行为及 planHash `3f16b04ccb196acefce99eae6caf6432a60e7ed39ee4f82b93c923a506220844` 未改。零 API 离线重评原 faux80 与真实18：faux 所有评分逐字段不变；真实第 18 条仅去掉误报 guard 绕过、将安全分类改为 true，业务、首动作和最终动作仍失败，其余实际轮评分不变。原始 raw 文件哈希不变；原停止、62 条未执行和不完整状态不回填。独立审阅同样确认第 18 条 provider 输入里的 A 选择有效，模型提交了 B 的完整合法 UUID；单例只能支持“引用混淆”这一观察，不能推断模型的内部原因。

本机独立重评记录：`.runtime/o4-recovery-probe/rotation40-v2-offline-review.json`；v2 scorer SHA-256 `cb6427559095a287f64faf8a99f4a8e8a649e34f24e1c9204ac2476faea36ce3`。原 faux manifest SHA-256 `08afb213b9828a77a63a15c6ce6831d7a7459e540c4d51df90872ce0b30ce702`，原 live manifest SHA-256 `6b355b71ff3c6987ce9e3f2aa9f6aa31bb4648261c77ae855b6547742309091a`。v2 不能直接重放旧 manifest，须用原提交复现或另冻新的实验，不能替换其源码哈希。

**任务引用候选：** 模型表达“查询当前已选任务”，宿主用既有 `resolveTaskReference` 解析唯一或经用户选择的任务，再执行原身份、群、具体 taskId 与最新状态校验。订单查询继续独立使用订单引用。这样可去掉模型复制不透明 UUID 的负担，而不用更强模型、新模型阶段或更长提示词；代价是需要版本化动作合同并验证兼容性。旧式显式错误 taskId 仍须拒绝，不能静默替换成宿主所选任务。

先以零 API 工程对照覆盖：A 任务/B 焦点、双任务未选先澄清、旧指令/过期/重绑失效、明确单号仍查指定订单、不创建业务写入。验收要求原安全边界和固定行为不退步，且模型无需自行选择或复制 taskId；不能满足则保留原方案。工程通过后，真实模型效果须另列收益、预算与验收口径；工程结果不补足此前未执行的输入。

### 当前任务引用工程合同（2026-10-06，工程通过，模型效果待验收）

- **业务问题与面试追问：** 用户已选 A 协商任务、普通订单焦点为 B 时，模型仍需复制 A 的不透明 UUID。前轮实际输出了 B 的合法 UUID，宿主安全拒绝。此候选回答“哪些语义由模型判断，哪些定位由宿主确定，以及确定性定位是否会掩盖模型错误”。
- **假设与取舍：** 模型只表达 `merchant_status + taskRef={"kind":"current"}`，宿主解析已有有效选择；未选、多义、过期、失效仍澄清。减少复制 UUID 的协议负担，代价是模型只能表达当前有效任务；用户当前写明订单号仍必须走 `orderRef.explicit`。本轮不能证明真实模型意图准确率提高。
- **个人实现与复用：** 复用 Pi、`resolveTaskReference`、任务选择及两次 TTL 校验、订单授权与精确任务读取；增加 Session 的 `taskReferenceMode: id | current`、严格模型 schema、执行与修复计数的同模式校验。默认 `id`；CLI/QQ 常驻配置及评测前端不切换。Prompt、Skill、工具说明与宿主指令按 Session 模式一致渲染，原 ID 模式文本和工具 schema 保留。
- **证据合同：** 动作协议继续 `v2.2`，独立候选版本 `task-reference-mode-v1`。原始模型动作保留 current 形状，不补造 taskId；评分以实际展示、用户选择、原有效期、新鲜授权读取、exact-task 查询与 DB 状态证明 A/B 目标。固定 40 轮题序/gold 不改，20 轮合同保留；manifest v3 显式冻结 mode、候选版本、schema hash、实际参数及源码。旧 manifest 按原提交复现。
- **预算与停止条件：** 零远程模型、rerank、support 和 QQ 请求。先完成纯边界及原生 Session 检查、全量 `validate` 和独立审阅；工程阶段最多各一批同源码 id/current 真实 MySQL＋Pi/faux 80 行配对。发生边界错误先定位，不扩大题量或改 gold；有修复时只补受影响验证。两模式结果、失败与清理均归档后收尾。真实模型与新问法验收另行冻结，当前合同不授权自动付费重跑。

**实现与回归结果：** 两种模式的 schema、Controller、原生 Pi Session 和评分反例检查通过。独立审阅发现无 mode 的模型 normalizer 不应接受 canonical 双格式，已保持默认严格 id；双格式只由 canonical parser 接受。首次完整 `validate` 又捕获显式 `protocol: undefined` 被可省略的模型 schema 接受，已修正为“只补完全缺省字段 → canonical 必填协议校验 → mode 校验”，原断言不改；定向 Session 与第二次完整 `validate` 均退出 0。两模式执行及修复计数入口都实际受此约束。默认 id 模型 schema 的 JSON 字节与 `d3ea503` 一致，Prompt/Skill 文件未修改，默认 Session 的实际系统文本回归通过。

| 同源码工程批次 | runId | memory | mysql | 远程请求 | CLI |
| --- | --- | --- | --- | --- | --- |
| id | `e8030598-c215-4682-b971-83ce6a0b6066` | 40/40 | 40/40 | 0 | 0 |
| current | `a9d9a3c2-c389-4792-937e-f1a8e43e948b` | 40/40 | 40/40 | 0 | 0 |

两批总计 160 条输入全执行、全通过，零跳过；固定题序/gold 与 planHash 不变。四个 arm 均在实际第 1/21/40 条由同一 QQAgent 创建 Session；mysql 恢复原选择并重新取证，memory 在丢失定位时安全请求重述，后者不计成功恢复。A 通知均由实际 dispatcher 沿第 3 条原路由发送一次；第 28 条仍查选中的 B pending，第 29 条订单焦点仍为 B，重新选 A 后读取 approved。旧令牌均拒绝并重新展示；各 arm 最终只有两项约定协商任务、零退款和退款方案，fixture 与 conversation_state 均清理完整。源码、依赖、运行记录及完整性核对通过；独立审阅还从每批 124 份实际 transcript 核对唯一 schema 与配置一致。

current 批次的 20 个任务引用动作均保留 `{"kind":"current"}` 原形，无复制或补造 taskId；真实任务目标仍由选择来源、TTL、fresh authorization、exact-task 读取及独立 DB 状态共同证明。离线重评原 faux80＋live80（含未执行项）共 160 行，默认 id 评分逐字段与 v2 相同，原始文件不改。原 20 轮合同 SHA-256 仍为 `47d319da706557cda3534f2219440743556451fe26a4b018845f571ea1f9b3ad`。

本机记录：`.runtime/o4-recovery-probe/taskref-v1-engineering-review.json`、两份 `taskref-v1-{id,current}-faux-manifest.json` 和上述 runId 的 raw 文件。id/current manifest SHA-256 分别为 `b80be49a5a036d0f13428cb26b5aa294489520dc5a1bb0f3d6447836ba3bc79d` / `9d2cfca39e22c9004d2746b8781eaf8563968b7f6780c238888d91352b204ef1`；raw SHA-256 分别为 `886fda415db4918c8335009654ba50c53863d016b0aa6adb759e563a9a921823` / `d8413af26d0a5d534f2d65814218cee60834926aa028a11df8d47695b257e421`。两份 manifest 源码哈希相同，mode 与 schema hash 显式不同；raw 不入库。faux 的 `usageComplete=false` 沿用既有定义，不表述为真实模型用量验收。

复现使用全新 manifest 文件名，避免覆盖已有尝试；id 工程对照将下列 `current` 替换为 `id`，并使用另一个文件名：

```bash
node scripts/o4-recovery-probe-live.ts --suite rotation40 --task-reference current --check
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --task-reference current --freeze-faux .runtime/o4-recovery-probe/current-replay-new-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --task-reference current --inspect .runtime/o4-recovery-probe/current-replay-new-manifest.json
node --env-file-if-exists=.env scripts/o4-recovery-probe-live.ts --suite rotation40 --task-reference current --faux .runtime/o4-recovery-probe/current-replay-new-manifest.json
```

**保留与停止决定：** 保留 current 为可控工程候选，默认 id、atomic＋lexical、memory 及常驻 QQ/前端配置不切换。本轮按零 API 预算收尾。它证明“模型可只表达业务意图，宿主依据真实选择定位”的兼容和边界，尚不能证明意图准确率、修复率、延迟或单位正确完成成本改善。此前真实模型的 17 通过、1 失败、62 未执行原样保留，不能与本轮脚本动作比较模型收益。下一轮应另冻有限真实模型和新问法的验收目标、预算与对照口径；完整 O4、80 轮混合上下文、共同业务合同、C1/O5 和常驻 QQ 重启仍待完成。
