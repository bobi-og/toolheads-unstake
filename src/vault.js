// Core logic for unlocking UTXOs from two owner-only contracts:
//   - Toolheads NFT vault   4e184586…acc4d  (Plutus V2)
//   - TOOL token staking    c7ab6ff0…808e5f (Plutus V3)
// Pure functions + transaction building; no DOM. Used by the page, the in-browser
// self-test and the Node emulator test.
import {
  Constr, Data, fromText, datumToHash, CML, assetsToValue,
  utxoToTransactionInput, utxoToTransactionOutput, fromCMLRedeemerTag,
} from "@lucid-evolution/lucid";
import * as UPLC from "@lucid-evolution/uplc";

export const MAX_INPUTS_PER_TX = 20;
// Validity window start is set this far in the past (slot rounding + clock skew).
const VALID_FROM_SLACK_MS = 60_000;
const VALID_FOR_MS = 15 * 60_000;

/* -------------------------------------------------------------------------- */
/* Contracts                                                                   */
/* -------------------------------------------------------------------------- */

const hex = (v) => (typeof v === "string" ? v : undefined);

export const CONTRACTS = {
  // Decompiled checks:
  //   1. redeemer == Constr 0 [bytes "Toolheads"]
  //   2. the PKH in datum Constr 0 [bytes pkh] is among the tx signatories
  // Address: script payment credential + the depositor's stake key.
  vault: {
    id: "vault",
    label: "Toolheads NFT vault",
    hash: "4e184586ce5d62d46e0d1ab3305f1d7b811278f1c27eecbf2baacc4d",
    script: {
      type: "PlutusV2",
      script:
        "58ec010000323232323232323222232325333008323232533300b002100114a066e3cdd71801180400324509546f6f6c6865616473003322323300100100322533301000114a026464a66601e66e3c00801452889980200200098098011bae30110013758601a601c601c601c601c601c601c601c601c600e6002600e0086eb8c004c01c0188c034004526163253330083370e900000089919299980698078010a4c2c6eb8c034004c01801058c01800cc94ccc01ccdc3a400000226464a666018601c0042930b1bae300c0013005004163005003230053754002460066ea80055cd2ab9d5573caae7d5d0aba201",
    },
    redeemer: Data.to(new Constr(0, [fromText("Toolheads")])),
    /** @returns {{owner:string}|null} */
    parseDatum(d) {
      if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 1) return null;
      const owner = hex(d.fields[0]);
      return owner?.length === 56 ? { owner, lockTime: null } : null;
    },
  },

  // Decompiled checks (Plutus V3, redeemer is not read):
  //   1. spending, with datum Constr 0 [int lockTimeMs, bytes ownerPkh]
  //   2. tx validity range has a finite lower bound L with lockTime < L
  //      (lockTime <= L if the bound is exclusive)
  //   3. ownerPkh is among the tx signatories
  // Address: enterprise script address (no stake key), shared by all stakers.
  tool: {
    id: "tool",
    label: "TOOL token staking",
    hash: "c7ab6ff0df90974fa01fcd7971336791207c475324f1b288e5808e5f",
    script: {
      type: "PlutusV3",
      script:
        "59016501010029800aba2aba1aba0aab9faab9eaab9dab9a488888896600264653001300800198041804800cdc3a400530080024888966002600460106ea800e2646644b30013370e900018059baa0018992cc004c8c8c8cc8966002601660226ea800a2b3001300b30113754602a602c0071337100026eb4c054c048dd500144cdc48009bad3015301237540048082294101018098009bad3013301037540086602260240026602330013008300e3754602460260034c0103d87a8000a60103d8798000403497ae0300e37546022601c6ea8004c040c044c044c044c044c044c044c044c034dd5002c4c8cc88cc008008004896600200314a115980099b8f375c602600200714a3133002002301400140388088dd618089809180918091809180918091809180918071baa006375c60206022601a6ea8006294100b180798061baa0018b2014300d001300d300e0013009375400716401c300800130033754011149a26cac80081",
    },
    redeemer: Data.to(new Constr(0, [])), // what past unlocks used; the script ignores it
    parseDatum(d) {
      if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 2) return null;
      const [t, o] = d.fields;
      if (typeof t !== "bigint" || hex(o)?.length !== 56) return null;
      return { owner: o, lockTime: Number(t) };
    },
  },
};

/** Mainnet (networkId 1) enterprise address of the TOOL staking contract. */
export function toolAddress(networkId = 1) {
  return CML.EnterpriseAddress.new(
    networkId, CML.Credential.new_script(CML.ScriptHash.from_hex(CONTRACTS.tool.hash)),
  ).to_address().to_bech32();
}

/** NFT vault address for a stake key: script payment credential + that stake key. */
export function vaultAddressFor(stakeKeyHash, networkId = 1) {
  return CML.BaseAddress.new(
    networkId,
    CML.Credential.new_script(CML.ScriptHash.from_hex(CONTRACTS.vault.hash)),
    CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(stakeKeyHash)),
  ).to_address().to_bech32();
}

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

export function paymentKeyHash(bech32) {
  try { return CML.Address.from_bech32(bech32).payment_cred()?.as_pub_key()?.to_hex(); }
  catch { return undefined; }
}
export function stakeKeyHash(bech32) {
  try { return CML.Address.from_bech32(bech32).staking_cred()?.as_pub_key()?.to_hex(); }
  catch { return undefined; }
}
/** The contract whose script is this address's payment credential, if any. */
export function contractForAddress(bech32) {
  try {
    const h = CML.Address.from_bech32(bech32).payment_cred()?.as_script()?.to_hex();
    return Object.values(CONTRACTS).find((c) => c.hash === h);
  } catch { return undefined; }
}

/* -------------------------------------------------------------------------- */
/* Datums                                                                      */
/* -------------------------------------------------------------------------- */

// Two CBOR encodings of the NFT vault's Constr 0 [bytes pkh]; they hash differently.
export const vaultDatumEncodings = (pkh) => [
  `d8799f581c${pkh}ff`, // indefinite-length list (what the vault used, verified on-chain)
  `d87981581c${pkh}`,   // definite-length list
];

/** Koios JSON datum value -> Lucid Data (Constr / bigint / hex string / list). */
function fromKoiosJson(v) {
  if (v == null || typeof v !== "object") return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(v, k); // NB: `"constructor" in {}` is true
  if (has("constructor")) return new Constr(Number(v.constructor), (v.fields ?? []).map(fromKoiosJson));
  if (has("int")) return BigInt(v.int);
  if (has("bytes")) return v.bytes;
  if (has("list")) return v.list.map(fromKoiosJson);
  return null;
}
function safeFromCbor(cbor) { try { return Data.from(cbor); } catch { return null; } }

/**
 * Match a Koios UTXO (address_utxos / utxo_info, _extended) to one of the wallet's keys.
 * @param u          Koios UTXO object
 * @param walletPkhs Set of the wallet's payment key hashes
 * @param datums     Map datum_hash -> datum CBOR (from Koios datum_info), optional
 * @returns null, or {contract, ownerPkh, lockTime, inline, utxo} with utxo in Lucid's shape
 *
 * Koios quirks handled: datum_hash is reported for inline datums too; inline_datum
 * can have bytes:null with only the decoded value.
 */
export function matchOwnedUtxo(u, walletPkhs, datums = new Map()) {
  const address = u.payment_addr?.bech32 ?? u.address;
  const c = contractForAddress(address);
  if (!c) return null;
  const inline = !!u.inline_datum;

  let datumCbor, parsed;
  const tryCbor = (cbor) => {
    const p = cbor && c.parseDatum(safeFromCbor(cbor));
    if (p) { datumCbor = cbor; parsed = p; }
    return !!p;
  };

  if (inline) {
    if (!tryCbor(u.inline_datum.bytes)) {
      parsed = c.parseDatum(fromKoiosJson(u.inline_datum.value));
      if (parsed) datumCbor = Data.to(fromKoiosJson(u.inline_datum.value));
    }
  } else if (u.datum_hash) {
    const known = datums.get(u.datum_hash);
    if (known && datumToHash(known) === u.datum_hash) tryCbor(known);
    // NFT vault datums only contain the owner, so they can be recomputed.
    if (!parsed && c.id === "vault") {
      outer: for (const pkh of walletPkhs) {
        for (const enc of vaultDatumEncodings(pkh)) {
          if (datumToHash(enc) === u.datum_hash) { tryCbor(enc); break outer; }
        }
      }
    }
  }
  if (!parsed || !walletPkhs.has(parsed.owner)) return null;

  const assets = { lovelace: BigInt(u.value) };
  for (const a of u.asset_list ?? []) {
    const unit = a.policy_id + (a.asset_name ?? "");
    assets[unit] = (assets[unit] ?? 0n) + BigInt(a.quantity);
  }
  return {
    contract: c.id, ownerPkh: parsed.owner, lockTime: parsed.lockTime, inline,
    utxo: {
      txHash: u.tx_hash, outputIndex: u.tx_index, address, assets,
      // Inline: tx must NOT carry the datum as a witness (ledger rejects it as
      // "extraneous"); Lucid takes the inline path when datumHash is unset.
      datumHash: inline ? undefined : u.datum_hash,
      datum: datumCbor,
      scriptRef: undefined,
    },
  };
}

/** Datum hashes of non-inline contract UTXOs that need a datum_info lookup. */
export function datumHashesToResolve(rows) {
  return [...new Set(rows
    .filter((u) => !u.inline_datum && u.datum_hash && contractForAddress(u.payment_addr?.bech32 ?? u.address)?.id === "tool")
    .map((u) => u.datum_hash))];
}

/* -------------------------------------------------------------------------- */
/* Evaluator fix                                                               */
/* -------------------------------------------------------------------------- */

// Lucid Evolution 0.6.x drops the datum hash of datum-hash inputs when it hands them
// to its local evaluator ("missing required inline datum or datum hash"). This is
// Lucid's default evaluator with datum-hash UTXOs rebuilt correctly.
const evalOutput = (utxo) => {
  if (!utxo.datumHash) return utxoToTransactionOutput(utxo);
  return CML.TransactionOutput.new(
    CML.Address.from_bech32(utxo.address),
    assetsToValue(utxo.assets),
    CML.DatumOption.new_hash(CML.DatumHash.from_hex(utxo.datumHash)),
  );
};
export const evaluator = {
  name: "aiken-datumhash-fix",
  evaluate: async ({ tx, additionalUTxOs, context }) => {
    const p = context.protocolParameters;
    const res = UPLC.eval_phase_two_raw(
      CML.Transaction.from_cbor_hex(tx).to_cbor_bytes(),
      additionalUTxOs.map((u) => utxoToTransactionInput(u).to_cbor_bytes()),
      additionalUTxOs.map((u) => evalOutput(u).to_cbor_bytes()),
      context.costModels.to_cbor_bytes(), p.maxTxExSteps, p.maxTxExMem,
      BigInt(context.slotConfig.zeroTime), BigInt(context.slotConfig.zeroSlot),
      context.slotConfig.slotLength, p.protocolMajorVersion,
    );
    return res.map((bytes) => {
      const r = CML.LegacyRedeemer.from_cbor_bytes(bytes);
      const ex = r.ex_units();
      return {
        ex_units: { mem: Number(ex.mem()), steps: Number(ex.steps()) },
        redeemer_index: Number(r.index()),
        redeemer_tag: fromCMLRedeemerTag(r.tag()),
      };
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Transaction                                                                 */
/* -------------------------------------------------------------------------- */

/** Earliest time (ms) at which this item can be unlocked, or 0. */
export const unlockableFrom = (item) => (item.lockTime == null ? 0 : item.lockTime + VALID_FROM_SLACK_MS + 1);

/**
 * Unlock several owned UTXOs (any mix of contracts) in one tx; everything goes to
 * `toAddress`.
 * @param items  [{contract, utxo, ownerPkh, lockTime}] from matchOwnedUtxo
 * @param nowMs  current time (Date.now() on mainnet, emulator.now() in tests)
 */
export async function buildUnlock(lucid, items, toAddress, nowMs = Date.now()) {
  if (!items.length) throw new Error("Nothing selected.");
  if (items.length > MAX_INPUTS_PER_TX) throw new Error(`Max ${MAX_INPUTS_PER_TX} per transaction — select fewer and repeat.`);
  const stillLocked = items.filter((i) => unlockableFrom(i) > nowMs);
  if (stillLocked.length) {
    throw new Error(`Still time-locked until ${new Date(Math.max(...stillLocked.map((i) => i.lockTime))).toISOString()}.`);
  }

  const signers = [...new Set(items.map((i) => i.ownerPkh))];
  const total = {};
  let tx = lucid.newTx();
  for (const c of Object.values(CONTRACTS)) {
    const mine = items.filter((i) => i.contract === c.id);
    if (!mine.length) continue;
    const utxos = mine.map((i) => ({ ...i.utxo, assets: { ...i.utxo.assets } }));
    for (const u of utxos) for (const [k, q] of Object.entries(u.assets)) total[k] = (total[k] ?? 0n) + q;
    tx = tx.collectFrom(utxos, c.redeemer).attach.SpendingValidator(c.script);
  }
  for (const s of signers) tx = tx.addSignerKey(s);
  if (items.some((i) => i.lockTime != null)) {
    tx = tx.validFrom(nowMs - VALID_FROM_SLACK_MS).validTo(nowMs + VALID_FOR_MS);
  }
  return tx.pay.ToAddress(toAddress, total).complete({ evaluator });
}

/* Backwards-compatible names */
export const SCRIPT_HASH = CONTRACTS.vault.hash;
export const VAULT_SCRIPT = CONTRACTS.vault.script;
export const REDEEMER = CONTRACTS.vault.redeemer;
export const datumEncodings = vaultDatumEncodings;
export const matchOwnedVaultUtxo = (u, pkhs, datums) => matchOwnedUtxo(u, pkhs, datums);
export const isVaultAddress = (a) => !!contractForAddress(a);
