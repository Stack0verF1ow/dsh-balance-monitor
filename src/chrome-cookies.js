/**
 * chrome-cookies.js — Read cookies from Chromium-based browsers.
 *
 * Strategy:
 * 1. CDP (Chrome DevTools Protocol) — reads cookies via the browser's debug port.
 *    Works when the browser is open and has remote debugging enabled.
 * 2. SQLite — reads from the browser's Cookies database file directly.
 *    Works on all platforms, may fail if the DB is locked (browser open on Windows).
 *
 * Supports Chrome, Edge, Brave, Vivaldi, Opera on Windows / macOS / Linux.
 */

import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// CDP-based cookie reading (primary method)
// ---------------------------------------------------------------------------

const CDP_PORTS = [9222, 9229, 9333]

/**
 * Read cookies from the browser via CDP (Chrome DevTools Protocol).
 * Requires the browser to be running with remote debugging enabled.
 * Returns the cookie string or null.
 */
async function readCookiesViaCdp(domain) {
  for (const port of CDP_PORTS) {
    try {
      const cookies = await getCookiesFromCdpPort(port, domain)
      if (cookies) return cookies
    } catch {
      // Try next port
    }
  }
  return null
}

function getCookiesFromCdpPort(port, domain) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser`)
    let cmdId = 0
    const pending = new Map()
    let sessionId = null
    let resolved = false

    const cleanup = () => {
      try { ws.close() } catch {}
    }

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; cleanup(); resolve(null) }
    }, 8000)

    const done = (result) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); cleanup(); resolve(result) }
    }

    const fail = () => {
      if (!resolved) { resolved = true; clearTimeout(timeout); cleanup(); resolve(null) }
    }

    ws.onopen = () => {
      // Get list of targets
      ws.send(JSON.stringify({ id: ++cmdId, method: 'Target.getTargets' }))
    }

    ws.onerror = fail

    ws.onmessage = (msg) => {
      let data
      try { data = JSON.parse(msg.data) } catch { return }

      // Handle pending CDP responses
      if (data.id && pending.has(data.id)) {
        pending.get(data.id)(data)
        pending.delete(data.id)
        return
      }

      // Handle Target.getTargets response
      if (data.id === 1 && data.result?.targetInfos) {
        // Find a target with the matching domain
        const target = data.result.targetInfos.find(t =>
          t.type === 'page' && t.url.includes(domain)
        )
        if (!target) {
          // No matching tab found, try to create one
          ws.send(JSON.stringify({
            id: ++cmdId,
            method: 'Target.createTarget',
            params: { url: `https://${domain}`, background: true }
          }))
          pending.set(cmdId, (resp) => {
            if (resp.result?.targetId) {
              attachToTarget(ws, resp.result.targetId, domain, cmdId, pending, done, fail)
            } else {
              fail()
            }
          })
        } else {
          attachToTarget(ws, target.targetId, domain, cmdId, pending, done, fail)
        }
      }
    }
  })
}

function attachToTarget(ws, targetId, domain, cmdId, pending, done, fail) {
  // Attach to the target
  ws.send(JSON.stringify({
    id: ++cmdId,
    method: 'Target.attachToTarget',
    params: { targetId, flatten: true }
  }))
  pending.set(cmdId, (resp) => {
    const sid = resp.result?.sessionId
    if (!sid) { fail(); return }

    // Enable Network domain
    ws.send(JSON.stringify({
      id: ++cmdId, sessionId: sid,
      method: 'Network.enable', params: {}
    }))
    pending.set(cmdId, () => {
      // Get cookies
      ws.send(JSON.stringify({
        id: ++cmdId, sessionId: sid,
        method: 'Network.getCookies',
        params: { urls: [`https://${domain}`] }
      }))
      pending.set(cmdId, (cookieResp) => {
        if (cookieResp.result?.cookies && cookieResp.result.cookies.length > 0) {
          const cookieStr = cookieResp.result.cookies
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
          done(cookieStr)
        } else {
          fail()
        }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// SQLite-based cookie reading (fallback method)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

const BROWSER_PATHS = {
  win32: [
    { name: 'Chrome',  base: join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data') },
    { name: 'Edge',    base: join(homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data') },
    { name: 'Brave',   base: join(homedir(), 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { name: 'Vivaldi', base: join(homedir(), 'AppData', 'Local', 'Vivaldi', 'User Data') },
    { name: 'Opera',   base: join(homedir(), 'AppData', 'Roaming', 'Opera Software', 'Opera Stable') },
  ],
  darwin: [
    { name: 'Chrome',  base: join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome') },
    { name: 'Edge',    base: join(homedir(), 'Library', 'Application Support', 'Microsoft Edge') },
    { name: 'Brave',   base: join(homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser') },
    { name: 'Vivaldi', base: join(homedir(), 'Library', 'Application Support', 'Vivaldi') },
    { name: 'Opera',   base: join(homedir(), 'Library', 'Application Support', 'com.operasoftware.Opera') },
  ],
  linux: [
    { name: 'Chrome',  base: join(homedir(), '.config', 'google-chrome') },
    { name: 'Chromium', base: join(homedir(), '.config', 'chromium') },
    { name: 'Edge',    base: join(homedir(), '.config', 'microsoft-edge') },
    { name: 'Brave',   base: join(homedir(), '.config', 'BraveSoftware', 'Brave-Browser') },
    { name: 'Vivaldi', base: join(homedir(), '.config', 'vivaldi') },
    { name: 'Opera',   base: join(homedir(), '.config', 'opera') },
    { name: 'Zen',     base: join(homedir(), '.config', 'zen') },
    { name: 'LibreWolf', base: join(homedir(), '.config', 'librewolf') },
  ],
}

function findCookieDbs() {
  const p = platform()
  const browsers = BROWSER_PATHS[p] || []
  const results = []
  for (const browser of browsers) {
    // Try common profile subdirectories
    for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
      let dbPath
      if (p === 'win32') {
        dbPath = join(browser.base, profile, 'Network', 'Cookies')
        if (!existsSync(dbPath)) dbPath = join(browser.base, profile, 'Cookies')
      } else {
        dbPath = join(browser.base, profile, 'Cookies')
      }
      if (existsSync(dbPath)) {
        results.push({ browser: browser.name, profile, path: dbPath })
      }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

function getEncryptionKey() {
  const p = platform()
  if (p === 'linux') {
    // Linux: Chrome uses 'peanuts' as the password (PBKDF2, 1 iteration, salt='saltysalt')
    return pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
  }
  if (p === 'darwin') {
    // macOS: Keychain stores the key; we'd need `security find-generic-password`
    // For now, try the default Chrome Safe Storage key
    try {
      const { execSync } = require('node:child_process')
      const keyB64 = execSync(
        'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome" 2>/dev/null || ' +
        'security find-generic-password -w -s "Chromium Safe Storage" -a "Chromium" 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      ).trim()
      if (keyB64) return pbkdf2Sync(keyB64, 'saltysalt', 1003, 16, 'sha1')
    } catch {}
    return pbkdf2Sync('peanuts', 'saltysalt', 1003, 16, 'sha1')
  }
  // Windows: DPAPI — we'll handle this separately in decryptValue
  return null
}

function decryptValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return ''

  const p = platform()

  if (p === 'win32') {
    // Windows: v10 prefix + AES-256-GCM with key from Local State
    // For simplicity, try DPAPI via PowerShell
    try {
      const { execSync } = require('node:child_process')
      // Extract the encrypted data (skip 'v10' or 'v20' prefix)
      const data = encryptedValue.slice(3)
      const b64 = Buffer.from(data).toString('base64')
      // Use DPAPI to decrypt
      const result = execSync(
        `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${b64}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim()
      return result
    } catch {
      return ''
    }
  }

  // macOS / Linux: AES-128-CBC with v10 prefix
  const prefix = encryptedValue.slice(0, 3).toString('ascii')
  if (prefix !== 'v10' && prefix !== 'v20') return ''

  const iv = Buffer.alloc(16, ' ')
  const encrypted = encryptedValue.slice(3)
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    let decrypted = decipher.update(encrypted)
    decrypted = Buffer.concat([decrypted, decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// SQLite reader
// ---------------------------------------------------------------------------

function readCookiesFromDb(dbPath, domain) {
  // Try node:sqlite first (Node 22+)
  let db = null
  try {
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true })
    // Check if cookies table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'"
    ).get()
    if (!tableCheck) return null

    const rows = db.prepare(
      "SELECT name, encrypted_value, host_key FROM cookies WHERE host_key LIKE ?"
    ).all(`%${domain}%`)
    return rows
  } catch (err) {
    // DB might be locked (Chrome open on Windows), try copying
  } finally {
    try { if (db) db.close() } catch {}
  }

  // Fallback: copy the file (Windows locks it while Chrome is open)
  try {
    const tmpPath = join(tmpdir(), `cookies-copy-${randomBytes(4).toString('hex')}.db`)
    copyFileSync(dbPath, tmpPath)
    let tmpDb = null
    try {
      const { DatabaseSync } = require('node:sqlite')
      tmpDb = new DatabaseSync(tmpPath, { readOnly: true })
      const rows = tmpDb.prepare(
        "SELECT name, encrypted_value, host_key FROM cookies WHERE host_key LIKE ?"
      ).all(`%${domain}%`)
      return rows
    } finally {
      try { if (tmpDb) tmpDb.close() } catch {}
      try { require('node:fs').unlinkSync(tmpPath) } catch {}
    }
  } catch {}

  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to read MiMo cookies from the system browser.
 * Strategy: CDP first (works when browser is open), then SQLite fallback.
 * Returns the cookie string (e.g. "api-platform_serviceToken=xxx; userId=yyy")
 * or null if not found.
 */
export async function readMimoCookie(domain = 'xiaomimimo.com') {
  // Strategy 1: CDP (works when browser is open with remote debugging)
  const cdpCookie = await readCookiesViaCdp(domain)
  if (cdpCookie) return cdpCookie

  // Strategy 2: SQLite (works when browser is closed or on Linux/macOS)
  const dbs = findCookieDbs()
  if (dbs.length === 0) return null

  const key = getEncryptionKey()

  for (const dbInfo of dbs) {
    try {
      const rows = readCookiesFromDb(dbInfo.path, domain)
      if (!rows || rows.length === 0) continue

      const parts = []
      for (const row of rows) {
        const value = decryptValue(row.encrypted_value, key)
        if (value) {
          parts.push(`${row.name}=${value}`)
        }
      }

      if (parts.length > 0) return parts.join('; ')
    } catch {
      continue
    }
  }

  return null
}

/**
 * List discovered browsers (for diagnostics).
 */
export function listBrowsers() {
  return findCookieDbs().map(d => `${d.browser} (${d.profile})`)
}
