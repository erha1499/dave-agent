# 网页客服问答

日期：2026-10-08；状态：只读问答首版、会话设置v2及消息/重置会话前置条件已实现并工程验证。设置沿用下文v2合同，当前消息与新建/替换分别追加[消息前置条件](#旧页消息拒收与迟到-cookie2026-10-08)及[重置前置条件](#旧页重置的会话前置条件2026-10-08)；首版合同与历史证据分列保留。前端由实际Kimi CLI K3 / Max完成，Codex完成后端与独立联调。

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
