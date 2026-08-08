---
name: legal-document-formatting
description: LegalWork 的 Office 文档确定性执行技能。Word/DOCX 与常规 PPTX 默认通过 document_skill_execute 批量执行；Office MCP 仅在受信任执行器确认本地方法遇到结构性能力边界后最后兜底。Word 中文正文默认宋体、小四 12pt。
---

# LegalWork 文档格式 Skill

## 核心规则

- Office 文档默认使用 `document_skill_execute`，不要用 bash 手工调用 Python，更不要直接使用 OfficeMCP。
- 一个确定性任务尽量一次 worker 完成；worker 只返回紧凑 JSON，不渲染整篇 HTML/XML。
- OfficeMCP 默认不可见。只有 `document_skill_execute` 返回 `fallback_available:true` 后，才可调用一次 `request_office_fallback`；模型自己创建 ticket/文件不能解锁。
- 环境、依赖、参数、文件类型、普通脚本错误均不得触发 OfficeMCP。
- 修改已有文档默认另存副本。

## 格式优先级

用户明确要求 > 用户提供的参考 DOCX/模板 > 对应法律文档 profile > `legal-default`。

没有更高优先级规则时，Word 中文正文固定默认：**宋体、小四 12pt**；英文和数字默认 Times New Roman 12pt。普通报告 A4，上下 2.54cm、左右 3.17cm，1.5 倍行距，首行 2 字符，段前后 0。

## `document_skill_execute`

参数只有三项：

- `kind`: `docx` / `pptx` / `reference` / `profile`
- `operation`: 对应 worker 操作
- `args`: 传给该操作的字符串参数数组

例：

```text
document_skill_execute({
  kind:"docx",
  operation:"normalize",
  args:["--input","a.docx","--output","b.docx","--profile","legal-default"]
})
```

普通任务成功后立即交付，不再追加“再看一下”的 view/HTML 循环。

## 法律文档语义 profile

使用：

```text
document_skill_execute({kind:"profile",operation:"apply",args:["--input","IN.docx","--output","OUT.docx","--profile","PROFILE"]})
```

### `fact-memo`
案件事实、大事记、待核实问题：正文宋体小四；大板块 Heading 1；事实分组/问题主题 Heading 2；具体“时间+事实+材料来源”仍是正文，不滥用大纲级别。

### `legal-research`
法律问题调研：正文宋体小四；**调研问题=Heading 3，法条标题/案例标题=Heading 4，法条内容和法院说理=Normal**；内容优先按“结论→法条→案例”。失效但重要法条要文字标注，关键内容可下划线。

需要精确指定层级时写小型 `structure.json`：

```json
{"styles":[
  {"exact_text":"公司清算注销后，账簿由谁来管理？","style":"Heading 3"},
  {"exact_text":"《会计档案管理办法》（2015）","style":"Heading 4"}
]}
```

然后在 `profile apply` 的 args 中增加 `--structure-spec`,`structure.json`。

### `engagement-agreement`
委托代理协议/服务协议：正文仍宋体小四；默认 1.25 倍行距、不强制首行缩进；保留“第1条 / 2.1 / （1）”编号结构，不机械转成 Heading；保留页码、签章页和既有字段。

### `case-notes`
办案手记/工作底稿：正文默认宋体小四；Heading 1/2 表示事实与议题层级；允许“事实时间线+观点表+法条+案例+工作问题”混排；默认不洗平表格和局部结构。

### `case-tables`
案件基本信息表、联系人表、进展表、证据目录：保留表格结构和列宽；单元格默认宋体小四，表头加粗；不套正文首行缩进。

## 参考 DOCX

查看样板格式：

```text
document_skill_execute({kind:"reference",operation:"inspect",args:["--input","REFERENCE.docx"]})
```

直接让目标沿用样板：

```text
document_skill_execute({kind:"reference",operation:"apply",args:["--reference","REFERENCE.docx","--input","TARGET.docx","--output","OUT.docx"]})
```

reference worker 会解析 Word 样式继承并覆盖 Title、Heading 1-4、正文和页面规则；不复制样板正文、案名、姓名、页眉页脚文字、批注或修订内容。

## 通用 DOCX

`kind:"docx"` 支持：

- `inspect`
- `normalize`
- `page`
- `from-markdown`
- `replace`
- `template-fill`

普通格式修改目标 1-3 次工具调用；新建普通 Word 目标 2-4 次。文档越长，主要增加本地 Python CPU 时间，不应线性增加模型轮数。

## PPTX

`kind:"pptx"` 支持 `inspect`、`from-json`、`replace`。先确定内容结构/模板，再一次性生成或修改，不逐页 Office 工具循环。

## OfficeMCP 最后兜底

只有受信任执行器确认类似以下结构性限制时才可能返回 `fallback_available:true`：复杂 Track Changes/修订、宏、跨 run 且无法安全保持格式的替换等。

此时先确认其他本地 Skill 路径确实无解，再调用 `request_office_fallback`。解锁后只补剩余小部分：禁止 `view html`，禁止反复 help，同类操作 batch，必要 validate 通过后立即结束。
