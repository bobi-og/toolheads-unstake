# Vault Unlock

Unofficial community tool for returning your own staked assets to your wallet from two
Toolheads contracts:

| Contract | Script hash | Holds |
|---|---|---|
| NFT vault (Plutus V2) | `4e184586ce5d62d46e0d1ab3305f1d7b811278f1c27eecbf2baacc4d` | Toolhead NFTs |
| TOOL staking (Plutus V3) | `c7ab6ff0df90974fa01fcd7971336791207c475324f1b288e5808e5f` | TOOL tokens (on-chain name `TSURU`) |

> **Disclaimer.** Use at your own risk. It worked for me; it may not work for you.
> I take no responsibility for anything. I offer no support. Check the transaction in
> your wallet before signing. Beware of scammers: nobody legitimate will DM you about
> this, and nothing here ever needs your seed phrase. Not affiliated with Toolheads,
> CNFT Tools or any marketplace.

## What the contracts check (decompiled)

**NFT vault:** the redeemer is `Constr 0 [bytes "Toolheads"]`, and the payment key hash in
the datum `Constr 0 [bytes pkh]` signed the transaction.

**TOOL staking:** the datum is `Constr 0 [int lockTimeMs, bytes pkh]`. The transaction's
validity range must have a finite start after `lockTimeMs`, and `pkh` must have signed.
The redeemer isn't read.

Neither contract has an admin key, a deadline beyond that lock, or an output check. So
the original staker's wallet can unlock its own UTXOs, and nobody else can.

## How the page works

1. It connects any CIP-30 wallet (Eternl, Lace, Vespr, Typhon, …).
2. It finds your UTXOs.
   - NFT vault: the address is the vault script plus your stake key, so it searches one
     address per stake key in the wallet.
   - TOOL staking: every staker shares one enterprise address, and owners are only
     visible in datums stored by hash. So it lists that address, resolves the datums
     with Koios `datum_info`, and keeps the ones whose owner is a key in your wallet.
   - Fallback: add a UTXO manually by `txhash#index`.
   - TOOL stakes still inside their lock time are shown but can't be selected.
3. It builds one transaction (max 20 UTXOs, mixing both contracts is fine) that sends
   everything to the wallet's change address. If any TOOL stake is included, it sets a
   15-minute validity window. It evaluates the scripts locally and shows a review.
4. It enables signing only if every selected contract input is present, all required
   signers are the wallet's own keys, every output goes to the wallet, and every token
   comes back.

All chain reads and the submission go through a same-origin proxy at `/koios/*`. It's
handled by the Cloudflare Worker in `worker/index.js`, restricted to the 7 Koios
endpoints the tool needs. That avoids CORS and works behind corporate HTTPS inspection.
Everything else is served as static files from `dist/`.

## Deploy to Cloudflare (Workers with static assets)

**From the dashboard (Git-connected):** Workers & Pages → Create → Import a repository → pick the repo.

- Project name: must match `name` in `wrangler.toml` (`toolheads-unstake`). Change both if you rename.
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Path: `/`

Optional, for higher Koios rate limits: after the first deploy, go to the Worker →
Settings → Variables and Secrets → add a **secret** `KOIOS_TOKEN` (free at koios.rest).
That's a runtime secret, not a build variable.

**From your machine:**

```
npm ci && npm run build
npx wrangler deploy          # first run asks you to log in
```

## Deploy to GitHub Pages (no proxy)

1. Push to GitHub (branch `main`).
2. Repo Settings → Pages → Source: **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` tests, builds with
   `VITE_KOIOS_URL=https://api.koios.rest/api/v1` and publishes to
   `https://<user>.github.io/<repo>/`.

Without the proxy, the browser calls Koios directly. That works on normal connections,
but can fail behind corporate HTTPS inspection or filtering. Users there can run it
locally with `serve.py`.

## Run locally

```
npm ci && npm test           # emulator test: discovery + unlock + negative cases
npm run dev                  # http://localhost:5173, Koios proxied by Vite
# or, without Node at runtime:
npm run build && python serve.py   # http://localhost:8000; honours CA_BUNDLE / truststore
```

## Files

- `src/vault.js`: validator, UTXO ownership matching, transaction building, plus an
  evaluator fix (Lucid Evolution 0.6.x drops datum hashes during local evaluation).
- `src/main.js`: page logic and pre-signing safety checks.
- `src/selftest.js`: emulator test, also runnable from the page.
- `worker/index.js`: Cloudflare Worker that serves `dist/` and proxies Koios (endpoint allowlist).
- `wrangler.toml`: Worker config. `/koios/*` runs the Worker; everything else is static.
- `public/_headers`: no framing, no referrer, and so on.
- `serve.py`: local server with the same proxy.

Dependencies are pinned (`@lucid-evolution/lucid` 0.6.7). The evaluator fix relies on
that version's behaviour, so re-run `npm test` before upgrading.
