/**
 * dsh-balance-monitor — host half.
 *
 * Shows API balance in the DSH web UI:
 * - DeepSeek:  reads the DEEPSEEK_API_KEY credential from the DSH credential
 *              store (no key pasting needed) and calls the documented
 *              `GET https://api.deepseek.com/user/balance` endpoint. The API
 *              has no spend endpoint, so "今日花费" (today's spend) is derived
 *              from a persisted day baseline: the balance at the first
 *              successful fetch of each local day minus the current balance
 *              (stored alongside the MiMo config in $DSH_HOME).
 * - Xiaomi MiMo: optional cookie-based check against the MiMo platform API.
 *              The cookie and endpoint live in a small plugin-owned config
 *              file under $DSH_HOME, editable from the web settings page.
 *              The tokenPlan quota response also exposes used/limit counts,
 *              which the browser half renders as "已用 %".
 *
 * The browser half talks to this half over three same-origin HTTP routes
 * served from the shared `webServer` service:
 *   GET  /balance/api/state    -> current balances + configuration presence
 *   POST /balance/api/refresh  -> fetch now, return fresh state
 *   POST /balance/api/config   -> store MiMo cookie/endpoint, then refresh
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const inject = ['webServer']

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
// MiMo 平台已下线 /api/v1/user/balance，当前余额走 tokenPlan 配额接口（2026-08-16 实测 200）。
const DEFAULT_MIMO_URL = 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024

/** One HTTPS GET that resolves {status, text}; rejects only on transport errors. */
function httpJson(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (error) {
      reject(error)
      return
    }
    if (u.protocol !== 'https:') {
      reject(new Error(`only https endpoints are supported, got ${u.protocol}`))
      return
    }
    const req = httpsRequest({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dsh-balance-monitor/0.3',
        ...extraHeaders,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
        if (text.length > MAX_RESPONSE_BYTES) req.destroy(new Error('balance response too large'))
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`)))
    req.on('error', reject)
    req.end()
  })
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Local-timezone date key (YYYY-MM-DD) used for the "today" baseline. */
function localDateString(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Sanitize the persisted DeepSeek day baseline, or return null. */
function parseDayBaseline(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const entry = raw
  if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return null
  const balance = Number(entry.balance)
  if (!Number.isFinite(balance)) return null
  return { date: entry.date, balance }
}

function configFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'balance-monitor.json')
}

function loadConfig(log) {
  const path = configFilePath()
  try {
    if (!existsSync(path)) return { mimoCookie: '', mimoEndpoint: '', deepseekDayBaseline: null }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      mimoCookie: typeof raw.mimoCookie === 'string' ? raw.mimoCookie : '',
      mimoEndpoint: typeof raw.mimoEndpoint === 'string' ? raw.mimoEndpoint : '',
      deepseekDayBaseline: parseDayBaseline(raw.deepseekDayBaseline),
    }
  } catch (error) {
    log(new Error('balance-monitor: config load failed', { cause: error }))
    return { mimoCookie: '', mimoEndpoint: '', deepseekDayBaseline: null }
  }
}

export function apply(ctx) {
  const log = (error) => {
    const wrapped = error instanceof Error ? error : new Error(String(error))
    if (ctx.logger && typeof ctx.logger.error === 'function') ctx.logger.error(wrapped)
    else console.error('[balance-monitor]', wrapped)
  }

  // Read lazily per use: provider fibers finish async init after apply time,
  // so a service captured once at apply can be a stale `undefined`.
  const getCredentials = () => ctx.get('credentials')
  let config = loadConfig(log)

  /** In-memory state snapshot; JSON-safe by construction. */
  const state = {
    deepseek: null,
    deepseekError: null,
    mimo: null,
    mimoError: null,
    deepseekKeyConfigured: false,
    hasMimoCookie: false,
    mimoEndpoint: '',
    lastUpdated: null,
  }

  async function resolveCredential(name) {
    const credentials = getCredentials()
    if (credentials === undefined) return undefined
    try {
      const resolved = await credentials.resolve(name)
      return resolved === undefined || resolved.value === '' ? undefined : resolved.value
    } catch (error) {
      log(new Error(`balance-monitor: credential resolve failed for ${name}`, { cause: error }))
      return undefined
    }
  }

  async function fetchDeepSeek() {
    const key = await resolveCredential('DEEPSEEK_API_KEY')
    if (key === undefined) {
      state.deepseekKeyConfigured = false
      return { data: null, error: '未配置凭据 DEEPSEEK_API_KEY（DSH 凭据库）' }
    }
    state.deepseekKeyConfigured = true
    const { status, text } = await httpJson(DEEPSEEK_BALANCE_URL, {
      Authorization: `Bearer ${key}`,
    })
    if (status !== 200) {
      return { data: null, error: `HTTP ${status}` }
    }
    let d
    try {
      d = JSON.parse(text)
    } catch {
      return { data: null, error: '响应不是合法 JSON' }
    }
    const info = Array.isArray(d.balance_infos) ? d.balance_infos[0] : undefined
    const total = num(info && info.total_balance)

    // "今日花费": the balance at the first successful fetch of the local day
    // minus the current balance. A rollover (or missing baseline) snapshots the
    // current balance and persists it; a top-up mid-day can only push the delta
    // negative, which we clamp to 0.
    const today = localDateString()
    const baseline = config.deepseekDayBaseline
    let todaySpend = 0
    if (baseline !== null && baseline.date === today) {
      todaySpend = Math.max(0, baseline.balance - total)
    } else {
      config.deepseekDayBaseline = { date: today, balance: total }
      try {
        await persistConfig()
      } catch (error) {
        log(new Error('balance-monitor: day baseline persist failed', { cause: error }))
      }
    }

    return {
      data: {
        available: Boolean(d.is_available),
        currency: info && typeof info.currency === 'string' ? info.currency : 'CNY',
        total,
        granted: num(info && info.granted_balance),
        toppedUp: num(info && info.topped_up_balance),
        todaySpend,
      },
      error: null,
    }
  }

  async function fetchMimo() {
    const cookie = config.mimoCookie.trim()
    const endpoint = config.mimoEndpoint.trim() || DEFAULT_MIMO_URL
    state.hasMimoCookie = cookie !== ''
    state.mimoEndpoint = endpoint
    if (cookie === '') {
      return { data: null, error: '未配置 MiMo Cookie' }
    }
    const { status, text } = await httpJson(endpoint, { Cookie: cookie })
    if (status !== 200) {
      return { data: null, error: `HTTP ${status}` }
    }
    let d
    try {
      d = JSON.parse(text)
    } catch {
      return { data: null, error: '响应不是合法 JSON' }
    }
    // tokenPlan/usage 返回 { code, message, data: { usage: { items: [{name, used, limit}] },
    //   monthUsage: { items: [...] } } }；旧的 user/balance（d.balance 金额）已下线。
    if (d && typeof d.code === 'number' && d.code !== 0) {
      return { data: null, error: `API 错误: ${d.message || d.code}` }
    }
    const findItem = (section, name) => {
      const items = d && d.data && d.data[section] && Array.isArray(d.data[section].items)
        ? d.data[section].items
        : []
      return items.find((item) => item && item.name === name)
    }
    const plan = findItem('usage', 'plan_total_token')
    const month = findItem('monthUsage', 'month_total_token')
    const remaining = (item) => Math.max(0, num(item && item.limit) - num(item && item.used))
    // Some platform variants expose a daily usage row ("day_total_token");
    // detect it defensively so the UI can show today's token spend when present.
    const day = findItem('usage', 'day_total_token') || findItem('monthUsage', 'day_total_token')
    const dayFallback = day === undefined
      ? (() => {
          const sections = [d && d.data && d.data.usage, d && d.data && d.data.monthUsage]
          for (const section of sections) {
            if (!section || !Array.isArray(section.items)) continue
            const hit = section.items.find((item) => item && /day/i.test(String(item.name || '')))
            if (hit !== undefined) return hit
          }
          return undefined
        })()
      : undefined
    const dayItem = day !== undefined ? day : dayFallback
    return {
      data: {
        // token 配额制套餐已无现金余额，余额语义映射为剩余 token 数
        total: remaining(plan),
        currency: 'TOKEN',
        tokenPlan: remaining(plan),
        tokenPlanTotal: num(plan && plan.limit),
        tokenPlanUsed: num(plan && plan.used),
        monthPlan: remaining(month),
        monthPlanTotal: num(month && month.limit),
        monthPlanUsed: num(month && month.used),
        todayTokensUsed: num(dayItem && dayItem.used),
        todayTokensLimit: num(dayItem && dayItem.limit),
      },
      error: null,
    }
  }

  /** Serialized refresh: concurrent callers share one in-flight pass. */
  let refreshing = null
  function refresh() {
    if (refreshing !== null) return refreshing
    const pass = (async () => {
      const [deepseek, mimo] = await Promise.allSettled([fetchDeepSeek(), fetchMimo()])
      state.deepseek = deepseek.status === 'fulfilled' ? deepseek.value.data : null
      state.deepseekError = deepseek.status === 'fulfilled'
        ? deepseek.value.error
        : `DeepSeek 拉取失败: ${deepseek.reason instanceof Error ? deepseek.reason.message : String(deepseek.reason)}`
      state.mimo = mimo.status === 'fulfilled' ? mimo.value.data : null
      state.mimoError = mimo.status === 'fulfilled'
        ? mimo.value.error
        : `MiMo 拉取失败: ${mimo.reason instanceof Error ? mimo.reason.message : String(mimo.reason)}`
      state.lastUpdated = Date.now()
      return state
    })()
    refreshing = pass
    pass.then(
      () => { if (refreshing === pass) refreshing = null },
      () => { if (refreshing === pass) refreshing = null },
    )
    return pass
  }

  async function persistConfig() {
    const path = configFilePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      mimoCookie: config.mimoCookie,
      mimoEndpoint: config.mimoEndpoint,
      deepseekDayBaseline: config.deepseekDayBaseline,
    }, null, 2), { mode: 0o600 })
  }

  // ---- HTTP API for the browser half -------------------------------------

  function sendJson(res, code, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体过大')
        error.statusCode = 413
        throw error
      }
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      const error = new Error('请求体不是合法 JSON')
      error.statusCode = 400
      throw error
    }
  }

  const handler = async (req, res) => {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' })
      return
    }
    try {
      if (req.method === 'GET' && pathname === '/balance/api/state') {
        sendJson(res, 200, { ok: true, state })
        return
      }
      if (req.method === 'POST' && pathname === '/balance/api/refresh') {
        const fresh = await refresh()
        sendJson(res, 200, { ok: true, state: fresh })
        return
      }
      if (req.method === 'POST' && pathname === '/balance/api/config') {
        const body = await readJsonBody(req)
        if (typeof body.mimoCookie === 'string') config.mimoCookie = body.mimoCookie.slice(0, 8192)
        if (typeof body.mimoEndpoint === 'string') config.mimoEndpoint = body.mimoEndpoint.slice(0, 2048)
        await persistConfig()
        const fresh = await refresh()
        sendJson(res, 200, { ok: true, state: fresh })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const code = typeof error.statusCode === 'number' ? error.statusCode : 500
      sendJson(res, code, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  const removeRoute = ctx.webServer.register({ kind: 'prefix', path: '/balance', handler })
  ctx.effect(() => removeRoute)

  const timer = ctx.get('timer')
  if (timer !== undefined) {
    const disposeInterval = timer.interval(() => { void refresh() }, REFRESH_INTERVAL_MS)
    ctx.effect(() => disposeInterval)
  }

  // Initial load, fire-and-forget: never block apply or boot on network.
  // A short follow-up pass corrects the early snapshot if a provider service
  // was still finishing its async init during the first pass.
  void refresh()
  if (timer !== undefined) {
    const disposeRetry = timer.timeout(() => { void refresh() }, 2000)
    ctx.effect(() => disposeRetry)
  }
}
