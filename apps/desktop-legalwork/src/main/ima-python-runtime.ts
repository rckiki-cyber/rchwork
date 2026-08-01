import { join } from 'node:path'

export function imaStandalonePythonCandidates(
  userDataDir: string,
  legalworkDataDir: string,
  platform: NodeJS.Platform
): string[] {
  const executable = platform === 'win32' ? 'python.exe' : join('bin', 'python3')
  return [
    join(userDataDir, 'data-compliance', 'python-standalone', executable),
    join(legalworkDataDir, 'data-compliance', 'python-standalone', executable)
  ]
}
