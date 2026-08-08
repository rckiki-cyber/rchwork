# 给 ChatGPT 的交接提醒：Skill-first / OfficeMCP-fallback 改造

> 用途：你在改造 legalwork 的 Office 文档执行路径（Skill-first），以下是另一个 AI 在深度排查中确认的事实和坑，避免你重走弯路。

---

## 一、必须知道的事实（已验证）

### 1. python-docx 版本和位置
- 你提到 `python-docx==1.2.9`，但**实际 requirements.txt 里是 `python-docx==1.1.0`**（`apps/desktop-legalwork/vendor/data-compliance-review-codex/requirements.txt` 第 2 行）。
- 它装在**脱敏功能的独立 Python 环境**里，那个环境**本地还没构建成功**（之前 `python-standalone` 下载 gzip 失败，我们刚修好校验）。**不能假设 Skill 运行时 python-docx 一定可用**——Skill 需自带依赖安装或运行时确保。
- 依赖包里 python-docx、python-pptx、openpyxl、PyMuPDF 都在，OCR/PDF 也齐，**不需要引入新重量依赖**（这点你判断对了）。

### 2. MCP 大输出截断已修复
- 我已把 MCP 工具文本输出**截断到 8000 字符**（`mcp-tool-provider.ts` 的 `truncateMcpTextOutput`）。
- 所以 `view html` 返回几十 KB HTML 全量进 history 的问题**已解决**。你改 Skill 时不用再处理这个大输出，但要理解这是**当前 main 上的状态**。

### 3. 步骤多的真正主因
- 真实轨迹：改一个页边距跑了 **38 次 office MCP 调用**（create→rm→重做→view html→help 查语法→再 set）。
- 主因是**模型不会用 officecli 的 batch**，反复单条操作 + help 现学语法。
- **纯截断解决不了步骤多**。Skill 必须做到"模型传参即用"，不要让它现场写复杂逻辑。

### 4. office-document-workflow 指令已存在
- `office-document-workflow.ts` 已有 `officeDocumentWorkflowInstruction`，在 `agent-loop.ts:934` 注入。
- 它已经在引导模型用 batch、save、validate，但**显然没约束住模型**（模型还是 38 步试错）。
- 你要改的是**这个指令的内容**（强化 Skill-first 路由），不是另起炉灶。

### 5. 复杂场景必须兜底
- python-docx **不支持**：track-change（修订）、批注、域代码、.doc（97-2003 老格式）。
- 这些场景**必须保留 office MCP 兜底**，否则律师改合同/批注会直接不可用。
- 建议：Skill 描述里明确"常规排版走本地脚本；涉及修订/批注/老格式用 office MCP"。

---

## 二、实现建议（针对你的 Skill-first 方向）

### Skill 形态（推荐）
```
skills/document-formatting/
├── SKILL.md          # 能力：生成/编辑 docx；传参即用；输出 JSON 摘要
├── scripts/
│   ├── create_docx.py     # 参数化：标题/段落/表格/页边距/字体（宋体小四固化）
│   ├── edit_docx.py       # 参数化：改字体/页边距/增删段落
│   └── inspect_docx.py    # 只读：输出结构化 JSON（替代 view html）
└── requirements.txt       # python-docx, python-pptx, openpyxl
```

### 关键点
1. **脚本要"传参即用"**：模型只需 `python3 edit_docx.py --file x.docx --margin-top 2.54cm`，不需要懂内部逻辑。
2. **只输出 JSON 摘要**：几百字符（成功/失败/改了什么），不输出文档全文。这和你想到的一致，是必须的。
3. **宋体小四等规则固化进脚本**：脚本内部处理默认样式，模型不用操心字体名。
4. **Skill 触发**：靠 SKILL.md 的 description 关键词（Word 文档/格式/字体/页边距），或复用 `officeDocumentWorkflowInstruction` 的 `DOCUMENT_INTENT_PATTERN` 判定。
5. **环境保障**：Skill 首次运行检查 python-docx，缺失则 `pip install -r requirements.txt`（用脱敏环境的 python）。

### 路由建议（在 office 工作流指令里写清楚）
| 场景 | 走谁 |
|---|---|
| 生成/编辑常规 docx（字体/页边距/表格/标题） | **document-formatting Skill** |
| 查看文档内容/格式 | **inspect_docx.py**（结构化摘要） |
| track-change / 修订 / 批注 / .doc 老格式 | **office MCP**（兜底） |

---

## 三、验证指标（改完要看的）
对比同一个"改页边距"任务：
- **步骤数**：38 次 → 期望 ≤5 次
- **单次请求 token**：8-9 万 → 期望 ≤2 万
- **总成本**：¥4.26 → 期望 ≤¥0.5
- **耗时**：十几分钟 → 期望 ≤2 分钟

实测数据参考：改页边距任务累计 485 万 token、¥4.26、4 turn / 47 步 / 48 次工具调用。
