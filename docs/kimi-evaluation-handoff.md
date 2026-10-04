# Kimi 前端协作：客观评测

用户已要求扩充已完成业务的客观评测系统，由 Kimi 负责前端，Codex 负责后端与评测集；本轮不评自然语言回答质量，不使用 LLM judge，不优化生产业务逻辑。

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
