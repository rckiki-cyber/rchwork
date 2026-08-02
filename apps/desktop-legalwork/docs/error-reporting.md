# 错误自动上报（GitHub Issues）

Legalwork 自动、无感地收集用户电脑上的报错，作者（发布者）在**自己的 GitHub 仓库 issues** 里查看。用户不需要做任何操作，也不需要 GitHub 账号。

## 原理

App 主进程在以下情况触发上报：

- 所有 `logError(...)` 调用点（自动 hook，无需逐点改）
- `uncaughtException` / `unhandledRejection`（main 进程全局捕获）
- 渲染进程崩溃 `render-process-gone`
- 子进程崩溃 `child-process-gone`（含 legalwork runtime）

上报 payload 只含**隐私安全**的错误摘要：
`deviceId`、`version`、`platform`、`arch`、`appId`、`category`、`message`（≤500 字符）、`stack`（≤2000 字符）、`dedupKey`。
**绝不含**用户文档/案件内容、日志全文、`detail` 原样内容。

去重：同一会话内相同错误（category+message 的 hash）只上报一次。
限流：每 10 分钟最多 10 条，防止刷屏你的仓库。

## 需要你在打包/分发前配置（3 个环境变量）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `LEGALWORK_ERROR_REPORT_GITHUB_REPO` | 收报错的仓库 `owner/repo` | `xiangyang/legalwork-reports` |
| `LEGALWORK_ERROR_REPORT_GITHUB_TOKEN` | 最小权限 token（见下） | `ghp_...` |
| `LEGALWORK_ERROR_REPORT_GITHUB_LABEL` | 可选，建 issue 打的标签，逗号分隔 | `bug-report`（默认） |

不配置任何变量 → App 完全不上报（发布者零配置 = 零外发，合规兜底）。

> 也可以不用 GitHub：配置 `LEGALWORK_ERROR_REPORT_URL=<任意能收 POST 的地址>`，App 会把同一个 payload POST 过去（Cloudflare Worker、自建接口等均可）。两种方式二选一，GitHub 优先。

## 创建最小权限 token（重要，安全要求）

⚠️ **不要**用你的主 token（`gh auth token` 或全权限 PAT）——它会随 App 分发到每个用户机器，被提取 = 你的 GitHub 账户风险。必须用**最小权限专用 token**：

1. GitHub → Settings → Developer settings → **Personal access tokens** → **Generate new token (classic)**。
2. **Scope 只勾一项**：`repo`（或更细的 `public_repo`，若收报错仓库是 public）。
3. 作用域限定：只在你用来收报错的仓库上用；不要给它其他权限。
4. 记下 token，打包时注入；一旦担心泄露，随时去设置里 **Revoke**，App 立刻失去上报能力，你的账户安全。

## 打包时注入环境变量

token 通过环境变量注入，**不要硬编码进源码 / 提交到 git**。示例：

```bash
export LEGALWORK_ERROR_REPORT_GITHUB_REPO="xiangyang/legalwork-reports"
export LEGALWORK_ERROR_REPORT_GITHUB_TOKEN="ghp_xxx"
npm run build   # 或 electron-builder，取决于你的发布流程
```

### GitHub Actions（release.yml 已接好，你只需配 3 个 repo secrets）

仓库 Settings → **Secrets and variables** → Actions → New repository secret：

| Secret | 值 |
| --- | --- |
| `ERROR_REPORT_REPO` | 收报错仓库，如 `your-account/legalwork-reports` |
| `ERROR_REPORT_TOKEN` | 上面的最小权限 token（只 issues:write） |
| `ERROR_REPORT_LABEL` | 可选，issue 标签，如 `bug-report` |

release workflow 的 macOS / Windows / Linux 三个 build job 已把这三个 secret 注入 `LEGALWORK_ERROR_REPORT_*` 环境变量，构建时自动烧进 App。**配好 secrets 后无需改代码**。

## 查看报错

打开收报错的仓库 → Issues 页，每条自动生成的 issue 就是一条报错，含 `bug-report` 标签、错误摘要 JSON、对应机器 deviceId 与版本。可按 `label:bug-report` 过滤，或按 `deviceId` 查看同一台机器的多次报错。

## 说明

- 上报是 **fire-and-forget**：失败被吞掉，绝不影响 App 运行。
- 上报失败（如用户离线、GitHub 不可达）不会重试，避免堆积；下一条错误仍会尝试上报。
