// app/hooks/use-lazygit-terminal.ts — the xterm.js bridge to the thread's
// persistent lazygit session. Owns the terminal lifecycle: attach (with
// retries while the environment provisions), scrollback replay on remount,
// keystroke/input, resize observation, output polling, and exit detection.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { toast } from "sonner";
import { decodeBase64Bytes, encodeBase64 } from "../../lib/base64";
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

  function observeResize(
    term: XTerm,
    fit: FitAddon,
    isDisposed: () => boolean,
  ): { observer: ResizeObserver; dispose: () => void } {
    let lastCols = term.cols;
    let lastRows = term.rows;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const fitSafe = () => {
      try {
        fit.fit();
      } catch {
        // Container may have zero dimensions during panel animation; ignore.
      }
    };

    const ro = new ResizeObserver(() => {
      if (isDisposed()) return;
      // Debounce rapid resize events (panel drag, window resize, animations)
      // so xterm.js only recalculates once the layout has settled.
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (isDisposed()) return;
        fitSafe();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          if (terminalIdRef.current !== null) {
            rpcRef.current
              .call("lazygit_resize", {
                terminalId: terminalIdRef.current,
                cols: lastCols,
                rows: lastRows,
              })
              .catch(() => {});
          }
        }
      }, 50);
    });
    ro.observe(containerRef.current!);
    return {
      observer: ro,
      dispose: () => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        ro.disconnect();
      },
    };
  }

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

    // Initial fit so the terminal fills the container from the first frame.
    try {
      fit.fit();
    } catch {
      // Ignore; the ResizeObserver will retry once the layout settles.
    }
    const { observer, dispose } = observeResize(term, fit, () => disposed);
    resizeCleanup = dispose;

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

      // Replay recent output so a remount (tab switch) restores the screen.
      let seq = 0;
      try {
        const tail = await rpcRef.current.call("lazygit_output", {
          terminalId,
          tailBytes: 131072,
        });
        if (disposed) return;
        for (const chunk of tail.chunks) {
          term.write(decodeBase64Bytes(chunk.dataBase64));
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