# 在原 DOCX 上安全修改

## 1. 优先局部编辑，不重建整篇

法律论文常有：

- 页码域；
- 自定义标题；
- 中文字体混排；
- 脚注；
- 页眉；
- 分节；
- 自动目录。

整篇用 python-docx 重建容易破坏这些结构。

## 2. 推荐方法

- 一般正文：python-docx；
- 需要真脚注：OOXML patch；
- 已有复杂脚注、批注、域：尽量局部改 XML；
- 每轮重大修改后渲染。

## 3. 新增内容标记

若用户要求看得出新增内容：

- 用浅黄色高亮；
- 不要改变文字颜色；
- 脚注号本身不要高亮；
- 定稿时可批量移除高亮。

## 4. 不要破坏

- 原有脚注 ID；
- 原有 page fields；
- headers/footers；
- section breaks；
- numbering definitions；
- hyperlinks/bookmarks。

