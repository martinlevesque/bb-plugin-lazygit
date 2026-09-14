// test/terminal-mode-tracker.test.ts — unit tests for the private-mode
// tracker that lets a remounted panel re-assert the session's alt-screen /
// mouse / paste modes before replaying the output tail.
import { describe, expect, it } from "vitest";
import { TerminalModeTracker } from "../app/hooks/use-lazygit-terminal";

describe("TerminalModeTracker", () => {
  it("reasserts nothing before any mode was seen", () => {
    expect(new TerminalModeTracker().reassertSequence()).toBe("");
  });

  it("learns modes from enable sequences, batched or not", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049h"); // alt screen
    tracker.feed("\x1b[?1000;1002;1006h"); // batched mouse reporting
    expect(tracker.reassertSequence()).toBe(
      "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h",
    );
  });

  it("drops modes on reset sequences", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    tracker.feed("\x1b[?1000l");
    expect(tracker.reassertSequence()).toBe("\x1b[?1049h\x1b[?1006h");
    tracker.feed("\x1b[?1049l\x1b[?1006l");
    expect(tracker.reassertSequence()).toBe("");
  });

  it("reasserts the alternate screen before input modes", () => {
    const tracker = new TerminalModeTracker();
    // Feed input modes first; the alt screen must still come first.
    tracker.feed("\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1049h");
    expect(tracker.reassertSequence()).toBe(
      "\x1b[?1049h\x1b[?1000h\x1b[?1004h\x1b[?2004h",
    );
  });

  it("handles sequences split across chunks", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("frame bytes\x1b[?10");
    expect(tracker.reassertSequence()).toBe("");
    tracker.feed("49h more bytes");
    expect(tracker.reassertSequence()).toBe("\x1b[?1049h");
  });

  it("ignores untracked private modes", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[?25l\x1b[?2026h\x1b[?1000h");
    expect(tracker.reassertSequence()).toBe("\x1b[?1000h");
  });

  it("ignores non-private CSI sequences", () => {
    const tracker = new TerminalModeTracker();
    tracker.feed("\x1b[2J\x1b[1;1H\x1b[1000h"); // no '?': not private modes
    expect(tracker.reassertSequence()).toBe("");
  });
});
