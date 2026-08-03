import { execFileSync } from 'node:child_process'

export type SystemProxy = {
  HTTP_PROXY?: string
  HTTPS_PROXY?: string
  NO_PROXY?: string
}

const NO_PROXY_EXCEPTIONS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '*.local',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16'
].join(',')

/**
 * Detect the macOS system proxy. The login window (Chromium) honours the
 * system proxy automatically, but the codex binary we spawn for the OAuth
 * token exchange only reads environment variables. If we don't mirror the
 * system proxy into the codex process env, a user on a proxy-based VPN can
 * finish the browser login and then fail the token exchange with
 * `error sending request`. Returns null when no system proxy is configured.
 */
export function detectMacSystemProxy(): SystemProxy | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 5_000
    })
    const lineOf = (key: string): string => {
      const line = out.split('\n').find((l) => l.trim().startsWith(key))
      return line ?? ''
    }
    const enabled = (key: string): boolean => /:\s*(?:1|true)\s*$/i.test(lineOf(key))
    const host = (key: string): string => {
      const line = lineOf(key)
      return line ? line.split(':').slice(1).join(':').trim() : ''
    }
    const port = (key: string): string => {
      const match = lineOf(key).match(/:\s*(\d+)\s*$/)
      return match ? match[1] : ''
    }
    const proxyFor = (enableKey: string, hostKey: string, portKey: string): string | undefined => {
      if (!enabled(enableKey)) return undefined
      const h = host(hostKey)
      const p = port(portKey)
      return h && p ? `http://${h}:${p}` : undefined
    }
    const http = proxyFor('HTTPEnable', 'HTTPProxy', 'HTTPPort')
    const https = proxyFor('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort')
    if (!http && !https) return null
    return {
      ...(http ? { HTTP_PROXY: http } : {}),
      ...(https ? { HTTPS_PROXY: https } : {}),
      NO_PROXY: NO_PROXY_EXCEPTIONS
    }
  } catch {
    return null
  }
}

/**
 * Detect the Windows system proxy from the IE/registry settings. This covers
 * the common "system proxy" VPN setup (Clash, v2rayN, etc.) that writes the
 * proxy into the registry. Returns null when nothing is configured.
 */
export function detectWindowsSystemProxy(): SystemProxy | null {
  if (process.platform !== 'win32') return null
  try {
    const reg = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true }
    )
    const valueOf = (name: string): string => {
      const line = reg.split('\n').find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase()))
      const match = line?.match(/\s(\S+)\s*$/)
      return match ? match[1] : ''
    }
    if (valueOf('ProxyEnable') !== '0x1') return null
    const server = valueOf('ProxyServer')
    if (!server) return null
    const proxy = server.includes('://')
      ? server
      : `http://${server}`
    const bypass = valueOf('ProxyOverride')
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ...(bypass ? { NO_PROXY: bypass } : { NO_PROXY: NO_PROXY_EXCEPTIONS })
    }
  } catch {
    return null
  }
}

/**
 * Detect the system proxy for the current platform, if any. Used to inject
 * HTTP(S)_PROXY into spawned codex processes so the OAuth token exchange can
 * reach OpenAI through the user's proxy-based VPN.
 */
export function detectSystemProxy(): SystemProxy | null {
  if (process.platform === 'darwin') return detectMacSystemProxy()
  if (process.platform === 'win32') return detectWindowsSystemProxy()
  return null
}
