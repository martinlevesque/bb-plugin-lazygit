// app/hooks/use-lazygit-terminal.ts — the xterm.js bridge to the thread's
// persistent lazygit session. The panel unmounts on every tab switch, so the
// xterm instance itself is parked per thread (rendered frame, modes and
// output cursor intact) and re-attached to the new container on return:
// switching back is a DOM move plus one status check, not a re-attach with a
// full scrollback replay. The hook still owns the cold path — attach (with
// retries while the environment provisions), first-mount replay,
// keystroke/input, resize observation, output polling, and exit detection.
import { useEffect, useRef, useState } from "react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { toast } from "sonner";
import {
  decodeBase64Bytes,
  decodeBase64ToUtf8,
  encodeBase64,
} from "../../lib/base64";
import type { Rpc } from "../rpc-store";
import { readTerminalFontFamily, readTerminalTheme } from "../terminal-theme";

export type PanelPhase =
  | { kind: "connecting"; waiting: boolean }
  | { kind: "ready" }
  | { kind: "no-repo" }
  | { kind: "exited"; exitCode: number | null }
  | { kind: "error"; message: string };

const OUTPUT_POLL_MS = 100;
const STATUS_POLL_MS = 2000;
const OUTPUT_FAILURE_TOLERANCE = 10;
// Collapse rapid resize bursts (panel drags, layout animations) into a
// single fit once the layout has settled.
const RESIZE_DEBOUNCE_MS = 50;
// A new thread's environment can take a while to provision; keep retrying
// attach instead of landing on an error the user has to dismiss.
const ATTACH_RETRY_MS = 2000;
const ATTACH_RETRY_LIMIT = 45;

// Last known phase per thread, shared across remounts. The lazygit session
// outlives the panel (tab/thread switches unmount it), so a remount can
// restore the previous phase immediately instead of flashing the
// "connecting" overlay on every switch.
const lastPhaseByThread = new Map<string, PanelPhase>();

function initialPhase(threadId: string): PanelPhase {
  return (
    lastPhaseByThread.get(threadId) ?? { kind: "connecting", waiting: false }
  );
}

// fit() reaches into xterm internals that can throw while the panel is
// mid-animation; skip those transient states — the next observer callback
// refits once the layout settles.
function fitSafe(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // ignore
  }
}

/**
 * Fits immediately, then on debounced container resizes. `onResize` fires
 * only when the fitted dimensions actually change; the returned cleanup
 * cancels any pending refit.
 */
export function observeTerminalResize(
  container: HTMLElement,
  term: XTerm,
  fit: FitAddon,
  isDisposed: () => boolean,
  onResize: (cols: number, rows: number) => void,
): () => void {
  fitSafe(fit);
  let lastCols = term.cols;
  let lastRows = term.rows;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const observer = new ResizeObserver(() => {
    if (isDisposed()) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (isDisposed()) return;
      fitSafe(fit);
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        onResize(lastCols, lastRows);
      }
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(container);

  return () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    observer.disconnect();
  };
}

// Private modes a full-screen TUI toggles that a remounted terminal must
// re-assert. Ordered so the alternate screen is entered before input modes.
const TRACKED_PRIVATE_MODES = [
  1047, 1048, 1049, // alternate screen
  1000, 1002, 1003, 1006, // mouse reporting
  1004, // focus reporting
  2004, // bracketed paste
];

const PRIVATE_MODE_PATTERN = /\x1b\[\?([0-9;]+)([hl])/g;
// Longest plausible tracked sequence is well under this; a sequence split
// across output chunks is re-scanned once the rest of it arrives.
const MODE_SCAN_CARRY_LENGTH = 32;

/**
 * Learns the private-mode state (alt screen, mouse reporting, …) of a
 * session's output stream. A freshly created terminal has every mode off,
 * but a replayed output tail usually no longer contains the enable
 * sequences — they were emitted when the session started — so without
 * re-asserting them a remounted panel loses mouse input (xterm falls back
 * to its I-beam text cursor and swallows clicks as selections) and paints
 * alt-screen frames into the normal buffer.
 */
export class TerminalModeTracker {
  private on = new Set<number>();
  private carry = "";

  /** Safe to call with sequences split across chunks. */
  feed(text: string): void {
    const data = this.carry + text;
    PRIVATE_MODE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PRIVATE_MODE_PATTERN.exec(data)) !== null) {
      for (const part of match[1].split(";")) {
        const mode = Number(part);
        if (!TRACKED_PRIVATE_MODES.includes(mode)) continue;
        if (match[2] === "h") {
          this.on.add(mode);
        } else {
          this.on.delete(mode);
        }
      }
    }
    this.carry = data.slice(-MODE_SCAN_CARRY_LENGTH);
  }

  /** Enable sequences for the modes currently on, alt screen first. */
  reassertSequence(): string {
    let sequence = "";
    for (const mode of TRACKED_PRIVATE_MODES) {
      if (this.on.has(mode)) sequence += `\x1b[?${mode}h`;
    }
    return sequence;
  }
}

// Modes a running lazygit main UI is known to hold after tcell init: alt
// screen, mouse click/drag reporting with SGR coordinates, bracketed paste.
// Used only when re-attaching to a session this window has no mode history
// for (the plugin reloaded mid-session); if lazygit is momentarily out of
// its main UI the next mode transition the tracker sees corrects course.
const PRESUMED_SESSION_MODES = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h";

/**
 * A parked terminal: the live xterm instance for one thread, kept across
 * panel unmounts with its rendered frame, private modes and output cursor.
 */
export interface CachedTerminal {
  term: XTerm;
  fit: FitAddon;
  /** The attached lazygit session; null while no session was ever started. */
  terminalId: string | null;
  /** Output sequence cursor for `terminalId`. */
  seq: number;
  modes: TerminalModeTracker;
  /** True while a mounted panel hosts the DOM element. */
  inUse: boolean;
  /** Bumped on every acquire so in-flight async work from a previous mount
   * stops before writing into a terminal a newer mount already resumed. */
  epoch: number;
}

// Parked terminals are capped; the least recently used parked ones are
// disposed (their sessions keep running and replay rebuilds the screen).
const TERMINAL_CACHE_LIMIT = 8;

export class TerminalCache {
  private byThread = new Map<string, CachedTerminal>();

  constructor(private limit = TERMINAL_CACHE_LIMIT) {}

  get size(): number {
    return this.byThread.size;
  }

  /** True while a mounted panel hosts this thread's parked terminal. */
  isInUse(threadId: string): boolean {
    return this.byThread.get(threadId)?.inUse === true;
  }

  /** Returns the parked terminal marked back in use, or undefined. */
  acquire(threadId: string): CachedTerminal | undefined {
    const entry = this.byThread.get(threadId);
    if (entry === undefined || entry.inUse) return undefined;
    // Refresh the LRU position.
    this.byThread.delete(threadId);
    this.byThread.set(threadId, entry);
    entry.inUse = true;
    entry.epoch += 1;
    return entry;
  }

  /** Parks a freshly created terminal, evicting the oldest parked ones. */
  store(threadId: string, entry: CachedTerminal): void {
    entry.inUse = true;
    this.byThread.set(threadId, entry);
    for (const [key, candidate] of this.byThread) {
      if (this.byThread.size <= this.limit) break;
      if (candidate.inUse) continue;
      candidate.term.dispose();
      this.byThread.delete(key);
    }
  }

  /**
   * Parks the terminal (DOM detached, instance kept) or disposes it when the
   * cache no longer holds it — evicted, or never stored because another
   * panel already hosts this thread's terminal.
   */
  release(threadId: string, entry: CachedTerminal): void {
    entry.inUse = false;
    if (this.byThread.get(threadId) !== entry) {
      entry.term.dispose();
      return;
    }
    entry.term.element?.remove();
  }
}

const terminalCache = new TerminalCache();

export function useLazygitTerminal(threadId: string, rpc: Rpc) {
  // The effect is long-lived; always call the latest client without re-running.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // The code theme's mode/name double as the "bb theme changed" signal: a
  // palette or light/dark switch always moves at least one of them.
  const codeTheme = experimental_useCodeTheme();
  const [phase, setPhaseState] = useState<PanelPhase>(() =>
    initialPhase(threadId),
  );
  // The host may reuse the panel for another thread without remounting;
  // resync the phase from that thread's cache during render.
  const [phaseThreadId, setPhaseThreadId] = useState(threadId);
  if (phaseThreadId !== threadId) {
    setPhaseThreadId(threadId);
    setPhaseState(initialPhase(threadId));
  }
  const setPhase = (next: PanelPhase) => {
    lastPhaseByThread.set(threadId, next);
    setPhaseState(next);
  };
  const [attempt, setAttempt] = useState(0);
  const [initializing, setInitializing] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    let sessionEnded = false;
    let attachTimer = 0;
    let outputTimer = 0;
    let statusTimer = 0;

    const createEntry = (): CachedTerminal => {
      const term = new XTerm({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        fontFamily: readTerminalFontFamily(container),
        fontSize: 12,
        theme: readTerminalTheme(container),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      const entry: CachedTerminal = {
        term,
        fit,
        terminalId: null,
        seq: 0,
        modes: new TerminalModeTracker(),
        inUse: true,
        epoch: 0,
      };
      // Input is subscribed once for the terminal's lifetime and reads the
      // live session id, so remounts never stack duplicate subscriptions.
      term.onData((data) => {
        if (entry.terminalId === null) return;
        rpcRef.current
          .call("lazygit_input", {
            terminalId: entry.terminalId,
            dataBase64: encodeBase64(data),
          })
          .catch(() => {});
      });
      return entry;
    };

    // Fast path: reuse the parked terminal — its last frame is already
    // rendered, so the tab switch paints immediately.
    const acquired = terminalCache.acquire(threadId);
    const entry = acquired ?? createEntry();
    if (acquired !== undefined) {
      const element = entry.term.element;
      if (element !== undefined) container.appendChild(element);
      // Re-sync in case the theme changed while this thread was parked.
      entry.term.options.theme = readTerminalTheme(container);
      entry.term.options.fontFamily = readTerminalFontFamily(container);
      fitSafe(entry.fit);
    } else if (!terminalCache.isInUse(threadId)) {
      terminalCache.store(threadId, entry);
    }
    // else: another panel already hosts this thread's terminal, so this one
    // stays out of the cache and release() disposes it.
    termRef.current = entry.term;
    const { term, fit } = entry;
    const epoch = entry.epoch;
    const stale = () => disposed || entry.epoch !== epoch;

    const resizeCleanup = observeTerminalResize(
      container,
      term,
      fit,
      () => disposed,
      (cols, rows) => {
        if (entry.terminalId !== null) {
          rpcRef.current
            .call("lazygit_resize", { terminalId: entry.terminalId, cols, rows })
            .catch(() => {});
        }
      },
    );

    const startStreaming = (): void => {
      if (stale() || sessionEnded) return;
      const terminalId = entry.terminalId;
      if (terminalId === null) return;

      let failures = 0;
      const pump = async () => {
        if (stale() || sessionEnded) return;
        try {
          const result = await rpcRef.current.call("lazygit_output", {
            terminalId,
            sinceSeq: entry.seq,
          });
          // A previous mount's in-flight pump must not write into a terminal
          // a newer mount already resumed — it would duplicate the output.
          if (stale() || sessionEnded) return;
          for (const chunk of result.chunks) {
            term.write(decodeBase64Bytes(chunk.dataBase64));
            entry.modes.feed(decodeBase64ToUtf8(chunk.dataBase64));
          }
          entry.seq = result.nextSeq;
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= OUTPUT_FAILURE_TOLERANCE) {
            if (!stale()) {
              sessionEnded = true;
              setPhase({
                kind: "error",
                message: "Lost the connection to the lazygit session.",
              });
            }
            return;
          }
        }
        if (!stale() && !sessionEnded) {
          outputTimer = window.setTimeout(pump, OUTPUT_POLL_MS);
        }
      };
      // Kick the first pump immediately so a resumed terminal catches up on
      // output that arrived while it was parked without a poll interval.
      outputTimer = window.setTimeout(pump, 0);

      const statusPoll = async () => {
        if (stale() || sessionEnded) return;
        try {
          const status = await rpcRef.current.call("lazygit_status", {
            terminalId,
          });
          if (status.status === "exited") {
            if (!stale()) {
              sessionEnded = true;
              setPhase({ kind: "exited", exitCode: status.exitCode });
            }
            return;
          }
        } catch {
          // Transient read failure; the output pump's tolerance handles loss.
        }
        if (!stale() && !sessionEnded) {
          statusTimer = window.setTimeout(statusPoll, STATUS_POLL_MS);
        }
      };
      statusTimer = window.setTimeout(statusPoll, STATUS_POLL_MS);
    };

    // The session this terminal last streamed is gone (exited while parked,
    // or bb restarted): wipe its state and fall back to a full attach.
    const resetEntry = (): void => {
      term.reset();
      entry.modes = new TerminalModeTracker();
      entry.terminalId = null;
      entry.seq = 0;
    };

    // Cold path: a terminal that has no session yet. The repo check avoids
    // starting lazygit where it could only show its raw "not a git
    // repository" prompt; the no-repo panel offers an explicit init action.
    const attach = async (attemptsLeft: number): Promise<void> => {
      try {
        const repo = await rpcRef.current.call("lazygit_repo_state", {
          threadId,
        });
        if (stale()) return;
        if (!repo.isGitRepo) {
          setPhase({ kind: "no-repo" });
          return;
        }
      } catch {
        // Environment still provisioning or check failed: fall through to the
        // attach path, whose retries already cover provisioning delays.
      }
      let session: {
        terminalId: string;
        status: string;
        exitCode: number | null;
        created: boolean;
      };
      try {
        session = await rpcRef.current.call("lazygit_attach", {
          threadId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (cause) {
        if (stale()) return;
        if (attemptsLeft > 1) {
          // Typically "environment is still provisioning" on a fresh thread.
          setPhase({ kind: "connecting", waiting: true });
          attachTimer = window.setTimeout(() => {
            void attach(attemptsLeft - 1);
          }, ATTACH_RETRY_MS);
          return;
        }
        setPhase({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }
      if (stale()) return;
      if (session.status === "exited") {
        sessionEnded = true;
        setPhase({ kind: "exited", exitCode: session.exitCode });
        return;
      }
      entry.terminalId = session.terminalId;

      // Replay recent output so the fresh terminal restores the screen.
      try {
        const tail = await rpcRef.current.call("lazygit_output", {
          terminalId: session.terminalId,
          tailBytes: 131072,
        });
        if (stale()) return;
        // A fresh session's tail starts at seq 0 (init sequences included),
        // so only a reused session needs its modes restored before replay.
        const reassert = entry.modes.reassertSequence();
        if (reassert !== "") {
          term.write(reassert);
        } else if (!session.created) {
          term.write(PRESUMED_SESSION_MODES);
        }
        // One write for the whole replay: hundreds of small pty chunks
        // through xterm's write queue cost visibly more than a single
        // concatenated buffer.
        const parts: Uint8Array[] = [];
        let total = 0;
        for (const chunk of tail.chunks) {
          const bytes = decodeBase64Bytes(chunk.dataBase64);
          parts.push(bytes);
          total += bytes.length;
          entry.modes.feed(decodeBase64ToUtf8(chunk.dataBase64));
        }
        const all = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          all.set(part, offset);
          offset += part.length;
        }
        term.write(all);
        entry.seq = tail.nextSeq;
      } catch {
        // A missing scrollback is not fatal; live output follows.
      }
      if (stale()) return;

      startStreaming();
      term.focus();
      setPhase({ kind: "ready" });
    };

    // Warm path: confirm the parked session is alive and resume streaming;
    // the pump catches up on any output missed while parked.
    const resume = async (): Promise<void> => {
      const terminalId = entry.terminalId;
      if (terminalId === null) {
        void attach(ATTACH_RETRY_LIMIT);
        return;
      }
      let alive = false;
      try {
        const status = await rpcRef.current.call("lazygit_status", {
          terminalId,
        });
        alive = status.status !== "exited";
      } catch {
        alive = false;
      }
      if (stale()) return;
      if (!alive) {
        // A plain re-attach replaces the dead session server-side, which is
        // also what the panel's Restart routes through.
        resetEntry();
        void attach(ATTACH_RETRY_LIMIT);
        return;
      }
      startStreaming();
      term.focus();
      setPhase({ kind: "ready" });
    };

    void resume();
    return () => {
      disposed = true;
      window.clearTimeout(attachTimer);
      window.clearTimeout(outputTimer);
      window.clearTimeout(statusTimer);
      resizeCleanup();
      termRef.current = null;
      terminalCache.release(threadId, entry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, attempt]);

  // Follow a bb theme switch (palette or light/dark) without restarting the
  // session: re-resolve the theme variables once the new stylesheet has
  // landed (rAF) and let xterm repaint on the options assignment.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const term = termRef.current;
      const container = containerRef.current;
      if (term === null || container === null) return;
      term.options.theme = readTerminalTheme(container);
      term.options.fontFamily = readTerminalFontFamily(container);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [codeTheme.mode, codeTheme.name]);

  const restart = () => {
    // User-initiated: show the connecting feedback immediately.
    setPhase({ kind: "connecting", waiting: false });
    setAttempt((value) => value + 1);
  };
  const initRepo = () => {
    setInitializing(true);
    rpcRef.current
      .call("lazygit_init_repo", { threadId })
      .then(() => restart())
      .catch((cause: unknown) => {
        toast.error(
          `Could not initialize a git repository: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      })
      .finally(() => setInitializing(false));
  };

  return { containerRef, phase, initializing, restart, initRepo };
}
