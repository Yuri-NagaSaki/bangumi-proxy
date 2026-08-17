<p>
  <img alt="警告：Web 镜像请勿公开" src="https://img.shields.io/badge/%E8%AD%A6%E5%91%8A-Web%20%E9%95%9C%E5%83%8F%E8%AF%B7%E5%8B%BF%E5%85%AC%E5%BC%80-red?style=for-the-badge">
</p>

<p>
  <strong><font color="red">经核实，bgm.tv Web 镜像同样可能导致 GFW 封禁。请不要公开给他人使用。</font></strong>
</p>

> `bangumi-web-interactive.nginx.conf` 和 `bangumi-web-mirror.nginx.conf` 只建议自用、内测或受控环境使用。不要公开给他人使用。

# Bangumi Proxy

这是一个 Bangumi API 和图片 CDN 的反向代理配置集合。

它主要解决两件事：

- 把 `api.bgm.tv` 代理成自己的 API 域名。
- 把 `lain.bgm.tv` 代理成自己的图片域名，并把 API 返回里的图片链接改成这个图片域名。

仓库里也放了 `bgm.tv` Web 镜像配置，但这不是推荐的公开用途。Web 镜像风险更高，请先阅读上面的警告。

## 文件

| 文件 | 用途 |
| --- | --- |
| `bangumi-proxy.nginx.conf` | Nginx 生产模板，代理 API 和图片。推荐优先使用。 |
| `bangumi-proxy.Caddyfile` | Caddy 示例，需要带 `replace-response` 插件的 Caddy。 |
| `worker.js` | Cloudflare Worker 示例。适合轻量使用，不适合大流量图片代理。 |
| `bangumi-web-interactive.nginx.conf` | `bgm.tv` 交互镜像模板，支持登录和表单交互。请勿公开使用。 |
| `bangumi-web-mirror.nginx.conf` | `bgm.tv` 只读镜像模板。请勿公开使用。 |

## 推荐方案

公开服务只建议部署 API 和图片反代：

```text
api.example.com  ->  api.bgm.tv
img.example.com  ->  lain.bgm.tv
```

如果使用 Cloudflare：

- DNS 记录保持橙云代理。
- SSL 模式使用 Full 或 Full strict。
- 源站 443 只允许 Cloudflare IP 访问。
- 如果有自己的健康检查机，需要额外放行健康检查机 IP。
- Nginx 使用 `CF-Connecting-IP` 还原真实客户端 IP。

这份 Nginx 模板不启用本地 `proxy_cache`。图片缓存交给 Cloudflare 和浏览器，避免小硬盘被缓存文件占满。

## 匿名公开端点合同

推荐的 `bangumi-proxy.nginx.conf` 是无凭据公开镜像。它不会把浏览器的
`Authorization`、`Cookie`、`Origin` 或 `Referer` 转发到上游，并会隐藏上游
`Set-Cookie`。需要登录、OAuth 或用户 access token 的调用必须直接使用官方 API，
不能经过公开镜像。

端点方法固定为：

| 端点 | 允许方法 |
| --- | --- |
| `/v0/search/subjects` | `POST`, `OPTIONS` |
| `/v0/subjects/{id}` 与 `/v0/subjects/{id}/image` | `GET`, `HEAD`, `OPTIONS` |
| 其他公开 API 路径 | `GET`, `HEAD`, `POST`, `OPTIONS` |
| 图片域名 | `GET`, `HEAD`, `OPTIONS` |

CORS 使用 `Access-Control-Allow-Origin: *`，只允许匿名请求所需的 `Accept` 和
`Content-Type` headers，不返回 `Access-Control-Allow-Credentials`，也不声明
`PUT`、`PATCH` 或 `DELETE`。部署后至少验证：

```bash
curl -i -X OPTIONS https://api.example.com/v0/search/subjects \
  -H 'Origin: https://client.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
curl -i -X GET https://api.example.com/v0/search/subjects
curl -i -X POST https://api.example.com/v0/subjects/26803
curl -I https://api.example.com/v0/subjects/26803
curl -I https://img.example.com/pic/cover/l/1b/3e/26803_s2xEw.jpg
```

其中 search 的 `GET` 与 subject 的 `POST` 应返回 `405`；合法 preflight/read 应返回
对应的 `204`/上游状态，且响应不得包含 `Access-Control-Allow-Credentials` 或
`Set-Cookie`。

## SEO 处理

反代域名默认返回：

```http
X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex
```

`robots.txt` 默认返回：

```text
User-agent: *
Allow: /
```

这里故意使用 `Allow: /`。这样搜索引擎可以抓到页面，然后看到 `X-Robots-Tag: noindex`，已收录内容会逐步移除。直接 `Disallow: /` 会让爬虫看不到 `noindex`，不利于清理已经收录的 URL。

## Nginx 部署

先安装带这些模块的 Nginx：

- `http_ssl`
- `http_v2`
- `http_realip`
- `http_sub`

可以使用系统包，也可以使用：

```bash
curl -sSL https://n.wtf/install/ | bash
```

然后部署配置：

1. 复制 `bangumi-proxy.nginx.conf` 到服务器。
2. 把 `api.example.com` 和 `img.example.com` 改成自己的域名。
3. 配好证书路径。可以使用 Cloudflare Origin 证书，也可以使用 Let's Encrypt。
4. 放到 `/etc/nginx/conf.d/bangumi-proxy.conf`。
5. 测试并重载：

```bash
nginx -t
systemctl reload nginx
```

部署后检查：

```bash
curl -I https://api.example.com/v0/subjects/26803
curl -I 'https://api.example.com/v0/subjects/26803/image?type=large'
curl -I https://img.example.com/pic/cover/l/1b/3e/26803_s2xEw.jpg
curl https://api.example.com/robots.txt
```

`/v0/subjects/{id}/image?type=large` 应该保留 `301` 或 `302`，并把 `Location` 改成图片反代域名：

```http
Location: https://img.example.com/pic/cover/...
```

这对 Jellyfin Bangumi 插件很重要。插件会读取 `Location` 里的图片地址。

## Caddy 部署

Caddy 标准版没有内置响应体替换能力。要使用 `bangumi-proxy.Caddyfile`，需要带 `replace-response` 插件的 Caddy。

示例构建方式：

```bash
xcaddy build --with github.com/caddyserver/replace-response
```

Caddyfile 里做了两类改写：

- 用 `replace` 改 JSON 响应体里的 `lain.bgm.tv`。
- 用 `header_down Location` 改 API 302 响应头里的图片地址。

部署前同样要把 `api.example.com` 和 `img.example.com` 改成自己的域名。

## Worker 部署

`worker.js` 适合轻量代理：

- API 响应体会改写图片域名。
- API 3xx 响应使用 `redirect: "manual"`，保留原状态码，并改写 `Location`。
- 图片走 Worker Cache。

使用前修改文件顶部的域名：

```js
const API_HOST = "api.example.com";
const IMG_HOST = "img.example.com";
```

如果图片流量较大，不建议用 Worker 承担全部图片代理。优先使用 Nginx + Cloudflare 缓存。

## Web 镜像

再次强调：不要公开提供 `bgm.tv` Web 镜像。

`bangumi-web-interactive.nginx.conf` 会代理登录、Cookie、评论和条目操作。它适合自用或小范围验证，不适合公开服务。

`bangumi-web-mirror.nginx.conf` 是只读版本，风险仍然存在。只读不等于安全公开。

如果确实要自用，至少做到：

- 放在 Cloudflare 后面。
- 源站只允许 Cloudflare IP 和自己的健康检查 IP。
- 不启用本地缓存。
- 保留 `X-Robots-Tag: noindex`。
- 不在公开页面、文档或社交平台传播镜像地址。

## 常见问题

### API JSON 里的图片地址还是 `lain.bgm.tv`

确认 API 反代关闭了上游压缩：

```nginx
proxy_set_header Accept-Encoding "";
```

`sub_filter` 只能可靠处理未压缩的文本响应。

### `/image?type=large` 跳到了 `lain.bgm.tv`

确认 API 反代里有：

```nginx
proxy_redirect https://lain.bgm.tv/ https://img.example.com/;
proxy_redirect http://lain.bgm.tv/ https://img.example.com/;
```

Caddy 版本需要确认有：

```caddy
header_down Location "^https?://lain\\.bgm\\.tv/(.*)$" "https://img.example.com/$1"
```

Worker 版本需要使用 `redirect: "manual"`，不要跟随上游 302。

### 搜索引擎已经收录了反代域名

保留 `Allow: /` 和 `X-Robots-Tag: noindex`，等待搜索引擎重新抓取。需要更快处理时，用 Google Search Console 或 Bing Webmaster Tools 的移除工具。

### 直连源站 443 不通

这是预期行为。生产环境应该只允许 Cloudflare IP 访问源站 80/443。

如果健康检查机需要直连源站，需要单独放行健康检查机 IP。否则故障转移程序会误判源站不可用。
