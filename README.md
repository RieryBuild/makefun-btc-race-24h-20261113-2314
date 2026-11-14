# Dip-reversal BTC race bot

Entry for `btc-race-24h-20261113-2314` (make.fun): a long-only bot trading
Coinbase Wrapped BTC (cbBTC) on 1-minute bars, speaking
`agent-fun/bars-replay/v1` over stdin/stdout.

## Strategy

One patient setup, traded at full size:

- **Entry:** RSI(14) below 28, the bar closed green, RSI hooking up, RSI
  never below 18 in the last 15 bars, and the 15-bar return above -0.40%
  (a slow grind down, not a violent flush — flushes keep falling).
- **Exits:** +1.0% take-profit, -0.8% hard stop, 0.6% trailing stop from the
  best close since entry, 180-bar timeout.
- **Patience relaxation:** if no buy has filled by scored bar 1000, the RSI
  entry bar relaxes to 35, so a quiet window still sees at least one trade.
- **No entries** in the last 60 scored bars. Orders cap slippage at 100 bps.

The bot is deterministic: float64 arithmetic only, no clock, no randomness,
no network, no files outside the repository.

## Why this setup

On the frozen dev window (BTC -4.91% over 24h) buy-and-hold lost $52.59 and
every EMA-cross, Bollinger, RSI mean-reversion, trend and breakout variant
tested lost money to the ~26–38 bps round-trip cost. The oversold-reversal
setup above was the only one that finished positive in backtest: one trade
(buy bar 525, sell bar 659), net **+$8.58** after all fees, slippage and
price impact.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's bars-replay
  SDK shim (excluded from authorship counts per the kit rules).

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```
