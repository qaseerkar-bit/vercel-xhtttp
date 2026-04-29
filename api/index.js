export const config = { runtime: "edge" };

// ─── Init-time (یک‌بار در cold start) ───────────────────────────────────────
const TARGET_BASE = (process.env.TARGET_DOMAIN ?? "").replace(/\/+$/, "");

const STRIP_REQ = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
]);

const STRIP_RES = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "trailer",
  "upgrade",
]);

// static response — یک‌بار ساخته میشه
const MISCONFIG_RES = new Response("Misconfigured: TARGET_DOMAIN is not set", {
  status: 500,
  headers: { "content-type": "text/plain" },
});

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (!TARGET_BASE) return MISCONFIG_RES.clone();

  try {
    // URL parse بدون URL object
    const rawUrl = req.url;
    const pathStart = rawUrl.indexOf("/", 8);
    const targetUrl =
      pathStart === -1
        ? TARGET_BASE + "/"
        : TARGET_BASE + rawUrl.slice(pathStart);

    // ─── فیلتر headers — یک loop، همه چیز یکجا ───
    const outHeaders = new Headers();
    let clientIp = "";

    for (const [k, v] of req.headers) {
      if (STRIP_REQ.has(k) || k.startsWith("x-vercel-")) continue;

      if (k === "x-real-ip") {
        clientIp = v;
        continue; // به upstream نفرست، پایین set میشه
      }
      if (k === "x-forwarded-for") {
        if (!clientIp) clientIp = v; // x-real-ip اولویت داره
        continue;
      }

      outHeaders.set(k, v);
    }

    if (clientIp) outHeaders.set("x-forwarded-for", clientIp);

    // ─── fetch ───
    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const upstreamRes = await fetch(targetUrl, {
      method,
      headers: outHeaders,
      body: hasBody ? req.body : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });

    // ─── فیلتر headers response — فقط اگر لازم باشه ───
    for (const k of upstreamRes.headers.keys()) {
      if (STRIP_RES.has(k)) {
        // header مشکل‌دار داریم — rebuild کن
        const resHeaders = new Headers(upstreamRes.headers);
        for (const sk of STRIP_RES) resHeaders.delete(sk);
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: resHeaders,
        });
      }
    }

    // اکثر requestها اینجا میرسن — zero overhead
    return upstreamRes;

  } catch (err) {
    console.error("relay error:", err);
    return new Response("Bad Gateway: Tunnel Failed", { status: 502 });
  }
}
