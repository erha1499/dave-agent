# 百炼千问候选与模型选型建议

调研日期：2026-10-06。状态：普通百炼候选接入与工程验证已完成；未进行千问真实调用、未切换默认配置。

结论：有必要加入不同模型家族的受控对照，尚无证据支持全面替换DeepSeek。优先选择Qwen3.7-Plus作为质量候选；先对照证据支持判别，再单独对照主Agent。两类失败分开：旧话题选择、漏动作属于主Agent；原文虽然真实但未覆盖支付渠道、类别或限定条件仍被接收，属于证据判别与宿主输入合同。宿主的身份、范围、资金、确认和幂等仍由实际代码执行，不随模型开关移除。

## P0与验证安排

- **业务约束：** 无资料要说明未知，有条件的规则须保留条件；多轮指代和办理动作必须按当前原文及fresh订单，不能因换成更强模型而用历史答案代替授权。
- **面试追问：** 如何分辨模型问题和Harness问题？为何单独选择Agent与判别模型？怎样用任务指标而不是榜单决定效果、延迟与费用？
- **实现与复用：** 继续使用Pi provider注册、工具循环和已有评测；后续个人工作是受限模型配置、角色独立凭据、请求兼容、费用与冻结快照。普通百炼按量API与Token Plan区分，不修改Pi核心。
- **验收证据：** 同源码、同Prompt、同可信输入和预算，分别比较无答案误收、有答案误拒、来源覆盖、首次动作正确、修复/澄清、全轮业务完成、P50/P95、真实HTTP与每成功轮费用。新题包含正负控制，完整分母及未执行项保留；开发集用于诊断，不能重跑曝光题冒称独立验收。
- **预算与停止：** 当前调研0模型请求。下一片先实现参数和fake-wire检查；通过后再确定新题、冻结两臂单次调用/费用上限。建议首个判别片12输入/两臂，不启动第三模型或多次追分；实际预算须在执行前另定。安全或证据违规时不准入，无净收益则保留DeepSeek并归档。

## 候选与费用

### 本轮接入合同（2026-10-06）

本轮只交付候选接入和工程验证，预算为 **0 远程模型、QQ 与数据库请求**；不切换默认模型或候选准入状态。业务仍执行原有身份、fresh 范围、确认及幂等检查。面试追问聚焦“为何模型按角色选择、如何防止错误凭据路由，以及多币种费用为何不能直接相加”。

复用 Pi 的 provider 注册、OpenAI 兼容适配与原生循环；项目实现有界的模型选择、普通百炼地址规范化、角色选择快照、非思考请求以及人民币估算。先接入固定 `qwen3.7-plus-2026-05-26`，不增加自动模型路由或故障时跨模型回退。`configured` 保持全局环境配置的既有语义；两个角色各自可以显式固定模型，不因主 Agent 选择而暗改判别模型。百炼固定选择只使用 `DASHSCOPE_API_KEY`，不能把 DeepSeek 的 `MODEL_API_KEY` 发送给百炼。

验收使用原生 SDK 的本地替代 HTTP：核对实际地址、模型、凭据、非思考参数、动作与无工具判别请求、取消、usage 和币种；已有配置与历史记录兼容。未知费用保持未知，Pi USD 费用不能用百炼 CNY 原价填充，也不能把 Token Plan 的 0 当普通调用免费。工程通过后执行全量 validate、审阅差异、提交推送即结束本片；真实模型对照另冻结新题、源码、价格和单次预算。

官方目前将Qwen3.7-Plus定位为能力与成本均衡的通用模型。首轮建议固定`qwen3.7-plus-2026-05-26`快照，减少别名升级带来的漂移；这个选择是假设，业务质量尚未测试。[文本模型选择](https://help.aliyun.com/zh/model-studio/text-generation-model/)。

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
