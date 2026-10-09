// Cloudflare Worker: serves the built page (dist/) as static assets and proxies
// /koios/* -> https://api.koios.rest/api/v1/*.
// Why the proxy: the browser then only talks to this site (no CORS; works behind
// corporate HTTPS inspection that breaks cross-origin requests). Only the endpoints
// this tool needs are allowed, so it can't be used as a general-purpose proxy.
// Optional: `npx wrangler secret put KOIOS_TOKEN` (free at koios.rest) for higher limits.

const UPSTREAM = "https://api.koios.rest/api/v1/";
const ALLOWED = new Set([
  "tip", "epoch_params",              // protocol params (Lucid)
  "address_utxos", "utxo_info",       // vault discovery
  "datum_info", "tx_status",          // Lucid helpers
  "submittx",                         // submission (Lucid)
]);
const MAX_BODY = 64 * 1024; // a signed tx is < 16 KB; JSON queries are tiny

async function koiosProxy(request, env, path) {
  if (!ALLOWED.has(path)) return new Response("Endpoint not allowed", { status: 403 });
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const headers = { Accept: request.headers.get("Accept") || "application/json" };
  const ct = request.headers.get("Content-Type");
  if (ct) headers["Content-Type"] = ct;
  if (env.KOIOS_TOKEN) headers.Authorization = `Bearer ${env.KOIOS_TOKEN}`;

  let body;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return new Response("Body too large", { status: 413 });
  }
  const url = new URL(request.url);
  const upstream = await fetch(UPSTREAM + path + url.search, { method: request.method, headers, body });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/koios/")) {
      return koiosProxy(request, env, url.pathname.slice("/koios/".length));
    }
    return env.ASSETS.fetch(request);
  },
};
