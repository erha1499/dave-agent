# MiniMax 面试补齐：语雀本地导入包

本包保存完整课程草稿，沿用 2026-10-10 已核对的语雀正文并扩写。用户本轮授权先生成本地稿；本包没有修改语雀线上内容，也不把本地写入算作发布成功。

入口为 [00 学习导航](./00-navigation.md)，项目实现与验收进度见 [plan](../../../plan.md)。本次覆盖说明见 [MiniMax 面试映射](../../minimax-interview-coverage.md)。

## 替换已有页面

以下文件包含原文和新增内容，应更新原页面，避免创建同名重复课程。

| 草稿 | 原页面 | 本次重点 |
| --- | --- | --- |
| [00 学习导航](./00-navigation.md) | [语雀导航](https://www.yuque.com/erha-vrnso/repg3o/vb4ua7gq7zdpthhn) | 新课位置、面试与复现路线 |
| [01.00 宿主](./01.00-host.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/3c7971f2134157e0f179aff6c7b0fd30) | 动作协议、固定依赖、步骤成功标准 |
| [02.20 工具与 Skill](./02.20-tools-skills.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/zggy63v4e66fov5d) | 真正的 Skill 文件、加载方式、权限边界 |
| [03.30 退款](./03.30-refund.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/zoyw530bwvxw0q5m) | COMMIT 前后进程退出窗口 |
| [03.50 失败与恢复](./03.50-failures.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/xe4459ywuihdnres) | retry / repair / clarify / query / stop、故障归因 |
| [04.20 记忆取舍](./04.20-memory.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/gkntytcceaz6yw3l) | 当前 TTL / 容量 / 删除；长期记忆的新增条件 |
| [07.10 评测与成本](./07.10-evaluation-cost.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/ylctono5n6gx1kc3) | 多请求、缓存、未知费用与单位正确任务成本 |
| [07.20 模型选型](./07.20-model-selection.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/xyafwngxm605xte2) | 静态分工、自动路由、故障降级的区别 |
| [07.30 面试与 owner](./07.30-interview.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/ba571017e1270654ce01c930f34673c0) | 方向判断、主动学习、全天候 Agent、业务推进 |

## 新建课程

| 草稿 | 建议位置 | 学习成果 |
| --- | --- | --- |
| [04.30 上下文预算](./04.30-context-budget.md) | 04.20 后 | 解释窗口、完整请求测量、输出预留与安全重述 |
| [07.15 联合验收](./07.15-joint-acceptance.md) | 07.10 后 | 用同一批证据核对做对、说对与费用 |
| [08.10 Coding Agent 选修](./08.10-coding-agent.md) | 核心面试课后 | 对比代码搜索、AST / LSP、语义检索与 Harness 职责 |

## 导入顺序与核验

先保存现有页面的版本，再更新已有章节；新增三篇后取得实际语雀链接，最后替换导航中的本地链接。`assets/` 中的 SVG 为可编辑原图，每篇新课有两幅不同图。正文已引用 PNG，导入时上传对应图片；上传后使用语雀生成的图片地址，避免保留本机相对路径。现有远程图片沿用原页面资源。

正文包含 Markdown 表格、代码块与部分 Mermaid。导入后逐篇在真实阅读页刷新，检查标题、段落顺序、代码完整性、表格、至少两张图及跳转目标；编辑器中的保存提示不是阅读页验收。对照本包 `manifest.json` 的源稿和资源哈希可发现文件混用，但哈希不能代替页面阅读检查。

源码节选对应本次交付版本；后续改动参数、重试或会话入口时，应同步相关节选。真实运行数据集中在各结果文档，不在课程中复制一份会漂移的成功率。所有模型、工程、MySQL、QQ 与商业验证层级继续分别表述。

作者的职业动机、过往履历、亲自复现与真人签收必须由本人确认。07.30 中的职业思考和业务计划是示范答法，不是替作者声称已经做过这些事。
