# DOCX 真脚注：从零创建、维护与验收

## 1. 先记住：脚注不是尾注

Word DOCX 是 ZIP 包。两者结构不同：

**脚注 footnote**
- `word/footnotes.xml`
- 正文元素：`w:footnoteReference`

**尾注 endnote**
- `word/endnotes.xml`
- 正文元素：`w:endnoteReference`

用户说“脚注”时，最终交付中新增引用必须是前者。

## 2. 常见错误实现

以下全部判为失败：

1. 用 python-docx 在正文插入上标“1”，并在文末添加“1 参见……”；
2. 把引用写入页脚 `word/footer*.xml`；
3. 调用只支持 endnotes 的库；
4. 创建 `word/endnotes.xml` 并声称“Word也会显示注释”；
5. 用 `①`、`²` 模拟；
6. 只改显示文本，不建立 relationship / content type；
7. `footnoteReference` 有 ID，但 `footnotes.xml` 没有对应 note；
8. `footnotes.xml` 有 note，但正文没有 reference。

## 3. 原稿已有脚注时

先获取：

- 所有正整数 footnote IDs；
- 现有普通脚注的段落/字符样式；
- `document.xml.rels` 中 footnotes relationship；
- `[Content_Types].xml` 中 footnotes override。

新增 note ID 使用：

`max(existing positive IDs) + 1`

**不要为了插入中间位置而重排已有 ID。** Word 的显示序号由正文引用顺序管理，ID 只是关联键。

## 4. 原稿完全没有脚注时：完整创建步骤

### A. 创建 `word/footnotes.xml`

最少需要：

```xml
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1">
    <w:p><w:r><w:separator/></w:r></w:p>
  </w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0">
    <w:p><w:r><w:continuationSeparator/></w:r></w:p>
  </w:footnote>
</w:footnotes>
```

随后添加正常脚注 `w:id="1"`、`2`……。

### B. 增加 relationship

在 `word/_rels/document.xml.rels` 添加：

```xml
<Relationship
  Id="rIdN"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes"
  Target="footnotes.xml"/>
```

`rIdN` 必须唯一。

### C. 增加 Content Type

在 `[Content_Types].xml` 添加：

```xml
<Override
 PartName="/word/footnotes.xml"
 ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
```

### D. 插入正文 reference

```xml
<w:r>
  <w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>
  <w:footnoteReference w:id="1"/>
</w:r>
```

reference 必须紧跟所支持的文字，不要统一放段尾。

### E. 添加脚注定义

```xml
<w:footnote w:id="1">
  <w:p>
    <w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>
    <w:r>
      <w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>
      <w:footnoteRef/>
    </w:r>
    <w:r><w:t xml:space="preserve"> </w:t></w:r>
    <w:r><w:t>参见张三：《……》，载《……》2025年第3期，第45页。</w:t></w:r>
  </w:p>
</w:footnote>
```

## 5. 脚注样式

很多原稿没有显式 `FootnoteText` / `FootnoteReference` 样式。

优先顺序：

1. 原稿已有真脚注：复制原脚注的 pPr/rPr；
2. 原稿无脚注但 styles.xml 已有标准脚注样式：直接使用；
3. 二者都没有：脚本可创建最低限度的 `FootnoteText` 段落样式和 `FootnoteReference` 字符样式；
4. 如果学校有固定字号（如小五宋体），再显式配置；没有要求时不要强行覆盖全文风格。

脚注编号应由 `w:footnoteRef` / `w:footnoteReference` 自动呈现，不要在脚注文本前手打“1.”。

## 6. 多条脚注一次插入

使用 JSON，避免循环反复解压/压缩导致错误：

```json
[
  {
    "marker": "[[FN001]]",
    "text": "参见张三：《……》，载《……》2025年第3期，第45页。"
  },
  {
    "marker": "[[FN002]]",
    "text": "参见李四：《……》，法律出版社2024年版，第80页。"
  }
]
```

正文先在准确锚点插入 marker，再一次性运行：

```bash
python scripts/insert_true_legal_footnotes.py in.docx notes.json out.docx
```

脚本会：

- 从零创建 footnotes.xml（若缺失）；
- 增加 relationship 和 content type（若缺失）；
- 保留已有 footnotes；
- 给新脚注分配唯一 ID；
- 将 marker 替换为真 footnoteReference；
- 不创建或修改 endnotes.xml；
- 尽量沿用现有脚注格式。

## 7. 为什么不用“脚注ID重排”

ID 是关系键，不是显示序号。把全文 ID 重新编号属于不必要风险。

只有在文档本身 ID 冲突/损坏时才考虑修复映射，而且要先备份并进行完整审计。

## 8. 硬性验收

运行：

```bash
python scripts/audit_notes.py out.docx
python scripts/assert_true_footnotes.py out.docx
```

需要确认：

- `word/footnotes.xml` 存在；
- `w:footnoteReference` 数量符合预期；
- 所有正整数 reference ID 均有定义；
- 所有正常 footnote definitions 均被正文引用（除非文档原本允许孤立注）；
- relationship 正确；
- content type 正确；
- 新增 endnote reference 为 0；
- 不是 footer 文字；
- 渲染后脚注位于当页底部。

## 9. LibreOffice/Word 渲染差异

LibreOffice 能验证多数结构和布局，但高风险交付最好再用 Microsoft Word 打开验证一次。特别关注：

- 脚注跨页；
- 分节后的编号重启；
- 自定义脚注分隔线；
- 文档兼容模式。

