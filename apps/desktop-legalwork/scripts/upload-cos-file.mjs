#!/usr/bin/env node
// 通用:把单个文件上传到腾讯云 COS(public-read),用于发布便携 ZIP 等非 publish-r2 产物。
// 用法: node scripts/upload-cos-file.mjs <本地文件> <COS key>
// COS 配置来自 release.local.env 或下列环境变量(S3_*/R2_* 均可)。
import { readFileSync, createReadStream } from 'node:fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

function loadEnvFile(path) {
  const map = {}
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)\s*$/)
      if (m) map[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch { /* ignore */ }
  return map
}

const env = loadEnvFile(process.env.LEGALWORK_RELEASE_ENV || 'scripts/release.local.env')
const bucket = process.env.COS_BUCKET || env.S3_BUCKET || env.R2_BUCKET
const accessKeyId = process.env.COS_SECRET_ID || env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.COS_SECRET_KEY || env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY
const endpoint = process.env.COS_ENDPOINT || 'https://cos.ap-guangzhou.myqcloud.com'
const region = env.S3_REGION || 'ap-guangzhou'

if (!bucket || !accessKeyId || !secretAccessKey) {
  console.error('缺少 COS 配置(S3_BUCKET/ACCESS_KEY/SECRET)'); process.exit(1)
}

const [, , file, key] = process.argv
if (!file || !key) { console.error('用法: node scripts/upload-cos-file.mjs <本地文件> <COS key>'); process.exit(1) }

const client = new S3Client({
  region, endpoint, forcePathStyle: false,
  credentials: { accessKeyId, secretAccessKey }
})

const size = readFileSync(file).length
console.log(`上传 cos://${bucket}/${key} (${(size / 1048576).toFixed(1)} MiB)`)
await client.send(new PutObjectCommand({
  Bucket: bucket, Key: key,
  Body: createReadStream(file),
  ContentType: key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
  ACL: 'public-read', ContentLength: size,
  CacheControl: 'public, max-age=31536000, immutable'
}))
console.log(`✅ 上传完成\n下载地址: https://${bucket}.cos.ap-guangzhou.myqcloud.com/${key}`)
