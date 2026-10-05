# C1 v2.2 真实 Session 开发结果

2026-10-06：10 个对话通过 9 个；20 轮通过 18 轮、失败 1 轮、未执行 1 轮。**C1 尚未准入**。这是已曝光开发题，使用真实 Pi Session 及模型动作选择，订单存储是受控内存 fixture；未调用 QQ、MySQL 或真实商家/资金接口，也没有评自然语言答案质量。

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

## 后续与复现

下一步按 plan 版本化隔离可归属候选的无效判别；引文、语义、范围与原文复检不放宽，invalid 不计为正确拒收。完成工程边界检查后再跑预约真实两轮及 14/24 业务开发回归，候选稳定才冻结新的 24 对话验证。当前新验证仅有 [合同草案](./c1-session-validation-draft.md)，未创建最终题目，未请求模型。

工程检查不产生模型调用：

```sh
node scripts/c1-session-live.ts
node scripts/support-session-check.ts
node scripts/support-controller-check.ts
npm run validate
```

当前完整 `npm run validate` 已通过。另用真实 Pi Session + faux 验证取消期间的晚结果不发布、已完成收据保留、新旧轮引用隔离；这是工程修复，不重算此前模型运行。通知夹具已明确发送 v2.2，原身份、通知和幂等断言保留。工作台由 Kimi K3 Max 增加判别模型选择；浏览器核对预设/配置下载、非法组合可修复、1440/390 px 历史运行取证展示及 A/B 页面，0 页面错误、0 远程实验提交。浏览器使用历史真实运行验证渲染，不冒充本次 Session 已写入 MySQL 或当前模型已通过新业务回归。

真实开发运行命令会付费，并保留独立 run ID，不覆盖首次报告：

```sh
node --env-file-if-exists=.env scripts/c1-session-live.ts --live
```

此前 `990dac49-10c3-46ab-a6dd-fdcb6e0c8f69` 的 14/14、24/24 是旧协议 / typed v2 的 MySQL 业务回归。本轮没有重跑它，也不能把该历史结果作为 v2.2 + Pro 已通过的证据。默认 QQ 配置、atomic 架构和 lexical 检索保持原值。
