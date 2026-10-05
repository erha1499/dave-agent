# C1 主 Agent 模型对照

预声明：2026-10-06，执行前提交 `403356d`。这是在已曝光 24 对话 / 45 轮上的单次开发对照，不是独立验收或统计显著性实验。Flash 运行 `44837294-6b93-48a1-af8a-7b076448e48c`；Pro 运行 `5645bebc-26b9-4552-ab47-33fdf1eeb751`。下方结果在两组完成及实际回复审阅后追加，原始预声明可在该提交查看。未删除失败、修改原题或重跑替换结果。

问题：`6f9a2f3` 修复金额选择、订单事实绑定及定向澄清后，Flash 仍出现常量协议字段遗漏、错误焦点/话题选择、澄清类别不准确。先测动作模型能力与成本的关系，再决定是否增加交互或状态复杂度。

唯一实验变量为主 Agent：`deepseek-flash` → `deepseek-v4-pro`。支持判别始终为 typed v5 / Pro，M4 rerank、declared 前提、threshold=0.5、repairBudget=1、同一代码/Prompt/Skill、原题/原 gold/夹具均不变。模型价格采用 Pi 目录估算，USD 与 CNY 分列；模型变更本身包含其目录费用差异，服务端随机性与缓存变化仍存在。

冻结文件为 `data/c1-session-pro-development-{setup,manifest}.json`。沿用每组 Agent HTTP≤120、rerank≤60、support≤60、每轮≤60秒、全组≤45分钟，以及 USD 1 / CNY 0.15 的软停止线；软停止线可能被最后一个已发请求越过。只执行一组 Pro，不因结果不佳立即重跑。

评估：完整计划分母下的对话/轮次、缺失/竞争安全停止、错误额外证据、知识召回、实际回复标准；同时报告格式/引用修复、终止失败、HTTP 数、轮次 P50/P95、币种独立费用及每个正确完成对话的估算成本。修复成功不抹去首次动作错误。全部实际回复需离线逐条审阅并绑定哈希，供人核验。

若 Pro 只改善语义选择，不能因此宣称宿主确定性消歧成立。若未达到既定 C1 门槛，继续保留候选并按失败类型处理；若达到开发门槛，再冻结新题独立验收。此实验不改变 QQ 或 atomic + lexical 默认配置，不新增模型阶段，不向真实商家或资金接口发送请求。

复现使用冻结提交 `403356d` 对应源码；后续协议输入简化的局部检查见[实施结果](./c1-next-iteration-results.md#对照后的接口修复)，不能沿用本表成绩。

```sh
node scripts/c1-session-validation-live.ts --inspect \
  data/c1-session-validation.json data/c1-session-pro-development-manifest.json data/c1-session-pro-development-setup.json
MODEL_ID=deepseek-v4-pro node --env-file-if-exists=.env scripts/c1-session-validation-live.ts --live \
  data/c1-session-validation.json data/c1-session-pro-development-manifest.json data/c1-session-pro-development-setup.json
```

## 实际结果与选型

**保留 Flash 默认；Pro 保留实验候选，不据本轮切换。** Pro 改善部分工程动作选择，但未满足竞争指代、直接无答案误收及完整回复门槛，成本和延迟明显增加。两个执行中的所有冻结源码、依赖和实际配置均匹配；业务数据均为独立合成夹具，无真实 QQ/SQL/商业运行。

| 指标 | Flash | Pro |
| --- | ---: | ---: |
| 全合同对话 / 轮次通过 | 14/24；35/45 | 17/24；36/45 |
| 完成 / 失败 / 未执行 | 43 / 2 / 0 | 43 / 0 / 2 |
| 已知核心工程 | 4/6 | 6/6 |
| 缺引用 / 竞争安全停止 | 6/6；4/6 | 6/6；4/6，其中1竞争目标轮未执行 |
| raw / accepted Recall@5 | 71.43% / 71.43% | 85.71% / 85.71% |
| 直接缺事实误接收 | 1/4 | 1/4 |
| 额外错误证据 / 与预期对象不符的 scope | 3轮 / 2轮 | 2轮 / 0轮 |
| 实际回复标准通过 | 117/135；36/45轮 | 122/135；38/45轮，2轮无回复未审阅 |
| 首次工具输入有效 / 实际模型轮 | 37/45 | 37/43 |
| 工具错误次数 | 10（含2次最终取消） | 6 |
| HTTP：Agent / rerank / support | 96 / 18 / 17 | 92 / 19 / 17 |
| 轮次 P50 / P95 | 2085 / 5874 ms | 6037 / 15693 ms |
| 批次耗时 | 135554 ms | 293180 ms |
| Agent USD / support USD | 0.027778704 / 0.022658592 | 0.116477416 / 0.014829848 |
| 合计目录估算 | USD 0.050437296 + CNY 0.032034 | USD 0.131307264 + CNY 0.0352745 |
| 每个全合同通过对话的批次均摊估算 | USD 0.003603 + CNY 0.002288 | USD 0.007724 + CNY 0.002075 |

币种不换算，单位成本分母是各组通过对话数，包含失败调用费用。它不是同一业务流量下的生产单位成本；Pro 有2轮跳过、其他轮动作/调用也不同。P50/P95 采用实际有计时轮的 nearest-rank（两组均45计划，Pro计时43轮），未执行不计0ms。首次工具输入有效只衡量宿主格式/引用预检，不代表语义选择正确。

Pro 的 `runIntegrityPassed=false` 是完整执行门槛未过：012/1 将产品核销规则咨询选为 refund_eligibility，实际回答正确但未满足原预声明 action 合同，后两轮依赖按既定 runner 跳过。原分母和该失败保留，不能计为Pro已解决012竞争问题；不是哈希、身份、费用或清理校验失败。

Pro 仍未完成的业务合同：001/2 已退款规则排第6而未入Top5，正文只给未知；015/3 从竞争时限选择最近话题并给一般建议；018/3 澄清未问出主体；019/1 支持判别把具体过敏原诉求误当文档覆盖问法；021保持停车题范围适配失败；023缺少商家核实路径。018/023为回复合同，019实际回复诚实未知仍独立通过，不抵销错误证据。

主 Agent Pro 的 USD估算约为Flash的4.19倍；批次USD合计约2.60倍，P50约2.90倍。单次开发对照只能显示本轮取舍，无法证明可靠性提升。下一步依据[剩余问题](./c1-next-iteration.md#本轮执行后待解决的问题)优化工具输入负担、检索与取证上下文分工、竞争引用合同；不以继续升级模型代替这些改动。

原 raw SHA-256 `dad36aa62d7b5abf7a333d62b3e145bdcfe5be268684f969dc78f0309027c27c`；派生 reviewed SHA-256 `549fd62eb23d051893ea0f1c8150fc21f1729d7c54336a9dbb5538503f02d850`，本机 `.runtime/c1-session-validation/5645bebc-26b9-4552-ab47-33fdf1eeb751{,-reviewed}.json`。43轮实际回复均审阅，另2轮保留未执行/未审阅；逐条绑定 replyHash 与 criteriaHash，Codex供人核验，不称真人验收。两组全部实际HTTP费用已知，未触发停止线；两组均 admitted=false。
