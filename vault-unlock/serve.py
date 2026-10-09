#!/usr/bin/env python3
"""
Local alternative to the Cloudflare Worker. Serves dist/ on http://localhost:8000 and proxies /koios/* -> https://api.koios.rest/api/v1/*.

The page talks only to localhost (same origin, no CORS); Python makes the Koios
calls, so TLS inspection is handled the same way as in toolhead_vault_probe.py:
  - CA_BUNDLE=/path/corp-root.pem   explicit corporate CA, or
  - pip install truststore          use the OS trust store, or
  - default Python trust store.
Verification is never disabled.

Usage:  python serve.py   (from the toolhead-unlock folder)
"""
import os, ssl, sys, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial

UPSTREAM = "https://api.koios.rest/api/v1"
PORT = int(os.environ.get("PORT", "8000"))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
ALLOWED = {"tip", "epoch_params", "address_utxos", "utxo_info", "datum_info", "tx_status", "submittx"}

if os.environ.get("CA_BUNDLE"):
    CTX = ssl.create_default_context(cafile=os.environ["CA_BUNDLE"]); TLS = "CA_BUNDLE"
else:
    try:
        import truststore
        CTX = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT); TLS = "OS trust store (truststore)"
    except ImportError:
        CTX = ssl.create_default_context(); TLS = "Python default"


class Handler(SimpleHTTPRequestHandler):
    def _proxy(self):
        endpoint = self.path[len("/koios/"):].split("?")[0]
        if endpoint not in ALLOWED:
            return self.send_error(403, "Endpoint not allowed")
        url = UPSTREAM + self.path[len("/koios"):]
        body = None
        if self.command == "POST":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() in ("content-type", "accept")}
        req = urllib.request.Request(url, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
                status, data, ctype = r.status, r.read(), r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, data, ctype = e.code, e.read(), e.headers.get("Content-Type", "text/plain")
        except Exception as e:  # network / TLS problem -> show it clearly in the page log
            status, data, ctype = 502, f"proxy -> Koios failed: {e!r}".encode(), "text/plain"
            print(f"  !! {self.command} {url}: {e!r}", file=sys.stderr)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/koios/"): return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/koios/"): return self._proxy()
        self.send_error(405)


if __name__ == "__main__":
    print(f"TLS trust: {TLS}")
    print(f"Open http://localhost:{PORT}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=ROOT)).serve_forever()
