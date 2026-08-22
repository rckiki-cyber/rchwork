/**
 * Read-only navigation/probe endpoints can fail transiently while the managed
 * runtime is starting or restarting. Callers still receive the failure, but
 * these paths should not create automatic incident reports. Mutating requests
 * are filtered separately by method at the call site.
 */
export function isRuntimeProbePath(pathAndQuery: string): boolean {
  const pathname = pathAndQuery.split('?')[0] ?? ''
  return (
    pathname === '/health' ||
    pathname === '/v1/runtime/info' ||
    pathname === '/v1/runtime/tools' ||
    pathname === '/v1/threads' ||
    pathname.startsWith('/v1/threads/') ||
    pathname === '/v1/memory' ||
    pathname === '/v1/usage' ||
    pathname === '/v1/knowledge/tree' ||
    pathname.startsWith('/data-compliance/')
  )
}
