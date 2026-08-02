#!/usr/bin/env node
/**
 * Generate error-report.config.json for the packaged app.
 *
 * The packaged app is launched by double-click (no shell environment), so the
 * error-report destination cannot rely on runtime env vars. This script reads
 * the publisher's release env and writes a config file that electron-builder
 * bundles into app resources via extraResources. The app reads it at runtime.
 *
 * When no report env vars are configured, an empty config is written so the
 * build never fails on a missing file AND the app stays silent (no reporting).
 *
 * Env vars (set in release.local.env or CI secrets):
 *   LEGALWORK_ERROR_REPORT_GITHUB_REPO   e.g. "owner/legalwork-reports"
 *   LEGALWORK_ERROR_REPORT_GITHUB_TOKEN   minimal-privilege token (issues:write only)
 *   LEGALWORK_ERROR_REPORT_GITHUB_LABEL   comma-separated labels (default "bug-report")
 *   LEGALWORK_ERROR_REPORT_URL            alternative generic POST endpoint
 */
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const OUTPUT = join(ROOT, 'error-report.config.json')

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = String(value ?? '').trim()
    if (trimmed) return trimmed
  }
  return ''
}

const config = {
  githubRepo: firstNonEmpty(process.env.LEGALWORK_ERROR_REPORT_GITHUB_REPO),
  githubToken: firstNonEmpty(process.env.LEGALWORK_ERROR_REPORT_GITHUB_TOKEN),
  githubLabels: firstNonEmpty(
    process.env.LEGALWORK_ERROR_REPORT_GITHUB_LABEL
  ).split(',').map((s) => s.trim()).filter(Boolean),
  endpoint: firstNonEmpty(process.env.LEGALWORK_ERROR_REPORT_URL)
}

// Strip empty entries so the runtime treats absent fields as "not configured".
const normalized = {}
for (const [key, value] of Object.entries(config)) {
  if (Array.isArray(value) ? value.length > 0 : value) {
    normalized[key] = value
  }
}

writeFileSync(OUTPUT, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

const dest = normalized.githubRepo
  ? `repo=${normalized.githubRepo} token=${(normalized.githubToken || '').slice(0, 4)}…`
  : normalized.endpoint
    ? `endpoint=${normalized.endpoint}`
    : 'disabled (no report destination configured)'
console.log(`[error-report-config] ${dest}`)
