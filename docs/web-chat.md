# 网页客服问答

日期：2026-10-07；状态：只读问答首版及会话设置v2已实现并验收。当前HTTP使用下文v2合同，首版合同与历史证据分列保留。前端由实际Kimi CLI K3 / Max完成，Codex完成后端与独立联调。

## P0与范围

- **业务约束：** 本机只读咨询入口，支持普通问答、本人订单、已验证的完整到账指令。浏览器选择两个固定合成客户；可信TEST_APP/TEST_USER身份由服务端目录绑定，不接收客户端senderId/customerId/appId。不同会话及身份隔离，原始输入不裁剪后当确认；金额和依据由现有工具边界取得。使用演示数据，不发生商家或退款写入。
- **面试追问：** QQ和网页如何复用同一Pi客服而不重复Agent loop？客户端的角色选择为什么不能成为任意身份授权？重复点击、超时、换身份和XSS怎样影响多轮会话及实际回复？
- **个人与复用边界：** Codex做本机HTTP入口、服务端会话/身份映射、串行及失败边界、业务接线、实际Reply契约与独立检查；复用Pi、订单授权、FAQ、到账咨询和Reply渲染。Kimi做独立`web/chat/`静态页面，沿用原生HTML/CSS/JS，不修改评测工作台、Pi核心、数据库结构、已有Prompt/Skill或依赖。
- **验收与演示：** 页面输入→本机JSON→cookie绑定合成身份→宿主到账处理或原生Pi只读工具→实际Reply→安全页面显示。检查身份/会话隔离、坏请求、来源失效、忙碌/错误、重复点击/换身份竞态、长文本/XSS、键盘及宽窄屏。真实模型和本地faux分列，网页显示不等于QQ或生产商业验收。
- **预算与停止：** 一片可运行MVP；离线定向、完整validate、HTTP与实际浏览器检查；最多两个普通真实模型用户回合，以一次执行留存结果，不重复追分/换模型。到账路径0模型请求，真实QQ0发送。发现可复现安全/契约问题才定向修复；首版完成即记录和提交，后续自然语言咨询、持久历史、公网登录与退款执行另定范围。

上述两个用户回合可能包含多次Pi工具循环和SDK的既有网络重试，不能解释为两个供应商HTTP请求。首版live只验实际接口/会话/工具订单卡接线，普通模型文字不作为已确定性验证的业务事实或语义准确率；供应商请求数和用量未采集时如实保留未知，不补零。

## 页面与入口

独立本机端口默认3002，与3001评测工作台并列，原有工作台不重启或修改。首屏以对话为主：简洁的品牌与“模拟数据/只读咨询”提示、客户选择、新对话、空态示例、消息列表、输入框和发送状态。电脑右侧可放当前客户的合成订单提示，窄屏收起；不给普通用户展示harness、trace、模型参数或评测指标。回复以安全文本和结构化订单/依据展示，禁止执行模型HTML或让模型拼按钮。

示例仅填入输入框，由用户发送：本人订单、常见门店咨询、`查询到账 银行卡`。切换客户必须新建服务端会话并清空旧消息，不能把旧订单/渠道带给新身份。新对话真正清空后端上下文。输入中Enter发送、Shift+Enter换行、中文IME回车不误发送，发送期间禁重复请求并保留失败草稿；不做伪逐字打字或假装模型正在流式返回。

API合同由Codex冻结后追加在本页；Kimi只依合同构建，不硬编码成功答案或后台凭据。演示身份选择只适用于本机合成数据，公网上线须另设计可信登录与客户绑定。

角色选择允许作者主动扮演客户A或B。本轮证明固定服务端映射、所选身份的订单归属与上下文隔离，不证明真实用户登录鉴权，也不限制演示客户A切换成B；不能将这个入口直接当成公网客户认证。

## 首版HTTP合同（实施前冻结）

本机`http://127.0.0.1:3002/`，同源cookie（HttpOnly、SameSite=Strict、Path=/）；POST必须`Content-Type: application/json`、`X-Chat-Request: 1`，不接受查询参数。Host/Origin/Fetch-Site校验沿用本机工作台边界；body最多8KiB，消息1..2000字符（原文保留）。无CORS、无外部字体/CDN或密钥表单。

- `GET /api/chat/config` → `{version:1, simulation:true, readOnly:true, profiles:[{id,label,orderHints:string[],examples:string[]}], limits:{messageCharacters:2000}}`。固定profileId为`demo-a`/`demo-b`，所有提示为合成资料，不能把提示当授权结果。
- `GET /api/chat/session` → `{session:null,messages:[]}`或`{session:{id,profileId,label},messages:[...]}`。id仅作响应/竞态核对，不能作为客户端授权参数；历史只存内存且有上限，重启/过期后session为空。消息形状为`{id,role:'user'|'assistant',text,reply?:Reply}`。
- `POST /api/chat/session` body仅`{profileId}` → `{session:{id,profileId,label},messages:[]}`及新cookie。新对话/换客户失效旧cookie与后端上下文；旧会话忙碌时409，前端保留现状，不误清屏。
- `POST /api/chat/messages` body仅`{requestId:<UUID>,text}` → `{sessionId,requestId,reply:Reply,durationMs,origin:'host'|'agent'}`。以cookie选择唯一后端身份；客户端不传身份、订单焦点、模型参数或提示词。每会话一次处理中，忙碌409；相同requestId+原文不重复调用，冲突原文400，完成响应可在当前会话内有限回放。后台失败不会自动重试一整轮；前端显示错误并保留草稿。
- `Reply`仅现有`answer/notice/order`：`{kind,text,evidenceIds?:string[],orders?:[{id,status,paidCents,refundedCents,couponStatuses:string[]}]}`，字段语义沿用现有源码。前端使用DOM安全文本，不解析任意HTML。订单卡来自`orders`，其他用text；依据可折叠，金额整数分，坏值显示未知，不猜付款渠道或退款成功。
- HTTP错误统一`{error:string}`：400格式，401会话失效，403外部来源，409忙碌，429容量，503服务不可用。没有订单/归属/规则等业务拒绝由200的`notice`表达，不能把HTTP200当业务成功。

Kimi只修改`web/chat/index.html`、`web/chat/app.js`、`web/chat/style.css`；禁止修改后端/数据/计划/已有工作台/依赖、提交推送、数据库写入、真实业务模型或QQ发送。Codex独立编写前端行为检查并联调。独立页面风格采用简洁明亮的客服会话、蓝/青色强调、清晰留白，重点是可读结果而非技术文字。参考frontend-design的层级、空态和可访问性；不增加装饰性大标题/KPI。

## 后端实现与复现

`src/web-chat-server.ts`提供固定静态文件及严格JSON接口，只绑定127.0.0.1。启动要求`dave_agent_read`，实际SHOW GRANTS核验仅USAGE/SELECT，不读取或启动售后/退款写账户。普通问答延迟初始化已配置模型，调用`createCouponSession`与`runCliPrompt`，精确只开放`get_order/search_faq`；采用已有atomic主线，不切QQ配置或Controller候选。到账咨询复用`createArrivalConsultation`，不需要模型初始化。

`src/web-chat.ts`用32字节随机cookie能力绑定服务端目录，响应公开UUID不是授权token。内存最多20个会话、每会话20轮、30分钟闲置失效；一次只处理一轮，原requestId+原文可回放，冲突拒绝。新对话删除旧上下文；SDK错误或60秒超时失效整会话，迟到factory/session/reply不能进入新客户。HTTP连接中断可继续完成本轮只读处理并按原ID回放，不能保证客户端abort取消远程请求或停止供应商计费。

启动（复用本机.env，只读账户与模型配置留在服务端）：

```sh
node --env-file-if-exists=.env src/web-chat-server.ts
```

然后打开`http://127.0.0.1:3002/`。可用`CHAT_PORT`指定其他本机端口。历史仅在进程内，浏览器刷新可恢复当前有限历史，服务重启后需新对话；这不是公网用户登录或长期对话存储。每条消息返回实际结构化Reply；订单卡由当前成功工具结果决定，普通模型text没有因此成为确定性校验的事实。

演示时可从以下入口追到代码：

| 路径 | 源码与取舍 |
| --- | --- |
| 页面提交和安全展示 | [app.js](../web/chat/app.js)：原文与请求UUID、会话代次、安全DOM、实际Reply订单卡；使用浏览器原生控件，不引入前端框架。 |
| HTTP到可信演示身份 | [web-chat-server.ts](../src/web-chat-server.ts)与[web-chat.ts](../src/web-chat.ts)：cookie能力、固定目录、串行与失效；公开会话ID不能代替授权cookie。 |
| 普通问答到Pi | [agent.ts](../src/agent.ts)的`createCouponSession`与[cli.ts](../src/cli.ts)的`runCliPrompt`：复用现有SDK与回复转换，只开放两项只读工具。 |
| 完整到账指令 | [arrival-consultation.ts](../src/arrival-consultation.ts)：复用既有范围/双授权和目录复核，直接返回宿主Reply，无模型初始化。 |

低成本演示可先发`查询到账 银行卡`，再切客户B发`查询到账 COUPON-1001 银行卡`查看归属拒绝；完整命令不会调用模型。普通问答或订单示例仅填草稿，点击发送才会调用真实模型。新对话清空服务端上下文，刷新保留当前内存历史；服务端失效后须新建会话，不能在旧身份下盲重试。

## 问答页设置与评测导航（2026-10-07，本轮实施合同）

用户已选择“聊天模型参数＋评测入口”。这轮补齐演示入口与配置可核验性，首版不展示模型参数的限制由此更新；完整检索、Controller及评测实验参数仍复用3001工作台。

- **真实业务约束：** 两合成客户与两只读工具保持现有边界。参数只随新会话生效，当前处理期间不得切换；校验失败保留旧会话和草稿。页面不能填写密钥、任意模型、URL、身份或Prompt，不提供关闭业务保护的开关。
- **面试追问：** 如何确保页面选择真正进入Pi请求、刷新恢复实际配置，而非仅改变UI？如何让比较可复现，并避免同一历史混用模型以及设置失败误删上下文？
- **个人实现与复用：** Codex实现严格会话设置合同、服务器允许目录、配置快照、原生Pi接线与独立检查；复用model-selection与只读会话，不修改Pi核心或QQ。实际Kimi CLI K3 Max负责三份聊天静态文件，原生导航、可收起控件与实际配置显示，无新增依赖。
- **验收与演示证据：** 原生Pi＋本地替代HTTP证明实际模型、推理与token参数；验证坏值、不可用选项、409回滚、刷新恢复、换客户保持已应用配置。实际浏览器查看宽窄屏、应用新会话、到账只读命令及既有评测导航；工程接线不声称模型质量或A/B收益。
- **投入预算与停止：** 一轮页面与参数接线，0业务远程模型、0QQ、0数据库写入；不重跑首版已关闭的两回合预算或历史题集。Kimi有界生成，确定性定向检查与最终validate通过即收尾提交推送；持久历史、更多参数、退款与公网另定范围。

HTTP v2：GET config在原字段上增加`defaults:{modelSelection,thinkingLevel,maxTokens}`、`models:[{id,label,provider,modelId,available,supportsThinking}]`、`options:{thinkingLevels:['off','high'],maxTokens:[512,1024,2048]}`及`evaluationUrl`（服务器校验EVAL_PORT产生的本机链接）。模型选择复用`configured/deepseek-flash/deepseek-v4-pro/qwen3.7-plus-2026-05-26`目录；推理只提供关闭/开启，开启映射Pi high，不将提供商不支持的多个强度冒称独立效果。

`available`仅表示本机凭据配置与离线目录元数据可解析，不保证远程密钥认证、额度或服务可用。省略settings沿用`configured/off/2048`，默认无密钥仍能处理宿主到账指令；显式完整设置选择未就绪模型时400并保留旧会话。普通新对话/换客户遇到该默认无密钥配置时省略settings以保持兼容；默认无密钥下普通问答仍按既有503失败/会话失效处理。目录不输出凭据、来源或base URL。token是提供商请求预算，不保证输出固定字数；开启推理可能与回答共用预算，当前工程验证不宣称质量或费用收益。

POST session兼容`{profileId}`，可增加完整`settings:{modelSelection,thinkingLevel,maxTokens}`，禁止未知字段与不完整设置；校验在旧会话失效前完成。返回及GET session增加`session.settings`与`session.model:{provider,id}`，只包含实际设置与已解析模型标识。POST messages继续仅允许原requestId和text，不接受中途配置。当前生效配置与未应用表单区分，应用按钮明确新建并清空上下文；普通新对话/换客户沿用已应用设置。不可用凭据只显示状态，不暴露来源或内容；配置目录不发远程发现请求。启动时固定服务端环境副本，修改.env需重启；网页选择不修改环境、QQ或评测台实验参数。

### v2完成记录与演示

- **代码与复用：** [web-chat-settings.ts](../src/web-chat-settings.ts)复用既有模型目录与Pi注册，返回四个允许选项的就绪/推理状态；严格验证设置，并按选择惰性缓存runtime。生产与工程检查共用`createWebChatAgentFactory`，传入模型clone的token上限、调用原生`setThinkingLevel`，核验实际getter没有夹档；不改变共享模型或Pi核心。`WebChatSessions`先校验再替换会话，只读工具与旧身份、超时、幂等和原文边界保持。
- **工程结果：** `node scripts/web-chat-check.ts`通过，既有11次Pi faux回调与新增6次原生SDK替代HTTP分列。新增检查覆盖四目录项、DeepSeek/Qwen的off/high和512/1024/2048档，捕获DeepSeek `thinking`/`reasoning_effort`/`max_tokens`，Qwen `enable_thinking`/`max_completion_tokens`（无reasoning_effort）。未知模型、坏字段/类型、未配置、不支持推理、端口无效、失败保留旧cookie、刷新及换客户快照、忙碌409与默认无密钥宿主均检查。0远程/DB/QQ；这是SDK接线证明，未验证云端接受、模型回答质量或费用。
- **Kimi来源与失败：** 实际CLI `2.1.1`、`kimi-code/k3`、K3/Max，本轮11份生成/修正call的wire元数据、候选及生产SHA在忽略的`.runtime/kimi-chat-v2-provenance.json`。采用独立stdout片段机械合并；`history/messages`、把selection当对象、CSS class/ID错配的候选在合并前拒收，由Kimi定向小修正。无新增依赖，Codex未代写前端；CLI用量与费用未采集，不补零。
- **独立UI工程检查：** 执行实际app的`node scripts/web-chat-ui-check.mjs`通过。除原有原文/UUID、XSS/金额/Reply、键盘与会话检查外，新增设置草稿不冒称已应用、忙碌禁用、400/409保留历史/输入/form、成功应用清空上下文、刷新恢复、换客户/新对话用已应用参数、无key默认兼容、未配置选项禁用及外部评测URL不生成链接。0远程/DB/QQ。
- **实际浏览器：** 测试Pro/high/512的未应用→应用→刷新，改表单为Flash/1024后换客户仍保持实际Pro配置。共3条宿主指令：全局银行卡咨询、B查询A的1001拒绝、恢复默认后全局银行卡；实际只读数据库接线，0业务模型/QQ/写入。点击评测入口成功打开3001既有历史工作台，没有启动实验；实际1280×720、600×800、390×844均无横向溢出，390展开设置可正常纵向滚动。宽屏及手机完整页面截图保留`.runtime/web-chat-v2-desktop.jpg`、`web-chat-v2-mobile.jpg`（后者390×1111），浏览器采集到0条error/warn。验收后恢复`configured/off/2048`，视口已复原。
- **收尾：** 最终`npm run validate`退出0，包含新增后端与UI检查；独立后端、前端及差异审阅通过。原package/lock与.idea工作区改动保留，不纳入本轮；首版2个真实回合的预算仍关闭，历史C1/O4/O5结果与未准入状态不改。不因设置接通认领新模型A/B或生产效果。

复现：同时启动网页与评测服务（均读取本机.env），打开3002，展开“聊天设置”，选择模型/推理/token后观察“设置未应用”；点击“应用并新建对话”核对页头实际配置，发`查询到账 银行卡`，刷新查看历史与配置。修改未应用表单后换客户，页头仍为已应用值；从“评测工作台”进入原有历史、对比与实验调试。这里只读宿主演示不调用模型；普通问答才会消耗所选模型。确认演示完恢复默认，避免将未实测的不同模型/推理模式当成已验证质量提升。

```sh
node scripts/web-chat-check.ts
node scripts/web-chat-ui-check.mjs
npm run validate
```

## 首版验收记录

- 本机运行配置为`deepseek/deepseek-flash`（环境未覆盖MODEL_ID，沿用`resolveModelSelection`默认）；Pi SDK `1.0.0`，验证Node `26.10.0`。普通入口保持atomic与既有Prompt/Skill及两只读工具；本轮不切QQ或实验候选配置。供应商模型未另有不可变快照，不能将这一ID视为永久固定权重。
- 后端确定性检查`node scripts/web-chat-check.ts`通过，11次本地faux回调，0远程模型/DB/QQ：实际HTTP与原生Pi只读工具、两身份隔离、完整原文/请求去重、忙碌、新对话、断连回放、createAgent迟到dispose、native prompt超时abort/signal及迟到回复隔离。非法来源、重复header、公开UUID冒充cookie、绝对URL及隐藏诊断另经独立负控。最新类型检查、后端独审通过。
- 首次typecheck中live-check的unknown/string条件spread错误已修；首次工程夹具将提供商归一化后的上下文误当raw custom role，改为核验实际提供商上下文含咨询假设及换身份无旧内容，不改变业务边界。原始失败不计通过。
- **唯一真实问答接线：2/2用户回合执行，通过接口检查。** `runId=5361e826-37ca-486e-81a6-1b191ae536f2`，演示客户A先查询`COUPON-1001`得到当前工具订单卡，再同会话询问核销情况得到answer；服务端两轮时长2366ms、716ms。第二轮只检查实际回复及会话接线，不宣称核销语义准确率；不是与其他配置的模型A/B。供应商HTTP次数、用量、费用未测量，不补零；没有业务写入或真实QQ发送。两回合预算已关闭，后续浏览器只用确定性到账命令，不追加普通问答。
- `scripts/web-chat-live-check.ts`不带`--live`仅检查合同，导入不发送请求；显式`node scripts/web-chat-live-check.ts --live`会使用已运行服务与远程模型，原始合成回执只保存在忽略的`.runtime/web-chat-live-results.json`，不入库。
- **前端来源：** 实际Kimi CLI `2.1.1`，模型别名`kimi-code/k3`、model `k3`、`thinkingEffort=max`由私有wire元数据核对；生产代码为三份原生静态文件，无新增依赖。大任务和部分片段多次超时，改为独立stdout小片段、逐字合并；曾出现reset误用实际helper签名的候选，静态复核拒收后由Kimi重写。CLI超时不一概当零产出：已完整落盘的片段另经语法与最终行为检查。CLI生成用量/费用未采集。私有来源与SHA记录保留`.runtime/`，不入库。
- **独立UI工程检查通过：** `node scripts/web-chat-ui-check.mjs`执行实际app代码，合成HTTP，0远程模型/DB/QQ。覆盖示例仅填稿、空白/超长拒绝、原文尾空格、同文同会话重试UUID、忙碌/IME/Shift+Enter、XSS纯文字、整数分与异常金额、正文JSON不能伪造订单卡、切客户409保留旧消息及成功清空、错会话回执不显示、503禁旧上下文重试、重新开始保稿与新UUID、新对话清空。
- **实际浏览器与本机服务通过：** 5条宿主指令为全局银行卡、客户B查他人1001拒绝、B本人1002电子钱包、缺渠道、混合退款请求拒绝；真实只读MySQL接线，0追加普通模型/QQ/业务写入。核对示例填稿、Enter发送与Shift+Enter不发送、客户切换/新对话、刷新恢复B的两轮历史、折叠依据。默认1280×720及600×800、390×844无横向溢出，窄屏订单提示折叠。页头重复整段notice经Kimi改为短状态，完整正文仍显示。宽窄屏截图保留忽略的`.runtime/web-chat-desktop.jpg`和`web-chat-mobile.jpg`；可选控制台日志采集未完成，临时浏览器tab随后失效，不影响已保存的页面与交互证据。
- **最终收尾：** `npm run validate`退出0，包含类型检查、以上后端/UI与既有离线回归；最终独审与差异检查通过。package/lock既有工作区变更及冻结C1数据哈希未改，不混入提交。旧真实QQ、C1/O4/O5未完成项及历史成绩保持原状态，网页接线不替代那些验收。本片已按预算收尾，不追加题集、模型选择或退款写入。
