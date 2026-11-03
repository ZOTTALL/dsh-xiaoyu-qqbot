# 本地记忆与认知星海

## 数据流

原始工作区 Markdown → 限量、脱敏扫描 → 稳定片段 ID / 来源 / 行号 → SQLite WAL + 中文 FTS5 / 向量 → BM25 与余弦召回 → RRF → 至多 20 个候选的 CPU BGE 重排 → 去重、证据与字符预算。

原文是真源，不自动覆盖。查询前同步删除与更新；后台约 15 秒合并扫描。模型清单指纹变化会重建派生索引。默认仅 owner；日期 / 类别先限制候选，再执行排序。worker 禁止网络连接；图谱不因模型安装失败而消失，降级会明确返回 semantic=false / degraded。

## 环境

总览或记忆空间点击部署本地向量环境，或执行：

```powershell
.\tools\setup-memory.ps1 -Root C:\QQBotData -Workspace C:\QQBotData\workspace
```

需要 uv。脚本建立独立 Python 3.11、安装固定版本 ONNX Runtime / tokenizers / numpy，并下载固定 revision / SHA256 的公开模型。嵌入 BGE small 中文 int8 权重约 24MB，重排 base int8 权重约 279MB，加上 tokenizer 约 320MB；模型权重和 venv 不在发布包里。CPU 两线程；重排首次查询惰性加载，显存不使用。整体内存受候选长度和运行时影响，不能只按模型文件大小估计。

配置在 `<workspace>/data/memory-local.runtime.json`，派生 SQLite 在同目录 `memory-local/index.sqlite3`。这两个位置均为运行数据，不提交 Git。删除索引可从 Markdown 重建，但先停用组件让 worker 关闭；不要删除原文。

## 能力边界

- 图边仍是原文共现 / 引用，不是因果，也不是向量余弦自动推导的“神经元”。光点仅为装饰动效。
- 六个区域由 rules-v1 关键词规则分类，是一个库的不同导航视图，不是六套记忆存储。
- Reflect 入口为 `extractive-evidence-review`、generated=false：按日期 / 文件更新时间整理原文，不做生成式推理和自动冲突裁决。
- 没有完整复刻 Hindsight，也没有部署本地生成 LLM；本插件搜索不会自动替代 QQ 链路原有的记忆工具。
- 默认上限 3000 片段，当前为精确向量搜索。阈值是起始经验值，不是模型置信度，需要按自己的真实问题评估。
- 不把本地小样本验收当成 LoCoMo / LongMemEval 的成绩。

## 测试

`npm test` 运行无需下载模型的 Node 测试。真实模型测试另提供 QQBOT_MEMORY_PYTHON、QQBOT_MEMORY_MODEL、QQBOT_MEMORY_RERANKER，然后 `npm run test:semantic`。覆盖实际推理、同义召回、无关拒答、来源范围、更新删除、持久化、预算、缓存、并发和断网防护。

模型：[BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5)、[Xenova ONNX](https://huggingface.co/Xenova/bge-small-zh-v1.5)、[BAAI/bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base)、[Xenova ONNX](https://huggingface.co/Xenova/bge-reranker-base)。
