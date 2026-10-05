# Kimi 前端协作：客观评测

用户已要求扩充已完成业务的客观评测系统，由 Kimi 负责前端，Codex 负责后端与评测集；本轮不评自然语言回答质量，不使用 LLM judge，不优化生产业务逻辑。

协作使用本机 `kimi` CLI：以 `--model kimi-code/k3 --prompt` 启动，后续用 `--session <已有会话ID>` 继续同一任务。K3 的模型配置设为 `default_effort = "max"`，实际请求日志应为 `model=k3`、`thinkingEffort=max`。本机 CLI 2.1.1 的 `--prompt` 不能与 `--auto` 或 `--yolo` 合用；通过进程输出取得进度，不再操作桌面 Kimi 窗口。模型/登录配置和会话日志留在本机，不加入仓库。

2026-10-05 v2 首批完成后的前端调整：保持现有灰绿风格和无框架实现，将核心结果、耗时/Tokens及场景列表前移；批次、覆盖和技术口径默认折叠，读取错误/无效口径/配置不一致仍显式可见。依据新 `attribution`/`spans` 展示执行分工，正确区分商家事件、宿主确认与 Agent 回复；归因与旧 steps/usage 不重复相加。详见 API 文档的 v2 增量合同。百炼 M0–M6 仍为离线报告，未接 API，不在页面写死实验数字。

非交互 shell 未必包含 Kimi 的 PATH，本机可直接调用 `/Users/zdl/.kimi-code/bin/kimi`。本轮使用 K3 且确认其 `default_effort=max`；不修改用户默认模型。前端文件由 Kimi 修改，Codex 补接口文档并检查实际页面、窄屏及交互。

本轮验收：`npm run validate` 通过，含 15 组前端回归（新增 v2 标签/归因、无效 span 诊断、atomic 商家事件有模型步骤但回执由宿主生成）。Chrome 1440px 与 390px 检查通过，覆盖版本对比、键盘展开、逐轮执行分工及窄屏标题换行；核心指标从约 989px 前移至 325px，场景列表从约 1222px 前移至 558px（同一默认运行、1440px 视口的页面坐标）。没有新增运行时依赖或重跑付费评测。本机截图与检查日志保存在忽略的 `.runtime/` 中。

请阅读 `docs/evaluation-api.md` 的完整合同及 `plan.md` 第 8.1 节。继续维护现有明亮柔和、简洁的工作台。旧 GET 运行列表与详情兼容；新 GET 提供单运行 analysis、两次 compare 与 batches 稳定性，HTTP 保持只读。

前端交付：

1. 显示客观/历史口径及“回答效果：本轮不评测”；客观分母与分类来自 analysis，不能拿历史措辞断言当客观分数。
2. 展示按标签的覆盖及失败定位；failed、skipped、missing 分开，计划数不从已完成案例倒推。
3. 当 run 含 batch 时展示重复运行稳定性；缺轮、配置变化或未知条件不能展示稳定满分。
4. 版本比较使用后端 comparable/repeatCompatible 与条件差异；跨题集时不展示通过率或耗时的优劣改善结论。
5. usage 的 known/complete 和覆盖率分开；null 不补零、无模型请求属不适用。首屏成本仍以 Tokens 为主，其余明细收起。
6. 检索运行显示 retrieval 的全量/选集、常规/难题 Recall/MRR；无答案非空只作召回诊断，不是幻觉率。工程/model 不合成一个总分。
7. 保留失败轨迹、历史运行、运行切换/A-B切换的竞态保护；检查宽窄屏与大量检索案例（约290）。

仅修改 `web/evaluation/`，如需配套验证可以修改 `scripts/eval-ui-check.ts`。不要改 `src/`、其他 `scripts/`、`data/`、`db/`、文档、计划、业务提示词、`package*.json` 或 `.idea/`。先用合成响应做前端测试；不要运行真实模型、数据库写入测试或 QQ 发信。真实新运行由 Codex 提供。

不要自行提交或推送；代码留在工作区，由 Codex 联调、验收并统一提交。完成后报告修改文件、已测状态以及缺失的 API 信息。合同新增字段以 `docs/evaluation-api.md` 最新内容为准。
