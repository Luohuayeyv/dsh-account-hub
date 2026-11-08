# Security

## 设计原则

- 密码只保存在本机 Harness Host 侧，磁盘上使用 AES-256-GCM 加密（密钥 `secret.key` 与数据同目录）。设置页、HTTP 接口、Agent 工具、日志都不会返回明文密码。
- 每个账号使用独立浏览器 profile（`profiles/<账号 id>`），其中包含登录 cookie。删除账号时会同时删除 profile 与登录态。
- 插件**不实现任何验证码识别或自动绕过**。验证码 / 人机验证 / 二次验证 / passkey 必须由用户在可见浏览器窗口中亲手完成。
- 本地 HTTP 接口（`/api/account-hub/*`）按本机单用户威胁模型设计：能运行本机程序的进程理论上也可以访问它们，因此接口不返回密码；账号与密钥文件位于当前用户目录。

## 报告漏洞

如果你发现安全问题，请通过 GitHub Security Advisories（仓库 Security 标签页 → Report a vulnerability）私下报告，或在 Issue 中只描述影响、不要附带可利用细节/真实凭证。请勿在 Issue 中粘贴任何真实密码、cookie 或 Token。

## 合法使用

请确认目标网站的服务条款与版权规定允许自动化访问，并且你只访问自己有权访问的内容。账号与凭证由用户自行负责保管。
