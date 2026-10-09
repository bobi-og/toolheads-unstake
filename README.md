# Vault Unlock

Unofficial community tool for returning your own NFTs from the vault script
`4e184586ce5d62d46e0d1ab3305f1d7b811278f1c27eecbf2baacc4d` (used by the Toolheads
staking vault) back to your wallet.

> **Disclaimer.** Use at your own risk. It worked for me; it may not work for you.
> I take no responsibility for anything. I offer no support. Check the transaction in
> your wallet before signing. Beware of scammers: nobody legitimate will DM you about
> this, and nothing here ever needs your seed phrase. Not affiliated with Toolheads,
> CNFT Tools or any marketplace.

## How it works

The vault validator (Plutus V2, 238 bytes, decompiled) checks exactly two things:

1. the redeemer is `Constr 0 [bytes "Toolheads"]`;
2. the payment key hash in the datum `Constr 0 [bytes pkh]` signed the transaction.

There is no admin key, deadline or output check. So the original depositor's wallet can
unlock its own UTXOs, and nobody else can.

The page:

1. connects any CIP-30 wallet (Eternl, Lace, Vespr, Typhon, …);
2. derives the vault address for each of the wallet's stake keys (vault script plus your
   stake key, as deposits used) and lists the UTXOs there whose datum owner is one of
   the wallet's payment keys. It handles both inline and by-hash datums, in either CBOR
   encoding. You can also add a UTXO manually by `txhash#index`;
3. builds one transaction (max 20 UTXOs) that sends everything to the wallet's change
   address, evaluates the script locally, and shows a review;
4. enables signing only if every selected vault input is present, all required signers
   are the wallet's own keys, every output goes to the wallet, and every token comes back.

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
