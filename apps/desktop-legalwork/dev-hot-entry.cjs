// legalwork 热更新入口（仅打包版使用，2026-08-12 新增）
//
// 原理：asar 内的 main 指向本 loader。启动时优先加载外部最新的
// out/main/index.cjs（npm run build 的产物），实现"改代码 → 重启即最新"，
// 同时保持打包环境（app.isPackaged === true），MCP / skills / OCR 等资源
// 仍走打包分支，功能与正式版一致。
//
// 外部目录不存在（例如正式发布版分发到其他机器）时，回退到 asar 内的
// out/main/index.cjs，行为与旧版完全相同。

const fs = require('node:fs')
const path = require('node:path')

// 本地开发工作区的最新编译产物；可用环境变量 LEGALWORK_HOT_OUT 覆盖
const EXTERNAL_OUT =
  process.env.LEGALWORK_HOT_OUT || '/Users/xiangyang/Desktop/legalwork/apps/desktop-legalwork/out'

const externalMain = path.join(EXTERNAL_OUT, 'main', 'index.cjs')

if (fs.existsSync(externalMain)) {
  module.exports = require(externalMain)
} else {
  module.exports = require('./out/main/index.cjs')
}
