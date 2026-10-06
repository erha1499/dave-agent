# C1：商品范围变化后的有限只读动作修复

日期：2026-10-06。状态：有限只读动作修复及独立评分v9已实现，工程与完整validate通过；唯一新Session验证已收尾，两臂完整业务均5/8，未证明净收益。唯一机械修复出现在应澄清的省略负控，仍误接收退款规则。C1未准入、默认不变；上一批类别对照6/8、7/8及失败记录不变，不重跑已收尾manifest。

## P0 选题合同

- **真实业务约束：** 用户完整重述当前订单问题时，应重新授权读取当前商品并取证。旧话题的商品范围已经变化，不能把旧原问、假设、来源或订单状态带进新查询；实际需依赖前文的省略问题仍须澄清。退款准备、确认、身份与幂等边界不开放重试。
- **具体面试追问：** “模型选错引用后，能否复用Harness的工具循环修复？为什么业务动作一般锁定，而某个只读前置失败可以例外？如何证明没有重复副作用或隐去失败？”
- **个人实现与复用边界：** 复用Pi原生工具循环、既有repairBudget、Controller和知识服务。个人实现仅为可审计的范围变化错误、一次受限动作修复及独立证据重建；不修改Pi核心，不新增自然语言正则分类器，不自动将previous改写为standalone。
- **验收及演示证据：** 实际Session工程替代先产生真实旧话题，再由store改变商品；让首次动作选择previous，检查实际授权读取、范围拒绝、第二次动作、重新读取和真实类别gate。失败动作与最终动作分列；必须证明新查询不含旧原问或假设。覆盖重复、预算、并发、取消、引用失效、异主/异群、资料失败及写入负控。
- **投入预算与停止条件：** 本片仅零远程模型/QQ/DB的工程验证；完成定向及完整validate、独立审阅、提交推送后收尾。最多一次范围修复，与已有协议修复共用repairBudget，不因budget=2允许反复范围重试。工程替代不证明模型语义改善；新真实模型对照须另写场景、冻结源码与单次预算。本片不追加上一批远程调用。

## 方案选择

实际失败发生在fresh get_order之后、search_faq之前：模型把完整问题选成previous，旧商品scope与当前商品不同，宿主拒绝继续。保护本身正确，但现有通用澄清会重新展示不能用于当前商品的话题，且动作锁不允许本轮修正。

选择有限只读修复，保留范围保护。它直接对应已观察到的动作误选，复用现有循环；仅加强Prompt仍不能处理已经选错的动作，增加“替换话题”schema则引入新的语义负担。代价是可能多一次Agent请求和一次订单读取，需要补齐两个attempt的证据；收益须由后续新题真实模型验证，不能从工程通过推断。

## 宿主合同

1. 首次动作仅限v2.2的policy、previous、同订单explicit和current_order用途；省略evidenceTarget按现有合同视为current_order。话题必须当前有效、唯一或用户已选，并满足同身份、群、订单与来源结构约束。
2. 唯一成功的授权get_order之后，只有旧topic scope与fresh scope不同，且没有任何search_faq、任务、准备或确认调用时，才能产生宿主专用范围错误。其他拒绝、服务错误、取消和不确定业务结果继续缓存，不能解锁。
3. Controller只允许一次例外。下一动作只能是同订单explicit的policy + standalone + current_order，或明确的policy_topic澄清；不能换单、改用途、沿用previous或进入写入。宿主不会替模型判断原问完整性。
4. Session将范围错误记入既有repairBudget，保留用于判断的当前引用，使用Pi下一次工具调用。预算为0时保留既有范围澄清，不开放特殊续修；预算已经耗尽或取消即停止续修。同一失败动作的并发重复不重新读取；同一个模型响应中猜测多条动作不能充当已看到错误后的修复。
5. 第二次动作重新授权读取，查询由本轮实际原文和第二次fresh事实构建，独立话题的priorQueries为空。scope在两次读取间再次变化时也只能使用第二次事实；没有旧答案兜底。
6. 首次失败动作、来源话题、失败读取和最终动作都可核验；call ID在两个attempt之间唯一。最终knowledge只绑定第二次读取，首次读取不冒充最终事实。独立评分需从实际工具轨迹、历史话题和读取重建，不只相信“已修复”字段。
7. 修复若选择澄清，明确要求完整重述当前对象、条件和问题，不再次展示已失效范围的话题选择指令；它只完成安全澄清，不能计为本轮业务问题已完成。其他话题和未解决的歧义不因这个例外被自动选择或授予权限。

## 结果口径

工程检查展示“给定模型做了正确修复，宿主可安全继续”，不展示模型自行判断正确率。后续真实模型记录首次动作错误、是否修复、是否多余澄清、业务完成、费用与延迟，保持完整分母；旧类别结果不重评分为成功。

整体C1仍未准入，默认atomic、lexical、memory和id保持。渠道咨询、完整O4/O5、共同业务题集与常驻QQ重启仍单列。

## 实际工程结果

`npm run validate`退出0，本机日志为`.runtime/c1-policy-scope-validate.log`。新增Controller、真实Pi原生请求/响应替代和独立证据检查均纳入同一入口；0远程API、DB或QQ请求。

23个隔离Session控制场景覆盖一次范围修复、同名未知SKU、已知晚餐、第二次读值再变化、历史假设清除、预算0/1/2、协议与范围共享预算、重复previous、转写入/换单/rule_only拒绝、取消、权限撤销、来源不可用、过期/异群、合法重述澄清以及首次/修复响应批量动作拒绝。6条代表轨迹从实际Session捕获旧话题、错误及最终动作；评分器独立重建全部通过，37项删改或伪造SDK、预算、读取、来源、身份、范围和旧话题展示的反例均被拒绝。

保留并修复工程中发现的问题：仅取消宿主signal仍会让Pi继续请求，现已同时中止原生循环；范围修复的第二响应若批量猜测多个动作，现在线程执行前停止，无第二读取；原评分器把安全澄清的首次读取误计为不fresh，现仅在完整修复证明成立时认可安全停止；重新展示失效话题的真实选择令牌被新评分合同拒绝。旧取消、工具选择与引用检查保留通过。

工程回复没有真实模型语义审阅，因此`answerPassed`与总体`passed`不从工程绿自动变成true。合法澄清表示安全停止；原gold要求完成问题时仍判失败。新真实模型探针须显式冻结`policyScopeRepair={version:"policy-scope-repair-v1",maxRepairs:1,repairBudget:1或2}`和新源码；未声明合同的修复轨迹不能计为证据通过。旧manifest、原始日志和已归档成绩没有改写。

```sh
node scripts/support-policy-scope-controller-check.ts
node scripts/support-policy-scope-session-check.ts
node scripts/c1-policy-scope-evidence-check.ts
npm run validate
```

源码入口：`src/support-controller.ts`的专用错误与一次受限续修；`src/support-session.ts`的共享预算、原生循环中止和当前轮审计；`scripts/c1-session-validation-check.ts`的`assertC1PolicyScopeRepairEvidence`重建实际两个attempt。个人实现围绕业务和证据边界，循环继续复用Pi。随后[千问单次判别对照](./model-selection.md)已收尾且未采用；模型选择与本片范围修复的收益分别验证。

## 下一片P0合同：新问法真实Session验证（执行前，2026-10-06）

- **业务约束：** 后台合成fixture修订商品定位后，完整重述的问题须按最新授权读取的商品取证；旧问题和用户假设不能变成当前商品资格。真正省略的续问仍需完整重述。fixture修订仅验证事实更新后的引用失效，不表示商家能修改已购合同；购买时SKU/规则快照尚未实现。本片不涉及业务写入、数据库或QQ。
- **面试追问：** “只读前置失败怎样在原生工具循环内安全修复，如何区分正常独立提问、模型自行修复和安全澄清？共享重试预算会不会混淆格式与范围收益？”千问判别对照已经收尾，未达到候选条件；此片验证现成宿主修复，不继续换模型或修改判别Prompt。
- **个人实现与复用：** 固定Flash Agent、Pro typed v6、declared-v2、separated，复用Pi Session、Controller、现有guard/controlledStore/deadline和v9独立评分。只新增有界探针、独立合成新问法及实际HTTP记录，不改Pi核心或旧实验合同。两臂仅repairBudget=0/1及对应修复声明不同；这是共享预算的整体操作对照，同时影响协议修复，不能称纯范围修复因果实验。
- **验收及演示：** 4场景各2轮，每臂8轮，共16轮，按场景AB/BA串行且各用独立store/Session。覆盖已声明午餐→同名未知SKU的完整使用咨询、午餐→已声明晚餐的完整人数咨询、旧rule_only假设→未知SKU的当前使用咨询，以及SKU修订后的真正省略问题。第1轮形成真实唯一且已核验的policy topic后才执行第2轮；前序未满足则保留未执行，不注入成功历史。预算1臂声明`policyScopeRepair={version:"policy-scope-repair-v1",maxRepairs:1,repairBudget:1}`，预算0臂无修复轨迹。报告首次questionContext、协议错误、scope_changed、预算、第二次fresh读取、最终query/basis、正确完成/多余澄清、回复审阅、用量及费用。模型直接选standalone是正常完成；若范围修复触发为0，效果为未观察到，不强制首次动作或补跑制造证据。新题按已知失败类型设计，属于非盲开发验证，不替代C1/O4/O5、QQ或商业验收。
- **预算与停止：** 工程替代及纯检查均0远程/DB/QQ；工程通过且实现/数据/配置/实际依赖先冻结提交后，只执行1次真实run。最多Agent48、rerank16、support16，共80实际HTTP；10分钟、单轮75秒，provider retry=0；USD 0.08/CNY 0.02请求前软停止，单个在途请求可能超限。真实usage未知、额外SDK重试、可信身份/来源/原生字段或冻结状态不符后停止后续发送，完整保留16行和未执行原因。已知用量的语义失败保留并继续独立场景；前序失败不能冒充已建立topic。源码、费用和实际输出独立核对后按这一轮预算收尾，不因触发0或未满分追加同题、第三模型或旧manifest调用。默认和整体未准入状态保持。

执行前工程已通过：新[8轮合成数据](../data/c1-policy-scope-session-development.json)与[两臂runner](../scripts/c1-policy-scope-session-development.ts)经独立审阅，原文/作用域/金标/来源hash一致；完整16轮Pi原生替代执行、8个Session清理、共享预算/一次修复及首次真实唯一话题依赖检查通过。所有工程回复仍为unreviewed、fullyPassed=0，不当模型效果。判别原生delta文本与实际typed分类、实际HTTP输入与知识trace绑定；未知用量/模型身份/来源漂移立即停止，rerank第16次后允许本轮support/final，第17次不得发送。保留并修复执行器审阅发现的原始判别输出缺失、可信身份失败后未立即停及末轮停止原因丢失；原有实验数据和成绩不变。独立`--check`/类型检查/差异检查及根任务最终`npm run validate`均退出0，日志`.runtime/c1-policy-scope-session-validate.log`。合同、实现、题集及manifest先提交推送`4b0ca4a`，随后仅执行一次，结果如下。

## 单次真实Session结果与收尾

运行`4ee83404-3a6a-4806-beee-caa43c32d227`于2026-10-06完成，56.896秒。16轮计划中14轮实际完成、2轮前序依赖跳过，没有执行器异常。47次真实HTTP：Agent 29、rerank 11、support 7；SDK retry为0。按冻结费率及真实usage估算USD 0.019824152、CNY 0.006906，两币种分列，缺失用量/费用为0；不是账单。SQL、QQ、业务写入均0，8个隔离Session/store全部清理。按预声明单次运行收尾，剩余额度不用于补跑。

| 完整计划分母上的指标 | repairBudget=0 | repairBudget=1 |
| --- | ---: | ---: |
| 计划 / 实际 / 未执行轮 | 8 / 7 / 1 | 8 / 7 / 1 |
| 原始工程及知识通过 | 6/8 | 5/8 |
| 实际回复审阅通过 | 5/7 | 5/7 |
| 完整业务通过（工程、知识、回复同时） | 5/8 | 5/8 |
| 两轮均完整通过的场景 | 2/4 | 2/4 |
| scope_changed / 机械修复完成 | 0 / 0 | 1 / 1 |
| 额外接收证据 | 0 | 1：KB-REFUND-UNUSED |

14条实际宿主回复经根任务逐项审阅及独立复核，44条已执行判据中38条通过；另6条判据随两轮未执行保留，完整计划共50条。审阅绑定实际reply与预冻结criteria的hash，`humanAcceptance=false`；不能把工程绿、未发送的`modelFinalText`或尚未进行的人工验收当成通过。原始artifact保留unreviewed和fullyPassed=0，[公开合成结果](../data/c1-policy-scope-session-development-results.json)另外记录原分、逐项审阅和完整业务分，不回写原始记录。

失败及边界：

- **002两臂第一轮：** 用户问当前午餐券人数，主Agent选择`order`而非`policy`，宿主实际只回复实付79.80元，没有人数和资料依据。模型末尾虽然写了人数，但没有成为实际宿主回复。第一轮未建立真实核验policy topic，因此晚餐第二轮两臂依法跳过；不得注入成功话题、删掉该场景或把它记为晚餐已验证。
- **004预算0第二轮：** 宿主安全澄清，没有检索或写入；但提示补上一次问题并展示旧话题，未要求完整重述当前对象、条件和问题，回复判据失败。安全停止和所要求的澄清质量分别评分。
- **004预算1第二轮：** 原生Pi首选`previous`，fresh读取product-demo-3后收到专用`POLICY_SCOPE_CHANGED` JSON，共享预算0→1；随后同单`standalone/current_order`再次读取，两个实际attempt、第二读取、来源和预算都通过v9重建，机械修复成立。可是用户本轮只有“刚才那个问题现在呢？”，模型的`action.question`仍抄旧完整问题；宿主实际`effectiveQuery`保留省略句并加入订单状态对应的“未核销退款”。`priorQueries=[]`不等于问题已经完整，最终检索并接收退款规则，返回使用未知及退款资格说明，违反本轮应澄清且不检索的gold。不是只归咎rerank或Pro，也不能把“重新读对了”说成“业务修复好了”。
- **001/003完整问题：** 两臂均正常按当前商品处理未知类别，未触发范围修复。目标完整重述场景的修复收益未观察到；唯一触发发生在省略负控，不能用于宣称完成率提高。共享repairBudget同时影响协议修复，此一次配对也不支持纯范围修复因果结论。

记录核对：55项源码在运行前后及`4b0ca4a`提交blob一致，实际依赖、package双SHA、唯一attempt锁和manifest匹配；47次请求全部200，raw support输出→typed值、实际wire输入、SDK用量、14行原始评分及summary均独立重建一致。`codeStable`、`dependenciesStable`、`usageComplete`、`requestBindingPassed`均true。`runIntegrityPassed=false`保留全执行要求：`executionComplete=false`，两条跳过记录没有入口且`ingressIntegrityPassed=null`；14条实际执行入口均true。这是依赖未完成，不是身份、账本或费用核验失败；也不修改原聚合结果为true。

冻结入口：[manifest](../data/c1-policy-scope-session-development-manifest.json)，内容hash `62c565533ca43218d090160d4d164a6cbbfae78e4496b631335d7fc05aa202eb`；题集SHA `58b985b078af89d8b99f25b8697e1ba2eb6c9f1423afdd6f93bb38a8a7bbac90`。本地原始artifact为`.runtime/c1-policy-scope-session-development/4ee83404-3a6a-4806-beee-caa43c32d227.json`，文件SHA `3085feea5dcf0ecedddafa47e23786ea0f299ca88462dc3997d430dc313811a4`，内容hash `b556bcffb1f0f199e49db2c7215fb7dc7401df633f1f57bd1ef3b6eef86db781`。完整HTTP body留在忽略目录；公开摘要不能独自复现完整wire审计。本文结果更新发生在运行终态后，执行绑定历史提交，不能在更新后的本文上重新冻结追认成绩。

决定：保留受限只读修复的工程实现与失败证据，C1仍未准入，不切默认模型/架构/检索，不追加同manifest、第三模型或同题付费追分。`--check`可作0远程工程复现；已执行的`--live`不再运行。本轮证明的是Pi原生修复接线及范围/来源的可核验性，没有证明真实咨询完成率改善、QQ体验或商业收益。

## P0：当前咨询命题的出处（显式v3工程候选，未准入）

- **业务约束：** 订单定位完整不等于咨询问题完整。人数/使用条件咨询应取规则，不能用订单事实代答；范围变化后省略句不得由旧问法或订单“未核销”状态补成新的退款诉求。完整重述须可追到当前原文，旧话题只能作为失效定位候选，不自动构成当前咨询授权。身份、fresh、确认与资金边界继续保留。
- **面试追问：** “证据真实、订单fresh，为何仍会答非所问？怎样区别订单事实、用户命题和历史推断？换大模型能改善动作选择，却能否代替宿主合同？”
- **个人实现与复用：** 已审阅`questionContext`、`modelQuestion/originalQuery/effectiveQuery`与状态扩展，沿用Controller/Pi端口实现下述v3工程候选。不改Pi核心，不加通用工作流框架；语义解析在线客户端仍待实现，文本相等、引文和来源hash不能证明问题完整。
- **验收及演示证据：** 先补独立正常咨询、完整重述、真正省略、同名未知SKU和合法历史续问的工程正负控；检查实际宿主回复、资料接收、两次读取及“无完整问题不检索”。保留本轮10/16及误收，调优后另用新题冻结真实验收，不能重评分本轮失败为改善。
- **投入预算与停止：** 下一片先限制为0远程模型/QQ/DB的设计与工程验证；完成合同审阅和可复现控制即收尾。真实模型验证须另定新题、单次预算与停止条件；不因这次未满分自动获批付费额度，也不自动升级judge Prompt或更换模型。

### 本轮工程合同（实施前，2026-10-06）

本轮采用显式v3候选，将只读咨询查询中的自动退款意图词删除，保留中性fresh状态、券数及日期；写入前提查询仍固定退款条件。v2/legacy构造与历史评分保留。候选另接一个有界咨询解析端口：只接受当前原问与可用的真实前序原问，不给订单退款提示、候选文档或答案；输出`current_complete / previous_resolved / needs_clarification`及出处。Controller在FAQ之前验证输入、来源和允许路径，范围变化时只允许当前完整命题，否则要求完整重述并清除失效选择展示。语义解析是模型判断，来源校验不能证明判断正确；工程注入结果只验证宿主行为，真实效果另验。

复用Pi、原Controller的读取/修复与知识服务，不新增Agent或工作流框架。本轮实现查询v3、咨询解析的类型/出处验证和Controller/Session端口，配套独立正负控；不激活线上默认、不开新付费模型调用。真实解析客户端与费用展示接线须另记录完成证据；没有解析端口时v3须显式拒绝启用，不能静默降级为信任模型的standalone标签。人数错选order先强化候选Prompt/Skill路由说明，不用关键词暗改宿主动作。工程覆盖完整重述、两个省略负控、合法previous/假设、退款与人数/周末跨状态及原有取消/权限边界，实际FAQ次数和回复为验收依据。完成定向检查、全量validate、独立审阅、文档及提交后按0远程预算收尾，不把它计为真实语义收益或C1准入。

### v3工程实现与取舍（2026-10-06）

第一片（`0352d8c`）实现解析端口、来源校验、中性查询与Controller/Session接线。只有调用者显式传入`questionContract: "v3"`及`questionResolver`才能使用；缺少端口直接拒绝。该片尚无真实解析客户端、CLI开关或费用接线；随后工程进展见本文末节，不能将端口检查描述为真实语义改善。默认v2、DeepSeek、atomic + lexical、memory/id与常驻QQ均保持既有配置。

执行顺序是：校验动作原问 → 本人订单重新授权读取 → 按fresh范围选择允许的历史原问 → 独立解析端口 → 来源及当前引用有效性校验 → 构造查询 → 原知识服务。解析仅输入`requestId`、本轮原文及合法前序原问链；范围变化或跨单时历史输入为`null`，不传旧回答、订单状态、资料或退款意图。输出固定为三种决策、输入hash、当前原文引文及前序请求ID；校验严格字段、数组、长度、重放及链预算。**模型仍可能引用真实原文却判断错语义**，来源校验无法识别这种错误，检查中保留了这一反例。

| 决策或边界 | v3宿主实际行为与代价 |
| --- | --- |
| 当前完整问题、standalone | 查询使用当前原问和fresh商品；订单状态、券数及有效期作为中性事实，不自动生成“未核销退款”等咨询意图。`policy/refund_eligibility`两种只读动作标签不会改变用户问题。用户原文明确问退款仍保留退款；写入前提沿用固定退款条件。 |
| 合法同范围续问 | `previous_resolved`须绑定已完成取证的原问链和实际前序ID；只沿用经过宿主选择的来源。解析等待后再校验TTL，期间过期则停止，FAQ为0。rule_only的历史假设仍是解释依据，不变成本单事实。 |
| 范围变化、解析为当前完整问题 | 原有一次只读范围修复仍可把错误previous改为standalone；两次均重新授权读取，解析对同一固定输入缓存一次，不把旧问法带入新查询。修复仍受既有共享预算限制。 |
| 省略、来源冲突、解析无效或不可用 | FAQ为0，要求完整重述对象、条件和问题，清除旧话题及选择展示。重新完整提问并成功取证后清除pending标记，允许新的合法续问；旧选择指令不复活失效话题。 |
| 当前完整却选择同范围previous，或跨单previous | 保守澄清，不把历史问题或bounded退款意图加入当前完整命题。真正完整的standalone跨单咨询仍可重新取证。该选择可能增加误澄清，不能称误拒为0；跨单省略退款续问在v3暂需重述，v2行为保留。 |
| 取消、超时、迟到结果 | 解析等待上限15秒，转发当前AbortSignal并在等待/完成处校验；不合作端口的迟到输出不能发布或覆盖新轮。此检查不能证明外部供应商已停止计费。 |

只扩充Prompt的成本低，但无法防止模型复制旧问题或宿主自动生成退款意图；仅做原文相等校验也不能判定“刚才那个现在呢”是否完整。此候选因此将语义判断和确定性来源校验分开：前者可错，后者限制错误可沿用的历史。新增解析请求将增加延迟、费用及可能的误澄清，尚需真实对照决定收益。没有引入第二个Agent循环或通用编排；候选Prompt追加人数/日期咨询使用policy、订单事实使用order的说明，尚未证明真实动作选择改善。

源码入口：[解析合同与来源验证](../src/support-question-resolution.ts)、[中性查询v3](../src/support-evidence-context.ts)、[Controller](../src/support-controller.ts)、[Session候选接线](../src/support-session.ts)。第一片保留C1/v9的v2合同与历史分数；末节新评分显式区分v3，不宣称v3通过旧机械证明。

### 工程复现及下一步

本片使用合成订单、内存存储、固定解析/排名/判别输出和替代HTTP；实际运行Pi原生循环及Controller/知识服务，不连接数据库、QQ或远程模型。三份检查分别验证来源合同、独立查询预期及实际宿主回复/调用。固定解析输出只验证接线，不能计算语义准确率或声称解决上轮误收。

```sh
node scripts/support-question-resolution-check.ts
node scripts/support-question-query-check.ts
node scripts/support-question-session-check.ts
npm run validate
```

定向结果：30组只读查询投影（3类咨询 × 5种fresh状态 × 2种动作）、来源/hash/重放/数组负控、22项原生Pi会话控制通过；跨单Controller正负控另覆盖1个previous意图冲突和2个standalone正常咨询。审阅中复现并修复了稀疏数组校验、完整问题仍携历史、清除话题后的pending恢复、解析期间TTL过期和跨单旧退款意图五处缺口，检查保留正负路径。独立审阅与最终`npm run validate`全部通过，包括原v2查询、23项范围修复、6条Session重建/37项篡改负控及QQ/回复/评测离线回归；本轮远程模型、DB、QQ均0，没有执行历史已关闭manifest。

首次全量检查在旧`support-controller-check.ts`注入知识服务处失败：新构造函数复制services后，原有构建后替换knowledge不再生效。已保留原服务引用，只固定新增咨询合同与端口；原检查不改，Controller定向与最终全量重跑均通过。首次失败日志和最终日志分别留在忽略目录`.runtime/c1-question-v3-engineering-validate.log`、`.runtime/c1-question-v3-engineering-validate-final.log`，不作为真实模型或数据库验收。

第一片收尾时确定的下一步是接真实有界解析客户端、角色配置、用量记录及v3独立证明；这些工程工作已按下节完成。在0远程工程验证通过后，再冻结新的完整/省略/合法续问题集、单次调用预算、误澄清分母与停止条件。真实验证同时固定主Agent和判别配置，以比较“新增解析请求的收益是否抵得过延迟、费用和误澄清”，不回跑本页16轮或模型选型12题追分。整体C1、完整O4/O5、共同79轮与常驻QQ重启仍待完成。

### 下一片P0工程合同（实施前，2026-10-06）

- **真实约束与追问：** 已授权订单仍不能补全省略诉求；真实解析请求也可能超时、格式错误或没有用量。需要说明“一次解析新增多少请求和费用，取消后如何保留未知用量而不发布迟到结果，来源合法为何仍会语义判断错误”。
- **实现与复用边界：** 一个无工具JSON解析请求，复用原Pi complete、独立角色凭据和既有USD/CNY价格函数；显式模型选择默认Flash、temperature0/思考关闭/SDK retry0/最多1024输出/超时不超过15秒。宿主添加版本和inputHash，模型只输出决策、当前原文引文和前序ID，不要求模型计算hash，不提供订单/资料/答案。沿用v3候选端口，不改变Pi核心、v2/QQ默认和旧评分合同。
- **本轮验收：** 原生Pi替代HTTP逐次校验真实wire、身份、JSON、一次请求、无工具、取消、超时、无效响应和未知用量；Controller/Session保留成功及失败解析trace，转换为既有评测span，不能漏计无效输出的已知用量。独立v3证明重建输入/原问链、决策来源、查询与费用；测试注入的语义结果仍不记为真实业务改善。
- **可用入口：** API显式传入候选client；CLI提供仅本地命令的v2/v3、解析模型与超时环境参数，拒绝atomic或v2下的无效组合。QQ、工作台默认及前端不自动接候选，新增解析费用用provider span分列，原仅汇总主Agent的指标不改称全链路费用。
- **预算与停止：** 0远程模型、DB、QQ；完成定向、全量validate、独立审阅、文档和提交收尾。真实新题及单次预算在工程完成后另冻结；本片不运行任何已收尾manifest，也不通过重复固定题追分。

### 真实解析客户端、费用与独立v3证明（2026-10-06，工程候选）

已接入[单次解析客户端](../src/support-question-client.ts)：复用Pi原生complete与provider，不启动额外Agent进程或改Pi核心。默认解析角色为DeepSeek Flash，可显式使用Pro或固定千问快照；角色凭据与主Agent分开。一个解析最多发送1次HTTP，无工具、关闭思考、temperature0、retry0、输出最多1024 Token；默认超时10秒，范围1..15秒。模型只返回决策、当前引文、前序请求ID，版本及输入hash由宿主添加。事实、检索资料与旧回答不进入解析输入。

Controller/Session保存成功与失败的解析trace，`onQuestionTrace`提供实际当前requestId、完成回调时间、固定输入与trace。范围修复重用一次解析，但两次订单读取仍独立取证。费用、配置和wire hash留在宿主证据及回调，不添加到主Agent的工具结果上下文；模型仍得到必要的问题出处和业务证据。回调故障标记采集不完整，不引发第二次请求或业务重试；取消后的迟到SDK结果不能变成新轮业务结果。

[provider span适配器](../src/knowledge-evaluation.ts)供回调消费者将解析记录纳入既有EvalSpan，按实际HTTP0/1、已知Token覆盖及USD/CNY分列。无效JSON、禁止工具/思考或不完整字段的输出，在首完整SDK响应与实际wire用量核对成立时仍计费；拦截额外请求不抹掉首请求账本。缺usage或对账不成立保持未知。**部分流超时可能已经观察到usage，但完整SDK结果未闭合时，费用仍为null；原始独立记录保留已到片段，不代表零费用或供应商停止计费。**原`summarizeEvaluation`仍仅汇总Agent模型step，不能称其为全链路总费用。工作台/QQ尚未激活v3解析或新增其费用展示；本片只提供候选API与适配器。

独立证明只在冻结`order-evidence-binding-v3`及`questionSettings`时启用，摘要标识`c1-session-validation-v10-question-v3`与`questionProofVersion=c1-question-evidence-v1`；旧v2仍v9且无新增摘要字段。评分从实际原问、完整合法前序历史、宿主候选、授权读取、SDK动作、独立HTTP body/原始SSE/SDK响应、完成时间、查询及价格重建，匹配自报hash不足以通过。0次FAQ的澄清/失败和取消也检查解析请求，不能绕过费用及来源核验。运行时在完整重述的宿主出处/引用校验与ready结果成立后清除policy待澄清；独立评分随后从原始HTTP/SDK重建出处，并核对该转换，生产Session不调用评分checker。旧话题清除后不能重新显示或复活。

显式本机候选入口（此命令会使用本机业务库并实际请求模型，本片未执行）：

```sh
SUPPORT_ARCHITECTURE=controller CLI_QUESTION_CONTRACT=v3 \
  CLI_QUESTION_MODEL=deepseek-flash CLI_QUESTION_TIMEOUT_MS=10000 npm start
```

省略这些CLI参数仍走v2；atomic下启用v3、v2下配置解析模型/超时、未知模型或非法超时直接拒绝。API使用`createSupportQuestionClient`并传入`createSupportSession`的`questionContract: "v3" / questionResolver / onQuestionTrace`。这些开关只作用于本机CLI候选，不改变QQ和工作台参数合同。

工程复现使用合成订单、原创内存规则和原生Pi替代HTTP，不读取真实QQ消息或改线上corpus：

```sh
node scripts/support-question-client-check.ts
node scripts/support-question-observation-check.ts
node scripts/support-question-evidence-check.ts
npm run validate
```

本片验收收尾后，下一步才冻结新的完整重述、省略、合法续问题集和单次预算，固定主Agent与证据判别配置，比较额外解析的真实收益、误澄清、延迟及费用。不重跑已关闭题集，不以工程固定分类冒充真实模型理解或C1准入。默认配置与旧失败结论均保留。

本片已按0远程/DB/QQ预算收尾：**54项原生客户端控制、23项span/采集/CLI控制、16条实际Pi Session捕获及45项篡改负控通过**；独立审阅、最终`npm run validate`退出0，包含旧v2、原23项范围修复、6条旧证明/37项篡改及QQ/回复/评测离线回归。16条涵盖当前完整问题、合法previous、一次范围修复、澄清、无效输出已知费用、未知用量、HTTP失败、CNY、修复后澄清、取消、跨单完整咨询，以及“澄清→完整重述→合法续问”的实际恢复。所有模型HTTP与语义分类均使用固定工程输入，不是远程效果测试。

独立审阅已复现并修复三类缺口：额外请求被拦截时错误清空首请求已知费用；参考评分器未镜像安全清除旧话题及完整重述后解除待澄清；普通SDK工具输出可被整体替换而未与宿主结果配对。现逐项保留负控，工具实际动作、成功位、回复、解析出处和业务投影均与宿主匹配，普通返回及范围错误都不把完整解析trace送入模型。被拦额外请求的特有事件尚无通用C1原始记录字段，独立评分对这种不完整录制保守拒绝；客户端专属检查仍证明只有1次HTTP及首账本未丢。

首次全量通过后发现的SDK输出证明缺项已另做必要修复，再次全量通过；日志分别留在忽略目录`.runtime/c1-question-client-engineering-validate.log`及`.runtime/c1-question-client-engineering-validate-final.log`。本片未修改题集gold、历史成绩、线上规则、数据库或前端；本机已有`package.json`、锁文件和`.idea/`改动保留且不纳入本片。截至本工程切片完成时，真实解析质量、额外请求净收益及v3真实执行runner/付费manifest仍待后续；QQ/工作台激活未交付。新题实现与实际结果见以下切片。

### 新题Session对照合同（实施前，2026-10-06）

- **业务约束：** 本人券单定位不等于完整咨询；人数、周末使用、省略续问和失效商品引用按实际当前原问、合法历史和fresh读取取证。使用现有原创演示规则与目录，合成状态修订只模拟fixture商品定位变化，不模拟商家改变已购合同。独立case/arm内存store与原生Pi Session，不注入成功话题、模型答案或直接解析标签。
- **面试追问：** “增加一次无工具问题解析能否减少旧意图污染，是否引入误澄清；业务完成率增加后每个正确业务轮付出多少延迟和费用；工程出处验证如何与真实模型效果分开？”
- **个人与复用：** 复用原Session、Controller、真实解析client、知识服务、授权fixture、期限/预算及独立评分。只补新题执行和账本接线；v2/v3比较包含中性查询与解析，不能归因于单一模型。两臂固定Flash主Agent、Pro typed v6、M4-support、declared-v2、separated及repairBudget1，v3解析Flash/10秒。默认不切换，QQ/数据库/前端不改。
- **新题与验收：** 6场景、每臂12轮，共24轮：完整人数、同范围合法续问、范围变化后的完整重述、范围变化后的省略负控、澄清→完整重述→合法续问、跨单完整问题。新问法独立编写及审阅，属于非盲开发验证。需要真实前序话题或澄清的轮次必须先核对已完成来源，否则保留未执行。记录完整24分母、业务完成/资料误收/误澄清、解析实际触发、原始wire/SDK/出处、范围修复、回复判据、真实请求、P50/P95和USD/CNY。明确全链路与Agent-only指标；来源正确仍不能代替语义质量。
- **预算与停止：** 一个新manifest仅执行一次，最多Agent72、rerank24、support24、question12 HTTP（总132），10分钟、每轮75秒；累计USD0.15、CNY0.05为请求前软停止，已发单次可能超限。未知费用、重试、源/配置/依赖变化或wire账本不符时停止后续发送，保留完整未执行分母。工程与独审先用0远程/DB/QQ跑通、提交，再冻结实际环境及题集；随后只执行这一批新题，不运行已关闭manifest、第三模型或同题追分。

候选推进须两臂完整执行、来源/费用完整性可信、v3省略负控零资料误收、完整问题无新增误澄清且严格业务完成数提高，同时分列额外解析的时延及费用。未达到便按本次证据归档，不继续扩大测试。单次小样本即使通过也只支持后续候选验证，不替代完整C1/O4/O5、QQ或商业验收。

### 新题执行器与工程边界（2026-10-06）

[新题](../data/c1-question-session-development.json)包含6个独立场景、两臂各12轮，复用原线上8篇原创演示文档及declared-v2目录，不覆盖已有题集。题集SHA-256为`5971fd9d76a6934b8c9e46170630d74d82a7e6108a59d3ac43d78ca91be601c7`。[执行器](../scripts/c1-question-session-development.ts)提供check/freeze/inspect/live；复用已有原生Session与三角色测量，只为问题解析另接已有预算计数器，两者共享停止、费用及源/依赖核验。没有修改Pi核心、生产业务、默认配置或前端。

前序依赖检查的是实际来源状态：合法话题须有已通过出处、范围、身份及规则接收证明的真实前轮；澄清须实际处于policy待澄清、无verified话题且FAQ调用0。前轮回复文案的严格判据仍独立评分、计入整场业务完成；不把“回复判据全通过”误当建立澄清状态的必要条件，也不注入成功历史。首次Agent请求核对前序宿主状态，修复或完整重述后的最终Agent请求可合法携带新状态。

原生替代HTTP工程路径执行24轮、12次解析、12个隔离store并全部清理；全部24轮独立出处证明通过。v2在场景005的第三轮仍保留policy待澄清，虽第二轮完整重述已成功，随后合法续问仍澄清、FAQ0，工程业务严格失败；v2为11/12，v3为12/12。该失败与原gold保留，明确例外只允许断言这项已知业务失败，不豁免出处证明。所有固定模型分类和固定回复均非真实语义效果，回复保持unreviewed，严格完整业务数尚未评定。

独审修正了用冻结配置重造actualSettings而非核验真实settings、在最终Agent请求仍强求旧宿主状态、以及已知业务失败绕过原24轮出处断言三个检查缺项。共享预算、未知用量阻止后续发送、取消/无效输出账本、配置及请求篡改均有负控；实际`wx`锁以临时忽略目录证明第二次claim被拒绝、dummy-send保持一次。旧范围runner只扩展复用类型和可选limits，默认逻辑及wire规则不变，旧check仍通过。

工程命令均为0远程、0DB、0QQ：

```sh
node scripts/c1-question-session-development.ts --check
npm run validate
```

完成全量核验和提交后才冻结新合同（freeze/inspect为0远程；live有真实模型与重排费用，只允许一次）：

```sh
node --env-file-if-exists=.env scripts/c1-question-session-development.ts --freeze data/c1-question-session-development-manifest.json
node --env-file-if-exists=.env scripts/c1-question-session-development.ts --inspect data/c1-question-session-development-manifest.json
node --env-file-if-exists=.env scripts/c1-question-session-development.ts --live data/c1-question-session-development-manifest.json
```

最终`npm run validate`退出0，包含新runner与既有业务、QQ离线及前端接口回归。全量日志保留于忽略目录`.runtime/c1-question-session-engineering-validate.log`；费用上限与失败停止按前述预定合同执行。工程审阅未调用远程模型，未认领v3效果或C1准入；真实结果需另据新manifest与执行记录判定。


### 新题真实结果与预算收尾（2026-10-06）

运行`78131547-63d2-474a-9aa8-9c85cd7025e7`完整执行24/24轮、两臂各12轮，122.887秒，0失败/未执行。执行器及新题先提交`a02c3c0`并通过全量validate，随后在`6c0d73b`提交[唯一新manifest](../data/c1-question-session-development-manifest.json)，冻结58份源码/规则/题集及实际依赖。manifest SHA-256为`34e35f0eefc4313e4b650bc0fae6860e32ecc762b8db72f74d5610d6d9f0c28d`。单次执行锁、源/依赖前后、实际配置、原生wire/SDK/费用与12个隔离store清理全部通过；`runIntegrityPassed=true`，没有provider/SDK自动重试、未知费用或SQL/QQ请求。

| 指标（完整分母） | v2 | 整套v3候选 |
| --- | ---: | ---: |
| 实际执行 | 12/12 | 12/12 |
| 工程与知识均通过 | 10/12 | 12/12 |
| 实际回复判据 / 严格完整业务 | 9/12 / 9/12 | 11/12 / 11/12 |
| 全部轮次严格通过的场景 | 4/6 | 5/6 |
| 额外资料接收 / ready正例误澄清 | 1 / 1 | 0 / 0 |
| Agent / rerank / support / question HTTP | 27 / 10 / 10 / 0 | 29 / 10 / 10 / 11 |
| 全轮P50 / P95（ms，含失败） | 4064 / 7239 | 5391 / 7393 |
| 已知估算USD / CNY | 0.022433004 / 0.006142 | 0.025492296 / 0.0060325 |
| 每个严格通过轮次估算USD / CNY | 0.002492556 / 0.000682444 | 0.002317481 / 0.000548409 |

共107次真实HTTP：Agent56、rerank20、support20、question11；全部200、真实用量已记录。总计USD0.0479253、CNY0.0121745，分别按冻结费率估算，不是账单，不相加或兑换。主Agent步骤摘要仍为Agent-only，表中费用按全部四角色实际请求重新汇总。额外8次Agent相对每轮两次的初始结构分别是7次工具协议错误修复和1次v2只读范围修复，均在既定预算内并保留，不能称0修复。解析实际11次：005首轮Agent直接发clarify而没有触发解析；不能声称每个用户轮都多一次调用。

独立审阅24条实际交付回复、92项冻结判据，reviewer为codex、forHumanReview=true、humanAcceptance=false。评分使用[答复审阅](../data/c1-question-session-development-answer-reviews.json)与实际replyHash/criteriaHash重算，并经另一只读任务复核；不把modelFinalText或工具成功代替宿主实际回复。严格保留以下失败：

- v2 004第2轮：未知商品下当前省略问题被扩展为退款规则，接收并显示`KB-REFUND-UNUSED`，未要求完整重述。实际文案又说明退款资料不能回答周末，故这是错误检索/接收及未澄清，不能描述成已给错误退款资格或资金结论。v3原生解析判为needs_clarification，FAQ0并清除旧话题，实际提示明确当前对象/条件/目标完整重述，阻断误收。
- v2 005第3轮：第二轮完整重述取证成功后仍遗留policy待澄清，随后合法续问被要求选择已有话题，没有可用结论或接待边界。v3按宿主出处/引用校验与ready结果解除待澄清，第三轮实际previous解析与重新授权取证成立；事后独立原生证明核对该转换。
- 两臂005第1轮：实际相同宿主notice为“补充具体使用规则或上一次问题”，未明确要求当前对象、条件和目标的完整重述。按冻结判据保守失败，记录语言歧义；模型另说得更全不能补实际交付。这是共同回复模板缺口，工程安全澄清和无FAQ状态仍成立，已经发生的前序依赖与原gold不回改。

v3有界候选推进条件成立：完整执行与来源/费用可信、省略负控0误收、完整正例无新增误澄清、严格业务11大于9。但本次是由已知失败类型设计的非盲小样本，比较中性查询、原问解析与澄清恢复整套方案，不能归因于单一模型，也不能推导生产效果、稳定P95或完整C1/O4/O5/QQ准入。v3每轮用时更高、USD总额增加，当前单批成功轮摊销较低不代表稳定成本优势；缓存、网络和执行顺序影响仍未单独控制。

[公开结果](../data/c1-question-session-development-results.json)保留24合成输入、实际交付/模型文本区别、评分、请求计数及用量、解析决定、配置和来源hash。完整原始artifact和原生请求/SSE留在忽略目录`.runtime/c1-question-session-development/78131547-63d2-474a-9aa8-9c85cd7025e7.json`，公开摘要不含完整raw审计，不能单独重建全部HTTP证明；须核对结果中artifact SHA及执行前版本。原始CLI输出和工程日志分别为`.runtime/c1-question-session-development-live.log`与`.runtime/c1-question-session-engineering-validate.log`。本文结果段在执行结束后添加，当前文档hash变化不改变冻结历史，也不得重新freeze同题追分。

本次预算关闭，默认模型及atomic + lexical、memory/id、QQ/工作台均不切换。先修共享完整重述提示并用0远程工程检查核对，保留本次9/12与11/12原始分数；然后补稳定闭环的演示、源码讲解和取舍材料。后续有界候选验证须有新问题及合同，不因为本轮仍有失败或预算剩余就追加调用。

### 共享澄清提示与演示复核合同（实施前，2026-10-06）

- **业务约束：** 初次省略咨询必须收到可执行的完整重述要求，写清当前对象、条件和要确认内容；实际宿主回复不能由模型最终文本补齐。保留真实候选选择、身份、范围与待澄清状态，不能因文案修复绕过既有授权或恢复合同。
- **面试追问：** “为何模型说得完整，用户实际收到的提示仍失败；固定宿主回复与生成回复的责任如何分开？如何从演示追到问题出处、重新取证和已记录成本？”
- **个人与复用：** 只修现有Controller共享policy_topic提示与相应Pi Session检查，复用Pi循环、固定宿主Reply和业务服务；沿用已有售后与C1文档补最新源码/证据指路，不扩建Harness、前端或演示平台。
- **验收及演示：** 两个questionContract的直接clarify均检查实际Reply包含对象/条件/目标完整重述、拒绝模型伪造资金话术且无提前业务/解析调用；既有真实候选、完整重述恢复、合法续问与全量工程检查仍通过。独立复核稳定售后演示和候选C1路径的命令、配置、源码及验证层级，补缺项，不认领新模型/QQ验收。
- **预算与停止：** 0远程模型、0DB、0QQ；定向工程与全量validate一次，只有实际错误再做必要修复检查。新题唯一运行9/12与11/12、原gold/reviews/manifest保持不变，不重新请求或对旧成绩追认修复。文案和证据入口核验通过即提交收尾；未完成C1/O4/O5与QQ候选准入另列，不因材料补齐勾选。


### 共享提示修复与材料收尾（2026-10-06，0远程工程）

Controller只改共享`policy_topic`固定文案为完整重述当前对象（订单或券）、具体条件和要确认内容，保留多规则选择提醒及已有候选展示。默认v2和显式v3分别经过4条澄清与1条明确订单后续查询，共10轮实际Pi/faux；`supportReply`严格等于宿主`result.reply`，模型另行生成完整提示或伪造批准/金额/链接均不能替代实际交付，澄清阶段store/FAQ/parser调用0。既有完整重述恢复、合法previous、范围/TTL/取消及独立证明检查由全量回归继续覆盖，没有修改状态机、授权、资金、评分或默认配置。

旧提示缺完整要求先复现失败；修改后的定向与类型检查通过。首次两次全量检查分别定位Controller和Reference Controller仍匹配旧文案，必要修复只加强当前对象/条件/目标的文字语义，原待澄清、候选选择和0calls断言保留；最终`npm run validate`退出0。before、两次旧断言失败与最终日志分别在忽略目录`.runtime/shared-policy-clarification-before.log`、`shared-policy-clarification-validate.log`、`shared-policy-clarification-validate-final.log`、`shared-policy-clarification-validate-final2.log`，不覆盖失败。

[稳定售后演示](./after-sales.md#启动)的完整17项export先用合成`.env`复现旧三选项命令失效，再以真实Node env-file读取及离线Pi模型metadata核验atomic/memory/lexical、v2和DeepSeek Flash；没有读取真实密钥或启动业务库/QQ，日志`.runtime/shared-policy-demo-config-final.log`。这证明配置解析，不是本机CLI/QQ服务再次启动验收。初次配置检查误计export数量的本地断言已删除，改用实际参数及provider/密钥隔离合同核验；失败留在`shared-policy-demo-config.log`。

[C1源码与演示入口](./c1-implementation-results.md#最新v3路径与0远程复现)已补新题取舍及declared-v2目录边界，并明确运行时宿主出处/引用校验与事后原始HTTP/SDK独审是不同步骤。CLI候选提示也区分方案有界对照与当前配置/完整准入。独立只读审阅及文档本地链接核对通过，未增加新Harness、平台或前端。

本片0远程模型、0DB、0QQ，原dataset、gold、reviews、结果与manifest字节保持；此前真实9/12和11/12不改，不能据工程修复说真实12/12。共享提示与材料按预算收尾；下一步优先补已有v3在工作台后端的参数/快照/解析span和分币种费用入口，候选激活及完整C1/O4/O5仍另有验收合同。
