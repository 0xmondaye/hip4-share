import assert from "node:assert/strict";
import { holdToNow, timeTicks } from "./chart-hover.ts";

const gaps = (ts, t0, t1, w) =>
  ts.slice(1).map((t, i) => ((t - ts[i]) / (t1 - t0)) * w);

// 30s window, 5s candles — narrow (mobile) plot must thin the ticks out
{
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 30_000;
  const w = 318;
  const ts = timeTicks(t0, t1, w, 5000);
  assert.ok(ts.length > 1, "needs at least two ticks");
  assert.ok(
    gaps(ts, t0, t1, w).every((g) => g >= 68),
    `labels crowd on mobile: ${gaps(ts, t0, t1, w)}`,
  );
  assert.ok(
    ts.every((t) => t % 5000 === 0 && t >= t0 && t <= t1),
    "ticks must stay on 5s boundaries inside the window",
  );
}

// wide plot keeps the native 5s step
{
  const t0 = 1_700_000_000_000;
  const ts = timeTicks(t0, t0 + 30_000, 714, 5000);
  assert.equal(ts[1] - ts[0], 5000);
}

// 6h window, hourly candles
{
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 6 * 3600_000;
  const w = 318;
  const ts = timeTicks(t0, t1, w, 3600_000);
  assert.ok(
    gaps(ts, t0, t1, w).every((g) => g >= 68),
    "hourly labels crowd on mobile",
  );
}

// degenerate inputs return nothing rather than looping forever
assert.deepEqual(timeTicks(5, 5, 300, 1000), []);
assert.deepEqual(timeTicks(0, 30_000, 0, 1000), []);

// stale series is carried to now at its live mid, so every line ends at the
// right edge showing the same number the legend does
{
  const now = 1_700_000_000_000;
  const stale = [{ t: now - 4 * 3600_000, c: 0.0 }];
  assert.deepEqual(holdToNow(stale, now, 0.03), [
    stale[0],
    { t: now, c: 0.03 },
  ]);
  // no candles / no mid / already current: leave untouched
  assert.deepEqual(holdToNow([], now, 0.03), []);
  assert.deepEqual(holdToNow(stale, now, null), stale);
  const fresh = [{ t: now, c: 0.5 }];
  assert.deepEqual(holdToNow(fresh, now, 0.03), fresh);
}

console.log("chart-ticks ok");
