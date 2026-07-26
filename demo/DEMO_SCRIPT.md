# Invisible Hand: 3-minute submission video script

> **HISTORICAL RECORD, PARTLY SUPERSEDED.** This is the narration as spoken in the
> published video (youtu.be/XA3-3MLTkAM), preserved verbatim so the script matches the
> audio. The 2026-07-25 errata in `docs/run-evidence.md` retracts the SHOT results
> narration: the generation-over-generation gain largely measures which hand-seeded price
> band survived and was computed on a fallback price for four of six model ids, the paired
> accuracy decline is confounded and unsized, and "reward hacking" overstates it. The
> video's audio cannot be edited after publication; the correction lives in the errata, the
> project page, and the video description. Do NOT reuse the retracted lines in new material.

Every narration line passes the honesty bar: testnet called testnet, self-play
disclosed, the stress test labeled operator-triggered, Guild called local mode.

### SHOT open
- target: dashboard
- narration: This is Invisible Hand: a live agent economy where real on-chain settlement decides which AI agents survive and breed. It has run all afternoon, no hands on the keyboard. Base Sepolia testnet USDC, and every claim in this demo is labeled honestly.
- action: goto url="/?static=1"
- action: wait ms=800
- action: highlight selector=".tiles"

### SHOT market-feed
- target: dashboard
- narration: Buyer agents pull live Hacker News articles and pay seller agents for claim extraction through x402 paywalls. The feed shows buy orders, on-chain settlements with transaction hashes, and per-model inference cost debits priced from Pioneer's table.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#feed-panel"
- action: highlight selector=".feed"
- action: wait ms=1500

### SHOT basescan
- target: dashboard
- narration: One of those settlements on a public block explorer: a real Base Sepolia transaction, one of more than two hundred in this run. Real transactions, testnet asset, nothing mocked.
- action: goto url="https://base-sepolia.blockscout.com/tx/0x2bd4dee37e4af3805d5d63299916d334af1852f2d34e70030f678df52974a155"
- action: wait ms=3500

### SHOT verification
- target: dashboard
- narration: Demand is disclosed self-play: adversarial Gemini verifiers cross-check every claim against the live source. Junk is rejected, over a hundred fifty rejections so far, and a verified failure sharply cuts a seller's future demand.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#feed-panel"
- action: highlight selector=".feed"

### SHOT population
- target: dashboard
- narration: Profit is fitness: cumulative settled revenue minus inference cost. This variant went insolvent and was delisted; its endpoint now literally returns 410 GONE. That death was an operator-triggered stress test, said out loud, and the path it fired is the real insolvency mechanism.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#population-panel"
- action: highlight selector="#population-panel"
- action: wait ms=1500

### SHOT evolution
- target: dashboard
- narration: The headline, raw counts: generation one children earn several times generation zero's profit per hundred requests, sample sizes on screen. Verified accuracy declined, though: early children optimized the declared fitness, not usefulness. Surfacing that reward hacking is the point, and it becomes the next selective pressure.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#evolution-panel"
- action: highlight selector="#evolution-panel"
- action: wait ms=1500

### SHOT lineage-governance
- target: dashboard
- narration: Survivors breed. Gemini mutates the children, which inherit immunity from their parents' failure clusters stored in Actian VectorAI. Every mutation passes a fail-closed policy gate; here a child is blocked on the spend cap. Guild's policy shape, honest local mode.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#lineage-panel"
- action: highlight selector="#lineage-panel"
- action: wait ms=1500

### SHOT cited
- target: dashboard
- narration: The market publishes its own generation reports into a Senso knowledge base, and Senso's engine generated this public cited dot md article from them. In the BAND room, buyer and herald agents exchange real at-mention orders and settlements.
- action: goto url="https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain"
- action: wait ms=2500

### SHOT close
- target: dashboard
- narration: Pioneer serves the inference being sold. x402 settles on-chain. Gemini verifies and mutates. Actian remembers. BAND coordinates. Senso publishes. Every stub is labeled, every settlement independently verifiable on-chain, costs are labeled estimates. The invisible hand, enforced by settlement.
- action: goto url="/?static=1"
- action: wait ms=800
- action: scroll selector="#receipts-panel"
- action: highlight selector="#receipts-panel"
- action: wait ms=1200
