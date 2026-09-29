// test/terminal-cache.test.ts — unit tests for the parked-terminal cache in
// app/hooks/use-lazygit-terminal.ts. Covers the lifecycle rules a tab switch
// relies on: a released terminal is re-acquired intact, in-use terminals are
// never handed out twice or evicted, the LRU overflow is disposed, and a
// terminal the cache no longer holds is disposed on release.
import { describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  TerminalCache,
  TerminalModeTracker,
  type CachedTerminal,
} from "../app/hooks/use-lazygit-terminal";

function fakeEntry(): CachedTerminal & { dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn();
  const term = { dispose, element: undefined } as unknown as XTerm;
  const entry: CachedTerminal = {
    term,
    fit: {} as FitAddon,
    terminalId: null,
    seq: 0,
    modes: new TerminalModeTracker(),
    inUse: false,
    epoch: 0,
  };
  return Object.assign(entry, { dispose });
}

describe("TerminalCache", () => {
  it("hands a released terminal back intact on the next acquire", () => {
    const cache = new TerminalCache(2);
    const entry = fakeEntry();
    cache.store("a", entry);
    cache.release("a", entry);
    const acquired = cache.acquire("a");
    expect(acquired).toBe(entry);
    expect(acquired?.inUse).toBe(true);
    expect(acquired?.epoch).toBe(1);
  });

  it("never hands out an in-use terminal", () => {
    const cache = new TerminalCache(2);
    const entry = fakeEntry();
    cache.store("a", entry);
    expect(cache.acquire("a")).toBeUndefined();
    expect(cache.isInUse("a")).toBe(true);
  });

  it("disposes the least recently used parked terminal past the limit", () => {
    const cache = new TerminalCache(2);
    const a = fakeEntry();
    const b = fakeEntry();
    const c = fakeEntry();
    cache.store("a", a);
    cache.store("b", b);
    cache.release("a", a); // parked: the eviction candidate
    cache.store("c", c); // over the limit → evicts "a"
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.dispose).not.toHaveBeenCalled();
    expect(c.dispose).not.toHaveBeenCalled();
    expect(cache.size).toBe(2);
  });

  it("evicts the older of two parked terminals", () => {
    const cache = new TerminalCache(1);
    const a = fakeEntry();
    const b = fakeEntry();
    cache.store("a", a);
    cache.release("a", a);
    cache.store("b", b);
    cache.release("b", b);
    expect(cache.size).toBe(1);
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(cache.acquire("b")).toBe(b);
  });

  it("disposes on release when the cache holds another entry for the thread", () => {
    const cache = new TerminalCache(2);
    const first = fakeEntry();
    const transient = fakeEntry();
    cache.store("a", first); // stays in use → a second panel gets no acquire
    cache.release("a", transient);
    expect(transient.dispose).toHaveBeenCalledOnce();
    expect(cache.isInUse("a")).toBe(true);
  });

  it("keeps the entry count bounded even when everything is in use", () => {
    const cache = new TerminalCache(1);
    const a = fakeEntry();
    const b = fakeEntry();
    cache.store("a", a);
    cache.store("b", b); // both in use: nothing may be evicted
    expect(cache.size).toBe(2);
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
  });
});
