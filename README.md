<div align="center">

# dsh-balance-monitor · DSH 余额监控

**Balance monitor plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web UI**
**DeepSeek Harness (DSH) Web 界面的 API 余额监控插件：DeepSeek + 小米 MiMo**

_Show API balances for DeepSeek and Xiaomi MiMo directly in the DSH web interface._
_在 DSH Web 界面直接显示 DeepSeek 与小米 MiMo 的 API 余额。_

</div>

## Features / 功能

- **DeepSeek balance**: reads `DEEPSEEK_API_KEY` from the DSH credential store and calls the official
  `GET https://api.deepseek.com/user/balance` endpoint. No key pasting needed.
- **Xiaomi MiMo balance (optional)**: queries via the MiMo platform cookie; cookie and endpoint are
  configurable on the settings page and stored in `$DSH_HOME/balance-monitor.json` (mode `0600`).
- Auto-refresh every 5 minutes; panel and settings page also poll every 60 seconds.
- The floating panel subscribes to `ctx.modelDirectories` (the same store as the `/model` popup and the
  composer model seat) and maps the currently selected model to the matching platform's balance.

## UI / 界面位置

- **Floating panel (persistent)**: the "当前模型余额" card at bottom-right shows the balance of the
  currently selected model — it follows in real time when you switch between DeepSeek / MiMo models;
  draggable and collapsible (a small capsule when collapsed).
- **Settings → 余额监控**: DeepSeek status, MiMo cookie / endpoint config, refresh now, clear cookie.

## Install / 安装

```bash
git clone https://github.com/Stack0verF1ow/dsh-balance-monitor.git
cd dsh-balance-monitor
dsh plugin --profile web add "link:$PWD"     # 首次安装（自动加入 dsh.profile.bundles）
```

Code changes after a `link:` install take effect after **restarting dsh** (no reinstall needed).

## Structure / 结构

```
src/index.js      Host-side plugin: balance fetch (node:https), /balance/api/* routes, scheduled refresh
client.js         Browser-side bundle (self-contained, no build step): floating panel + settings page
cordis.patch.yml  Inserts the balance-monitor row into the web profile (via dsh.bundle.patch)
```

Communication uses same-origin HTTP (`GET /balance/api/state`, `POST /balance/api/refresh`,
`POST /balance/api/config`) — no typert/remote internals. Keys and cookies never go back to the
browser (only "is configured" flags do).

## FAQ

- **DeepSeek 显示「未配置凭据」**: make sure `~/.dsh/.credentials.yaml` has a non-empty `DEEPSEEK_API_KEY`.
- **MiMo 显示 HTTP 404 / 解析失败**: the MiMo platform API may have changed; edit the endpoint on the
  settings page. As of 2026-08-16, `api/v1/user/balance` is gone; the current working endpoint is
  `https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` (token-quota plan, no cash balance — the
  plugin parses the new shape and shows "Token Plan remaining"). The cookie needs `api-platform_serviceToken`
  and `userId`.
- **自动刷新间隔**: host-side `REFRESH_INTERVAL_MS` (default 5 min) and the browser 60s polling are tunable.

## Uninstall / 卸载

```bash
dsh plugin --profile web remove @local/dsh-balance-monitor
```

If a change ever breaks dsh startup, remove `"@local/dsh-balance-monitor"` from the
`dsh.profile.bundles` array in `~/.dsh/profiles/web/package.json` to restore boot.

## License / 许可

[MIT](LICENSE) © 2026 Stack0verF1ow

---

**Topics**: `deepseek` `deepseek-harness` `dsh` `mimo` `xiaomi` `余额监控` `balance` `plugin` `web-ui`
