# office MCP 问题诊断报告

> 日期：2026-08-08
> 适用范围：legalwork 桌面端 Office 文档任务（docx 生成/编辑/格式调整）
> 状态：诊断完成，已实施「MCP 大输出截断」修复，替换方案待决策

---

## 一、问题现象

用户反馈：**凡是涉及 Office 文档的任务（生成、改格式、编辑），都会执行十几分钟、几十上百个步骤、消耗 4-5 元 token，还经常解决不了。**

典型例子（真实轨迹 `thr_ilh9r3d2`）：改一个文字格式（页边距），agent 跑了 4 个 turn、47 个模型响应步、48 次工具调用，累计 **485 万 token**，花费 **¥4.26**，最终还中断重来了一次（turn aborted）。

---

## 二、数据实证（来自真实 traj）

### 2.1 工具调用分布

| 指标 | 数值 |
|---|---|
| 工具调用总数 | 48 次 |
| **office MCP 调用** | **38 次（79%）** |
| 其中 create | 3 次 |
| 其中 rm（删除重做） | 2 次 |
| 其中 view html | 1 次（返回完整文档 HTML） |
| 其中 help docx | 1 次（还在查语法） |
| 其中 set / batch / add | 约 20 次 |

### 2.2 Token 消耗曲线

| 步数 | 累计 prompt token | 单次增量 |
|---|---|---|
| 步 1 | 42,993 | 42,993 |
| 步 5 | 323,381 | ~81,000 |
| 步 10 | 732,697 | ~82,000 |
| 步 20 | 1,649,356 | ~95,000 |
| 步 47 | 4,724,345 | ~127,000 |

**单次请求从 4.3 万 token 一路涨到 12.7 万**——每步都在变大。

### 2.3 成本

- 累计 ¥4.26（单次文档格式任务）
- 4 个 turn 里 1 个被中断（aborted）重来

---

## 三、根因分析

### 3.1 直接原因 1：office 工具大输出进 history（已修复）

`view html` 命令返回**整个文档渲染后的完整 HTML**（几十 KB）作为 tool_result 进对话历史。后续每次请求都把这几十 KB 重发给模型，单次 prompt 从 4.3 万一路涨到 12.7 万。

**这是"成本高"和"上下文大"的直接原因。**

✅ **已实施修复**：MCP 工具文本输出超过 8000 字符自动截断（保留头尾，中间省略标注），`view html` 的大 HTML 不再全量进 history。预计单次请求可从 8-9 万降到 1-2 万 token。

### 3.2 直接原因 2：模型不会用 officecli（未修复，需另治）

轨迹显示模型反复：
- `help docx section` 查命令语法（第 30 步还在查）
- `create` 一个文档 → 不满意 → `rm` 删掉 → 重新 `create`
- `view html` 这种"重工具"查看格式（返回超大 HTML）
- 对 batch 用法不熟，多次单条 set/add 而非合并

**这是"步骤多"和"执行任务复杂化"的直接原因。**

即使截断了输出，模型仍会试错很多步（每步都调 office，产生新 turn 和请求）。**光截断不够。**

### 3.3 间接原因：office MCP 的工具模型设计

officecli 是一个"命令字符串"式 MCP 工具（一个 `command` 字段塞整条 CLI 命令）。这种设计对模型不友好：
- 模型容易拆参漏参（代码里有 `normalizeOfficeCliArguments` 专门修复这个问题，说明高频发生）
- 语法复杂（`batch` 有结构化/argv 两种形式），模型需要 help 现学
- 输出不可控（view 返回完整 HTML）

---

## 四、替换方案评估：office MCP → Python 文档 skill

### 4.1 替换后能解决什么

| 问题 | office MCP | Python skill |
|---|---|---|
| 步骤多 | 模型试错 38 次 | **少**：一条 `python script.py` 完成全部操作 |
| 成本高 | 每次调用 + 大输出进 history | **低**：本地处理，输出可控（打印摘要） |
| 上下文大 | view html 返回几十 KB | **小**：只回传操作结果/摘要 |
| 任务复杂化 | 模型要懂 officecli 语法 | **简单**：skill 内置成熟脚本 |

**核心收益**：把"模型现场操作 docx"（试错、查语法、大输出）变成"模型调用一个写好的 Python 脚本"（一次性执行，输出小）。

### 4.2 需要增加的环境

替换需要准备一套 **Python 文档处理环境**。legalwork 已有部分基础：

| 依赖 | 用途 | 状态 |
|---|---|---|
| `python-docx` | 生成/编辑 .docx（段落、表格、样式、页边距、字体） | ✅ 系统 python3 已有 |
| `python-pptx` | 生成/编辑 .pptx | ✅ 脱敏环境依赖里有 |
| `openpyxl` | 生成/编辑 .xlsx | ✅ 脱敏环境依赖里有 |
| `reportlab` / `fpdf` | PDF 生成 | ❌ 需确认 |
| `python-docx` 的样式/字体细节 | 中文字体（宋体/黑体）、页边距、段落格式 | ✅ python-docx 支持 |

**关键问题**：legalwork 打包后用的是**独立 Python 运行时**（脱敏功能的 `python-standalone`），不是系统 python3。所以替换方案需要：

1. **把 python-docx / python-pptx / openpyxl 装进 legalwork 的独立 Python 环境**（`~/.legalwork/.../python-standalone` 或脱敏 venv）
2. 或写一个 **skill**（如 `document-format-skill`），skill 内带 Python 脚本 + 依赖说明，运行时自动 pip install

### 4.3 skill 方案设计（建议）

```
skills/document-formatting/
├── SKILL.md          # 说明能力：生成/编辑 docx、设置字体/页边距/样式、转格式
├── scripts/
│   ├── create_docx.py     # 参数化创建文档（标题、段落、表格、页边距）
│   ├── edit_docx.py       # 编辑已有文档（改字体、改页边距、增删段落）
│   └── inspect_docx.py    # 检查文档内容/格式（输出结构化摘要，替代 view html）
└── requirements.txt  # python-docx, python-pptx, openpyxl
```

**skill 工作方式**：
- 模型用 bash 跑 `python3 edit_docx.py --file xxx.docx --margin-top 2.54cm` 之类
- 脚本本地执行，只打印结构化结果（成功/失败/摘要），不输出大段 HTML
- 相比 office MCP：**步骤从 38 次降到 2-3 次，输出从几十 KB 降到几百字符**

### 4.4 需要处理的风险

| 风险 | 说明 | 对策 |
|---|---|---|
| Python 环境依赖 | 打包后无 python-docx | skill 内置 `pip install -r requirements.txt` 或随安装包预装 |
| 复杂排版能力 | 页眉页脚、域、批注、修订（track-change）python-docx 支持有限 | 保留 office MCP 作为**复杂场景兜底**（track-change 等） |
| 模型写脚本出错 | 模型现场写 Python 也可能有 bug | skill 内置**成熟脚本**（参数化），模型只需传参数，不写逻辑 |
| 旧文档兼容 | .doc（97-2003）python-docx 不支持 | 用 libreoffice headless 转 .doc→.docx，或保留 MCP |

### 4.5 建议：混合策略（不是二选一）

**推荐保留 office MCP + 新增 Python skill，按场景路由：**

| 场景 | 用谁 |
|---|---|
| 常规生成/编辑（段落、字体、页边距、表格） | **Python skill**（快、省、稳） |
| 需要 track-change / 修订 / 复杂域 / .doc 老格式 | **office MCP**（兜底） |
| 只是"看下文档内容" | **Python skill** 的 inspect（结构化摘要，替代 view html） |

---

## 五、结论与建议

1. **成本高/上下文大**：已修复（MCP 输出截断），单次请求预计降 5-8 倍
2. **步骤多/任务复杂化**：根因是模型不会用 officecli，**截断解决不了，需要换工具或教模型**
3. **替换方案可行**：写一个 `document-formatting` Python skill（python-docx 等），内置成熟脚本，模型传参即用
4. **不建议彻底删除 office MCP**：track-change / 老格式等复杂场景仍需它兜底

### 推荐下一步
1. 落地 `document-formatting` skill（python-docx 脚本 + SKILL.md）
2. 把 python-docx 等装进 legalwork 独立 Python 环境（或 skill 内自动装）
3. 工具描述里引导模型"常规文档操作用 document-formatting skill，复杂修订用 office MCP"
4. 观察一个文档任务的 token/步数对比，验证效果
