// src/market/wallets.js
// viem local accounts: buyer treasury + one wallet per seller variant.
// Private keys live ONLY in data/keys.json (gitignored, mode 600).
// Public addresses are mirrored to data/wallets.json for the dashboard.
// Never log or export private keys beyond the account objects viem needs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const KEYS_PATH = path.join(DATA_DIR, 'keys.json');
const WALLETS_PATH = path.join(DATA_DIR, 'wallets.json');

// Payment constants (ARCHITECTURE.md): Base Sepolia = eip155:84532.
export const CHAIN = baseSepolia;
export const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonPrivate(p, obj) {
  ensureDataDir();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best effort on non-posix
  }
}

function writeJsonPublic(p, obj) {
  ensureDataDir();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function loadKeys() {
  return readJson(KEYS_PATH, {});
}

function syncWalletsJson(keys) {
  const pub = { treasury: keys.treasury ? keys.treasury.address : null, variants: {} };
  for (const [id, rec] of Object.entries(keys.variants || {})) {
    pub.variants[id] = rec.address;
  }
  writeJsonPublic(WALLETS_PATH, pub);
  return pub;
}

// Create the treasury key if it does not exist yet. Returns { address, created }.
export function ensureTreasury() {
  const keys = loadKeys();
  if (keys.treasury && keys.treasury.privateKey) {
    return { address: keys.treasury.address, created: false };
  }
  const pk = process.env.TREASURY_PRIVATE_KEY || generatePrivateKey();
  const account = privateKeyToAccount(pk);
  keys.treasury = { privateKey: pk, address: account.address };
  writeJsonPrivate(KEYS_PATH, keys);
  syncWalletsJson(keys);
  return { address: account.address, created: true };
}

// viem local account for the buyer treasury. Throws with guidance if absent.
export function getTreasuryAccount() {
  const keys = loadKeys();
  const pk = (keys.treasury && keys.treasury.privateKey) || process.env.TREASURY_PRIVATE_KEY;
  if (!pk) {
    throw new Error('No treasury key: run `node scripts/fund-treasury.js` first (writes data/keys.json)');
  }
  return privateKeyToAccount(pk);
}

export function getTreasuryAddress() {
  const keys = loadKeys();
  if (keys.treasury && keys.treasury.address) return keys.treasury.address;
  return getTreasuryAccount().address;
}

// Create (or return, idempotent) a wallet for a seller variant.
// Appends the key to data/keys.json and the address to data/wallets.json.
export function createVariantWallet(id) {
  if (!id || typeof id !== 'string') throw new Error('createVariantWallet: id (string) required');
  const keys = loadKeys();
  keys.variants = keys.variants || {};
  if (keys.variants[id] && keys.variants[id].privateKey) {
    return { id, address: keys.variants[id].address, created: false };
  }
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  keys.variants[id] = { privateKey: pk, address: account.address, created_at: new Date().toISOString() };
  writeJsonPrivate(KEYS_PATH, keys);
  syncWalletsJson(keys);
  return { id, address: account.address, created: true };
}

export function getVariantAccount(id) {
  const keys = loadKeys();
  const rec = keys.variants && keys.variants[id];
  if (!rec) throw new Error(`No wallet for variant ${id}: call createVariantWallet('${id}') first`);
  return privateKeyToAccount(rec.privateKey);
}

export function getVariantAddress(id) {
  const keys = loadKeys();
  const rec = keys.variants && keys.variants[id];
  if (!rec) throw new Error(`No wallet for variant ${id}`);
  return rec.address;
}

export function listWallets() {
  return syncWalletsJson(loadKeys());
}

export function makePublicClient() {
  return createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
}

// Wallet client shaped for x402-fetch wrapFetchWithPayment (chain id drives network pick).
export function makeWalletClient(account) {
  return createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
}

// { eth: string, usdc: string, usdcUnits: bigint } for an address, via Base Sepolia RPC.
export async function getBalances(address) {
  const client = makePublicClient();
  const [wei, usdcUnits] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ]);
  return {
    eth: formatUnits(wei, 18),
    usdc: formatUnits(usdcUnits, 6),
    usdcUnits,
  };
}

export function explorerAddressUrl(address) {
  return `https://sepolia.basescan.org/address/${address}`;
}

export function explorerTxUrl(hash) {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

// Inline self-test: pure key derivation only, no file writes, no network.
if (process.env.SELF_TEST) {
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  const ok = /^0x[0-9a-fA-F]{40}$/.test(acct.address);
  console.log(`[wallets self-test] derived address shape ok=${ok} chain=${CHAIN.id} usdc=${USDC_ADDRESS}`);
  if (!ok) process.exit(1);
}
