// Open a local file with the app that owns it, so a group chat's file chip shows the
// file instead of making the reader download a copy first. The host is on the user's
// machine, so the app opens on it; fire and forget, since a launcher's exit code says
// nothing on Windows (explorer.exe reports 1 on success too).
import { spawn } from 'node:child_process'

export function openExternally(path) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [path], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}
