---
name: legal-document-formatting
description: LegalWork 的 Office 文档确定性执行技能。Word/DOCX 与常规 PPTX 默认由本技能的本地 Python worker 完成；支持参考 DOCX 与法律文档语义 profile。Office MCP 仅在所有本地方法都无法安全完成时最后兜底。Word 中文正文默认宋体、小四 12pt。
---

# LegalWork 文档格式执行 Skill

目标：把 Office 文档处理从“模型逐条调 Office 工具”改成“模型决定一次任务，本地 worker 批量执行并返回紧凑 JSON”。内容起草、法律分析、检索由其他能力完成；本技能负责文档结构与格式。

## 1. 格式来源优先级

按以下顺序决定格式，前者覆盖后者：

1. 用户当前任务明确指定；
2. 用户提供的参考 DOCX / 模板 / 法院、学校、律所样板；
3. 对应法律文档语义 profile；
4. 通用 `legal-default`。

用户说“照这个 Word”“按这份格式”时，直接使用 reference worker，不要先把几十条格式规则写进上下文再逐条修改。

## 2. Word 正文硬默认

没有更高优先级规则时：

- 中文正文：**宋体，小四 12pt**；
- 英文与阿拉伯数字：Times New Roman 12pt；
- A4 纵向；
- 默认页边距：上下 2.54cm、左右 3.17cm；
- 普通报告正文：两端对齐、首行缩进 2 字符、1.5 倍行距、段前后 0。

不同法律文档 profile 可以改变行距、缩进、标题层级和表格策略，但**不改变“中文正文宋体小四”这一默认**，除非用户或参考模板明确要求其他字体字号。

## 3. 强制执行顺序

1. 默认不调用 `mcp_officecli_officecli`，不主动查 OfficeCLI help。
2. 使用 Assets 中 `scripts/skill_runner.py`。runner 管理 `~/.legalwork/runtimes/office-skills/python-venv`；不要让模型自己 pip install。
3. 一个确定性任务尽量一次 worker 完成；stdout 仅一条紧凑 JSON。
4. 禁止把整篇 DOCX/PPTX HTML、XML、二进制或 pip 日志塞入 history。
5. 修改已有文档默认另存副本。
6. 只有本地 worker 明确证明无法安全处理并返回合法 fallback ticket，才申请 Office MCP；普通参数错误、环境错误、脚本错误不能直接启用 MCP。

## 4. 法律文档语义 profile

真实法律工作文档不能全部套同一套段落规则。使用：

```text
<python> <skill_runner.py> profile apply --input IN.docx --output OUT.docx --profile PROFILE
```

### `fact-memo`

适用于案件事实、大事记、待核实问题。

- 正文宋体小四、1.5 倍行距、首行 2 字符；
- 大板块使用 Heading 1；
- 事实分组 / 待确认问题主题使用 Heading 2；
- 时间+事实+材料来源保持正文，不把每条事实滥用成大纲标题。

### `legal-research`

适用于法律问题调研成果。

- 正文宋体小四、1.5 倍行距、首行 2 字符；
- **调研问题 = Heading 3**；
- **法条标题 / “案例”标题 = Heading 4**；
- 具体法条内容、法院说理 = Normal 正文；
- 内容组织优先“结论 → 法条 → 案例”；
- 失效但重要法条要在文字中显式标注；关键法条/案例说理的下划线属于内容层格式，不通过 Office MCP 逐句操作。

需要精确指定某些段落层级时，先写一个很小的 JSON：

```json
{"styles":[
  {"exact_text":"公司清算注销后，账簿由谁来管理？","style":"Heading 3"},
  {"exact_text":"《会计档案管理办法》（2015）","style":"Heading 4"}
]}
```

再一次执行：

```text
... profile apply --profile legal-research --structure-spec structure.json
```

### `engagement-agreement`

适用于委托代理协议、服务协议等合同式文档。

- 中文正文仍为宋体小四；
- 默认 1.25 倍行距；
- 不强制首行缩进；
- 保留“第1条 / 2.1 / （1）”等合同编号结构；
- 不把合同条款机械转换为 Heading 大纲；
- 页码、签章页、既有字段优先保留。

### `case-notes`

适用于办案手记、案件分析工作底稿。

- 中文正文默认宋体小四；
- Heading 1 / 2 表示事实和议题层级；
- 允许混合“事实时间线 + 各方观点表 + 法条 + 案例 + 工作问题”；
- 默认不重排表格，不把整份混合文档一键洗平成普通正文。

### `case-tables`

适用于案件基本信息表、联系人表、案件进展表、证据目录等表格型成果。

- 保留表格结构和列宽；
- 表格正文默认宋体小四；
- 表头默认加粗；
- 不对表格单元格套首行两字符缩进；
- 不把表格内容转为普通段落大纲。

默认 `profile apply` 只执行该 profile 的安全 scope；需要明确扩大范围时再传 `--scopes page,body,headings,tables`。

## 5. 参考 DOCX 驱动格式

查看参考格式摘要：

```text
<python> <skill_runner.py> reference inspect --input REFERENCE.docx
```

直接套用参考样式：

```text
<python> <skill_runner.py> reference apply --reference REFERENCE.docx --input TARGET.docx --output OUT.docx
```

参考 worker 只提取并应用页面、正文与标题样式；不复制参考正文、案名、姓名、页眉页脚文字、修订、批注、字段内容。

如果用户给了真实样板，reference 路径优先于语义 profile；语义 profile 主要用于没有模板时提供稳定默认。

## 6. 通用 DOCX worker

```text
<python> <skill_runner.py> docx <operation> <arguments...>
```

主要操作：

- `inspect --input FILE`：返回段落、表格、节、主要样式和复杂特性摘要，不输出全文；
- `normalize --input IN --output OUT --profile legal-default`：普通正式文档一次规范化；
- `page ...`：只改页边距；
- `from-markdown ...`：从完整 Markdown 一次生成 DOCX；
- `replace ...`：安全文字替换；
- `template-fill ...`：填 `{{NAME}}` 等模板占位符。

worker 返回 `status:"ok"` 且 audit 无 mismatch 时立即交付，不追加“再看一下”的 HTML/view 循环。

## 7. PPTX worker

```text
<python> <skill_runner.py> pptx <operation> <arguments...>
```

常用：`inspect`、`from-json`、`replace`。先确定内容结构/模板，再一次性生成或修改；不要逐页 Office 工具循环。

## 8. Office MCP 最后兜底

Office MCP 不是常用执行器。只有本地方法都无法安全满足用户需求时才允许兜底，例如：

- 必须完整保留并编辑复杂 Track Changes；
- 宏、复杂域、内容控件、嵌入对象或特殊模板无法安全改写；
- 旧 `.doc` / `.ppt` 经本地转换仍无法处理；
- worker 明确证明某项操作会破坏原有结构。

解锁后只处理本地 worker 无法完成的剩余部分：禁止 `view html`，禁止反复 help，同类操作 batch，必要 validate 通过后立即结束。

## 9. 成本纪律

- 普通格式修改目标：1-3 次工具调用；
- 新建普通 Word/PPT：2-4 次工具调用；
- 有参考 Word：优先一次 `reference apply`；
- 法律文档已有语义类型：优先一次 `profile apply`；
- 文档越长，主要增加本地 Python CPU 时间，而不是模型循环和上下文长度。

最终只说明产物、采用的 profile / 参考样板和必要限制，不复述执行日志。
