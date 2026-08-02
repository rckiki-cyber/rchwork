# GitHub 下载镜像列表与排查方法

## 用途

`legalwork-landing.html` 的"备用下载链接"按钮用 GitHub 镜像解决国内用户不连 VPN 无法从 GitHub 下载安装包的问题。按钮点击时会自动遍历 `GH_MIRRORS` 列表，探测到第一个能下载的镜像自动跳转。

## 当前可用镜像（2026-08-02 实测）

```js
const GH_MIRRORS = [
    'https://ghfast.top/',
    'https://ghproxy.net/',
    'https://gh-proxy.com/',
    'https://cors.isteed.cc/'
];
```

这 4 个是实测**能真正下载文件**（HTTP 206 + 返回真实文件数据）的镜像，已配置上线。

## 排查/更新方法

镜像会失效，需定期验证。用真实安装包 URL 测试：

```bash
# 用真实安装包 URL（GitHub Release 上的 dmg）
RELEASE_URL="https://github.com/sunyifeisb-art/legalwork/releases/download/v0.3.10/legalwork-0.3.10-mac-arm64.dmg"

# 测试镜像能否下载文件（关键：-r 0-255 只取前 256 字节，返回 206 + 真实数据才算可用）
curl -s -L --max-time 12 -r 0-255 "<镜像域名>/${RELEASE_URL}" -o /tmp/t.bin -w "HTTP %{http_code}\n"
head -c4 /tmp/t.bin | xxd
# 可用：HTTP 206，前 4 字节是 78da（gzip 魔数，真实文件）
# 不可用：HTTP 200 + 前 4 字节是 <!DO 或 <!--（返回的是 HTML 页面，不是文件）
# 连不上：HTTP 000
```

## 判断标准

| 结果 | 含义 |
|---|---|
| HTTP 206 + 前4字节 `78da` | ✅ 真下载，可用 |
| HTTP 200 + 前4字节 `<!DO`/`<!--` | ❌ 返回 HTML 页，不可用 |
| HTTP 000 | ❌ 连不上 |
| HTTP 429 | ❌ 限流，不稳定 |

## 更新步骤

1. 改 `legalwork-landing.html` 里 `GH_MIRRORS` 数组（增删镜像）。
2. 部署：`cd /Users/xiangyang/Desktop/legalwork-landing-deploy && cp /Users/xiangyang/Desktop/legalwork/legalwork-landing.html index.html && vercel --prod --yes`。
3. 用上面方法验证线上 `https://bytelegal.cn` 生效。

## 已知不可用镜像（避免重复测试）

ghproxy.cc、mirror.ghproxy.com、ghps.cc、gh.ddlc.top、github.moeyy.xyz、ghp.ci、gh2.anoyi.com、ghproxy.eu.org、ghps.tk、ghproxy.link、gitlab.moe、ghproxy.cn、gh-proxy.net、gh.jasonzeng.dev、gh.llkk.cc、gh.xiu2.xyz 等。
