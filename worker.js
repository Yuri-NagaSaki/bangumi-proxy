/**
 * Bangumi 反向代理 - Cloudflare Worker 版
 * --------------------------------------------------
 * 代理：
 *   api.bgm.tv   (v0 REST API)   ->  你的 API 域名
 *   lain.bgm.tv  (图片 CDN)       ->  你的图片域名
 *
 * 关键点：API 返回的 JSON 里图片地址是写死的 lain.bgm.tv 绝对 URL，
 * 本 Worker 会自动把响应体里的 lain.bgm.tv 改写成你的图片域名，
 * 这样客户端拿到数据后只访问你的域名，不会再碰被污染的 bgm.tv。
 *
 * ============== 部署（3 步）==============
 *  1. 把下面 CONFIG 里的 API_HOST / IMG_HOST 改成你的两个域名。
 *  2. Cloudflare Dashboard -> Workers & Pages -> Create -> 贴入本文件 -> Deploy。
 *  3. 进入该 Worker -> Settings -> Domains & Routes -> Add Custom Domain，
 *     把上面填的两个域名都绑上去。
 *
 * 域名随便取、根域不限，只要这里填对哪个是 API、哪个是图片即可。
 * 调试：访问 https://你的域名/__health 查看识别到的角色和上游。
 */

// ====== CONFIG（必填：填你的两个域名）======
const API_HOST = "api.example.com"; // 你的 API 域名（代理 api.bgm.tv）
const IMG_HOST = "img.example.com"; // 你的图片域名（代理 lain.bgm.tv）

// 上游（不要改）
const BGM_API = "api.bgm.tv";
const BGM_IMG = "lain.bgm.tv";

// 图片缓存时长（秒），默认 30 天
const IMG_CACHE_TTL = 30 * 24 * 60 * 60;
const ROBOTS_TXT = "User-agent: *\nAllow: /\n";
const X_ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet, noimageindex";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: noIndexHeaders(corsHeaders()) });
    }

    const role = resolveRole(host);

    if (url.pathname === "/robots.txt") {
      return new Response(ROBOTS_TXT, {
        headers: noIndexHeaders({
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "cdn-cache-control": "no-store",
          "cloudflare-cdn-cache-control": "no-store",
        }),
      });
    }

    // 健康检查 / 调试
    if (url.pathname === "/__health") {
      return json({
        ok: true,
        host,
        role,
        upstream: role === "img" ? BGM_IMG : BGM_API,
        apiHost: API_HOST,
        imgHost: IMG_HOST,
      });
    }

    return role === "img"
      ? handleImage(request, url, ctx)
      : handleApi(request, url);
  },
};

// ---------- API：代理 + 改写响应体里的 lain.bgm.tv ----------
async function handleApi(request, url) {
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
  setNoIndex(headers);

  // 文本/JSON 才改写
  if (ct.includes("application/json") || ct.includes("text/")) {
    let text = await resp.text();
    text = text.split(BGM_IMG).join(IMG_HOST); // 同时覆盖 https://lain.bgm.tv 和裸域名
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
    setNoIndex(r.headers);
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
  setNoIndex(out.headers);

  if (resp.status === 200) {
    out.headers.set("cache-control", `public, max-age=${IMG_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
  }
  return out;
}

// ---------- 工具函数 ----------
function resolveRole(host) {
  if (host === IMG_HOST) return "img";
  if (host === API_HOST) return "api";
  return "api"; // 未匹配的域名默认按 API 处理
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

function setNoIndex(headers) {
  headers.set("X-Robots-Tag", X_ROBOTS_TAG);
}

function noIndexHeaders(headers) {
  const out = new Headers(headers);
  setNoIndex(out);
  return out;
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: noIndexHeaders({ "content-type": "application/json; charset=utf-8", ...corsHeaders() }),
  });
}
