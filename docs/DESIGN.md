# 设计说明（docs/DESIGN.md）

本文说明 dsh-account-hub 的结构、数据流与关键设计取舍，便于二次开发与代码审查。

## 目标

1. 在 Harness 设置页管理站点账号（网址 + 账号 + 密码 + 可选登录页/搜索模板）。
2. 让 Agent（含子智能体）能用这些登录会话检索/阅读需要登录的页面。
3. 遇到真人验证（验证码、人机验证、二次验证、passkey 等）时把控制权交还用户：打开可见浏览器窗口，等待用户完成后继续。
4. 凭证不离开本机、不以明文出现在任何 UI/接口/日志中。

## 模块与数据流

```
设置页 (client.js) ──HTTP──▶ lib/routes.js ──▶ lib/accountService.js
子智能体工具 (tools.js) ────────┘                     │
                                                    ▼
                                          lib/browser.js（会话/登录/抓取）
                                                    │
                                       lib/cdp.js ──▶ 本机 Edge（CDP）
                                                    │
                                          lib/extract.js（正文/验证码检测）

lib/accountService.js ──▶ lib/store.js（AES-256-GCM 加密的 accounts.json）
```

- `lib/store.js`：账号持久化。数据文件 `$DSH_HOME/account-hub/accounts.json`，每个密码单独 AES-256-GCM 加密（每次加密独立 IV），密钥为同目录随机 `secret.key`。所有写操作串行化，采用临时文件 + rename 原子写；文件损坏时以空列表启动并告警，不阻塞 Harness。
- `lib/accountService.js`：唯一的业务操作实现。设置页路由与 Agent 工具都调用同一组方法，避免两套逻辑分叉。
- `lib/routes.js`：`/api/account-hub/*` 的本地 HTTP JSON 接口（envelope：成功 `{ok:true,data}`，失败 `{ok:false,error:{code,message}}`）。
- `lib/tools.js`：`account_hub_list / search / fetch / login` 四个工具，参数为 JSON Schema；`execute` 内部捕获错误并返回 `{status:'error',error:{code,message}}`，不向模型抛异常。
- `lib/browser.js`：会话语义层。
  - 每个账号一个独立浏览器 profile：`profiles/<accountId>`；同一账号串行，避免 profile 锁冲突。
  - 登录方式由账号字段 `loginMode` 决定：
    - `auto`（默认）：headed 启动 → 自动填表 → 轮询检测。检测到验证码/二次验证、页面提示“不支持密码登录/请用通行密钥”、或长时间停留在登录页时，**保持窗口打开**并把状态置为 `verification-required`，提示用户手动完成；用户点“我已完成验证”时再检测，检测不到也信任用户确认并保存会话。
    - `manual`：只打开可见登录窗口，**不填表、不提交**，用于 Google/Apple 等第三方登录、passkey-only 或需要人工走多步流程的账号；用户完成后由自动检测或“我已完成验证”保存会话。
  - 成功判定加固：必须连续多次满足“无可见密码框 + 无挑战 + 非 passkey 拒绝页”，且页面已离开登录/session 类路径或出现账号/登出类提示才确认；宁可多等用户确认，也不误判成功。
  - 登录成功后把 session cookie 转成持久 cookie（默认 7 天），否则关闭浏览器即丢登录态，后续 headless 抓取无法复用。
  - 抓取：默认 headless + 保存的 profile；若页面出现验证码/登录墙，可自动切换到 headed 窗口交给用户（`autoOpenOnChallenge`），并返回 `verification-required` 让 Agent 提示用户。
- `lib/cdp.js`：零依赖 CDP 客户端。启动 `msedge.exe --remote-debugging-port=0`，读取 profile 内 `DevToolsActivePort`，用全局 `WebSocket` 建立 flat session；`Page.send/goto/evaluate/waitFor/screenshot` 全部带超时，浏览器退出或连接断开时立即抛错，`close()` 幂等并杀进程兜底。
- `lib/extract.js`：页面正文提取（去掉 script/style/nav/footer 等）与验证码检测启发式（可见结构信号 + 文案；优先级 captcha > 2fa > login），宁严勿滥。
- `client.js`：Web 客户端模块（Harness Client 插件格式）。注册两个插槽：
  - `settings.section` → 账号管理页（增删改、登录验证、状态徽标、会话测试）；
  - `shell.overlay` → 全局「需要真人验证」横幅（轮询 `/api/account-hub/state`）。
  样式只使用 Harness 主题 token（`--dsw-alias-*`），不依赖其他 Client 包。

## 状态与并发

- 账号 `session.status`：`unknown` / `authenticated` / `verification-required` / `expired` / `error`，并记录 `lastLoginAt/lastCheckedAt/detail`。
- `browser.pending()` 暴露当前等待用户操作的窗口（账号、URL、阶段、提示）。设置页与横幅据此引导用户；Agent 工具结果也会带 `verification-required` 与 `pending`。
- 浏览器操作串行：同一账号已有 pending 时，新的 `login/fetch` 返回 `busy` 或直接返回当前 pending 状态，不并行打开第二个同 profile 浏览器。
- 插件卸载（`ctx.effect` disposes）时关闭所有浏览器窗口。

## 安全模型

- 密码加密存储在 Host 用户目录；接口/工具只返回脱敏账号信息，日志不含密码/cookie 值。
- 真人验证交接是唯一“绕过”验证的方式——由用户在可见窗口中亲自完成；插件不实现任何验证码识别或自动化。
- 本地 HTTP 接口无额外鉴权，按本机单用户威胁模型设计：能运行本机程序的进程理论上也可访问，因此接口永远不返回明文密码，且密钥文件与数据文件均位于同一用户目录。
- 删除账号 = 取消进行中的浏览器操作 + 删除 profile（含 cookie）+ 删除记录。

## 测试

- `dev/test-service.mjs`：Host 层单元测试（加密存储、CRUD、路由 envelope、工具定义与执行、装配与卸载）。
- `dev/test-browser.mjs`：真实 Edge 的浏览器层测试（登录自动填表、会话复用、验证码交接、confirm/cancel、profile 清理）。
- `dev/test-integration.mjs`：真实 store + 浏览器 + 服务 + 路由 + 工具的集成测试。
- `dev/test-e2e.mjs`：针对已安装插件通过本机 HTTP 路由的端到端测试（创建账号→登录→抓取→验证码交接→删除）。
- `dev/fixture-server.mjs`：本地夹具站点（登录、cookie 保护页面、验证码页、passkey-only 登录页、慢页面）。

## 已知限制

- 自动填表只覆盖标准表单；多步登录、iframe/Shadow DOM 登录框、passkey-only 需要用户手动完成（插件保持窗口并等待确认）。
- 部分站点会检测无头浏览器，可在账号级别开启「搜索时显示浏览器窗口」。
- 只持久化 cookie；若站点登录态存于 sessionStorage/内存，关窗后可能需要再次确认。
