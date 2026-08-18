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
- **DeepSeek today spend (今日花费)**: the balance API has no spend endpoint, so the plugin keeps a
  persisted day baseline (balance at the first successful fetch of each local day, stored in
  `$DSH_HOME/balance-monitor.json`) and shows `今日花费 = 当日基线余额 − 当前余额`.
- **Xiaomi MiMo balance (optional)**: queries via the MiMo platform cookie; cookie and endpoint are
  configurable on the settings page and stored in `$DSH_HOME/balance-monitor.json` (mode `0600`).
- **Token plan usage % (已用百分比)**: the token-plan quota display shows `已用 %` next to the
  remaining tokens, plus today's token usage when the platform reports a daily usage row.
- Auto-refresh every 5 minutes; panel and settings page also poll every 60 seconds.
- The floating panel subscribes to `ctx.modelDirectories` (the same store as the `/model` popup and the
  composer model seat) and maps the currently selected model to the matching platform's balance.

## UI / 界面位置

- **Floating panel (persistent)**: the "当前模型余额" card at bottom-right shows the balance of the
  currently selected model — it follows in real time when you switch between DeepSeek / MiMo models;
  draggable and collapsible (a small capsule when collapsed). Cash balance lanes also show
  「今日花费」; token-plan lanes show 「已用 %」 (highlighted in warning/error colors at 75%/90%).
- **Settings → 余额监控**: DeepSeek status (含今日花费), MiMo cookie / endpoint config, refresh now,
  clear cookie.

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
- **「今日花费」是怎么算的**: DeepSeek 官方接口只有余额没有消费明细，插件用「当日首次成功拉取时的余额」作基线，
  今日花费 = 基线余额 − 当前余额（当天首次拉取/跨天自动更新基线并落盘，跨重启也有效；当天充值会使差值变负，按 0 显示）。
- **MiMo 显示 401 / 解析失败**: 额度接口 `platform.xiaomimimo.com/api/v1/tokenPlan/usage` 只认**网页会话 Cookie**（官方没有 API Key 版额度接口）。
  Cookie 会过期（通常是数天到数周）：重新登录 platform.xiaomimimo.com，在开发者工具中复制 Cookie 粘贴到设置页保存即可。
  插件会自动从 DSH 凭据库读取 `XIAOMI_TOKEN_PLAN_CN_API_KEY` 做连通性校验（`/v1/models`），因此 401 时会明确提示
  「API Key 正常 / Cookie 已过期」而不再是一句裸 401。若确认新 Cookie 仍 401，可在设置页改 endpoint
  （2026-08-16 起 `api/v1/user/balance` 已下线，当前走 `tokenPlan/usage`）。
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
