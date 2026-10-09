// End-to-end test against Lucid's emulator, runnable in Node and in the browser.
// Locks five UTXOs at the real vault script in every datum shape seen on-chain
// (plus one belonging to someone else), discovers them through Koios-shaped data
// exactly as the page does, and unlocks them in one transaction.
import {
  Lucid, Emulator, generateEmulatorAccount, getAddressDetails,
  scriptFromNative, mintingPolicyToId, fromText, toUnit, Data, datumToHash, validatorToScriptHash,
} from "@lucid-evolution/lucid";
import {
  VAULT_SCRIPT, REDEEMER, SCRIPT_HASH, datumEncodings, vaultAddressFor,
  matchOwnedVaultUtxo, buildUnlock, evaluator,
} from "./vault.js";

// Convert a Lucid UTxO to the shape Koios returns, including its quirks.
function koiosShape(u, { inline, nullBytes = false, datumCbor, pkh }) {
  const asset_list = Object.entries(u.assets).filter(([k]) => k !== "lovelace")
    .map(([k, q]) => ({ policy_id: k.slice(0, 56), asset_name: k.slice(56), quantity: q.toString() }));
  return {
    tx_hash: u.txHash, tx_index: u.outputIndex, address: u.address, value: u.assets.lovelace.toString(),
    datum_hash: datumToHash(datumCbor), asset_list,
    inline_datum: inline ? { bytes: nullBytes ? null : datumCbor, value: { constructor: 0, fields: [{ bytes: pkh }] } } : null,
  };
}

export async function selfTest(log = console.log) {
  const me = generateEmulatorAccount({ lovelace: 200_000_000n });
  const other = generateEmulatorAccount({ lovelace: 50_000_000n });
  const emulator = new Emulator([me, other]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(me.seedPhrase);
  const myAddr = await lucid.wallet().address();
  const { paymentCredential, stakeCredential } = getAddressDetails(myAddr);
  const myPkh = paymentCredential.hash;
  const otherPkh = getAddressDetails(other.address).paymentCredential.hash;

  // Sanity: real-world constants
  const sh = validatorToScriptHash(VAULT_SCRIPT);
  if (sh !== SCRIPT_HASH) throw new Error("script hash mismatch");
  if (datumToHash(datumEncodings("752abcdf09df9d714471589e235204555e79edaffba203eadd133a30")[0])
      !== "70f723c9bad61940f6adc0757bc9a3d692f722c8664fbb9daf9cbf5e17806eee") throw new Error("datum hash mismatch");
  log("script hash and known datum hash match mainnet ✓");

  // Mint 5 test NFTs
  const policy = scriptFromNative({ type: "sig", keyHash: myPkh });
  const pid = mintingPolicyToId(policy);
  const units = [1, 2, 3, 4, 5].map((i) => toUnit(pid, fromText(`TestNFT${i}`)));
  let tx = await lucid.newTx().mintAssets(Object.fromEntries(units.map((u) => [u, 1n]))).attach.MintingPolicy(policy).complete();
  await emulator.awaitTx(await (await tx.sign.withWallet().complete()).submit());

  // Lock them in every shape. Vault address uses MY stake key, as deposits did.
  const vaultAddr = vaultAddressFor(stakeCredential.hash, 0);
  const cases = [
    { unit: units[0], owner: myPkh, inline: false, enc: 0, label: "datum by hash (indefinite)" },
    { unit: units[1], owner: myPkh, inline: false, enc: 1, label: "datum by hash (definite)" },
    { unit: units[2], owner: myPkh, inline: true, enc: 0, label: "inline datum" },
    { unit: units[3], owner: myPkh, inline: true, enc: 0, nullBytes: true, label: "inline, Koios bytes:null" },
    { unit: units[4], owner: otherPkh, inline: true, enc: 0, label: "someone else's" },
  ];
  for (const c of cases) {
    c.datumCbor = datumEncodings(c.owner)[c.enc];
    const datum = c.inline ? { kind: "inline", value: c.datumCbor } : { kind: "hash", value: datumToHash(c.datumCbor) };
    tx = await lucid.newTx().pay.ToContract(vaultAddr, datum, { lovelace: 1_500_000n, [c.unit]: 1n }).complete();
    await emulator.awaitTx(await (await tx.sign.withWallet().complete()).submit());
  }
  const atVault = await lucid.utxosAt(vaultAddr);
  log(`locked ${atVault.length} UTXOs at the vault script ✓`);

  // Discovery exactly as the page does it, from Koios-shaped data
  const koios = atVault.map((u) => {
    const c = cases.find((x) => u.assets[x.unit]);
    return koiosShape(u, { inline: c.inline, nullBytes: c.nullBytes, datumCbor: c.datumCbor, pkh: c.owner });
  });
  const owned = koios.map((k) => matchOwnedVaultUtxo(k, new Set([myPkh]))).filter(Boolean);
  if (owned.length !== 4) throw new Error(`expected 4 owned, found ${owned.length}`);
  log("found my 4 UTXOs, ignored the other owner's ✓");

  // Negative checks with the validator itself
  const one = owned[0];
  const mustFail = async (label, fn) => {
    try { await fn(); } catch { log(`${label}: rejected by validator ✓`); return; }
    throw new Error(`${label} was accepted`);
  };
  await mustFail("wrong redeemer", () => lucid.newTx().collectFrom([{ ...one.utxo }], Data.void())
    .attach.SpendingValidator(VAULT_SCRIPT).addSignerKey(myPkh).complete({ evaluator }));
  await mustFail("missing owner signature", () => lucid.newTx().collectFrom([{ ...one.utxo }], REDEEMER)
    .attach.SpendingValidator(VAULT_SCRIPT).complete({ evaluator }));
  const theirs = matchOwnedVaultUtxo(koios.find((k) => k.asset_list.some((a) => a.policy_id + a.asset_name === units[4])), new Set([otherPkh]));
  await mustFail("someone else's UTXO signed by me", () => buildUnlock(lucid, [{ ...theirs, ownerPkh: myPkh }], myAddr));

  // The real thing: all four in one tx
  const sb = await buildUnlock(lucid, owned, myAddr);
  const witnessDatums = sb.toTransaction().witness_set().plutus_datums()?.len() ?? 0;
  if (witnessDatums !== 2) throw new Error(`expected 2 witness datums (hash inputs only), got ${witnessDatums}`);
  log("witness datums only for by-hash inputs ✓");
  await emulator.awaitTx(await (await sb.sign.withWallet().complete()).submit());

  const left = await lucid.utxosAt(vaultAddr);
  const mine = await lucid.utxosAt(myAddr);
  const back = units.slice(0, 4).every((u) => mine.some((m) => m.assets[u]));
  if (!back || left.length !== 1 || !left[0].assets[units[4]]) throw new Error("unexpected end state");
  log(`unlocked 4 in one tx (fee ${Number(sb.toTransaction().body().fee()) / 1e6} ADA); other owner's still locked ✓`);
}
