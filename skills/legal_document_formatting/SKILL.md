---
name: legal-document-formatting
description: LegalWork 的 Office 文档确定性执行技能。Word/DOCX、Excel/XLSX 与常规 PPTX 默认通过 document_skill_execute 批量执行；Office MCP 仅在受信任执行器确认本地方法遇到结构性能力边界后最后兜底。Word 中文正文默认宋体、小四 12pt。
---

# LegalWork 文档格式 Skill

## 核心规则

- Word、Excel、PPT 默认使用 `document_skill_execute`，不要用 bash 手工调用 Python，更不要直接使用 OfficeMCP。
- 一个确定性任务尽量一次 worker 完成；worker 只返回紧凑 JSON，不渲染整篇 HTML/XML。
- OfficeMCP 默认不可见。只有 `document_skill_execute` 返回 `fallback_available:true` 后，`request_office_fallback` 才会临时出现；模型自己创建文件不能解锁。
- 环境、依赖、参数和普通脚本错误均不得触发 OfficeMCP。
- 修改已有文档默认另存副本。

## 内置 Office Python 环境

正式安装版 LegalWork 随应用携带 Office Python runtime，预装 `python-docx`、`openpyxl`、`python-pptx`、`lxml`、`Pillow`。`document_skill_execute` 会从 `resources/office-runtime` 自动发现并使用它。

**正式安装态禁止现场创建 venv、禁止 pip install、禁止要求用户配置 Python。** 如果内置 runtime 缺失或损坏，直接报告安装损坏，不得改用 OfficeMCP 掩盖环境问题。开发态才允许本地 Python/managed venv 作为调试兜底。

## 格式优先级

用户明确要求 > 用户提供的参考 DOCX/模板 > 对应法律文档 profile > `legal-default`。

没有更高优先级规则时，Word 中文正文固定默认：**宋体、小四 12pt**；英文和数字默认 Times New Roman 12pt。普通报告 A4，上下 2.54cm、左右 3.17cm，1.5 倍行距，首行 2 字符，段前后 0。

## `document_skill_execute`

- `kind`: `docx` / `xlsx` / `pptx` / `reference` / `profile` / `legacy`
- `operation`: 对应 worker 操作
- `args`: 传给该操作的字符串参数数组

普通任务成功后立即交付，不追加“再看一下”的 view/HTML 循环。

## 法律文档语义 profile

使用 `kind:"profile", operation:"apply"`。

### `fact-memo`
案件事实、大事记、待核实问题：正文宋体小四；大板块 Heading 1；事实分组/问题主题 Heading 2；具体“时间+事实+材料来源”仍是正文，不滥用大纲级别。

### `legal-research`
法律问题调研：正文宋体小四；**调研问题=Heading 3，法条标题/案例标题=Heading 4，法条内容和法院说理=Normal**；内容优先按“结论→法条→案例”。失效但重要法条要文字标注，关键内容可下划线。

需要精确指定层级时写很小的 `structure.json`，例如：

```json
{"styles":[
  {"exact_text":"公司清算注销后，账簿由谁来管理？","style":"Heading 3"},
  {"exact_text":"《会计档案管理办法》（2015）","style":"Heading 4"}
]}
```

然后在 `profile apply` args 中增加 `--structure-spec`,`structure.json`。

### `engagement-agreement`
委托代理协议/服务协议：正文仍宋体小四；默认 1.25 倍行距、不强制首行缩进；保留“第1条 / 2.1 / （1）”编号结构，不机械转成 Heading；保留页码、签章页和既有字段。

### `case-notes`
办案手记/工作底稿：正文默认宋体小四；Heading 1/2 表示事实与议题层级；允许“事实时间线+观点表+法条+案例+工作问题”混排；默认不洗平表格和局部结构。

### `case-tables`
案件基本信息表、联系人表、进展表、证据目录：保留表格结构和列宽；单元格默认宋体小四，表头加粗；不套正文首行缩进。

## 参考 DOCX

`kind:"reference", operation:"inspect"` 提取样板格式摘要；`operation:"apply"` 一次把样板页面、正文和 Title/Heading 1-4 样式应用到目标 DOCX。

reference worker 会解析 Word 样式继承；不复制样板正文、案名、姓名、页眉页脚文字、批注或修订内容。

## Excel / XLSX

`kind:"xlsx"` 支持：

- `inspect`：只返回工作表数量、行列规模、合并单元格、冻结窗格和可选的小范围 preview，不把整本工作簿数据塞进上下文；
- `from-json`：从结构化 JSON 一次生成 XLSX；
- `replace`：在现有 `.xlsx/.xlsm` 中安全批量替换文本。

案件基本信息表、联系人表、案件进展表、证据目录等优先直接产出 XLSX，而不是让模型逐单元格操作 Office 工具。

## 旧 `.doc` / `.xls` / `.ppt`

先走本地转换，不能因为扩展名旧就直接启用 MCP：

```text
document_skill_execute({kind:"legacy",operation:"convert",args:["--input","OLD.xls","--output","NEW.xlsx"]})
```

worker 会优先使用可用的 LibreOffice/soffice headless 转为 `.docx/.xlsx/.pptx`，成功后继续正常 Skill 流程。只有转换器不存在或全部本地转换尝试失败，才可能返回 `fallback_available:true`。

## 通用 DOCX / PPTX

`kind:"docx"` 支持 `inspect`、`normalize`、`page`、`from-markdown`、`replace`、`template-fill`。

`kind:"pptx"` 支持 `inspect`、`from-json`、`replace`。先确定内容结构/模板，再一次性生成或修改，不逐页 Office 工具循环。

普通格式修改目标 1-3 次工具调用；新建普通 Word/Excel/PPT 目标 2-4 次。文件越大，主要增加本地 Python CPU 时间，不应线性增加模型轮数。

## OfficeMCP 最后兜底

只有受信任执行器确认本地路径已遇到真实能力边界时才会返回 `fallback_available:true`，例如复杂 Track Changes/修订、宏、无法安全保持格式的跨-run替换，或 `.doc/.xls/.ppt` 本地转换确已失败。

此时才调用 `request_office_fallback`。解锁后只补剩余小部分：禁止 `view html`，禁止反复 help，同类操作 batch，必要 validate 通过后立即结束。
