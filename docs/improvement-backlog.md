# legalwork 待完善清单（详细版）

> 整理日期：2026-08-08
> 来源：173 个历史对话 thread 深度分析 + 真实轨迹(traj) 数据 + 代码审查 + 用户反馈
> 说明：每个问题含完整背景、数据证据、根因、修法建议。按优先级排列。MCP 弃用由 ChatGPT 单独负责；北大法宝配额问题用户已明确不用管。

---

## P0 级（直接烧钱/卡死，最高优先）

---

### 1. 文档任务历史膨胀控制（成本杀手，实测单任务 ¥4.26）

**背景**
用户反馈：凡是涉及 Office 文档的任务（生成、改格式、编辑），都执行十几分钟、几十上百步、消耗 4-5 元 token，还经常解决不了。

**数据证据**（真实轨迹 `thr_ilh9r3d2`，改一个页边距）
- 4 个 turn、47 个模型响应步、48 次工具调用（38 次是 office MCP）
- 累计 token：**485 万**（usage 累计 promptTokens 4,850,746）
- 成本：**¥4.26**
- 4 个 turn 状态：completed / **aborted（中断重来）** / completed / completed
- 单次请求 prompt token 曲线：
  - 步 1：42,993
  - 步 5：323,381（累计）→ 单次约 81,000
  - 步 10：732,697 → 单次约 82,000
  - 步 20：1,649,356 → 单次约 95,000
  - 步 47：4,724,345 → 单次约 127,000
- **单次请求从 4.3 万一路涨到 12.7 万 token**，每步都在变大

**根因**
1. `assistant_reasoning_delta`（reasoningEffort: max 的思维链）大量累积——4758 个 reasoning 事件
2. 每次请求带完整 history，历史持续膨胀
3. 大 tool_result（office view html 返回几十 KB HTML）进 history 后每步重发（此项已通过 MCP 截断修复）

**修法建议**
- `reasoningEffort: max` 是否必要？长文档任务降级到 medium/high，或限制 reasoning 写入 history
- history 里超长 assistant_text（法律文书长输出）写回后，后续请求重发——需要更激进的 compaction 策略
- **单次请求 token 上限兜底**：超过阈值（如 30 万）强制压缩历史，而不是无限涨
- 涉及：`agent-loop.ts`、`context-compactor.ts`、模型配置

---

### 2. 大 tool_result 统一截断（非 MCP 工具）

**背景**
MCP 工具输出已截断（8000 字符，见 `mcp-tool-provider.ts` 的 `truncateMcpTextOutput`），但其他工具的大输出没有统一处理。

**数据证据**
- `knowledge_read_file` 分页读长文档（裁判文书几万字）
- `bash` 命令输出（如 `cat` 大文件、`find` 递归结果）
- `search_skills` 返回 1.7MB 技能目录（见 P3-13）

**根因**
agent-loop 层对 tool_result 无统一大小上限，任何工具都能把大结果塞进 history。

**修法建议**
- 在 `agent-loop.ts` 统一对所有 tool_result 做大小上限（如保留头部 4000 + 尾部 1000 字符，中间省略标注）
- 对 `search_skills` / 目录类工具返回加硬阈值（>100KB 降级为计数摘要）

---

### 3. 长文档分页读取累积

**背景**
`knowledge_read_file` 分页读取长文档，每页结果都作为 tool_result 进 history。

**数据证据**
- 报告《知识库DeepSeek缓存命中率与成本问题报告.md》§6.3：长文档分页读取累积，多页全进历史，后续请求重发
- 法律场景裁判文书动辄几千到几万字，分页读 5-10 页很常见

**根因**
读过的文档内容没有压缩，重复全量进 history。

**修法建议**
- 读过的文档页自动压缩为摘要（保留关键信息 + 章节结构），不重复全量进 history
- 或同文档二次读取时返回"已在历史中，跳过"提示（类似已有的 read 去重但更彻底）

---

## P1 级（明显影响体验）

---

### 4. knowledge_auto_retrieve 结果截断

**背景**
法律调研/知识库检索时，`knowledge_auto_retrieve` 把检索结果全量注入 history。

**根因**
- 每次检索结果不同 → 缓存尾部变化，影响命中
- 检索结果多时注入量大

**修法建议**
- 限制单次检索注入 token（如 2000）
- 检索结果只保留 top-N 精要 + 引用，原文用文件引用替代

---

### 5. 错误上报质量（区分噪音）

**背景**
错误上报仓库（legalwork-reports）有大量"模型不会用工具"的噪音上报。

**数据证据**
- 125 条新上报里，officecli 误用 16 条、web_fetch 反爬失败 13 条、bash 用户环境问题 14 条
- 大量是模型误用，不是代码缺陷

**修法建议**
- 区分"代码缺陷"和"模型误用/外部配额"，后者降级不上报或低频上报
- 北大法宝 90001 配额错误用户已明确不用管——上报里应静默
- 模型误用类（officecli 语法错、web 404）聚合上报而非逐条刷屏

---

### 6. 对话文件面板

**已修**
- basename 去重（同文件不同路径只显示最新）
- 过滤过程性 json（batch_cmds.json、scratch、staging 等）

**待完善**
- 按时间倒序排列（最新产出在最前）
- 已显示文件的"Agent 产出"和"用户上传"标签区分

---

### 7. 桌面端打包体积

**现状**
- dmg 340MB、zip 340MB
- 含 officecli 二进制（`@officecli/officecli`，约 100MB+）+ 内嵌技能 + Python 运行时

**待完善**
- 弃用 office MCP 后可移除 officecli 二进制，省 100MB+
- Python 方案依赖内嵌后体积对比

---

## P2 级（打磨）

---

### 8. 缓存命中率进一步优化

**现状**
- 追加式历史 + read 去重后命中率 89-91%（从 55% 提升）
- 报告实测：miss 降 96-98%，成本降约 24 倍

**待完善**
- 检索结果放尾部（已做）
- 文档内容压缩后进历史（P0-3）
- reasoning 控制（P0-1）

---

### 9. no-project 工作区完整性

**已修**
- 只读预览允许 workspace 外绝对路径（`workspace-paths.ts` 的 `allowOutsideWorkspace`）

**待完善**
- 写操作是否放开？no-project 模式用户可能希望产出到桌面/指定目录
- 但要注意安全边界（写越界风险）

---

### 10. 进程崩溃监控

**数据证据**
- Windows 上报 render-process-gone / child-process-gone（0.3.12，如 issue #633/#634/#635）

**待完善**
- 崩溃时自动恢复/重启，而不是让用户手动重开

---

### 11. 学习线程（learning-iteration）超时

**已修**
- EPERM 写状态重试（atomicWriteFile）

**待完善**
- 学习线程失败率高（模型 turn 失败、超时），需更好降级策略
- 见 P3-12 的 plan 模式死循环

---

## P3 级（对话历史实证问题）

> 以下全部来自 173 个历史 thread 的深度分析，有真实数据证据。

---

### 12. 学习迭代 plan 模式死循环（烧钱，最严重）

**背景**
legalwork 有个"学习迭代"（learning iteration）功能，会自动跑子 agent 分析记忆/技能质量。173 个 thread 里有 16 个 `[Learning iteration]` 标题的会话，其中 2 个完全失败烧钱。

**数据证据**

| thread | 模式 | turns | 工具调用 | 消耗 token | 终态 |
|---|---|---|---|---|---|
| thr_zenknzj0 | **plan** | **59** | 63 | **4,188,032** | failed |
| thr_821ihthm | **plan** | **82** | 91 | **6,502,359** | aborted/running |
| thr_qdcgmxho | agent | 1 | 0 | 102,756 | ✅ 正常 |
| thr_5s7jhwmh | agent | 1 | 0 | 91,214 | ✅ 正常 |
| thr_23030d0d | agent | 1 | 0 | 98,689 | ✅ 正常 |
| thr_5ic67hmg | agent | 12 | 15 | 1,659,418 | ⚠️ 读文件被拒 |

**两个坏线程合计烧掉约 1068 万 token，各耗 3-10 分钟无效空转，最终失败。单个文件碎片就占 92MB。**

**根因 A：plan 模式死循环**
- 学习迭代驱动把子 agent 设成 `plan` 模式，强制要求 GUI turn 必须调用 `create_plan` 工具
- 但模型不理解：没产出 create_plan 而是重复 reasoning → 触发 `required_tool_missing` 错误
- 模型又疯狂尝试 create_plan（相同参数重复 3 次以上）→ 被 `tool_storm_suppressed` 拦截 → 继续空转
- 证据：`thr_zenknzj0` error "Model did not call the required 'create_plan' tool"；`thr_821ihthm` 63 次 create_plan，中途 token 超限触发 compaction，最后卡在 user_input_requested 无人应答 aborted

**根因 B：sandboxMode 只读 + approvalPolicy never 导致工具被拒**
- 所有线程 `sandboxMode: read-only`、`approvalPolicy: never`
- 模型想读 validation-policy.md、skill-stress-test-template.json 等失败，只能在 reasoning 里"手动分析"

**修法建议**
1. **禁用 plan 模式**：学习迭代是纯分析产出类任务，设 `mode: agent` 即可（14 个 agent 线程全部正常）
2. **放宽只读**：允许读取 learning-iterations/runs/* 内文件
3. **加失败熔断**：tool_storm 拦截计数超过 N 次或单线程超时 X 分钟，强制 kill 标记 failed
4. **降推理成本**：reasoningEffort high→medium

---

### 13. 法律调研来源路由失效 + 1.7MB 上下文灌爆（烧钱）

**背景**
法律调研任务，部分线程完全绕过内置的来源路由约束，落进 raw-curl/浏览器抓取黑洞。

**数据证据**（12 个调研线程）

| thread | 主题 | 总token | 成本 | turns | 工具 | bash/curl-gov | playwright |
|---|---|---|---|---|---|---|---|
| thr_wkkpcunu | 智能驾驶事故 | **5148K** | ¥0.284 | **45** | 50 | 37/15 | 0 |
| thr_8u2yw6vr | 行政协议免责 | **5247K** | ¥0.291 | **52** | **58** | 23/18 | **17** |
| thr_smujvukz | 跨国领养 | 2150K | ¥0.169 | 26 | 30 | 5 | 0 |
| thr_tmsugwoo | 醉驾标准 | 1447K | ¥0.140 | 16 | 24 | 0 | 0 |
| thr_0159v9rn | 非法利用信息网罪 | 302K | ¥0.100 | 5 | 8 | 0 | 0 |
| thr_76q1cld7 | 法律意见书 | 184K | ¥0.096 | 4 | 11 | 0 | 0 |

**正常基线**：thr_0159v9rn（302K/5 turns）、thr_76q1cld7（184K/4 turns）等，≤1000K token、≤11 turns 完成。**两个异常线程比正常基线高出 5-17 倍。**

**根因 1（thr_wkkpcunu）：丢弃指定的北大法宝主源，改 curl 国家库 + 1.7MB skill 目录灌爆上下文**
- 0 次调用 `mcp_pkulaw_*`，全程 37 次 bash（15 次 curl flk.npc.gov.cn）
- 启动时 `search_skills` 返回 **1,722,471 字节（1.7MB）** 技能目录整体写入上下文——这是 5.1M token 的第一大来源
- 最终报告自我声明"本次环境未配置北大法宝 MCP"

**根因 2（thr_8u2yw6vr）：对禁止来源反复重试 + 浏览器自动化绕行**
- 23 次 bash：18 次 curl court.gov.cn、5 次 curl flk.npc.gov.cn，反复试 GET/POST/Referer/charset
- 叠加 17 次 Playwright 浏览器调用
- **直接违反提示词明文约束**："国家法律法规数据库不是强制来源…不得为访问国家库调用用户浏览器…失败时最多换用一个已配置的非浏览器来源，不要反复重试"

**修法建议**
1. **来源路由做硬失败**：未配置北大法宝 → 用已配置备源（IMA/知识库）→ 仍不可用直接标注"不可核验"，禁止 raw-curl/浏览器抓 gov.cn
2. **bash 含 gov.cn/court.gov.cn 命令加权限拦截或审计告警**
3. **search_skills / 目录类返回加大小截断**（>100KB 降级摘要）
4. **限制单线程最大工具轮次**（>15 次强制收敛进报告）

---

### 14. 扫描件 PDF 放弃太早（体验）

**背景**
用户处理扫描件 PDF 时，agent 拿到空文本直接宣布"无法提取"，不探测已安装的 OCR 工具。

**数据证据**（`thr_32w6yzya`）
- 08:53 pdftotext 判决书成功
- 08:54 pdftotext 起诉状、协议 → 空结果（扫描件）
- 08:54:16 agent 下结论"两份PDF均为扫描件，无法直接提取文字"，开始起草
- 用户怒斥"扫描件你就不管了？你知道无法提取?"
- 08:55 才 which tesseract 确认 → **tesseract/ocrmypdf/pytesseract/pymupdf/pillow 一直可用**，随后成功 OCR

**根因**
拿到空文本后直接定性"无法提取"，从不主动探测已安装的 OCR 工具。

**修法建议**
- 检测到扫描件先检查本机 OCR 可用性再走 OCR，别先宣布失败
- 或在文档提取工具里内置"空结果 → 提示可能是扫描件 → 建议 OCR"的降级路径

---

### 15. PPT 大 batch 超时挂起（体验）

**背景**
PPT 生成任务，一次 batch 塞 17 页导致超时，线程永久卡死。

**数据证据**（`thr_zfsmer0n`）
- 唯一 turn 状态永远 running，events 里 0 个 turn_completed
- 16:28:03 发起包含全部 17 页的超大 batch
- 16:29:04 tool_call status failed（超时），agent reasoning 承认"命令太多，一次 batch 可能太长"
- 之后线程再无进展，挂起未交付
- 对照 thr_9uyp13be（干净环境）：~6 页/92 操作的小 batch，正常完成

**根因**
超大 batch 超时失败后 agent 未能可靠恢复收尾。

**修法建议**
- PPT skill/指令层面强制限制单批 page 数（如 ≤6 页）
- 超时失败后有兜底重试路径，不静默挂起

---

### 16. 文书写作不产出 .docx（功能缺陷）

**背景**
文书写作任务有时只输出文本占位符，不生成真实 .docx 文件。

**数据证据**（`thr_ys1bgu0h` 授权委托书）
- 全程只有 1 个 turn，completed
- **仅 2 次 mcp_ima_knowledge_base_research_ima 查法，0 次 officecli、0 次文件写入**
- 最终只输出一段 assistant_text，内容满是 `【待核实：请填写委托人公司全称】` 占位符
- 对比 thr_9mp2fu7g（答辩意见）：用 officecli 38 次真生成了 .docx
- 附加：该会话 reasoning 说"本次会话工具列表中没有北大法宝…我只有 IMA 工具可用"——**法律来源工具在各会话可用性不一致**

**根因**
a) 文书任务未强制走文档生成链路产出真实文件
b) 用户表单留空太多，agent 用占位符糊弄而非追问补全

**修法建议**
- 文书写作任务必须产出 .docx 落盘（或明确提示无法生成）
- 关键字段空缺（法定代表人/住所/信用代码/代理人）主动向用户确认，而不是塞占位符
- 统一各会话法律来源工具可用性

---

### 17. 调研结果 MD 渲染（已修但需验证）

**背景**
用户报"法律调研页面，调研结果怎么不渲染 md"。

**数据证据**（`thr_x4mb3cjq`，5 个子问题）
1. **不渲染 md**：根因是 LegalResearchPanel.tsx 用 `<div className="whitespace-pre-wrap">` 纯文本渲染 → 已换 AssistantMarkdown（Streamdown + remark-gfm）
2. **无导出 word 按钮**：缺功能 → 已新增 legal-research:export-word IPC 链路（shared 类型 + preload + main handler + html-to-docx），6 文件
3. **按钮太暗**：用了不存在的 --ds-accent-hover 变量 → 已改 hover:brightness-110
4. **调研过程不分行**：推理过程一整段无换行 → 已新增 splitSentences 按句号切分
5. **`\|\|` 乱码**：AI 用 `\|\|` 当表格分隔符 → 已新增 preprocessSummary 预清洗

**待验证**
- 这些修复是否已进当前打包版本（v0.3.15 相关）

---

### 18. 中断后汇报延迟（低优）

**数据证据**（`thr_r42mwmcu`）
- 用户中断 2 次（16:10、16:18），最后打"？"
- agent 才回复"抱歉，刚才最后一步还没向您汇报"
- Word/PPT 最终都成功交付

**修法建议**
- 中断后尽快主动汇报当前状态，别等用户追问

---

## 验证指标（改完要对比）

| 指标 | 当前（实测） | 目标 |
|---|---|---|
| 文档任务步骤 | 38 次 office 调用 / 47 步 | ≤5 步 |
| 单次请求 token | 8-12 万 | ≤2 万 |
| 文档任务成本 | ¥4.26 | ≤¥0.5 |
| 文档任务耗时 | 十几分钟 | ≤2 分钟 |
| 法律调研成本（异常线程） | 5148K token / ¥0.28 | ≤1000K / ≤¥0.1 |
| 学习线程成功率 | 14/16 正常（2 个烧钱失败） | 100% 正常 |
| 缓存命中率 | 89-91% | 保持或更高 |

## 涉及核心文件速查

| 文件 | 相关项 |
|---|---|
| `legalwork/src/loop/agent-loop.ts` | P0-1/2/3、P2-8 |
| `legalwork/src/loop/context-compactor.ts` | P0-1 |
| `legalwork/src/adapters/tool/mcp-tool-provider.ts` | P0-2（已修截断）|
| `legalwork/src/knowledge/knowledge-retrieval-pipeline.ts` | P1-4 |
| `src/main/services/workspace-paths.ts` | P2-9（已修预览）|
| `src/main/learning-iteration-runtime.ts` | P3-12 |
| `src/renderer/src/lib/conversation-files.ts` | P1-6（已修去重）|
| `src/renderer/src/components/legal-research/LegalResearchPanel.tsx` | P3-17（已修）|
