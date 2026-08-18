<div align="center">

# dsh-balance-monitor

**Balance monitor plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web UI**

_Show API balances for DeepSeek and Xiaomi MiMo directly in the DSH web interface._

[English](#english) · [中文](#中文)

</div>

---

<a id="english"></a>

## English

### Features

- **DeepSeek balance**: reads `DEEPSEEK_API_KEY` from the DSH credential store and calls the official `GET https://api.deepseek.com/user/balance` endpoint. No key pasting needed.
- **DeepSeek today spend**: the balance API has no spend endpoint, so the plugin keeps a persisted day baseline (balance at the first successful fetch of each local day, stored in `$DSH_HOME/balance-monitor.json`) and shows `Today Spend = Baseline Balance − Current Balance`.
- **Xiaomi MiMo balance (optional)**: queries via the MiMo platform cookie. Cookie and endpoint are configurable on the settings page and stored in `$DSH_HOME/balance-monitor.json` (mode `0600`).
  **Auto-detect**: reads cookies directly from the system browser via CDP (Chrome DevTools Protocol) or SQLite — no manual copy-paste needed. On startup and when cookies expire (HTTP 401), it automatically fetches fresh cookies from the browser. If auto-detection fails, manual paste is available as fallback.
- **Token plan usage %**: the token-plan quota display shows used percentage next to the remaining tokens, plus today's token usage when the platform reports a daily usage row.
- Auto-refresh every 5 minutes; panel and settings page also poll every 60 seconds.
- The floating panel subscribes to `ctx.modelDirectories` and maps the currently selected model to the matching platform's balance.

### UI

- **Floating panel (persistent)**: the "Current Model Balance" card at bottom-right shows the balance of the currently selected model — it follows in real time when you switch between DeepSeek / MiMo models; draggable and collapsible. Cash balance lanes also show "Today Spend"; token-plan lanes show "Used %" (highlighted in warning/error colors at 75%/90%).
- **Settings → Balance Monitor**: DeepSeek status (with today spend), MiMo cookie / endpoint config, refresh now, clear cookie, auto-detect cookie from browser.

### Install

```bash
git clone https://github.com/Stack0verF1ow/dsh-balance-monitor.git
cd dsh-balance-monitor
dsh plugin --profile web add "link:$PWD"
```

Code changes after a `link:` install take effect after **restarting dsh** (no reinstall needed).

### Structure

```
src/index.js          Host-side plugin: balance fetch, /balance/api/* routes, scheduled refresh
src/chrome-cookies.js Browser cookie reader: CDP (primary) + SQLite (fallback)
client.js             Browser-side bundle: floating panel + settings page
cordis.patch.yml      Inserts the balance-monitor row into the web profile
```

Cookie auto-detection uses two strategies:
1. **CDP** (primary): connects to the browser's debug port and reads cookies via the DevTools Protocol. Works while the browser is running.
2. **SQLite** (fallback): reads from the browser's Cookies database file directly. Works when the browser is closed or on Linux/macOS.

Communication uses same-origin HTTP (`GET /balance/api/state`, `POST /balance/api/refresh`, `POST /balance/api/config`) — no internals exposed. Keys and cookies never go back to the browser.

### FAQ

- **DeepSeek shows "credential not configured"**: make sure `~/.dsh/.credentials.yaml` has a non-empty `DEEPSEEK_API_KEY`.
- **How is "Today Spend" calculated?**: The DeepSeek API only provides balance, not spend details. The plugin uses the balance at the first successful fetch of each local day as baseline. `Today Spend = Baseline − Current` (clamped to 0 if negative due to top-up).
- **MiMo shows 401**: The quota endpoint `platform.xiaomimimo.com/api/v1/tokenPlan/usage` only accepts web session cookies (no API key endpoint exists). Cookies expire after days to weeks. The plugin automatically reads fresh cookies from the system browser (Chrome, Edge, Brave, Vivaldi, Opera, etc.) via CDP or SQLite. If auto-detection fails, paste the cookie manually from browser DevTools.
- **Refresh interval**: host-side 5 min, browser 60s polling.

### Uninstall

```bash
dsh plugin --profile web remove @local/dsh-balance-monitor
```

If a change ever breaks dsh startup, remove `"@local/dsh-balance-monitor"` from the `dsh.profile.bundles` array in `~/.dsh/profiles/web/package.json` to restore boot.

### License

[MIT](LICENSE) © 2026 Stack0verF1ow

---

<a id="中文"></a>

## 中文

### 功能

- **DeepSeek 余额**：从 DSH 凭据库自动读取 `DEEPSEEK_API_KEY`，调用官方 `GET https://api.deepseek.com/user/balance` 接口。无需手动粘贴密钥。
- **DeepSeek 今日花费**：官方接口只有余额没有消费明细，插件用「当日首次成功拉取时的余额」作基线，今日花费 = 基线余额 − 当前余额（跨天自动更新基线并落盘；当天充值使差值变负时按 0 显示）。
- **小米 MiMo 余额（可选）**：通过 MiMo 平台 Cookie 查询，Cookie 和接口地址可在设置页配置，存储在 `$DSH_HOME/balance-monitor.json`（权限 `0600`）。
  **自动检测**：通过 CDP（Chrome DevTools Protocol）或 SQLite 直接从系统浏览器读取 Cookie——无需手动复制粘贴。插件启动时、Cookie 过期时（HTTP 401）自动从浏览器获取最新 Cookie。自动检测失败时可手动粘贴。
- **Token Plan 已用百分比**：Token 配额显示剩余量和已用百分比，平台返回日用量时还显示今日已用。
- 每 5 分钟自动刷新；浮动面板和设置页每 60 秒轮询。
- 浮动面板订阅 `ctx.modelDirectories`，实时跟随当前选中的模型显示对应平台余额。

### 界面

- **浮动面板（常驻）**：右下角「当前模型余额」卡片，跟随 DeepSeek / MiMo 模型切换实时更新，可拖拽、可收起。现金余额显示「今日花费」；Token 配额显示「已用 %」（75%/90% 时高亮警告/错误色）。
- **设置 → 余额监控**：DeepSeek 状态（含今日花费）、MiMo Cookie / 接口配置、立即刷新、清除 Cookie、自动从浏览器检测 Cookie。

### 安装

```bash
git clone https://github.com/Stack0verF1ow/dsh-balance-monitor.git
cd dsh-balance-monitor
dsh plugin --profile web add "link:$PWD"
```

`link:` 安装后修改代码，**重启 dsh** 即生效（无需重新安装）。

### 结构

```
src/index.js          服务端插件：余额拉取、/balance/api/* 路由、定时刷新
src/chrome-cookies.js 浏览器 Cookie 读取：CDP（主）+ SQLite（备）
client.js             浏览器端 bundle：浮动面板 + 设置页
cordis.patch.yml      将 balance-monitor 注入 web profile
```

Cookie 自动检测双策略：
1. **CDP（主）**：连接浏览器调试端口，通过 DevTools Protocol 读取 Cookie。浏览器运行时可用。
2. **SQLite（备）**：直接读取浏览器 Cookies 数据库文件。浏览器关闭时或 Linux/macOS 下可用。

通信使用同源 HTTP（`GET /balance/api/state`、`POST /balance/api/refresh`、`POST /balance/api/config`），不暴露内部接口。密钥和 Cookie 不会回传到浏览器。

### 常见问题

- **DeepSeek 显示「未配置凭据」**：确认 `~/.dsh/.credentials.yaml` 中有非空的 `DEEPSEEK_API_KEY`。
- **「今日花费」怎么算的**：DeepSeek 官方接口只有余额没有消费明细，插件用「当日首次成功拉取时的余额」作基线，今日花费 = 基线余额 − 当前余额（跨天自动更新基线并落盘；当天充值使差值变负时按 0 显示）。
- **MiMo 显示 401**：额度接口 `platform.xiaomimimo.com/api/v1/tokenPlan/usage` 只认网页会话 Cookie（官方没有 API Key 版额度接口）。Cookie 会过期（通常数天到数周）。插件会通过 CDP 或 SQLite **自动从系统浏览器读取最新 Cookie**（支持 Chrome、Edge、Brave、Vivaldi、Opera 等 Chromium 系浏览器）。自动检测失败时可手动粘贴。
- **刷新间隔**：服务端 5 分钟，浏览器 60 秒轮询。

### 卸载

```bash
dsh plugin --profile web remove @local/dsh-balance-monitor
```

如果改动导致 dsh 无法启动，从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组中删除 `"@local/dsh-balance-monitor"` 即可恢复。

### 许可

[MIT](LICENSE) © 2026 Stack0verF1ow

---

**Topics**: `deepseek` `deepseek-harness` `dsh` `mimo` `xiaomi` `balance` `plugin` `web-ui` `余额监控`
