// src/market/registry.js
// Market core: variant registry + per-variant paid route /v/:id/extract.
// Each variant gets its own x402-express paymentMiddleware instance priced from
// genome.price_usd, payTo = that variant's wallet address, on Base Sepolia
// (eip155:84532, the middleware's "base-sepolia" network name) via the
// facilitator at https://x402.org/facilitator.
// delist(id, reason) swaps the route to 410 GONE with a JSON body naming the
// insolvency. Settled sales are credited to the ledger WITH tx_hash by watching
// the X-PAYMENT-RESPONSE header on response finish.

import express from 'express';
import { paymentMiddleware } from 'x402-express';
import * as ledger from './ledger.js';
import { makeExtractHandler } from './seller.js';

// Payment constants (ARCHITECTURE.md). "base-sepolia" is x402's name for eip155:84532.
export const NETWORK = 'base-sepolia';
export const CAIP2_NETWORK = 'eip155:84532';
export const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
export const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export const PRICE_MIN_USD = 0.001;
export const PRICE_MAX_USD = 0.02;

function normalizeVariant(variant) {
  if (!variant) throw new Error('register: variant required');
  const genome = variant.genome || variant;
  const walletField = typeof variant.wallet === 'string'
    ? variant.wallet
    : (variant.wallet && variant.wallet.address) || null;
  const address = variant.address || walletField || genome.address;
  if (!genome.id) throw new Error('register: variant genome.id required');
  if (!address) throw new Error(`register: variant ${genome.id} needs a wallet address (payTo)`);
  const price = Number(genome.price_usd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`register: variant ${genome.id} price_usd invalid: ${genome.price_usd}`);
  }
  return { genome, address, price: Math.round(price * 1e6) / 1e6 };
}

// createRegistry() -> { app, register, delist, list, get, listen, close }
// options.creditSales (default true): credit ledger on settled x402 sales.
export function createRegistry(options = {}) {
  const creditSales = options.creditSales !== false;
  const variants = new Map(); // id -> { genome, address, price, status, mw, handler, ... }

  const app = options.app || express();
  app.use(express.json({ limit: '1mb' }));

  function register(variant, opts = {}) {
    const { genome, address, price } = normalizeVariant(variant);
    const id = genome.id;
    const routePath = `/v/${id}/extract`;
    const mw = paymentMiddleware(
      address,
      {
        [routePath]: {
          price,
          network: NETWORK,
          config: {
            description: `Structured claim extraction by seller variant ${id} (gen ${genome.gen ?? 0}, model ${genome.model || 'pioneer/auto'}). Testnet USDC on Base Sepolia.`,
            mimeType: 'application/json',
            maxTimeoutSeconds: 60,
            outputSchema: {
              type: 'object',
              properties: {
                claims: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      source_url: { type: 'string' },
                      confidence: { type: 'number' },
                    },
                  },
                },
                model: { type: 'string' },
                cost_est_usd: { type: 'number' },
              },
            },
          },
        },
      },
      { url: FACILITATOR_URL },
    );
    const record = {
      id,
      genome,
      address,
      price_usd: price,
      status: 'active',
      listed_at: new Date().toISOString(),
      delisted_at: null,
      delist_reason: null,
      route: routePath,
      mw,
      handler: opts.handler || makeExtractHandler({ genome, address }),
    };
    variants.set(id, record);
    return publicView(record);
  }

  // Insolvency exit: the endpoint literally 410s from now on.
  function delist(id, reason) {
    const rec = variants.get(id);
    if (!rec) throw new Error(`delist: unknown variant ${id}`);
    rec.status = 'delisted';
    rec.delist_reason = reason || 'insolvent';
    rec.delisted_at = new Date().toISOString();
    return publicView(rec);
  }

  function get(id) {
    const rec = variants.get(id);
    return rec ? publicView(rec) : null;
  }

  function list() {
    return [...variants.values()].map(publicView);
  }

  function publicView(rec) {
    return {
      id: rec.id,
      address: rec.address,
      price_usd: rec.price_usd,
      model: rec.genome.model || null,
      gen: rec.genome.gen ?? 0,
      niche: rec.genome.niche || null,
      status: rec.status,
      route: rec.route,
      listed_at: rec.listed_at,
      delisted_at: rec.delisted_at,
      delist_reason: rec.delist_reason,
      explorer: `https://sepolia.basescan.org/address/${rec.address}`,
    };
  }

  // On settled payment the middleware sets X-PAYMENT-RESPONSE (base64 JSON incl.
  // transaction hash). Credit the sale when the response finishes successfully.
  function watchSettlement(rec, res) {
    if (!creditSales) return;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const header = res.getHeader('X-PAYMENT-RESPONSE');
      if (!header) return;
      let tx = null;
      try {
        const decoded = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'));
        if (decoded && decoded.success) tx = decoded.transaction || null;
        else return; // unsettled: do not credit
      } catch {
        return; // unreadable settlement header: do not credit
      }
      try {
        ledger.credit(rec.id, rec.price_usd, 'sale', tx);
      } catch (e) {
        console.error(`[registry] sale credit failed for ${rec.id}: ${e.message}`);
      }
    });
  }

  app.all('/v/:id/extract', (req, res) => {
    const rec = variants.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'unknown variant', id: req.params.id });
      return;
    }
    if (rec.status === 'delisted') {
      res.status(410).json({
        error: 'gone',
        id: rec.id,
        reason: rec.delist_reason,
        delisted_at: rec.delisted_at,
        message: `Seller variant ${rec.id} was delisted: ${rec.delist_reason}. The market selected against it.`,
      });
      return;
    }
    watchSettlement(rec, res);
    // The variant's own paywall runs first; on paid (or exempt) it calls the handler.
    Promise.resolve(rec.mw(req, res, () => {
      Promise.resolve(rec.handler(req, res)).catch((err) => {
        console.error(`[registry] handler error for ${rec.id}: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal handler error' });
      });
    })).catch((err) => {
      console.error(`[registry] paywall error for ${rec.id}: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'paywall error' });
    });
  });

  // Free market metadata (discovery surface for buyers + dashboard).
  app.get('/market', (_req, res) => {
    res.json({
      network: CAIP2_NETWORK,
      facilitator: FACILITATOR_URL,
      usdc: USDC_ADDRESS,
      testnet: true,
      variants: list(),
    });
  });

  let server = null;
  function listen(port, cb) {
    server = app.listen(port, cb);
    return server;
  }

  function close() {
    if (server) server.close();
  }

  return { app, register, delist, list, get, listen, close };
}

// Inline self-test: register/delist/list semantics, no server, no network.
if (process.env.SELF_TEST) {
  const reg = createRegistry({ creditSales: false });
  const fakeAddr = '0x000000000000000000000000000000000000dEaD';
  const v = reg.register({
    genome: { id: 'st-1', gen: 0, price_usd: 0.001, model: 'Pioneer/Auto', niche: 'general' },
    address: fakeAddr,
  });
  const listed = reg.list();
  const d = reg.delist('st-1', 'bankroll exhausted (self-test)');
  const ok = v.status === 'active' && listed.length === 1 && d.status === 'delisted'
    && d.delist_reason.includes('bankroll') && reg.get('st-1').status === 'delisted';
  console.log(`[registry self-test] ok=${ok} route=${v.route} network=${NETWORK} facilitator=${FACILITATOR_URL}`);
  if (!ok) process.exit(1);
}
