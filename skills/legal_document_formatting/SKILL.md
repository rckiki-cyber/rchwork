---
name: legal-document-formatting
description: LegalWork 的 Word/DOCX 底层格式与排版技能。凡任务涉及新建、起草、生成、编辑、改写、套用模板、规范化、审阅、修复、合并、导出或交付 Word（.doc/.docx），以及诉状、答辩状、代理词、证据目录、法律意见书、法律备忘录、尽调报告、律师函、合同、会议纪要、研究报告、论文、学位论文等正式可打印文档时，必须优先使用本技能；即使用户只说“整理成正式文档”“按法院/律所/学校格式排版”也应触发。它负责版式选择、Word 样式、字体字号、段落、编号、表格、页眉页脚、脚注引文、分页、模板保真与渲染质检，并与内容起草类技能叠加使用。用户的明确要求始终优先于本技能默认值。
---

# LegalWork Word 底层格式

把本技能作为所有 Word 任务的格式层；把其他法律、研究或写作技能作为内容层。不得让内容层跳过本技能的格式决策和交付质检。

## 约束优先级

按以下顺序解决冲突，前项覆盖后项：

1. 用户在本次任务中的明确要求。
2. 用户提供或指定的法院、仲裁机构、客户、律所、学校、期刊或单位模板。
3. 接收机构的现行强制提交规则。
4. 用户要求保留的原文档版式、品牌和修订状态。
5. 本技能对应场景的默认规范。
6. 一般审美优化。

若用户要求明显不利于提交、打印或阅读，仍按用户要求执行，同时用一句话指出风险。不得以“更美观”为由改动法定结构、学校模板、律所品牌、签章位置或用户指定参数。

## 工作流

### 1. 判定任务模式

- 新建：从零生成 DOCX。
- 内容编辑：在现有 DOCX 中做局部增删改。
- 格式整理：统一样式、修复版面、套模板。
- 模板迁移：将内容迁入指定模板。
- 审阅：只检查格式并给出问题清单；未获授权不得改文件。

编辑现有文件时先复制为新文件，保留原件。默认做最小必要修改；只有用户要求“统一重排”“按模板重做”时才进行全局重构。不得擅自接受修订、删除批注或改写正文。

### 2. 选择格式权威

**前置纪律：本技能全部内容已通过注入提供，禁止 `find`/`ls`/`cat` 查找或重新读取本技能目录下的任何文件**（`SKILL.md`、`references/*.md`、`scripts/*.py`）。需要格式规范直接按本文件执行；需要审计脚本直接按下方 `python3 scripts/audit_docx_format.py` 调用，不要先 grep 脚本源码。

先检查是否存在以下材料：

- 指定模板、同类历史定稿、投稿或提交指南；
- 原文件中的有效样式、节、页眉页脚、编号和字段；
- 用户给出的字体、字号、页边距、行距、页码、封面要求。

存在模板时，以模板为版式权威，先提炼其页面、样式、节、页眉页脚、编号、表格和字段，再替换内容。不得把有结构的模板当作普通样式包覆盖。

无模板时选择一个场景：

- 诉讼、仲裁、执行及法院文书：读取 [litigation-documents.md](references/litigation-documents.md)。
- 法律意见、备忘录、尽调、报告、函件、合同及日常办公：读取 [advisory-transactional.md](references/advisory-transactional.md)。
- 证据目录、时间线、案件台账、清单和表单：读取 [tables-evidence-forms.md](references/tables-evidence-forms.md)。
- 课程论文、期刊论文、学位论文、开题和研究报告：读取 [academic-writing.md](references/academic-writing.md)。
- 任一场景均读取 [core-style-system.md](references/core-style-system.md)；需要理解默认值来源时再读取 [reference-basis.md](references/reference-basis.md)。

### 3. 建立样式系统

在写正文前确定并实现以下命名角色：

- Normal/正文；
- Title/文档标题；
- Subtitle/副标题或案号；
- Heading 1—3/一级至三级标题；
- Quote/引文；
- Caption/图表题注；
- Footnote Text/脚注；
- Table Text/表格正文；
- Signature/落款；
- Header、Footer。

必须用 Word 样式表达重复角色，用真实多级编号表达层级，用节表达页面变化。不得靠连续空格、全角空格、空段落、手打圆点、手打序号或大量直接格式模拟版面。

把中西文字体分别写入 OOXML：中文使用 `eastAsia`，英文和阿拉伯数字使用 `ascii`/`hAnsi`。同时设置 `w:sz` 与 `w:szCs`。标题样式和 Heading 1—3 必须有正确大纲级别，以支持导航窗格和目录。

### 4. 应用通用底线

- 默认纸张为 A4 纵向；宽表可在独立节中改为 A4 横向，之后恢复纵向。
- 默认正文为中文宋体、英文与阿拉伯数字 Times New Roman、12 pt、小四；正文两端对齐。
- 默认正文首行缩进 2 字符，1.5 倍行距，段前段后 0；场景规范另有规定时覆盖。
- 标题、表格、落款、当事人信息、目录和引文不得机械套用正文首行缩进。
- 页边距、字体、字号、行距、段距、缩进、表格宽度、页眉页脚距离必须显式设置，不依赖 Word 默认值。
- 保持每页自然密度；不得通过缩小到 10 pt 以下、压扁行距、固定表格行高或删除必要留白强行塞页。
- 使用 `keepNext`、`keepLines`、孤行控制和合理分页，避免标题悬空、单行落页、表题与表格分离、签名栏拆页。
- 中文标点使用全角；英文和数字使用半角。数字、日期、案号、金额、条款序号在全文保持同一口径。

完整数值与例外见 [core-style-system.md](references/core-style-system.md)。

### 5. 处理关键组件

#### 编号

根据文种使用真实多级列表。中文法律文档通常采用：

1. `一、`
2. `（一）`
3. `1.`
4. `（1）`

同一层级不得混用符号；正文层级原则上不超过四级。合同条款、裁判主文、证据目录和论文标题按各自参考文件执行。

#### 表格

只在信息具有稳定行列关系时使用表格。明确设置表宽、列宽、表格缩进、单元格宽度和边距；禁止自动平均分列。表头重复，短字段居中，叙述字段左对齐，数值按位数或小数点对齐。禁止固定行高造成截字，禁止用表格包装普通长段落。

#### 页眉页脚和页码

封面、正文、附件、横向表格需要不同版式时使用分节符。正确设置“首页不同”“奇偶页不同”和“链接到前一节”。页码必须用字段，不得手打；需要总页数时使用 `PAGE`/`NUMPAGES`。封面是否计页、前置部分是否用罗马数字，按场景规范或模板执行。

#### 目录、脚注和交叉引用

目录必须由大纲级别和 TOC 字段生成。脚注使用真实 footnote，不得在正文末尾手打。图表使用 Caption/SEQ；正文引用使用 REF 或交叉引用字段。更新字段后再渲染检查。

#### 修订、批注和隐私

- 编辑稿默认保留原有修订和批注。
- “清洁版”仅在用户要求或明确进入最终交付阶段时生成；保留一份可追溯版本。
- 对外文件检查作者、公司、模板路径、自定义属性、隐藏文本、批注、修订和嵌入对象；是否清除以用户要求和交付目的为准。
- 不得把案件样本中的当事人、客户、律所或学校信息复制到新文档，除非它们属于当前任务。

## 实现要求

- 优先使用环境提供的专业 DOCX 工具链、OpenXML 或 `python-docx`；不得把 Markdown/HTML 改扩展名伪装成 DOCX。
- 复制模板时保留必要的主题、字体表、样式、编号、关系、节、页眉页脚、图片、字段和内容类型。
- 直接操作 OOXML 时遵守元素顺序；`sectPr` 保持在 body 最后或对应段落属性中，表格单元格至少包含一个段落。
- 复制内容到模板时清理与目标样式冲突的直接格式，但保留具有语义的粗体、斜体、上标、下标、链接、批注和修订。
- 表格几何使用 DXA 明确计算，确保 `tblW`、`tblGrid`、`tcW` 与可用版心一致。
- 对旧 `.doc` 先转换为 `.docx`，再编辑；不得直接用仅支持 `.docx` 的库打开 `.doc`。

## 新建 DOCX 的一键生成模板（首选，省时省调用）

**这是新建文档的默认路径。目标：一次 batch 写完内容，总工具调用控制在 ≤6 次，不反复 help、不逐条 create/section/paragraph。**

用环境提供的 officecli MCP 工具（`mcp_officecli_officecli`），命令结构如下（参数按 MCP 工具传 `{command, file, ...}`，见下方示例）：

```
第1步  create <文件路径>                          # 建空文件
第2步  set    <文件路径> /section[1]              # 页面设置：A4、页边距（一次设完）
第3步  batch  <文件路径>                          # 一次性写入：样式 + 标题 + 正文 + 表格 + 页脚（所有内容一个 batch 的 commands 数组）
第4步  save   <文件路径>
第5步  validate <文件路径>                        # 结构校验（一次，不要反复）
第6步  view <文件路径> outline                     # 检查大纲层级，确认无空段/错层即止
```

### 已实测可用的命令模板

**create（第1步）**
```
{command: create, file: "/path/out.docx"}
```

**页面设置 set（第2步）**
```
{command: set, file: "/path/out.docx", path: "/section[1]", props: {
  pageWidth: "21cm", pageHeight: "29.7cm",
  marginTop: "2.54cm", marginBottom: "2.54cm",
  marginLeft: "3.18cm", marginRight: "3.18cm",
  marginHeader: "1.5cm", marginFooter: "1.75cm"}}
```

**一次性写全部内容 batch（第3步）——按需组合，全部塞进 commands 数组**

样式（先建样式，一次 add 完）：
```
{command: batch, file: "/path/out.docx", commands: [
  {command: add, parent: "/styles", type: "style", props: {id: "Title", type: "paragraph", font: "Times New Roman", "font.ea": "黑体", size: 18, align: "center", spaceBefore: "0pt", spaceAfter: "18pt", outlineLvl: 0, keepNext: true}},
  {command: add, parent: "/styles", type: "style", props: {id: "Heading1", type: "paragraph", basedOn: "Normal", font: "Times New Roman", "font.ea": "黑体", size: 14, bold: true, align: "left", spaceBefore: "12pt", spaceAfter: "6pt", outlineLvl: 0, keepNext: true}},
  {command: add, parent: "/styles", type: "style", props: {id: "Heading2", type: "paragraph", basedOn: "Normal", font: "Times New Roman", "font.ea": "黑体", size: 12, bold: true, align: "left", spaceBefore: "9pt", spaceAfter: "3pt", outlineLvl: 1, keepNext: true}},
  {command: add, parent: "/styles", type: "style", props: {id: "Heading3", type: "paragraph", basedOn: "Normal", font: "Times New Roman", "font.ea": "宋体", size: 12, bold: true, align: "left", spaceBefore: "6pt", spaceAfter: "0pt", outlineLvl: 2, keepNext: true}},
  {command: set, path: "/styles/Normal", props: {font: "Times New Roman", "font.ea": "宋体", size: 12, lineSpacing: "1.5x", align: "justify", widowControl: true}}
]}
```

正文与表格（同样放 batch 的 commands 数组，跟在样式后面一起提交）：
```
{command: add, parent: "/body", type: "paragraph", props: {style: "Title", text: "标题"}}
{command: add, parent: "/body", type: "paragraph", props: {style: "Heading1", text: "一、..."}}
{command: add, parent: "/body", type: "paragraph", props: {style: "Normal", firstLineIndent: "480", text: "正文首行缩进2字符"}}
{command: add, parent: "/body", type: "table", props: {cols: 2, rows: 4, layout: "fixed", width: "100%", data: "表头1,表头2;单元格A,单元格B;..."}}
```

表格列宽与表头重复（同一 batch 或下一个 batch）：
```
{command: set, path: "/body/tbl[1]", props: {colWidths: "1800,6000", layout: "fixed", border: "none"}}
{command: set, path: "/body/tbl[2]/tr[1]", props: {header: true}}
```

页脚页码（放在 batch commands 数组末尾）：
```
{command: add, parent: "/", type: "footer", props: {type: "default", align: "center", font: "Times New Roman", "font.ea": "宋体", size: 10.5, text: "第 "}},
{command: add, parent: "/footer[1]/p[1]", type: "field", props: {fieldType: "page"}},
{command: add, parent: "/footer[1]/p[1]", type: "run", props: {text: " 页　共 "}},
{command: add, parent: "/footer[1]/p[1]", type: "field", props: {fieldType: "numpages"}},
{command: add, parent: "/footer[1]/p[1]", type: "run", props: {text: " 页"}}
```

### 关键纪律（违反会导致 30+ 次无谓调用）

- **不要 help**：语法已在上方，不需要 `help docx style/section/paragraph/...`。一次都不需要。
- **不要 find/cat 技能文件**：本技能内容已通过注入提供，无需 `ls ~/.legalwork/skills`、`find`、`cat SKILL.md`。直接照本模板执行。
- **内容一次写完**：把全部标题、正文、表格、页脚在**第一个 batch** 里一次提交，不要分 6 次 `batch` 逐个 add。
- **最多一次 validate + 一次 view outline**：通过即交付，不要对 warning 反复调试。

## PPT（.pptx）一键生成模板

officecli 同样支持 PPT。**目标：≤8 次调用，一次 batch 建完所有幻灯片，不逐页截图、不反复渲染检查。**

```
第1步  load_skill pptx          # 加载 pptx 语法（只一次）
第2步  create <文件路径>.pptx
第3步  batch <文件路径>  commands=[ ...全部幻灯片... ]   # 见下方
第4步  save <文件路径>
第5步  view <文件路径> outline   # 检查大纲层级，通过即交付
```

**batch 命令模板（每页一个 slide，全部塞进 commands 数组）：**
```json
{ "command": "batch", "file": "/path/演示.pptx", "commands": [
  { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "title", "title": "人工智能对行政法的根本影响", "subtitle": "——基于本地知识库的文献综述" } },
  { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "title_and_content", "title": "一、核心判断", "content": "人工智能对行政法的影响不是局部修补，而是对“主体—行为—程序—责任”链条的根本性重塑。" } },
  { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "title_and_content", "title": "二、组织平台化", "content": "行政组织法变革：平台化、公私合作新形态。" } }
] }
```

**PPT 质检纪律（防止陷入死循环）：**
- **绝不逐页截图检查**。模型不支持读图时，截图毫无意义，`view screenshot` 一次都不要用。
- **不重渲染**：`view outline` 确认层级正确即交付，不要反复 screenshot + 几何复核。
- **保存即收尾**：`save` 之后直接输出交付说明（"PPT 已生成，共 N 页"），**不要 save 后再发起新的复核轮次**。
- **不要 help**：pptx 语法已在上方，`load_skill pptx` 一次即可，不要反复 help slide。

## 强制质检

每次生成或实质修改 DOCX 后执行，**控制在 ≤3 次工具调用，只修真错误，不为美观反复折腾**：

1. 结构检查：`validate` 一次，确认文件可打开、样式/字段/内容类型有效。
2. 规则审计：运行 `scripts/audit_docx_format.py` 并选正确 profile。
   - **只修 error**。error 为 0 即可交付。
   - **warning 一律不修**，除非它影响真实交付（如表格破表、缺页眉页脚）；正常交付下 warning 记为已知项即可。
   - **info 直接忽略**，不做任何处理。
3. 内容保真：核对段落、表格、脚注、图片、批注、修订和附件是否丢失或重复（`view outline` 一次即可）。

不强制逐页 PNG 渲染。只有当 `validate` 或 audit 报出真实结构/版面错误、且确实需要目视确认时才渲染，检查完即止。不要对肉眼几乎不可见的中英文标点混排、手打编号等吹毛求疵——这些不是错误。

## 最终交付

- 默认只交付最终 DOCX，不交付临时 PDF、PNG、分析 JSON 或脚本输出。
- 文件名应包含清晰文种和版本，避免“新建文档”“最终最终版”等名称。
- 明确说明采用的模板或场景规范、是否保留修订、是否清理元数据，以及任何遵照用户要求而保留的格式例外。
- 用户要求与本技能不一致时，以用户要求为准。
