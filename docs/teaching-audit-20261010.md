# 教学质量与术语审计（2026-10-10）

状态：已完成。27 页均已发布、重新加载并回读完整原生文档；知识库目录、导航、图片和 Mermaid 已完成最终核验。

## 本轮解决什么问题

读者了解基础 LLM / RAG，但不认识 dave-agent，希望能沿一个实际问题讲清架构、个人实现、设计取舍、失败与验证结果。此前材料中“Harness、取证、门禁、回执”等词在不同场景指代不一，标题也偏阶段记录。本轮沿现有实现和已保存证据审查教学正文，用具体行为解释术语，改成更自然的问题式标题，并保持核心源码自包含。

| P0 项目 | 本轮约束 |
| --- | --- |
| 真实业务约束 | 合成订单、商家与资金；身份、确认、金额、幂等和恢复由真实代码与存储执行。文档简化不能省掉这些约束。 |
| 具体面试追问 | 从用户提问到最终回答是谁在做什么；Skill 怎样加载、权限怎样强制；重启后恢复什么；工具正确为何仍可能答错。 |
| 个人实现与复用 | 复用 Pi 的循环与生命周期，项目贡献集中在业务 Harness / Controller、可信上下文、工具和检索边界、异步售后与评测。 |
| 验收与演示证据 | 当前线上原文备份、原生卡片保全、正文交叉复审、源码与历史记录核对、本地链接及差异检查；27 页在线阅读与完整原生文档复核通过。 |
| 投入预算与停止条件 | 限现有文档的一轮审计、必要修订和最终复核；不追加模型、数据库或 QQ 业务实验，不因旧分数未满继续追分。 |

## 范围

- 在线范围共 27 页：1 页学习导航与 26 页正文，包含核心链路、Skill、会话与 Memory、RAG、网页、评测、面试、Coding Agent、业务案例及简历模板。
- 本地范围共扫描 44 份：AGENTS.md、README.md、plan.md 和 docs/ 下 41 份 Markdown，其中 42 份修改、2 份保持。既有 `docs/yuque-learning-maintenance.md` 作为维护依据另读，未计入 44 份变更集合。
- 在线编辑以本轮实际页面复制的原生文档为准，避免用旧本地草稿覆盖后续已更新内容。历史源码快照、运行文档和简历说明分别保留各自版本。

## 发现与修正

| 发现 | 本轮处理 |
| --- | --- |
| Harness 被译为“Harness”，职责混在一个词里 | 直接使用 Harness；具体执行者写明 Controller、QQ 接待层、应用服务、RefundStore 或 AfterSalesStore，并解释它们与 Pi 的关系。 |
| 查询、保护和回复使用难懂的同义术语 | 取证按查询订单/规则、核对依据、证据采集处理；门禁按权限或条件检查处理；回执分普通回复、通知、平台确认与请求结果记录，避免混为已读。 |
| Skill 内容存在但标题不突出 | 将对应课程标题明确为 Skill 加载与工具权限；说明固定加载路径、Prompt / Skill 与执行代码的分工，不暗示已实现动态多 Skill 路由。 |
| 标题像阶段编号，目录阅读路线不清 | 保留便于定位的 1.1、2.1 等层级，改为具体问题；选修与业务案例使用自然标题。3.2 明确讨论等锁后的截止复核，避免误写成复核既有退款批准。 |
| 长文存在重复和维护流水账 | 合并长期偏好未来设计的重复小节；将少量历史维护和实验说明移到参考资料位置；保留场景、机制、源码、失败、取舍和练习。 |
| 个别描述停留在旧验收进度 | 依据同库当前记录同步 Web 七轮结果，保留工程 7/7、答复与联合 6/7 及未通过状态；后续确定性文字检查不回填原成绩。 |
| 通俗化可能破坏核心概念 | 保留事务、幂等、CAS、一致快照、schema 等标准词并解释行为；保留作用域、来源、并发窗口与候选限定。 |
| 简历正文可能被审计信息挤占 | 保留面试页 8 条和独立简历 18 条职责结构，正文保持精简；指标出处、环境和边界继续集中说明，不把分母重新塞回每条职责。 |

## 本地静态核验

独立复核确认 44 份扫描、42 份修改；772 个 Markdown 链接目标保持原地址与顺序。其中 675 个本地路径/锚点解析通过，97 个外部地址未逐一重新请求，不能由“目标保留”推导为外站实时可访问。旧标题锚点保留。

源码与可执行命令块逐字保留；UUID、代码/数据哈希、显式费用、实验分数、金额和预算没有改变。新增数字仅来自 D1/D2/D3 的首次释义，旧课号调整不影响实验结果。`git diff --check` 退出 0。

本轮没有修改运行代码、Prompt、Skill、数据或依赖。工作区仍有既有 package.json、package-lock.json、.idea 和计划段落变化，均不能混作本轮产出；最终提交如另有授权，仍需使用明确文档清单。

## 在线发布与最终阅读核验

以本轮最终线上页面为准，独立复审结果与主任务实际视觉检查共同确认以下结果。

| 项目 | 最终结果 |
| --- | --- |
| 27 页当前正文与标题发布 | 27/27 通过；保留原页面地址，全部采用当前在线内容为基线。 |
| 目录层级、页面顺序及导航链接 | 知识库重新加载后逐屏清点到末尾：27 页，无遗漏或额外页；8 个分组名称已更新。课程按 1.1—7.4 排列，选修在面试课之后，业务案例单列；导航覆盖其余 26 页。 |
| 全部页面重新打开后的正文、表格与源码卡 | 27 个标题、4242 个文本片段、291 个小标题、57 个表格/1068 个单元格、117 个链接一致；重新进入编辑器取得完整副本，118 个代码块与语言标记逐字一致。 |
| 图片与 Mermaid 标签、加载与实际显示 | 52/52 图片引用、5/5 Mermaid 加载完成，来源及顺序一致；18 张独立图片全部审阅，其中 6 张修正术语并同步 12 处引用。 |
| 简历两处职责格式与指标 | 7.4 的 8 条推荐职责、独立模板的 8 条推荐及 10 条替换职责保留；指标来源与限制仍集中在备查部分。 |
| 发现的问题及最终修复 | 7.4 横向 Mermaid 文字过小，改为纵向且节点/连线不变；3.3 两处长注释超出底色框，分行后实际阅读页显示完整。最终复审无未处理内容或图形问题。 |

目录分组依次为“Agent 怎样运行”“Skill、工具与权限”“一次售后怎样可靠完成”“上下文与 Memory”“RAG 怎样找到可用依据”“网页接入与会话恢复”“效果、成本与面试”“带着业务问题查阅”。下表列出已发布页面，按学习顺序排列。

| 页面 | 标题 |
| --- | --- |
| 1 | [从哪里开始学 Dave-Agent？一张阅读路线图](https://www.yuque.com/erha-vrnso/repg3o/vb4ua7gq7zdpthhn) |
| 2 | [1.1 从用户提问到最终回答，Agent 是怎样运行的？](https://www.yuque.com/erha-vrnso/repg3o/3c7971f2134157e0f179aff6c7b0fd30) |
| 3 | [1.2 配置改了，为什么程序没有按预期运行？](https://www.yuque.com/erha-vrnso/repg3o/piqm37taos3w4v96) |
| 4 | [2.1 用户说“这是我的订单”，系统该相信吗？](https://www.yuque.com/erha-vrnso/repg3o/hkarf7z7sp68lw1p) |
| 5 | [2.2 Skill 怎么加载，工具权限又由谁控制？](https://www.yuque.com/erha-vrnso/repg3o/zggy63v4e66fov5d) |
| 6 | [3.1 从“想退款”到联系商家，为什么还要确认？](https://www.yuque.com/erha-vrnso/repg3o/vl5ed2mnp6n4yddh) |
| 7 | [3.2 拿到数据库锁后，为什么还要检查截止时间？](https://www.yuque.com/erha-vrnso/repg3o/ke73n9g4wl0pgqxf) |
| 8 | [3.3 退款怎样确认，才能不越权、不重复执行？](https://www.yuque.com/erha-vrnso/repg3o/zoyw530bwvxw0q5m) |
| 9 | [3.4 商家晚到的回复，怎样通知到正确的人？](https://www.yuque.com/erha-vrnso/repg3o/us8q9ourkbvuzaaq) |
| 10 | [3.5 请求超时后，怎样取消并接着处理下一条？](https://www.yuque.com/erha-vrnso/repg3o/xe4459ywuihdnres) |
| 11 | [4.1 会话重启了，哪些内容还能恢复？](https://www.yuque.com/erha-vrnso/repg3o/scb40rh02au61uo6) |
| 12 | [4.2 聊天记录、业务引用和长期 Memory 有什么区别？](https://www.yuque.com/erha-vrnso/repg3o/gkntytcceaz6yw3l) |
| 13 | [4.3 上下文快满了，什么时候停止、怎样继续？](https://www.yuque.com/erha-vrnso/repg3o/4bad6d05de0ac4c326a04f5785e4b7aa) |
| 14 | [5.1 关键词、向量和 Rerank，RAG 应该怎么选？](https://www.yuque.com/erha-vrnso/repg3o/23c67bb990333948bfb6bea9a60a2e69) |
| 15 | [5.2 查到一条规则，怎样确认它适用于这笔订单？](https://www.yuque.com/erha-vrnso/repg3o/gfgtkqz4ov2yy0kf) |
| 16 | [5.3 订单查对了，为什么回答仍可能出错？](https://www.yuque.com/erha-vrnso/repg3o/bgk7n1zx4we3gcvn) |
| 17 | [5.4 用户只说“刚才那个”，怎样理解又不猜错？](https://www.yuque.com/erha-vrnso/repg3o/pkpmew1sxmf99o2e) |
| 18 | [6.1 网页选的模型，真的用到这次请求了吗？](https://www.yuque.com/erha-vrnso/repg3o/hk0gwwgm4rqk4ncu) |
| 19 | [6.2 刷新、断线和多标签页，怎样避免丢回复与串会话？](https://www.yuque.com/erha-vrnso/repg3o/tu9dm4a5wev2otqf) |
| 20 | [7.1 Agent 做得好不好，效果、延迟和成本怎么算？](https://www.yuque.com/erha-vrnso/repg3o/ylctono5n6gx1kc3) |
| 21 | [7.2 工具成功、回答却错了，怎样验收完整任务？](https://www.yuque.com/erha-vrnso/repg3o/5bb102e88426b8d894179cf8dbf8c610) |
| 22 | [7.3 换一个模型值不值，怎样做公平对照？](https://www.yuque.com/erha-vrnso/repg3o/xyafwngxm605xte2) |
| 23 | [7.4 面试时怎样讲清自己的实现、取舍和结果？](https://www.yuque.com/erha-vrnso/repg3o/ba571017e1270654ce01c930f34673c0) |
| 24 | [选修：仓库太大放不进上下文，Coding Agent 怎么办？](https://www.yuque.com/erha-vrnso/repg3o/b32aa6c3928922f6a28535ea59684b82) |
| 25 | [案例：问“多久到账”和问“已经到账了吗”，差在哪？](https://www.yuque.com/erha-vrnso/repg3o/gudinkahr1hknxmf) |
| 26 | [案例：一张券用掉了，剩下的钱能直接退吗？](https://www.yuque.com/erha-vrnso/repg3o/rixwimb2cfm7fexc) |
| 27 | [Dave-Agent 简历项目描述与职责模板](https://www.yuque.com/erha-vrnso/repg3o/unul46mhmro4k8do) |

## 证据边界

本次是教学和术语修订，没有新增业务功能。未运行 npm validate、数据库专项、业务远程模型、真实 QQ 或商业支付验证，也未重跑已关闭实验。静态检查、源码说明、历史模型结果、真实数据库、真实 QQ 客户端与商业运行继续分别表述；项目没有真实商业交易。

本轮为修正文档插图进行了 3 次 ImageGen 调用，用量费用未知；它们不是业务模型评测，不能计入客服效果或成本结果。

默认主线、Controller / 知识判别 / 持久引用候选及其未准入状态不变。小题集分数不能推广为生产完成率；失败、跳过、缺失和未知费用均保留。主工作区与交付 worktree 的运行版本不同，线上较新教学材料不能自动成为主区当前实现的证据。

本地详细审阅材料保存在 `.runtime/teaching-audit-20261010/`，包括保存前副本、最终原生正文、发布后完整副本、逐篇修改说明、交叉复审、本地链接与差异核验。最终汇总为 `final-live-review.md/json`、`final-directory.json`；实际阅读效果见 `proof-final-navigation.png` 和 `proof-refund-diagram-final.png`。该目录是本机检查材料，不作为业务运行日志公开入库。
