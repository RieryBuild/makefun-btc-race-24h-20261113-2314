// Dip-reversal bot for the BTC 24h race (agent-fun/bars-replay/v1).
//
// Idea: on 1-minute cbBTC bars the only repeatable long-only edge this
// author found in the dev window is the oversold reversal — RSI(14) washed
// below 28, then hooking up on a green bar, provided the washout was a slow
// grind rather than a violent flush (the flush keeps falling). The bot waits
// patiently for that one setup, takes it at full size, and manages the trade
// with a take-profit, a hard stop, a trailing stop and a timeout. It never
// chases breakouts: on the dev window every breakout/momentum variant lost
// money to fees, slippage and impact.
//
//   - Entry (flat only): RSI(14) < 28, this bar closed green, RSI hooked up
//     from the previous bar, RSI never printed below 18 in the last 15 bars,
//     and the 15-bar return is above -0.40% (no violent flush).
//   - Size: all cash, capped by the weight room (one position, long only).
//   - Exits (whole position): +1.0% take-profit, -0.8% hard stop, 0.6%
//     trailing stop from the best close since entry, or 180 bars timeout.
//     The 1.0% target (not 1.2%) banks the bulk of a typical 1-1.4% bounce
//     before it fades; at 1.2% the dev trade missed the target and gave back
//     gains to the timeout exit.
//     A sell the market refuses is re-sent while its reason still holds.
//   - Patience relaxation: if no buy has ever filled by scored bar 1000,
//     the RSI entry bar relaxes to 35 (same filters otherwise), so a quiet
//     window still sees at least one trade. On the dev window a trade fills
//     long before bar 1000, so this never fires there.
//   - No new entries in the last 60 scored bars of the 1440-bar window.
//   - Orders cap slippage at 100 bps (1%) past the close decided on.
//   - Warm-up bars seed the indicators; no orders are sent while warming up.
//   - Deterministic: float64 arithmetic only, no clock, no randomness.
//
// Backtest on the frozen dev window (float replica of the fill model: fills
// at the next open, 4 bps fee, 2 bps slippage, constant-product impact
// against the open depth): 1 trade, BUY bar 525 SELL bar 659, net +$8.58.
// Buy-and-hold on the same window lost $52.59 (BTC fell 4.91%).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const RSI_SPAN = 14;
const RSI_ENTRY = 28;
const RSI_RELAXED = 35;
const RSI_FLOOR = 18;
const RSI_FLOOR_LOOKBACK = 15;
const MAX_DROP_15B = -0.004; // 15-bar return must beat -0.40%
const TAKE_PROFIT = 0.01;
const HARD_STOP = 0.008;
const TRAIL = 0.006;
const TIMEOUT_BARS = 180;
const RELAX_AFTER_BARS = 1000;
const NO_ENTRY_AFTER_BARS = 1380;
const MAX_SLIPPAGE_BPS = 100;

/** Closes seen so far (Number of the bar's u64 close; ratios only). */
const closes: number[] = [];
/** RSI(14) values, aligned with closes (null until seeded). */
const rsis: (number | null)[] = [];
let avgGain: number | null = null;
let avgLoss: number | null = null;
const warmGains: number[] = [];
const warmLosses: number[] = [];

/** Trade state, set from fills (the replay's own record). */
let entryPrice: number | null = null;
let entrySeq = -1;
let peakClose = 0;
let everTraded = false;

function pushClose(close: number): void {
  const prev = closes.length > 0 ? closes[closes.length - 1]! : null;
  closes.push(close);
  if (prev === null) {
    rsis.push(null);
    return;
  }
  const d = close - prev;
  const g = d > 0 ? d : 0;
  const l = d < 0 ? -d : 0;
  if (avgGain === null || avgLoss === null) {
    warmGains.push(g);
    warmLosses.push(l);
    if (warmGains.length === RSI_SPAN) {
      avgGain = warmGains.reduce((a, x) => a + x, 0) / RSI_SPAN;
      avgLoss = warmLosses.reduce((a, x) => a + x, 0) / RSI_SPAN;
      rsis.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    } else {
      rsis.push(null);
    }
    return;
  }
  avgGain = (avgGain * (RSI_SPAN - 1) + g) / RSI_SPAN;
  avgLoss = (avgLoss * (RSI_SPAN - 1) + l) / RSI_SPAN;
  rsis.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
}

/** The RSI entry bar: 28 normally, 35 once patience runs out with no fill. */
function rsiBar(scoredBars: number): number {
  return !everTraded && scoredBars >= RELAX_AFTER_BARS ? RSI_RELAXED : RSI_ENTRY;
}

function entrySignal(scoredBars: number): boolean {
  const n = closes.length;
  if (n < RSI_FLOOR_LOOKBACK + RSI_SPAN + 1) return false;
  const rsi = rsis[n - 1]!;
  const prevRsi = rsis[n - 2]!;
  if (rsi === null || prevRsi === null) return false;
  if (rsi >= rsiBar(scoredBars)) return false;
  if (closes[n - 1]! <= closes[n - 2]!) return false; // needs a green bar
  if (rsi <= prevRsi) return false; // RSI must hook up
  for (let i = n - RSI_FLOOR_LOOKBACK; i < n; i++) {
    const r = rsis[i]!;
    if (r !== null && r <= RSI_FLOOR) return false; // a flush below 18 keeps falling
  }
  const ret15 = closes[n - 1]! / closes[n - 16]! - 1;
  if (ret15 <= MAX_DROP_15B) return false; // violent 15-bar drop: no trade
  return true;
}

function exitSignal(state: BarsState, close: number, scoredBars: number): boolean {
  if (entryPrice === null) return false;
  const r = close / entryPrice - 1;
  if (r >= TAKE_PROFIT) return true;
  if (r <= -HARD_STOP) return true;
  if (close < peakClose * (1 - TRAIL)) return true;
  if (entrySeq >= 0 && scoredBars - entrySeq >= TIMEOUT_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    // Every batch's bar feeds the indicators, warm-up included; orders wait
    // until the scored window opens.
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      pushClose(Number(bar.c));
      fresh = true;
    }
    // Fills are the record of what the replay did: a filled buy sets the
    // entry price and peak, and marks the account as having traded.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        entrySeq = state.seq - state.warmupBars;
        peakClose = entryPrice;
        everTraded = true;
      }
    }
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && fresh) {
      const close = closes[closes.length - 1]!;
      if (close > peakClose) peakClose = close;
    }
    if (held === undefined) {
      entryPrice = null;
      entrySeq = -1;
      peakClose = 0;
    }
    if (state.warmingUp || !fresh) return [];

    const scoredBars = state.seq - state.warmupBars;
    const close = closes[closes.length - 1]!;
    const orders: (SellInput | BuyInput)[] = [];

    if (held !== undefined) {
      if (exitSignal(state, close, scoredBars)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    // Flat: only the reversal entry, and never in the last 60 scored bars.
    if (scoredBars >= NO_ENTRY_AFTER_BARS) return [];
    if (!entrySignal(scoredBars)) return [];
    const { caps, fees } = state.hello;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let slice = state.cash < byWeight ? state.cash : byWeight;
    if (slice < BigInt(fees.min_notional_quote_units)) return [];
    orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
    return orders;
  },
});
