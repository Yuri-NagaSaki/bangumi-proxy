/**
 * Bangumi 反向代理 - Cloudflare Worker 版
 * --------------------------------------------------
 * 代理：
 *   api.bgm.tv   (v0 REST API)   ->  你的 API 自定义域名
 *   lain.bgm.tv  (图片 CDN)       ->  你的图片自定义域名
 *
 * 关键点：API 返回的 JSON 里图片地址是写死的 lain.bgm.tv 绝对 URL，
 * 本 Worker 会自动把响应体里的 lain.bgm.tv 改写成你的图片域名，
 * 这样客户端拿到数据后只访问你的域名，不会再碰被污染的 bgm.tv。
 *
 * ============== 部署（复制粘贴即可）==============
 *  1. Cloudflare Dashboard -> Workers & Pages -> Create -> 把本文件全部贴进去 -> Deploy
 *  2. 进入该 Worker -> Settings -> Domains & Routes -> Add Custom Domain
 *     绑定两个子域，例如：
 *         api.example.com
 *         img.example.com
 *  3. 完成。下面的 CONFIG 一般不用改（按 api./img. 前缀自动识别）。
 *
 * 如果你的子域名不是 api. / img. 开头，请在下面 CONFIG 里写死。
 * 调试：访问 https://你的域名/__health 查看识别到的角色和上游。
 *
 * ============== 命名约定（零配置的前提）==============
 * 留空下面的 CONFIG 即为全自动，不限制你的根域，只约定子域第一段的关键词：
 *   · API 域名：第一段含 "api"   （如 api / bgmapi / bangumi-api）
 *   · 图片域名：第一段含 "img"   （如 img / bgmimg / pic / cdn / lain）
 *   · 两者用同一个根域           （example.com / foo.net 都行，随便）
 * 改写时会把 API 域名第一段里的 "api" 换成 "img"、根域原样保留：
 *   bgmapi.example.com  ->  bgmimg.example.com   （自动）
 * 不符合该约定（比如图片域名不含 img、或两域名根域不同）时，
 * 才需要在 CONFIG 里写死 API_HOST / IMG_HOST。
 */

// ====== CONFIG（可选；留空=全自动，按上面的命名约定识别）======
const API_HOST = ""; // 仅当域名不符合命名约定时才填，如 "data.example.com"
const IMG_HOST = ""; // 仅当域名不符合命名约定时才填，如 "pics.example.net"

// 上游（不要改）
const BGM_API = "api.bgm.tv";
const BGM_IMG = "lain.bgm.tv";

// 图片缓存时长（秒），默认 30 天
const IMG_CACHE_TTL = 30 * 24 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const role = resolveRole(host);

    // 健康检查 / 调试
    if (url.pathname === "/__health") {
      return json({
        ok: true,
        host,
        role,
        upstream: role === "img" ? BGM_IMG : BGM_API,
        imgHostForRewrite: imgHostFor(host),
      });
    }

    return role === "img"
      ? handleImage(request, url, ctx)
      : handleApi(request, url, host);
  },
};

// ---------- API：代理 + 改写响应体里的 lain.bgm.tv ----------
async function handleApi(request, url, host) {
  const upstreamURL = `https://${BGM_API}${url.pathname}${url.search}`;

  const upstreamReq = new Request(upstreamURL, {
    method: request.method,
    headers: cleanRequestHeaders(request.headers),
    body: hasBody(request.method) ? request.body : undefined,
    redirect: "follow",
  });

  const resp = await fetch(upstreamReq);
  const ct = resp.headers.get("content-type") || "";
  const headers = new Headers(resp.headers);
  setCors(headers);

  // 文本/JSON 才改写
  if (ct.includes("application/json") || ct.includes("text/")) {
    const imgHost = imgHostFor(host);
    let text = await resp.text();
    text = text.split(BGM_IMG).join(imgHost); // 同时覆盖 https://lain.bgm.tv 和裸域名
    headers.delete("content-length");
    headers.delete("content-encoding"); // body 已是解压后的文本
    return new Response(text, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }

  // 其它类型直接透传
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

// ---------- 图片：代理 + 边缘缓存 ----------
async function handleImage(request, url, ctx) {
  const upstreamURL = `https://${BGM_IMG}${url.pathname}${url.search}`;
  const cache = caches.default;
  const cacheKey = new Request(upstreamURL, { method: "GET" });

  let hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("x-cache", "HIT");
    setCors(r.headers);
    return r;
  }

  const upstreamReq = new Request(upstreamURL, {
    method: "GET",
    headers: cleanRequestHeaders(request.headers),
    redirect: "follow",
  });

  const resp = await fetch(upstreamReq);
  const out = new Response(resp.body, resp);
  out.headers.set("x-cache", "MISS");
  setCors(out.headers);

  if (resp.status === 200) {
    out.headers.set("cache-control", `public, max-age=${IMG_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
  }
  return out;
}

// ---------- 工具函数 ----------
function resolveRole(host) {
  if (API_HOST && host === API_HOST) return "api";
  if (IMG_HOST && host === IMG_HOST) return "img";
  const label = (host.split(".")[0] || "").toLowerCase();
  // 命名约定：第一段含 img/pic/lain/cdn -> 图片；其余默认 API
  if (/(img|pic|lain|cdn)/.test(label)) return "img";
  return "api"; // 默认按 API 处理
}

// 改写 API 响应时，把图片指向哪个域名（保留根域，只把第一段的 api 换成 img）
function imgHostFor(host) {
  if (IMG_HOST) return IMG_HOST;
  const parts = host.split(".");
  const first = parts[0];
  // bgmapi -> bgmimg, api -> img；若没有 api 字样则前缀加 img-
  parts[0] = /api/i.test(first) ? first.replace(/api/i, "img") : "img-" + first;
  return parts.join(".");
}

function cleanRequestHeaders(h) {
  const out = new Headers(h);
  out.delete("host");
  out.delete("cf-connecting-ip");
  out.delete("cf-ipcountry");
  out.delete("x-forwarded-host");
  return out;
}

function hasBody(method) {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function setCors(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}
