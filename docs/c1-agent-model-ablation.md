# C1 主 Agent 模型对照

预声明：2026-10-06。这是在已曝光 24 对话 / 45 轮上的单次开发对照，不是独立验收或统计显著性实验。Flash 运行 `44837294-6b93-48a1-af8a-7b076448e48c` 已完成；Pro 结果尚未产生。不得删除失败、修改原题或用重跑替换任一组结果。

问题：`6f9a2f3` 修复金额选择、订单事实绑定及定向澄清后，Flash 仍出现常量协议字段遗漏、错误焦点/话题选择、澄清类别不准确。先测动作模型能力与成本的关系，再决定是否增加交互或状态复杂度。

唯一实验变量为主 Agent：`deepseek-flash` → `deepseek-v4-pro`。支持判别始终为 typed v5 / Pro，M4 rerank、declared 前提、threshold=0.5、repairBudget=1、同一代码/Prompt/Skill、原题/原 gold/夹具均不变。模型价格采用 Pi 目录估算，USD 与 CNY 分列；模型变更本身包含其目录费用差异，服务端随机性与缓存变化仍存在。

冻结文件为 `data/c1-session-pro-development-{setup,manifest}.json`。沿用每组 Agent HTTP≤120、rerank≤60、support≤60、每轮≤60秒、全组≤45分钟，以及 USD 1 / CNY 0.15 的软停止线；软停止线可能被最后一个已发请求越过。只执行一组 Pro，不因结果不佳立即重跑。

评估：完整计划分母下的对话/轮次、缺失/竞争安全停止、错误额外证据、知识召回、实际回复标准；同时报告格式/引用修复、终止失败、HTTP 数、轮次 P50/P95、币种独立费用及每个正确完成对话的估算成本。修复成功不抹去首次动作错误。全部实际回复需离线逐条审阅并绑定哈希，供人核验。

若 Pro 只改善语义选择，不能因此宣称宿主确定性消歧成立。若未达到既定 C1 门槛，继续保留候选并按失败类型处理；若达到开发门槛，再冻结新题独立验收。此实验不改变 QQ 或 atomic + lexical 默认配置，不新增模型阶段，不向真实商家或资金接口发送请求。

```sh
node scripts/c1-session-validation-live.ts --inspect \
  data/c1-session-validation.json data/c1-session-pro-development-manifest.json data/c1-session-pro-development-setup.json
MODEL_ID=deepseek-v4-pro node --env-file-if-exists=.env scripts/c1-session-validation-live.ts --live \
  data/c1-session-validation.json data/c1-session-pro-development-manifest.json data/c1-session-pro-development-setup.json
```
