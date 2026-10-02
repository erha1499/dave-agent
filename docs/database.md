# 团购券演示数据库

本项目使用 Docker 中的 MySQL `8.4.11`，数据库名 `dave_agent`。数据全部原创合成，不包含真实订单、客户、门店或支付信息，也不复制参考项目的数据。当前数据库支持团购券规则问答、本人订单查询，以及可选的 D1 模拟商家协商和 D2 模拟退款。模型可以准备退款方案与查询结果，执行退款仅由宿主的精确确认入口调用。

基础业务包含 11 表/8 个只读订单，评测另有四张 `eval_*` 表；D1 增加两张协商表与三张独立订单，D2 增加 `refund_operations`，均复用同一个 MySQL。2026-10-02 基础业务、D1 与 D2 的真实数据库及工程检查通过。CLI 与 QQ 共用 `createCouponSession(identity, store, runtime, model, afterSales?)`，可选第五参数增加协商准备/查询；其中 `refunds` 配置再增加退款方案/查询，共六项工具，宿主确认不是模型工具。真实模型与 QQ 的效果另行验收，数据库通过不能单独证明模型会正确使用工具。

## 启动与连接

先启动本机 Docker，将以下配置填入被 Git 忽略的 `.env`。两个密码使用本机生成的随机值，不要复制到聊天或公开仓库。

```dotenv
MYSQL_ROOT_PASSWORD=<本机管理员随机密码>
DB_HOST=127.0.0.1
DB_PORT=13306
DB_NAME=dave_agent
DB_USER=dave_agent_read
DB_PASSWORD=<本机应用随机密码>
```

```sh
npm run db:up
docker compose ps
npm run check:business
# 使用真实模型验证固定样例，需模型凭据
npm run check:model
# 停止容器，保留数据卷
npm run db:stop
```

数据库仅发布到 `127.0.0.1:13306`，使用 named volume 保存数据，容器内时区为 UTC。宿主服务连 `127.0.0.1:13306`；以后放入同一个 Compose 网络的服务应连 `mysql:3306`。MySQL 版本升级前要检查兼容性，不能在已有数据卷上盲目降级。

SQL 文件保存为 UTF-8，schema 与 seed 开头显式执行 `SET NAMES utf8mb4`，同时设置客户端、连接和结果字符集。服务器的 `--character-set-server=utf8mb4` 不会自动修正导入客户端的字符集；管理员手工导入也应使用 `mysql --default-character-set=utf8mb4`，防止中文标题、正文和 JSON 标签被错误解码。已经导入的乱码不会因更改配置自动恢复，需要明确的数据修复或重建这份合成 seed。

官方镜像只在空数据目录首次启动时按文件名顺序执行 `db/` 中的 SQL；现有文件包括基础结构/seed/只读授权，以及 `04-evaluation.sql`、`05-merchant.sql`、`06-refunds.sql`。修改 SQL 不会自动修改已有数据卷，重新执行 `up` 也不会重新 seed。已有库使用 `npm run eval:init`、`npm run after-sales:init` 分别补充对应结构和独立受限账户；空库首次启动后也需这些命令配置账户密码。`docker compose down` 保留 volume；`docker compose down -v` 会删除本项目的所有演示数据与身份绑定，只在明确需要重建时使用。

## 表关系与约束

金额均为非负整数分，应用不依赖浮点数。业务 ID 区分大小写；时间字段是 UTC 的 `DATETIME(3)`。稳定外部订单号就是 `orders.id`，不另造一套不可见订单编号。

| 表 | 作用及主要字段 |
| --- | --- |
| `customers` | 内部客户：`id`、`display_name` |
| `qq_identities` | 可信绑定：`app_id`、`sender_id`、`customer_id`；AppID＋发送者唯一 |
| `merchants` | 商家：`id`、`name` |
| `shops` | 门店：`merchant_id`、`name`、演示地址、启用状态 |
| `products` | 套餐：`shop_id`、名称、说明、`price_cents`、`validity_days` |
| `orders` | 订单：客户、门店、状态、`total_cents`、`paid_cents`、`refunded_cents`、支付时间 |
| `order_items` | 订单项：订单、套餐、门店、数量、实付单价与小计 |
| `coupons` | 每张券：订单项、状态、截止时间、核销时间和核销门店 |
| `payments` | 支付事实：订单、状态、支付金额与时间 |
| `refunds` | 历史退款事实：订单、状态、金额、原因与完成时间 |
| `knowledge_documents` | 规则证据：稳定 `id`、可选门店/套餐范围、标题、正文、JSON 关键词数组、启用状态 |
| `merchant_demo_scenarios` | D1 模拟配置：订单、固定 approve/reject/timeout 结果、延迟；模型不可读取或修改配置 |
| `merchant_requests` | D1 持久任务：唯一订单、taskId、客户与原会话哈希、原始原因、金额、pending/approved/rejected/timed_out 状态及时间 |
| `refund_operations` | D2 当前方案：唯一订单、操作编号、审批任务、可信身份/原会话、金额、prepared/awaiting_confirmation/succeeded、有效期与展示/确认时间、唯一退款记录 |

```text
QQ AppID + senderId → qq_identities → customers → orders
                                                ├─ payments
                                                ├─ refunds
                                                └─ order_items → products → shops → merchants
                                                      └─ coupons
knowledge_documents → 可选 shops / products 范围
```

外键拒绝悬空关联，组合外键拒绝把另一门店的套餐放入订单或在另一门店核销。唯一约束防止同一 QQ 发送者绑定两个客户。CHECK 约束验证订单金额关系、订单项小计、支付/退款成功时间及券核销字段一致性。多行合计和已核销数量与订单摘要的对应关系不能由单行 CHECK 代替，数据库检查脚本必须核对 seed 的实际关联数据。

## 可复现订单案例

首客户为 `customer-demo-1`，第二客户为 `customer-demo-2`。所有券截止时间相对于首次初始化时间生成；表内保存真实截止值，后续查询应根据当前时间识别已到期的 `unused` 券，不能永远相信初始状态标签。

| 订单号 | 归属 | 首次初始化时事实 | 金额与规则边界 |
| --- | --- | --- | --- |
| `COUPON-1001` | 客户一 | 双人午餐、已支付、1 张未核销券，剩 14 天 | 实付 79.80 元，可按规则申请；当前仅查询，不执行退款 |
| `COUPON-1002` | 客户二 | 已支付、未核销 | 客户一查询必须拒绝，不能泄露金额和状态 |
| `COUPON-1003` | 客户一 | 未核销，但已过期 7 天 | 实付 79.80 元；需要商家确认，不能套用有效券规则 |
| `COUPON-1004` | 客户一 | 已完成全额历史退款，券已退款 | 原支付及已退均 59.90 元，不能声称本轮退款或再次退款 |
| `COUPON-1005` | 客户一 | 单人晚餐 2 张券，1 张已核销、1 张未核销 | 实付 119.80 元，未消费部分 59.90 元；不能承诺整单可退 |
| `COUPON-1006` | 客户一 | 待支付，无已发放券 | 标价 59.90 元、实付 0 元，没有到账资金可退 |
| `COUPON-1007` | 客户一 | 双人午餐券已核销 | 实付 79.80 元，消费后的售后需商家核实 |
| `COUPON-1008` | 客户一 | 私享套餐、已支付、未核销 | 实付 99.80 元，特殊节假日规则缺失；明确未知并建议向商家核实 |

`TEST_APP`＋`TEST_USER1/TEST_USER2` 是自动检查和 CLI 使用的合成绑定，不是真实 QQ 身份；CLI 通过 `CLI_DEMO_USER` 选择其中一个，QQ 不读取该配置或旧 `CUSTOMER_ID`。真实群里可用的身份必须来自 SDK 已验证消息的发送者标识，再由本机管理员绑定；消息正文里的客户 ID、订单归属声明或 QQ 群成员身份不能自行建立绑定。

D1 另加 `COUPON-2001/2002/2003`，均为客户一、单张未核销午餐券、实付 79.80 元，初始化时有效期 30 天。2001 固定模拟同意、2002 固定模拟拒绝，均延迟约 5 秒；2003 不返回商家结果，约 8 秒到期。它们不参与原 100x 只读案例；任务由用户明确确认才创建，迁移不会自动发起任务，也不会重置已存在的任务或刷新券有效期。

未绑定发信人的可信身份文件保存本机忽略目录 `.runtime/qq-identities/`，日志只输出 12 位匿名身份代号。管理员核对实际发信人及其演示客户归属后运行 `npm run qq:bind -- <身份代号> <对应客户ID>`；脚本用容器管理员权限写入 `qq_identities`，不会覆盖已有绑定。不能自动把所有发信人绑定到客户一。应用在每次查询时重新检查数据库映射，绑定完成后无需重启 QQ 会话；未绑定用户仍可咨询通用规则，订单查询与他人/不存在订单使用同一种拒绝结果。

## 知识证据与只读权限

知识库包含 8 篇演示文档：`KB-REFUND-UNUSED`、`KB-REFUND-REDEEMED`、`KB-REFUND-EXPIRED`、`KB-REFUND-PARTIAL`、`KB-REFUND-PAYMENT` 是通用规则；`KB-SHOP-DEMO-1` 是门店规则；`KB-PRODUCT-LUNCH` 和 `KB-PRODUCT-DINNER` 为门店套餐规则。检索返回证据 ID 与正文，回答需引用本次实际返回的证据，不能仅凭标题或历史回答臆造政策。

数据库缺少法定节假日、特殊活动、实时库存、菜品明细和过敏原政策，询问这些内容时应说明缺口。所有“可申请退款”描述都是演示资格说明，不等于申请已受理、商家批准或资金到账。

官方镜像会先给 `MYSQL_USER` 库级权限，并把数据库名中的下划线转义。`03-readonly.sql` 按账户撤销全部权限及授权权，再只对确切的 `dave_agent` 数据库授予固定账号 `dave_agent_read` **SELECT**：

```sql
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'dave_agent_read'@'%';
GRANT SELECT ON `dave\_agent`.* TO 'dave_agent_read'@'%';
```

上述数据库授权中的 `\_` 匹配字面下划线，避免将 `_` 当成授权模式的单字符通配符；按账户撤权也避免与镜像创建的转义授权名称不匹配。语法依据是 MySQL 8.4 官方 [REVOKE](https://dev.mysql.com/doc/refman/8.4/en/revoke.html) 与 [GRANT](https://dev.mysql.com/doc/refman/8.4/en/grant.html) 说明。基础订单与规则工具仅用这个账号，管理员密码不进入应用数据库连接配置。验收需查询实际 grants，并确认 UPDATE 被拒绝；环境声明、Prompt 或“没有写工具”均不能单独证明数据库只读。更改 `.env` 密码不会修改已有 MySQL 账户密码，必须由管理员显式变更，保持宿主配置同步。

## D1 协商账户与事务

运行 `npm run after-sales:init`，脚本通过本机 Docker 管理员连接补充 `05-merchant.sql`，创建默认账号 `dave_agent_after_sales`，并在本机 `.env` 生成 `AFTER_SALES_DB_PASSWORD`；文件权限为 `0600`。账号只能 SELECT 订单、身份、券、支付、退款和模拟配置等所需表，以及 SELECT/INSERT/UPDATE `merchant_requests`，不能修改订单、支付、退款、身份绑定或模拟场景配置。初始化会按本机配置同步该专用账号密码和权限，不清空业务表或 QQ 绑定。

宿主根据可信 AppID、用户与原会话生成 `source_key`，模型参数不能提供这些值。准备建议只读；宿主收到精确单行确认后，在事务中重新校验当前归属、单券未核销/未过期、全额支付且未退款等事实。`order_id` 唯一约束保证每个演示订单一个任务，重复确认保留原任务和原原因；另一用户或会话不能读取或接管它。任务结果检查 taskId、订单、状态与金额上限，重复或过期结果不覆盖终态。

QQ/CLI 的同进程 worker 默认每 500 毫秒检查数据库中的到期任务，模拟结果约 5 秒、超时约 8 秒，并非精确定时承诺。停止进程后不会推进状态；重启会继续扫描，超过截止时间的任务进入超时。持久化任务不等于持久化 Pi 对话。D1 不写退款事实、不通知真实商家、不公开网络商家回调；D2 退款使用独立账户，原会话主动通知留 D3。运行与验证见 [模拟协商说明](./after-sales.md)。

当前不提供通用 SQL 执行工具或数据库迁移框架；D2 仅支持演示单的整笔模拟退款。

## D2 退款账户与事务

同一个 `after-sales:init` 命令补充 `06-refunds.sql`，创建默认 `dave_agent_refund`，将 `REFUND_DB_PASSWORD` 写入本机 `.env`。它只读所需业务/审批事实，对 `refund_operations` 有 SELECT/INSERT/UPDATE、对 `refunds` 有 INSERT、对 `orders` 仅能 UPDATE `status/refunded_cents`、对 `coupons` 仅能 UPDATE `status`；不能写身份、支付或商家审批。D1 与基础只读账户不增加退款权限。

`prepare_refund` 校验原会话的商家批准和整笔资格后登记 15 分钟有效方案。QQ API 成功接受摘要后，宿主才将其标记为 `awaiting_confirmation`；真实用户精确发送操作编号才进入确认。过期或审批/金额改变时，重新准备轮换编号，旧确认失效。

所有 D2 修改先锁定同一订单，事务内核对归属、审批、当前券/付款/退款事实与金额，取得必要锁后再次按数据库时间检查方案及券有效期。确认将退款记录、订单已退金额、券状态和操作结果一同提交；同一操作重复或并发确认返回同一退款记录。准备与确认权限均在业务边界检查，不依赖模型话术或内存会话。

## 验收范围

`npm run check:business` 分别执行两层检查：

- 真实 MySQL：11 表关联、8 个订单案例、整数金额和支付/退款事实、可信身份与 AppID 隔离、归属和输入校验、规则作用域及有效证据、中文规则检索、未知问题和 UPDATE 权限拒绝。
- 真实 Pi SDK＋faux 模型＋真实 MySQL：精确 Prompt/Skill、两个工具声明、参数中不接受客户身份、工具结果回填，以及未绑定/越权/错误路径。这是工程回放，不是模型语义成绩。

只读业务的两层工程检查与真实 DeepSeek 9 场景、10 轮回归均已通过，覆盖多轮澄清/未核销、过期、已退款、部分核销、待支付、已核销、未知政策、未绑定和越权边界。不引用参考项目的评测成绩，也不把少量关键词断言称为完整检索基线。真实 QQ 已验证多轮追问、管理员可信绑定、本人订单和规则查询、实际工具拒绝他人订单，以及 `COUPON-1008` 查询引用门店证据并明确节假日政策缺失。D1/D2 真实群已完成同意退款、幂等、重启查询和拒绝/超时验收；公网 HTTP、真实双用户隔离和手机端验收留后续。

`npm run check:merchant` 已通过真实 MySQL 与 Pi/faux 工程检查，覆盖只读准备、精确宿主确认、用户/会话隔离、重复申请与回调、同意/拒绝/超时、重建 store 后查结果，以及权限拒绝和退款事实不变。检查使用临时合成订单并按随机标记清理，保留 2001–2003 供人工演示；这些是工程检查，尚未写入评测平台，也不作为真实 QQ 或模型质量成绩。

此前 D1 Prompt 修改后，`npm run validate` 和原只读真实模型回归再次通过：9 场景、10 轮、88 项检查，已保存评测运行 `8ab32fb3-6ce9-4eb8-b5d9-5a013c8acb2c`。另一个独立的 `npm run check:merchant-model` 使用真实 DeepSeek＋MySQL＋QQAgent、本地替代发送函数，通过 3 轮模型回复及 1 轮宿主确认，验证准备、期间咨询和结果查询；这条独立检查不写评测工作台，也不通过 QQ 平台发送；D1/D2 的持久真实模型套件见下文。


`npm run check:refund` 已覆盖真实 MySQL 权限、成功展示后确认、15 分钟有效期、旧编号失效、身份/原群限制、审批/金额/券/付款/历史退款复核、并发幂等及重启查询。检查使用带随机归属标记的临时订单并清理，保持原 100x 基线。

`npm run check:refund-model` 保存独立真实模型套件 `after-sales-refund-v1`：已记录通过 run `6349a275-946c-44bc-aac2-a8b9987f55d4` 为 3/3 场景、12/12 轮、67/67 检查通过，覆盖批准退款、重复确认、重启查询和拒绝/超时不生成方案。它经过真实模型、MySQL 和 QQAgent，发送在本地替代；实际 QQ 群验收也已单独通过，不包含真实资金操作。

同版 Skill 的只读回归 run `8c921f5f-eb37-44c0-86e9-bedc23eb6727` 为 9/9 场景、10/10 轮、88/88 检查通过；旧回归记录保留，与 D1/D2 指标分开。


真实群数据库核对：成功路径与重复确认均为同一退款 UUID，仅一笔 7980 分退款，订单及券为 `refunded`；机器人真正重启后读取同一结果。拒绝与 `timed_out` 路径均无退款方案、无退款记录，已退金额为 0、券为 `unused`。验收使用带随机标记的临时合成订单，按标记清理，不消耗原 100x 与 2001–2003 演示单。
