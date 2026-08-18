/**
 * dsh-balance-monitor — client bundle.
 *
 * Self-contained web bundle (no build step): a classic script that registers
 * its factory with the DSH client module table. The factory returns the
 * Cordis client plugin ({ apply }), which registers:
 *  - shell.overlay      — a floating, draggable, collapsible panel that shows
 *                         the CURRENTLY SELECTED model and its balance
 *                         directly (bottom-right corner by default). Cash
 *                         balance lanes also show today's spend; token-plan
 *                         lanes show the used percentage (and today's token
 *                         usage when the platform reports it).
 *  - settings.section   — the "余额监控" settings page: DeepSeek status,
 *                         MiMo cookie/endpoint configuration, manual refresh.
 *
 * Model selection is read from the shared `ctx.modelDirectories` service
 * (the same store the /model popup and composer seat use), and balances from
 * the host half through same-origin fetch calls to /balance/api/*. No
 * secrets are held or echoed by this half.
 */
(function () {
  window.__ModuleLoader__.load({
    id: '@local/dsh-balance-monitor',
    factory: function (require) {
      var module = { exports: {} }
      var React = require('react')
      var e = React.createElement

      var CSS = {
        bgOverlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
        bgLayer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        bgLayer2: 'var(--dsw-alias-bg-layer-2, #f5f6f8)',
        border: 'var(--dsw-alias-border-l1, #e5e7eb)',
        borderStrong: 'var(--dsw-alias-border-l2, #d1d5db)',
        brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
        text: 'var(--dsw-alias-label-primary, #1f2328)',
        textSecondary: 'var(--dsw-alias-label-secondary, #6b7280)',
        error: 'var(--dsw-alias-state-error-primary, #ef4444)',
        success: 'var(--dsw-alias-state-success-primary, #16a34a)',
        warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      }

      /** Client ctx captured at apply time (service reads stay lazy). */
      var clientCtx = null

      // ---- host API client -------------------------------------------------

      function apiCall(path, options) {
        return window.fetch('/balance/api' + path, options).then(function (res) {
          return res.json().catch(function () { return {} }).then(function (data) {
            if (!res.ok || data.ok === false) {
              var message = (data && data.error) || ('HTTP ' + res.status)
              var err = new Error(message)
              err.status = res.status
              throw err
            }
            return data
          })
        })
      }

      function fmtMoney(n, currency) {
        var v = Number(n)
        if (!isFinite(v)) return '--'
        var symbol = currency === 'USD' ? '$' : '\u00a5'
        return symbol + v.toFixed(2)
      }

      /** Compact token counts: 3121184732 -> "3.12B". */
      function fmtTokens(n) {
        var v = Number(n)
        if (!isFinite(v)) return '--'
        if (v >= 1e9) return trimZero((v / 1e9).toFixed(2)) + 'B'
        if (v >= 1e6) return trimZero((v / 1e6).toFixed(2)) + 'M'
        if (v >= 1e3) return trimZero((v / 1e3).toFixed(1)) + 'K'
        return String(Math.round(v))
      }
      function trimZero(s) {
        return s.replace(/\.?0+$/, '')
      }

      /** Used share of a quota as a compact percent string ("68.8%"), or null. */
      function fmtPct(used, limit) {
        var u = Number(used)
        var l = Number(limit)
        if (!isFinite(u) || !isFinite(l) || l <= 0) return null
        var pct = Math.max(0, Math.min(100, (u / l) * 100))
        if (pct >= 99.95) return '100%'
        if (pct >= 10) return trimZero(pct.toFixed(1)) + '%'
        return trimZero(pct.toFixed(2)) + '%'
      }

      /** MiMo lane headline: token plan when available (money balance is gone). */
      function mimoBalanceText(balance) {
        if (!balance) return null
        if (balance.tokenPlanTotal > 0) {
          return fmtTokens(balance.tokenPlan) + ' / ' + fmtTokens(balance.tokenPlanTotal) + ' tokens'
        }
        return fmtMoney(balance.total, balance.currency)
      }

      function fmtTime(ts) {
        if (ts === null || ts === undefined) return null
        var d = new Date(ts)
        if (isNaN(d.getTime())) return null
        return d.toLocaleTimeString()
      }

      // ---- current-model tracking ------------------------------------------

      /** Known provider id -> display name + balance lane key. */
      function providerInfo(providerId) {
        if (!providerId) return null
        var p = String(providerId).toLowerCase()
        if (p.indexOf('deepseek') >= 0) return { label: 'DeepSeek', key: 'deepseek' }
        if (p.indexOf('xiaomi') >= 0 || p.indexOf('mimo') >= 0) return { label: 'MiMo', key: 'mimo' }
        return { label: providerId, key: null }
      }

      /**
       * Reactively read the active session's model selection through the
       * shared `modelDirectories` service (lazy per mount, so the provider
       * fiber may still be initializing when our apply first runs).
       */
      function useCurrentModel(sessionId) {
        var [current, setCurrent] = React.useState(null)
        React.useEffect(function () {
          if (!sessionId || !clientCtx) {
            setCurrent(null)
            return
          }
          var dirs = clientCtx.get('modelDirectories')
          if (dirs === undefined) {
            setCurrent(null)
            return
          }
          var directory
          try {
            directory = dirs.directoryFor(sessionId)
          } catch (err) {
            setCurrent(null)
            return
          }
          var booted = false
          var read = function () {
            var snap = directory.store.getSnapshot()
            setCurrent(snap.current)
            if (!booted && snap.status === 'idle') {
              booted = true
              directory.load().catch(function () {})
            }
          }
          read()
          var stop = directory.store.subscribe(read)
          return stop
        }, [sessionId])
        return current
      }

      // ---- floating balance panel ------------------------------------------

      function BalancePanel(props) {
        var sessionId = props.useSessions(function (s) { return s.current })
        var model = useCurrentModel(sessionId)

        var [state, setState] = React.useState(null)
        var [error, setError] = React.useState(null)
        var [loading, setLoading] = React.useState(false)
        var [collapsed, setCollapsed] = React.useState(false)
        var [pos, setPos] = React.useState({ left: null, top: null })

        React.useEffect(function () {
          apiCall('/state').then(function (d) {
            setState(d.state)
            setError(null)
          }).catch(function (err) { setError(err.message) })
          var t = window.setInterval(function () {
            apiCall('/state').then(function (d) {
              setState(d.state)
              setError(null)
            }).catch(function (err) { setError(err.message) })
          }, 60 * 1000)
          return function () { window.clearInterval(t) }
        }, [])

        var refresh = function () {
          setLoading(true)
          apiCall('/refresh', { method: 'POST' }).then(function (d) {
            setState(d.state)
            setError(null)
          }).catch(function (err) {
            setError(err.message)
          }).then(function () { setLoading(false) })
        }

        var startDrag = function (ev) {
          if (ev.button !== 0) return
          var origin = pos.left === null
            ? { left: window.innerWidth - 300, top: window.innerHeight - 156 }
            : pos
          var start = { x: ev.clientX, y: ev.clientY }
          var move = function (me) {
            var left = Math.max(0, Math.min(window.innerWidth - 44, origin.left + (me.clientX - start.x)))
            var top = Math.max(0, Math.min(window.innerHeight - 44, origin.top + (me.clientY - start.y)))
            setPos({ left: left, top: top })
          }
          var up = function () {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          ev.preventDefault()
        }

        var info = providerInfo(model && model.provider)
        var balance = null
        var laneError = null
        var laneMissing = null
        if (info && info.key === 'deepseek') {
          balance = state && state.deepseek
          laneError = state && state.deepseekError
        } else if (info && info.key === 'mimo') {
          balance = state && state.mimo
          laneError = state && state.mimoError
          laneMissing = state && !state.hasMimoCookie ? 'MiMo \u672a\u914d\u7f6e Cookie\uff0c\u8bf7\u5230 \u8bbe\u7f6e \u2192 \u4f59\u989d\u76d1\u63a7 \u914d\u7f6e' : null
        } else if (info) {
          laneMissing = '\u8be5\u6a21\u578b\u672a\u63a5\u5165\u4f59\u989d\u76d1\u63a7'
        }

        var balanceText = null
        var dotColor = CSS.textSecondary
        if (info && info.key !== null) {
          if (balance) {
            if (info.key === 'mimo' && balance.tokenPlanTotal > 0) {
              balanceText = mimoBalanceText(balance)
            } else {
              balanceText = fmtMoney(balance.total, balance.currency)
              if (balance.available === false) balanceText += ' \u00b7 \u4e0d\u53ef\u7528'
            }
            dotColor = balance.available === false ? CSS.error : CSS.success
          } else if (laneError) {
            balanceText = laneError
            dotColor = CSS.warn
          } else if (laneMissing) {
            balanceText = laneMissing
            dotColor = CSS.warn
          } else {
            balanceText = '\u83b7\u53d6\u4e2d\u2026'
          }
        }
        if (error) dotColor = CSS.error

        // Extra lane info: cash balance lanes show today's spend; token-plan
        // lanes show the used percentage (and today's token usage when the
        // platform reports a daily row).
        var spendLabel = null
        var spendAmount = null
        var pctText = null
        var pctColor = CSS.textSecondary
        var todayTokensText = null
        if (info && info.key !== null && balance) {
          if (info.key === 'deepseek' && isFinite(Number(balance.todaySpend))) {
            spendLabel = '\u4eca\u65e5\u82b1\u8d39 '
            spendAmount = fmtMoney(balance.todaySpend, balance.currency)
          }
          if (info.key === 'mimo' && balance.tokenPlanTotal > 0) {
            var pct = fmtPct(balance.tokenPlanUsed, balance.tokenPlanTotal)
            if (pct !== null) {
              pctText = '\u5df2\u7528 ' + pct
              var pctValue = (Number(balance.tokenPlanUsed) / Number(balance.tokenPlanTotal)) * 100
              pctColor = pctValue >= 90 ? CSS.error : (pctValue >= 75 ? CSS.warn : CSS.textSecondary)
            }
            if (balance.todayTokensLimit > 0) {
              todayTokensText = '\u4eca\u65e5\u5df2\u7528 ' + fmtTokens(balance.todayTokensUsed) + ' tokens'
            }
          }
        }

        // MiMo lane: when the quota query is unavailable, explain the state —
        // the API key comes from the DSH credential store and only proves
        // connectivity; quota numbers need a fresh web-session cookie.
        var mimoKeyHint = null
        if (info && info.key === 'mimo' && laneError && state) {
          if (state.mimoKeyValid === true) {
            mimoKeyHint = '\u5df2\u4ece\u51ed\u636e\u5e93\u8bfb\u53d6 XIAOMI_TOKEN_PLAN_CN_API_KEY \u4e14\u6821\u9a8c\u901a\u8fc7\uff1b\u989d\u5ea6\u63a5\u53e3\u53ea\u8ba4\u7f51\u9875 Cookie\uff0c\u8bf7\u5230 \u8bbe\u7f6e \u2192 \u4f59\u989d\u76d1\u63a7 \u66f4\u65b0'
          } else if (state.mimoKeyValid === false) {
            mimoKeyHint = 'MiMo API Key \u6821\u9a8c\u5931\u8d25\uff08XIAOMI_TOKEN_PLAN_CN_API_KEY\uff09'
          }
        }

        var modelLabel = model
          ? (info ? info.label + ' \u00b7 ' + model.model : model.model)
          : (sessionId ? '\u8bfb\u53d6\u4e2d\u2026' : '\u65e0\u6d3b\u52a8\u4f1a\u8bdd')

        var panelStyle = {
          position: 'fixed',
          zIndex: 8000,
          width: 276,
          background: CSS.bgOverlay,
          border: '1px solid ' + CSS.borderStrong,
          borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.16)',
          fontSize: 13,
          color: CSS.text,
          cursor: 'default',
          userSelect: 'none',
        }
        if (pos.left === null) {
          panelStyle.right = 16
          panelStyle.bottom = 96
        } else {
          panelStyle.left = pos.left
          panelStyle.top = pos.top
        }

        if (collapsed) {
          return e('div', {
            style: Object.assign({}, panelStyle, { width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px' }),
            title: error ? error : (modelLabel + (balanceText ? ' \u00b7 ' + balanceText : '')),
            onClick: function () { setCollapsed(false) },
          },
            e('span', { style: { width: 8, height: 8, borderRadius: '50%', background: dotColor, display: 'inline-block' } }),
            e('span', { style: { fontWeight: 600, fontSize: 12 } },
              balance
                ? (info && info.key === 'mimo' && balance.tokenPlanTotal > 0
                    ? fmtTokens(balance.tokenPlan) + (pctText ? ' \u00b7 ' + pctText : '')
                    : fmtMoney(balance.total, balance.currency))
                : '\u00a5'),
          )
        }

        return e('div', { style: panelStyle },
          e('div', {
            onPointerDown: startDrag,
            style: {
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 12px', cursor: 'move',
              borderBottom: '1px solid ' + CSS.border,
            },
          },
            e('span', { style: { width: 8, height: 8, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 } }),
            e('span', {
              style: { fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: model ? model.provider + ' / ' + model.model : '',
            }, modelLabel),
            e('button', {
              type: 'button',
              onClick: function () { setCollapsed(true) },
              style: {
                border: 'none', background: 'transparent', color: CSS.textSecondary,
                cursor: 'pointer', fontSize: 12, padding: '2px 4px', lineHeight: 1,
              },
              title: '\u6536\u8d77',
            }, '\u25bc'),
          ),
          e('div', { style: { padding: '9px 12px 10px', lineHeight: 1.7 } },
            info
              ? e('div', { style: { fontSize: 13, display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, rowGap: 2 } },
                  e('span', { style: { color: CSS.textSecondary } },
                    info.key === 'mimo' && balance && balance.tokenPlanTotal > 0 ? '\u5269\u4f59 ' : '\u4f59\u989d '),
                  e('span', { style: { fontWeight: 600, color: dotColor === CSS.warn ? CSS.warn : CSS.text } }, balanceText || '--'),
                  spendAmount ? e('span', { style: { fontSize: 12 } },
                    e('span', { style: { color: CSS.textSecondary } }, spendLabel),
                    e('span', { style: { fontWeight: 600, color: CSS.text } }, spendAmount),
                  ) : null,
                  pctText ? e('span', { style: { fontSize: 12, fontWeight: 600, color: pctColor } }, pctText) : null,
                )
              : e('div', { style: { color: CSS.textSecondary } }, '\u5f53\u524d\u6a21\u578b\u672a\u63a5\u5165\u4f59\u989d\u76d1\u63a7'),
            todayTokensText ? e('div', { style: { fontSize: 12, color: CSS.textSecondary, marginTop: 2 } }, todayTokensText) : null,
            error ? e('div', { style: { color: CSS.error, fontSize: 12 } }, error) : null,
            laneError && mimoKeyHint ? e('div', { style: { fontSize: 12, color: CSS.textSecondary, marginTop: 2 } }, mimoKeyHint) : null,
            e('div', {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
            },
              e('span', { style: { fontSize: 11, color: CSS.textSecondary } },
                state && state.lastUpdated ? '\u66f4\u65b0\u4e8e ' + fmtTime(state.lastUpdated) : ''),
              e('button', {
                type: 'button',
                onClick: refresh,
                disabled: loading,
                style: {
                  border: '1px solid ' + CSS.border, background: 'transparent', color: CSS.textSecondary,
                  borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: loading ? 'wait' : 'pointer',
                },
              }, loading ? '\u5237\u65b0\u4e2d\u2026' : '\u5237\u65b0'),
            ),
          ),
        )
      }

      // ---- settings page ---------------------------------------------------

      function fieldLabel(text) {
        return e('label', { style: { display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13, color: CSS.text } }, text)
      }
      function inputStyle(width) {
        return {
          width: width || '100%', padding: '8px 10px', borderRadius: 8,
          border: '1px solid ' + CSS.borderStrong, fontSize: 13,
          color: CSS.text, background: CSS.bgLayer1, boxSizing: 'border-box',
        }
      }
      function cardStyle(tone) {
        return {
          marginTop: 12, padding: '12px 14px', borderRadius: 8, fontSize: 13,
          border: '1px solid ' + (tone === 'ok' ? CSS.success : tone === 'warn' ? CSS.warn : CSS.border),
          background: CSS.bgLayer2, color: CSS.text, lineHeight: 1.8,
        }
      }
      function primaryButton(text, onClick, disabled, tone) {
        var ghost = tone === 'ghost'
        return e('button', {
          type: 'button', onClick: onClick, disabled: disabled,
          style: {
            padding: '8px 16px', borderRadius: 8, cursor: disabled ? 'wait' : 'pointer',
            background: ghost ? 'transparent' : CSS.brand,
            color: ghost ? CSS.textSecondary : '#ffffff',
            border: '1px solid ' + (ghost ? CSS.borderStrong : 'transparent'),
            fontSize: 13, fontWeight: 500,
          },
        }, text)
      }

      function BalanceSettingsPage(props) {
        var [state, setState] = React.useState(null)
        var [error, setError] = React.useState(null)
        var [endpoint, setEndpoint] = React.useState('')
        var [cookie, setCookie] = React.useState('')
        var [saving, setSaving] = React.useState(false)
        var [notice, setNotice] = React.useState(null)
        var initialized = React.useRef(false)

        var load = function () {
          apiCall('/state').then(function (d) {
            setState(d.state)
            setError(null)
            if (!initialized.current) {
              initialized.current = true
              setEndpoint(d.state.mimoEndpoint || '')
            }
          }).catch(function (err) { setError(err.message) })
        }
        React.useEffect(function () {
          load()
          var t = window.setInterval(load, 60 * 1000)
          return function () { window.clearInterval(t) }
        }, [])

        var refresh = function () {
          setSaving(true)
          apiCall('/refresh', { method: 'POST' }).then(function (d) {
            setState(d.state)
            setError(null)
          }).catch(function (err) {
            setError(err.message)
          }).then(function () { setSaving(false) })
        }

        var save = function (clearCookie) {
          setSaving(true)
          setNotice(null)
          var body = { mimoEndpoint: endpoint }
          if (clearCookie) body.mimoCookie = ''
          else if (cookie.trim() !== '') body.mimoCookie = cookie
          apiCall('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).then(function (d) {
            setState(d.state)
            setCookie('')
            setError(null)
            setNotice(clearCookie ? 'MiMo Cookie \u5df2\u6e05\u9664' : '\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u5df2\u5237\u65b0')
          }).catch(function (err) {
            setError(err.message)
          }).then(function () { setSaving(false) })
        }

        var ds = state && state.deepseek
        var mimo = state && state.mimo

        return e('div', { style: { padding: '4px 8px 24px', maxWidth: 640 } },

          // DeepSeek
          e('h3', { style: { margin: '16px 0 8px', fontSize: 15, color: CSS.text } }, 'DeepSeek \u4f59\u989d'),
          e('div', { style: { fontSize: 13, color: CSS.textSecondary, lineHeight: 1.7 } },
            '\u5bc6\u94a5\u81ea\u52a8\u4ece DSH \u51ed\u636e\u5e93\uff08DEEPSEEK_API_KEY\uff09\u8bfb\u53d6\uff0c\u65e0\u9700\u5728\u6b64\u586b\u5199\u3002'),
          state && state.deepseekKeyConfigured
            ? e('div', { style: cardStyle(ds ? 'ok' : 'warn') },
                ds
                  ? e('span', null,
                      '\u603b\u4f59\u989d: ' + fmtMoney(ds.total, ds.currency),
                      ' \u00b7 \u8d60\u9001: ' + fmtMoney(ds.granted, ds.currency),
                      ' \u00b7 \u5145\u503c: ' + fmtMoney(ds.toppedUp, ds.currency),
                      isFinite(Number(ds.todaySpend)) ? ' \u00b7 \u4eca\u65e5\u82b1\u8d39: ' + fmtMoney(ds.todaySpend, ds.currency) : '',
                      !ds.available ? ' \u00b7 \u4f59\u989d\u4e0d\u53ef\u7528' : '')
                  : e('span', null, (state.deepseekError || '\u83b7\u53d6\u4e2d\u2026')),
              )
            : e('div', { style: cardStyle('warn') },
                state && state.deepseekError ? state.deepseekError : '\u672a\u68c0\u6d4b\u5230 DEEPSEEK_API_KEY \u51ed\u636e\uff0c\u8bf7\u5728 DSH \u51ed\u636e\u5e93\u4e2d\u914d\u7f6e'),

          // MiMo
          e('h3', { style: { margin: '24px 0 8px', fontSize: 15, color: CSS.text } }, 'MiMo \u4f59\u989d\uff08\u53ef\u9009\uff09'),
          e('div', { style: { fontSize: 13, color: CSS.textSecondary, lineHeight: 1.7, marginBottom: 10 } },
            '\u901a\u8fc7 MiMo \u5e73\u53f0\u7684 Cookie \u67e5\u8be2\u3002\u5728\u6d4f\u89c8\u5668\u767b\u5f55 platform.xiaomimimo.com \u540e\uff0c\u4ece\u5f00\u53d1\u8005\u5de5\u5177\u590d\u5236 Cookie\uff08\u901a\u5e38\u9700\u8981 api-platform_serviceToken \u4e0e userId\uff09\u3002'),
          fieldLabel('\u63a5\u53e3\u5730\u5740'),
          e('input', {
            type: 'text',
            value: endpoint,
            onChange: function (ev) { setEndpoint(ev.target.value) },
            style: inputStyle(),
            placeholder: 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
          }),
          e('div', { style: { height: 12 } }),
          fieldLabel(state && state.hasMimoCookie
            ? 'MiMo Cookie\uff08\u5df2\u914d\u7f6e\uff0c\u7559\u7a7a\u5219\u4e0d\u4fee\u6539\uff09'
            : 'MiMo Cookie'),
          e('textarea', {
            value: cookie,
            onChange: function (ev) { setCookie(ev.target.value) },
            style: Object.assign({}, inputStyle(), { minHeight: 76, fontFamily: 'monospace', fontSize: 12 }),
            placeholder: 'api-platform_serviceToken=xxx; userId=xxx',
          }),
          mimo
            ? e('div', { style: cardStyle('ok') },
                mimo.tokenPlanTotal > 0
                  ? 'Token Plan \u5269\u4f59: ' + fmtTokens(mimo.tokenPlan) + ' / ' + fmtTokens(mimo.tokenPlanTotal)
                    + (fmtPct(mimo.tokenPlanUsed, mimo.tokenPlanTotal) !== null ? ' \u00b7 \u5df2\u7528 ' + fmtPct(mimo.tokenPlanUsed, mimo.tokenPlanTotal) : '')
                    + (mimo.monthPlanTotal > 0 ? ' \u00b7 \u672c\u6708: ' + fmtTokens(mimo.monthPlan) + ' / ' + fmtTokens(mimo.monthPlanTotal)
                      + (fmtPct(mimo.monthPlanUsed, mimo.monthPlanTotal) !== null ? ' \u00b7 \u5df2\u7528 ' + fmtPct(mimo.monthPlanUsed, mimo.monthPlanTotal) : '') : '')
                    + (mimo.todayTokensLimit > 0 ? ' \u00b7 \u4eca\u65e5\u5df2\u7528: ' + fmtTokens(mimo.todayTokensUsed) + ' tokens' : '')
                  : '\u4f59\u989d: \u00a5' + Number(mimo.total || 0).toFixed(2))
            : e('div', { style: cardStyle('warn') }, state && state.mimoError ? state.mimoError : '\u672a\u914d\u7f6e'),

          // MiMo API Key 状态：自动从 DSH 凭据库读取，仅用于连接校验（额度接口只认网页 Cookie）
          e('div', { style: { fontSize: 12, color: CSS.textSecondary, marginTop: 8, lineHeight: 1.7 } },
            'MiMo API Key: ' + (state && state.mimoKeyConfigured
              ? '\u5df2\u4ece DSH \u51ed\u636e\u5e93\u8bfb\u53d6\uff08XIAOMI_TOKEN_PLAN_CN_API_KEY\uff09'
              : '\u672a\u5728 DSH \u51ed\u636e\u5e93\u914d\u7f6e XIAOMI_TOKEN_PLAN_CN_API_KEY')
              + (state && state.mimoKeyValid === true ? ' \u00b7 \u6821\u9a8c\u901a\u8fc7' : state && state.mimoKeyValid === false ? ' \u00b7 \u6821\u9a8c\u5931\u8d25' : '')),
          state && state.mimoCookieStale
            ? e('div', { style: Object.assign({}, cardStyle('warn'), { marginTop: 8 }) },
                '\u26a0 Cookie \u5df2\u8fc7\u671f\uff1a\u8bf7\u91cd\u65b0\u767b\u5f55 platform.xiaomimimo.com \u540e\uff0c\u5728\u6d4f\u89c8\u5668\u5f00\u53d1\u8005\u5de5\u5177\u4e2d\u590d\u5236 Cookie \u7c98\u8d34\u5230\u4e0a\u65b9\u5e76\u4fdd\u5b58\u3002\u989d\u5ea6\u67e5\u8be2\u53ea\u8ba4\u7f51\u9875\u4f1a\u8bdd Cookie\uff1bMiMo API Key \u4ec5\u7528\u4e8e\u6a21\u578b\u8c03\u7528\u3002')
            : null,

          // actions
          e('div', { style: { display: 'flex', gap: 10, marginTop: 18, alignItems: 'center', flexWrap: 'wrap' } },
            primaryButton('\u4fdd\u5b58\u914d\u7f6e', function () { save(false) }, saving),
            state && state.hasMimoCookie ? primaryButton('\u6e05\u9664 Cookie', function () { save(true) }, saving, 'ghost') : null,
            primaryButton('\u7acb\u5373\u5237\u65b0', refresh, saving, 'ghost'),
          ),
          notice ? e('div', { style: { marginTop: 12, fontSize: 13, color: CSS.success } }, notice) : null,
          error ? e('div', { style: { marginTop: 12, fontSize: 13, color: CSS.error } }, error) : null,
          state && state.lastUpdated ? e('div', {
            style: { marginTop: 10, fontSize: 12, color: CSS.textSecondary },
          }, '\u6700\u540e\u66f4\u65b0: ' + fmtTime(state.lastUpdated)) : null,
        )
      }

      // ---- plugin entry ----------------------------------------------------

      function apply(ctx) {
        clientCtx = ctx
        var slots = ctx.get('slots')
        if (slots === undefined) return

        slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'balance-monitor-panel', order: 0 },
            function (props) { return e(BalancePanel, props) },
          )
        })

        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'balance-monitor', order: 25, label: '\u4f59\u989d\u76d1\u63a7' },
            function (props) { return e(BalanceSettingsPage, props) },
          )
        })
      }

      module.exports = { apply: apply, inject: ['slots'] }
      return module.exports
    },
  })
})()
