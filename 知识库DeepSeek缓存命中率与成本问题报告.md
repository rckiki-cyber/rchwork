# legalwork 法律知识库 DeepSeek 缓存命中率与成本问题报告

> 调研日期：2026-08-07
> 适用范围：legalwork 本地知识库（法律场景）+ DeepSeek API 模型调用
> 状态：调研报告（未改代码，未实施方案）

---

## 目录

1. [背景](#1-背景)
2. [legalwork 法律场景定位](#2-legalwork-法律场景定位)
3. [DeepSeek 上下文缓存机制](#3-deepseek-上下文缓存机制)
4. [legalwork 知识库当前架构](#4-legalwork-知识库当前架构)
5. [成本模型与实测数据](#5-成本模型与实测数据)
6. [可能的所有原因分析](#6-可能的所有原因分析)
7. [可能的所有解决办法](#7-可能的所有解决办法)
8. [可参考的开源项目与链接](#8-可参考的开源项目与链接)
9. [结论与建议](#9-结论与建议)

---

## 1. 背景

### 1.1 问题现象

用户反馈：legalwork 的本地知识库存放了上万件文件后，执行涉及知识库的任务时成本极高，**几句对话就要 4 元人民币**。同时 DeepSeek 缓存命中率低（实测 55% 左右），用户怀疑是软件架构问题而非单纯模型定价问题。

### 1.2 问题本质

成本高的直接原因是：**每次模型请求中有大量 token 无法命中 DeepSeek 的上下文缓存（Context Caching on Disk），按全价计费**。而缓存命中率低，根源在于 **RAG（检索增强生成）的"每次动态检索注入"与 DeepSeek"前缀完全匹配"缓存机制之间存在根本性冲突**。

---

## 2. legalwork 法律场景定位

### 2.1 产品定位

legalwork 是**面向法律工作者的垂直 AI 助手**，不是通用编码 agent。其系统提示（`legalwork-system-prompt.ts`）明确：

> "You are first and foremost a legal-work assistant: help with legal documents, case analysis, contract review, evidence organization, litigation preparation, compliance checks, and other legal professional tasks."

### 2.2 知识库内容特征（文本文件为主）

法律知识库的文档构成与其他场景（代码、通用办公）有本质区别：

| 特征 | 说明 |
|---|---|
| **文档类型** | 以**文本文件**为主：`.md`、`.txt`、`.docx`、`.pdf`（含扫描件）、`.pptx`、`.xls` |
| **典型内容** | 法条/法规/司法解释、裁判文书/案例、合同模板、起诉状/答辩状模板、法律意见书、实务操作手册、学术文献、类案检索结果 |
| **长文档占比高** | 裁判文书动辄几千到几万字、法规汇编、合同模板，`text-extractor` 提取后 chunk 数量大 |
| **引用性强** | 法条编号（第X条）、案号（(2023)京XX民初XX号）、案例名，检索高度依赖精确短语匹配 |
| **高频重复** | 同一法条（如劳动合同法第47条）、同一案由（如"劳动争议"）会被**反复检索引用** |
| **效力状态敏感** | 法条修订/失效、司法解释更新，需要核验时效性 |

### 2.3 任务特征（文字/文件工作为主）

| 任务类型 | 涉及工具 | 知识库参与度 |
|---|---|---|
| **法律文书起草**（起诉状/答辩状/合同）| `knowledge_auto_retrieve` + `knowledge_read_file` + 模板 | **高**：先检索模板和法条，再起草 |
| **类案检索分析** | `knowledge_search` + 外部法律源 | **高**：检索大量案例 |
| **法规检索核验** | `knowledge_search` + 北大法宝 MCP | 高 |
| **合同审查** | `knowledge_read_file` + 检索 | 高 |
| **证据整理** | 文件操作 + OCR | 中 |
| **案例分析** | 检索 + 引用核验 | 高 |

**关键特征**：法律任务是**文字密集型**——输出都是长文档（起诉状、意见书），且过程高度依赖**反复检索知识库**。这与编码任务不同（编码是代码+文件改动，法律是文字+文件读写）。

### 2.4 对缓存优化的影响

法律场景的这些特征决定了缓存优化策略的方向：

1. **文本为主** → 检索结果、文档内容是**纯文本**，注入体积可用字符数精确控制，不像图片/代码有大量 base64 或结构噪声
2. **重复性极高** → 同一法条/案由反复检索引用，**语义缓存和内容寻址缓存收益巨大**（比通用场景高得多）
3. **长文档多** → 需要精细的分页读取（`knowledge_read_file` 已有 200 行/页）和检索结果截断
4. **引用核验** → 检索结果要带准确引用（GB/T 7714），这要求检索**确定性**（同一查询返回同样排序），恰好也是缓存友好的前提
5. **文字输出长** → 最终文书是长文本，作为 assistant_text 写入历史，后续请求重发（需控制）

---

## 3. DeepSeek 上下文缓存机制

### 3.1 工作原理（官方文档确认）

DeepSeek 提供**磁盘上下文缓存**（Context Caching on Disk），官方文档关键点：

- 对所有用户**默认启用**，无需修改代码
- 每次请求会构建缓存；后续请求若与之前的请求存在**前缀重叠（prefix overlap）**，重叠部分直接从缓存读取，按便宜的"缓存命中"费率计费
- **命中前提**：请求前缀必须**逐字节完全匹配**某个已持久化的"缓存前缀单元"；仅部分重叠**不算命中**
- 缓存前缀单元在以下三处持久化：
  1. **请求边界**：每个请求在"用户输入结束位置"和"模型输出结束位置"各产生两个缓存前缀单元
  2. **公共前缀检测**：检测到多个请求的公共前缀时，持久化为独立单元
  3. **固定 token 间隔**：长输入/输出按固定间隔切分，防止长前缀永远达不到结束位置
- 缓存系统是 **best-effort**（尽力而为），**不保证 100% 命中率**
- 缓存不再使用时自动清除（几小时到几天内）
- 缓存只匹配**输入前缀**，输出仍正常计算（受 temperature 影响，有随机性）

### 3.2 官方提高命中率的建议

- **多轮对话**：完整复用前次的 messages（system + user + assistant + user），第二次请求即可命中
- **长文本 Q&A**：保持 system 提示和长文本内容不变，只改变末尾的具体问题

### 3.3 计费（官方价格页）

| 模型 | 缓存命中（1M 输入） | 缓存未命中（1M 输入） | 输出（1M） |
|---|---|---|---|
| deepseek-v4-flash | $0.0028 | $0.14 | $0.28 |
| deepseek-v4-pro | $0.003625 | $0.435 | $0.87 |

**缓存命中 vs 未命中差价：flash 50 倍，pro 120 倍。** 这意味着缓存命中率从 50% 提到 90%，输入成本可降低约 4-5 倍。

**法律场景意义**：法律任务是输入密集型（反复检索+长文档注入+长历史），输出相对较少，所以**命中率对成本的影响比通用场景更显著**。

---

## 4. legalwork 知识库当前架构

### 4.1 存储层

- **落盘位置**：`~/.legalwork/legalwork/knowledge/`（managed root）+ 用户工作区下的 `knowledge-base/`、`knowledge/`、`docs/` 目录（`defaultKnowledgeSourceRoots` 扫描工作区及上级目录，支持 `LEGALWORK_KNOWLEDGE_ROOTS` 环境变量）
- **纯文件系统 + 索引**：没有数据库，文件原样存盘，同步时构建 `index.json`（含 documents / chunks / edges / skippedCount / syncedAt）
- 文本类（.md/.txt/.json/.html/.csv 等）直接读；二进制文档（pdf/docx/pptx/xls 等）用 `text-extractor`（PyMuPDF/python-docx）提取纯文本
- 文档按 **2400 字符/块、240 字符重叠**切 chunk 存进索引
- 每文件可带 `.meta.json` 侧车元数据（source/author/category/tags/confidence/expiresAt/deprecated）

### 4.2 检索层（无向量数据库）

`knowledge_search` 用**启发式打分**，非语义搜索：

- 短语精确匹配（+12）—— **对法律引用（"第47条"、"劳动争议"）很有效**
- 中文分词后的词项命中（2.4/1.2 分/次）
- 词项覆盖率（最高 +12）
- 标题/路径/分类/关键词命中（+3~5）
- **词频余弦相似度**（+18）
- 邻近匹配 + 目标层匹配加成
- 排序**确定性**（`score 降序 || relativePath.localeCompare`），rerank 用 MMR（最大边际相关）做多样性去重

**法律场景评价**：短语匹配 + 确定性排序对法律检索（法条编号、案号、专有名词）是合适的——不需要语义向量库也能精确命中。且确定性排序天然是缓存友好的（同一查询 → 同一结果）。

### 4.3 注入链路（成本关键）

```
用户提问
  → knowledge_auto_retrieve 实时检索（关键词+余弦打分，确定性排序）
  → 返回 contextText（≤8K chars）+ sources（截断到 500 chars/条，最多 8 条）
  → 作为 tool_result 追加进对话历史
  → 模型下一次请求把整个历史（含这些 tool_result）发给 DeepSeek
```

- 检索结果作为 `contextInstructions` 注入**历史尾部**（`collectMessages` 中排在 history 之后）——这一点已经符合"变化内容放尾部"的缓存友好原则
- 但每次调用 `knowledge_auto_retrieve` 都是**实时检索**，tool_result **内容每次不同**

### 4.4 Agent 集成

暴露给模型的 4 个工具：

- `knowledge_search` — 检索（可带 layer/query）
- `knowledge_read_file` — 分页读文件（每页限 200 行控成本）—— **法律长文档分页读取的关键**
- `knowledge_sync` — 触发同步
- `knowledge_auto_retrieve` — 自动检索管道（注入 contextText + sources）
- `knowledge_legal_external_sources` — 外部法律源检索（北大法宝/元典/IMA 等）

### 4.5 检索管道（`KnowledgeRetrievalPipeline`）

1. 金字塔路由（L1-L5 分层）定目标层 → 2. 本地知识库搜索 → 3. 过期/弃用过滤 → 4. 元数据 + 引用（GB/T 7714）增强 → 5. 汇总进上下文（≤8K chars）

### 4.6 会话历史管理（缓存友好现状）

- **历史窗口改追加式**：`limitHistoryPreservingCompaction` 从"滑动裁剪最近 240 条"改为"从最近 compaction 摘要开始保留全部"，前缀稳定
- **compaction 增加消息条数触发**：历史 >240 条折叠早期为摘要
- **compaction 确定性**：默认用确定性启发式摘要（`buildCompactionSummary`，字节稳定）；`summaryMode: 'model'` 时用 temperature=0
- **read 工具同 turn 去重**：同 turn 内重复 read 同 path 返回 dedup 指针
- **动态指令放尾部**：goal 预算、todo、记忆、skill 提示等易变内容放 history 之后（`contextInstructions`），避免污染前缀

---

## 5. 成本模型与实测数据

### 5.1 实测场景

用今天（2026-08-06）的真实任务「去整理今年新修订、新出台法律法规的主要内容，我要考公用…」在旧代码上跑，命中率 55%，miss 861 万 tokens。

### 5.2 逐层分析（今天任务 thr_jz1lqe5r）

| 指标 | 数值 |
|---|---|
| 模型请求次数 | 132 次 |
| 累计 prompt tokens | 1913 万 |
| 缓存 miss | **861 万**（命中率 55%） |
| 历史消息 | 664 条，工具调用 284 次 |
| 历史压缩（compaction） | 0 次（旧代码） |

历史 token 构成（22.8 万）：
- tool_result 16.6 万（73%）
- tool_call 3.9 万
- assistant_reasoning 2.1 万
- assistant_text 0.16 万

其中最大单条：`read` 图片结果 2.7 万 tokens × 2（base64），`thread_read` 1 万 tokens。

### 5.3 缓存命中率对比（优化前后实测）

| 运行 | 命中率 | miss | 累计 prompt |
|---|---|---|---|
| 旧代码（滑动窗口） | 55% | 861 万 | 1913 万 |
| 新代码第 1 次 | 89.3% | 30.7 万 | 287 万 |
| 新代码第 2 次 | 90.9% | 16 万 | 175 万 |

优化后 miss 降低约 96-98%，命中率提升约 34-36 个百分点。

### 5.4 成本估算

以 flash 模型、命中 $0.0028/1M、未命中 $0.14/1M 计：
- 861 万 miss × $0.14 = **$1.21**（约 8.6 元）一次任务
- 优化后 16 万 miss × $0.14 + 命中部分 ≈ **$0.05**（约 0.36 元）
- 成本降低约 **24 倍**

### 5.5 法律场景的放大效应

法律任务比通用任务成本更高的原因（基于实测任务推断）：
1. **检索调用密集**：起草一份起诉状可能调用 5-10 次 `knowledge_auto_retrieve` / `knowledge_search`，每次注入 2-8K tokens
2. **长文档反复读取**：裁判文书、合同全文，`knowledge_read_file` 分页读取，多页都进历史
3. **长输出**：最终文书是长 assistant_text，写入历史后后续请求重发
4. **多轮迭代**：起草 → 审阅 → 修改 → 核验，每轮都重新注入检索结果

---

## 6. 可能的所有原因分析

### 6.1 架构范式层面（最根本）

**RAG 动态检索 vs 前缀缓存冲突**：
- DeepSeek 缓存要求请求前缀**逐字节完全一致**
- RAG 每次查询**动态检索不同 chunk** 注入 → 前缀每次变化 → miss
- 这是架构层面的固有矛盾，非调优能根治
- **法律场景加剧**：法律任务检索调用次数多、每次注入量大，冲突更明显

### 6.2 前缀稳定性层面

| 原因 | 说明 | 现状 |
|---|---|---|
| 滑动窗口裁剪 | 每步裁掉最前消息，前缀滑动 → 击穿缓存 | **已修复**（改追加式）|
| 动态指令注入前缀 | goal/todo/记忆在 prompt 前部，每次变化 | 已放尾部，合规 |
| system prompt 变化 | 版本迭代导致前缀变化 | 常量，稳定 |
| 工具定义变化 | 工具列表/顺序变化 | 已排序+规范化，跨会话稳定（实测 4 会话指纹一致）|

### 6.3 检索结果注入层面（法律知识库成本核心）

| 原因 | 说明 |
|---|---|
| **检索结果每次不同** | `knowledge_auto_retrieve` 实时检索，tool_result 内容每次变 → 每次新增量大。法律检索调用密集，放大此问题 |
| **大 tool_result 全量重发** | 图片 base64（2.7 万 tokens）、大文件、检索原文全量进历史，后续每次请求重发 |
| **重复检索** | 模型可能对同一 query 多次调用（虽有 read 去重，但 knowledge 检索去重仅覆盖 3 个工具）|
| **无跨会话复用** | 相同 query 的检索结果不缓存，跨会话不共享。法律场景同一法条/案由跨会话反复查，浪费大 |
| **长文档分页读取累积** | `knowledge_read_file` 分页读，多页全进历史，后续重发 |

### 6.4 会话历史管理层面

| 原因 | 说明 | 现状 |
|---|---|---|
| 历史无限膨胀 | 长任务消息数超过阈值不压缩 | 已修复（条数触发 compaction）|
| compaction 非跨会话复用 | 每次压缩重新生成摘要，无哈希缓存 | 待改进 |
| 历史窗口裁剪破坏配对 | 裁剪导致 tool_call/tool_result 配对断裂（400 错误）| 已修复（追加式）|
| **长输出写回历史** | 法律文书长 assistant_text 写回，后续重发 | 待控制 |

### 6.5 模型配置层面

| 原因 | 说明 |
|---|---|
| reasoningEffort 默认 max | `deepseek-v4-flash` 默认 max，思考内容进入请求（实测证明不破坏前缀，但增大体积）|
| 大上下文窗口 | 1M token 窗口，工具密集任务单请求可达 14.5 万 tokens |

### 6.6 可观测性层面

- 前端 `SessionHeader` 已显示**当前会话命中率**百分比 + hover 显示 hit/miss token 数
- `InitialSessionUsageHeatmap` 有按时间/会话的用量热力图（含 cache hit）
- **已有基础可观测性**，但缺"前缀变化检测"（无法定位哪个环节破坏了前缀）

### 6.7 缓存机制固有特性（不可消除）

- DeepSeek 缓存 **best-effort**，不保证 100%
- 缓存整体失效（evict/超时）——实测出现 2 次 6-7 万 tokens 的突然整体失效
- 首次请求必须建缓存（全 miss）
- 新增内容（新 tool_result、新指令）必然 miss

---

## 7. 可能的所有解决办法

### 7.0 法律场景的优化方向总览

法律任务的"高重复性 + 文本密集 + 长文档"特征，决定了以下方向收益最高：

1. **利用高重复性** → 语义缓存 / 内容寻址缓存（同一法条、案由反复查）
2. **利用纯文本特征** → 精确控制注入体积（文本可精确截断/摘要）
3. **利用确定性检索** → 让检索结果字节级可复用
4. **高频核心材料** → 稳定前缀预填充（常用法条、模板）

### 7.1 检索结果内容寻址缓存（P0，法律场景最大收益）

**问题**：同一法条/案由反复检索，注入内容每次不同 → 反复 miss。

**方案**：给 `knowledge_auto_retrieve` / `knowledge_search` 的检索结果做**内容寻址缓存**：
- 对归一化后的 query 计算 **SHA-256 哈希**作为 key
- 相同 query → 返回**字节级一致的缓存结果**（不重新检索）
- 命中时注入的 tool_result 字节一致 → 模型第二次请求该内容可命中 DeepSeek 缓存
- 缓存需在知识库文件变化时失效（关联 `index.json` 的 syncedAt 或文档 hash）

**法律场景收益**：同一法条（"劳动合同法第47条"）、同一案由（"劳动争议赔偿标准"）在**同一任务/跨任务**中被反复检索，内容寻址缓存让这些检索结果复用 → 命中率大幅提升。

**借鉴**：pi-deepseek-cache 的 SHA-256 摘要缓存 + CAG 的内容复用。

### 7.2 语义缓存层（P1，法律重复咨询成本归零）

法律场景的"同类型问题反复咨询"特征使语义缓存收益极高：
- 用户在法律 agent 上常问相似问题（"辞退赔偿怎么算"、"工伤认定标准"）
- **方案**：在模型调用前加语义缓存，embedding 判断 query 相似 → 相同/相似问题**直接返回缓存答案**
- 成本归零（不调模型）
- 可选：本地 embedding（如 bge-small-zh）+ 向量存储（Qdrant/faiss），或先用关键词哈希做精确匹配

### 7.3 稳定前缀预填充（P1，高频核心材料）

法律场景有天然的"高频核心材料"：
- 常用法条（劳动法、合同法、刑法常考条目）
- 常用合同模板、文书模板
- 高频引用的司法解释

**方案**：
- 统计被反复检索的文档（LRU）
- 构建"核心法律前缀"（≤几千 tokens），作为**固定 system 前缀**
- 所有查询共享此前缀 → 命中
- 前缀随使用频率动态更新

**借鉴**：CAG 的"固定前缀 + 只变尾部"，但扩展到高频子集而非单文档。

### 7.4 确定性摘要与压缩缓存（P1，借鉴 pi-deepseek-cache P3）

- legalwork compaction 已是确定性启发式摘要（字节稳定）
- **改进**：对摘要结果做 **SHA-256 哈希缓存**，跨会话复用（相同历史 → 相同摘要，不重新生成）
- 检索结果注入前做**确定性摘要**（而非原文），减少每次注入量
- **法律场景**：长裁判文书、法规汇编的检索结果，用摘要代替全文注入，大幅减少体积

### 7.5 注入体积控制强化（已有 + 强化）

法律场景的长文档 + 长输出特征需要精细控制：

| 控制点 | 现状 | 强化建议 |
|---|---|---|
| 检索结果截断 | sources 截断到 500 chars/条、8 条 | 保持 + 检索结果做摘要 |
| 长文档分页 | `knowledge_read_file` 200 行/页 | 保持，可加"只读需要的章节"提示 |
| 图片/大文件 | read 图片塞 base64 | 走附件通道或 OCR/文本替代 |
| 长输出 | assistant_text 全量写回历史 | compaction 更快折叠早期长文书 |

### 7.6 前缀诊断与遥测（借鉴 pi-deepseek-cache P2）

- 前端已有命中率显示，可增加**前缀变化检测**：对每次请求的前缀（除尾部新增外）计算 SHA-256，检测"被修改而非追加"→ 定位缓存破坏点
- 暴露到日志/诊断面板，帮助发现哪个工具/环节破坏了前缀
- **法律场景意义**：法律任务工具链复杂（检索+读文件+写文书），前缀被哪个环节破坏难定位，诊断工具价值高

### 7.7 法律检索确定性强化

法律检索依赖精确短语匹配，强化确定性：
- 对检索结果注入**固定顺序**（已确定性排序，保持）
- 对 `knowledge_read_file` 的分页结果加**页码锚定**，确保分页稳定
- 检索结果的**引用核验**（GB/T 7714）需确定性（已具备）

### 7.8 组合架构（最终形态）

```
┌─────────────────────────────────────────────┐
│  语义缓存层（重复法律咨询直接返回，成本归零）   │
│  ┌─────────────────────────────────────────┐ │
│  │  稳定前缀层（高频法条/模板预填充）         │ │
│  │  ┌─────────────────────────────────────┐ │
│  │  │  会话层（追加式历史 + 确定性压缩）      │ │
│  │  │  ┌─────────────────────────────────┐ │ │
│  │  │  │  检索层（内容寻址缓存 + 确定性注入）│ │ │
│  │  │  └─────────────────────────────────┘ │ │
│  │  └─────────────────────────────────────┘ │
│  └─────────────────────────────────────────┘
└─────────────────────────────────────────────┘
```

---

## 8. 可参考的开源项目与链接

### 8.1 直接相关（DeepSeek 缓存优化）

| 项目 | 链接 | 说明 |
|---|---|---|
| **pi-deepseek-cache** | https://github.com/ruanbw/pi-deepseek-cache | DeepSeek 前缀缓存扩展：前缀守卫、确定性摘要（SHA-256 缓存）、命中率遥测。**最贴合 legalwork 需求** |
| pi-deepseek-cache (fork) | https://github.com/rohaquinlop/pi-deepseek-cache | 声称多轮会话降本 95%+ |
| **DeepSeek-Reasonix** | https://github.com/esengine/DeepSeek-Reasonix | 99%+ 缓存命中架构，工具调用修复 + 前缀守卫 |
| Reasonix | https://github.com/shengcanxu/Reasonix | DeepSeek-Reasonix 的另一份 |
| CodeWhale issue #2264 | https://github.com/Hmbown/CodeWhale/issues/2264 | 引用 DeepSeek-Reasonix 99%+ 架构的 feature request |

### 8.2 Cache-Augmented Generation（CAG）

| 项目 | 链接 | 说明 |
|---|---|---|
| **pi-cache-augmented-generation** | https://github.com/Pleias/pi-cache-augmented-generation | CAG：文档作为固定前缀预填充一次，跨问题复用 KV cache。省 prefill 20-76×。单文档场景（≤12k tokens）|

### 8.3 语义缓存类（成本归零）

| 项目 | 链接 | 说明 |
|---|---|---|
| **RAG-Cache** | https://github.com/zakariaf/RAG-Cache | Redis+Qdrant 语义缓存，降本 80%、延迟 8.5s→1ms |
| **tessera** | https://github.com/hectar-glitches/tessera | 语义缓存 RAG，跨权限隔离 |
| **llm-cache** | https://github.com/reaatech/llm-cache | 精确+embedding 相似度双缓存，模型版本感知失效 |
| node-llm-cache | https://github.com/mdmax007/node-llm-cache | Node 生态，压缩+语义检索+agent memory |
| semantic-prompt-cache | https://github.com/renswickd/semantic-prompt-cache | 语义缓存最小化延迟与成本 |
| semantic-cache-example | https://github.com/HarperFast/semantic-cache-example | 语义缓存示例 |

### 8.4 法律 RAG / 文档知识库相关

| 项目 | 链接 | 说明 |
|---|---|---|
| llm-rag-app | https://github.com/arunkatika/llm-rag-app | 通用 RAG 应用参考 |
| context-swarm-memory | https://github.com/muhamadjawdatsalemalakoum/context-swarm-memory | 长上下文记忆（1M tokens），零 LLM 索引，适合长文档 |

### 8.5 相关参考文档/论文

| 项目 | 链接 | 说明 |
|---|---|---|
| **DeepSeek 官方缓存文档** | https://api-docs.deepseek.com/guides/kv_cache | 官方权威，缓存机制 |
| **DeepSeek 计费** | https://api-docs.deepseek.com/quick_start/pricing | 缓存命中/未命中价格 |
| DeepSeek RAG 缓存优化 | https://deepseek.csdn.net/6a1ea955662f9a54cb79044a.html | 重叠切片+高频访问，DS RAG 缓存直接参考 |
| DeepSeek Context Caching Guide | https://coldfusion-example.blogspot.com/2026/02/deepseek-context-caching-guide.html?m=1 | 前缀结构化指南，90% 降本 |
| APE 论文 | https://mlanthology.org/iclr/2025/yang2025iclr-ape/ | Adaptive Parallel Encoding，长上下文加速 |
| ContextCache 论文 | https://zenodo.org/records/18795189 | 内容哈希寻址的工具 schema 缓存 |

---

## 9. 结论与建议

### 9.1 核心结论

1. **成本高 = 缓存命中率低 × 大量输入 token**。命中率低的主因是 RAG 动态检索注入与 DeepSeek 前缀缓存机制的根本冲突。
2. **法律场景加剧成本**：法律任务检索调用密集、长文档多、长输出、重复性高，输入量远大于通用场景，命中率对成本的影响更显著。
3. 已实施的追加式历史 + compaction 条数触发 + read 去重，将命中率从 55% 提到 89-91%，miss 降 96-98%，成本降约 24 倍（实测）。
4. 法律场景的**高重复性**是最大机会：同一法条/案由反复检索引用，**内容寻址缓存 + 语义缓存**收益远大于通用场景。
5. DeepSeek 缓存 best-effort + 首次建缓存 + 新增内容必然 miss，决定了命中率存在约 90% 附近的天花板。

### 9.2 建议优先级（法律场景加权）

| 优先级 | 方案 | 法律场景收益 | 复杂度 |
|---|---|---|---|
| P0 | **检索结果内容寻址缓存** | 同类法条/案由反复检索复用 | 中 |
| P1 | **语义缓存层** | 重复法律咨询成本归零 | 中 |
| P1 | **稳定前缀预填充**（高频法条/模板） | 常用法条/模板命中 | 高 |
| P1 | **compaction 摘要哈希缓存**（跨会话） | 长任务压缩更便宜 | 低 |
| P2 | 检索结果确定性摘要 | 减少长文档注入体积 | 中 |
| P2 | 前缀变化诊断 | 定位缓存破坏点 | 低 |

### 9.3 已实施（本次会话）

- `agent-loop.ts`：turn 错误透传真实 message
- `context-compactor.ts`：compaction 增加消息条数触发（>240 折叠）
- `deepseek-compat-model-client.ts`：历史窗口改追加式（前缀稳定）
- `agent-loop.ts`：read 工具同 turn 去重
- `register-app-ipc-handlers.ts`：Python 下载完整性校验 + 解压重试
- 设置界面：chatgpt 模式隐藏模型归属选项 + 渲染额度区块

---

*本报告基于 legalwork 源码分析、DeepSeek 官方文档、以及多个开源项目的源码级研究（pi-deepseek-cache、pi-cache-augmented-generation 已完整阅读源码）。所有链接均为公开可访问资源。*
