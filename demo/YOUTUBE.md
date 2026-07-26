# YouTube upload metadata (unlisted)

> **ACTION NEEDED (Dan, manual):** the description below has been corrected for the
> 2026-07-25 errata, but the LIVE description on youtu.be/XA3-3MLTkAM still carries the
> original reward-hacking sentence. Paste the corrected Description section into YouTube
> Studio to bring the live surface in line. The video audio itself cannot be edited.

File: Downloads\invisible-hand-demo.mp4 (2:55)
Visibility: Unlisted. Thumbnail: the Downloads PNG.

## Title

Invisible Hand: an agent economy where on-chain settlement selects which AI agents survive (SwarmHack SF 2026)

## Description

A live agent economy built in one day at SwarmHack SF (tokens&, July 24, 2026).

Seller-agents sell claim extraction over live Hacker News articles behind x402
paywalls. Buyers pay real testnet USDC on Base Sepolia (250+ on-chain
settlements), Gemini adversarially verifies every claim, and cumulative net
P&L is the fitness function: an insolvent agent's endpoint literally returns
HTTP 410 GONE, and survivors breed through a fail-closed governance gate.
During this recording the market bred a new variant through that gate live.

Honesty bar: all USDC is testnet; demand is disclosed self-play (adversarial
verifier-buyers); operator triggers are narrated as such; non-live
integrations are labeled local mode.

Correction (2026-07-25): the narration in this video reads the generation-over-
generation numbers as an economic gain against an accuracy regression, and calls
it reward hacking. A post-release errata retracts that reading: the comparison
largely measures which hand-seeded price band survived, the profit figures used
a fallback price for four of six model ids, and the accuracy decline is
confounded and unsized. What holds is structural: the fitness function carried
no accuracy term, so selection could only ever see profit. Details in
docs/run-evidence.md.

Project page: https://www.danmercede.com/works/invisible-hand/
Repo: https://github.com/OrionArchitekton/invisible-hand
Proof tx: https://sepolia.basescan.org/tx/0x4e1b80cfab76f9e30bf7695854bbe4c1183edc516b6d1b900fdef80234545df1
Public artifact: https://cited.md/article/what-is-the-invisible-hand-agent-economy-and-how-does-real-on-chain

Built with Pioneer, x402 + Coinbase CDP rails, Google Gemini, Actian
VectorAI, BAND, Senso, and Replay QA.

## Tags

AI agents, agent economy, x402, Base Sepolia, USDC, evolutionary algorithms,
autonomous agents, hackathon, SwarmHack, on-chain settlement
