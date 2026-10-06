# C1 类别候选：显式参数与Session开发对照

日期：2026-10-06。状态：显式候选与审阅目录已实现，完整工程检查通过；冻结的单次真实对照已执行并完成16条回复审阅，v1为6/8、v2为7/8。本批有局部改善及一项新增会话失败，整体C1仍未准入；按预算收尾，不重跑本manifest。沿用[类别必要前提合同](./c1-product-category-guard.md)；本轮不改前端、Pi核心、默认参数、线上语料或旧gold。

## P0 选题合同

- **真实业务约束：** 商品类别由受审阅目录按精确shop/product ID取得。合成订单仍经当前身份重新授权读取，未知类别不能靠名称推断；普通周末规则保留节假日、特殊活动及接待核实限制，不等于预约或实际可以接待。
- **具体面试追问：** “宿主必要前提门控如何接回真正的模型会话？匹配前提为什么仍可能被模型误拒？候选接口、已验证能力和默认部署怎样分开？”
- **个人实现与复用边界：** 复用Pi Session、Controller、已有知识服务和请求预算，增加显式`knowledgeApplicability=declared-v2`，保留`declared`为v1及默认`model_only`。v2只使用新增审阅元数据，不重新实现循环、检索或评测平台。
- **验收及演示证据：** 六个合成场景，每臂8轮，两臂完整16轮。检查午餐/晚餐普通周末、同名未知类别、同订单fresh商品ID变化、一般/假设规则和资料覆盖；沿实际动作、授权读取、取证和回复追到来源及门控。必要前提匹配与模型接收分列，回复不能冒称具体日期已可接待、已预约或获批。
- **投入预算与停止条件：** 一个新manifest只执行一次；最多48 Agent、16 rerank、16 support真实HTTP，USD 0.06及CNY 0.02费用软上限，总6分钟、单轮75秒，provider重试0。到达费用线不启动新请求，在途可能超过软线；所有失败、依赖跳过、invalid及unknown用量留在16轮分母。0真实DB/QQ。不重跑已收尾12输入环境诊断或80轮工程预算。

## 参数与业务定义

显式候选的目录来自现有`db/02-seed.sql`的两个精确商品ID：双人午餐与**单人晚餐**；目录类别是作者新增的合成业务定义，不声称旧正文已经提供SKU分类映射，也不称外部商家认证。

新文件`data/knowledge-applicability-v2.json`保留8篇完整source hash/scope审阅，只为门店类别规则增加必要前提。v1文件、8篇原文及seed不覆盖。v2规范内容哈希与原始文件SHA分列；旧参数/报告兼容，新参数在实际配置和评分重建中不能冒充v1。

两臂使用相同Flash主Agent、Pro typed v6判别、分离查询和0.5阈值，只改变`declared`/`declared-v2`及其必须绑定的元数据版本。每个场景从独立会话开始，fixture状态变化由脚本显式记录；不依赖真实演示库中当前余额或任务状态。

这是新的失败驱动开发场景，仍不是独立准入验证。8轮不是8个独立业务场景；仅有一个固定配对运行，不能推广为生产效果或长期稳定性。

请求预算在实际`fetch`发送前计数，使用显式`per-operation`策略：第16次rerank后允许本轮尚有额度的support和Agent完成，第17次rerank仍在发送前拒绝。费用与总时间线阻止所有新请求；某类额度已耗尽时，不提前删掉可能无需该类请求的计划轮，其发送尝试会受控拒绝并保留结果。旧验证guard默认仍为任一类别到线即整体停止，不改历史合同。

```sh
# 使用真实Pi和本地HTTP替代，不连接模型、数据库或QQ。
node scripts/c1-category-session-development.ts --check
# 通用A/B参数预览，与本批冻结预算分开。
node scripts/experiment.ts --preset support-knowledge-category-ab --dry-run
```

完整Session沿`createSupportSession → support_action → get_order/SupportController → createKnowledgeService → supportReply`执行。fixture和新目录受版本控制；运行先取得manifest唯一`wx`尝试锁，再预建并保存16行，二者均在首个实际HTTP之前。真实回复初始保持未审阅，后续按arm/case/turn、实际replyHash和固定criteriaHash独立复核，不从工程通过自动生成回答通过。`--live`正常退出只代表记录命令结束；必须核对artifact完整性、完整分母和逐回复审阅，不能把退出0当成模型测试全绿。

## 已知边界与决定口径

类别门控过滤未知/不匹配的受限规则，但当前支持判别的query尚未直接承载审阅目录中的类别事实。若已知类别正例仍误拒，应区分“必要前提已匹配”与“语义判别缺少可见事实”，再确定明确来源绑定的事实输入合同；不能直接把matched计为语义正确。

推进条件：所有计划轮完整记录、源码/参数/请求与费用可核验；未知类别不接收其类别规则，known类别及一般/假设、资料覆盖正例不能出现新退步。只有观察到目标改善且保留正例，才称本批有收益；否则明确记录无收益或缺口。完成这些局部条件仍不能替代C1整体、共同业务或O4/O5准入。

银行卡时限问题另按[渠道咨询合同](./c1-channel-consultation-contract.md)设计可信请求条件取得；本次类别对照不能宣称解决它。

## 实际执行

完整`npm run validate`实际退出0，日志保留本机`.runtime/c1-category-session-validate.log`；新探针、旧guard默认行为、参数派发、版本错配拒绝及独立评分检查通过。`--freeze`与`--inspect`均退出0、无远程请求，随后提交执行源码`a3d065edf89e4399b3b555829d0b08bb7e0aaf81`。

唯一真实run：`2312d6af-0088-484c-913e-69ffc182fbc0`，UTC 07:49:09.386–07:50:17.023，67.637秒。六场景、两臂16轮全部执行；配置与用例在首次请求前固定，gold未回改。实际命令：

```sh
node --env-file=.env scripts/c1-category-session-development.ts --freeze data/c1-category-session-development-manifest.json
node --env-file=.env scripts/c1-category-session-development.ts --inspect data/c1-category-session-development-manifest.json
node --env-file=.env scripts/c1-category-session-development.ts --live data/c1-category-session-development-manifest.json
```

该manifest的远程预算已收尾。尝试锁禁止再次真实执行；上述记录用于复现入口说明，不是重跑授权或独立验证建议。

| 层次与完整分母 | declared v1 | declared-v2 |
| --- | --- | --- |
| 实际执行轮数 | 8/8 | 8/8 |
| 工程合同通过 | 8/8 | 7/8 |
| 知识证据合同通过 | 6/8 | 7/8 |
| 实际回复审阅通过 | 6/8 | 7/8 |
| 完整轮次通过 | 6/8 | 7/8 |
| 全轮通过的对话 | 4/6 | 5/6 |
| 有证据正例通过 | 5/5 | 5/5 |
| 类别不足负例完成 | 1/3 | 2/3 |
| 额外接收目标次数 | 2 | 0 |

38项固定回复判据由Codex逐条审阅并经独立交叉审阅，35项通过；每条review绑定arm/case/turn、实际replyHash及固定criteriaHash。随后复用独立scorer回算；不是人工验收或盲测。完整结果和实际回复见[合成结果摘要](../data/c1-category-session-development-results.json)，执行前合同见[manifest](../data/c1-category-session-development-manifest.json)和[用例](../data/c1-category-session-development.json)。

### 失败、局部收益与未覆盖项

- **003及005第1轮：** v1按同名午餐商品套用常规周末规则，误接收`KB-SHOP-DEMO-1`并回答可用。v2实际fresh读取`product-demo-3`，门控为`unknown/product_category_unknown`，目标在support前被排除、该轮0support，实际回复说明缺少适用规则并建议核实。两次改善确实走过共享门控，没有把替身行为当成模型修复。
- **004第2轮：** v1选择standalone、重新读取未知SKU，检索后无证据并正确停止；该轮没有support，不能称为v1类别能力。v2也成功授权读取变更后的SKU，但Agent选择previous，宿主发现旧话题范围与fresh商品不匹配，先要求选择话题，未执行`search_faq`、rerank、support或类别门控。安全边界保留，但完整问题没有被完成，按原gold记失败；不能说v2已经验证切商品后的类别阻断，也不能凭一次配对认定类别开关导致了动作差异。
- **已知午餐、晚餐、004首轮、假设规则和资料覆盖：** 两臂5个正例全部保留；本批没有出现支持模型因类别事实不可见而误拒。它只说明本批通过，未证明以后不需要明确类别事实输入。006始终是当前商品资料覆盖问题，不与rule_only混淆；资料缺失不升级为安全判断。
- **工具修复：** 005-v1第2轮首次rule_only basis不是原文逐字片段，被协议拒绝，在既定repairBudget=1内修复继续，造成额外一次Agent请求。0模型错误、0support invalid不等于全链路零错误。
- **措辞局限：** 002-v2“不含法定节假日”容易把未知说成禁止，宜明确“节假日规则未录入”；004/005部分回复反复强调没有“普通周日专条”，弱化普通周末已含周日的一般解释。保留此观察，没有事后新增或修改本批gold。

### 请求、费用与来源审计

实际60次HTTP全部200：Agent 33、rerank 15、support 12，均低于48/16/16硬限。总tokens 304329，合计估算USD **0.024717876**与CNY **0.0088985**分列；不是账单。费用、tokens未知项0，SDK自动重试0，0真实DB/QQ请求。

| 实际记录 | v1 | v2 |
| --- | --- | --- |
| Agent / rerank / support HTTP | 17 / 8 / 7 | 16 / 7 / 5 |
| tokens | 160143 | 144186 |
| 估算USD | 0.013114332 | 0.011603544 |
| 估算CNY | 0.004691 | 0.0042075 |
| 轮次P50 / P95（ms） | 4591 / 5797 | 4150 / 5060 |

单次费用与延迟受缓存、一次协议修复和v2一轮未走知识链影响，不能归为同质量生产收益，也不把所有support减少都归于类别门控。

独立审计重算54来源：工作树、manifest、执行提交blob及raw前后哈希全部相同；五个实际运行依赖项和本地package双SHA稳定，唯一attempt锁、16轮原始score重建、实际请求绑定与用量核验通过。`runIntegrityPassed=true`表示记录完整性，语义失败仍保留。无真实业务写入，隔离内存fixture已清理；原始记录仅本机保留。

- manifest SHA256：`2829b00d3e9e4f438fa21b83a7f08e48ee1d5ef0abd54bbb10dd453fe1f34df7`
- configuration SHA256：`caa7719754fc9072c780a6b69e60bba9c1f14b68ecfe0c4fc3766adeb120f97c`
- raw SHA256：`e79c503d7c59f5d3a53798c9a08093271eb604f2ed75ecbe411320de036ec627`
- raw位置：`.runtime/c1-category-session-development/2312d6af-0088-484c-913e-69ffc182fbc0.json`

### 决定与下一步

保留显式类别候选及其工程边界。本批修复两次未知同名误用、保留5/5正例，但切商品续问出现未完成问题，仍只有一个开发配对；不称整体C1准入，不切默认，不追加同题追分。

下一轮先研究“完整重述当前订单问题”与previous话题迁移的合同，避免旧范围污染同时减少多余澄清；按实际Session读取与来源证明设计工程回归，不能给组件人工预填正确命题。渠道时限仍按独立方案评估收益，尚未实施。先明确合同、收益与新预算，再决定是否启动新模型场景；共同业务、完整O4/O5和常驻QQ重启仍待后续。
