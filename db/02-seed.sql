-- Original, wholly synthetic fixtures; not copied from a production merchant or kefu-harness.
-- The import client's character set is separate from the server default.
SET NAMES utf8mb4;
USE dave_agent;
SET @seed_now = UTC_TIMESTAMP(3);

INSERT INTO customers (id, display_name) VALUES
  ('customer-demo-1', '演示客户一'),
  ('customer-demo-2', '演示客户二');
-- Test-only identities are synthetic strings, never QQ account numbers or real OpenIDs.
-- A real QQ sender must be independently verified and bound by the host administrator.
INSERT INTO qq_identities (app_id, sender_id, customer_id) VALUES
  ('TEST_APP', 'TEST_USER1', 'customer-demo-1'),
  ('TEST_APP', 'TEST_USER2', 'customer-demo-2');

INSERT INTO merchants (id, name) VALUES ('merchant-demo-1', '演示餐饮商家（虚构）');
INSERT INTO shops (id, merchant_id, name, address) VALUES
  ('shop-demo-1', 'merchant-demo-1', '云味餐厅演示店（虚构）', '虚拟市演示路 1 号（非真实地址）');
INSERT INTO products (id, shop_id, name, description, price_cents, validity_days) VALUES
  ('product-demo-1', 'shop-demo-1', '双人午餐团购券', '两人午餐套餐；演示券，一张券核销一次。', 7980, 30),
  ('product-demo-2', 'shop-demo-1', '单人晚餐团购券', '单人晚餐套餐；演示券，一张券核销一次。', 5990, 30),
  ('product-demo-3', 'shop-demo-1', '私享套餐团购券', '演示私享套餐；节假日使用政策未录入。', 9980, 30);

INSERT INTO orders (id, customer_id, shop_id, status, total_cents, paid_cents, refunded_cents, created_at, paid_at) VALUES
  ('COUPON-1001', 'customer-demo-1', 'shop-demo-1', 'paid', 7980, 7980, 0, @seed_now - INTERVAL 16 DAY, @seed_now - INTERVAL 16 DAY),
  ('COUPON-1002', 'customer-demo-2', 'shop-demo-1', 'paid', 7980, 7980, 0, @seed_now - INTERVAL 1 DAY, @seed_now - INTERVAL 1 DAY),
  ('COUPON-1003', 'customer-demo-1', 'shop-demo-1', 'paid', 7980, 7980, 0, @seed_now - INTERVAL 37 DAY, @seed_now - INTERVAL 37 DAY),
  ('COUPON-1004', 'customer-demo-1', 'shop-demo-1', 'refunded', 5990, 5990, 5990, @seed_now - INTERVAL 10 DAY, @seed_now - INTERVAL 10 DAY),
  ('COUPON-1005', 'customer-demo-1', 'shop-demo-1', 'partially_redeemed', 11980, 11980, 0, @seed_now - INTERVAL 2 DAY, @seed_now - INTERVAL 2 DAY),
  ('COUPON-1006', 'customer-demo-1', 'shop-demo-1', 'pending_payment', 5990, 0, 0, @seed_now - INTERVAL 1 HOUR, NULL),
  ('COUPON-1007', 'customer-demo-1', 'shop-demo-1', 'redeemed', 7980, 7980, 0, @seed_now - INTERVAL 3 DAY, @seed_now - INTERVAL 3 DAY),
  ('COUPON-1008', 'customer-demo-1', 'shop-demo-1', 'paid', 9980, 9980, 0, @seed_now - INTERVAL 1 DAY, @seed_now - INTERVAL 1 DAY);

INSERT INTO order_items (id, order_id, product_id, shop_id, quantity, unit_price_cents, total_cents) VALUES
  ('item-1001', 'COUPON-1001', 'product-demo-1', 'shop-demo-1', 1, 7980, 7980),
  ('item-1002', 'COUPON-1002', 'product-demo-1', 'shop-demo-1', 1, 7980, 7980),
  ('item-1003', 'COUPON-1003', 'product-demo-1', 'shop-demo-1', 1, 7980, 7980),
  ('item-1004', 'COUPON-1004', 'product-demo-2', 'shop-demo-1', 1, 5990, 5990),
  ('item-1005', 'COUPON-1005', 'product-demo-2', 'shop-demo-1', 2, 5990, 11980),
  ('item-1006', 'COUPON-1006', 'product-demo-2', 'shop-demo-1', 1, 5990, 5990),
  ('item-1007', 'COUPON-1007', 'product-demo-1', 'shop-demo-1', 1, 7980, 7980),
  ('item-1008', 'COUPON-1008', 'product-demo-3', 'shop-demo-1', 1, 9980, 9980);

INSERT INTO coupons (id, order_item_id, status, expires_at, redeemed_at, redeemed_shop_id) VALUES
  ('CP-1001-1', 'item-1001', 'unused', @seed_now + INTERVAL 14 DAY, NULL, NULL),
  ('CP-1002-1', 'item-1002', 'unused', @seed_now + INTERVAL 29 DAY, NULL, NULL),
  ('CP-1003-1', 'item-1003', 'expired', @seed_now - INTERVAL 7 DAY, NULL, NULL),
  ('CP-1004-1', 'item-1004', 'refunded', @seed_now + INTERVAL 20 DAY, NULL, NULL),
  ('CP-1005-1', 'item-1005', 'redeemed', @seed_now + INTERVAL 28 DAY, @seed_now - INTERVAL 1 DAY, 'shop-demo-1'),
  ('CP-1005-2', 'item-1005', 'unused', @seed_now + INTERVAL 28 DAY, NULL, NULL),
  ('CP-1007-1', 'item-1007', 'redeemed', @seed_now + INTERVAL 27 DAY, @seed_now - INTERVAL 2 DAY, 'shop-demo-1'),
  ('CP-1008-1', 'item-1008', 'unused', @seed_now + INTERVAL 29 DAY, NULL, NULL);

INSERT INTO payments (id, order_id, status, amount_cents, paid_at, created_at) VALUES
  ('payment-1001', 'COUPON-1001', 'succeeded', 7980, @seed_now - INTERVAL 16 DAY, @seed_now - INTERVAL 16 DAY),
  ('payment-1002', 'COUPON-1002', 'succeeded', 7980, @seed_now - INTERVAL 1 DAY, @seed_now - INTERVAL 1 DAY),
  ('payment-1003', 'COUPON-1003', 'succeeded', 7980, @seed_now - INTERVAL 37 DAY, @seed_now - INTERVAL 37 DAY),
  ('payment-1004', 'COUPON-1004', 'succeeded', 5990, @seed_now - INTERVAL 10 DAY, @seed_now - INTERVAL 10 DAY),
  ('payment-1005', 'COUPON-1005', 'succeeded', 11980, @seed_now - INTERVAL 2 DAY, @seed_now - INTERVAL 2 DAY),
  ('payment-1006', 'COUPON-1006', 'pending', 5990, NULL, @seed_now - INTERVAL 1 HOUR),
  ('payment-1007', 'COUPON-1007', 'succeeded', 7980, @seed_now - INTERVAL 3 DAY, @seed_now - INTERVAL 3 DAY),
  ('payment-1008', 'COUPON-1008', 'succeeded', 9980, @seed_now - INTERVAL 1 DAY, @seed_now - INTERVAL 1 DAY);

INSERT INTO refunds (id, order_id, status, amount_cents, reason, completed_at, created_at) VALUES
  ('refund-1004', 'COUPON-1004', 'succeeded', 5990, '合成历史记录：用户取消行程', @seed_now - INTERVAL 8 DAY, @seed_now - INTERVAL 8 DAY);

INSERT INTO knowledge_documents (id, shop_id, product_id, title, body, tags) VALUES
  ('KB-REFUND-UNUSED', NULL, NULL, '未核销且未过期团购券退款规则',
   '【演示规则】已支付、未核销且尚未过期的团购券可以申请退款。必须先查本人订单确认支付、核销和有效期；可申请金额不超过尚未消费且未退款的实付金额。退款申请资格不等于商家已经批准或资金已经退回。当前助手只能查询与说明，不能申请、联系商家或执行退款。',
   JSON_ARRAY('退款', '能退', '可以退', '未核销', '没用', '没使用', '未使用', '有效期', '退钱', '退款金额')),
  ('KB-REFUND-REDEEMED', NULL, NULL, '已核销团购券售后规则',
   '【演示规则】已经核销的团购券不适用未核销自动退款规则，需由商家核实实际消费与售后原因后决定。没有商家核实结果时不能承诺可退、不可退或具体金额。当前助手无法联系商家或提交退款，只能解释规则并建议用户自行咨询商家。',
   JSON_ARRAY('退款', '已经用', '已使用', '已核销', '消费', '吃过', '售后', '商家确认')),
  ('KB-REFUND-EXPIRED', NULL, NULL, '过期团购券售后规则',
   '【演示规则】已过期但未核销的券需要商家确认能否退款、延期以及金额。知识库未提供过期自动退款或自动延期政策。不得把未过期券的规则套用到过期券，也不能自行编造门店承诺。当前助手只提供查询和说明。',
   JSON_ARRAY('退款', '过期', '失效', '到期', '延期', '有效期', '没用', '未核销')),
  ('KB-REFUND-PARTIAL', NULL, NULL, '部分核销订单退款规则',
   '【演示规则】同一订单有多张券时必须逐券核对。未核销、未过期、未退款部分可申请的金额按对应券的实付单价计算；已核销部分需商家另行核实，不能按整单实付金额承诺退款。查询工具提供的金额只是演示规则下的申请上限，尚未提交或完成退款。',
   JSON_ARRAY('退款', '部分核销', '用了一张', '剩余', '两张', '退款金额', '退一张')),
  ('KB-REFUND-PAYMENT', NULL, NULL, '未支付订单和已退款订单',
   '【演示规则】未支付订单没有到账资金，因此没有可退金额；不能把订单标价当作实付金额。已完成退款的订单需以支付和退款历史为准，不得重复退款；展示已退金额时说明这是已有历史记录，并非本轮执行。当前查询助手不会取消订单或发起退款。',
   JSON_ARRAY('退款', '未付款', '未支付', '待支付', '已经退', '已退款', '重复退款', '支付金额')),
  ('KB-SHOP-DEMO-1', 'shop-demo-1', NULL, '演示门店使用与预约说明',
   '【演示规则】云味餐厅演示店为虚构餐饮门店，演示地址为虚拟市演示路1号。常规午餐与晚餐套餐允许普通周末使用，到店前需用户自行与商家确认接待情况；助手目前不能预约、外呼、查询实时库存或安排接待。法定节假日、特殊活动和私享套餐使用限制没有录入，遇到这些问题应明确规则缺失并建议向商家核实。',
   JSON_ARRAY('门店', '地址', '周末', '预约', '营业', '套餐', '接待', '节假日', '五一', '十一', '私享')),
  ('KB-PRODUCT-LUNCH', 'shop-demo-1', 'product-demo-1', '双人午餐套餐说明',
   '【演示规则】双人午餐团购券标价79.80元，一张券对应两人午餐套餐，核销一次即视为整张券已使用。每张券具体截止时间以订单返回的 expiresAt 为准，不能从标价推断实付金额。菜品明细、过敏原和特殊节假日可用性未录入。',
   JSON_ARRAY('午餐', '双人', '套餐', '价格', '两人', '核销', '有效期')),
  ('KB-PRODUCT-DINNER', 'shop-demo-1', 'product-demo-2', '单人晚餐套餐说明',
   '【演示规则】单人晚餐团购券标价59.90元，一张券对应一人晚餐，核销一次即视为整张券已使用。订单购买两张券时可以分别核销，剩余券状态以订单查询为准。菜品明细、过敏原和特殊节假日可用性未录入。',
   JSON_ARRAY('晚餐', '单人', '套餐', '价格', '一人', '两张', '分别核销', '剩余'));
