import "./polyfills.js";
import { Lucid, Koios, CML, toText } from "@lucid-evolution/lucid";
import {
  vaultAddressFor, toolAddress, matchOwnedUtxo, datumHashesToResolve, buildUnlock,
  paymentKeyHash, stakeKeyHash, contractForAddress, unlockableFrom, CONTRACTS, MAX_INPUTS_PER_TX,
} from "./vault.js";
import { selfTest } from "./selftest.js";

// Koios base URL. Default: same-origin proxy (Cloudflare Worker, vite dev proxy, serve.py).
// Static hosts without a proxy (GitHub Pages) build with VITE_KOIOS_URL=https://api.koios.rest/api/v1
// and call Koios directly from the browser.
const KOIOS = import.meta.env.VITE_KOIOS_URL || `${location.origin}/koios`;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const log = (msg, cls = "") => $("log").append(el("div", { className: cls, textContent: msg }));
const row = (dl, k, v, cls = "") => dl.append(el("dt", { textContent: k }), el("dd", { textContent: v, className: cls }));
const ada = (l) => `${(Number(l) / 1e6).toFixed(6)} ADA`;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// Registered tickers that differ from the on-chain asset name.
const KNOWN = { "ac015c38917f306a84748c2d646bed90bdd64421c592163e60702d735453555255": "TOOL" };
const assetLabel = (unit) => {
  if (KNOWN[unit]) return KNOWN[unit];
  const nameHex = unit.slice(56);
  try { const t = toText(nameHex); if (/^[\x20-\x7e]+$/.test(t)) return t; } catch {}
  return nameHex ? `${unit.slice(0, 8)}…/${nameHex.slice(0, 16)}` : unit.slice(0, 12);
};

async function koios(path, body, query = "") {
  const r = await fetch(`${KOIOS}/${path}${query}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Koios ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ----- state -----
let lucid, api, walletAddrs = new Set(), walletPkhs = new Set(), walletStakes = new Set(), changeAddr;
const found = new Map(); // "tx#ix" -> {contract, utxo, ownerPkh, lockTime, inline}
const fmtNum = (q) => q.toLocaleString("en-US");
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
let signBuilder;

// ----- disclaimer gate -----
$("accept").onchange = () => renderWallets();

function renderWallets() {
  const box = $("wallets"); box.textContent = "";
  if (!$("accept").checked) { box.append(el("span", { className: "sub", textContent: "Tick the box above first." })); return; }
  const wallets = Object.entries(window.cardano ?? {})
    .filter(([, w]) => w && typeof w.enable === "function" && w.name)
    .filter(([k], i, arr) => arr.findIndex(([, w2]) => w2 === window.cardano[k]) === i);
  if (!wallets.length) {
    box.append(el("span", { className: "err", textContent: "No Cardano wallet extension found. Install one (Eternl, Lace, Vespr, Typhon…) and reload." }));
    return;
  }
  for (const [key, w] of wallets) {
    const b = el("button", {}, w.icon ? el("img", { src: w.icon, alt: "" }) : "", w.name);
    b.onclick = () => connect(key, w.name);
    box.append(b);
  }
}
// Wallet extensions inject asynchronously; re-render a few times.
for (const t of [300, 1000, 2500]) setTimeout(() => $("accept").checked && !lucid && renderWallets(), t);

// ----- connect -----
async function connect(key, name) {
  try {
    api = await window.cardano[key].enable();
    if ((await api.getNetworkId()) !== 1) throw new Error("Wallet is not on mainnet.");
    lucid = await Lucid(new Koios(KOIOS), "Mainnet");
    lucid.selectWallet.fromAPI(api);

    const hexToBech = (h) => CML.Address.from_hex(h).to_bech32();
    const used = (await api.getUsedAddresses()).map(hexToBech);
    const unused = (await api.getUnusedAddresses().catch(() => [])).map(hexToBech);
    changeAddr = hexToBech(await api.getChangeAddress());
    walletAddrs = new Set([...used, ...unused, changeAddr]);
    walletPkhs = new Set([...walletAddrs].map(paymentKeyHash).filter(Boolean));
    walletStakes = new Set((await api.getRewardAddresses()).map((h) => h.slice(2)));
    for (const a of walletAddrs) { const s = stakeKeyHash(a); if (s) walletStakes.add(s); }

    const dl = $("walletInfo"); dl.textContent = "";
    row(dl, "Wallet", name);
    row(dl, "Payment keys seen", String(walletPkhs.size));
    row(dl, "Stake keys", String(walletStakes.size));
    log(`Connected to ${name}.`, "ok");
    $("manualAdd").disabled = false;
    await discover();
  } catch (e) { log(errText(e), "err"); console.error(e); }
}

// ----- discovery -----
/** All UTXOs at the given addresses (Koios pages at 1000 rows). */
async function addressUtxos(addresses) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await koios("address_utxos", { _addresses: addresses, _extended: true }, `?offset=${offset}&limit=1000`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
/** datum_hash -> CBOR for by-hash datums (TOOL staking datums can't be recomputed). */
async function resolveDatums(rows) {
  const hashes = datumHashesToResolve(rows);
  const map = new Map();
  for (let i = 0; i < hashes.length; i += 100) {
    const res = await koios("datum_info", { _datum_hashes: hashes.slice(i, i + 100) });
    for (const d of res) if (d.bytes) map.set(d.datum_hash, d.bytes);
  }
  return map;
}
function addMatches(rows, datums) {
  let added = 0;
  for (const u of rows) {
    const m = matchOwnedUtxo(u, walletPkhs, datums);
    if (m) { found.set(`${u.tx_hash}#${u.tx_index}`, m); added++; }
  }
  return added;
}

async function discover() {
  // 1) NFT vault: one address per stake key
  const vaultAddrs = [...walletStakes].map((s) => vaultAddressFor(s));
  log(`Searching the NFT vault for your ${vaultAddrs.length} stake key(s)…`);
  const vaultRows = await addressUtxos(vaultAddrs);
  const nVault = addMatches(vaultRows, new Map());
  const foreign = vaultRows.length - nVault;
  log(`NFT vault: ${nVault} UTXO(s) you can unlock.` + (foreign ? ` ${foreign} more at your vault address belong to a key this wallet account didn't expose. Try another account, or add them by reference.` : ""), nVault ? "ok" : "");

  // 2) TOOL staking: one shared address; owners are only visible in the datums
  log("Searching TOOL staking (shared address, checking every stake's owner)…");
  const toolRows = await addressUtxos([toolAddress()]);
  const datums = await resolveDatums(toolRows);
  const nTool = addMatches(toolRows, datums);
  const unresolved = datumHashesToResolve(toolRows).filter((h) => !datums.has(h)).length;
  log(`TOOL staking: ${nTool} stake(s) of yours among ${toolRows.length}.` + (unresolved ? ` (${unresolved} stake datums couldn't be looked up; if yours is missing, add it by reference.)` : ""), nTool ? "ok" : "");
  renderFound();
}

$("manualAdd").onclick = async () => {
  const ref = $("manualRef").value.trim();
  if (!/^[0-9a-f]{64}#\d+$/i.test(ref)) { log("Reference must look like <64 hex chars>#<index>.", "err"); return; }
  try {
    const [u] = await koios("utxo_info", { _utxo_refs: [ref.toLowerCase()], _extended: true });
    if (!u) throw new Error("UTXO not found.");
    if (u.is_spent) throw new Error("That UTXO is already spent.");
    if (!contractForAddress(u.address)) throw new Error("That UTXO is not at a supported contract.");
    const m = matchOwnedUtxo(u, walletPkhs, await resolveDatums([u]));
    if (!m) throw new Error("Its owner key isn't in this wallet account (or its datum couldn't be found). Only the depositor's key can unlock it.");
    found.set(`${u.tx_hash}#${u.tx_index}`, m);
    log(`Added ${ref}.`, "ok"); renderFound();
  } catch (e) { log(errText(e), "err"); }
};

function renderFound() {
  const box = $("found"); box.textContent = "";
  if (!found.size) { box.append(el("span", { className: "sub", textContent: "Nothing found for this wallet." })); $("build").disabled = true; return; }
  let n = 0;
  const now = Date.now();
  for (const [ref, m] of found) {
    const ready = unlockableFrom(m) <= now;
    const cb = el("input", { type: "checkbox", checked: ready && n < MAX_INPUTS_PER_TX, disabled: !ready });
    if (cb.checked) n++;
    cb.dataset.ref = ref; cb.onchange = updateBuildButton;
    const tokens = Object.keys(m.utxo.assets).filter((k) => k !== "lovelace");
    const status = m.lockTime == null ? "" : ready ? ` · lock ended ${fmtDate(m.lockTime)}` : ` · locked until ${fmtDate(m.lockTime)}`;
    box.append(el("label", { className: "utxo" }, cb, el("div", {},
      el("div", { className: "kind", textContent: CONTRACTS[m.contract].label + status }),
      el("div", { className: "mono", textContent: ref }),
      el("div", { className: "assets" },
        el("span", { className: "pill", textContent: ada(m.utxo.assets.lovelace) }),
        ...tokens.map((t) => el("span", { className: "pill", textContent: `${assetLabel(t)}${m.utxo.assets[t] > 1n ? ` ×${fmtNum(m.utxo.assets[t])}` : ""}` }))),
    )));
  }
  updateBuildButton();
}
const selected = () => [...document.querySelectorAll("#found input:checked")].map((c) => found.get(c.dataset.ref));
function updateBuildButton() {
  const n = selected().length;
  $("build").disabled = n === 0 || n > MAX_INPUTS_PER_TX;
  $("build").textContent = n > MAX_INPUTS_PER_TX ? `Select at most ${MAX_INPUTS_PER_TX}` : `Build unlock transaction (${n})`;
  $("sign").disabled = true;
}

// ----- build & review -----
$("build").onclick = async () => {
  $("build").disabled = true; $("sign").disabled = true;
  try {
    const items = selected();
    log(`Building for ${items.length} UTXO(s); evaluating the script locally…`);
    signBuilder = await buildUnlock(lucid, items, changeAddr, Date.now());
    const body = signBuilder.toTransaction().body();
    const dl = $("summary"); dl.textContent = "";

    const ins = body.inputs(); const inRefs = new Set();
    for (let i = 0; i < ins.len(); i++) inRefs.add(`${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`);
    const vaultInsOk = items.every((m) => inRefs.has(`${m.utxo.txHash}#${m.utxo.outputIndex}`));
    row(dl, "Contract inputs", vaultInsOk ? `${items.length} selected ✓` : "MISSING", vaultInsOk ? "ok" : "err");
    row(dl, "Wallet inputs", String(inRefs.size - items.length));

    const rs = body.required_signers(); const signers = [];
    if (rs) for (let i = 0; i < rs.len(); i++) signers.push(rs.get(i).to_hex());
    const signersOk = signers.length > 0 && signers.every((s) => walletPkhs.has(s));
    row(dl, "Required signers", signersOk ? `${signers.length}, all your keys ✓` : "UNEXPECTED", signersOk ? "ok" : "err");

    const outs = body.outputs(); let allMine = true; const back = {};
    for (let i = 0; i < outs.len(); i++) {
      const o = outs.get(i); const addr = o.address().to_bech32();
      const mine = walletAddrs.has(addr) || (paymentKeyHash(addr) && walletStakes.has(stakeKeyHash(addr)));
      allMine &&= !!mine;
      const ma = o.amount().multi_asset(); const pols = ma.keys();
      for (let p = 0; p < pols.len(); p++) {
        const pid = pols.get(p).to_hex(); const names = ma.get_assets(pols.get(p)); const nk = names.keys();
        for (let n = 0; n < nk.len(); n++) {
          const unit = pid + toHex(nk.get(n).to_raw_bytes());
          if (mine) back[unit] = (back[unit] ?? 0n) + names.get(nk.get(n));
        }
      }
      row(dl, `Output ${i}`, `${addr}  ·  ${ada(o.amount().coin())}`, mine ? "" : "err");
    }
    row(dl, "All outputs to your wallet", allMine ? "yes ✓" : "NO — do not sign", allMine ? "ok" : "err");
    const want = {}; for (const m of items) for (const [k, q] of Object.entries(m.utxo.assets)) if (k !== "lovelace") want[k] = (want[k] ?? 0n) + q;
    const tokensOk = Object.entries(want).every(([k, q]) => (back[k] ?? 0n) >= q);
    row(dl, "Tokens returned to you", `${Object.keys(want).length} kind(s) ${tokensOk ? "✓" : "MISSING"}`, tokensOk ? "ok" : "err");
    row(dl, "Fee", ada(body.fee()));
    if (body.validity_interval_start() != null) row(dl, "Valid for", "about 15 minutes — sign before it expires, or rebuild");
    row(dl, "Collateral", body.collateral_inputs() ? "set (only taken if the script fails on-chain)" : "none");

    $("cbor").textContent = signBuilder.toTransaction().to_cbor_hex(); $("cborBox").classList.remove("hidden");
    if (vaultInsOk && signersOk && allMine && tokensOk) { $("sign").disabled = false; log("Built. Review above, then sign.", "ok"); }
    else log("Safety checks failed — signing disabled.", "err");
  } catch (e) { log(errText(e), "err"); console.error(e); }
  $("build").disabled = false;
};

// ----- sign & submit -----
$("sign").onclick = async () => {
  $("sign").disabled = true;
  try {
    log("Waiting for your wallet…");
    const signed = await signBuilder.sign.withWallet().complete();
    const hash = await signed.submit();
    const link = el("a", { href: `https://cardanoscan.io/transaction/${hash}`, target: "_blank", rel: "noopener noreferrer", textContent: hash });
    $("result").textContent = ""; $("result").append(el("p", { className: "ok" }, "Submitted: ", link));
    log("Submitted. Your assets arrive once it's in a block (usually under a minute).", "ok");
    for (const m of selected()) found.delete(`${m.utxo.txHash}#${m.utxo.outputIndex}`);
    renderFound();
  } catch (e) { log(errText(e), "err"); console.error(e); $("sign").disabled = false; }
};

// ----- self-test -----
$("selftest").onclick = async () => {
  $("selftest").disabled = true;
  try { log("Self-test running…"); await selfTest((m) => log(m, "ok")); log("Self-test passed.", "ok"); }
  catch (e) { log("Self-test FAILED: " + errText(e), "err"); console.error(e); }
  $("selftest").disabled = false;
};

function errText(e) {
  const s = e?.message ?? e?.info ?? (typeof e === "string" ? e : JSON.stringify(e));
  if (/collateral/i.test(s)) return s + "  (Tip: keep ~5 ADA of plain ADA, no tokens, in this wallet for collateral.)";
  if (/user declined|declined|rejected by user/i.test(s)) return "You declined in the wallet. Nothing was sent.";
  return s;
}
