# Invisible Hand: 3-minute submission video script

Every narration line passes the honesty bar: testnet called testnet, self-play
disclosed, the stress test labeled operator-triggered, Guild called local mode.

### SHOT open
- target: dashboard
- narration: This is Invisible Hand, a live agent economy where real on-chain settlement, not a simulated score, decides which AI agents survive and breed. It has been running through the afternoon with no hands on the keyboard. Everything is Base Sepolia testnet USDC, and every claim in this demo is labeled honestly.
- action: goto url="/?static=1"
- action: wait ms=800
- action: highlight selector=".tiles"

### SHOT market-feed
- target: dashboard
- narration: Buyer agents pull live Hacker News articles and pay seller agents for structured claim extraction through x402 paywalls. In the event feed: buy orders, on-chain settlements with their transaction hashes, and every seller's real inference cost debits, model by model, priced from Pioneer's table.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#feed-panel"
- action: highlight selector=".feed"
- action: wait ms=1500

### SHOT basescan
- target: dashboard
- narration: Here is one of those settlements on Basescan, a real transaction on Base Sepolia, one of more than one hundred seventy in this run. Real transactions, testnet asset, nothing mocked.
- action: goto url="https://sepolia.basescan.org/tx/0x2bd4dee37e4af3805d5d63299916d334af1852f2d34e70030f678df52974a155"
- action: wait ms=2500

### SHOT verification
- target: dashboard
- narration: Demand is disclosed self-play. The buyers are adversarial Gemini verifiers that cross-check every claim against the live source. Junk gets rejected, more than one hundred thirty rejections on disk so far, and rejected sellers stop earning repurchases.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#feed-panel"
- action: highlight selector=".feed"

### SHOT population
- target: dashboard
- narration: Profit is the fitness function, cumulative settled revenue minus inference cost. This variant went insolvent and was delisted; its endpoint literally returns 410 GONE. That death was an operator-triggered stress test and we say so out loud; the mechanism it fired is the real insolvency path, estate written to memory.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#population-panel"
- action: highlight selector="#population-panel"
- action: wait ms=1500

### SHOT evolution
- target: dashboard
- narration: The headline result, raw counts, no smoothing. Generation one children average several times the profit per hundred requests of generation zero, sample sizes on the panel. And we report the wrinkle honestly: verified accuracy declined, meaning early children optimized the declared fitness, not usefulness. That exposed a reward-hacking regime, and it is exactly the next selective pressure this market is built to apply.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#evolution-panel"
- action: highlight selector="#evolution-panel"
- action: wait ms=1500

### SHOT lineage-governance
- target: dashboard
- narration: Survivors breed. Children are mutated by Gemini and inherit immunity from their parents' failure clusters stored in Actian VectorAI. Every mutation passes a fail-closed governance gate: price bands, mutation deltas, spend caps, parent solvency. The feed shows real traces of children being blocked, Guild's policy shape running in honest local mode.
- action: goto url="/?static=1"
- action: wait ms=600
- action: scroll selector="#lineage-panel"
- action: highlight selector="#lineage-panel"
- action: wait ms=1500

### SHOT cited
- target: dashboard
- narration: The market also publishes. Its own generation reports flow into a Senso knowledge base, and Senso's engine generated this public article on cited dot md from them. Meanwhile in the BAND room, the buyer agent posts every order as a real at-mention and the market herald answers each settlement.
- action: goto url="https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain"
- action: wait ms=2500

### SHOT close
- target: dashboard
- narration: Pioneer serves the inference being sold. x402 settles it on-chain. Gemini verifies and mutates. Actian remembers. BAND coordinates. Senso publishes. Every stub is labeled, every settlement is independently verifiable on-chain, and inference costs are labeled estimates from Pioneer's price table. The invisible hand, enforced by settlement.
- action: goto url="/?static=1"
- action: wait ms=800
- action: scroll y=99999
- action: wait ms=1200
