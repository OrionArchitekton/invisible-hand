// scripts/spike-e2e.js
// PROOF spike: 1 seller behind an x402 paywall + 1 buyer purchase via x402-fetch,
// treasury-funded, on Base Sepolia (eip155:84532, TESTNET USDC) through the
// facilitator https://x402.org/facilitator.
// Prints the 402 challenge; on settlement prints the tx hash + basescan link.
// Exit 0 when the 402 challenge round-trip works even if funds are absent
// (prints FUNDS_NEEDED). Exit 1 only when the paywall itself misbehaves.
// Usage: node scripts/spike-e2e.js   (SPIKE_PORT to override :3312)

import { wrapFetchWithPayment, decodeXPaymentResponse } from 'x402-fetch';
import { createRegistry, FACILITATOR_URL, CAIP2_NETWORK } from '../src/market/registry.js';
import {
  ensureTreasury,
  getTreasuryAccount,
  makeWalletClient,
  createVariantWallet,
  getBalances,
  explorerTxUrl,
  explorerAddressUrl,
} from '../src/market/wallets.js';
import * as ledger from '../src/market/ledger.js';

const PORT = Number(process.env.SPIKE_PORT || 3312);
const VARIANT_ID = 'spike-1';
const PRICE_USD = 0.001;

const SAMPLE_TEXT = 'Base Sepolia is the public testnet for the Base L2. The x402 protocol '
  + 'turns HTTP 402 into a payment challenge that agents settle with signed USDC transfer '
  + 'authorizations. A facilitator verifies and settles the payment on-chain, then the '
  + 'origin server releases the paid response.';

function line(s = '') {
  console.log(s);
}

async function main() {
  line('=== Invisible Hand spike: 1 seller + 1 paid buy (TESTNET USDC, Base Sepolia) ===');
  line(`network=${CAIP2_NETWORK} facilitator=${FACILITATOR_URL}`);

  // Seller side: registry + one variant behind its own paywall.
  const { address: treasuryAddress } = ensureTreasury();
  const wallet = createVariantWallet(VARIANT_ID);
  const registry = createRegistry();
  registry.register({
    genome: { id: VARIANT_ID, parent_ids: [], gen: 0, price_usd: PRICE_USD, model: 'Pioneer/Auto', prompt_variant: 'baseline', niche: 'general' },
    address: wallet.address,
  });
  await new Promise((resolve) => registry.listen(PORT, resolve));
  const url = `http://localhost:${PORT}/v/${VARIANT_ID}/extract`;
  line(`seller listening: ${url}`);
  line(`seller payTo    : ${wallet.address} (${explorerAddressUrl(wallet.address)})`);
  line(`buyer treasury  : ${treasuryAddress}`);

  let exitCode = 1;
  try {
    // Step 1: unpaid request MUST 402 with a payment challenge.
    const bare = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: SAMPLE_TEXT }),
    });
    if (bare.status !== 402) {
      line(`FAIL: expected 402 challenge, got HTTP ${bare.status}`);
      return 1;
    }
    const challenge = await bare.json();
    line('');
    line('--- 402 CHALLENGE (verbatim) ---');
    line(JSON.stringify(challenge, null, 2));
    const req0 = challenge.accepts && challenge.accepts[0];
    if (!req0 || req0.payTo.toLowerCase() !== wallet.address.toLowerCase()) {
      line('FAIL: challenge accepts[] missing or payTo is not the variant wallet');
      return 1;
    }
    line(`challenge ok: scheme=${req0.scheme} network=${req0.network} maxAmountRequired=${req0.maxAmountRequired} (USDC base units) payTo=${req0.payTo}`);
    exitCode = 0; // challenge round-trip proven; funding issues no longer fail the spike

    // Step 2: paid purchase with the treasury account via x402-fetch.
    let usdc = 'unknown';
    try {
      usdc = (await getBalances(treasuryAddress)).usdc;
    } catch { /* RPC optional */ }
    line('');
    line(`treasury USDC balance: ${usdc}`);
    const account = getTreasuryAccount();
    const fetchWithPay = wrapFetchWithPayment(fetch, makeWalletClient(account));
    let paid;
    try {
      paid = await fetchWithPay(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: SAMPLE_TEXT }),
      });
    } catch (err) {
      line(`payment attempt threw: ${String(err.message || err).slice(0, 200)}`);
      line(`FUNDS_NEEDED: fund ${treasuryAddress} with Base Sepolia USDC (https://faucet.circle.com) and re-run.`);
      return 0;
    }

    if (paid.status === 200) {
      const body = await paid.json();
      const settleHeader = paid.headers.get('x-payment-response');
      line('');
      line('--- PAID RESPONSE ---');
      line(JSON.stringify(body, null, 2));
      if (settleHeader) {
        const settled = decodeXPaymentResponse(settleHeader);
        line('');
        line('--- SETTLEMENT ---');
        line(`success   : ${settled.success}`);
        line(`tx hash   : ${settled.transaction}`);
        line(`explorer  : ${explorerTxUrl(settled.transaction)}`);
        line(`payer     : ${settled.payer}`);
        const p = ledger.pnl(VARIANT_ID);
        line(`ledger pnl: ${JSON.stringify(p)}`);
        line('');
        line('SPIKE PASS: full x402 purchase settled on Base Sepolia (testnet).');
      } else {
        line('WARNING: 200 without X-PAYMENT-RESPONSE header; settlement not proven.');
      }
      return 0;
    }

    // Second 402: challenge worked, settlement refused (typically unfunded treasury).
    const errBody = await paid.json().catch(() => ({}));
    line('');
    line(`payment not settled: HTTP ${paid.status} error=${errBody.error || 'unknown'}`);
    line(`FUNDS_NEEDED: fund ${treasuryAddress} with Base Sepolia USDC (https://faucet.circle.com), then re-run.`);
    line('(402 challenge round-trip verified; exiting 0 per spike contract.)');
    return 0;
  } finally {
    registry.close();
    // viem transports may hold sockets; make exit deterministic for CI-style use.
    setTimeout(() => process.exit(exitCode), 250).unref();
  }
}

main().then(
  (code) => process.exitCode = code,
  (err) => {
    console.error(`SPIKE ERROR: ${err.stack || err}`);
    process.exitCode = 1;
  },
);
