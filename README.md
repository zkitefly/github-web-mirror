# GitHub 网页代理 / 下载

![HITS](https://hits.zkitefly.eu.org/?tag=https%3A%2F%2Fgithub.com/zkitefly/github-web-mirror)

基于 Cloudflare Workers 的 GitHub 镜像，可在无法直接访问 GitHub 时浏览页面、查看文件，并下载仓库归档和 Release 附件。

## 演示站

直接将 `github.com` 替换为以下内容即可：

```
ghm.zkitefly.eu.org
```

注：为防止请求过多耗尽额度，演示站设置了限速。若出现 HTTP 429 / Error 1015，属正常现象，刷新网页重试即可。同时已启用托管质询限制自动程序访问，如有需要请自行部署。

## 路由

- `/` 302 跳转到 `/zkitefly/github-web-mirror/blob/main/README.md`
- `/{owner}/{repo}/...` 反代到 `https://github.com/{owner}/{repo}/...`
- `/_ext/{host}/{path}` 代理 GitHub 附属域名，覆盖静态资源、头像、原始文件、下载、API 等，白名单见 `cors.js` 的 `EXT_HOSTS`

## 行为

- `github.com` 和 `github.githubassets.com` 返回的 HTML、CSS、JavaScript、JSON 会改写成镜像地址，避免浏览器直连源站
- 静态资源和公开 API 按上游 `Cache-Control` 写入 Cloudflare 边缘缓存（如 GitHub 静态资源一年、`api.github.com` 60 秒），命中缓存后不再回源
- 下载类请求（仓库归档、Release 附件、raw 文件）流式透传，不改写正文
- 登录相关入口（`login`、`signup`、`password_reset` 等）直接返回 403

## 限制

- 镜像域名下无法保存 GitHub 的 Cookie，因此不支持登录、Star、提交等需要会话的操作
- 经由镜像访问 `api.github.com` 时受 Worker 出口 IP 的速率限制
- `docs.github.com`、`github.blog` 等外部链接保持直连

## 部署

- 安装依赖：`npm install`
- 登录 Cloudflare：`npx wrangler login`
- 部署：`npm run prod`（即 `npx wrangler deploy`）
- 本地调试：`npm run dev`

也可设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 后在 CI 中执行 `npx wrangler deploy`，或在 Cloudflare 控制台连接 Git 仓库自动部署。

Worker 名称等配置见 `wrangler.jsonc`，首页跳转目标见 `cors.js` 的 `HOME_PATH`。免费套餐每天 10 万请求，代理静态资源会放大请求数。

## 来源

基于 <https://github.com/netnr/workers> 改造。
