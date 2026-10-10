# MiniMax 面试补齐：语雀本地导入包

本包保存已发布课程的本地源稿，沿用并扩写2026-10-10核对的语雀正文。用户授权先修复问题、完成必要验收，再发布语雀；本轮16篇现有页面更新、3篇新课均已保存，随后实际重载全册26篇并核验目录。

**当前发布状态：发布与全册阅读页验收完成。** 最终26/26篇通过，失败0、待验0；52张图片、118个代码块、5个原生Mermaid图表逐项核对，导航覆盖其余25篇，侧栏新课层级和顺序另行检查。发布验收摘要见[记录](../../../data/yuque-publication-results-20261010.json)。Web真实模型新题仍为工程7/7、答复与联合6/7；唯一宿主拒绝文字缺陷已另用确定性检查修复，不回填原题批。旧20/26、9/11、5/6及本次6/7的失败和未准入状态均保留。

在线入口为[00 学习导航](https://www.yuque.com/erha-vrnso/repg3o/vb4ua7gq7zdpthhn)，本地源稿为[00 学习导航](./00-navigation.md)，项目实现与验收进度见 [plan](../../../plan.md)。本次覆盖说明见 [MiniMax 面试映射](../../minimax-interview-coverage.md)。

## 替换已有页面

以下文件包含原文和新增内容，应更新原页面，避免创建同名重复课程。

| 草稿 | 原页面 | 本次重点 |
| --- | --- | --- |
| [00 学习导航](./00-navigation.md) | [语雀导航](https://www.yuque.com/erha-vrnso/repg3o/vb4ua7gq7zdpthhn) | 新课位置、面试与复现路线 |
| [01.00 宿主](./01.00-host.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/3c7971f2134157e0f179aff6c7b0fd30) | 动作协议、固定依赖、步骤成功标准 |
| [01.10 启动过程](./01.10-startup.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/piqm37taos3w4v96) | 会话工厂与任务预算初始化的当前源码 |
| [02.10 可信身份](./02.10-identity.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/hkarf7z7sp68lw1p) | 授权失败与当前任务记录的源码同步 |
| [02.20 工具与 Skill](./02.20-tools-skills.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/zggy63v4e66fov5d) | 真正的 Skill 文件、加载方式、权限边界 |
| [03.30 退款](./03.30-refund.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/zoyw530bwvxw0q5m) | COMMIT 前后进程退出窗口 |
| [03.40 结果通知](./03.40-notifications.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/us8q9ourkbvuzaaq) | 通知模型的三项只读工具及当前取证依赖 |
| [03.50 失败与恢复](./03.50-failures.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/xe4459ywuihdnres) | retry / repair / clarify / query / stop、故障归因 |
| [04.10 会话重建](./04.10-session-rebuild.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/scb40rh02au61uo6) | 会话轮换、创建及阶段记录的源码同步 |
| [04.20 记忆取舍](./04.20-memory.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/gkntytcceaz6yw3l) | 当前 TTL / 容量 / 删除；长期记忆的新增条件 |
| [05.10 规则来源](./05.10-rules.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/gfgtkqz4ov2yy0kf) | 宿主如何强制本轮授权范围及失败后失效 |
| [05.20 订单取证](./05.20-retrieval.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/bgk7n1zx4we3gcvn) | 订单、规则和输出依据不能互相替代 |
| [06.20 网页重试与回放](./06.20-web-replay.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/tu9dm4a5wev2otqf) | 本轮证据与流式文字的门槛、旧会话隔离及持久回执 |
| [07.10 评测与成本](./07.10-evaluation-cost.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/ylctono5n6gx1kc3) | 多请求、缓存、未知费用与单位正确任务成本 |
| [07.20 模型选型](./07.20-model-selection.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/xyafwngxm605xte2) | 静态分工、自动路由、故障降级的区别 |
| [07.30 面试与 owner](./07.30-interview.md) | [语雀](https://www.yuque.com/erha-vrnso/repg3o/ba571017e1270654ce01c930f34673c0) | 方向判断、主动学习、全天候 Agent、业务推进 |

## 新建课程

| 草稿 | 建议位置 | 学习成果 |
| --- | --- | --- |
| [04.30 上下文预算](./04.30-context-budget.md) | [已发布：04.20后](https://www.yuque.com/erha-vrnso/repg3o/4bad6d05de0ac4c326a04f5785e4b7aa) | 解释窗口、完整请求测量、输出预留与安全重述 |
| [07.15 联合验收](./07.15-joint-acceptance.md) | [已发布：07.10后](https://www.yuque.com/erha-vrnso/repg3o/5bb102e88426b8d894179cf8dbf8c610) | 用同一批证据核对做对、说对与费用 |
| [08.10 Coding Agent 选修](./08.10-coding-agent.md) | [已发布：核心面试课后](https://www.yuque.com/erha-vrnso/repg3o/b32aa6c3928922f6a28535ea59684b82) | 对比代码搜索、AST / LSP、语义检索与 Harness 职责 |

## 导入顺序与核验

先保存现有页面的版本，再更新已有章节；新增三篇后取得实际语雀链接，最后替换导航中的本地链接。`assets/` 中的 SVG 为可编辑原图，每篇新课有两幅不同图。正文已引用 PNG，导入时上传对应图片；上传后使用语雀生成的图片地址，避免保留本机相对路径。现有远程图片沿用原页面资源。

正文包含 Markdown 表格、代码块与部分 Mermaid。导入后逐篇在真实阅读页刷新，检查标题、段落顺序、代码完整性、表格、至少两张图及跳转目标；编辑器中的保存提示不是阅读页验收。对照本包 `manifest.json` 的源稿和资源哈希可发现文件混用，但哈希不能代替页面阅读检查。

发布清单由上面两表确定，README 本身只作导入说明，不新建为课程。文稿数量、现有课程更新数、新课数、导航数、源码节选和图片引用数由生成脚本读取当前目录及审计结果后写入 `manifest.json`，不沿用旧导入包的统计。新增或调整稿件后，先重新执行文稿检查，再生成清单。

源码节选对应本次交付版本；后续改动参数、重试或会话入口时，应同步相关节选。真实运行数据集中在各结果文档，不在课程中复制一份会漂移的成功率。所有模型、工程、MySQL、QQ 与商业验证层级继续分别表述。

修复机制按当前源码教学；真实模型批次已完成运行和独立辅助审阅，后续宿主固定文字的确定性修复与其版本分开记录。不能将离线回归写成真实模型整批通过。旧联合批次的失败、未执行轮和未准入状态保持；新批次另列题集、完整分母、版本、费用与局限，不覆盖历史结果。

作者的职业动机、过往履历、亲自复现与真人签收必须由本人确认。07.30 中的职业思考和业务计划是示范答法，不是替作者声称已经做过这些事。
