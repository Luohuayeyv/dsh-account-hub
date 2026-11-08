# dsh-account-hub · 账号中心

DeepSeek Harness 插件：在 **设置 → 账号管理** 中保存网站账号（网址 + 账号 + 密码），并让子智能体在搜索/阅读资料时复用这些登录会话；遇到验证码 / 人机验证 / 二次验证时，自动弹出**可见浏览器窗口**，由你亲手完成验证后继续（插件不会自动破解验证码）。

A DeepSeek Harness plugin that manages site accounts (URL + username + password) and gives agents authenticated search/fetch tools backed by a real Edge browser session, with an explicit **human-verification handoff** in a visible window. No captcha bypass — by design.

- 适用：需要登录/付费墙/验证码才能访问的网站（如期刊站点、内部资料库、社交平台）。
- 浏览器：本机 Microsoft Edge（也支持 Chrome，路径可通过插件配置 `browserPath` 指定）。
- 零 npm 依赖：Host 侧只用 Node 内置模块，直接通过 Chrome DevTools Protocol 驱动浏览器。

## 安装

1. 克隆本仓库：
   ```powershell
   git clone https://github.com/Luohuayeyv/dsh-account-hub.git
   ```
2. 在 DeepSeek Harness 中安装为本地 bundle（二选一）：
   - 对 Agent 说：**「安装本地插件，目录是 `<克隆目录的绝对路径>`」**（底层是 `plugin_manager` → `install_bundle`，target 为该绝对路径）；
   - 或使用设置里的插件管理界面安装本地插件目录。
3. 安装完成后刷新 Harness 页面，左下角 **设置 → 账号管理** 即会出现。

卸载：`plugin_manager` → `remove_bundle`，target `dsh-account-hub`。数据目录 `%USERPROFILE%\.dsh\account-hub\` 可手动删除。

## 使用方式

1. 设置 → 账号管理 → 添加账号：
   - **网站地址**（必填，如 `https://www.nature.com`）
   - **账号 / 密码**（必填，本机 AES-256-GCM 加密保存）
   - 可选：名称、登录页地址、搜索地址模板（`https://www.nature.com/search?q={query}`）、备注、**搜索时显示浏览器窗口**。
2. 点 **登录并验证**：插件打开可见 Edge 窗口并自动填入账号密码提交。
   - 若站点要求验证码 / 人机验证 / 二次验证：在窗口中完成，然后回到设置页点 **我已完成验证**（插件通常也会自动检测到并继续）。
   - 若账号只支持通行密钥（passkey）/ 第三方登录（如 Google）注册的账号（GitHub 常见）：在添加/编辑账号时把 **登录方式** 选为 **手动登录**。插件只打开登录窗口、不自动填表；请用 Google / Apple / 通行密钥等方式登录，完成后点 **我已完成验证**。即使忘了切换，自动模式检测到“该账号不支持密码登录”时也会自动转为等待你手动完成，不会误判成功。
3. **测试会话** 可快速检查登录是否有效。

## 子智能体可用的工具

| 工具 | 说明 |
|---|---|
| `account_hub_list` | 列出已保存账号与登录状态（不含密码） |
| `account_hub_search` | 用指定账号的登录会话在站点内搜索 |
| `account_hub_fetch` | 用指定账号的登录会话打开任意 URL 并读取正文/链接 |
| `account_hub_login` | 打开可见浏览器窗口供用户登录/完成验证（立即返回） |

`account` 参数可传账号 id（`acc_...`）或账号名称。插件还会在系统提示词中注入已保存账号清单，因此子智能体在 `web_search` / `web_fetch` 被登录墙、付费墙或验证码挡住时会自动改用这些工具。

## 安全与隐私

- 密码仅保存在 Host 侧，磁盘上用 **AES-256-GCM** 加密（密钥 `secret.key` 与数据同目录）；任何设置页、HTTP 响应、工具结果、日志都不会出现明文密码。
- **不会自动破解验证码**：验证码 / 人机验证 / 短信或 TOTP 二次验证必须由真人完成。这是有意的安全设计。
- 每个账号使用独立的浏览器 profile（`profiles/<账号 id>`），其中包含该站点的登录 cookie；**删除账号会同时删除对应 profile**。
- HTTP 接口仅监听本机（Harness Web 服务，如 `127.0.0.1:50461`），按本机单用户模型设计；账号数据与密钥均在同一用户目录下。
- 请确认目标网站服务条款允许自动化访问，仅用于你有权访问的内容。

## 限制

- 自动填表覆盖常见登录表单；多步登录、iframe / Shadow DOM 登录框、passkey-only 账号需在弹窗中手动完成（插件会保持窗口并等待你确认）。推荐把这类账号的 **登录方式** 设为「手动登录」。
- 部分站点会检测无头浏览器；抓取失败时可为该账号勾选「搜索时显示浏览器窗口」重试。
- 登录会话保存在本机 Edge profile 中，站点 Session 过期后重新点「登录并验证」。
- 同一账号的浏览器操作串行执行（同一 profile 不能被两个浏览器同时打开）。

## 开发与测试

```powershell
npm run check              # node --check 所有模块
npm test                   # Host 层单元测试（不启动浏览器）
npm run test:browser       # 浏览器层测试（真实 Edge，会短暂弹出窗口）
npm run test:integration   # 真实 store + 浏览器 + 路由 + 工具 集成测试
```

目录结构：

```
index.js                Host 插件入口（store / browser / service / routes / tools 装配）
client.js               Web 设置页 + 全局真人验证横幅
lib/store.js            加密账号存储（AES-256-GCM，原子写）
lib/accountService.js   统一操作层（UI 路由与 agent 工具共用）
lib/routes.js           /api/account-hub/* HTTP 路由
lib/tools.js            account_hub_* Agent 工具
lib/cdp.js              零依赖 CDP 客户端（本机 Edge/Chrome）
lib/browser.js          登录 / 会话 / 抓取 / 真人验证交接
lib/extract.js          页面正文提取与验证码检测
docs/DESIGN.md          架构与接口设计
dev/                    测试与本地夹具站点（不参与运行时）
```

## License

[MIT](LICENSE)
