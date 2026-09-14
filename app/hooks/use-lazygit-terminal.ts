// app/hooks/use-lazygit-terminal.ts — the xterm.js bridge to the thread's
// persistent lazygit session. Owns the terminal lifecycle: attach (with
// retries while the environment provisions), scrollback replay on remount,
// keystroke/input, resize observation, output polling, and exit detection.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { toast } from "sonner";
import {
  decodeBase64Bytes,
  decodeBase64ToUtf8,
  encodeBase64,
} from "../../lib/base64";
import type { Rpc } from "../rpc-store";

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
// restore the previous phase immediately — the scrollback replay fills the
// screen — instead of flashing the "connecting" overlay on every switch.
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
 * session's output stream. A remount creates a fresh xterm with every mode
 * off, but the replayed output tail usually no longer contains the enable
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

// Per-thread trackers, shared across remounts (same lifecycle as
// lastPhaseByThread): the panel unmounts on tab/thread switches while the
// session's modes live on in the running process.
const modeTrackersByThread = new Map<string, TerminalModeTracker>();

function modeTracker(threadId: string): TerminalModeTracker {
  let tracker = modeTrackersByThread.get(threadId);
  if (tracker === undefined) {
    tracker = new TerminalModeTracker();
    modeTrackersByThread.set(threadId, tracker);
  }
  return tracker;
}

export function useLazygitTerminal(threadId: string, rpc: Rpc) {
  // The effect is long-lived; always call the latest client without re-running.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
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
    let resizeCleanup: (() => void) | null = null;

    const styles = getComputedStyle(container);
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      theme: {
        background: styles.backgroundColor || undefined,
        foreground: styles.color || undefined,
        cursor: styles.color || undefined,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    resizeCleanup = observeTerminalResize(
      container,
      term,
      fit,
      () => disposed,
      (cols, rows) => {
        const terminalId = terminalIdRef.current;
        if (terminalId !== null) {
          rpcRef.current
            .call("lazygit_resize", { terminalId, cols, rows })
            .catch(() => {});
        }
      },
    );

    // Keep the cached phase (ready/exited/no-repo) while re-attaching; the
    // first attach failure downgrades to "connecting" if the session is gone.
    const attach = async (attemptsLeft: number): Promise<void> => {
      // Don't start lazygit where it could only show its raw "not a git
      // repository" prompt; the no-repo panel offers an explicit init action.
      try {
        const repo = await rpcRef.current.call("lazygit_repo_state", {
          threadId,
        });
        if (disposed) return;
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
        if (disposed) return;
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
      if (disposed) return;
      if (session.status === "exited") {
        sessionEnded = true;
        setPhase({ kind: "exited", exitCode: session.exitCode });
        return;
      }
      const terminalId = session.terminalId;
      terminalIdRef.current = terminalId;
      const modes = modeTracker(threadId);

      // Replay recent output so a remount (tab switch) restores the screen.
      let seq = 0;
      try {
        const tail = await rpcRef.current.call("lazygit_output", {
          terminalId,
          tailBytes: 131072,
        });
        if (disposed) return;
        // A fresh session's tail starts at seq 0 (init sequences included),
        // so only a reused session needs its modes restored before replay.
        const reassert = modes.reassertSequence();
        if (reassert !== "") {
          term.write(reassert);
        } else if (!session.created) {
          term.write(PRESUMED_SESSION_MODES);
        }
        for (const chunk of tail.chunks) {
          term.write(decodeBase64Bytes(chunk.dataBase64));
          modes.feed(decodeBase64ToUtf8(chunk.dataBase64));
        }
        seq = tail.nextSeq;
      } catch {
        // A missing scrollback is not fatal; live output follows.
      }

      const dataSub = term.onData((data) => {
        rpcRef.current
          .call("lazygit_input", { terminalId, dataBase64: encodeBase64(data) })
          .catch(() => {});
      });

      let failures = 0;
      const pump = async () => {
        if (disposed || sessionEnded) return;
        try {
          const result = await rpcRef.current.call("lazygit_output", {
            terminalId,
            sinceSeq: seq,
          });
          for (const chunk of result.chunks) {
            term.write(decodeBase64Bytes(chunk.dataBase64));
            modes.feed(decodeBase64ToUtf8(chunk.dataBase64));
          }
          seq = result.nextSeq;
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= OUTPUT_FAILURE_TOLERANCE) {
            if (!disposed) {
              sessionEnded = true;
              setPhase({
                kind: "error",
                message: "Lost the connection to the lazygit session.",
              });
            }
            return;
          }
        }
        if (!disposed && !sessionEnded) {
          outputTimer = window.setTimeout(pump, OUTPUT_POLL_MS);
        }
      };
      outputTimer = window.setTimeout(pump, OUTPUT_POLL_MS);

      const statusPoll = async () => {
        if (disposed || sessionEnded) return;
        try {
          const status = await rpcRef.current.call("lazygit_status", {
            terminalId,
          });
          if (status.status === "exited") {
            if (!disposed) {
              sessionEnded = true;
              setPhase({ kind: "exited", exitCode: status.exitCode });
            }
            return;
          }
        } catch {
          // Transient read failure; the output pump's tolerance handles loss.
        }
        if (!disposed && !sessionEnded) {
          statusTimer = window.setTimeout(statusPoll, STATUS_POLL_MS);
        }
      };
      statusTimer = window.setTimeout(statusPoll, STATUS_POLL_MS);

      term.focus();
      setPhase({ kind: "ready" });
    };

    void attach(ATTACH_RETRY_LIMIT);
    return () => {
      disposed = true;
      window.clearTimeout(attachTimer);
      window.clearTimeout(outputTimer);
      window.clearTimeout(statusTimer);
      resizeCleanup?.();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, attempt]);

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