# 团购券演示数据库

本项目使用 Docker 中的 MySQL `8.4.11`，数据库名 `dave_agent`。数据全部原创合成，不包含真实订单、客户、门店或支付信息，也不复制参考项目的数据。当前数据库支持团购券规则问答和本人订单查询；退款表只展示历史事实，Agent 没有退款写工具。

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
docker compose up -d --wait
docker compose ps
```

数据库仅发布到 `127.0.0.1:13306`，使用 named volume 保存数据，容器内时区为 UTC。宿主服务连 `127.0.0.1:13306`；以后放入同一个 Compose 网络的服务应连 `mysql:3306`。MySQL 版本升级前要检查兼容性，不能在已有数据卷上盲目降级。

SQL 文件保存为 UTF-8，schema 与 seed 开头显式执行 `SET NAMES utf8mb4`，同时设置客户端、连接和结果字符集。服务器的 `--character-set-server=utf8mb4` 不会自动修正导入客户端的字符集；管理员手工导入也应使用 `mysql --default-character-set=utf8mb4`，防止中文标题、正文和 JSON 标签被错误解码。已经导入的乱码不会因更改配置自动恢复，需要明确的数据修复或重建这份合成 seed。

官方镜像只在空数据目录首次启动时依次执行 `db/01-schema.sql`、`02-seed.sql`、`03-readonly.sql`。修改 SQL 不会自动修改已有数据卷，重新执行 `up` 也不会重新 seed。保留已有数据时需要管理员执行明确的数据变更；`docker compose down` 保留 volume。`docker compose down -v` 会删除本项目的所有演示数据与身份绑定，只在明确需要重建时使用。

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
| `COUPON-1008` | 客户一 | 私享套餐、已支付、未核销 | 实付 99.80 元，特殊节假日规则缺失；应说明未知并询问具体日期 |

`TEST_APP`＋`TEST_USER1/TEST_USER2` 是自动检查使用的合成绑定，不是真实 QQ 身份。真实群里可用的身份必须来自 SDK 已验证消息的发送者标识，再由本机管理员绑定；消息正文里的客户 ID、订单归属声明或 QQ 群成员身份不能自行建立绑定。

## 知识证据与只读权限

知识库包含 8 篇演示文档：`KB-REFUND-UNUSED`、`KB-REFUND-REDEEMED`、`KB-REFUND-EXPIRED`、`KB-REFUND-PARTIAL`、`KB-REFUND-PAYMENT` 是通用规则；`KB-SHOP-DEMO-1` 是门店规则；`KB-PRODUCT-LUNCH` 和 `KB-PRODUCT-DINNER` 为门店套餐规则。检索返回证据 ID 与正文，回答需引用本次实际返回的证据，不能仅凭标题或历史回答臆造政策。

数据库缺少法定节假日、特殊活动、实时库存、菜品明细和过敏原政策，询问这些内容时应说明缺口。所有“可申请退款”描述都是演示资格说明，不等于申请已受理、商家批准或资金到账。

官方镜像会先给 `MYSQL_USER` 库级权限，并把数据库名中的下划线转义。`03-readonly.sql` 按账户撤销全部权限及授权权，再只对确切的 `dave_agent` 数据库授予固定账号 `dave_agent_read` **SELECT**：

```sql
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'dave_agent_read'@'%';
GRANT SELECT ON `dave\_agent`.* TO 'dave_agent_read'@'%';
```

上述数据库授权中的 `\_` 匹配字面下划线，避免将 `_` 当成授权模式的单字符通配符；按账户撤权也避免与镜像创建的转义授权名称不匹配。语法依据是 MySQL 8.4 官方 [REVOKE](https://dev.mysql.com/doc/refman/8.4/en/revoke.html) 与 [GRANT](https://dev.mysql.com/doc/refman/8.4/en/grant.html) 说明。应用仅用这个账号，管理员密码不进入应用数据库连接配置。验收需查询实际 grants，并确认 UPDATE 被拒绝；环境声明、Prompt 或“没有写工具”均不能单独证明数据库只读。更改 `.env` 密码不会修改已有 MySQL 账户密码，必须由管理员显式变更，保持宿主配置同步。

本阶段不提供 SQL 执行工具、数据库迁移框架、退款提交或商家协商任务表；这些能力在对应业务流程开始实现时再添加。
