# C1 v2.2 真实 Session 开发结果

2026-10-06：最新 typed v5 + Pro + declared 单次开发回归 **10/10 对话、20/20 轮**，首次动作 16/20。此前各次失败原样保留。**随后新固定验证为15/24，C1未准入**（见[独立批次](./c1-session-validation-results.md)）；独立语言诊断 7/8、商品类别依据不足的歧义仍保留。使用真实 Pi Session 及模型动作选择，订单为受控内存 fixture；未调用 QQ、MySQL 或真实商家/资金接口，未逐例评分全部自然语言答案质量。

## 实现与验证分工

v2.2 复用 Pi 工具循环，只暴露一个 `support_action`。模型选择 explicit / focus / alternative 订单引用、standalone / previous 问题引用或 paid_amount_compare；宿主验证原文、实际 requestId、用户/群绑定和候选唯一性，再读取当前授权订单。身份、金额、批准、确认与业务写入仍由宿主控制。

跨订单续接只保留适用的退款资格意图，不能把旧订单的状态描述带入新查询。实付比较直接核对数据库事实与真实展示来源，本轮知识调用为 0；不代表退款上限、部分退款能力或商家批准。旧 v2.1 只用于历史 Controller 回放，当前 Session 必须提交 v2.2。

这解决了旧 runner 直接提供动作、未真实验证模型引用选择的问题。[旧题动作适配](./c1-runner-contract.md)只做工程回放；本套件的输入只有用户消息，不预填 action、requestId 或成功话题。后序依赖前序实际结果，失败就保留未执行项。

## 冻结与首次成绩

- 数据与来源：`data/c1-session-development.json`、`data/c1-session-development-source.json`。各对话新建 Session，online 8 篇演示政策与 reference corpus 分开。
- 配置：动作模型 deepseek-flash；独立支持模型 deepseek-v4-pro；typed v3、阈值 0.5、repairBudget 1；rerank/support 零重试。Session 自动重试配置为 2，但本次实际重试为 0。
- run：`5dec8496-33c8-4708-81ed-6ccc08937637`；原始报告 `.runtime/c1-session/live-development-<runId>.json`，SHA-256 `011111da384dd79552a7d5dafa6781b2ae88a231c300a3dfa6ae67ecf890058c`。报告保存源码前后 hash，`codeStable=true`。
- 每轮上限 60 秒，全局 HTTP 上限 70；实际 55。10 个 Session 均已销毁，合成订单全部清理。

| 指标 | 首次结果 |
| --- | ---: |
| 完整对话通过 | 9/10 |
| 用户轮次通过 / 失败 / 未执行 | 18 / 1 / 1，共 20 |
| 六类正例 / 四类缺引用或歧义 | 5/6 / 4/4 |
| 首次动作正确 | 16/19 已执行轮；16/20 计划轮 |
| 修复后已执行动作正确 | 19/19，另 1 轮未执行 |
| 计划知识轮 | 8：6 通过、1 格式失败、1 未执行 |
| HTTP 请求 | Agent 41、rerank 7、support 7 |
| Agent / support 目录估算 USD | 0.012002904 / 0.008932704 |
| rerank 估算 CNY | 0.0081985 |
| 9 个已执行最终用户轮 P50 / P95 | 2758 / 6360 ms |

3 次首次动作把历史订单写成 explicit，被宿主在业务执行前拒绝，模型在预算内改为 focus。不能只报告修复后的 19/19 而隐去首次错误。金额比较、备选订单、普通周末和退款渠道续问，以及缺引用/三订单歧义均完成本次开发合同。

唯一失败是预约场景的前序规则咨询：Pro 返回 `invalid_response`；未形成成功政策话题，因此“他的同意”续问没有执行。前次原始模型输出未保存，细因未知。随后单次同输入诊断发现一篇 limitation_only 引文把半角逗号改成全角，整批拒收；详见 [判别对照与诊断](./c1-support-model-results.md)。后一次结果不能用来证明前一次必为同因，也不能修正原 9/10。

## 逐候选隔离后的完整回归

run `9b14fe45-dbb1-4605-9a8c-c0bd784184e6` 于北京时间 2026-10-06 03:06:26–03:07:28 完成，仍为 Flash 动作模型 + Pro 支持模型、typed v3 / 0.5；解析版本为 `typed-candidate-isolation-v1`。本轮输入和 gold 未改，加入了业务合同与判别完整性的分层评分。原始 `.runtime/c1-session/live-development-<runId>.json` SHA-256 为 `c527e3768a6ae54385bda6f0d08cf9e98feb4678a784cb278361e4c93bea60e7`，`codeStable=true`。10 个 Session 全部销毁，无预算耗尽或遗漏轮。

| 指标 | 本轮实际结果 |
| --- | ---: |
| 严格对话通过 / 业务合同通过 | 7/10 / 8/10 |
| 严格轮次通过 / 失败 / 未执行 | 17 / 3 / 0，共 20 |
| 业务合同通过轮 | 18/20 |
| 首次动作正确 / 最终动作正确 | 16/20 / 19/20 |
| 知识调用 | 计划 8，实际 9；无话题轮多调用 1 次 |
| 判别完整性 | complete 8、partial 1；已知 invalid 候选 1 |
| HTTP 请求 | Agent 43、rerank 9、support 9，共 61/70 |
| Agent / support 目录估算 USD | 0.010680624 / 0.008010992 |
| rerank 估算 CNY | 0.012300 |

Agent 243,964 tokens、support 11,690 tokens、rerank 24,600 tokens，用量完整；USD 合计 0.018691616，币种不混加，均为估算而非账单。实际 SDK 重试为 0。不能将本轮与首次运行的不同输出及更严格的完整性分层直接解释为单组件提升或退化。

三个失败轮分别是：

1. `session-alternative-order/3`：当前授权订单只有 1 张未核销券，正确 gold 为 UNUSED；Pro 同时接收 PARTIAL 和 REDEEMED，忽略整篇规则的多券 / 已核销适用前提。切单、fresh 授权和目标订单正确，错误位于证据接收。实际答复明确本单只有 1 张未核销券，并说 REDEEMED 暂不适用；不能写成已经发生错误退款决定或将订单状态捏造为已核销。旧接收层失败保留。
2. `session-appointment-topic/1`：RS003 有效规则成功接收，真实生成 topic，第二轮也完成；RF003 的引文仍为 invalid，记录 partial。业务合同通过，完整性未通过，RF003 不计为正确拒收。只看最后一轮成功会遗漏这个前序失败。
3. `session-missing-topic/1`：没有前序 topic，模型却提交 standalone 并查询 RF005，违反冻结的先澄清引用合同。实际回复列出各渠道时限，并以“如果超过 7 个工作日”为条件给建议，没有声称用户已经等了 7 天；因此不能计为事实捏造。若产品未来允许条件式通用帮助再澄清，需另定合同；本次不回改 gold，而且回复只询问订单，仍没有确认“这个时间”具体所指。

以上是 Codex 对失败轮的逐例复核，供人复核，不等于全部回复已完成真人验收。与此同时，[真实 MySQL 业务回归](./c1-business-results.md) `0082f06e-60d5-43c1-a797-488e84b461d4` 为 14/14、24/24；其不同业务合同不覆盖或抵销这里的 C1 失败。

## typed v4 + fresh 券计数的单次开发回归

run `4417a40f-87ae-44cf-babb-43129eca2e43` 于北京时间 2026-10-06 03:26:21–03:27:08 完成，Flash 动作模型 + Pro / typed v4 / 0.5，保留逐候选隔离，资格 query 加入本轮授权订单的券数量及各状态计数。原始 `.runtime/c1-session/live-development-<runId>.json` SHA-256 为 `78f15c810660dbd7ecf301dd74120a632aa059b83429ff9d25547f50604a689c`；`codeStable=true`，10 个 Session 均销毁，fixture 剩余 0，无预算耗尽。Prompt、Controller 与主业务提示一并调整，本次是同题开发回归，不能将差异归因于某一个组件。

| 指标 | v4 本轮结果 |
| --- | ---: |
| 严格 / 业务合同对话通过 | 8/10 / 8/10 |
| 严格轮次通过 / 失败 / 未执行 | 17 / 2 / 1，共 20 |
| 首次动作正确 | 15/19 已执行轮；15/20 计划轮 |
| HTTP 请求 | Agent 40、rerank 6、support 6，共 52/70 |
| 实际知识查询 / 完整判别 | 6 / 6；invalid 0、partial 0 |
| Agent / support 目录估算 USD | 0.011688396 / 0.010750872 |
| rerank 估算 CNY | 0.0096345 |

Agent 231,052 tokens、support 10,299 tokens、rerank 19,269 tokens，完整计量；USD 合计 0.022439268。实际执行的 6 次知识查询均接收完整预期 gold、无额外证据，但计划知识轮为 **8**：周末前序在检索前澄清，其续问未执行。summary 的 `measuredTurns=7` 包含前序没有 trace 的未完成目标，不代表发了 7 次知识请求，不能将实际 6/6 宣称为完整计划 8/8。

上一批的另一单资格误接收、缺话题误用 standalone 和预约 partial 在这一次分别通过；不追改上一批成绩。新出现的失败是：

- `session-weekend-topic/1`：用户说“订单 COUPON-1001 对应的常规午餐套餐”，模型提交 `productMention=常规午餐套餐`；fresh 商品名为“双人午餐团购券”，宿主按连续子串匹配保守澄清。产生一次成功授权 `get_order`，没有知识调用；第 2 轮保留 skipped。
- `session-missing-decision-maker/1`：模型只输出澄清文字，没有调用 `support_action`。用户实际收到的是宿主固定“本轮未形成有效业务动作”提示，不是模型那段文字。无业务调用及越权，但缺少合同要求的结构化澄清结果，继续计失败。

周末题存在未明示的产品消歧合同：[`products`](../db/01-schema.sql) 没有可信别名 / 分类映射；[seed](../db/02-seed.sql) 只给“双人午餐团购券”“两人午餐套餐”，店铺规则说“常规午餐与晚餐套餐允许普通周末使用”，但未显式建立“常规午餐套餐 → product-demo-1”的关系。旧题与 gold 延用了作者的语义理解，不能仅因期望未满足就认定宿主必须放行。保留原失败及 gold，下一步先决定：无可信别名时展示 fresh 规范名称并请求用户确认；或用有来源、版本、门店 / SKU 范围的别名关系支持首轮消歧。不能悄悄删修饰词、按“午餐”字样跨商品匹配，或把规则文本反过来当授权映射。

随后独立 [MySQL v4 业务回归](./c1-business-results.md) `0227d537-761a-48f9-ae6f-3d0ed82f7a63` 通过 14/14 案例、24/24 轮、172/172 断言，16 张测试订单剩余 0；原 `0082...` 仍是 v3 历史证据。该业务合同不覆盖这里的两处失败，也未精确约束全部接收证据，本轮业务 trace 仍保留单券额外接收多券规则的风险。Session 成绩继续为 8/10，新 24 对话尚未生成，C1 未准入。

## 后续与复现

逐候选隔离、typed v4 与 fresh 券计数已经完成上面各自范围的工程检查、Session 开发运行及 MySQL 业务回归；仍需明确产品消歧合同、解决结构化澄清缺失，并处理规则适用性风险。候选稳定后才冻结新的 24 对话；当前仅有 [合同草案及纯评分检查](./c1-session-validation-draft.md)，未创建最终题或调用该验证集。

工程检查不产生模型调用：

```sh
node scripts/c1-session-live.ts
node scripts/support-session-check.ts
node scripts/support-controller-check.ts
npm run validate
```

当前完整 `npm run validate` 已通过。另用真实 Pi Session + faux 验证取消期间的晚结果不发布、已完成收据保留、新旧轮引用隔离；这是工程修复，不重算此前模型运行。通知夹具已明确发送 v2.2，原身份、通知和幂等断言保留。工作台由 Kimi K3 Max 增加判别模型选择；浏览器核对预设/配置下载、非法组合可修复、1440/390 px 历史运行取证展示及 A/B 页面，0 页面错误、0 远程实验提交。浏览器使用历史真实运行验证渲染；本次受控内存 Session 没有写入 MySQL，真实数据库结果以另行执行的业务 run 为准。

真实开发运行命令会付费，并保留独立 run ID，不覆盖首次报告：

```sh
node --env-file-if-exists=.env scripts/c1-session-live.ts --live
```

此前 `990dac49-10c3-46ab-a6dd-fdcb6e0c8f69` 的 14/14、24/24 是旧协议 / typed v2 的 MySQL 业务回归；后续 v2.2 + Pro 的 typed v3 与 v4 分别使用独立 run `0082f06e-60d5-43c1-a797-488e84b461d4`、`0227d537-761a-48f9-ae6f-3d0ed82f7a63`，不覆盖历史报告。上面的命令运行当前源码，会产生新的开发记录，不会恢复上述冻结版本。默认 QQ 配置、atomic 架构和 lexical 检索保持原值。

## 原生动作约束与 declared 前提首批（2026-10-06，typed v4）

完整旧开发集 run `2e97898b-ee0f-4932-9c97-00ba76cf4cf7`：**9/10 对话、19/20 轮**，1 轮失败、0 跳过，首次动作正确 17/20；最终动作及引用 20/20。59 次实际 HTTP = 43 Agent + 8 rerank + 8 support，用量完整、SDK retry 0、源码稳定。估算 USD 0.01742301（Agent 0.010230594 + support 0.007192416）+ CNY 0.0107825。实际知识查询 8/8，判别及 declared 完整性 8/8、invalid 0；证据集合 7/8 正确，没有额外误接收，缺少一项 SHOP gold。

漏工具的 missing-decision-maker 本批通过。唯一失败为 weekend/2：宿主已提供上一轮“普通周末”的成功取证话题，SHOP 排名 1、分数 0.6977303，通过阈值；support 把“原文未明确星期天属于普通周末或特殊限制”作为拒收理由，归 limitation_only。这是支持语义过严，不能归因为召回失败或元数据门控。商品词槽本批首轮被模型省略，故没有触发规范名称澄清；槽位匹配是条件性保障，不能宣称模型总会完整抽取商品描述。

独立新增 `product-clarification` 开发合同 run `46fa5ee4-6d5b-4b6d-814f-f68347d3628a` 为 **1/1 对话、2/2 轮**：提供商品槽时先按 fresh 规范名称澄清，再以订单号、规范名称及完整问题重新取证。7 次 HTTP = 5 Agent + 1 rerank + 1 support，首次动作正确 1/2，有一轮用到原有修复；SDK retry 0，用量完整、源码稳定。估算 USD 0.00256038 + CNY 0.0005285。它不替换原 10/20 的问题、gold 或分数。

产物字节 SHA-256：完整开发 `c94ab8b8688cc2e1bbb7cc0629e573e045a63cdf7cee754347374a991f2c3570`；商品补充 `3886af687f8fc13eae63be9eeeeee87eb8ec0e7cba8be67e821fc6b22c3b853b`。本批仍未通过 C1；下一候选区分必要语言理解与缺失业务事实，保留旧失败，不通过特判星期词或 sourceId 追分。

## typed v5 + declared 单次开发回归（2026-10-06）

保持原 10 对话 / 20 轮、gold、模型、阈值与新门控不变；typed 提示由 v4 改为 v5，并明确当前“生成 / 再次生成方案”应交给 prepare 流程及宿主幂等，而不因已有方案改成纯状态查询。本批是这组改动的一次完整开发回归，不归因于单一组件。

run `c041e1b3-9554-4721-ab96-f6959336f5f8` 为 **10/10 对话、20/20 轮**，首次动作 16/20，修复后动作 / 引用 / 业务合同 20/20。8 次知识请求均满足原 evidence 集合，额外接收、缺失、invalid、partial 为 0，判别及已声明必要前提完整性 8/8。SDK 自动重试 0、codeStable=true，10 个 Session 清理完成。最终回复未在此开发评分中作逐项语义验收。

实际 60 次 HTTP = Agent 44 + rerank 8 + support 8，计量完整；Agent 264,056 tokens / USD 0.011238876，support 14,224 tokens / USD 0.008358064，rerank 21,565 tokens / CNY 0.0107825；合计估算 **USD 0.01959694 + CNY 0.0107825**。artifact SHA-256 `42fa9207771e9dfe1dd9f791e8235731ad858753557a26ce80a5eed59c9f02ca`。

周末两轮均接收 SHOP，最终回执保留了普通周末、需确认接待和特殊节假日未知条件。但相同 v5 的单篇语言诊断仍为 7/8（周末失败），商品类别也未增加权威映射。完整链路通过不能抹掉这项输入差异与稳定性限制；此前 v4 的 9/10、v5 单篇失败均保留。独立商品消歧补充的 v4 2/2 只验证模型提供 productMention 时的宿主链，不能据此宣称所有别名都会被抽取或识别。

```sh
node --env-file-if-exists=.env scripts/c1-session-live.ts --applicability declared --live
```

候选可进入新 24 对话的固定验证准备；新题须另行审核、冻结和执行，不能将这 10 个已曝光开发对话改名为最终验收。
