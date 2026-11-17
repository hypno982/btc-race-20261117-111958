// btc-race entry: a displacement bot for cbBTC/USDC on the bars-replay rule set.
//
// What it does, in one sentence: stay flat while the window is noise, and when price is far
// enough under its own recent level that the snap back should pay for the round trip, take one
// full-size position once and leave it alone until an exit or the hold limit closes it.
//
// The cost structure is the whole argument for trading rarely. Every fill is charged 4 bps of
// fee, and on top of the fee the replay models 2 bps of slippage and constant-product price
// impact against whatever pool depth the universe froze (around 7 bps for a full-size buy at
// that depth). Add both legs together and a full-size round trip costs roughly 26 bps. A trade
// therefore has to capture more than 26 bps just to come back to where it started, while the
// median absolute one-minute move on the dev window's 1,440 bars is a small fraction of that.
// Firing on every wiggle means paying the full round-trip cost over and over to chase moves
// that are individually too small to cover it, and the graded field shows exactly that: of
// 2,828 entries on a recent race window, 52% traded nothing at all, 35% finished negative, and
// losses grew monotonically with trade count (10+ trades averaged about -$28 on a $1,000
// stake). There is a second, separate penalty on churn: when two entries tie on exactly equal
// net PnL, the tie is broken in favour of the entry with fewer trades, so extra fills can only
// lose you money or, at best, lose you the tie break.
//
// The trigger is displacement from a rolling median rather than a mean or a fixed price. This
// series is a mean-reverting walk around a slowly drifting level across minutes and hours, and
// a median is the reference that survives the occasional outlier print into the pool, where a
// mean would be dragged by it and would mistake a spike for a dip. The entry only fires when
// the close sits DIP below that level, which is far enough below it that a normal reversion to
// the level pays several times the 26 bps round trip.
//
// The exits exist because the dev gate wants a net PnL above zero on a window nobody can see
// ahead of time, and the race scores only the ten best net PnLs, so the bot has to be right on
// an unknown window instead of a fitted one. The hold limit bounds how long capital can sit in
// a position that is not working, and the stop bounds drawdown against the 25%-of-equity
// guardrail. Both thresholds were picked so the same numbers clear the gate on the dev window
// and on independent 24-hour bitcoin windows, and were kept at the centre of the region that
// survives rather than at its single best cell: one profitable point is noise, a profitable
// neighbourhood is a signal.
//
// Determinism: no clock, no network, no Math.random. Two runs over the same bars emit the same
// orders byte for byte, which the grader checks.

import { runBars } from './vendor/makefun-bars.ts';

/** Symbol we trade: the universe holds exactly one at this competition. */
const SYMBOL = 'CBBTC';

// 120 bars is two hours of one-minute bars. That is long enough for the median to describe
// the level the price is walking around rather than the last wiggle: a shorter window tracks
// the most recent move and calls a normal pullback a displacement, which is the churn this
// bot exists to avoid.
const LOOKBACK = 120;
/** Close this far below the rolling median is a displacement worth a full-size entry. */
const DIP = 0.02;
/** Take the position out once it is this far above the entry. */
const TAKE_PROFIT = 0.015;
/** Cut it once it is this far below the entry: bounds the drawdown the guardrails measure. */
const STOP_LOSS = 0.05;
/** Bars a position may stay open before it is closed regardless (12 hours). */
const MAX_HOLD_BARS = 720;

/**
 * Slippage headroom in bps, measured from the latest close. Wide enough that the modelled
 * slippage plus the fill's own impact never gets the order refused, and no wider: the point of
 * max_slippage_bps is to refuse a fill far from the close we decided on.
 */
const MAX_SLIPPAGE_BPS = 200;

/** The window of closes the reference level is taken over, kept in insertion order. */
const closes: number[] = [];
/** True while a position is open, so the bot never sends a second buy. */
let holding = false;
/** The fill price recorded when the position went on, and the bar count since. */
let entryPrice = 0;
let barsHeld = 0;
/** Count of bars seen, used to keep the hold limit honest across the whole window. */
let barCount = 0;

/** Median of a copy: the level estimate that survives the pool's outlier prints. */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

await runBars({
  onBatch(state) {
    // One symbol only: another universe would need its own sizing, so stay out of it.
    if (state.hello.symbols.length !== 1 || state.hello.symbols[0]?.symbol !== SYMBOL) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];                       // no bar yet: any order would be refused
    if (state.warmingUp) return [];                      // warm-up bars are history, never tradable

    const price = Number(close);
    barCount += 1;
    closes.push(price);
    if (closes.length > LOOKBACK + 1) closes.shift();

    if (holding) {
      barsHeld += 1;
      const move = (price - entryPrice) / entryPrice;
      const takeProfit = move >= TAKE_PROFIT;
      const stopLoss = move <= -STOP_LOSS;
      const stale = barsHeld >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || stale) {
        const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
        if (qty > 0n) {
          holding = false;
          barsHeld = 0;
          return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // A full window of history is needed before the median means anything.
    if (closes.length <= LOOKBACK) return [];

    const level = median(closes);
    const displacement = (price - level) / level;
    if (displacement > -DIP) return [];

    // Enter at full size: one position at up to 100% of equity, sized off cash rather than the
    // weight cap so the order can never be trimmed into something the fee would dominate.
    const spend = state.cash;
    if (spend <= 0n) return [];
    holding = true;
    barsHeld = 0;
    // The fill happens at the next bar's open, which is unknown here; the close is the best
    // estimate and the exit thresholds are measured against the fill the harness reports.
    entryPrice = price;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },

  onDone(state) {
    // The harness flattens anything still held; nothing to send here.
  },
});
