# C1 v2.2 开发适配与评分合同

本页记录 `c1-context-runner-v3.1-adapter` / `c1-supplied-action-scoring-v2`。它修复评测适配，配合新的 v2.2 宿主动作协议；**不是新验证集，也不证明模型理解自然语言**。旧题、gold、来源 manifest、原始 artifact 和[首次结果报告](c1-context-results.md)均未改动。

## 输入与动作分开冻结

[独立动作适配表](../data/c1-context-action-adapter.json) 显式列出 31 组既有问题对应的 `kind`、`orderRef`、`questionContext` 和必要的原文商品片段；[冻结 manifest](../data/c1-context-action-adapter-source.json) 将内容 SHA-256 `539602f6f2e439a8941660a49612b13bc57f753d89b9268cb4b3952cca95532b` 与 original / development / validation-v2 / validation-v3 四份原数据 hash 绑定。

这是测试作者提供的动作 oracle：动作、是否续接、应否比较金额、明确商品片段都不是模型判断的结果。运行时只能填入真实 warmup 返回的 requestId，不能伪造正确引用。artifact 明确保存 `fixtureActionsAreOracle=true`、`naturalLanguageUnderstandingEvaluated=false`、`modelActionSelectionEvaluated=false`。后续生产 Pi Session 的实际动作选择须另外验证。

## 前序和授权证据

- 每个声明的 prior 都实际执行；不先调用被测 resolver 决定要不要建立前序。多个 prior 都保留执行记录，当前不任选某一个 topic。
- prior 原问含其订单号才用 `explicit`。不含订单号则使用实际 order 查询已建立的 `focus`；必要时增加明确标记的 fixture order 前置调用，保持原 prior 文字不变。
- `fixturePreparation` 记录声明、尝试、建立的 topic 数及是否选择了唯一 topic。声明成功的前序未取得证据时作为错误保留，不能静默略去。
- fresh 授权用当前 result 中成功的 `get_order`、正确 parent requestId、输入 orderId 和 `evidence.order` 一致性验证。顶层 `verifiedOrderId` 只是状态续接输出，不再作为所有成功分支必返的授权凭据。
- online 和隔离 reference 都使用真实 Controller 入口。reference 只注入参考 corpus，不导入业务数据库。
- 缺失 / 多义前序和金额引用会提交不存在的 requestId，由宿主拒绝；有有效引用的行还增加一次无效 ID 探针。拒绝必须无知识请求、无规则、无副作用，不是通过一律预填 clarify 得到高分。单纯金额上限超范围案例例外：它明确提供 clarify 并保留旧能力合同失败。

## 新旧评分分开

原 `effectiveQueryMustInclude` 完整保留，但只输出 `legacyDiagnostics.missingEffectivePhrases`。例如“实际付款金额”不因没出现“实付”两字被判语义错误。硬检查改为原问保留、实际 fresh 事实、订单 / 商品范围、被使用的前序 requestId、金额来源与数值。原始严格分数留在旧 artifact，不重新计算覆盖。

v2.2 的 `paid_amount_compare` 是纯数据库金额比较：当前必须重新读授权订单，核对宿主展示来源，产生实际 `amountComparison` 和 `refundApproved=false`，当前 `knowledge.length=0`、`rules.length=0`。旧 fixture 声明的历史咨询仍按输入重放并独立计入 warmup；这不代表当前金额动作需要检索。金额的新指标在 `amountFactsContract` 单列。**旧 PARTIAL gold 不改，也不能宣称已通过该旧检索合同**；`originalPositiveContractsNotPassedByAdapter` 和逐行诊断明确记录此变化。

`dev-002` 要求退款申请上限，仍未支持。适配表提供澄清，但保留“旧 resolved 上限合同未通过”的诊断，不能把澄清替换旧 gold 或将它称作上限能力成功。

知识动作真实判别时仍严格比较原 gold 和实际接收集合。因此 v3-003 多收 PAYMENT 会继续失败，不能将不适用的旧订单政策补进 gold。旧指标若输出只作为 legacy label 诊断；`admission.status=not_applicable_to_original_validation`，适配通过不能替代原验证准入。

## 本轮离线检查

```sh
node scripts/c1-context-check.ts --schema-only --split=validation-v3
node scripts/c1-context-check.ts --split=original --knowledge-support=typed
node scripts/c1-context-check.ts --split=development --knowledge-support=typed
node scripts/c1-context-check.ts --split=validation-v2 --knowledge-support=typed
node scripts/c1-context-check.ts --split=validation-v3 --knowledge-support=typed
npm run typecheck
```

未使用 `--live`，未调用任何 API。offline transport 为不读 gold 的词面排序与固定格式接收替身；`semanticScored=false`、`metrics=null`、`admission=null`、真实用量为 0。它只检查协议接线、前序确实建立、fresh 授权、引用拒绝、金额及范围，不能把“直接无答案”分层的工程通过说成模型拒收正确。

本轮工程检查：original 的 query-only 6 + contextual 21、development 7 + 21、v2 的 6 + 18、已曝光 v3 的 12 + 24 均通过。不存在或多义引用探针分别 22、16、16、24 通过。独立金额事实合同在 original、v2、v3 各 1 例通过且当前知识请求为 0；development 的上限能力继续列为旧合同未通过。词面诊断仍保留，不用同义词字面差异压低能力分数。

后续 `c1-context-runner-v3.2-adapter` 仅增加 `--knowledge-support-model=configured|deepseek-v4-pro`。默认 `configured` 解析环境中的 `MODEL_PROVIDER` / `MODEL_ID`；固定 Pro 只替换支持判别模型，不影响动作模型、题目或判别 prompt。工厂校验注入 mock 与选择的模型一致；离线 transport 仍为替身，不能据此声称 Pro 已实际运行。artifact 的 `configuration.knowledgeSupportModel` 保存所选项，`observedSupportSettings` 保存 trace 中实际出现的支持判别设置（含 provider/model）；未进入支持阶段时保持空数组，不推测实际调用。该开关与 `--knowledge-support=typed`、`--threshold` 相互独立。

实现入口为 [C1 runner](../scripts/c1-context-check.ts)、[v2.2 动作 schema](../src/support-context-action.ts) 和 [Controller](../src/support-controller.ts)。本适配回放没有新的验证数据、付费实验或原始结果重写；后续另一个使用真实 Pi Session 的 10 对话开发运行已执行，独立报告见 [真实动作链结果](./c1-session-results.md)，不能与本页提供动作的 oracle 回放混算。
