import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'

const CANDIDATE_BROWSERS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    `${process.env['ProgramFiles'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
}

export function findSystemBrowser(): string | null {
  const candidates = CANDIDATE_BROWSERS[process.platform] ?? []
  return candidates.find((p) => p && existsSync(p)) ?? null
}

/** Chỉ cho phép ký tự an toàn để id không thể thoát khỏi thư mục profile (path traversal). */
function toSafeProfileName(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Mở trình duyệt thật (Chrome/Edge) với profile riêng cho từng nick.
 * Google tin trình duyệt thật nên đăng nhập 1 lần, profile giữ phiên lâu dài.
 * @returns true nếu đã mở, false nếu máy không có trình duyệt phù hợp.
 */
export function openInSystemBrowser(profilesRoot: string, accountId: string, url: string): boolean {
  const browserPath = findSystemBrowser()
  if (!browserPath) return false

  const profileDir = path.join(profilesRoot, toSafeProfileName(accountId))
  mkdirSync(profileDir, { recursive: true })

  const child = spawn(
    browserPath,
    [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', url],
    { detached: true, stdio: 'ignore' },
  )
  child.on('error', (err) => console.error('[SystemBrowser] launch failed:', err.message))
  child.unref()
  return true
}
