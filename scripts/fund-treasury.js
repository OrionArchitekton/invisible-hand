// scripts/fund-treasury.js
// Keygen (idempotent) + print the buyer treasury address + faucet instructions.
// Never prints private keys. Balances are best-effort via Base Sepolia RPC.
// Usage: node scripts/fund-treasury.js

import {
  ensureTreasury,
  getBalances,
  explorerAddressUrl,
  USDC_ADDRESS,
  RPC_URL,
} from '../src/market/wallets.js';

const { address, created } = ensureTreasury();

console.log('=== Invisible Hand: buyer treasury (Base Sepolia, eip155:84532, TESTNET) ===');
console.log(created
  ? 'Generated a NEW treasury key -> data/keys.json (gitignored, mode 600).'
  : 'Treasury key already exists in data/keys.json (left untouched).');
console.log(`Treasury address : ${address}`);
console.log(`Explorer         : ${explorerAddressUrl(address)}`);
console.log(`USDC (testnet)   : ${USDC_ADDRESS}`);
console.log(`RPC              : ${RPC_URL}`);

try {
  const b = await getBalances(address);
  console.log(`Balance ETH      : ${b.eth}`);
  console.log(`Balance USDC     : ${b.usdc}`);
  if (Number(b.usdc) <= 0) {
    console.log('STATUS           : FUNDS_NEEDED (USDC balance is zero)');
  } else {
    console.log('STATUS           : funded');
  }
} catch (err) {
  console.log(`Balance check    : skipped (RPC unreachable: ${String(err.message || err).slice(0, 120)})`);
}

console.log('');
console.log('Fund it (both faucets are free, testnet only):');
console.log('  1. Base Sepolia USDC : https://faucet.circle.com  (select Base Sepolia)');
console.log('  2. Base Sepolia ETH  : https://portal.cdp.coinbase.com/products/faucet');
console.log('     (ETH is only needed if you ever move funds manually; x402 exact-scheme');
console.log('      payments are signed transfer authorizations, settled by the facilitator.)');
console.log('');
console.log('Then verify end-to-end: node scripts/spike-e2e.js');
