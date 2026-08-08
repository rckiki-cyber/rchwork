---
name: legal-document-formatting
description: LegalWork 的 Office 文档格式执行技能。Word/DOCX 与常规 PPTX 任务默认使用技能自带的本地 Python worker；Office MCP 只有在本地 worker 明确返回 unsupported 并生成 fallback ticket 后才能作为最后兜底。Word 默认正文中文宋体、英文 Times New Roman、小四 12pt。
---

# LegalWork 文档格式执行 Skill

本技能负责 Office 文档的**确定性执行层**。内容起草、法律分析、检索等由其他能力完成；文档写入、格式、页面和基础结构优先交给本技能自带 worker，不让模型逐条操作 OfficeCLI。

## 一、最高优先级执行原则

1. **默认禁止 Office MCP。** 不要主动寻找、调用或尝试 `mcp_officecli_officecli`。
2. **优先运行本技能 Assets 中的本地 worker。** 不要现场重写一套 Python 文档脚本，也不要先 `help`、`find`、`cat` 本技能源码。
3. **一次完成一个确定性操作。** 能一条 worker 命令完成的，不拆成十几次工具调用。
4. **禁止整篇 HTML 渲染进入 history。** 不使用 `view html` 检查 Word；检查内容和格式用 worker 的 `inspect` / 内置 audit 摘要。
5. **保留用户原件。** 修改已有文档时默认输出新文件，不覆盖原始文件。
6. **Office MCP 只是最后兜底。** 只有 worker 返回 `status:"unsupported"` 且同时给出 `fallback_ticket` 时，才允许调用 `request_office_fallback`；没有 ticket 不得申请兜底。

## 二、Word 默认格式

用户没有另行指定、也没有模板/机构强制格式时，默认采用：

- A4 纵向；
- 正文中文：宋体；
- 正文英文和阿拉伯数字：Times New Roman；
- 正文字号：12 pt（小四）；
- 正文两端对齐；
- 首行缩进：2 字符；
- 行距：1.5 倍；
- 段前、段后：0；
- 标题使用 Word Heading/Title 样式，不用空格和手打结构模拟标题；
- 用户明确要求、现有模板、法院/学校/律所规范优先于上述默认值。

内置 profile：

- `legal-default`：普通法律意见、合同、备忘录、报告、日常正式文档；
- `academic`：课程论文、期刊论文、学位论文、研究报告；
- `litigation`：诉状、答辩状、代理词等诉讼文书基础版式。

## 三、Word：默认工作流

Assets 中会给出 `scripts/docx_worker.py` 的绝对路径。直接使用该路径。

### 1. 只查看结构/格式摘要

```bash
python3 <docx_worker.py> inspect --input "/path/input.docx"
```

输出只有紧凑 JSON：段落数、表格数、节、页边距、主要样式和复杂特性，不输出全文 HTML。

### 2. 只改页边距/页面

用户只要求页边距时，不要顺手重排全文：

```bash
python3 <docx_worker.py> page \
  --input "/path/input.docx" \
  --output "/path/output.docx" \
  --top 2.54 --bottom 2.54 --left 3.17 --right 3.17
```

目标：**1 次 bash 完成**。

### 3. 统一为标准格式

```bash
python3 <docx_worker.py> normalize \
  --input "/path/input.docx" \
  --output "/path/output.docx" \
  --profile legal-default
```

默认一次完成页面、样式、正文宋体小四、标题和格式审计。worker 会在保存后重新打开文件并给出 audit 摘要；audit 无 mismatch 时直接交付，不再重复检查。

如果只需改部分：

```bash
--scopes page
--scopes body,styles
--scopes headings,styles
```

### 4. 从零生成 Word

先把最终正文一次性写到 Markdown 临时文件，然后只调用一次 worker：

```bash
python3 <docx_worker.py> from-markdown \
  --input "/path/draft.md" \
  --output "/path/final.docx" \
  --profile legal-default
```

支持 1—3 级 Markdown 标题、正文、项目符号、编号和基础表格。

常规新建 Word 的理想工具链：

```text
write draft.md → bash docx_worker.py from-markdown → 交付
```

通常 2 次工具调用即可，不要再 create/set/add/save/view 循环。

### 5. 精确文字替换

```bash
python3 <docx_worker.py> replace \
  --input "/path/input.docx" \
  --output "/path/output.docx" \
  --old "原文字" --new "新文字"
```

worker 默认只做能保留 run 格式的安全替换。如果目标跨多个 Word run，会返回 `unsupported`，而不是粗暴重建整段导致格式丢失。

### 6. 模板占位符填充

模板中使用 `{{NAME}}`、`{{DATE}}` 等占位符，并准备一个 JSON 对象：

```bash
python3 <docx_worker.py> template-fill \
  --input "/path/template.docx" \
  --output "/path/output.docx" \
  --values "/path/values.json"
```

跨 run 的复杂占位符会返回 `unsupported`，不擅自破坏模板。

## 四、PPTX：本地优先

Assets 中的 `scripts/pptx_worker.py` 用于常规 PPTX 创建、检查和文本替换。原则与 Word 相同：

- 本地 worker 优先；
- 不逐页截图形成大上下文；
- 不反复渲染；
- worker 明确 `unsupported` 后才申请 Office MCP 兜底。

## 五、何时允许 Office MCP 兜底

以下情形可以由本地 worker判定为 unsupported，例如：

- 需要完整保留并编辑复杂 Track Changes/修订结构；
- 宏文档或复杂 Word 结构无法安全改写；
- 文字跨多个 run 且重排会破坏既有格式；
- 复杂模板、域、嵌入对象或本地库确实无法处理；
- 旧 `.doc` / `.ppt` 在本地转换手段也失败。

worker 返回示例：

```json
{"status":"unsupported","marker":"LEGALWORK_DOCUMENT_UNSUPPORTED","reason":"...","fallback_ticket":"/tmp/...json"}
```

这时才调用：

```text
request_office_fallback(ticket=<fallback_ticket>)
```

该工具验证一次性 ticket 后，只对**当前 turn**开放 Office MCP。没有 worker ticket、只是模型觉得 OfficeCLI 更方便，不构成兜底条件。

### Office MCP 已解锁后的纪律

- 只处理 worker 无法完成的那一小部分，不重新做已经完成的本地操作；
- 不调用 `view html`；
- 不反复 `help`；
- 同类修改必须 batch；
- 最多进行必要的一次验证和一次针对性修复；
- 不因为 warning 或肉眼不可见的小问题反复重做整份文件。

## 六、成本与上下文约束

文档任务默认遵循：

- 不把完整 DOCX HTML/XML/大段二进制编码返回给模型；
- worker stdout 只输出一行紧凑 JSON；
- 不为了“确认一下”重复读取同一文档；
- 不先扫描 Skill 目录；Assets 已给出脚本路径；
- 普通格式修改目标 1—3 次工具调用；
- 新建普通 Word 目标 2—4 次工具调用；
- worker 已成功并 audit 通过后立即结束，不追加审美型工具循环。

## 七、交付底线

- 用户要求优先于默认格式；
- 有模板时优先保留模板；
- 现有文件默认另存副本；
- 不擅自接受修订、删除批注、删除字段、清除签章或改写用户未要求修改的正文；
- 交付时只说明最终文件位置、采用的 profile/模板和必要的已知限制，不复述工具日志。
