# 正式入口的模型请求预算与脱敏记录

本项解决一个具体问题：一条用户消息可能触发多次模型调用、工具循环和连接重试，仅记录最后一段回复的 Token，无法解释这一轮实际发送了多少请求；无限继续调用也缺少明确停止点。

当前在每次受理的 CLI、QQ、网页消息或宿主事件外建立 `withModelTask` 作用域。同一轮的主 Agent、候选 question 解析、support 判断和 rerank 共用 HTTP 预算。**一轮是一条入口消息或事件，不是跨多轮的完整退款业务。** 原默认 atomic + lexical 不变；候选未因此升级为默认。

## 范围、配置与复用边界

| 项目 | 当前合同 |
| --- | --- |
| 单轮默认上限 | 12 次底层 HTTP transport 调用，网络失败、429/5xx 及重试均计数 |
| 配置 | `MODEL_TASK_HTTP_LIMIT`，严格十进制整数 1..64；省略取 12，不接受空串、空白、前导零、小数或越界 |
| 快照 | 每轮摘要保存实际 `limits.httpRequests`，不是仅记录环境变量名称 |
| 达到上限 | 第 N+1 次在调用底层 transport 前拒绝，取消共享信号；后续再试仍不能联网 |
| 同轮重试 | 每个真正的 fetch attempt 分别计数，logical call 和 HTTP attempt 分开 |
| 嵌套驱动 | 网页调用 CLI 回复驱动时复用外层 requestId、预算、信号；不重复生成完成日志 |
| 并发 | `AsyncLocalStorage` 绑定异步执行链；同一个 runtime 的不同 QQ/网页会话不共享计数 |
| 本地 faux | Pi 原生 faux 明确记为 local call、HTTP=0，不采信其合成 Token 为真实用量 |
| 网络接口 | 当前完整接入 `openai-completions` 的 HTTP SSE，以及百炼 rerank/embedding 的 JSON HTTP；未接入的 API 或 WebSocket 在正式 scope 中拒绝 |

复用 Pi 的工具循环、凭据处理、模型目录、provider 请求构造及会话自动重试。项目只在单个 Session 的原 `streamFunction` 外注入 fetch，保留原有 runtime 和 hooks；不改 Pi 核心，不替换全局 fetch，也不在共享 runtime 上保存“当前用户请求”变量。

未进入 `withModelTask` 的旧评测或独立脚本保持原行为，不能据此声称这些运行已有正式入口预算。独立运行器需要显式建立 scope 并接入受控 transport。业务工具、MySQL、QQ 发送次数不属于这个 HTTP 模型预算；它不能充当支付限额、总费用硬上限或跨进程账户额度。

## 源码入口与 API

- [model-request-budget.ts](../src/model-request-budget.ts)：作用域、终止状态、严格配置、实际 dispatch 计数和单路响应观察。
- [agent.ts](../src/agent.ts)：每个 Pi Session 的主模型 transport。
- [support-question-client.ts](../src/support-question-client.ts)：保留原 question wire 合同，在其底层 transport 记录 question 阶段。
- [evidence-support.ts](../src/evidence-support.ts)：native completion 的 support 阶段。
- [bailian.ts](../src/bailian.ts)：rerank/embedding 的实际 HTTP 调用。
- [cli.ts](../src/cli.ts)、[qq-agent.ts](../src/qq-agent.ts)、[web-chat.ts](../src/web-chat.ts)：正式入口与业务阶段归因。

入口采用以下结构；示例展示 API，不是业务实现替代品：

```typescript
await withModelTask({
  requestId, entrypoint: "qq", trigger: "user", limits,
  onComplete: summary => log(JSON.stringify(summary)),
}, async task => {
  task.setPhase("authorization");
  // 验权、会话、宿主回执、模型、渲染、发送和展示登记仍由原入口执行。
  task.setPhase("model");
  await session.prompt(text);
});
```

`currentModelTask()` 供内部发送等辅助函数取得当前任务，避免为每次发送新建 scope。`task.setPhase` 使用 `authorization/session/host/model/render/send/receipt` 固定枚举。入口已经 catch 的失败须显式 `task.fail`，不能因为异常没有继续抛出就记为成功。首次失败的阶段与原因保留；发送未知后补发说明成功，或清理时触发 abort，都不会抹掉首次失败。

`task.cancel()` 终止当前请求作用域并阻止晚到网络。已有业务失败的清理取消保留 failed 状态；第一次事件就是取消则记 canceled。HTTP 预算停止保留 http_limit。已经形成的持久业务回执由原业务代码继续处理，不因为模型预算用尽而再准备或执行一次业务。

## 一次逻辑调用与多次 HTTP

`createModelRequestFetch` 为一次模型调用建立包装器。它首次到达 dispatch 边界时登记 logical call，每次实际调用底层 transport 时登记一个 attempt。若运行器覆盖了 Session 包装器，却从未使用原包装器，原包装器不产生虚假的调用记录。

Pi 的 `before_provider_request` 扩展不能作为硬拒发边界：当前 SDK 会捕获扩展异常并继续返回 payload。当前预算检查位于真正 fetch 之前，因此不依赖该 hook 的异常传播。模型自动重试、provider retry 和工具后的第二轮模型请求最终都必须经过同一 dispatch 检查。

有独立批次预算的实验运行器，应把批次 guard 作为包装器的底层 transport，避免用 override 绕过正式预算。只有批次 guard 能明确证明尚未调用其底层 fetch 时，才可抛 `ModelRequestNotDispatchedError`；此时撤回这次预留 HTTP 计数、保留 blocked 记录并停止当前 scope。真实网络错误或发送状态不明不得转成此类型。

## 记录什么，保留哪些未知

完成摘要包含 requestId 的 SHA-256、入口、触发类型、阶段、首次失败阶段/固定原因、时长、实际预算、logical/local/HTTP 数量，以及脱敏 attempt。attempt 保存配置的 provider/model、`agent/question/support/rerank/embedding` 调用来源、序号、HTTP 状态、完成状态和有依据的用量。

不保存请求正文、用户文本、工具参数和结果、完整 URL、header、API key 或自由文本错误。`onComplete` 抛异常不会触发业务重试。这里只输出结构化摘要，没有新增监控平台或数据库表。

用量从实际响应单消费路径读取，不使用无界 `response.clone()` 后台读取。SSE 缓冲最多 64 KiB，JSON 缓冲最多 1 MiB；超过观察上限仍把原响应交给原消费者，但该 attempt 的用量保持未知。OpenAI SSE 需要正常协议结束、finish 标记、匹配模型和合法 wire usage；SDK 收到 `[DONE]` 后正常取消 reader 也属于协议完成。显式 abort、半流、缺少 usage、非法计数或模型不匹配均不补零。

| 字段 | 含义 |
| --- | --- |
| `knownTokens` | 有明确 wire 用量的已知部分之和 |
| `unknownUsageAttempts` | 未知用量的实际 HTTP 数量 |
| `totalTokens` | 存在未知 attempt 就为 null；纯宿主路径无调用时可为 0 |
| `knownCostUsd` / `knownCostCny` | 各币种已知估算部分，分别求和，不混币种 |
| `unknownCostAttempts` | 无法估算费用的 HTTP 数量 |

已知费用是按照当前项目审阅的价格合同计算的估算，不是供应商账单。DeepSeek 等使用 Pi 目录费率；已审阅百炼快照遵循项目人民币费率和输入分档限制；北京 rerank 沿用已有每百万 Token 0.5 元的估算合同。超出已审阅分档、缺用量或费率不可用时费用仍未知。不能把 `knownCostUsd=0` 解读为整个任务免费。

## 验收与停止条件

执行 `node scripts/model-request-budget-check.ts`，使用假 transport、本机 HTTP 服务和已安装 Pi 原生 provider；不调用远程模型、MySQL 或 QQ。专项覆盖：

1. 默认及非法配置、宿主零调用、嵌套复用、并发隔离、首次失败与清理取消。
2. 实际 429/重试、工具循环、第 N+1 次和结束后晚调用拒发，已完成工具不为补答复重复执行。
3. 正常原生 SSE 的 `[DONE]` 消费方式、缺用量、半流、显式取消、非法 usage 与模型不匹配。
4. question/support/rerank 真实调用点归因、人民币与美元分列、日志不包含合成敏感正文。
5. 批次 guard 明确拒发与真实网络错误的不同计数。

入口故障与嵌套作用域另由 `node scripts/model-task-entry-check.ts` 检查；本轮 M2 专项和冻结前完整 `validate` 已通过。工程检查不能证明实际模型语义效果、远端收到取消后立即停止或供应商不再计费。

2026-10-10 的 [M1 冻结批次](stable-joint-acceptance.md) 已实际接入本模块：正式单轮账本与实验 transport 记录均为 40 次 HTTP，已执行请求的用量和费用估算均可核对，没有未知项。该批**联合通过 20/26、未准入**；记账完整不等于答复和业务任务全部通过，也不代表所有正式入口均做过远程模型验收。其他运行缺失的用量仍保留未知。

完整 payload 与输出预留已按 [M4 上下文预算合同](context-budget-contract.md) 接入同一 transport，正式默认 65536 本地预算单位，独立真实验收参数 30000；纯检查及最终完整 `validate` 通过，独立真实批次四题结构检查通过（6 次 HTTP、22,001 Tokens），结果和答复审阅见该合同；它只验证声明的只读合成夹具与上下文控制。`limits.contextBudgetUnits`、`contextChecks` 分别保留实际阈值、最终 UTF-8 body 字节、实际输出预留、固定余量、目录窗口和经过白名单过滤的 SDK 投影估计。超限记 `context_limit`，非法或冲突输出字段记 `context_invalid`，两者均拒发而不伪造 attempt。M2 的请求次数上限、M4 的本地上下文预算和供应商实际 Token 用量是三种口径；新增 M4 后的最终源码与检查记录须单列，不能继承 M1 旧版本的模型成绩。自动语义摘要和通用长期记忆不在这两项交付范围内。
