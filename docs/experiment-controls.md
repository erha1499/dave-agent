# 实验配置与调试

统一入口使用方案预设和参数白名单，不修改 `.env` 或运行中的 QQ。现有六项业务授权/确认约束始终生效。业务评测用隔离的模拟订单，检索仍是离线开发实验；M0–M6 不代表线上知识服务已切换。

## 配置

`src/experiment-config.ts` 是 CLI 与工作台共享的校验入口，格式 version 1：

```json
{
  "version": 1,
  "kind": "support",
  "label": "业务架构 A/B",
  "repeat": 1,
  "allowRemote": false,
  "variants": [
    { "id": "A", "architecture": "atomic", "parameters": {} },
    { "id": "B", "architecture": "controller", "parameters": {} }
  ]
}
```

每个实验含 1–2 个方案，每个方案重复 1–3 次，按 repetition → A/B 顺序串行执行。不同方案各有独立 batch。业务参数为 `timeoutMs`（10000–120000）、`repairBudget`（0–2，仅 Controller）、`merchantEvents`（architecture/host/model）。Controller 不支持 model 通知分支，配置时拒绝；atomic 可切 host 作通知消融。实际 QQ 配置不受实验影响。

检索方案改为 `kind: "retrieval"`，每个 variant 使用 `modes: ["M0", "M4"]` 替代 architecture。参数含 candidateTopK、bm25K1/bm25B、rrfK/rrfWindow、cache、timeoutMs、retries、maxRequests、consecutiveFailureLimit。默认及边界由共享校验器提供。M4 始终使用可见范围内全部候选；Recall@5 / MRR@5 固定。cache=refresh 不读取或写入持久结果缓存，复用缓存的运行不能声称为独立模型重复或生产延迟。

模型固定为现有业务模型配置及百炼 text-embedding-v4 1024 维、qwen3-rerank。没有任意模型、API URL、系统提示词、命令、文件路径或环境变量表单。A1 阈值、长期记忆和模型改写暂未实现，不提供假开关。

CLI 默认仅预览，不调用模型或数据库：

```sh
node scripts/experiment.ts --list
node scripts/experiment.ts --preset support-ab --dry-run
node scripts/experiment.ts --config configs/experiments/retrieval-local.json --run
node --env-file-if-exists=.env scripts/experiment.ts --preset support-ab --run --allow-remote
```

配置文件可来自工作台下载或 `configs/experiments/` 示例。CLI 和网页执行共用目录锁及任务记录，执行中的配置不会随表单更改而改变。

## 工作台接口（本机）

- `GET /api/experiments/catalog` → `{presets:[{id,name,config}],fields:{support:[],retrieval:[]},modes:[{value,label}],limits,notes}`。field 含 key/label/type(number|select)/min/max/step/options/note。config 已填默认参数；allowRemote 默认 false。
- `GET /api/experiments` → `{jobs: ExperimentJob[]}`，最新 30 项。
- `GET /api/experiments/<uuid>` → `ExperimentJob`。
- `POST /api/experiments`，Content-Type application/json、`X-Experiment-Request: 1`，body 为配置本身 → 202 `ExperimentJob`。400 参数/组合/远程调用未允许，409 已有活动实验，503 启动不可用。错误响应 `{error:string}`。

```ts
type ExperimentJob = {
  id: string;
  status: "running" | "completed" | "completed_with_failures" | "failed" | "interrupted";
  createdAt: string; finishedAt: string | null;
  config: ExperimentConfig; configHash: string;
  plannedRuns: number;
  current: {variantId:string; repetition:number} | null;
  error: string | null;
  results: Array<{
    variantId: string; repetition: number;
    kind: "support" | "retrieval";
    status: string;
    runId: string;
    summary: unknown;
  }>;
};
```

support 的 runId 是现有 MySQL 评测记录，summary 为 `RunAnalysis`（counts/usage/timing/issues 等，合同见 evaluation-api.md），可在现有页面查看或对比。检索 runId 对应已有 `.runtime/retrieval-v2/<id>.json`，summary 是该报告的真实 summary（groups 按 mode/corpus/suite 分列，usage 按 operation 分列；含缺失、失败、缓存命中和部分用量），工作台只展示实验关联结果，不扫描导入历史离线报告。不能把 USD/CNY 合并或把各种语料和题集合成单一通过率。

HTTP 不接受命令或密钥；仅本机 Host/Origin，严格 JSON、请求体上限 32 KiB。任务执行状态和完整配置保存在忽略的 `.runtime/experiments/`。终止后不自动重跑；中断及未执行重复不能算通过。实验目录锁限制同一工作区同时一个实验；关闭工作台会等待当前实验完成，以便清理隔离订单。

正常进程退出自动释放锁，死进程的完整锁元数据可恢复；半写或损坏锁会保守拒绝启动。仅在确认没有实验进程运行后，手动检查并清理 `.runtime/experiments/active.json` 和 `active.lock/`；不要删除历史任务 JSON。没有提供运行中强制取消，以免中断模拟订单清理。

## 对比口径

执行前解析完整配置，执行时将同一参数传入 runner 并保存实际 settings。架构、通知模式、修复预算和检索参数差异可追溯；实验 ID 单独记录，不污染重复兼容哈希。原有共同业务条件与检查器资格门控继续生效。runner 源码变化可能导致新记录与旧历史不可比，应使用当前同版代码重跑基线/候选，不放宽 checker 来制造提升。

请求上限按每次检索运行计，不是整组实验的金额预算；重试也计请求。缓存复用可能显著减少请求，但不能据此假设某次调用免费或已取消远程授权要求。付费业务或 M2–M6 必须显式设置 allowRemote=true 才能启动。

## 本轮验收

2026-10-05，本地 CLI 运行 M0/M1 完成 580 项；工作台配置 A/B（BM25 b 为 0.75 / 0.25）分别完成 580 项，配置下载与载入后参数一致，远程请求均为 0。这里只证明配置与执行、展示的闭环，不声称调参提高了泛化效果。本轮未重新调用付费业务模型或百炼服务，也未重验真实 QQ。

确定性检查覆盖参数实际改变排序/候选/缓存/修复预算，错误组合在凭据读取前拒绝，配置快照不可被表单修改，串行重复与失败缺项，跨进程死锁恢复的活锁保护，HTTP 同源/请求体/非法 URL 边界。前端检查覆盖懒加载、远程调用门控、任务状态竞态、连续参数编辑与统计口径；浏览器验证宽窄屏、JSON 下载、参数复现及本地 A/B。完整检查入口为 `npm run validate`。
