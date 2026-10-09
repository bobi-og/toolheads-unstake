// Core logic for unlocking UTXOs from the vault script 4e184586…acc4d.
// Pure functions + transaction building; no DOM. Used by the page, the in-browser
// self-test and the Node emulator test.
import {
  Constr, Data, fromText, datumToHash, CML, assetsToValue,
  utxoToTransactionInput, utxoToTransactionOutput, fromCMLRedeemerTag,
} from "@lucid-evolution/lucid";
import * as UPLC from "@lucid-evolution/uplc";

/* -------------------------------------------------------------------------- */
/* The validator                                                               */
/* -------------------------------------------------------------------------- */

// Plutus V2, 238 bytes. blake2b-224(0x02 || bytes) = SCRIPT_HASH.
// Decompiled, it checks exactly two things:
//   1. redeemer == Constr 0 [bytes "Toolheads"]
//   2. the PKH in datum Constr 0 [bytes pkh] is among the tx signatories
export const SCRIPT_HASH = "4e184586ce5d62d46e0d1ab3305f1d7b811278f1c27eecbf2baacc4d";
export const VAULT_SCRIPT = {
  type: "PlutusV2",
  script:
    "58ec010000323232323232323222232325333008323232533300b002100114a066e3cdd71801180400324509546f6f6c6865616473003322323300100100322533301000114a026464a66601e66e3c00801452889980200200098098011bae30110013758601a601c601c601c601c601c601c601c601c600e6002600e0086eb8c004c01c0188c034004526163253330083370e900000089919299980698078010a4c2c6eb8c034004c01801058c01800cc94ccc01ccdc3a400000226464a666018601c0042930b1bae300c0013005004163005003230053754002460066ea80055cd2ab9d5573caae7d5d0aba201",
};
export const REDEEMER = Data.to(new Constr(0, [fromText("Toolheads")]));
export const MAX_INPUTS_PER_TX = 20;

// Two possible CBOR encodings of Constr 0 [bytes pkh]; they hash differently.
export const datumEncodings = (pkh) => [
  `d8799f581c${pkh}ff`, // indefinite-length list (what the vault used, verified on-chain)
  `d87981581c${pkh}`,   // definite-length list
];

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/** Vault address for a stake key: script payment credential + that stake key. */
export function vaultAddressFor(stakeKeyHash, networkId = 1) {
  return CML.BaseAddress.new(
    networkId,
    CML.Credential.new_script(CML.ScriptHash.from_hex(SCRIPT_HASH)),
    CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(stakeKeyHash)),
  ).to_address().to_bech32();
}

/** Payment key hash of a key address, or undefined (script/byron/garbage). */
export function paymentKeyHash(bech32) {
  try { return CML.Address.from_bech32(bech32).payment_cred()?.as_pub_key()?.to_hex(); }
  catch { return undefined; }
}
export function stakeKeyHash(bech32) {
  try { return CML.Address.from_bech32(bech32).staking_cred()?.as_pub_key()?.to_hex(); }
  catch { return undefined; }
}
export function isVaultAddress(bech32) {
  try { return CML.Address.from_bech32(bech32).payment_cred()?.as_script()?.to_hex() === SCRIPT_HASH; }
  catch { return false; }
}

/* -------------------------------------------------------------------------- */
/* Ownership: match a Koios UTXO to one of the wallet's payment keys          */
/* -------------------------------------------------------------------------- */

/**
 * @param u          one element from Koios address_utxos / utxo_info (_extended)
 * @param walletPkhs Set of the wallet's payment key hashes
 * @returns {null | {utxo, ownerPkh, inline}} utxo is in Lucid's UTxO shape
 *
 * Koios quirks handled: datum_hash is reported for inline datums too; inline_datum
 * can have bytes:null with only the decoded value.
 */
export function matchOwnedVaultUtxo(u, walletPkhs) {
  if (!isVaultAddress(u.payment_addr?.bech32 ?? u.address)) return null;
  const address = u.payment_addr?.bech32 ?? u.address;
  const inline = !!u.inline_datum;

  let ownerPkh, datumCbor;
  // 1) Inline datum with decoded value
  const v = u.inline_datum?.value;
  const fromValue = v && v.constructor === 0 && v.fields?.length === 1 ? v.fields[0]?.bytes : undefined;
  if (fromValue) {
    if (!walletPkhs.has(fromValue)) return null;
    ownerPkh = fromValue;
    datumCbor = u.inline_datum.bytes || undefined;
  }
  // 2) Otherwise recompute the datum hash for each wallet key and both encodings
  if (!ownerPkh) {
    if (!u.datum_hash) return null;
    outer: for (const pkh of walletPkhs) {
      for (const enc of datumEncodings(pkh)) {
        if (datumToHash(enc) === u.datum_hash) { ownerPkh = pkh; datumCbor = enc; break outer; }
      }
    }
    if (!ownerPkh) return null;
  }
  if (!datumCbor) datumCbor = datumEncodings(ownerPkh)[0];

  const assets = { lovelace: BigInt(u.value) };
  for (const a of u.asset_list ?? []) {
    const unit = a.policy_id + (a.asset_name ?? "");
    assets[unit] = (assets[unit] ?? 0n) + BigInt(a.quantity);
  }
  return {
    ownerPkh, inline,
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

/**
 * Unlock several owned vault UTXOs in one tx; everything goes to `toAddress`.
 * @param items [{utxo, ownerPkh}] from matchOwnedVaultUtxo
 */
export async function buildUnlock(lucid, items, toAddress) {
  if (!items.length) throw new Error("Nothing selected.");
  if (items.length > MAX_INPUTS_PER_TX) throw new Error(`Max ${MAX_INPUTS_PER_TX} per transaction — select fewer and repeat.`);

  const utxos = items.map((i) => ({ ...i.utxo, assets: { ...i.utxo.assets } }));
  const signers = [...new Set(items.map((i) => i.ownerPkh))];
  const total = {};
  for (const u of utxos) for (const [k, q] of Object.entries(u.assets)) total[k] = (total[k] ?? 0n) + q;

  let tx = lucid.newTx().collectFrom(utxos, REDEEMER).attach.SpendingValidator(VAULT_SCRIPT);
  for (const s of signers) tx = tx.addSignerKey(s);
  return tx.pay.ToAddress(toAddress, total).complete({ evaluator });
}
