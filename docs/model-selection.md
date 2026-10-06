# 百炼千问候选与模型选型建议

调研日期：2026-10-06。状态：仅调研和下一步建议，未接入普通百炼生成模型、未进行千问真实调用、未切换默认配置。

结论：有必要加入不同模型家族的受控对照，尚无证据支持全面替换DeepSeek。优先选择Qwen3.7-Plus作为质量候选；先对照证据支持判别，再单独对照主Agent。两类失败分开：旧话题选择、漏动作属于主Agent；原文虽然真实但未覆盖支付渠道、类别或限定条件仍被接收，属于证据判别与宿主输入合同。宿主的身份、范围、资金、确认和幂等仍由实际代码执行，不随模型开关移除。

## P0与验证安排

- **业务约束：** 无资料要说明未知，有条件的规则须保留条件；多轮指代和办理动作必须按当前原文及fresh订单，不能因换成更强模型而用历史答案代替授权。
- **面试追问：** 如何分辨模型问题和Harness问题？为何单独选择Agent与判别模型？怎样用任务指标而不是榜单决定效果、延迟与费用？
- **实现与复用：** 继续使用Pi provider注册、工具循环和已有评测；后续个人工作是受限模型配置、角色独立凭据、请求兼容、费用与冻结快照。普通百炼按量API与Token Plan区分，不修改Pi核心。
- **验收证据：** 同源码、同Prompt、同可信输入和预算，分别比较无答案误收、有答案误拒、来源覆盖、首次动作正确、修复/澄清、全轮业务完成、P50/P95、真实HTTP与每成功轮费用。新题包含正负控制，完整分母及未执行项保留；开发集用于诊断，不能重跑曝光题冒称独立验收。
- **预算与停止：** 当前调研0模型请求。下一片先实现参数和fake-wire检查；通过后再确定新题、冻结两臂单次调用/费用上限。建议首个判别片12输入/两臂，不启动第三模型或多次追分；实际预算须在执行前另定。安全或证据违规时不准入，无净收益则保留DeepSeek并归档。

## 候选与费用

官方目前将Qwen3.7-Plus定位为能力与成本均衡的通用模型。首轮建议固定`qwen3.7-plus-2026-05-26`快照，减少别名升级带来的漂移；这个选择是假设，业务质量尚未测试。[文本模型选择](https://help.aliyun.com/zh/model-studio/text-generation-model/)。

以下为官方模型信息页的华北2北京原价，单位为元/百万Token，普通实时调用、不含缓存折扣和优惠；Plus按输入≤256K档，具体授权、地域及执行时价格仍需核对。

| 候选 | 输入 / 输出 | 项目用途建议 |
| --- | --- | --- |
| Qwen3.7-Plus | 2 / 8 | 首个质量对照，独立测试判别和动作能力 |
| Qwen3.8-Flash | 0.8 / 2.7 | Plus形成收益后，再研究成本候选 |
| Qwen3.8-Max | 12 / 36 | 前两者仍有明确语义瓶颈时再做小量能力上限实验 |

价格来源：[Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)、[Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)。不能据单价推出整轮更便宜；多次动作修复、长输入、思考和误拒都会改变每成功轮成本。Pi当前DeepSeek估算为USD，百炼为CNY，保持分列；需要总额比较时另冻结汇率和价格版本。

## 当前接入缺口

本机Pi 1.0.0目录包含Qwen Token Plan专属provider，不能用其价格0或专属endpoint冒充普通百炼免费按量服务。`createModelRuntime`使用`modelsPath:null`；当前主模型factory不读取DASHSCOPE凭据，单改MODEL_PROVIDER不能完成本项目接入。

后续使用`runtime.registerProvider`注册受审阅的百炼模型，通过OpenAI兼容接口调用，key只在进程中绑定到相应provider。生成模型base URL需与key地域一致并指向`/compatible-mode/v1`；现有rerank的DASHSCOPE_BASE_URL不能未经规范化就当生成API地址。[官方兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)。

主Agent与证据判别要分别选模型。当前`src/evidence-support.ts`只允许configured/DeepSeek Pro，固定Pro又要求主provider是DeepSeek；`scripts/support-v2-live.ts`主模型仍跟随全局环境，实验表单尚不能逐variant换主模型。先补两个角色的有界配置、来源/模型快照及真实币种费用；判别对照时主Agent保持Flash，主Agent对照时判别保持Pro，检索模式与类别参数保持同版。

首轮关闭思考，先验证流式结束、usage、JSON/schema、一次动作、错误修复与取消。百炼官方规定思考模式不能同时使用required/object形式的tool_choice；Qwen的required也不能当稳定工具调用保证。项目现有hook未识别Qwen的enable_thinking，需要接入前适配和fake-wire检查，不能只换模型名。[Function Calling合同](https://help.aliyun.com/zh/model-studio/qwen-function-calling)。判别角色没有业务工具调用，是较小的首个接入切片；是否最终替换主Agent由真实业务对照决定。
