# 网页客服问答

日期：2026-10-09；当前状态：会话产品与持久记录、客户与多页原稿恢复、能力简介、响应式与键盘阅读、评测草稿保护和工作台编辑保持已完成相应验收。第33轮持续监测于北京时间10:00结束；用户随后另授权第34轮导航与文案修复、截图检查和自动commit/push。第34轮最终专项与完整 validate 均通过，另有当前版本只读MySQL与临时SQLite联调；运行版本、结果及局限见末节。本轮及持续优化由 Codex 实现，不使用 Kimi。首版Kimi来源、旧进程内历史和逐轮结果保留在历史章节，不能替代当前证据。

<a id="current-history"></a>

## 当前产品与复现入口

页面围绕客户咨询：左侧会话记录、中央对话与输入；手机通过原生弹窗回访记录。首页介绍本人订单和券状态、预约与使用条件、退款条件核对，具体示例只填草稿。模型设置留在次级弹窗；评测工作台是常驻导航，桌面与手机均可直接找到。删除常驻固定订单提示、重复页脚与无实际用途的说明文字。网页仍只读，不办理退款或向商家发消息。

启动仍使用本机只读配置：

```sh
node --env-file-if-exists=.env src/web-chat-server.ts
```

打开 `http://127.0.0.1:3002/`。`dave_agent_read` 必须实际只有 USAGE/SELECT；模型和数据库凭据只留在服务端。新建、回访、处理中刷新、客户切换及保存失败的最终结果见[第23轮记录](#round23-history)。

| 当前接口与状态 | 合同 |
| --- | --- |
| `GET /api/chat/config` | 继续版本2；增加每对话20轮、每浏览器归属/客户100条历史限额，模型可用性与实际配置目录沿原合同。 |
| `GET /api/chat/session` | 返回当前运行会话或null，以及服务端已保存消息；公开session包括运行UUID `id`、稳定 `conversationId`、`turns`、`busy`、`modelAvailable`，保留实际settings/model。 |
| `GET /api/chat/sessions?profileId=demo-a或demo-b` | 唯一允许该查询字段的入口；只列至少受理过一轮、且当前浏览器归属与重新授权客户绑定共同允许的会话。返回 `{conversations:[{id,profileId,title,createdAt,updatedAt,turns,status,current}],limit:100}`；标题来自首条受理原文，不让模型生成。 |
| `POST /api/chat/session` | `{profileId,sessionId:<当前UUID或null>,settings?:完整设置}`；新建并轮换运行UUID/token，保留已受理对话。 |
| `POST /api/chat/session/open` | 严格 `{conversationId,profileId,sessionId:<当前UUID或null>}`；回看及续聊复核归属与当前客户绑定，建立新运行UUID，不恢复历史选单权限。 |
| 消息与流式入口 | 仍严格 `{sessionId,requestId:<UUID>,text:<原文>}`；保留原文、代次/UUID、同轮回执与迟到保护。受理先持久保存pending，完成Reply/步骤与回执同事务保存后才发布最终result；失败或重启中断不自动重发。 |

`dave_chat` 是运行会话能力；新增 `dave_chat_owner` 是一年有效的本机浏览器归属能力。两者均 HttpOnly/SameSite=Strict，服务端仅保存其哈希。历史存于忽略目录 `.runtime/web-chat/history.sqlite`，使用 Node 内置 SQLite；30分钟释放运行资源，历史可在服务重启后从列表回访。20轮属于稳定对话，打开不会重新获得额度；100条/归属/客户和全局1000条达到上限时拒绝新增，保留已有受理记录。

过去的订单卡只展示过去结果，回访后入口先重新查询最近订单；当前订单与最后绑定复核仍由既有业务代码执行。模型不可用或实际配置变化时仍可回看原记录、走宿主只读订单咨询；需要模型的问题明确拒绝且不登记新轮次，不静默替换原模型。

连接中断时可主动“查看当前记录”，运行会话失效时可“重新连接”；已知或可能受理对话以稳定ID找回，不自动发送原问题。同浏览器共享cookie且仅有一个活动运行，其他页面切换后GET返回的当前运行只作为恢复的CAS前提，不覆盖本页原客户或原稿；明确打开历史、新建、设置及确认换客户的目标优先。其他页面忙碌、读取失败或竞争时保留原稿并提示重新连接。只有合法历史列表确认无原记录且明确未受理时才新建原客户空对话并转稿；已知/可能受理记录打开失败不退回新建。尚未受理的空对话不进入列表；有未发送草稿时先保护原文，手机会关闭历史窗口并聚焦输入。旧版仅有运行cookie的页面也可通过已读null后的显式新建恢复，不据旧cookie认领历史。

手机历史打开失败时返回主界面，错误和恢复入口可见；容量已满明确说明已有记录仍可查看，不误导等待重试。短屏（宽不超过760、高不超过500）保留160px聊天内部滚动区，并允许必要的外层纵向滚动；正文16px与44px操作触区不缩小。

进入评测工作台前，若本页任一会话仍有未发送原稿，默认继续编辑；明确选择丢弃才同标签离开，已有记录保持。空稿直接导航，返回仍重新读取服务端会话。评测入口只依赖已校验的本机配置地址；会话读取失败后仍可进入，不要求先恢复客服会话。正在处理咨询时仍阻止离页，错误、重连与原稿保护保持。

这是固定合成客户的本机浏览器归属，并非真实登录或跨设备账号。清除归属cookie不能自行找回记录；未发送草稿只在当前页面内保护。Pi使用已保存原文与公开Reply作为历史上下文，不恢复SDK私有轨迹或旧业务授权。SQLite事务不等于跨MySQL授权读取和HTTP发送的原子事务，也不证明远程模型取消、停止计费或跨进程业务exactly-once。

## 首版来源与历史验收

以下为2026-10-08首版及逐轮修订记录，历史能力和接口不得替代上方当前合同。首版前端由实际Kimi CLI K3 / Max完成，Codex完成后端与独立联调；后续用户调整分工后由Codex优化。

## P0与范围

- **业务约束：** 本机只读咨询入口，支持普通问答、本人订单、已验证的完整到账指令。浏览器选择两个固定合成客户；可信TEST_APP/TEST_USER身份由服务端目录绑定，不接收客户端senderId/customerId/appId。不同会话及身份隔离，原始输入不裁剪后当确认；金额和依据由现有工具边界取得。使用演示数据，不发生商家或退款写入。
- **面试追问：** QQ和网页如何复用同一Pi客服而不重复Agent loop？客户端的角色选择为什么不能成为任意身份授权？重复点击、超时、换身份和XSS怎样影响多轮会话及实际回复？
- **个人与复用边界：** Codex做本机HTTP入口、服务端会话/身份映射、串行及失败边界、业务接线、实际Reply契约与独立检查；复用Pi、订单授权、FAQ、到账咨询和Reply渲染。Kimi做独立`web/chat/`静态页面，沿用原生HTML/CSS/JS，不修改评测工作台、Pi核心、数据库结构、已有Prompt/Skill或依赖。
- **验收与演示：** 页面输入→本机JSON→cookie绑定合成身份→宿主到账处理或原生Pi只读工具→实际Reply→安全页面显示。检查身份/会话隔离、坏请求、来源失效、忙碌/错误、重复点击/换身份竞态、长文本/XSS、键盘及宽窄屏。真实模型和本地faux分列，网页显示不等于QQ或生产商业验收。
- **预算与停止：** 一片可运行MVP；离线定向、完整validate、HTTP与实际浏览器检查；最多两个普通真实模型用户回合，以一次执行留存结果，不重复追分/换模型。到账路径0模型请求，真实QQ0发送。发现可复现安全/契约问题才定向修复；首版完成即记录和提交，后续自然语言咨询、持久历史、公网登录与退款执行另定范围。

上述两个用户回合可能包含多次Pi工具循环和SDK的既有网络重试，不能解释为两个供应商HTTP请求。首版live只验实际接口/会话/工具订单卡接线，普通模型文字不作为已确定性验证的业务事实或语义准确率；供应商请求数和用量未采集时如实保留未知，不补零。

## 页面与入口

独立本机端口默认3002，与3001评测工作台并列；首版页面及后续设置、共享样式、导航修订分节记录。首屏以对话为主：简洁品牌、客户选择、新对话、空态示例、消息列表、输入框和发送状态；日常界面不反复强调模拟实现，具体业务结果仍如实显示。电脑右侧可放当前客户的合成订单提示，窄屏收起；后续设置片提供实际模型配置，评测指标留在工作台。回复以安全文本和结构化订单/依据展示，禁止执行模型HTML或让模型拼按钮。

示例仅填入输入框，由用户发送：本人订单、常见门店咨询、`查询到账 银行卡`。切换客户必须新建服务端会话并清空旧消息，不能把旧订单/渠道带给新身份。新对话真正清空后端上下文。输入中Enter发送、Shift+Enter换行、中文IME回车不误发送，发送期间禁重复请求并保留失败草稿；不做伪逐字打字或假装模型正在流式返回。

API合同由Codex冻结后追加在本页；Kimi只依合同构建，不硬编码成功答案或后台凭据。演示身份选择只适用于本机合成数据，公网上线须另设计可信登录与客户绑定。

角色选择允许作者主动扮演客户A或B。本轮证明固定服务端映射、所选身份的订单归属与上下文隔离，不证明真实用户登录鉴权，也不限制演示客户A切换成B；不能将这个入口直接当成公网客户认证。

## 首版HTTP合同（实施前冻结）

以下是首版历史接口，保留当轮合同与结果。当前配置按会话设置v2，消息按[消息会话前置条件](#旧页消息拒收与迟到-cookie2026-10-08)，新建/替换按[重置会话前置条件](#旧页重置的会话前置条件2026-10-08)；调用当前接口不能继续使用历史两字段消息或不带sessionId的新建正文。

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

## 网页请求去重与迟到隔离审计（2026-10-08）

**本轮合同：** 真实约束是只读咨询断连后可能已经处理完成，重试不能无意多跑一轮，旧客户迟到结果不能进入新对话。面试追问是“禁用发送按钮之外，宿主怎样去重、超时后恢复了什么、为何不等于资金幂等或取消计费”。个人实现为HTTP、cookie会话、请求结果缓存与失效边界；复用Pi生命周期、原生只读工具和`runCliPrompt`，前端沿用Kimi K3 Max产物。本轮预算30分钟，只审阅固定源码、既有断言与文档差异/链接；0新增模型/DB/QQ调用，无新失败证据则不改代码或追加实验。

源码基线为已提交的[`cb40012014c7e4bdf3e946635bc8b9aefcbdbf38`](https://github.com/erha1499/dave-agent/tree/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38)。下列七份源码/检查文件的公开固定版本与本机字节一致；这只证明审阅依据一致，不代表本轮执行过工程检查。

| 调用步骤 | 源码入口与实际行为 |
| --- | --- |
| 原文与请求编号 | [app.js](../web/chat/app.js)的`submitMessage`（约300行）：保留原文，只用trim判空；仅同一页面、同会话、同原文的`failedAttempt`复用UUID。 |
| HTTP与身份 | [web-chat-server.ts](../src/web-chat-server.ts)的`capability/readBody/createWebChatServer`（约16/23/45行）：只接受requestId/text，由cookie找到服务端身份，公开sessionId用于核对回执；完整正文读取后才进入`send`。 |
| 去重与业务处理 | [web-chat.ts](../src/web-chat.ts)的`send`（约84行）：检查原文冲突→回放已有结果→检查busy/轮数→登记请求→宿主到账或Pi→最后检查active→保存实际Reply和历史。 |
| Pi初始化与回复 | [web-chat-settings.ts](../src/web-chat-settings.ts)的`createWebChatAgentFactory`（约56行）及[cli.ts](../src/cli.ts)的`runCliPrompt`（约49行）：惰性创建原生Session、应用实际参数，复用prompt与本轮工具结果转换；CLI内部轮次UUID另行生成，浏览器UUID不是业务授权。 |
| 失败与页面接收 | `web-chat.ts`的`invalidate/assertActive`与`app.js`的`generation/sessionId/requestId`核对：失败删除旧Entry、abort/dispose，迟到factory先dispose，迟到处理不能保存结果；页面只有当前会话匹配且结构合法的回执才显示。 |

请求缓存属于**同一进程、同一cookie会话内的只读结果回放**。同UUID不同原文先400；同UUID正在处理仍409，不等待共享Promise；已有结果先返回，即使另一轮正忙也可回放，且不增加轮数或重新读订单。回放的是原结果，不证明订单或政策仍是最新状态。处理异常使整会话503失效，旧token再发为401；新会话、过期或进程重启不能继承这份Map。它不承担退款事务的确认、授权或资金幂等。

默认60秒计时在`send`的处理竞速中，覆盖宿主读取、factory、历史注入及Pi prompt，不包含此前HTTP正文读取（另有5秒）、新建会话配置校验或响应传输；计时依赖事件循环，不是强制终止执行的硬截止。超时会使旧Entry失效并请求取消，但不等待供应商证明已停止。完整正文已交给`send`后断开HTTP连接，服务端只读处理仍可能完成；`json`只避免写入已销毁响应。页面fetch没有自己的截止或断连取消合同，不能据超时/abort推断没有远程请求或费用。

刷新由`initialize`重新读取服务端已完成历史及配置，同时清空`failedAttempt`；失败草稿/UUID不持久化，处理中的请求不出现在完成历史里。因此“按原ID安全回放”要求调用方仍保有该ID，不能声称页面刷新会自动恢复并重试未完成请求。新对话和换客户在服务端busy时409保留原会话；成功替换才清空历史。多标签页共享cookie的并发替换未作专门验收，本轮不扩大这一保证。

**复现与证据：** 既有[后端检查](../scripts/web-chat-check.ts)约106–115行断言原文回放及冲突，173–199行断言busy/断连/原ID回放，203–264行分别控制宿主读取、factory和忽略取消信号的原生Pi迟到窗口；断连回放样例走host路径，不证明远程模型只计费一次。[UI检查](../scripts/web-chat-ui-check.mjs)约118–162行用Node VM及合成DOM/fetch断言同页原文重试、错会话回执不显示、503禁旧轮及新会话新UUID；没有专门的在途响应跨generation断言。可运行`node scripts/web-chat-check.ts`和`node scripts/web-chat-ui-check.mjs`，无须真实模型/DB/QQ；本轮仅核对这些断言与[首版记录](#首版验收记录)，未重跑，不计新增样本。历史HTTP/Pi/faux、合成Store、原生SDK替代HTTP与实际浏览器成绩仍属于各自原轮；未补验当前MySQL、真实供应商取消、跨进程请求恢复或QQ。

**取舍与收尾：** 有界Map与busy标志复用现有20会话/20轮上限，避免给本机只读页面增加持久任务系统；代价是重启丢请求、刷新丢未完成ID，超时选择丢弃整个上下文。只靠UI按钮挡不住直接HTTP；持久幂等表可支持跨进程恢复，但当前没有写入业务收益，不据此扩建。回放省去了新的业务读取/模型轮次，未测量延迟或费用收益；历史真实问答两回合的供应商用量仍未知。源码链与证据范围已补齐，本轮审阅的单会话只读路径未发现需修复的明确缺陷，按预算收尾；C1/O4/O5与真实商业能力不变。

## 旧页消息拒收与迟到 cookie（2026-10-08）

**本轮合同：** 真实约束是两个标签页共享 cookie，另一页切客户后，旧页输入不能先按新客户执行、再靠回复校验拒显；旧请求的失败响应也不能清掉新会话 cookie。面试追问是“cookie 已授权，为什么还要核对页面 sessionId；为什么响应里的 cookie 也有竞态”。Codex补宿主/HTTP入场边界和确定性检查，复用 Pi、既有Entry/只读咨询与前端；实际 Kimi CLI K3 Max只增消息请求的会话字段，不重构UI。基线固定`128fe898`，30分钟、两项本地HTTP负控及一组定向/项目检查、最多一次Kimi生成；0业务远程模型/DB/QQ。先保留失败，再做最小修复；预算到或检查不通过即保留未完成状态，不追加评测。

**根因与最小修复：** [页面提交](../web/chat/app.js)携带当前公开UUID，消息body严格为`{sessionId,requestId,text}`；[HTTP入口](../src/web-chat-server.ts)透传到[WebChatSessions.send](../src/web-chat.ts)，在cookie定位Entry后、缓存回放/busy/轮数/宿主读取/Pi创建之前核对`sessionId`。cookie决定可信合成身份，UUID只是页面预期会话的前置条件，两者不能互相替代；不匹配401且不失效cookie所指当前Entry。原`active/abort`仍保护已进入旧Entry的迟到结果，本次不是重写Pi或这一发布门槛。

第二项窗口是HTTP先捕获旧cookie、再等待正文，此时尚未进入busy；另页可先新建，旧正文结束后的401原会清cookie。现在仅成功新建会话设置HttpOnly/SameSite=Strict的会话cookie，消息成功/失败均不设置或清除cookie。去掉消息续期时同时去掉create的固定Max-Age，避免活跃对话被创建后30分钟硬截断；服务端30分钟闲置、20会话/20轮上限仍执行。不依赖浏览器关闭来撤销服务端Entry，也不承诺浏览器会话恢复策略。替代方案是每标签页独立授权能力，但会改身份/恢复合同，本机只读范围没有必要；入场校验增加UUID格式检查和一次会话编号比较，无新增DB查询或模型调用，延迟/费用收益未测量。

| 确定性场景 | 基线128fe898 | 修复后的断言 |
| --- | --- | --- |
| A旧页原文配B新cookie | HTTP200，B历史增加2条 | HTTP/直接send均401；读取、factory、Pi请求计数和B历史不增加 |
| 已缓存UUID/原文配错误会话UUID | 基线无请求会话前置条件 | 401，不能先回放缓存结果，无新增读取 |
| 旧正文分块等待期间另页新建 | 旧请求401带Max-Age=0，清cookie | 旧请求401无Set-Cookie；新cookie仍能读到新会话 |

**验证与失败留痕：** Node `v26.10.0`；两个根因在修复前由本地真实Node HTTP各一次复现（2/2已执行、0通过、2失败，基线脚本以捕获这两项失败为成功退出条件），未访问DB或模型。修复后[后端入口](../scripts/web-chat-check.ts)两项根因及缓存负控3/3通过；[UI入口](../scripts/web-chat-ui-check.mjs)以实际app源码/VM/合成fetch检查每条消息带页面会话ID，[真实问答入口](../scripts/web-chat-live-check.ts)只同步合同，未执行`--live`。生产修复的一次完整`npm run validate`退出0；独审建议补缓存负控后，后端定向及最终类型检查通过。定向/完整检查复用了同一组11次faux与6组原生Pi替代HTTP，重复执行不计独立模型样本。首次类型检查因`every`未收窄unknown失败，改显式字段typeof后通过；Kimi补丁首个机械白名单因JSON字段顺序拒收且未写文件，核对等价顺序后原样应用，未重跑生成。唯一实际Kimi CLI生成经wire元数据核验`kimi-code/k3`/`max`，CLI用时9.549秒，用量/费用未知。基线本地日志与Kimi记录保留在忽略的`.runtime`，不入库。

本片已实现并工程验证，0业务远程模型/DB/QQ/资金请求，固定题/gold/原始结果、默认atomic/lexical/memory/id及C1/O4/O5不变。只保证消息入场与消息响应cookie；并发create响应的cookie竞争、旧页主动reset（后续单独修复见下节）、多标签页浏览器状态同步及在途响应跨generation的实际Chrome验收仍未补验，不冒称全部多页竞争已解决。已有标签页加载的旧两字段代码会被400拒绝，更新后须刷新；语雀旧篇的单页保证不自动升级，应沿本节证据单独更新材料。预算内收尾，不追加模型或DB批次。

## 旧页重置的会话前置条件（2026-10-08）

**P0与停止条件：** 两个标签页共享cookie，旧页的“新对话／换客户／应用设置”不能清空另一页的新会话；正文或配置等待期间的旧请求也不能补建第三会话并覆盖新cookie。面试追问是“为什么只校验消息UUID仍会丢会话，检查为什么必须放在最后一次await之后”。Codex补宿主/HTTP合同与确定性检查；前端只由实际Kimi CLI K3/Max生成小补丁，复用Pi、现有Entry和原生UI。基线`1ff40cffe8a2cef497412750a0425748561ad756`；30分钟、两个本地HTTP失败复现、一次Kimi生成（若独审发现原能力回归，最多一次定向补缺）、一组定向与项目要求检查；0业务远程模型/DB/QQ。按预算收尾，不扩建会话存储、不追加模型评测。

**冻结合同：** `POST /api/chat/session`必填`sessionId: UUID|null`，仍只允许`profileId`及可选完整`settings`。UUID表示替换页面正在显示的会话，null表示初次或已确认失效的恢复；宿主在配置await后、busy检查及删除前严格比较当前cookie对应UUID（无可用Entry为null）。字段缺失/非法400、不匹配401且无Set-Cookie；正常忙碌409与参数400保留。UUID仅作并发前提，cookie仍提供服务端身份定位。普通重置携带页面UUID；失效后的重新连接先GET，现有会话直接接回，只有null才用null创建；客户改变时清除旧草稿，503同客户恢复保留草稿及原已应用设置；配置不可用时沿既有校验拒绝，默认configured无密钥的宿主兼容路径继续省略settings。无cookie初次创建及null恢复之间的响应cookie竞争仍未覆盖，不能称全部多页竞态已解决。

**调用链与取舍：** [app.js](../web/chat/app.js)的`resetConversation`声明旧UUID；[HTTP入口](../src/web-chat-server.ts)读完正文，再调用[宿主create](../src/web-chat.ts)。cookie只定位当前Entry，不能证明旧页有意删除它。`create`等待配置、校验参数后，以当前UUID/null比较请求前提；比较到失效/创建之间无await，在本进程内竞争替换只接受一次。只在HTTP或await前检查仍会漏掉正文/配置等待窗口；前端generation只挡旧正文显示，挡不住服务器删除或浏览器处理Set-Cookie。复用原Map及同步执行段，比加全局锁或持久化会话简单；不改变Pi循环，也不添加登录能力。

| 工程反例/控制 | 本轮结果与检查范围 |
| --- | --- |
| 旧页A＋新cookie B重置；B已有两条历史 | HTTP及直接create均401、无Set-Cookie，B的UUID/历史精确不变 |
| session正文分块，另一请求先替换A | 用服务端request事件屏障，补完旧正文后401，无Set-Cookie，新B仍可查询 |
| 两个直接create经过同一配置await竞争旧UUID | 仅一个成功，另一个401；不证明跨进程互斥 |
| 初次null、活会话配null、缺/非法UUID | 初次正常；活会话null为401；缺字段/两种坏值为400；原busy409/坏设置400回归保留 |
| 503与TTL恢复 | 实际HTTP503后GET null→POST null成功；30分钟受控Date.now使Entry失效，旧UUID拒绝、null恢复。TTL是受控时钟，不是实等30分钟 |
| 实际app的重新连接 | VM/合成fetch验证接回另一客户不POST、不删除且清旧草稿；503同客户保留草稿和已应用Pro/high/512参数；默认无密钥的普通reset回归保留，initialize恢复分支本轮仅静态核对 |

**证据与失败：** 基线两项本地Node HTTP反例2/2执行、0通过、2失败：旧页面不带前提的重置返回200并删除B；旧正文补完返回200及新的cookie，B仍在Map但浏览器可被切到第三会话。原记录保留忽略目录`.runtime/web-reset-baseline.json`，不回填为修后成绩。修后[后端入口](../scripts/web-chat-check.ts)覆盖上表前五组，[实际UI/合成传输入口](../scripts/web-chat-ui-check.mjs)覆盖最后组；[真实问答入口](../scripts/web-chat-live-check.ts)仅同步null新建合同，未执行`--live`。首次定向检查因本轮给既有B增加历史，改变原Pi捕获断言而失败，隔离合成会话后通过；第一Kimi候选的503参数恢复断言失败，保留日志后仅做一次定向补缺，不通过删断言收尾。正文检查的20ms等待已替换为事件屏障；一次TTL补丁上下文不匹配未写入，定位后修正。

Node `v26.10.0`；最终UI定向、完整`npm run validate`（含后端/UI、类型及既有项目检查）均退出0，独审及文档差异/链接通过。定向与完整检查重复使用既有11次faux及6组原生Pi替代HTTP，不计独立真实模型样本。实际Kimi CLI `kimi-code/k3`、`model=k3`、`thinkingEffort=max`两次生成分别128.887/38.699秒，共167.586秒，wire元数据核验；用量/费用未知。业务远程模型/DB/QQ/资金请求均0。验证时生产SHA256：`src/web-chat.ts=f9457f8c66ad0967ba23aeb66d582bcce4a728336b2c5c16ae1861f413efa063`、`src/web-chat-server.ts=88d6bb26d7e184dbe3e93812628779d6d75377bfafad299de6971be4a54d3620`、`web/chat/app.js=5794130732c4bda0ded83affc829672c17eacdb828fda59cea127118a701c937`。

**收尾与演示边界：** 本片已修复并工程验证；客户端新增一个UUID/null字段，宿主增加一次本地比较，正常重置无额外DB或模型调用，失效重新连接增加GET；时延收益未测量。复现用`node scripts/web-chat-check.ts`、`node scripts/web-chat-ui-check.mjs`，可从表中任一失败追到宿主最终比较及固定证据。仅本机合成身份、内存会话和只读入口；无cookie初次创建/并发null恢复的cookie响应竞争、真实Chrome多页/跨generation、跨进程恢复、当前MySQL/真实QQ均未补验。旧页面不含新字段会400，须刷新载入新合同；本轮不重启常驻业务服务、不部署。固定题/gold/结果及atomic/lexical/memory/id、C1/O4/O5准入不变，预算内收尾，不追加实验。后续优先用此入口讲清“拒绝旧页删除为什么需要服务端前提”；剩余null窗口若值得做，另立有界合同。

## 问答页设置与评测导航（2026-10-07，本轮实施合同）

用户已选择“聊天模型参数＋评测入口”。这轮补齐演示入口与配置可核验性，首版不展示模型参数的限制由此更新；完整检索、Controller及评测实验参数仍复用3001工作台。

- **真实业务约束：** 两合成客户与两只读工具保持现有边界。参数只随新会话生效，当前处理期间不得切换；校验失败保留旧会话和草稿。页面不能填写密钥、任意模型、URL、身份或Prompt，不提供关闭业务保护的开关。
- **面试追问：** 如何确保页面选择真正进入Pi请求、刷新恢复实际配置，而非仅改变UI？如何让比较可复现，并避免同一历史混用模型以及设置失败误删上下文？
- **个人实现与复用：** Codex实现严格会话设置合同、服务器允许目录、配置快照、原生Pi接线与独立检查；复用model-selection与只读会话，不修改Pi核心或QQ。实际Kimi CLI K3 Max负责三份聊天静态文件，原生导航、可收起控件与实际配置显示，无新增依赖。
- **验收与演示证据：** 原生Pi＋本地替代HTTP证明实际模型、推理与token参数；验证坏值、不可用选项、409回滚、刷新恢复、换客户保持已应用配置。实际浏览器查看宽窄屏、应用新会话、到账只读命令及既有评测导航；工程接线不声称模型质量或A/B收益。
- **投入预算与停止：** 一轮页面与参数接线，0业务远程模型、0QQ、0数据库写入；不重跑首版已关闭的两回合预算或历史题集。Kimi有界生成，确定性定向检查与最终validate通过即收尾提交推送；持久历史、更多参数、退款与公网另定范围。

HTTP v2：GET config在原字段上增加`defaults:{modelSelection,thinkingLevel,maxTokens}`、`models:[{id,label,provider,modelId,available,supportsThinking}]`、`options:{thinkingLevels:['off','high'],maxTokens:[512,1024,2048]}`及`evaluationUrl`（服务器校验EVAL_PORT产生的本机链接）。模型选择复用`configured/deepseek-flash/deepseek-v4-pro/qwen3.7-plus-2026-05-26`目录；推理只提供关闭/开启，开启映射Pi high，不将提供商不支持的多个强度冒称独立效果。

`available`仅表示本机凭据配置与离线目录元数据可解析，不保证远程密钥认证、额度或服务可用。省略settings沿用`configured/off/2048`，默认无密钥仍能处理宿主到账指令；显式完整设置选择未就绪模型时400并保留旧会话。普通新对话/换客户遇到该默认无密钥配置时省略settings以保持兼容；默认无密钥下普通问答仍按既有503失败/会话失效处理。目录不输出凭据、来源或base URL。token是提供商请求预算，不保证输出固定字数；开启推理可能与回答共用预算，当前工程验证不宣称质量或费用收益。

POST session兼容`{profileId}`，可增加完整`settings:{modelSelection,thinkingLevel,maxTokens}`，禁止未知字段与不完整设置；校验在旧会话失效前完成。返回及GET session增加`session.settings`与`session.model:{provider,id}`，表示已接受的会话配置及离线目录解析的模型标识；新建会话返回时尚未创建Pi，字段本身不证明Pi已初始化、云端认证或参数接受。POST messages继续仅允许原requestId和text，不接受中途配置。当前生效配置与未应用表单区分，应用按钮明确新建并清空上下文；普通新对话/换客户沿用已应用设置。不可用凭据只显示状态，不暴露来源或内容；配置目录不发远程发现请求。启动时固定服务端环境副本，修改.env需重启；网页选择不修改环境、QQ或评测台实验参数。

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

## 网页会话参数生效调用链审计（2026-10-08）

**本轮合同：** 真实约束是同一段历史不混用新旧模型配置，参数坏值或处理中切换不能删掉旧会话，设置不得扩大只读权限。面试追问是“页面显示已应用，究竟证明到了哪一步；如何定位到真正的Pi请求”。个人实现为目录、严格校验、会话替换、配置快照和请求检查；复用Pi生命周期、模型注册与已有只读工具，前端沿用Kimi K3 Max产物。本轮预算30分钟，仅审阅已提交源码和既有证据、补差异与链接；0新增模型/DB/QQ调用，没有明确缺陷不改代码或追加实验。

固定依据为[`cb40012`](https://github.com/erha1499/dave-agent/tree/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38)的八份源码/检查：`web-chat-server.ts`、`web-chat-settings.ts`、`web-chat.ts`、`agent.ts`、`model-selection.ts`、`web/chat/app.js`六份源码，加上后端/UI两份检查。按以下时点讲解，不能把本地配置、Pi getter、HTTP请求和云端效果合成一个“成功”。

| 时点 | 调用路径与源码定位 | 实际承诺 |
| --- | --- | --- |
| 启动目录 | [web-chat-server.ts](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/src/web-chat-server.ts#L119)复制环境→`createWebChatSettingsCatalog`→`resolveModelSelection`；[web-chat-settings.ts](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/src/web-chat-settings.ts#L14)离线取得元数据、检查本机配置。 | 四个允许选择中，`configured`解析启动环境；`available`不检查云端密钥、额度或服务。环境修改需重启，不进行远程模型发现。 |
| 表单提交 | [app.js](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/web/chat/app.js#L333)`resetConversation`→`POST /api/chat/session`；普通新对话/换客户读取`state.session.settings`，应用按钮才读取新表单。 | 草稿与已应用快照分开，改表单本身不改变当前历史或参数。服务端messages接口不接受中途配置。 |
| 校验与替换 | [web-chat.ts](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/src/web-chat.ts#L63)`create`→`validateWebChatSettings`→busy/容量检查→旧会话`invalidate`→新Entry及cookie。 | 三字段、枚举、整数上限、模型能力及显式选择的就绪状态均由宿主检查；400/409发生在旧会话失效前。成功后清空历史并保存配置，尚未创建Pi。省略settings的无密钥默认兼容仅供宿主路径，并非跳过参数格式/能力检查。 |
| 首次普通问答 | `send`先尝试完整到账宿主指令，未命中才调用[factory](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/src/web-chat-settings.ts#L56)：按selection缓存runtime→clone模型的maxTokens→`createCouponSession`→`setThinkingLevel`→getter复核→`runCliPrompt`。 | 推理或上限未实际保留则dispose并失败；每个Entry独立Pi会话，runtime缓存不共享对话历史。宿主到账命令不会创建所选生成模型，不能用它证明Pi参数生效。 |
| Pi及执行边界 | [agent.ts](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/src/agent.ts#L149)已有2048上限与三个网页档一致；`createAgentSession`沿用内存会话、固定Prompt/Skill，factory未传售后写工具，`send`再次核对工具恰为`get_order/search_faq`。 | 换模型没有修改业务身份或增加写权限；Pi默认off随后由factory设为所选档。参数接线正确不证明模型话术、云端接受或费用收益。 |

例子：应用`deepseek-v4-pro/high/512`后再把表单改为Flash/1024而不应用，换客户仍传Pro/high/512，刷新从GET session恢复该快照。发送`查询到账 银行卡`只证明宿主及页面接线；真正的Pi参数证据来自下一段替代HTTP断言。非法`maxTokens:"512"`或处理中应用返回400/409，旧cookie与上下文保留；**新Entry成功后**若factory/普通问答失败则按既有503失效整会话，并不回滚到被替换的旧历史。若成功替换但响应丢失，前端恢复旧显示并标记expired、要求重新开始，也不能声称服务端事务回滚。

**证据与复现：** [后端检查](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/scripts/web-chat-check.ts#L277)的HTTP层采用faux factory；参数层直接调用`WebChatSessions`，用生产factory、原生Pi及替代fetch捕获请求。六个配置各一次普通问答，核对model、DeepSeek的`thinking/reasoning_effort/max_tokens`、Qwen的`enable_thinking/max_completion_tokens`及getter/只读工具；创建与宿主消息均不增加wire。它覆盖四个选择、off/high和三档token，**不是四×二×三的完整组合矩阵，也不是一批端到端云端验收**。[UI检查](https://github.com/erha1499/dave-agent/blob/cb40012014c7e4bdf3e946635bc8b9aefcbdbf38/scripts/web-chat-ui-check.mjs#L173)使用实际app/Node VM、自制DOM及合成HTTP，覆盖草稿、400/409保留、成功清空、刷新和换客户的已应用值，不证明真实浏览器布局。复现入口仍为`node scripts/web-chat-check.ts`与`node scripts/web-chat-ui-check.mjs`；[v2历史记录](#v2完成记录与演示)的11次faux与6次替代HTTP属于原轮，本轮未执行或增加样本，也未重验浏览器/MySQL/供应商/QQ。

**取舍与收尾：** 新建会话比在旧Agent上切模型更容易复现参数与历史的对应关系，代价是丢弃旧上下文；先离线校验、后懒初始化避免应用设置及宿主指令产生云端请求，代价是远程认证失败要到首次普通问答才发现。factory每selection缓存一个runtime Promise，当前仅四个选择且环境固定；`createConfiguredModelRuntime`的离线初始化Promise若拒绝，也会保留在缓存中，重新建网页会话不会重建它，需重启服务。后续云端prompt失败不等于这个初始化缓存失败。本轮不增加健康探针、热更新或持久配置；初始化延迟、云端质量和费用收益未测量。源码与既有断言未发现此单会话配置链需要修复的明确缺陷，材料补齐即收尾，C1/O4/O5及商业能力状态不变。

## 视觉优化（2026-10-07）

- **业务约束：** 用户明确要求提升观感，保留当前两合成客户、只读回复、参数新会话生效和评测导航。清楚表达演示/只读状态，不增加假指标、未接线入口或成功话术；真实Reply正文和警告不因美化丢失。
- **面试追问：** 作者如何在简洁的产品演示中展示客服闭环、查看实际配置与评测证据？如何证明视觉改动没有破坏身份切换、草稿、确认语义或安全渲染？
- **个人与复用边界：** 实际Kimi CLI K3 Max负责聊天静态HTML/CSS，必要时有界调整安全展示JS；Codex负责契约、独立检查与浏览器验收。复用现有app/API/原生控件，不更换框架、后端、Pi或评测台。
- **验收与演示：** 清晰导航、居中会话、独立设置区、层级与状态、完整安全回复、易用输入框；检查初始化/设置应用/草稿/切换/刷新/评测链接，宽屏及390px无横向溢出，键盘焦点与reduced-motion。保存实际截图，与前版对照；视觉观感由用户判断，不捏造效率或满意度指标。
- **预算与停止：** 一轮明确设计与实现，最多4次Kimi生成/修正调用（K3/Max），最多40分钟生成预算；浏览器仅确定性宿主命令，0业务远程模型/QQ/业务写入，不重跑历史付费题集。复用现有UI检查，必要布局/可访问性定向修复后收尾，不开展新业务或持久化能力。

方向为本地生活客服演示的明亮专业工作台：深蓝文字、冷灰蓝底、蓝色主操作、克制绿/琥珀状态；导航与身份清晰，会话占视觉中心，实际模型配置收进设置区域。留白、字体尺度与卡片细节承担品质，禁止靠大面积渐变、无意义KPI或装饰性营销文案替代内容。

**本片已实现并验收：** 生产改动仅`web/chat/index.html`及`style.css`，`app.js`逐字不变；复用原生控件与现有响应类型，未增加依赖。三栏工作台在中窄屏改为顶部导航与页面纵滚；消息、完整警告、订单卡、折叠依据和设置卡分别呈现。空态文案准确说明只读咨询范围，实际配置完整换行显示。

- **Kimi来源与预算：** 实际CLI `2.1.1`，3次生成/修正均核对`kimi-code/k3`、model `k3`与`thinkingEffort=max`；总生成耗时560.693秒，未使用第4次预算。源码SHA及私有来源记录保存在忽略的`.runtime/kimi-chat-visual-provenance.json`，生成用量/费用未采集，不能写成零费用。Codex机械集成、补HTML检查、独立联调与文档，Pi和业务后端无改动。
- **发现与修正：** 初稿空态误称退款进度、全部回答基于当前订单，修为使用/本人订单/到账规则；1440px原生textarea未随自动边距居中、手机隐藏快捷键后按钮靠左，均由Kimi修正。placeholder与实付绿色加深，白底实付色对比5.502、placeholder字段背景对比5.073；配置摘要改13px/500并完整换行。原发现保留，不将初稿追认成通过。
- **工程与独审：** `node scripts/web-chat-ui-check.mjs`通过，执行实际app代码及合成HTTP；新增21个实际HTML ID唯一绑定、原生form/textarea/select与标签检查，复用草稿/去重、IME、安全Reply/订单金额、失效恢复、设置失败/应用/刷新与身份快照回归。最终差异、CSP/隐藏语义、焦点及reduced-motion源码检查和独立审阅通过。纯静态视觉范围未另跑业务付费题集或全量后端回归；此前全量validate成绩属于上一片。
- **实际浏览器：** 1280×720、1440×900、600×800及390×844验收；宽屏输入框/label/footer同宽并居中（1440下均left304/right1064/760px），窄屏控件边界无越界且scrollWidth等于视口。手机设置展开/应用、刷新恢复、切客户和最终默认恢复通过；示例只填稿、Shift+Enter换行不发送、Tab焦点2px可见、Enter发送通过。2条确定性宿主指令分别检验B查询他人订单的完整拒绝与A全局银行卡的完整咨询/折叠依据，真实只读接线，0业务远程模型/QQ/业务写入；不声称新增模型质量成绩。最终预览控制台warn/error采集为空。
- **截图与访问边界：** 前版`.runtime/web-chat-design-before.jpg`；最终空态`web-chat-visual-desktop.jpg`、`web-chat-visual-mobile.jpg`，真实宿主提示`web-chat-visual-mobile-notice.jpg`及回复`web-chat-visual-desktop-reply.jpg`，均保存在忽略的`.runtime/`。使用独立localhost cookie验收以保留用户127.0.0.1会话；localhost导航到127.0.0.1评测台被既有跨站访问保护（`Sec-Fetch-Site`）拒绝，默认127.0.0.1入口已只读核验工作台正常，未放宽该保护。演示继续使用默认`http://127.0.0.1:3002/`。外观由用户判断，没有新增效率/满意度指标，实际模型与QQ显示不属于本片验收。

复现：启动既有问答页与评测服务，打开`http://127.0.0.1:3002/`；先查看空态与设置，再用合成客户发送完整到账命令检查回复和依据。修改静态文件后刷新页面即可载入；工程检查使用上述UI命令。本片按预算收尾，截图与来源不入库，已有package/lock及IDE工作区改动不混入提交。

## 视觉协调修订（2026-10-07）

- **业务约束：** 用户认为三栏首稿仍不协调，目标是形成统一、易于演示的只读客服页面。保留真实配置、两合成客户、完整回复/警告/依据及评测入口，不增加虚构指标或业务能力。
- **面试追问：** 怎样用清晰演示呈现聊天主线与实际配置，并证明展示层迭代不影响可信身份和安全响应？上一片的功能通过不能代表用户对审美满意。
- **个人与复用边界：** 按用户补充要求，以既有评测台`web/evaluation/style.css`与HTML组件模式为基准，聊天同源`/ui.css`固定复用该文件，不复制第二套主题变量；评测页本身不重设计。Kimi CLI K3 Max基于源码及审图发现改进聊天HTML/CSS；必要时仅调整实际配置的安全DOM排版，复用element/textContent，保留既有事件/状态/API。Codex负责固定静态资源映射、设计约束、独立审阅和回归，不更换框架或业务后端。
- **验收与证据：** 对照评测台品牌栏/胶囊导航/按钮/表单/面板，验证共享样式响应确为同一源文件，审查字体/间距/圆角/边框、空态与输入区整体关系、展开设置、长回复/警告与移动端；保存前后实际截图。回归原生控件、填稿/发送/设置应用/刷新/换角色与完整文字，真实配置不可被装饰或静态标签替代。
- **预算与停止：** 最多3次实际Kimi生成/修正，总生成预算30分钟；审图明确的问题集中修正一次，随后按结果收尾。浏览器最多2条确定性宿主指令，0业务远程模型/QQ/业务写入；不重跑旧付费评测、不修改数据/权限。记录费用未知与失败，不用追加调用追求主观满分。

本轮已实现并验收，保留共享样式方案，按预算收尾：

- **实际复用与取舍：** 问答页先加载同源`/ui.css`（固定映射至未修改的`web/evaluation/style.css`），再加载仅`.chat-page`作用域的聊天布局。直接复用已有`masthead`、`brand-mark`、`tabs/tab`、`panel/panel-heading`、`quiet-button/primary-button`和`exp-field`样式；没有新建组件库或复制主题。全量共享CSS包含评测页选择器，聊天窄域兼容规则处理同名notice等交叉影响，代价是后续共享样式调整需要两页回归。布局由三栏改为主会话＋紧凑配置侧栏，移动端顺序堆叠。app只改实际配置的三行安全DOM排版，其他代码字节不变；未改Pi、业务授权或API。
- **Kimi来源：** 实际CLI `2.1.1`，两次调用均核对`kimi-code/k3`、model `k3`和`thinkingEffort=max`，生成耗时571.791秒；第三次预算未使用。来源、最终源码SHA和未知用量/费用保存在忽略的`.runtime/kimi-chat-refine-provenance.json`，不能写为零费用。Codex完成后端静态接线、验收检查、独立联调与文档。
- **发现与修正：** 初稿在1280×720下发送按钮落到首屏外，空态多层边框、notice双框、默认模型断行及订单提示标记造成噪声，Kimi集中修正；补回错误状态色、示例换行和提示正文对比度，移除重复meta CSP，保留服务端CSP。初稿截图保留，不追认为通过。浏览器按完整label选择客户一次未匹配，改用已验证的固定`profile-select`绑定成功；该步骤未发送消息，不作业务失败或成功成绩。
- **工程与独审：** 最终`node scripts/web-chat-ui-check.mjs`、`node scripts/web-chat-check.ts`、`npm run typecheck`和差异检查通过；沿用21个HTML绑定及既有11次faux＋6次原生Pi替代HTTP回归。新增共享CSS加载顺序和实际HTTP字节对照，核验CSS类型/no-store/CSP与非白名单路径、非法Host/Origin拒绝。评测页HTML/CSS的SHA前后不变；独立源码与最终宽窄屏、完整提示截图审阅通过。此轮未重跑全量validate，前文全量成绩仍属于对应历史切片。
- **浏览器证据：** 对照两页实际计算样式，九项主题变量、body字体/行高/背景、品牌渐变及当前页签样式相同。1280×720发送按钮位于首屏（bottom680.38px），600×800、390×844控件无横向越界；手机自然纵向滚动。未应用表单保留旧快照，Pro/high/512应用并刷新恢复、换客户隔离及默认configured/off/2048恢复通过。示例只填稿、Shift+Enter换行、Tab可见焦点及Enter发送通过。两条确定性宿主命令分别验证A全局银行卡完整回复/折叠依据、B查他人订单完整拒绝，真实只读接线；0业务远程模型/QQ/业务写入。最终预览与默认入口warn/error采集为空，默认127.0.0.1问答页的评测链接实际打开既有工作台，未启动实验。
- **截图与局限：** 评测对照`web-chat-refine-benchmark.jpg`、初稿`web-chat-refine-candidate-desktop.jpg/mobile.jpg`、最终`web-chat-refine-desktop.jpg/mobile.jpg`及实际宿主回复`web-chat-refine-reply.jpg/notice.jpg`均位于忽略的`.runtime/`。固定静态映射需要重启本地服务，临时聊天上下文随重启重建；已在无草稿、空闲时刷新用户页面载入新样式。外观仍由用户判断，没有新增满意度或效率成绩，也没有商业运行、普通模型质量或QQ渲染结论。已有C1/O4/O5与业务默认配置不变，package/lock和IDE工作区改动不混入提交。

复现：启动既有评测服务和问答服务，打开`http://127.0.0.1:3002/`；共享样式从评测台源文件读取，可对照`http://127.0.0.1:3001/`。工程检查使用本节三个命令；实际演示仍限合成客户、只读问答与既有完整到账命令。本片不自动续跑付费或业务实验。

## 导航与产品文案修订（2026-10-07）

- **业务约束：** 当前另开标签页的评测链接与缺失返回入口造成割裂。两页须在同一标签页内双向导航，统一顶层品牌与“客服问答/评测工作台”；评测的总览、对比、实验仍是其内部视图。界面不反复渲染模拟标签；合成数据、只读能力及结果真实性作为实现和文档准则，实际资金/授权/咨询结果不伪造。
- **面试追问：** 怎样复用已运行的两套静态页面形成连贯入口，同时保留会话身份、模型快照、来源保护和实验口径？页面切换与业务执行必须分开。
- **个人与复用边界：** Kimi CLI K3 Max只改现有前端的导航、层级与文案，继续加载同一套CSS，不引入SPA/iframe、框架或代理。Codex增加评测台固定`GET /chat`返回路由，使用已验证的CHAT_PORT与当前本机hostname；聊天链接沿用EVAL_PORT并保持当前127.0.0.1/localhost别名。固定身份ID和授权映射保持，客户名称改为普通产品用语；不重写业务Reply或固定评测。
- **验收与证据：** 实际HTTP核验默认/自定义端口返回地址、127/localhost及非法来源/参数拒绝；两页共有导航和当前页语义、点击不新开tab、浏览器往返与已有会话/模型快照恢复。只读浏览器检查总览/对比/实验切换与窄屏，无自动实验启动；完整业务警告不因文案调整截断。
- **导航恢复边界（实施前补充）：** 忙碌或尚未初始化时阻止页内评测链接，避免处理期间丢失当前页面；浏览器Back从BFCache恢复时重载并重新读取服务端会话，不能把旧DOM当当前身份或模型配置。只承诺已完成历史和已应用配置往返恢复，未发送草稿、失败请求UUID及未应用表单仅在当前页保留。刷新或通过浏览器离开不代表取消提供商处理；不新增轮询或持久化。两服务继续使用同hostname，端口不隔离cookie；不同本机chat实例并存不在此片合同。
- **预算与停止：** 最多两次Kimi生成/修正，总生成15分钟；定向UI/HTTP/类型检查及最终独审，浏览器最多一条确定性宿主命令、0业务远程模型/QQ/业务写入。导航及文案问题收尾即提交推送；不追加模型质量实验或重设计整站。原始失败与未知Kimi用量/费用如实保留。

本轮已实现并验收，保留原生双向导航方案，按预算收尾：

- **产品与复用：** 问答、评测两页共享品牌与顶层“客服问答/评测工作台”，同标签页切换；评测的总览/对比/实验仍用原ID与事件，作为次级导航。共享CSS只新增三条次级导航样式及一条禁用链接样式，问答仍直接加载同一文件。移除日常页头的模拟/本机强调、客户改为“客户 A/B”；AGENTS增加产品表达准则，合成身份ID和来源、只读授权及实际业务Reply保持。没有新框架、代理、iframe、页面存储或业务能力。
- **后端接线：** `createEvaluationServer`第三参数默认为`3002`，启动时严格读取CHAT_PORT；`GET /chat`固定302到已放行当前hostname与该端口，拒绝query/hash/正文，POST仍405、非法来源仍403。聊天沿用已验证EVAL_PORT并保持当前hostname，避免localhost跳127的跨站拒绝。聊天启动的CHAT_PORT改用`??`，显式空值不再默认为3002。两服务仍独立启动，导航隐藏了服务边界，没有把两服务合成SPA；返回后重新读取已有cookie会话。
- **Kimi与个人边界：** 实际CLI `2.1.1`、两次调用均核对`kimi-code/k3`、model `k3`、`thinkingEffort=max`；耗时237.688＋35.183＝272.871秒，预算已关闭。Kimi产出导航/文案及busy click、aria-disabled、persisted pageshow重载，Codex负责后端、检查、文档和最终联调；评测品牌的`href="/chat"`单属性由Codex复用已生成的同一固定返回地址机械接线，不算Kimi产出。私有来源与集成前后SHA在忽略的`.runtime/kimi-chat-nav-provenance.json`；生成用量/费用未知，不补零。
- **工程与失败记录：** 最终`node scripts/web-chat-ui-check.mjs`、`node scripts/web-chat-check.ts`、`npm run typecheck`通过，`node scripts/eval-check.ts`及其原有离线评测/实验回归通过，独审和差异检查通过。UI覆盖同标签、当前alias与自定义EVAL_PORT、非法URL、busy click及BFCache持久恢复分支；HTTP覆盖默认/自定义CHAT_PORT与两hostname、非法端口/来源/参数/正文。首次导航夹具使用fetch传Host被底层忽略，改为实际Node HTTP；一次TS响应类型错误已修，Prompt准备substring错误发生在请求前，未产生模型调用。不改固定业务题/gold/结果，也未重跑全量validate或付费题集。
- **实际浏览器：** 1280×720与390×844下共有主导航/次级导航、三个内部视图正常，390下两页scrollWidth均390。localhost会话用客户B与configured/off/1024，唯一宿主命令`查询到账 COUPON-1001 银行卡`返回完整归属拒绝；往返后客户B、完整历史、配置逐项一致，tab数量不变。浏览器Back/Forward和品牌返回通过；默认127.0.0.1也实际往返成功。原生浏览器返回成功与工程中persisted事件分支证明分开，不声称引擎必定启用了BFCache。联调默认客户A/configured/off/2048已还原，最终console warn/error为空；0业务远程模型/QQ/业务写入，查看实验视图没有启动实验。
- **截图与边界：** 忽略的`.runtime/web-navigation-chat-desktop.jpg`、`web-navigation-chat-mobile.jpg`、`web-navigation-evaluation-desktop.jpg`与`web-navigation-evaluation-mobile.jpg`保留实际预览。一次手机截图被工具缩为390×219，改用浏览器clip后保存390×844，未将缩略捕获作为布局验收。完成历史/已应用配置恢复不包括未发送草稿、失败UUID与未应用设置；重启两服务会清空临时聊天上下文，重启前已核对无活动实验和用户无草稿/空闲。本片不认领商业效果、模型质量或QQ新成绩；旧C1/O4/O5状态保持，package/lock及IDE工作区变更不混入提交。

复现：按现有启动命令运行两服务，在`http://127.0.0.1:3002/`点击“评测工作台”，再点“客服问答”或品牌返回；localhost入口同样保持alias。两服务配置同一套CHAT_PORT/EVAL_PORT。检查采用上面四个定向命令，浏览器验收仍限本机合成数据与完整宿主到账命令，不自动追加业务模型调用。

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

## 最近订单、选单续轮与真实流式（2026-10-09）

本轮合同与投入见 [plan 的 P0 记录](../plan.md#订单发现与网页连续交互2026-10-09已验收)。以下实现已完成本轮工程、实库只读、真实模型接线及浏览器分层验收。

- **业务入口：** “我有哪些订单”与缺少订单的“我要退款”先读取可信客户的最近三笔订单，按创建时间及订单号倒序；有更多订单时明确提示可按订单号查询。列表保留商品、门店、整数分金额及券状态，空客户、身份未绑定和数据库失败分别处理。列表不等于退款资格或批准。
- **连贯选择：** 结构化卡的 `selectionText` 为宿主生成的 `选择订单 COUPON-xxxx`。服务端仅接受当前会话已经返回、十五分钟内仍有效的候选，选择后重新授权读取，再恢复原问题并继续 Pi 回合。新问题使旧候选失效；客户端历史卡不能授权新查询或复活旧退款诉求。CLI/QQ 复用同一业务宿主，QQ 仅成功发送后登记候选。网页候选登记在已完成、可按原请求回放的只读回执上，不声称浏览器已经显示或客户已经确认。
- **执行边界：** 网页工具仅 `list_orders / get_order / search_faq`。选单后的退款请求查询本人订单和适用规则，当前页面仍只提供咨询，不创建商家任务、退款方案或退款执行。已有售后入口的批准、展示、精确确认与幂等不因此放宽；金额不来自页面、模型或列表选择。
- **前端体验：** 客服与客户使用本地头像，消息、订单卡和输入区统一对齐。每轮显示中文处理步骤，完成后可折叠回看；它是公开的宿主/工具执行进度，不是模型内部推理。正文来自真实 Pi `text_delta`，无伪逐字动画；中间正文尚未完成，结构化订单和依据以最终 `Reply` 为准，失败不会被显示为业务完成。
- **复用与代价：** Pi 提供工具循环、文本增量和生命周期，项目只映射公开事件、保存有界步骤和接通同源 HTTP。列表采用单条身份关联 SQL；选择 fresh 读取后，模型需要的事实仍重新读取，增加一次选单读取以避免把旧列表当授权和最新事实。会话/选择/步骤均只在内存，不新增数据库表、前端框架或 Pi 核心改动。

### SSE 与最终回执

保留当前 JSON `/api/chat/messages`，前端使用 `POST /api/chat/messages/stream`；正文仍只有 `{sessionId,requestId,text}`，Cookie、JSON、`X-Chat-Request`、Host/Origin/来源校验不变。请求开始前的格式/会话/忙碌/容量拒绝仍为 JSON 4xx。

流返回 `text/event-stream`，每个 JSON payload 均含同一 `sessionId/requestId`：

| event | 字段与含义 |
| --- | --- |
| `start` | `replayed`：本轮新处理或已有完整回执回放 |
| `step` | `id,label,status`；状态仅 `running/done/error`，中文固定业务标签，不含原始参数、工具名或私有思考 |
| `delta` | `messageId,text`；只转发文本增量，同一助手消息拼接，新消息号替换未完成正文 |
| `result` | 原 `WebChatResult` 及有界 `steps`；最终结构化回复覆盖未完成正文，完成历史亦保留步骤 |
| `error` | `status,error`；开始后失败以受控错误结束，会话失效，不写新 Cookie |

完成请求按同 ID 回放只返回 `start + result`，不会再执行模型或重放工具。正在处理的相同 ID 仍 409；连接断开仅停止写流，原只读轮可能继续完成，客户端保留原 ID 时可回放。断连、会话清空、Abort 和页面离开均不证明供应商已停止计费。前端按会话代次、sessionId、requestId 核对每个事件，跨客户或旧页结果不能进入当前会话。

### 复现与验收入口

```sh
node --env-file-if-exists=.env src/web-chat-server.ts
node scripts/order-discovery-check.ts
node --env-file-if-exists=.env scripts/order-discovery-db-check.ts
node scripts/web-chat-stream-check.ts
node scripts/web-chat-check.ts
node scripts/web-chat-ui-check.mjs
npm run validate
```

普通浏览器演示：发送“我有哪些订单”查看本人最近订单；发送“我要退款”，点击结构化订单卡，观察无需另发问题即可继续咨询，再用“这张券现在有没有核销？”续问。切客户后重复列表并尝试查询另一客户的订单；未完成进度、最终答复和拒绝须分别表达。真实模型会产生费用，页面示例只填草稿、点击发送才请求。

新接线探针 `node --env-file-if-exists=.env scripts/order-chat-live-check.ts --live` 限本机合成只读库，固定 8 用户回合、最多 24 供应商 HTTP、15 分钟、每请求 SDK provider 重试为 0；Pi 会话既有整轮重试仍可能发生并计入总 HTTP。一次尝试锁与完整结果保存在忽略的 `.runtime/business-chat-20261009/`，新批次须先建立新 P0 合同，不能重跑旧题追分。不带 `--live` 只检查计划、不发送请求。它检查真实模型/工具/HTTP接线与有界断言，不能推广为自然语言总体准确率、当前 QQ 显示、商家或支付验收。

### 本轮结果与事实时效修复

真实模型两批结果分别保留在[脱敏记录](../data/order-chat-results-20261009.json)，配置为 Pi SDK `1.0.0`、Node `26.10.0`、`deepseek/deepseek-flash`、`configured/off/2048`、本机 `dave_agent_read` 合成数据库。USD 按 Pi 模型目录和供应商上报用量估算，不是账单；供应商没有不可变模型快照，Kimi 用量和费用未采集，人民币不适用。SDK 请求重试为 0，Pi 原有会话重试开启、最多 2 次，所有 HTTP 都计入预算。

| 批次 | 完整计划与结果 | 实际调用、用量及估算 |
| --- | --- | --- |
| entry-v1，`09628d29-17ea-4187-a830-08c78034077a` | 计划 8，执行 4，通过 3、失败 1、未执行 4；失败即停止，原记录未重评分或补跑 | 4 HTTP、4 条有用量、20,704 Tokens、USD 0.00223542 |
| fresh-v2，`9a8b7107-7f3a-4746-8d84-bcd5dbbaa98f` | 按新 P0 合同执行 4 个新输入，4/4 通过；不回填 v1 的未执行输入 | 7 HTTP、7 条有用量、30,469 Tokens、USD 0.002622084 |

v1 的“这张券现在有没有核销？”只沿用历史订单事实，还错误自称本轮查询；严格检查拒收。原工具说明仅明确退款必须 fresh 读取，普通当前状态没有同样要求。修复在共享工具说明、Prompt 和 Skill 中要求当前订单/券状态重新 `get_order`，历史及列表只帮助定位；实际退款操作状态须由当前结果查询提供，订单退款历史不能证明到账。确定性两轮检查更新底层券状态以验证新快照接收，真实模型 v2 用新的核销数量问法验收实际工具调用；该修复没有硬编码答案或重跑旧题追分。v2 同时覆盖客户 B 缺单退款、裸订单号续轮及未命中宿主正则的原生 Pi 最近订单查询。原始 v1 最终源码哈希验证未完成，另存的修前源码已逐文件核验；v2 运行前后源码哈希一致。

**工程与实库：** 最终版本的 `order-discovery-check`、`web-chat-check`、`web-chat-stream-check`、`web-chat-ui-check` 及完整 `npm run validate` 均退出 0。新 SQL 用真实 MySQL 只读账号检查双身份、最近三笔/更多、排序、摘要与详情一致、未绑定、AppID 和注入拒绝；`coupon-agent-check` 验证真实数据库到 Pi 工具回填。无订单客户、读取失败和身份改绑后重新授权的拒绝由确定性夹具覆盖，本轮未改绑真实库、未作事务写入。独立审查另修复完整宿主到账命令后的旧卡复活和网页双份 discovery 状态，相关负控随专项进入 `validate`。

**前端与浏览器：** Kimi K3 Max 两次生成均超时、无代码（600.356 / 285.358 秒），预算关闭后用户明确授权 Codex 子代理完成前端。独立合成 SSE 浏览器检查验证正文/步骤先于最终回执、单击续轮和忙碌禁用；实际 app 的检查覆盖 3 字节 UTF-8 分片、CRLF/多行帧、会话/请求代次、异常 EOF、原 UUID 重试与最终事实卡替换。最终真实服务在 1280×720 / 390×844 下无横向溢出（内容宽 1265 / 375），双客户只显示本人订单，完整到账指令插入后旧卡拒绝，控制台 warn/error 为 0。浏览器仅执行宿主只读请求、0 追加模型；真实模型文本流另经实际 HTTP reader 验收。截图按明确 clip 保存为 1280×720 和 390×844，位于忽略的 `.runtime/business-chat-20261009/web-chat-real-desktop.png` / `web-chat-real-mobile.png`。真实屏幕阅读器及当前 QQ 客户端未验。

最终完整验证日志为忽略的 `.runtime/business-chat-20261009/validate-final-accessibility.log`，原始模型记录及 Kimi 来源也保留该目录。公开结果包含固定分母、合成回执、实际配置与源码哈希；本地原有依赖改动只纳入哈希快照、未混入本轮提交。`--live-fresh` 对应 v2（4 输入 / 12 HTTP / 10 分钟），与 v1 一样每批只允许一次；本轮两批预算均已关闭，不追加付费浏览器问答或其他候选实验。

## 前端体验持续优化（2026-10-09，进行中）

用户要求由 Codex 直接优化客服问答与评测工作台，不使用 Kimi，持续检查至北京时间 2026-10-09 10:00。按可复现问题逐片实现、验证和收尾；到点停止新增改动，保留未验项。当前目标不改变 C1/O4/O5、默认模型或网页只读业务范围。

| P0 项目 | 当前合同 |
| --- | --- |
| 真实业务约束 | 客服消息、订单状态、金额、处理步骤与错误均由现有实际合同展示；选单只提供咨询上下文。改善用户查看历史、输入、切客户和审查评测的体验，身份与请求隔离不变 |
| 具体面试追问 | 流式答复如何避免打断历史阅读和辅助技术使用；运行记录切换失败如何恢复；手机首屏、长内容与键盘交互如何用证据验收 |
| 个人实现与复用 | Codex 修改现有原生 DOM/HTML/CSS 与确定性检查，复用共享主题、Pi 生命周期及现有后端；不新增框架、依赖、业务写入或静态假指标 |
| 验收及演示证据 | 修复前确定性失败与修后专项检查；实际页面桌面/手机尺寸、溢出、焦点、长消息与错误恢复，最终版本完整 `npm run validate`；工程、真实浏览器和真实业务调用分别记录 |
| 投入预算与停止条件 | 每片最多一轮实现和集中修正，约 45 分钟；0 新业务远程模型、QQ 或数据库写入。通过则记录结果并转入下一有证据的问题，失败或预算到则保留未验状态；全部持续工作截至 10:00 |

### 第一轮：历史阅读、草稿与运行选择（03:27 记录）

- **修复前证据：** 上滚位置断言为 `1400 !== 240`；新轮提交替换既有历史 DOM、展开依据变回收起；最终回执增加输入框 focus 次数；同客户新对话清掉未发送原文；评测切换移除聚焦按钮。新增确定性断言均在旧实现失败后修正，不以样式类名代替行为验收。
- **实际改动：** 聊天只追加完成历史、更新临时消息，保留已展开依据/步骤与用户上滚位置；最终回执尊重历史焦点和非折叠选区。同客户新对话/设置保草稿，跨客户有草稿先确认，取消零 HTTP、成功清稿、400/409 失败回滚。品牌与当前页导航改静态当前页，避免误刷新丢失处理中状态。评测切换保留记录节点，详情明确 loading/error/retry 与 `aria-busy`，重试回对应记录或命名详情区；缺 Agent 步骤只表示未记录步骤，不能据此宣称所有提供商调用为零。
- **视觉与取舍：** 复用两页共享主题，将 muted/red/green 深化，辅助文字在白底对比度从约 3.92 提高至 5.39（面板软底 5.06、页底 4.91）；输入框焦点统一。聊天卡片按动态视口分配消息区/输入区，移除空态继承的多余大内边距，手机主导航、问题引导、选单、发送和应用设置触区至少 44px、短屏输入框在内部滚动；未覆盖所有辅助控件。保留原生控件与共享 CSS，代价是共享变量需两页检查；未引入设计组件库或持久草稿。
- **最终工程检查：** `web-chat-check`、`web-chat-stream-check`、`web-chat-ui-check`、`eval-ui-check`、`experiment-ui-check` 与最终 `npm run validate` 全部退出 0；最后 CSS 修订后重跑聊天 UI 与完整 validate。独立源码审查未发现身份、金额、Reply、旧请求/代次或旧响应门禁回归。日志位于忽略的 `.runtime/frontend-20261009/`，不纳入仓库。
- **浏览器证据：** 实际问答页 1280×720 发送按钮 bottom=669.80px，390×844 为 806px，320×568 为 526px；对应内容宽 1265/375/305，无横向溢出。桌面及常见手机空态的三条引导完整可见，320×568 消息区需内部滚动。完整 `查询到账 银行卡` 宿主只读回复正常，未新增模型问答。合成 HTTP 浏览器验收证明记录失败重试回 `focus-a`、Enter 切换后保持 `focus-b`、notice 消失且 busy=false；15 秒合成流开始/结束时历史步骤保持展开、焦点和 scrollTop=0，上滚选区保持非折叠、scrollTop=579.5。合成传输不算真实模型成绩。
- **保留未验与失败：** 内置浏览器无法通过自动化识别/关闭原生 `window.confirm`，实际跨客户取消步骤被阻塞，已请求用户点取消；逻辑由实际 app 的确定性 VM 检查覆盖，但不声称实际弹窗验收通过。真实屏幕阅读器、移动设备虚拟键盘及 QQ 本片未验。首次桌面空态第三条引导裁切已集中修正；早期连续 viewport 采样出现尺寸未稳定的记录，最终尺寸以刷新后单次核验为准。

本片 0 新远程业务模型/QQ/数据库写入；截图 `chat-desktop.jpg`、`chat-mobile.jpg`、`chat-real-reply.jpg`、`eval-desktop.jpg` 与合成服务源码仅在上述忽略目录。工作区已有 README/plan/package/lock/IDE 的并行修改保留，本片尚未提交或推送。目标继续至 10:00；下一独立候选是实验任务每两秒轮询重建详情导致折叠/焦点丢失，先复现再决定最小修复，不重跑业务实验。

### 第二轮：任务跟踪与明确的恢复动作（03:47 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 轮询必须持续显示实际任务进度和新结果，同时保留已完成结果的阅读状态；跨客户确认清除旧草稿，不传承业务身份；历史结果对比不受当前总览筛选数量误阻断 |
| 具体面试追问 | 两秒轮询怎样更新数据而不销毁键盘焦点/折叠内容；如何明确说明切客户后果并默认保留原客户；从实验导入历史 A/B 后如何在失败时重试 |
| 个人实现与复用 | 复用现有任务/结果 DOM 构造、epoch 守卫、对比 API 与原生 HTML `dialog`，只修改展示层和检查，不改 runner/远程授权/业务后端/指标 |
| 验收及演示证据 | 先复现轮询 DOM 丢失与工程列表 0/1 条时对比按钮误禁用；覆盖无变化/新进度/新增或修订结果/切任务/旧响应，以及 dialog 取消/Escape/确认/失败/重复动作；最终专项、validate、实际浏览器与宽窄屏分别验收 |
| 投入预算与停止条件 | 三个互不写同文件的有界切片，本轮约 45 分钟；0 远程业务模型/DB 写入/QQ。一次实现及集中修正后记录通过或失败，不启动实验以制造任务；截止仍为 10:00 |

上一轮临时浏览器标签已随轮次清理，旧句柄消失；当前实际工作台能够重新打开。原生确认的确定性逻辑通过与实际工具控制失败均保留；第二轮将确认改为页内原生 `dialog`，使动作后果、默认取消和焦点可直接检查，不声称旧失败已通过。

- **实际改动与负控：** 实验任务列表、同任务配置及未变化的完成结果保留 DOM；进度、新增结果、修订结果和终态缺项继续更新。旧实现的展开内容被轮询移除、工程总览 0 条时历史对比失败后按钮误禁用，均先由回归复现。对比恢复按当前有效且不同的 A/B ID 判断，不依据总览条数。跨客户草稿确认改原生页内 `dialog`，每次打开重置为取消，关闭时复核原身份/会话；取消零请求，确认只触发一次，失败保稿。
- **视觉细节：** 状态文字复用深化后的共享色值；在白底叠加各状态背景时，通过/失败/进行中/待执行/混合状态对比度分别约 4.74/5.18/5.60/4.93/5.48。相等配置标签取消额外透明度，侧栏分数不折行、不压缩；禁用按钮使用不可操作指针，命名详情区也显示键盘焦点。这是所测组合的颜色计算，不声称全站或辅助技术认证。
- **最终工程检查：** `web-chat-ui-check`、`eval-ui-check`、`experiment-ui-check`、`web-chat-check`、`web-chat-stream-check` 与最终 `npm run validate` 均退出 0，差异空白检查通过。独立只读审查未发现业务授权、费用口径、远程调用门禁或旧响应隔离回归。运行文件冻结后仅补记录，未提交或推送。
- **实际浏览器：** 页内确认默认聚焦“保留当前客户”；取消和 Escape 保留原身份与草稿并回焦角色选择，确认成功切角色并清稿；390×844 对话框宽 343px、两按钮高 44px，无越界。合成任务由 1/3 更新至 2/3、随后中断，第一份 JSON 持续展开且保留 summary 焦点，终态显示未执行 1 次。工程总览 0 条时导入历史 A/B，首次 HTTP 500 后按钮保持可用，再次成功展示对比；不把合成通过率记作业务模型结果。实际工作台 1280×720 分数保持单行，合成对比/任务页 390×844 内容宽 375px，无页面横向溢出。
- **证据与未验：** 日志、源码哈希及 `dialog-*.jpg`、`experiment-poll-proof.json`、`experiment-compare-proof.json`、`experiment-layout-proof.json`、`eval-final-desktop-round2.jpg` 留在忽略的 `.runtime/frontend-20261009/`。本轮 0 新远程业务模型/数据库写入/QQ；真实屏幕阅读器、移动设备键盘及原生 dialog 的完整平台焦点循环未验。窄屏评测操作触区仍有低于 44px 的项，留作下一轮有界检查，不将当前界面宣称为企业级认证。

### 第三轮：实验控件名称与手机触区（03:55 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 实验策略/阈值必须能按名称识别，手机能稳定选择和展开；参数、指标及付费授权保持实际行为 |
| 具体面试追问 | 怎样从标签关联和实际点击/键盘名称检查可访问性；共享样式如何避免影响客服页 |
| 个人实现与复用 | 两个已有容器改原生 label，复用现有控件事件与主题；只在评测页手机断点扩大触区，不引入组件库 |
| 验收及演示证据 | 旧实现标签无关联负控；A/B 四控件关联检查；浏览器名称/文案点击聚焦，宽窄屏控件尺寸、溢出及展开/筛选操作，最终专项与 validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/数据库写入/QQ；通过即记录，平台未验项保留，不启动真实实验；持续目标仍至 10:00 |

两处策略/阈值容器改原生 `label`，A/B 四控件关联检查修前失败、修后通过，原参数、说明和事件保留。评测页新增明确 body class，手机断点将按钮、选择框、折叠入口和复选框标签扩大至至少 44px；复用原生复选框，不放大其图标。初版最小宽度覆盖运行卡片，实际截图暴露长标题被压成窄列，集中修正为排除 `.run-button`；最终卡片仍为 216px，横向条 scrollWidth=11208、clientWidth=341，页面本身不横滚。视口覆盖未生效的 1280×720 采样另存 `viewport-invalid-round3.json`，不纳入手机验收。

最终实际工作台 390×844：总览所采 84 个可见布局控件最小高度 44px、无小于 44px 的宽度；点击“失败 0”正确显示空分类。A/B 策略与阈值均有实际可访问名称，点击 A 的文案分别聚焦对应控件；off 时阈值禁用，切 score 后可聚焦，Tab 到高级参数显示 2px 焦点线、Enter 展开；表单仍未授权远程调用、提交禁用。320×568 表单和 390×844 总览/实验页内容宽分别 305/375，无页面溢出。共享聊天页保持 profile 40px、发送 bottom=806px，证明本片未扩散；同时发现其“新对话”仅 28.5px，留作下一独立手机触区切片。

最终 `web-chat-ui-check`、`eval-ui-check`、`experiment-ui-check` 和完整 `npm run validate` 全部退出 0；修正卡片规则后重跑，独立审查确认共享 CSS 作用域、卡片宽度及标签事件一致。结果与截图 `labels-touch-browser-round3.json`、`eval-mobile-touch-round3.jpg`、`experiment-labels-mobile-round3.jpg` 留在忽略目录；0 新业务模型/DB 写入/QQ，未提交推送。辅助技术仅检查浏览器语义与键盘行为，真实屏幕阅读器及物理手机未验；label 名称包含保留的原说明文本，未据此宣称全面可访问性合格。

### 第四轮：客服手机辅助操作（04:08 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 手机切客户、开始新对话和展开配置/依据容易操作；草稿、会话隔离与实际结果继续按现有合同执行 |
| 具体面试追问 | 主操作变大后辅助入口是否遗漏；短屏/长消息/展开状态怎样检查输入区与内部滚动；键盘发送怎样处理中文输入与错误恢复 |
| 个人实现与复用 | 修现有 chat-page 手机断点触区，复用原生控件；只读审查复现重置期间仍显示旧“已回复”，在共享 resetConversation 补新建/切客户进行中状态，不改请求或业务边界 |
| 验收及演示证据 | 保留新对话 28.5px、角色选择 40px 的实测负证据；延迟重置检查等待反馈、单次请求和成功/失败恢复；设置与长消息折叠，390/320 手机触区、输入区位置与溢出；最终专项和 validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；一轮实现和集中修正后收尾，真实手机键盘仍未验；持续目标至 10:00 |

手机断点扩大聊天按钮、选择框、折叠入口至至少 44px，小型步骤/依据/设置折叠加内边距，未增加最小宽度覆盖。修前新对话 28.5px、角色 40px、设置折叠 27.80px、三个配置选择 34.5px；修后均 44px。实际 390×844 / 320×568 的页宽 375/305，页面无横向溢出，首屏发送 bottom=806/530px，短屏消息区内部滚动；长历史步骤与依据均能展开，入口高 44px。点击折叠引起的正常页面/消息滚动分别记录，不把滚动后的屏幕坐标当首屏位置。

共享重置方法补三种等待反馈，旧版延迟负控仍显示“可咨询”（另一个探针复现“已回复”残留）；新回归覆盖同客户保稿、跨客户成功清稿、400/409 保原身份/历史/草稿、等待期单次请求及设置原反馈。实际合成 HTTP 延迟 3 秒，浏览器分别显示新建/切客户/应用设置中；成功后保稿或清稿与合同一致，设置完成前实际快照仍 2048，完成后变 1024，草稿保留。三次重置、0 消息流/业务调用的探针单列，不能当真实后端或模型成绩。

最终聊天 UI 专项与完整 `npm run validate` 均退出 0，独立审查确认身份、代次、草稿恢复及手机 CSS 作用域不变。证据为忽略目录中的 `chat-touch-before-round4.json`、`chat-touch-proof-round4.json`、`reset-browser-proof-round4.json`、`chat-touch-mobile-round4.jpg` 和最终验证日志。0 新业务模型/DB 写入/QQ，未提交推送；物理手机键盘及屏幕阅读器未验。另记录应用设置完成后焦点落到 BODY，作为下一轮键盘恢复候选，先复现其用户操作链再判断最小修复。

### 第五轮：重置操作的键盘焦点恢复（04:23 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 新建/切客户/应用设置完成或失败后，键盘操作有可继续的位置；不得夺走等待期间转移的历史焦点或文字选择，也不改变草稿与授权 |
| 具体面试追问 | 禁用中的控件失焦怎样恢复；异步完成如何区分浏览器失焦与用户主动移到其他内容；旧代次为何不能恢复当前焦点 |
| 个人实现与复用 | 在已有共享重置方法捕获发起控件，仅在 BODY 失焦且无主动文本选择时，以 preventScroll 恢复仍可操作的原控件，复用现有完成答复的焦点保护条件 |
| 验收及演示证据 | 真实 3 秒设置响应已观察 BODY；延迟 VM 负控覆盖新建/切客户/设置、成功/400/409失败，以及用户转移焦点/选文/旧代次；浏览器用键盘发起并核对完成焦点和滚动 |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；一次实现与集中修正，专项及最终 validate 通过即收尾；持续目标到 10:00，真实屏幕阅读器仍未验 |

原版 3 秒设置请求完成后仍为 BODY；共享重置方法在禁用前记录发起控件，当前代次解锁后仅在浏览器失焦、无文本选区且来源仍可操作时恢复。延迟回归覆盖三入口各成功/400/409共九条恢复路径，以及转移焦点、选文、隐藏/移除/无布局/仍禁用来源和旧代次不恢复；旧版负控失败、最终通过。独立只读复核确认弹窗确认以关闭后客户选择框为来源，身份、请求、草稿和历史分支未改。

实际合成 HTTP 浏览器：设置完成焦点为 apply-settings，等待及完成 scrollY 均为 144；同客户新对话返回 new-chat、草稿保留；等待期间转到设置折叠后完成仍在该 SUMMARY；跨客户确认期间保留旧身份与草稿，成功后返回 profile-select、切为 demo-a 并清稿。最终聊天专项与完整 validate 均退出 0。证据为忽略目录 `reset-focus-negative-round5.json`、`reset-focus-positive-round5.json`、`reset-focus-guards-round5.json` 及截图/日志；400/409与文本选区保护为确定性 VM 检查，未当真实浏览器失败验收。0 新业务模型/DB 写入/QQ，未提交推送，物理手机与屏幕阅读器未验。

### 第六轮：评测结果跨视图键盘导航（04:42 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 从实验结果打开运行或带入对比后，键盘可继续查看目标内容；只读跳转不得改变分母、调用授权或运行记录 |
| 具体面试追问 | 隐藏当前视图会如何处理原按钮焦点；异步载入成功/失败怎样维持可继续操作的位置 |
| 个人实现与复用 | 仅在两个明确跳转动作中聚焦现有运行详情容器/基线选择框，复用原生焦点及已有 tabindex；普通页签切换行为保留 |
| 验收及演示证据 | 保留源按钮所在视图被隐藏但未交接焦点的负控；成功/失败四路径与等待期位置，实际浏览器只读合成结果跳转；最终评测专项及 validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；两处共享动作的一次最小修复与验证后收尾，禁止启动实际实验；持续目标至 10:00 |

两处明确跳转在显示目标及建立加载态后同步聚焦：查看运行到稳定 run-detail 容器，带入对比到可操作 baseline。修前真实浏览器两动作均落 BODY；新增八条确定性回归覆盖两动作×成功/失败×等待期间留在目标/主动转焦，两个去修复内存负控失败，普通页签行为保留。实际只读合成 HTTP 延迟 3 秒：详情加载、500 后均留 run-detail，等待期间主动转到客服问答链接后成功也留链接；A/B 首次 500 与第二次成功均留 baseline，按钮正常恢复，工程总览仍为 0 条。原生焦点可揭示目标，无异步迁焦。最终两项评测 UI 专项与完整 validate 均退出 0，独立复核通过；证据 `jump-negative-round6.json`、`compare-jump-negative-round6.json`、`jump-positive-round6.json` 及截图/日志留在忽略目录。0 新业务模型/DB 写入/QQ，未提交推送；真实辅助技术未验。

### 第七轮：流式处理中保留阅读位置（04:42 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 用户收起处理步骤或用键盘阅读时，新文本/步骤到达不重建正在操作的区块；临时文本仍明确未完成，最终回复按可信 Reply 合同展示 |
| 具体面试追问 | 为什么滚动恢复不足以保留交互；如何在流式局部更新时保留折叠、焦点与已选文本，并处理最终/失败/旧代次 |
| 个人实现与复用 | 复用现有消息 DOM 和 pendingTurn 代次边界，仅保留当前轮临时节点并更新对应槽位；最终步骤状态与焦点连续，禁止把临时文本当最终依据或订单卡 |
| 验收及演示证据 | 原版真实 app 的合成 SSE 复现每次 delta/step 重建、收起后重新展开；确定性节点身份/折叠/焦点/文本增量/消息 ID 切换/失败与最终检查，浏览器合成流验证，最终聊天专项与 validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；一项流式稳定性修复与回归，复杂度超出当前交互合同则保留失败并暂缓；持续目标至 10:00 |

同一 pendingTurn 保留两行、正文与处理步骤节点，按步骤 ID 更新，同 messageId 仅追加 Text；新 messageId 清旧临时文本。最终只由校验后的 Reply 原位提升，覆盖临时文字，添加权威卡片/依据；步骤为空时移除旧步骤，仅在原行失焦且无非空选区时有界交接到该行。旧版节点稳定负控失败，去掉选区守卫的内存负控也失败。新增回归覆盖节点、折叠、文本锚点、新消息 ID、最终空步骤、EOF 原文/UUID 重试、旧代次及错身份帧，历史与草稿合同保留。

修前合成浏览器收起步骤后，增量把它重开并落 BODY；修后桌面和实际 390×844 的收起状态及 summary 焦点均保留至完成，最终仅显示权威文本/依据。另一手机合成流双击形成句号非空选区，首段增量后仍选中原字、anchor 原文本及 offset=8；不据此宣称最终覆盖临时文本后仍保选区。一次视口设置落到其他标签的 1280×720 采样明确仅算桌面，随后重测正确 390 宽。最终聊天 UI/HTTP/流式专项与完整 validate 均退出 0，独立复核通过；`stream-collapse-negative-round7.json`、`stream-collapse-desktop-positive-round7.json`、`stream-mobile-collapse-positive-round7.json`、`stream-selection-positive-round7.json` 及截图/日志留在忽略目录。浏览器四次均为合成流，0 新业务模型/DB 写入/QQ；未提交推送，物理手机和屏幕阅读器未验。

### 第八轮：合法长名称的详情可读性（04:42 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 80 字以内的合法实验名称须在运行/任务详情完整可读，不能以页面无横滚掩盖面板内裁切；状态及失败分母保持可见 |
| 具体面试追问 | 怎样区分页面溢出与内部裁切；长连续英文/中文在手机宽度如何验证，为什么不靠截断或改变输入合同 |
| 个人实现与复用 | 复用现有详情页头，仅补标题容器宽度约束及断词，保留面板圆角、运行卡片宽度与原始标签 |
| 验收及演示证据 | 80W 合成记录的修前/修后 390/320 布局尺寸、完整文字、状态及页宽；运行与实验专项、最终 validate |
| 投入预算与停止条件 | 单轮约 20 分钟，0 新业务模型/DB 写入/QQ；实际复现后做最小 CSS 修正，一次宽窄屏检查后收尾；持续目标至 10:00 |

80W 合法合成名称在 390 宽的任务/运行页头分别为 991/1296px，被 341px 面板裁掉，页面本身仍仅 375px。三条 evaluation-page 专属 CSS 补标题宽度约束与 overflow-wrap；修后任务/运行分别 313/311px（390）及 243/241px（320），80 字全文换行，scrollWidth=clientWidth；桌面运行标题也完整换行。任务中断 2/3、未执行 1 次，运行客观口径及 3/3 分数保持。面板圆角、216px 卡片、聊天页和表格滚动均沿原规则，独立只读复核通过。最终评测/实验 UI 专项与完整 validate 均退出 0；证据 `title-negative-round8.json`、`title-run-negative-round8.json`、`title-positive-round8.json`、`title-desktop-round8.json` 及正验截图留在忽略目录。最初任务负控截图只覆盖文档顶部，不用作标题裁切的视觉证据；负控尺寸与运行截图有效。0 新业务模型/DB 写入/QQ，未提交推送；不同真实设备字体与缩放仍未验。

### 第九轮：A/B 导入选项一致性（05:03 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 同一运行 ID 在比较选择框只出现一次，重复导入/重试不制造另一条记录；既有名称/时间、选择值和后端可比性门控保留 |
| 具体面试追问 | 如何区分前端选项重复与实际重复执行；为何按唯一运行 ID 复用选项，不按相同文案判断 |
| 个人实现与复用 | 在既有 expCompare 两侧，仅缺相同 value 时追加原生 option；复用 renderPickers 已有条目及第六轮焦点交接，不增加缓存层或 API |
| 验收及演示证据 | 真实合成浏览器两次导入后每侧两个同 ID/同文案选项；修前负控、重复/既有/不同 ID 检查、浏览器下拉重导入；最终评测专项与 validate |
| 投入预算与停止条件 | 单轮约 20 分钟，0 新业务模型/DB 写入/QQ；一次最小修复与回归，通过即收尾；持续目标至 10:00 |

每侧按完整运行 ID 检查已有 option，仅缺失时追加；保留既有节点、名称与时间，不按短 ID 或相同文案去重。原版真实合成浏览器重复导入后每侧各两条；修后重新载入、两次导入均只有一条对应记录，值与文案不变，焦点留 baseline、对比可用，工程总览仍零条。确定性检查覆盖既有 renderPickers 节点、相同显示短 ID 但不同完整 ID，以及同 ID 禁用/零请求；原版重复负控失败。已加载旧脚本的标签页须重载取得修复，不另增历史选项清理机制。独立只读复核及最终实验/评测 UI、完整 validate 均退出 0；证据 `duplicate-options-negative-round9.json`、`duplicate-options-positive-round9.json`、`compare-positive-round9-11.jpg` 留在忽略目录。仅合成只读 GET，0 新业务模型/DB 写入/QQ，未提交推送。

### 第十轮：订单卡选择保留未发送问题（05:03 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 用户在输入框写好另一段问题后，点选订单不得静默覆盖并丢稿；既有空框选单续接和同一命令失败 UUID 重试保留，只读选单不扩写入权限 |
| 具体面试追问 | 为什么网络失败也找不回草稿；如何在入口阻止覆盖而不增加两套草稿/重试状态，保留原确认与授权链 |
| 个人实现与复用 | 仅在订单选择按钮入口检查不同的非空原文，保稿、零 POST、提示先发送或清空并聚焦现有输入框；空框/相同命令复用原 submitMessage |
| 验收及演示证据 | 原版实际 app 的内存合成请求失败后仅剩选单命令；多行草稿/空白原文/相同命令/空框/忙碌与身份检查，合成订单卡浏览器正验，最终聊天专项与 validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；一处入口防丢稿与回归，禁止引入新弹窗或后台草稿缓存；持续目标至 10:00 |

订单卡原门禁之后，遇到不同且非空的输入原文，仅提示先发送或清空、聚焦输入框并返回；空输入及完全相同命令继续原提交流程。修前合成浏览器多行问题被覆盖，500 后仅剩选单命令；修后多行、空白原文及实际 390×844 均保稿、保历史、焦点回输入框，累计请求仍为修前 1 次。手机按钮 104×44px、页宽 375px，无页面横滚；清空后继续选单，第二次合成流成功，输入清空、状态已回复、原订单卡保留。观察时误用“发送启用”等待完成，空输入本就禁用发送；随后按实际状态/新对话启用/最终回复核对，记录该观察修正。

回归覆盖多行/空白/其他订单/尾随空格、busy/init/expired 原门禁、历史/设置/失败对象不变，以及同精确命令失败后按原 UUID 重试与忙碌重复点击；修前负控失败。独立只读复核通过，最终聊天 UI 及完整 validate 退出 0；聊天 HTTP/流式专项在本轮最终 JS 上亦退出 0。`card-draft-negative-round10.json`、`card-draft-positive-round10.json`、`card-draft-mobile-positive-round10.jpg`、`card-empty-positive-round10.json` 及请求探针留在忽略目录。两次均为合成 HTTP（一次 500、一次成功流），0 新业务模型/DB 写入/QQ；未提交推送，物理手机与屏幕阅读器未验。

### 第十一轮：悬停文字可读性（05:03 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 主按钮与折叠入口在启用及悬停时保持可读，鼠标操作不能降低已有文字对比度；共享主题保持协调，状态真值及操作权限不变 |
| 具体面试追问 | 常态颜色检查为何会漏过 hover；共享 token 修改的作用面如何核对，怎样保留实际浏览器状态与数值边界 |
| 个人实现与复用 | 仅调深现有 --sage，复用按钮、折叠和焦点样式，不新建配色分支或组件；核对所有 token 使用点 |
| 验收及演示证据 | 白字按钮悬停 4.304、浅面板上同色文字 4.035 的修前数值；浏览器实际 computedStyle/hover 状态、各现有背景上修后值、截图与最终专项/validate |
| 投入预算与停止条件 | 单轮约 20 分钟，0 新业务模型/DB 写入/QQ；一处 token 的一次修正与状态复核，平台无法观察的 hover 不宣称验收；持续目标至 10:00 |

共享 --sage 从 #59836a 调深为 #51775f，逐一核对按钮、折叠、边框、焦点及品牌使用点，其余 CSS 字节保持。白色/浅面板/页面背景上的对比度分别从 4.304/4.035/3.921 变为 5.056/4.740/4.605；sage-tint 上为 4.356，此用途是焦点/边框/装饰，正文仍用 deep。实际浏览器鼠标点击使主按钮与设置 summary 处于 :hover：启用按钮 opacity=1、白字 12px、背景 rgb(81,119,95)；summary 12px 同色、最近不透明祖先白色。修前同状态均为 rgb(89,131,106)。最终三个 UI 专项和完整 validate 均退出 0；`hover-primary-negative-round11.json`、`hover-primary-positive-round11.json`、`hover-summary-negative-round11.json`、`hover-summary-positive-round11.json` 及统一源码 hash/日志 `round9-11-evidence.json` 留在忽略目录。0 新业务模型/DB 写入/QQ，未提交推送；颜色数值与浏览器状态不等于真实设备或全面可访问性验收。持续目标保持至北京时间 10:00，下一片先只读核查尚未覆盖的用户路径。

### 第十二轮：失效会话的新对话入口（05:13 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 会话失效后提示用户新建，顶部同名入口必须能恢复；先重新读取当前会话，不能直接绕过旧 UUID/null 前提、跨身份保稿或重放失败写入 |
| 具体面试追问 | 客服超时后服务端清空会话，前端旧 UUID 仍在时怎样恢复；普通重置与重新连接为何不能混用 |
| 个人实现与复用 | 失效状态的新对话入口复用既有 initialize(preferredProfileId)，健康状态继续原 resetConversation；不改服务端、会话校验或业务权限 |
| 验收及演示证据 | 503 失效后旧 UUID 重置 401、重新连接再失败后按钮无操作的确定性负控；原初始化读取/null 创建、同身份保稿与跨身份清稿、重复点击/迟到隔离；合成浏览器及最终专项/validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；一处入口修复与回归，通过即收尾，不扩登录/持久历史；持续目标至 10:00 |

顶部新对话在忙碌时返回、失效时复用 initialize(profileId)、健康时沿原保稿重置。两条旧版负控分别暴露直发旧 UUID 和重连失败后无请求；修后检查配置 GET→会话 GET→只有已读 null 才 POST null、延迟时重复零追加、同身份精确保稿、外部其他身份只 GET 接回并清稿、失败后再恢复、实际设置而非未应用编辑、旧代次隔离。负控与聊天 UI/HTTP/流式专项为子代理已有工具输出，根代理最终 UI/validate 日志另落盘，均退出 0；独立只读复核通过。

实际浏览器合成 503 后点顶部新对话，重新读取并创建新 UUID，客户 demo-b、Flash/off/1024 及带尾空格换行的原文保留；探针只在读到 null 后创建，未发旧 UUID 重置。辅助服务器第二次配置 GET 故意断开 socket，但浏览器自动再发第三次 GET 并恢复，因此此路径只算成功恢复，不算浏览器重连失败验收；后者按确定性检查记录。证据 `recovery-positive-round12.json`、`recovery-positive-round12.jpg` 和 `round12-14-evidence.json` 留在忽略目录。0 新业务模型/DB 写入/QQ，未提交推送；初始化完成后焦点仍 BODY，作为尚未实现的下一候选保留，不把恢复入口修复当焦点验收。

### 第十三轮：高级数值参数清空（05:13 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 清空输入不能静默成为可实际生效的零阈值；表单显示、配置下载与提交参数保持一致，显式 0 与省略/null 的原合同继续区分 |
| 具体面试追问 | Number(空字符串) 为什么会使阈值变化，原生输入限制为何不能代替状态同步；怎样在不新建校验体系的情况下保持实验可复现 |
| 个人实现与复用 | 高级数字字段 change 复用已有非法值回退路径，空值恢复当前参数显示；不改后端范围、预设或 v2 必填阈值合同 |
| 验收及演示证据 | 原版浏览器键盘删除 0.5 并 Tab 后，空显示而完整 JSON 为 0；已有/省略/null/显式0及参数提交检查，修后浏览器表单/JSON，最终专项/validate |
| 投入预算与停止条件 | 单轮约 20 分钟，0 新业务模型/DB 写入/QQ；一处共享数字入口修复与回归，通过即收尾，不授权实际实验；持续目标至 10:00 |

共享 change 仅补空字符串门槛和 nullish 显示回退：清空已有数字恢复原值，省略/null 仍为空且不补键，显式 0 继续有效。修前回归失败；修后覆盖 0.5 清空恢复、0 再清空、有限小数、非有限值原回退、缺省字段、v3/null 历史及原禁用状态，并调用实际 downloadExpConfig 读取 Blob JSON，与合成提交体整对象一致；不新加 min/max 规则或 disabled 事件分支。浏览器键盘删除/Tab 后输入与完整 JSON 都为 0.5，明确键入 0 后两者均为 0，远程授权仍未勾选、提交禁用。最初直接 fill 的观察没有触发 change，另存后改用原生键盘操作，不当失败负控。独立复核、最终实验/评测 UI 及完整 validate 均退出 0；`numeric-empty-negative-round13.json`、`numeric-empty-positive-round13.json` 及日志留在忽略目录。0 新业务模型/DB 写入/QQ，未提交推送。

### 第十四轮：窄屏场景筛选完整可见（05:13 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 320px 时全部/失败/跳过/缺失筛选都可完整阅读、点击与键盘聚焦；缺失计数与固定分母不因布局裁切而隐藏 |
| 具体面试追问 | 页面无横滚为何仍会裁掉控件；390px 正常为何不能代表窄屏，怎样让按钮完整显示又保留单个文案与触区 |
| 个人实现与复用 | 评测页手机断点让现有 case-toolbar 换行并约束宽度，复用原筛选事件；桌面及聊天保持原规则 |
| 验收及演示证据 | 实际 320×568 正常一场景，第四按钮右边界 301.98、面板右边界 289，被 overflow:hidden 裁切；修后四按钮边界/44px/筛选与键盘焦点、390/桌面，最终专项/validate |
| 投入预算与停止条件 | 单轮约 20 分钟，0 新业务模型/DB 写入/QQ；一条窄屏布局修正与实际复核，通过即收尾；持续目标至 10:00 |

仅手机断点评测页 case-toolbar 增加 wrap/max-width。修后实际 320×568 总览宽 243px、scrollWidth=clientWidth，“缺失”移到第二行，四按钮均高 44px且完整在面板内；Space 激活缺失 0，正确显示该分类无场景并保留可见焦点。390×844 四项保持同一行，1280×720 桌面仍 nowrap；320px A/B 三类筛选宽 218px、均 44px且未裁切。两个构造入口及作用域独立复核通过，聊天/216px 卡片/长标题不匹配新规则。最终两个评测 UI、聊天 UI 和完整 validate 均退出 0；`filter-negative-round14.json`、`filter-positive-round14.json`、`filter-positive-round14.jpg`、`filter-other-widths-round14.json`、`filter-compare-positive-round14.json` 及最终源码 hash/日志留在忽略目录。0 新业务模型/DB 写入/QQ，未提交推送；实际字体缩放、物理手机与屏幕阅读器未验，持续目标仍至北京时间 10:00。

### 第十五轮：重新连接后的键盘焦点（05:34 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 主动重新连接后，键盘能继续新建或输入；首次打开不自动抢输入，等待期间主动转焦/选文及旧代次不被完成事件覆盖；身份与草稿恢复合同保留 |
| 具体面试追问 | 重置入口已有焦点保护，重新初始化为何仍会掉 BODY；成功隐藏重试按钮时如何交接到合理且可操作的目标 |
| 个人实现与复用 | 复用现有 BODY/文本选择/可布局/当前代次保护与 preventScroll；发起控件可用时恢复，明确重试成功且原控件隐藏时交接现有输入框，不改连接请求或原生禁用行为 |
| 验收及演示证据 | 第十二轮浏览器顶部新对话恢复后 BODY 负证据；首次/主动重试/顶部恢复、成功/失败、转焦/选文/隐藏/旧代次回归，延迟合成浏览器与最终专项/validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；共享初始化焦点一次修复与回归，通过即收尾，不扩会话或提示体系；持续目标至 10:00 |

initialize 仅捕获主动发起的新对话或重试控件；当前代次完成后、焦点落 BODY 且无选文时，恢复仍可布局的发起控件，重试成功隐藏原按钮才交接输入框。首次打开不自动聚焦，等待期间用户转焦、选文及旧代次保持原保护。旧版实际浏览器顶部恢复与重试成功后均落 BODY；修后 3 秒延迟的顶部恢复聚焦 new-chat、重试成功聚焦 chat-input、HTTP 500 失败聚焦可再操作的 init-retry，原客户 demo-b、Flash/off/1024、含空格换行草稿及 scrollY=0 保留。等待期间转焦“聊天设置”后，成功完成仍留在那里。一次等待工具在 3 秒完成附近超时，随后读取同一标签页确认已是 HTTP 500 终态，未重启或重复该请求。确定性负控、首次/转焦/选文/隐藏/移除/迟到回归及聊天 HTTP/流式专项为子代理工具输出；最终三个 UI 专项及完整 validate 均退出 0。证据 `initialize-focus-negative-round15.json`、`initialize-focus-positive-round15.json`、`initialize-retry-focus-positive-round15.jpg` 和统一 `round15-17-evidence.json` 留在忽略目录。0 新业务模型/DB 写入/QQ，未提交推送；这些是本机合成传输和浏览器键盘检查，物理设备与屏幕阅读器未验。

### 第十六轮：历史方案 ID 的复制与文案（05:34 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 合法历史配置可使用唯一自定义方案 ID，载入后的复制不能制造重复 ID；显示、删除、下载和提交都对应实际方案，保留原历史快照与参数 |
| 具体面试追问 | 为什么首个方案不一定叫 A；合法历史 B 复制后两个 B 如何破坏可复现配置，按钮文案怎样保持数据身份一致 |
| 个人实现与复用 | 仅单方案复制时选未占用的 A/B ID，复制/删除及完整参数 JSON 显示实际 ID；复用既有深拷贝、表单和后端唯一性合同，不重编号历史或加 ID 编辑器 |
| 验收及演示证据 | 合法单 B 历史载入→复制产生 B/B 的旧负控；A/B/自定义 ID 复制、参数深拷贝、实际删除/JSON key 与内层 ID 一致、下载/合成提交一致性，合成浏览器及最终专项/validate |
| 投入预算与停止条件 | 单轮约 20 分钟，0 新业务模型/DB 写入/QQ；一项复制根因与对应文案修复，通过即收尾，不运行实际实验；持续目标至 10:00 |

单方案复制选择未占用的 A/B，按钮、删除和完整 JSON 都显示实际 ID；原 A→B 行为保持，合法 B→A 或自定义 ID→B 不重编号历史。原版确定性负控为 B/B；修后检查深拷贝隔离、实际删除、原历史快照不变、实际 Blob 下载与合成提交对象一致。第一版浏览器已得到 B/A，但完整 JSON 仍沿旧位置标 A/B；该部分证据保留为 `single-b-copy-positive-round16.json`，发现后补齐共享 JSON 展示调用点，并以原行负控失败后重跑最终检查。最终浏览器卡片与 JSON key/内层 ID 均为 B/A，两个参数对象相同；点“删除 A”只留下 B 并重新出现“复制 B 成 A 对照”。远程授权手动关闭、提交禁用；原任务仍中断 2/3、未执行 1，编辑不改历史。最终证据为 `single-b-copy-final-round16.json`、`single-b-delete-final-round16.json` 及截图；修前后断言与独立复核为工具输出。补齐调用点后最终三个 UI 专项及完整 validate 均退出 0，先前日志另存 before-json-map-fix，不作为最终版本证明。0 新业务模型/DB 写入/QQ，未提交推送。

### 第十七轮：当前工作台导航保留编辑（05:34 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 在工作台编辑未提交配置时，点已选中的主导航不应整页重载丢稿；客服与工作台之间仍用真实返回链接，子视图按既有页签切换 |
| 具体面试追问 | 当前页入口为什么仍会丢内存配置；怎样从真实导航复现而不是只用 VM 检查控件点击，静态当前项与返回链接如何分工 |
| 个人实现与复用 | 沿客服页的静态当前项，把评测页当前导航改 span 并保留 class/aria-current；不加确认弹窗、存储或导航拦截层 |
| 验收及演示证据 | 实际浏览器编辑名称后点工作台，回总览，再开实验恢复默认名称；静态入口及返回链接检查、修后同位置点击/子视图切换保稿，最终专项/validate |
| 投入预算与停止条件 | 单轮约 15 分钟，0 新业务模型/DB 写入/QQ；一处原生语义修正及现有检查更新，通过即收尾；持续目标至 10:00 |

评测页当前主导航沿客服页改为无 href 的 span，原 class/aria-current 和其他链接、子视图按钮保持。实际修前点击当前页会整页重载、返回总览并丢失实验名称；修后同位置点击仍在实验视图，名称“未提交配置保留检查”、重复 2、单 B 及关闭的远程授权保留，切总览再返回也相同。浏览器证据 `current-nav-negative-round17.json`、`current-nav-positive-round17.json` 和截图留在忽略目录。现有检查同时断言静态当前项、拒绝当前项链接及保留 /chat 返回；旧 HTML 负控失败，新检查和最终三个 UI 专项/完整 validate 均退出 0。仅消除当前项误重载，未增加离页拦截或跨页持久草稿；本轮不把真正离页后保稿宣称为能力。0 新业务模型/DB 写入/QQ，未提交推送。持续目标仍至北京时间 10:00；任务列表与详情时点不一致另列只读候选，尚未修改或准入。

### 第十八轮：当前任务的列表与详情状态一致（05:46 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 同一任务详情已明确终止时，旁边列表不继续显示运行中；保留完整计划分母、未执行及失败，不把终态当通过，也不因旧响应回退 |
| 具体面试追问 | 两次 GET 的快照时间不同，终态停止轮询为何会留下永久旧列表；怎样让当前任务状态一致且保留其他任务列表与迟到隔离 |
| 个人实现与复用 | 复用已有轮询的按 ID 同步方式，补齐详情首次读取与列表响应时序；沿现有稳定行更新，不扩后台推送、持久状态或取消能力 |
| 验收及演示证据 | 浏览器列表 running 1/3、同 ID 详情 interrupted 2/3 未执行1的负证据；首次详情终态、旧列表晚到、切任务/详情错误/常规轮询检查，修后浏览器及最终专项/validate |
| 投入预算与停止条件 | 单轮约 25 分钟，0 新业务模型/DB 写入/QQ；修复已证实的当前行同步缺口，通过即收尾，不运行实际实验；持续目标至 10:00 |

renderExpJobs 仅在列表行完整 ID 同时匹配 selected 与当前 job 时用已接受详情显示该行；原顺序、Map 键、按钮和文本节点保持，不反写 jobs/job，也不新增 HTTP。旧版确定性负控分别捕获首次终态仍 running 1/3，以及旧列表晚到仍 running 0/1；修后断言当前行状态/分母、未执行1、终态零轮询、同前缀不同完整 ID、切任务迟到、错误解锁和节点/焦点/展开态保持。一次新增错误 fixture 的 HTTP JSON 文案期待与实际 GET 合同不符，改为网络失败 fixture 后再取得有效旧版负控，未更改产品错误文案。原负证据 `job-list-mismatch-candidate-round18.json` 保留。实际桌面从列表运行中 1/3 点开后，行与详情均中断 2/3；Space 发起的同一任务按钮继续有焦点。390×844 复核中，clientWidth=scrollWidth=375、任务行左右 27/348、高68.95，详情与未执行1完整呈现；探针仅两次直接选中的详情读取，无追加轮询。`job-list-positive-round18.json`、`job-list-mobile-positive-round18.json`、截图和探针均留在忽略目录。独立复核、最终三个 UI 专项与完整 validate 均退出 0；其他任务行仍是列表快照，不宣称实时同步。0 新业务模型/DB 写入/QQ，未提交推送。

### 第十九轮：失效会话的设置应用门控（05:46 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 会话失效后不能让“应用并新建对话”继续携带旧 UUID 失败；用户能明确定位到已验的重新连接入口，恢复后再选择并应用可用设置；不绕过当前会话/已读 null 前提 |
| 具体面试追问 | 模型失败后用户想换模型，为什么健康会话的配置重置接口不能直接复用；控件门控、宿主前提校验与安全恢复各解决什么问题 |
| 个人实现与复用 | 复用设置 locked/应用条件及既有 settings-status，失效时暂停编辑/应用并提示先重新连接；同时覆盖真实提交入口，不新建设置重连或自动提交路径 |
| 验收及演示证据 | 503 失效后选择备选模型、应用仍发旧 UUID/401 的负控；失效禁用与零追加、顶栏/重试恢复后设置解锁、健康配置/400/409/草稿/代次原回归，合成浏览器及最终专项/validate |
| 投入预算与停止条件 | 单轮约 25 分钟，0 新业务模型/DB 写入/QQ；只修失效应用的误导入口，通过即收尾，不扩登录、自动恢复提交或业务权限；持续目标至 10:00 |

只在设置 locked、既有 status 与 settings submit 三处检查 expired，失效提示“会话已失效，请先重新连接”；原 reset/initialize、身份、UUID 与配置校验保持。旧版实际浏览器 503 后仍能选 Pro 并点应用，探针确认发旧 UUID 后 401，实际应用配置仍 Flash/off/1024；原文空格换行未丢，负证据及探针保留。修后 503 四控件禁用，确定性直接表单提交零 HTTP，原 generation/session/messages/failedAttempt 引用和原文保持；覆盖恢复失败继续锁、成功解锁及未应用设置不自动生效。浏览器先顶部重新连接，GET 已读 null 后才以原 Flash 配置 POST null，恢复原文及 new-chat 焦点；随后健康地选择 Pro 再应用，才以新 UUID 产生配置重置并显示已应用。等待工具在连接完成附近超时，读取同页确认成功终态，无重启或第二次重连请求。手机390×844再触发合成503，四控件均高44且左右31/344、clientWidth=scrollWidth=375，失效说明完整可读；实际配置保留上次成功应用的 Pro。证据 `expired-settings-negative-round19.json`、`expired-settings-positive-round19.json`、`expired-settings-mobile-positive-round19.json`、截图与探针及统一 `round18-19-evidence.json` 留在忽略目录；子代理负控、HTTP/流式专项为工具输出。独立复核、最终三个 UI 专项与完整 validate 均退出 0。0 新业务模型/DB 写入/QQ，未提交推送；实际模型服务故障、物理手机及屏幕阅读器未验，持续目标仍至北京时间 10:00。

### 第二十轮：失效会话的客户切换门控（06:15 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 会话失效后，不提供必然旧 UUID 失败的换客入口或清稿确认；先按已验路径重新连接，再走健康会话的身份切换及草稿确认，不引入跨身份自动恢复 |
| 具体面试追问 | 设置已锁而客户仍能切换为何不一致；原生 disabled、change 与共享 reset 的状态门槛如何覆盖空稿、有稿和迟到确认 |
| 个人实现与复用 | 在既有客户 disabled、change 与 reset 前置条件加入 expired，沿原 restoreSelect 回退；不改 initialize、身份来源、null 创建或确认弹窗合同 |
| 验收及演示证据 | 503 后有稿确认及清空后直接换客仍发旧 UUID/401的负控；四类稿件、已打开确认后失效、零 HTTP/状态引用保持、恢复后健康确认与身份切换，浏览器与最终专项/validate |
| 投入预算与停止条件 | 单轮约 25 分钟，0 新业务模型/DB 写入/QQ；一项共享门槛补齐，通过即收尾，不扩跨身份恢复或持久在线；持续目标至 10:00 |

仅在原客户控件 disabled、change 与共享 reset 前置加入 expired，迟到确认沿 restoreSelect 返回。旧版实际合成503后有稿确认和空稿切换均发旧UUID/401，探针保留；修后失效禁选、直接change/共享reset/已打开确认晚到均零追加，四类草稿与状态引用不变。实际浏览器先安全重连，GET null 后以原客户/配置 POST null并保留原文；再确认切客户，以恢复后的UUID新建并清稿，最终选择框有焦点。第一份确认观察仍为“正在切换客户”，另存pending后读取同页最终态，不把pending算完成。独立只读复核、HTTP/流式专项及最终三个UI/完整validate均退出0。证据 expired-profile-negative/positive-round20.json 与探针、截图及 round20-22-evidence.json 留在忽略目录；0新业务模型/DB/QQ，未提交推送。

### 第二十一轮：实验列表错误的正确重试（06:15 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 列表读取失败后的重试必须真实重取列表，不能因详情成功就伪装列表恢复；详情与轮询失败保留对应重试路径、失败和固定分母 |
| 具体面试追问 | 一个共享错误条为何需要区分请求来源；有已选任务时怎样避免按选择状态猜重试目标，以及并行 GET 互相清错 |
| 个人实现与复用 | 复用现有列表/详情请求、错误条、epoch 与焦点保护，记录有限错误来源并按来源重试/清错，不新增请求框架或后台推送 |
| 验收及演示证据 | 现有 harness 纯内存探针：列表错误重试请求 selected detail 且成功隐藏错误，列表未重取；已选/未选的集合重试、真正新行更新、详情/轮询重试、并行清错/迟到隔离、浏览器与最终专项/validate |
| 投入预算与停止条件 | 单轮约 30 分钟，0 新业务模型/DB 写入/QQ；补齐错误来源与对应调用点，通过即收尾，不运行实际实验；持续目标至 10:00 |

错误条记录有限来源 catalog/list/detail，重试按实际来源复用对应GET；成功只清同源错误，原epoch/selected/节点与preventScroll保持。原版浏览器列表失败后的“重试”仅多读详情并隐藏错误，集合仍2次；修后集合第2、第3次故意500，第二次重试第4次成功新增任务，详情仍2/3未执行1，焦点在刷新。探针集合4/详情1，无额外轮询或提交。共享错误条只保留最近错误，不声称错误队列；初始运行详情的另一条故意500与集合失败分开。原一份negative errorVisible字段使用错误的选择器，结论依据实际任务区可见文本及请求探针，未据该布尔值判断。独立复核、最终三个UI/完整validate均退出0，collection-retry-negative/positive-round21.json、探针与截图留在忽略目录；0新业务模型/DB/QQ，未提交推送。

### 第二十二轮：长方案 ID 的完整展示（06:15 记录）

| P0 项目 | 本轮范围 |
| --- | --- |
| 真实业务约束 | 历史配置允许最多24字符方案 ID，手机与桌面窄列不能裁掉身份、复制或删除文案；完整 ID 不改写、不截断，触区与原参数/远程门控保留 |
| 具体面试追问 | 整页无横滚为何仍会在卡片内裁切；合法历史 ID 与默认 A/B 的长度差异怎样贯穿标题、复制、删除三个使用点 |
| 个人实现与复用 | 仅现有 variant head 与复制/删除按钮作用域限宽、断词及页头换行，复用原卡片和操作，不新增短 ID、tooltip 或布局组件 |
| 验收及演示证据 | 源码/字体计算的24W候选，实际320/390载入单长ID及两方案的边界负控；修后复制/删除/完整JSON、44px与默认A/B桌面布局保留，最终专项/validate |
| 投入预算与停止条件 | 单轮约 25 分钟，0 新业务模型/DB 写入/QQ；浏览器负控成立才修改一处作用域 CSS，通过即收尾，不泛化所有按钮；持续目标至 10:00 |


24W合法历史负控在320/390及明确1280桌面成立：整页无横滚，卡片仍被裁切；1280右列删除按钮到908.12，而表单右界675.45。作用域补head换行/min-width与完整标题及复制/删除的max-width/anywhere。修后320复制/删除内部scrollWidth均等clientWidth，删除高64.45；390删除在46..329，高46.30；1280右列按钮在372.73..641.45，正常A/B标题与删除仍一行。真实复制长ID成B、只删B、两方案只删长ID均对应完整JSON，remote未勾选。先前reset默认实际409px，被误命名dualDesktop，已更名dualResetViewport409并追加明确1280记录；不将默认reset算桌面证据。原辅助58805实际进程和会话消失，经lsof/Unknown process确认后同源helper另启59817，非观察超时重启。最终三个UI与完整validate均退出0，截图目视复核，long-id-negative/positive-round22.json及统一hash/日志留在忽略目录；0新业务模型/DB/QQ，未提交推送。


<a id="round23-history"></a>

### 第二十三轮：以咨询与真实会话记录重组产品（06:17 启动，07:01 验收记录）

用户最新要求会话记录、能力介绍、清理无意义小字并允许必要重构，替代此前不扩持久历史的切片范围；仍由 Codex 实现，不使用 Kimi。

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 新建保留已受理记录，能回看并继续咨询；历史保存在本机服务端，刷新/重启可找回。浏览器归属与当前可信客户绑定共同限制历史标题、正文与续聊；过去订单、失败或回复不能作为当前业务授权，网页仍只读 |
| 具体面试追问 | 新对话为何会删除记录；稳定对话ID与运行UUID为何分开；A→B→A旧页、重启中断和丢回执如何阻止误执行或静默重跑；从客户视角如何解释能做什么 |
| 个人实现与复用 | 专用本机 SQLite 记录复用 Node 内置能力；保留 Pi 惰性创建、已有消息→历史注入、业务工具、Reply和公开步骤。重组静态聊天骨架为左历史/中央咨询，保留消息稳定DOM/草稿/IME/焦点，设置评测降为次级入口，不改Pi核心、业务表或依赖 |
| 验收及演示证据 | 完成发送→新建→打开原对话→真实下一轮代码→刷新/跨进程恢复；实际临时磁盘、原子保存失败/损坏/并发、owner与客户绑定隔离、busy/UUID/重放/迟到/失败记录、旧选单拒绝、UI草稿/稳定节点，以及1280/390/320浏览器；最终受影响专项与完整validate |
| 投入预算与停止条件 | 约2小时纵向实现、1小时独立复核及联合验收，至10:00目标继续；0新增远程业务模型/QQ，不启动C1/O4/O5或退款写入。预算用于完成history与用户界面，不追加外围功能；必需检查未通过不提交或宣称完成 |

冻结接口：原 `POST /api/chat/session` 新建并保存旧记录；新增 `GET /api/chat/sessions?profileId=demo-a或demo-b`，仅新入口严格允许此唯一查询字段；新增 `POST /api/chat/session/open` 只接受 conversationId、profileId、sessionId（当前UUID/null前提）。公开session新增稳定conversationId；每次打开建立新runtime UUID/token，消息成功/失败不改cookie。独立HttpOnly/SameSite Strict owner能力与服务端可信绑定限制保存和读取，客户端不能提交历史/身份/回执。

记录保存已接收原文、完成的Reply/步骤与实际设置；未完成轮与未知结果如实保留、不会自动重发。30分钟回收运行资源与20轮上限不再删除历史或被打开重置；历史容量达到上限时明确拒绝新增，不悄悄淘汰。欢迎说明仅承诺本人订单/券状态、预约使用与退款条件解释，网页不承诺办理退款、联系商家或核验真实到账。删除重复页脚与常驻技术参数，模型设置的实际生效结果保留。

**实现与取舍：** 新增 `src/web-chat-history.ts`，使用Node内置SQLite，WAL/FULL、2秒busy_timeout、BEGIN IMMEDIATE及CAS；受理pending、轮数和原文一起保存，完成Reply/步骤与回执在同一事务提交后才发布。目录/数据库权限0700/0600；公开消息ID稳定为requestUUID加角色。owner、profile与最新bindingId/customerId共同限制记录；打开始终换运行UUID，原页不能继续发送。模型配置快照不可用时允许回看和宿主订单路径，模型问题在受理前拒绝，不默换配置。未受理空壳不入列表，只清理同归属、无请求且无运行引用的真空壳；已有受理、pending、失败、损坏记录不被这个清理删除。

**独立负证据与修正：** 保存60字长标题后，页面虽无横滚，历史行仍扩到866px并遮住中央控件；局部网格列改minmax(0,1fr)后，桌面列表215px、行211px，390/320列表364/294px均无内部横溢。重新回访的订单卡最初仍给选单入口，现统一先重新查询最近订单。换页或打开历史失败时，只有明确的新建/设置意图才转移草稿，避免把原稿移给错误对话；未受理草稿阻止回访时，手机原生弹窗必须先关，提示与输入才可见。实际双SQLite连接发现新运行已提交后旧lease释放还可能被写锁阻塞，现旧lease已替换时直接返回，并保留事务内复核；专门负控与真实写锁检查通过。旧127浏览器只有运行cookie时出现401循环，显式null新建现在建立新归属，不能靠旧token读取历史。网络断线提示改为中文并提供纯读取入口，20轮丢回执也能找回已保存结果，不再要求重发。

**实际联合验收：** 本机HTTP/Pi/SQLite合成业务入口完成新建、回访续聊、A/B隔离、取消切换保稿、已确认切换清稿、长标题、手机设置、处理中刷新及强制进程退出恢复。历史上下文由真实Pi本地faux读取，之前续聊阶段4次本地faux；这些不作为远程模型语义验收。最后首次咨询处理中强制退出77，原页面不刷新即显示“查看当前记录”；重启后主动读取找回同一标题、原文和诚实中断记录，输入原文保留、可继续咨询。重启探针仅2次绑定读取，订单/list/factory/faux及远程模型/QQ均0，未自动重发。实际1280×900、390×844、320×740无整页横滚；真实3002项目页面已启动并显示“可咨询”，最终截图1280×900已核尺寸并目视复核。

**检查结果：** 最终聊天/评测/实验三个UI专项、完整 `npm run validate`、真实只读MySQL+HTTP+临时SQLite重启联调均退出0；HTTP/流式/历史/订单发现专项此前在同一最终后端版本退出0。实际临时磁盘及子进程检查覆盖SIGKILL、独立进程重启、并发/CAS、两连接写锁、事务保存失败、有效JSON坏记录、数据库损坏、绑定更改、重放/迟到、20轮/容量与空壳恢复。MySQL联调实际核验USAGE/SELECT，仅查当前绑定和本人订单，0业务写入/模型/QQ。源码hash、日志、负控与浏览器JSON/截图集中于忽略目录 `.runtime/frontend-20261009/round23-evidence.json`；一份UI执行器错误因调用不存在导出而失败，原日志保留为ui-invocation-error，修正执行器后得到最终0，未当作产品失败或成功证据。未提交推送。

**边界与停止：** 实际运行Node26.10；SQLite busy_timeout沿Node22.19基线兼容API写法，未实际运行22.19。本轮未调用远程模型、真实QQ或商业交易，未验物理手机、屏幕阅读器或跨设备账号。浏览器cookie归属、固定合成客户、公开历史上下文和最终绑定快照仍有上方限制。本轮产品与持久记录范围已收尾；持续目标保持至北京时间10:00，不据剩余时间追加模型实验或外围平台。

### 第二十四轮：客户订单路径与低高度操作复核（07:03 启动，07:20 验收记录）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户从能力介绍进入本人订单、读到完整答复、回访原记录后重新查单；手机可用高度变小时，输入、发送、历史与关闭窗口仍可操作，原稿与当前身份不变 |
| 具体面试追问 | 页面整体无横滚为何仍可能遮住订单或操作；历史消息、长答复、低高度和原生弹窗的滚动区域如何保持客户能完成下一步 |
| 个人实现与复用 | 复用当前静态页面、原生滚动/弹窗与既有宿主本人订单路径；先实际浏览器复现，必要时只改已证实的布局或交互决策点，不新增业务写入、登录、远程模型调用或依赖 |
| 验收及演示证据 | 当前3002服务的真实只读订单、已受理历史回访及重新查询；宽窄屏/低高度的元素边界、滚动可达性、键盘焦点与草稿；若有运行改动，定向负控、受影响专项与最终完整validate |
| 投入预算与停止条件 | 约45分钟一轮客户路径复核；0远程模型/QQ/业务数据库写入。没有可复现缺陷就保留原实现并归档结果，不凭偏好追加控件；发现阻断本路径的缺陷则修完并验收，持续目标仍至10:00 |

独立源码复核与实际原生手机弹窗已确认：打开历史POST失败后，错误只落在弹窗外页头，列表GET成功又清空列表错误，客户看不到原因与恢复入口。另已有实际SQLite容量429合同明确永久达到记录上限，前端通用429却写“频繁，请稍后重试”；本轮据这两个证据补齐同一客户恢复片：错误在当前操作区域可见、容量满不误导等待。仍保留当前会话/原稿/身份，不增删除、自动淘汰或自动重发。横屏低高度的可达性另作实际几何检查，成立才修。

**修复与实际结果：** 只改聊天app、对应UI检查和局部短屏CSS。历史POST失败时关闭手机原生窗口，让原页头错误和下一步可见；404给刷新或另选记录的固定提示，503/401等失效时焦点交给可用重连，其余交给历史入口。当前代次、选文和等待期间主动转焦保护保留；桌面原行焦点与手机正常打开不变。容量429仅创建接口、精确受控错误句采用固定容量提示，不展示任意后端字符串，普通频率429仍沿原文案。原生浏览器404失败后窗口关闭、历史入口有焦点、原标题/4条消息及“保留未发送原稿”不变；503后重连可见、可用、有焦点，主动重连恢复原订单记录，无问题重发。

740×360负控中恢复按钮可见时，消息区仅29.61px，44px订单动作无法完整容纳；页面360px且禁止外层滚动。短屏局部允许外层纵向滚动、消息区160px并固定其flex基准。第一版漏掉flex固定，使2轮历史撑出1102px消息区、1413px整页，未准入；补齐后长历史内部scrollHeight仍1102px、clientHeight160px，恢复态整页490px，健康态471px。真实外层滚动111.5px后，44px订单动作边界129.31..173.31、发送292.89..336.89均在360px视口内。390×450、320×480也保持160px内部区；1280×720、390×844、320×740仍沿原布局，消息区分别440/533/429px。各场景clientWidth=scrollWidth，输入16px、动作44px、原稿始终不变。

**证据与检查：** 旧容量、旧弹窗VM负控各退出1，修后UI、HTTP与流式专项退出0；最终聊天/评测/实验三个UI与完整 `npm run validate` 均退出0。当前后端三个文件hash与第23轮相同。本轮临时HTTP故障注入原生浏览器共6次，实际宿主/Pi/SQLite探针0订单/列表/factory/faux/远程模型/QQ调用，只做绑定读取、历史读取与受控失败响应；与前轮实际存储容量检查分列。另真实3002页面通过能力卡→本人最近订单→新建→原记录回访→重新查询，实际本机SQLite只读汇总2条完成回执均origin=host、原记录2轮ready；业务库仅查询，0业务写入。最终实际项目欢迎页保留该历史条目，1280×900截图已核尺寸并目视复核。

日志、原生负正JSON与源码hash集中于 `.runtime/frontend-20261009/round24-evidence.json`。原短屏截图以page坐标clip(0,0)得到文档顶部，不能证明滚动后触区；另保留page-clip，最终可达性采用当前滚动视口原生截图（实际725×353）和DOM740×360/边界记录，两者尺寸分列。一次AXWebArea滚动目标被拒绝，改用已观察的外层滚动区域后确认111.5px实际位移，不算产品失败。未提交推送，不重跑远程固定题；本轮收尾，持续目标仍至10:00。

**待独立评估：** 实际订单卡中的“云味餐厅演示店（虚构）”来自可信 `shops.name` 种子与规则材料，非前端加的说明；目前没有展示别名字段。不在前端按订单ID猜名或通用剥词。若统一正常业务命名，应另立合成数据与规则来源版本合同、保留旧固定基线；修改seed不会更新已有volume，本轮未改业务库/seed/规则。物理手机键盘与屏幕阅读器仍未验。

### 第二十五轮：其他页面切换后的原稿与客户恢复（07:24 启动，07:50 验收记录）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 同一浏览器另一页面新建或换客户后，旧页面消息仍先按旧UUID拒绝；客户主动重新连接时不静默丢弃原稿或切成其他客户。已有已受理会话、明确打开/新建/设置意图与未受理空稿分别按真实存储状态恢复，不自动重发问题 |
| 具体面试追问 | cookie共享而页面内状态不同，GET返回其他页面当前会话为何可能清稿；如何同时保护用户原稿、原客户、CAS前提和已经明确发起的打开目标 |
| 个人实现与复用 | 复用现有稳定conversationId、历史列表、严格GET/POST前提、页面草稿及代次保护；先原生双页面与确定性负控，再补已证实恢复分支，不放宽后端授权、不加入localStorage或多会话后台协议 |
| 验收及演示证据 | 同客户空对话有稿→他页新建→旧页401/主动重连；不同客户他页切换、已受理原会话、明确打开/设置丢回执、处理中他页、迟到及原稿/身份/零自动消息。若改运行文件，受影响专项与最终完整validate |
| 投入预算与停止条件 | 约45分钟一个恢复片，0远程模型/QQ/业务库写入；依据负控修完整恢复合同，检查通过即收尾，不扩跨设备登录/并发运行协议/数据命名迁移；持续目标仍至10:00 |

**已复现负控：** 当前原生浏览器两页共享实际HTTP宿主与临时SQLite。A页空会话输入“保留这个页面还没有发送的问题”，B页新建后A页发送以旧UUID获得401、未登记受理；主动重连却改读B页空对话，14字原稿消失。第二次B页切客户B，A页同样401后重连未经本页确认改成客户B，11字原稿清空。探针0业务订单/业务列表/factory/faux/远程模型/MySQL/QQ；两个发送动作均在受理前被拒绝。10个独立VM负控另覆盖已受理记录、start丢失、他页busy与明确open/settings丢body后的第三页覆盖；这些是旧行为证据。负控、原稿前后JSON与源码hash保留在 `.runtime/frontend-20261009/round25-negative-evidence.json`。

**最小实现：** 仅修改聊天app与对应UI检查，后端、布局、HTML和业务授权合同不变。抽出原列表校验供恢复复用；增加有限open/reset意图和完整设置快照。恢复先严格校验GET，再取fresh运行UUID；按本页原CID或明确目标调用原open/new接口，busy不发POST。local0读取原客户列表确认是否已受理；同请求可能受理标记只能升为true，后续pre-start401不能推翻首次断线的不确定性。未知受理或已知记录404/401/503均保稿失败、不新建。明确new/settings回执丢失且目标CID未知时，在用户主动重连中按已授权客户和完整设置再新建一次，不猜第三页GET就是自己的结果；此路径只整理空对话，0自动问题。明确跨客户成功才按原确认清稿，打开目标则分别保留源/目标草稿。

**验收：** 旧UI恢复负控退出1；最终新增12个恢复、4个明确意图和1个请求设置不可用边界，加上原聊天回归均退出0。覆盖真实POST路径/数量、fresh CAS、等待后竞争、原CID/身份/raw字节/对象引用、busy/list/GET坏响应、可能受理后同UUID401与隐藏列表404无fallback、第三页覆盖和一次转稿。最终聊天/评测/实验UI、HTTP、流式专项与完整 `npm run validate` 均退出0；两项语法与diff检查退出0，最终两源hash冻结后未改。独立源码复核未发现blocker，VM/合成HTTP断言不当作模型、QQ或商业结果。

**原生及实际存储证据：** 真实双页面分别确认同客户14字、跨客户11字原稿恢复，0新消息；hold期间仅显示他页处理中并保留本页正文/原稿，release后主动重连恢复空稿；已受理原CID、4条历史消息及11字原稿完全恢复。实际POST提交后受控丢JSON、再由第三页覆盖：设置仍恢复high/512及原稿，明确open仍恢复选定退款历史，返回原订单记录可见独立14字源草稿。390×844手机同样恢复原CID/客户/8字原稿并聚焦输入；clientWidth=scrollWidth=390、输入16px、发送44px，截图实际390×844。临时真实宿主/HTTP/SQLite探针99次绑定读取、1次明确发送的宿主最近订单读取、0factory/faux/远程模型/MySQL/QQ、2次受控丢body；关闭后只读SQLite与第24轮复制基线对照，受理轮和completed host回执各只增加1，agent及interrupted回执增量0，证明恢复没有自动消息。旧复制记录含已有faux回执，未算成本轮新调用。

所有最终hash、检查日志、负正JSON、截图、基线差分与探针集中于 `.runtime/frontend-20261009/round25-evidence.json`。临时服务及3个验收页面已关闭，当前3002项目预览保留欢迎能力介绍与真实订单历史，实际1280×720；该页只重载静态最终版本，本轮未在业务库写入。草稿仍仅当前页面内保护，跨设备登录、物理手机键盘、屏幕阅读器与远程模型语义未验；不扩多运行协议或数据命名迁移。未提交推送，本轮收尾，持续目标仍至北京时间10:00。

### 第二十六轮：能力介绍排版与客户阅读路径（07:52 启动，08:00 验收记录）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户首次进入能读懂已实现的只读帮助、选示例并开始提问；能力简介不夸大退款执行，长答复及历史记录仍能继续阅读和操作 |
| 具体面试追问 | 能力入口怎样减少客户猜测，同时避免无意义的小字和不真实承诺；固定阅读宽度、窄屏和正文换行怎样影响完成咨询的路径 |
| 个人实现与复用 | 复用第23轮产品结构、16px正文和已有对话/历史控件；先检查实际文字换行及阅读动作，只改有证据的文案或布局，不新增业务、身份协议、依赖或装饰控件 |
| 验收及演示证据 | 当前1280×720欢迎简介句尾孤行的实际截图；正常宽窄屏的完整能力说明、示例仅填稿、历史长答复的滚动可达性。若改运行文件，受影响UI专项及最终完整validate |
| 投入预算与停止条件 | 约30分钟一轮阅读路径复核；0远程模型/QQ/业务库写入。解决已观察的排版问题并完成有界检查即收尾；无新可复现问题则保留实现，持续目标仍至10:00 |

**最小修改与实际阅读证据：** 只删欢迎简介末尾重复的“你遇到了什么问题？”，36字变27字；本人订单、券状态、预约、使用与退款条件含义完整。原1280×720、560px简介宽度、16px字下只有“题？”落入第二行；修改后相同几何为一行完整说明。390×844与320×740分别343/273px简介宽度，均完整两行，整页clientWidth=scrollWidth。正文尺寸、布局、控件和交互代码不改；不为这一句增加测试、装饰或配置。

**客户动作与边界：** 原生浏览器先验证已有原稿时不同示例不会覆盖；这份guard证据与三项填稿证据分列。清空原稿后逐项点击，分别得到“我有哪些订单”“团购券需要预约吗？”“我要退款”，均聚焦输入、0消息，未发送。实际项目SQLite只读汇总前后均2轮/2条完成回执，受理增量0。独立源码复核确认既有48px阅读阈值、稳定历史节点、选文与焦点、长文换行及短屏160px区域已有对应检查，未发现本轮新增阅读阻断，不重复改实现或跑模型。手机截图中的示例保稿提示为本轮主动验证的可见结果；最终桌面重载后提示清除、原稿为空、历史保留。

**检查与收尾：** 最终聊天/评测/实验三个UI专项及完整 `npm run validate` 均退出0；当前app、UI检查、CSS和后端hash与第25轮相同，运行文件仅HTML简介变化。最终项目1280×720截图已核尺寸并目视复核，320×740截图另有实际尺寸与目视复核。源码hash、日志、原生换行JSON、示例guard/填稿、SQLite零增量与截图集中于 `.runtime/frontend-20261009/round26-evidence.json`。0远程模型/QQ/业务写入；物理手机键盘、屏幕阅读器与跨设备仍未验。未提交或推送，本轮收尾，持续目标保持至北京时间10:00。

### 第二十七轮：历史回访的键盘与窗口导航（08:00 启动，08:12 验收记录）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户回看已保存的本人订单时，可完整阅读、进入并取消设置或历史窗口，再继续输入；取消不更改实际设置、客户、历史内容或原稿，不自动提交问题 |
| 具体面试追问 | 浏览器原生窗口为何仍需要检查焦点与滚动；历史按钮更新和视口断点如何影响键盘用户完成回访与继续提问 |
| 个人实现与复用 | 复用当前原生dialog、历史按钮和稳定消息DOM；只读核对源码及已有检查，实际键盘Tab/Shift+Tab/Escape与滚动验证；有可复现阻断才改共享决策点，不新增快捷键、历史管理或业务能力 |
| 验收及演示证据 | 当前真实3002已受理记录回访；宽屏及760px断点两侧、窄屏窗口的实际焦点/可见控件/原稿/身份/设置与滚动几何；若改运行文件，定向负控、受影响专项及最终完整validate |
| 投入预算与停止条件 | 约30分钟一轮真实客户导航复核；0远程模型/QQ/业务写入，取消不点击应用/发送。不重复已有模型实验或物理设备结论；有问题修完，否则保留实现并记录验收，持续目标仍至10:00 |

**本轮负证据：** 原生真实项目从760px打开历史窗口，保持打开改761px后Escape关闭，history-open已display:none，焦点落BODY；4条历史、客户A与12字原稿仍在。761px点击桌面“刷新”，GET成功后仍落BODY。设置窗口正常Escape能回settings-open并保留原稿/4消息/实际Flash-off-2048。将修复范围限定为历史加载发起控件的解锁回焦，以及历史窗口关闭时原入口隐藏后的可见导航交接；用户主动转焦、选文、窗口关闭/隐藏、旧代次响应不得抢焦。原始JSON保留，不作为屏幕阅读器或模型验收。

**最小修复与确定性证据：** 仅改app两处和对应UI检查。刷新开始前捕获当前历史view中的refresh/retry，当前代次/客户/epoch完成解锁后，仅焦点仍在BODY/原按钮且无选文、目标可用可见时preventScroll回焦；重试成功隐藏后交给同一view的刷新。历史窗口取消时若原入口因断点隐藏，交给固定可见的新对话导航；不依赖可能滚出视野的历史行，不新增控件/resize监听。普通取消、打开成功/失败、主动转焦和目标禁用合同保留。旧UI负控退出1捕获成功刷新落BODY；修后桌面/手机成功失败、重试交接、自动读取、转焦、选文、隐藏、旧epoch、关窗、跨断点及raw/对象引用/0POST断言全部退出0。独立源码复核无blocker。

**原生结果：** 隔离真实宿主HTTP/临时SQLite页面的500刷新后焦点回刷新，Tab进入重试；Enter失败后仍重试，再Enter成功回同窗口刷新，键盘outline为2px。受控hold等待中主动点输入，release后仍在输入；390×844历史窗口刷新失败仍在手机刷新，窗口366×640，clientWidth=scrollWidth=390。hold时Escape取消返回history-open，release后不回隐藏窗口。该服务最终9次合成绑定读取、5次受控GET失败、0业务订单/list/factory/faux/远程模型/MySQL/QQ；已退出0、临时页已关闭。实际3002最终版本760→761取消焦点回new-chat（45.09px高且完整可见），随后Tab/Enter刷新仍回桌面刷新，4消息/客户A/12字原稿/Flash-off-2048不变。实际项目只读汇总仍2轮/2完成回执，临时SQLite0轮/0请求；运行lease与最终新建空壳按原合同变化，不声称SQLite零写入。

**检查及停止：** 最终聊天、评测、实验UI与完整 `npm run validate` 均退出0；app/UI语法与diff检查退出0。两项专项首次执行误用不存在的导出名，未启动检查的exit1日志另留invocation-error；UI代理首次重定向目录缺失也未启动Node，创建目录后唯一专项退出0。只读汇总首次deepStrictEqual误比SQLite行的null原型与JSON普通对象，列值相同，改为选择相同status/count列后退出0，提取器错误说明保留；未将这些执行错误当成产品失败或成功。当前后端/CSS/HTML/其他UIhash与第26轮相同，源码与证据集中于 `.runtime/frontend-20261009/round27-evidence.json`。390×844与761×720焦点截图已核尺寸并目视复核；最终项目1280×720欢迎页、空原稿与原历史保留。未验物理手机键盘、屏幕阅读器或跨设备；0远程模型/QQ/业务写入，未提交推送。本轮收尾，持续目标仍至北京时间10:00。

### 第二十八轮：中等窗口的能力入口与输入可达性（08:15 启动，08:24 验收记录）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户首次进入时能看懂本人订单、使用条件和退款条件三个入口，并随时输入；侧栏仍显示的中等窗口不能因空态留白无意义地遮住业务入口 |
| 具体面试追问 | 整页无横滚是否足以保证首屏可用；能力卡断点、中央宽度和动态高度如何兼顾完整内容、可读字体与发送操作 |
| 个人实现与复用 | 复用已有三卡、响应式CSS、内部滚动与44px控件；先实际测761—900px窗口及常见宽窄屏，不减字体/触区，不加控件、业务或依赖 |
| 验收及演示证据 | 实际欢迎页各卡与消息区可见边界、输入/发送、scrollWidth及按需滚动；仅在有可复现遮挡时局部改已存在的断点规则，再用相同几何验收及最终UI专项/完整validate |
| 投入预算与停止条件 | 约30分钟一轮首屏入口复核；0提交问题/远程模型/QQ/业务写入。不要求极低高度塞下全部内容；内部滚动可达性与正文/触区保留，没有确定改善就不改代码，持续目标仍至10:00 |

**实际负证据与改动合同：** 900×720及761×720均为单列3×80px，消息区440px，最后卡底553.99px而可见区底544px，裁掉约10px下缘；文字仍可读，输入16px、发送44px且完整可见，不称咨询被阻断。欢迎上边距50.4px、下边距24px导致scrollHeight482px。仅在已有≤900断点采用现有16px留白尺度，欢迎上下各16px；目标是三卡完整并消除这一正常高度的空态无意义滚动，≤760后续手机margin规则和>900布局保留。首份900请求的观察实际仍1280，重取当前视口能力并重载后实测900/761；原观察按实际1280另留，不作为负证据。

**最小修改及原生结果：** CSS仅新增既有≤900块中一行欢迎margin；无JS、HTML或检查代码改动。761/800/900×720三卡均完整，第三卡底519.59px低于可见底544px，消息区clientHeight=scrollHeight=440，不再为留白显示滚动条。901/1280保留50.4/24px边距及三列124px卡片；760/390保留16/20px手机边距及80px单列卡。所有场景整页clientWidth=scrollWidth、输入16px、发送44px。独立级联复核确认仅761—900欢迎命中，正文、历史、其他页面与短屏合同不变。

800×600仍自然保留320px内部区域、440px内容，不缩正文或强塞三卡。实际内部滚动119.5px后退款卡320.09..400.09px完整位于104..424px可见区，发送523..567px完整位于600px视口。原生点击退款卡仅填“我要退款”，输入有焦点、0消息、发送可用；未发送，完成后清除本轮草稿。实际SQLite与第27轮最终只读汇总相同：2轮/2完成回执，受理增量0。900×720负正截图及800×600滚动填稿截图均核尺寸并目视复核；最终1280×720正常视口、可咨询、空稿与1条历史保留。

**检查及停止：** 最终聊天/评测/实验UI专项及完整 `npm run validate` 均退出0，diff检查退出0；此低影响CSS范围不增加镜像样式测试，实际几何是视觉验收证据。app、HTML、现有UI检查和后端hash与第27轮相同。源码、单行diff、日志、原生宽窄屏/低高度JSON与截图、SQLite零受理增量集中于 `.runtime/frontend-20261009/round28-evidence.json`。本轮未提交问题、远程模型/QQ调用或业务写入，未提交推送；物理手机键盘、屏幕阅读器与跨设备仍未验。本轮收尾，持续目标保持至北京时间10:00。

### 第二十九轮：咨询与工作台之间的导航（08:27 启动）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户从咨询设置进入工作台并返回，历史与实际客户仍经过可信宿主读取；未发送的问题不得在产品内跳转中无提示丢失，不自动提交或用旧历史替代授权 |
| 具体面试追问 | BFCache的页面还原与宿主会话恢复为何不同；重新授权、页面草稿和跨页面导航如何兼顾可用性与旧页隔离 |
| 个人实现与复用 | 复用当前同标签导航、pageshow保护、历史/初始化与已有原稿策略；先实际浏览器和只读源码复核，再选择能完整保稿且保持授权的最小修复，不默认新增持久存储、新标签或登录协议 |
| 验收及演示证据 | 原生真实3002咨询→3001工作台→返回的历史/原稿/客户/配置；原7号工作台及未应用配置保留，不启动任何评测。若发现丢稿，保留负证据及定向断言、修后同路径与最终UI专项/validate |
| 投入预算与停止条件 | 约30分钟一个导航片，0提交问题/实验/远程模型/QQ/业务写入。不得为保稿放松旧页UUID、身份或不确定受理保护；无确定问题则保留实现并归档，持续目标仍至10:00 |

**负证据及修复取舍：** 08:37实际同标签3002→3001→产品“客服问答”返回：16字原稿（含换行和尾空格）变为空，4条历史、客户A与Flash/off/2048保持。既有页面内草稿策略不覆盖文档重建，单改BFCache不足以完整解决。采用现有原生dialog样式与取消优先模式：任一本页会话仍有原稿时先确认离开，继续编辑保留全部原文/失败UUID；明确“离开并丢弃草稿”才导航。当前框为空但其他CID有稿也须确认，不迁移草稿、不自动开历史、不增加持久存储；原同标签和pageshow重授权保留。调用方仅eval-link、dialog关闭，覆盖HTML绑定、当前/其他原稿、失败请求、忙碌/初始化、取消/确认与过期确认；约30分钟边界保持，未授权自动保存跨页原稿。

**实现与原生结果：** 仅聊天app新增离页状态及点击/关闭处理，HTML复用当前原生dialog及取消优先样式，CSS/业务/评测页面均未改。whole Map覆盖当前框为空、其他CID有原稿；继续编辑及Escape保持原文、失败请求与全部页面草稿，确认不预先清Map，只有当前代次/运行UUID/href仍一致且空闲已初始化时同标签导航。独审指出取消回焦需要沿用主动转焦、选文、连接及可见性保护，已补；实际浏览器Escape会先回设置入口，纳入该原入口的回焦交接后，最终Escape回输入，16字原文（含换行/尾空格）逐字不变。保护中间版本曾回设置入口，单独JSON保留，不作为最终回输入证据。

原生1280×720及390×844提醒完整，手机dialog366×202.39px，两个按钮均44px，整页scrollWidth=390；默认焦点在继续编辑。明确丢弃本轮合成原稿后进入真实3001总览，再通过品牌返回3002，4条历史/客户A/Flash-off-2048保持，输入空符合明确选择；原先负控的“客服问答”返回与最终品牌返回、空稿直接导航及浏览器Back均实际走通，不声称引擎必定使用BFCache。最后清除复核自建原稿，1280×720欢迎页可咨询、0消息/空稿/1条已受理历史；原7号工作台未应用配置未操作，所有导航未启动实验/提交咨询。最终页面warn/error为空；实际SQLite只读汇总仍2轮/2完成回执，受理增量0，不声称运行lease/空壳SQLite零写入。

定向VM保留原busy/空稿/persisted重授权断言，新增exact/whitespace、其他实际CID原稿、失败UUID与原文、取消/Escape/重复选择、5类过期确认、取消及过期关闭各5类焦点保护、UA回原设置入口的交接，均断言零HTTP/不提前清稿。旧app独立临时副本负控在“有稿不能无决策离页”退出1，实际运行app未切回；中间UI0日志单独归档，最终专项以最终焦点保护版本为准。该修复只保证产品内评测入口先作明确选择；浏览器刷新、关闭或地址栏离开仍不持久保存未发送原稿，不把导航或丢弃原稿表达为提供商取消。

**最终检查及停止（08:45）：** 最终聊天UI专项、评测/实验UI专项及完整 `npm run validate` 全部退出0；app/UI语法与diff检查退出0。业务/存储/评测运行代码及CSS与第28轮hash一致，本轮只改聊天app、HTML、定向UI检查及本文。第23轮已验收的SQLite与只读实库合同不扩写为本轮新验收。源码/差异、旧app负控1、中间与最终专项0、完整日志、原生桌面/窄屏与返回证据集中于 `.runtime/frontend-20261009/round29-evidence.json`。未提交推送；0咨询提交/实验启动/远程模型/QQ/业务写入。物理手机键盘、屏幕阅读器、跨设备及浏览器关闭保稿未验或不在合同；本片完成，持续目标仍至北京时间10:00。

### 第三十轮：用户要求与核心使用路径整体复核（08:47 启动）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户无需理解Agent实现即可找到能力、输入问题、回访记录并识别真实处理状态；历史、原稿与选择客户的保护遵循当前授权与持久记录合同 |
| 具体面试追问 | “企业级体验”如何落到可核验路径；首页、记录、异常恢复和次级评测入口分别有什么证据与明确局限 |
| 个人实现与复用 | 对照最新用户提出的会话记录、能力介绍、无意义小字与必要重构，复核现有HTML/CSS/app和已验收来源，不默认加框架、模型问题、登录、搜索或主题。只读代理分别审查主使用路径、页面内容与响应式、评测次级界面；根代理负责实际浏览器与结论 |
| 验收及演示证据 | 逐要求证据矩阵、当前源码/hash、原生首页/历史回访/取消及错误恢复的现有证据和必要新观察；原7号页保留，不启动实验。只有实际缺口才单独明确假设、改动和定向负控，再最终专项/validate |
| 投入预算与停止条件 | 约25分钟一次要求复核，不重复已关闭模型题集，不把绿检查当完整产品证明。0模型/QQ/咨询提交/实验/业务写入；无具体新缺口则只归档证据，随后以实际常驻服务handle及页面可用性持续监测至北京时间10:00 |

**具体缺口与预算调整（08:50）：** 只读根因已确认：受理会话A写原稿→打开同客户已受理B（B空稿、Map保A）→切另一客户；当前框判空而跳过确认，成功后清全部Map。第29轮实际app合成UI已经证明前半路径保稿可到达，但没有覆盖跨客户组合。改动只复用当前客户切换dialog，以全页面原稿判需确认，提示清稿作用域；取消/Escape零请求，失败仍保全部原稿，确认成功按旧合同清稿。根代理先在独立实际HTTP/临时SQLite＋合成业务夹具做负控：仅2条已验证宿主最近订单命令生成两个会话，禁止普通模型问题，faux/远程模型/业务MySQL/QQ为0；实际3002仍零提交/零业务写入。复现后只改app和专项，无新dialog/存储/API。25分钟整体复核预算内收尾，完整检查之后进入常驻服务监测，不扩展主题或已关闭实验。

**实际负控、最小改动与收尾（08:58）：** 独立真实宿主HTTP/临时SQLite＋合成业务页面仅提交“我的订单”“查询我的最近订单”两个宿主只读命令，形成不同标题的受理记录。旧app实际留20字原稿于第一记录→打开第二空稿记录→切客户B没有dialog→切回A并打开第一记录原稿为空，2条消息与两记录保持。最终app仅在已有可信profile/locked校验之后保存当前原稿，以whole Map决定现有确认dialog，并精简重复提示为“本页所有会话中未发送的问题会清空，已有会话记录会保留”。取消后回第一记录原稿逐字一致；最终确认前默认保留当前客户，current框确实为空；受控429切换失败后仍客户A/第二记录/两历史，回第一记录20字换行与尾空格均保留。无新HTML/CSS、API或业务状态，确认成功清稿的已有行为保留，最终VM明确检查该组合。

夹具最终43次合成绑定读取、2次list、1次受控HTTP429、0订单详情/factory/faux/远程模型/MySQL/QQ；2受理轮/2完成回执，已退出0，临时tab32关闭。本轮执行失误：夹具误用主预览相同hostname，不同端口共享运行cookie，关闭后main初始化与重连401；这是文档已排除的多chat实例并存边界，不改授权门禁绕过。核对main为2轮/2完成回执、busy owner0、空稿后，原常驻handle48979正常退出0，重新按原只读启动命令启动handle60551（grants/ping门禁通过），原生显式重连、打开07:17记录恢复4消息/客户A/原Flash-off-2048。main前后只读汇总相同，0受理增量；SQLitelease/空壳写入不称零写入。最终1280×720欢迎页、空稿/1历史/输入可用，7号评测未应用配置保持。后续隔离页面应使用与main不同的本机alias，避免此执行错误。

最终聊天专项、评测/实验UI专项及完整 `npm run validate` 均退出0，语法和diff检查退出0。旧app独立临时副本负控退出1，实际main未切换旧版；专项补实际accepted甲→乙空稿、cancel/Escape零请求/Map与failedUUID、确认400/409保两行与原对象、明确成功清全部草稿但不改受理历史。真正新文档fixture同时清空旧文档Map，先断言Map0再验证免确认，不把遗留跨文档内存当无稿。source/hash/差异、日志、原生失败及保稿、重启历史与只读汇总见 `.runtime/frontend-20261009/round30-evidence.json`；未提交推送。

| 用户要求 | 本轮当前证据与边界 |
| --- | --- |
| Codex持续优化，不使用Kimi | 第23—30轮具体源码、运行与验收由Codex；首版旧来源单列保留，本轮无Kimi调用；持续目标至10:00，尚未到时完成 |
| 从用户角度优化/必要重构 | 主会话＋历史/输入，次级设置与评测；当前原生1280首页及第28轮761/800/900、宽窄/短屏几何支持当前可读性，不能称生产企业验收 |
| 会话记录 | 当前实际1条历史/4消息在服务重启后原生回访，SQLite事务、owner/profile与绑定保护见第23轮；仍为本机合成身份/浏览器归属，无真实登录或跨设备 |
| 无意义小字 | 示例中的固定phrase已从当前HTML/DOM消失；已删除常驻订单hint/重复页脚，切换确认只保必要作用域与结果。提供商未知量、失败、只读结果等事实仍保留 |
| Agent能做什么 | 当前首页一句能力介绍与3个只填草稿入口，准确限定本人订单/券、预约/使用/退款条件；网页无退款执行承诺 |
| 持续检测与异常恢复 | 第24—30轮实际/合成故障、焦点、多页与导航、容量、隐藏草稿证据分别留存；当前常驻handle60551已启动且页面可用。物理手机键盘/屏读未验，长纯文本无内部控件的键盘滚动尚缺原生证据，不推断缺陷 |

次级工作台只读复核另发现三项候选：Agent步骤0的“无模型请求”口径过宽、实验GET503恢复引导混同MySQL、提交响应整区重建可能丢编辑焦点；前两项已有源码根因，第三项需隔离延迟POST原生负控，不在本轮冒作已修。继续按独立合同推进，不启动真实实验或模型题集。核心本片已收尾，持续目标保持至北京时间10:00。

Manifest首次提取误用负控断言的缩写短语，匹配失败；实际负控是“a draft in another accepted conversation requires confirmation before changing customers”，false!==true，非新增产品失败。提取器按原日志修正，执行错误说明独立保留，不能以复合shell最后0掩盖提取器AssertionError。

### 第三十一轮：次级工作台的编辑保持与准确恢复提示（09:07 启动）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 提交等待期间仍可编辑当前实验草稿，响应不能销毁正在编辑的输入或高级参数；后台读取失败给对应服务的恢复方向。Agent步骤用量不能表达为全部提供商调用为零 |
| 具体面试追问 | 异步提交为何会丢焦点与展开态；局部刷新如何保留用户在等待期间的修改而不改变已提交快照；零Agent步骤为何不等于零问题解析或重排调用 |
| 个人实现与复用 | 根代理修改共享GET错误文案并做原生夹具；实验代理只复用现有actions/side局部刷新和summary；检查代理仅补两个现有UI专项；独立代理只读复核。保留后端验证、重复提交保护、远程授权与未知用量，不增依赖、通用diff框架或真实实验 |
| 验收及演示证据 | 隔离localhost合成HTTP延迟/拒绝POST原生负控，实际静态前端编辑值/节点/焦点/高级参数、成功与失败；零Agent步骤但其他提供商有请求的summary及实验/记录503分流。旧源码负控、最终三个UI专项与完整validate |
| 投入预算与停止条件 | 约25分钟收尾；0实际实验启动、咨询提交、远程模型、MySQL与QQ。合成POST仅夹具回执，不创建worker或外部请求；原7号工作台未应用配置保持。通过即归档，持续目标仍至北京时间10:00 |

调用链复核补充：运行与批次聚合的usage同样只统计Agent步骤，原有折叠说明已明确Agent口径，但首条“无模型请求”仍过宽；本轮仅将这些首条标签明确为Agent步骤/用量，不改聚合、金额或其他提供商执行分工。原生探针首次用了错误data-field选择器，后续读到exp-label后修正；第二次错误复用了未完成声明，改用新的局部变量。两次观察执行错误不是产品证据，真实等待/响应负控另存JSON及截图。

**最终结果（09:18）：** 旧静态前端在localhost59904的合成延迟POST中，等待时名称输入有焦点、光标27、高级参数展开；拒绝到达后原文仍在但焦点BODY、展开态false。最终仅复用actions/side局部刷新，保持原提交/下载按钮节点；校验、开始与终态不重建表单。最终拒绝响应仍exp-label焦点、光标12、展开true、原文尾空格不变；合成成功回执保留新草稿与下载按钮焦点，任务名称仍是原提交快照；无人主动转焦时拒绝后回到可用提交按钮。禁止重复提交与远程授权沿旧合同。四次POST均是夹具回执，0实际worker/实验、咨询、provider、MySQL/SQLite/QQ写入；临时tab33和handle4511退出/关闭，主handle60551仍运行，实际3002欢迎页/1条历史/空稿保持，7号未应用配置保持。

实验目录503旧文案实际误导排查MySQL，最终明确实验服务、重试当前操作；显式重试恢复表单。summary原生零Agent分支改为Agent口径；其他提供商正数、已知/未知用量与费用的合法组合以确定性UI夹具另验，不将原生简化归因对象当完整分析合同证据。运行、批次首条同样明确Agent作用域，金额、聚合、分母和执行分工不变。

最终两个工作台UI、聊天UI及完整validate均退出0，四份旧源负控各退出1；API14个服务/状态组合，提交等待输入/下载、同表单/节点/原文/展开、原快照、恢复/选文/隐藏/新预设/跨view/远程禁用有确定断言。新增eval direct-batch夹具首次漏runIds导致TypeError，原失败独立保留，补完整必需字段后只重跑eval；零Agent fixture费用校正null后只重跑experiment。最终运行文件未再改，语法与diff0，独立复核clean。源码、差异、日志与原生证据集中于 `.runtime/frontend-20261009/round31-evidence.json`。没有提交推送、真实模型或物理手机/屏读验收，本片收尾，持续目标仍至10:00。

### 第三十二轮：长纯文本会话的键盘阅读可达性（09:16 启动）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 客户只使用键盘也能阅读没有订单按钮或步骤控件的长历史，再回到输入；读取中不改变正文、原稿、身份或发起咨询 |
| 具体面试追问 | 没有横向溢出、鼠标可滚动为何不足以证明键盘可读；不同宽高下内部滚动区能否获得焦点并读取首尾 |
| 个人实现与复用 | 独立代理仅写忽略目录GET-only合成HTTP夹具，按最终session/config/list合同初始恢复合法长用户消息与中断状态；根代理实际Tab/方向键操作。复用现有滚动区域，只有原生负控成立才补最小语义属性，不造组件或新业务 |
| 验收及演示证据 | localhost59905隔离夹具、1280×720和390×450原生Tab/ShiftTab及PageUp/PageDown/方向键、首尾scrollTop与焦点、原稿及零POST；失败才留旧源负控并补匹配检查/validate，成功则只归档已有实现 |
| 投入预算与停止条件 | 约15分钟一条只读可达性检查；0咨询提交、实际实验、模型、业务库或SQLite写入、QQ。保留3002与7号原配置，夹具退出后不重跑同路径；持续目标至北京时间10:00 |

**结果：已有实现可达，无运行改动。** 原生1280×720的1629字纯文本记录，没有步骤、订单或依据控件；Shift+Tab从输入直接进入chat-messages，虽然显式tabIndex为-1，当前浏览器已将该滚动区纳入键盘顺序。Home实际scrollTop0，End1410.5（最大1411，像素取整），Tab回到输入。390×450同一记录保留160px内部区、无内部可聚焦子控件；Home0、PageDown140、PageUp0、End3304.5（最大3304）、Up3264.5，随后Tab输入和发送、Shift+Tab回输入。13字原稿及尾空格始终一致，发送44px、底部448.39处于450视口，clientWidth=scrollWidth390。保持诚实中断提示，无自动咨询。

GET-only夹具直接用当前前端validateConfig/session/conversations检查实际公开形状，再真实HTTP GET200核对；不设Cookie、POST0，宿主/faux/model/SQLite/MySQL/QQ均0。独立代理的owned handle52541已正常退出0、59905无监听，临时tab34关闭，viewport reset后主页面实际恢复1280×720/空稿/原1条历史。根代理曾误用子代理exec handle读取，工具返回Unknown process；由实际持有代理关闭并查端口，不据这条错误推断进程已退出。

没有已复现缺陷，因此不加tabindex、监听或控件，不重复已通过的完整检查；所有20个运行/测试源hash与第31轮一致，只补本文及忽略证据。原生JSON、桌面和手机截图、GET探针与hash见 `.runtime/frontend-20261009/round32-evidence.json`；截图实际1280×720/390×450已核尺寸并目视复核。这仅证明当前本机浏览器键盘路径，不等于其他浏览器、屏幕阅读器或物理手机键盘验收。本片关闭，后续仅按实际常驻服务与主页面状态持续监测至10:00，不凭剩余时间追加实验。

### 第三十三轮：最终版本的持续可用性监测（09:26 启动，10:00 停止）

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 已验收页面在目标剩余时间仍可打开，主服务与实际加载资源保持当前版本；不能通过反复咨询或实验生成“持续优化”成绩 |
| 具体面试追问 | 源码通过检查与当前服务可用分别有什么证据；持续维护如何识别服务退出、资源漂移并在明确期限收尾 |
| 个人实现与复用 | 仅忽略目录标准库监测器每分钟读取本机3002/3001的公开静态资源，比较冻结hash，记录状态与错误；复用当前常驻服务，不触用户未应用的工作台草稿或启动业务 |
| 验收及演示证据 | 有截止时间的实际HTTP监测记录、当前常驻handle、最终原生主页面/历史/空稿及源码freeze；若发生具体失败才定向修复并重验，不将静态200推广成模型/QQ或商业验收 |
| 投入预算与停止条件 | 截止北京时间2026-10-09 10:00；0咨询、真实实验、provider、业务数据库写入或QQ。状态未变保持安静，不重复闭合检查/模型题集，不提前完成Goal；到时关闭监测与到期唤醒并记录结果 |

**最终收尾（北京时间10:00）：** 监测器实际于02:00:00.002Z停止，正常退出0；35轮×6个公开静态资源共210次读取，全部HTTP成功且hash匹配冻结文件，无失败或漂移。静态200只证明这些入口/资源可用，不能代表模型、业务授权、QQ或商业运行验收。最后实际3002空稿刷新后恢复当前客户与原历史，回访07:17记录显示4消息、只提供重新查单动作，再新建保留1条历史与首页能力/3个填稿入口；实际1280×720，无横溢、输入/客户/新建可用。主服务handle60551保持供用户预览，7号未应用配置保持，当前轮临时夹具均已关闭，目标到期heartbeat已PAUSED。

最终只读SQLite计数前后相同：受理轮2、完成回执2、busy owner0，0新咨询/真实实验/provider/QQ/业务库写入；主动恢复/新建会更新SQLite运行lease/空壳，不能称主SQLite零写入。初次计数对比误把SQLite的null-prototype行与JSON普通对象deepEqual，数值相同但原型导致assert失败；后续sips导致复合shell最终0不能覆盖该失败。独立按序列化记录合同对比退出0，错误说明与最终日志分别保留。历史消息计数初次选择器误用message-row后按实际.message修正为4；原生AX本身也显示4条，并非历史丢失。

所有20个运行/测试源仍与第31轮最终检查版本一致，最后只改本文，无重复完整检查或新增业务验收。源码、最终页面截图/JSON、历史/计数、210次HTTP记录及收尾见 `.runtime/frontend-20261009/round33-evidence.json`。原有README/plan/依赖/IDE等他人工作保留，未提交推送；物理手机、其他浏览器、屏读、真实登录/跨设备以及真实商业运行仍未验或不在当前本机只读范围。持续目标截至10:00完成，后续修订需另有新的用户范围。

### 第三十四轮：可用导航、界面文案与提交交付（12:30 启动）

用户新增范围：实际评测工作台跳转仍有问题，继续清理无意义小字，多截图检查效果，并授权自动commit/push；这是前一限时目标结束后的新目标。

| P0 项目 | 本轮合同 |
| --- | --- |
| 真实业务约束 | 用户能找到并实际进入评测工作台、返回客服；连接状态与草稿保护不能阻断无依赖导航，文案只解释实际能力、动作与必要失败，记录和授权不得丢失 |
| 具体面试追问 | 为什么通过一次导航检查仍会出现不可达入口；原生modal、失效会话、正在处理和未发送稿分别如何影响安全离页；如何用实际截图而非源码绿检查证明用户路径 |
| 个人实现与复用 | 根代理实际浏览器复现并修改最小决策点，代理分别只读审查导航/文案/当前20个运行及测试源的提交完整性；复用现有HTML/CSS/JS和对话保护，保留其他README/plan/依赖/IDE改动，不增框架或后台实验 |
| 验收及演示证据 | 实际3002↔3001、空稿/有稿取消与离开、失效连接及宽窄屏，多张截图/几何/焦点；定向负控与最终UI/HTTP/历史专项、完整validate。提交包含已确认归属的完整可运行前端与持久会话依赖，另复核实际存储/只读联调及远端commit |
| 投入预算与停止条件 | 首轮约90分钟，0付费业务模型、真实QQ、退款/业务写入或真实实验；依实际新缺陷收敛，最终检查均0后显式文件清单commit+push，不混入他人文件，不据小字减少真实性或安全提醒 |


**第34轮结果：** 实际3002空稿→3001→客服可用；旧入口藏在设置modal。隔离localhost59906有效配置＋sessionGET503的旧源码实际使设置禁用、eval-link隐藏且无href；最终复用同一URL检验，在安全配置成功后先发布常驻入口，失败后可实际点击进入localhost3001。导航与客服initialized解耦；busy、URL范围、全会话原稿、代次/运行UUID/初始化快照陈旧决定保护仍保留。取消恢复原文和输入焦点，明确丢稿才进入工作台。没有为通过导航弱化会话或业务授权。

删除重复设置动作说明与工作台页脚品牌；实验提示改为“修改用于下一次提交”，准确表达提交快照。能力介绍、三个填稿示例、历史状态、授权与缺失用量说明保留。实际1280×720、390×844、320×568截图目视检查；窄屏四个导航触区均44px，scrollWidth等于视口宽。320px会话记录打开后仍有原4消息，空稿/1条历史保持。尺寸cap在未选中页面reset没有改变旧tab27实际尺寸，因此交付新tab36实测1280×720，关闭空稿旧tab27；不以reset返回推断尺寸已复原。

最终六项专项（聊天UI、HTTP、stream、真实临时SQLite历史、评测UI、实验UI）及完整 `npm run validate` 全部退出0，Node v26.10.0；最终20个运行/测试源冻结hash见忽略证据。旧source与旧markup负控各退出1；FakeDOM首次dialog.open未初始化引起的中间失败保留，补原生false/空returnValue后专项通过，未放宽产品断言。真实只读MySQL联调副本仅改结果文件名，验证当前授权绑定、订单、临时SQLite重启与owner/profile隔离，0业务写入/远程模型/QQ。没有覆盖第23轮原证据。导航夹具退出0、59906无监听、POST0/Cookie0，原7号未应用实验配置保留。

本轮按用户授权以显式文件清单提交并推送完整前端、持久历史依赖和匹配测试，排除其他README、plan、package/lock、IDE及语雀维护文件；Git提交及远端可核对交付版本。证据、截图和最终日志见 `.runtime/frontend-20261009/round34-evidence.json`。后端终态与第23轮版本一致；[独立复核](optimization-plan.md)仍保留SSE中途解绑/重绑/绑定读失败控制、跨进程同owner竞争、物理I/O故障与测试子进程超时回收未验边界，不表达为全部闭合。物理手机、屏读、真实登录/跨设备及商业运行不在本轮验收。

主SQLite最终聚合为6受理轮/6完成回执/busy0，来自2轮旧记录与另一个浏览器归属的4轮记录；后者最后受理于12:26，早于本目标12:28开始。不能拿第33轮全库2轮当本轮起始快照：首次旧基线断言退出1，结果检查改为当前只读分布并保留错误，不修改业务存储。实际交付浏览器仍原1条历史/4消息，本轮该页面未提交咨询；全库数不能用于归因本轮UI产生模型请求。
