# 一隅 · Personal Dashboard

中文个人生活中心，适配电脑与手机屏幕。v1.1 将「我的计划」改为「我的日程」，将「我的目标」改为「我的邮件」。

## 运行

需要 Node.js 22 或更高版本，无第三方运行依赖：

```sh
node server/index.mjs
```

打开 **http://127.0.0.1:8765**。必须通过此本机服务使用账户授权，不能只部署静态文件到 GitHub Pages。服务固定监听本机回环地址，不向局域网或公网开放。

## 功能

- **我的日程**：Google 日历今天与明天，固定使用 Asia/Shanghai 时区；包括全天、跨夜及展开后的重复日程。读取 Google Calendar 中选中显示的日历和主日历，不包括隐藏日历。单个日历失败会明确提示。
- **我的邮件**：Gmail 未读邮件，排除垃圾邮件和垃圾箱；每页 50 封，可加载更多；显示发件人、主题、时间与摘要。读取列表不会改变未读状态，在 Gmail 中打开后的行为由 Gmail 控制。
- **自动刷新**：页面可见且不在编辑/账户设置界面时，每 60 秒重新读取；服务器缓存 55 秒。隐藏页面恢复可见时刷新；服务或页面关闭后不继续同步。失败时显示错误和上次成功内容的时间，不伪装为实时数据。
- **我的记录与个人中心**：保留笔记、收藏、名片、主题、备份恢复。
- 原有本地安排仍可在「我的日程 → 本地安排」中查看和编辑。旧版目标数据保留在原备份结构中，但目标入口已移除。

## Google 授权配置

1. 在 [Google Cloud](https://console.cloud.google.com/apis/credentials) 创建或选择项目。
2. 启用 Gmail API 与 Google Calendar API。
3. 配置 Google Auth Platform 的应用名称、联系邮箱和受众。个人测试使用 External / Testing，并将自己的 Gmail 加为测试用户；组织账号遵循管理员限制。
4. 创建类型为 **Web application** 的 OAuth 客户端，添加精确回调地址：

   `http://127.0.0.1:8765/auth/google/callback`

5. 在 App 的「个人中心 → 账户连接」填写 Client ID、Client Secret，保存到此电脑，再点击「连接账户」。密钥不要发到聊天或提交到仓库。
6. 在 Google 授权页同时允许 Gmail 和日历的只读访问。授权成功会自动返回 App。

使用授权码流程、随机 state、PKCE、离线访问和 refresh token 续期。测试模式或账户策略可能让授权过期，届时页面提示重新连接。没有配置和授权之前，页面显示「尚未连接」，不会显示虚构个人数据。

请求权限仅为 `gmail.readonly` 与 `calendar.readonly`；没有发信、标记已读、修改或删除日程接口。Client ID 对应的应用必须由使用者自行在 Google 注册，Codex 中的 Gmail/日历连接不能转移为此 App 的授权。

## 滴答清单置顶的限制

截至本次核对，滴答清单官方 Open API 的 Task 定义没有置顶标记，也没有置顶列表接口；优先级和置顶不是同一回事。因此当前界面明确显示「置顶同步暂不可用」，提供打开滴答清单的入口，**未实现自动读取原生置顶列表**。

已预留国内滴答清单只读 OAuth 及关注任务的后端能力，回调为 `http://127.0.0.1:8765/auth/dida/callback`，权限为 `tasks:read`。这不是置顶识别。只有采用「手动选择关注任务」的替代方案后，才能据此自动更新所选任务的内容；不会自动跟随原生置顶变化。

## 私人数据与源码

- OAuth 配置及令牌保存在 `.private/`：目录权限 700，文件权限 600，凭据使用 AES-256-GCM 加密，密钥保存在同一受限本机目录。此机制防止误提交和直接静态读取，不防御能读取整个本机账户的攻击者。
- `.private/` 已加入 Git 忽略规则。发布、分享或打包时必须使用源码白名单，不能把整个工作目录无条件压缩。
- 账户同步结果仅在服务器和页面内存中缓存，不包含在个人笔记的 JSON 备份中。没有把用户真实邮件、日程、任务或凭据写入此仓库。
- 本地笔记、名片及原安排仍使用 v1 的浏览器 localStorage；切换浏览器或域名不会自动迁移。支持手动导出恢复。
- 服务校验 Host、Origin、CSRF token 和 OAuth state，所有敏感响应禁止缓存，静态路由使用白名单。凭据不返回前端，不打印授权码或令牌。
- 「移除本机连接」仅移除此电脑凭据；如需撤销服务端授权，请到 Google/滴答清单账户设置操作。

## 结构

- `dist/`：界面与交互
- `server/index.mjs`：本机 HTTP 服务、OAuth、受限凭据存储
- `server/providers.mjs`：日历、邮件、滴答清单只读适配器
- `tests/`：日期边界、全天/跨夜日程、分页、授权和隔离测试
- `.openai/hosting.json`：保留的 v1 静态目录配置；仅可用于静态界面预览，不代表当前后端可在 Sites/Workers 运行

## 验证

```sh
node --test tests/*.test.mjs
```

已经用合成数据测试日期分组、日历分页、邮件未读过滤、任务筛选，以及本机服务器的会话/CSRF/回调状态校验。真实账户的端到端自动同步需要完成各自授权后验证；当前不声称已连接成功。

## 官方参考

- [Google OAuth 服务端授权](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Calendar events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [滴答清单 Open API 文档](https://developer.dida365.com/docs/openapi.md)
