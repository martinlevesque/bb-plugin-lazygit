// test/observe-terminal-resize.test.ts — unit tests for the debounced
// container→xterm size sync in app/hooks/use-lazygit-terminal.ts.
//
// Regression coverage for the terminal rendering corruption fixed by
// debouncing the ResizeObserver: a burst of resize events (panel drag,
// layout animation) must collapse into a single fit once the layout
// settles, transient fit() failures must not escape the observer callback,
// and disposal must cancel any pending refit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { observeTerminalResize } from "../app/hooks/use-lazygit-terminal";

type FakeObserver = {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
};

let observers: FakeObserver[];

function stubResizeObserver() {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(public callback: ResizeObserverCallback) {
        observers.push({ callback, observed: [], disconnected: false });
      }
      observe(el: Element) {
        observers[observers.length - 1].observed.push(el);
      }
      disconnect() {
        observers[observers.length - 1].disconnected = true;
      }
    },
  );
}

function fire(index = 0) {
  observers[index].callback([], {} as ResizeObserver);
}

function makeTerm(cols = 80, rows = 24) {
  const fake = { cols, rows };
  return fake as unknown as XTerm & { cols: number; rows: number };
}

function makeFit(
  term: XTerm & { cols: number; rows: number },
  target: { cols: number; rows: number },
) {
  const fitFn = vi.fn(() => {
    term.cols = target.cols;
    term.rows = target.rows;
  });
  return { fit: fitFn } as unknown as FitAddon;
}

const container = {} as HTMLElement;
const notDisposed = () => false;

beforeEach(() => {
  vi.useFakeTimers();
  stubResizeObserver();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("observeTerminalResize", () => {
  it("fits immediately so the terminal fills the container from the first frame", () => {
    const term = makeTerm();
    const fit = makeFit(term, { cols: 80, rows: 24 });
    observeTerminalResize(container, term, fit, notDisposed, () => {});
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(observers[0].observed).toEqual([container]);
  });

  it("collapses a burst of resize events into a single refit", () => {
    const term = makeTerm();
    const target = { cols: 80, rows: 24 };
    const fit = makeFit(term, target);
    const onResize = vi.fn();
    observeTerminalResize(container, term, fit, notDisposed, onResize);

    target.cols = 120;
    target.rows = 30;
    for (let i = 0; i < 20; i++) fire();
    expect(fit.fit).toHaveBeenCalledTimes(1); // still only the initial fit

    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(120, 30);
  });

  it("does not report onResize when the fitted dimensions are unchanged", () => {
    const term = makeTerm();
    const fit = makeFit(term, { cols: 80, rows: 24 });
    const onResize = vi.fn();
    observeTerminalResize(container, term, fit, notDisposed, onResize);

    fire();
    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(onResize).not.toHaveBeenCalled();
  });

  it("contains transient fit() failures and refits on the next event", () => {
    const term = makeTerm();
    let fail = true;
    const fitFn = vi.fn(() => {
      if (fail) throw new Error("transient zero-dimension state");
      (term as { cols: number }).cols = 120;
      (term as { rows: number }).rows = 30;
    });
    const fit = { fit: fitFn } as unknown as FitAddon;
    const onResize = vi.fn();
    // The initial fit failing must not break the observer setup.
    observeTerminalResize(container, term, fit, notDisposed, onResize);

    fail = false;
    fire();
    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledWith(120, 30);
  });

  it("cancels a pending refit and disconnects on cleanup", () => {
    const term = makeTerm();
    const fit = makeFit(term, { cols: 120, rows: 30 });
    const onResize = vi.fn();
    const dispose = observeTerminalResize(
      container,
      term,
      fit,
      notDisposed,
      onResize,
    );

    fire();
    dispose();
    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledTimes(1); // initial fit only
    expect(onResize).not.toHaveBeenCalled();
    expect(observers[0].disconnected).toBe(true);
  });

  it("ignores events after the hook is disposed", () => {
    const term = makeTerm();
    const fit = makeFit(term, { cols: 120, rows: 30 });
    const onResize = vi.fn();
    let disposed = false;
    observeTerminalResize(container, term, fit, () => disposed, onResize);

    disposed = true;
    fire();
    vi.advanceTimersByTime(50);
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(onResize).not.toHaveBeenCalled();
  });
});
