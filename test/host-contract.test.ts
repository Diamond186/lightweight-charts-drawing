// Host contract on the integration branch: the options of the separate PRs (dragToPlace, clampToPane, keyboard,
// magnetSource, interactive, cancelPending) work together, and the body-move rule of project.ts holds on the
// drawing's own bar grid and on a coarser one. Main only, not part of any upstream PR.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrawingManagerOptions } from "../src";
import { OFF, SAVED, ptr, setup } from "./pointer-harness";

afterEach(() => vi.unstubAllGlobals());

// Pane 800 x 500 at the origin; price = 500 - y, time = x (pointer-harness).
const pts = (s: ReturnType<typeof setup>) => s.dm.drawings().map((d) => d.points);

/** Armed trend line, point 1 pressed at (100, 200) = { time: 100, price: 300 }; the drag-to-place watcher runs. */
function pressed(opts: DrawingManagerOptions) {
  const s = setup({ dragToPlace: true, ...opts });
  s.dm.setTool("trend-line");
  s.el.dispatchEvent(ptr("pointerdown", "mouse", 100, 200));
  return s;
}

describe("dragToPlace with the other options", () => {
  it("clampToPane: a release over the pane below lands point 2 on the price pane bottom edge", () => {
    const s = pressed({ clampToPane: true });
    s.doc.dispatchEvent(ptr("pointermove", "mouse", 300, 650));
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 300, 650));
    expect(pts(s)).toEqual([[{ time: 100, price: 300 }, { time: 300, price: 0 }]]);
  });

  it("keyboard: false: Shift on the pointer events of the drag angle-snaps point 2 (D-11)", () => {
    const s = pressed({ keyboard: false });
    expect(s.win.live("keydown")).toBe(0);
    s.doc.dispatchEvent(ptr("pointermove", "mouse", 300, 190, { shiftKey: true }));
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 300, 190, { shiftKey: true }));
    // 200 px right, 10 px up: snapped to the horizontal through point 1.
    expect(pts(s)).toEqual([[{ time: 100, price: 300 }, { time: 300, price: 300 }]]);
  });

  it("keyboard: false, no Shift on the events: point 2 is where it was released", () => {
    const s = pressed({ keyboard: false });
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 300, 190));
    expect(pts(s)).toEqual([[{ time: 100, price: 300 }, { time: 300, price: 310 }]]);
  });

  it("cancelPending() during the drag: nothing placed, no gesture listener left, chart released, tool armed", () => {
    const s = pressed({});
    s.doc.dispatchEvent(ptr("pointermove", "mouse", 200, 250));
    s.dm.cancelPending();
    expect(s.dm.drawings()).toHaveLength(0);
    expect(s.doc.liveTotal()).toBe(s.base.doc);
    expect(s.win.liveTotal()).toBe(s.base.win);
    expect(s.chart.applyOptions.mock.calls).toEqual([[OFF], [SAVED]]);
    expect(s.dm.tool()).toBe("trend-line");
    // the late release places nothing; a fresh drag places a line
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 300, 300));
    expect(s.dm.drawings()).toHaveLength(0);
    s.el.dispatchEvent(ptr("pointerdown", "mouse", 100, 200));
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 300, 300));
    expect(pts(s)).toEqual([[{ time: 100, price: 300 }, { time: 300, price: 200 }]]);
  });

  it("magnetSource (weak): a release 10 px from a source value takes that value exactly", () => {
    const magnetSource = vi.fn((t: unknown) => ({ time: t as never, values: [123.456] }));
    const s = pressed({ magnet: "weak", magnetSource });
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 300, 500 - 133.456));
    expect(pts(s)).toEqual([[{ time: 100, price: 300 }, { time: 300, price: 123.456 }]]);
    expect(magnetSource).toHaveBeenCalledWith(300);
  });
});

describe("interactive: false", () => {
  it("with no tool, a press on a drawing selects nothing", () => {
    const s = setup({});
    s.dm.add({ kind: "trend-line", points: [{ time: 100 as never, price: 300 }, { time: 300 as never, price: 200 }] });
    s.dm.setInteractive(false);
    const down = ptr("pointerdown", "mouse", 200, 250);
    const stop = vi.spyOn(down, "stopPropagation");
    s.el.dispatchEvent(down);
    s.doc.dispatchEvent(ptr("pointerup", "mouse", 200, 250));
    expect(s.dm.selection()).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    expect(s.chart.applyOptions).not.toHaveBeenCalled();
  });
});

// D-13 backstop: bars 10 px apart, bar i at x = 10 i + 5; the time scale maps bar times only (off-bar times go
// through the library's logical fallback, as with Lightweight Charts).
describe("body move rule (project.ts translateDrawing)", () => {
  const T0 = 240_000_000;
  function onGrid(iv: number) {
    const bars = Array.from({ length: 40 }, (_, i) => ({ time: (T0 + i * iv) as never, open: 1, high: 1, low: 1, close: 1 }));
    const s = setup({ bars: () => bars });
    const idx = (t: number) => (t - T0) / iv;
    const base = s.chart.timeScale();
    Object.assign(s.chart, {
      timeScale: () => ({
        ...base,
        timeToCoordinate: (t: number) => (Number.isInteger(idx(t)) && idx(t) >= 0 && idx(t) < bars.length ? idx(t) * 10 + 5 : null),
        coordinateToTime: (x: number) => {
          const i = Math.round((x - 5) / 10);
          return i >= 0 && i < bars.length ? T0 + i * iv : null;
        },
        coordinateToLogical: (x: number) => (x - 5) / 10,
        logicalToCoordinate: (l: number) => l * 10 + 5,
      }),
    });
    return s;
  }
  /** Select a flat line at price 300, grab its body at the middle and move it right by `px`; the new times. */
  function moveBody(s: ReturnType<typeof setup>, iv: number, times: [number, number], px: number) {
    const id = s.dm.add({ kind: "trend-line", points: [{ time: times[0] as never, price: 300 }, { time: times[1] as never, price: 300 }] });
    s.dm.select([id]);
    // A point is drawn on the bar that holds its time.
    const xOf = (t: number) => Math.floor((t - T0) / iv) * 10 + 5;
    const x0 = (xOf(times[0]) + xOf(times[1])) / 2;
    s.el.dispatchEvent(ptr("pointerdown", "mouse", x0, 200));
    s.doc.dispatchEvent(ptr("pointermove", "mouse", x0 + px, 200));
    s.doc.dispatchEvent(ptr("pointerup", "mouse", x0 + px, 200));
    return s.dm.get(id)!.points.map((p) => p.time as unknown as number);
  }

  it("own grid: a move by 3 bars shifts both times by exactly 3 intervals, the delta stays", () => {
    const iv = 60;
    const s = onGrid(iv);
    const from: [number, number] = [T0 + 2 * iv, T0 + 6 * iv];
    const to = moveBody(s, iv, from, 30);
    expect(to).toEqual([from[0] + 3 * iv, from[1] + 3 * iv]);
    expect(to[1] - to[0]).toBe(from[1] - from[0]);
  });

  it("4x coarser grid: each point lands on the open time of the bar under it", () => {
    const iv = 240;
    const s = onGrid(iv);
    // Drawn on a 1 minute grid: 300 s is inside bar 1 (240..480), 2220 s inside bar 9 (2160..2400).
    const from: [number, number] = [T0 + 300, T0 + 2220];
    const to = moveBody(s, iv, from, 30);
    expect(to).toEqual([T0 + 4 * iv, T0 + 12 * iv]);
  });
});
