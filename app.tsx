// bb-plugin-lazygit — a BB plugin frontend entry.
//
// Three surfaces, all backed by the RPC contract in server.ts:
// - an app-wide overlay that adds the thread's Lazygit panel tab the first
//   time a thread is opened in this window (like the built-in Diff tab —
//   present, not selected);
// - a "Lazygit" row in the thread panel's Actions list that selects the tab
//   (openPanel replaces the "New tab" launcher and activates the tab);
// - the tab body itself: an xterm.js terminal bridged to the thread's
//   persistent lazygit session via the lazygit_* RPCs.
import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginRpcClient,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import type { EnsureResult, rpcContract } from "./server";

type Rpc = PluginRpcClient<typeof rpcContract>;

const OUTPUT_POLL_MS = 100;
const STATUS_POLL_MS = 2000;
const OUTPUT_FAILURE_TOLERANCE = 10;
// A new thread's environment can take a while to provision; keep retrying
// attach instead of landing on an error the user has to dismiss.
const ATTACH_RETRY_MS = 2000;
const ATTACH_RETRY_LIMIT = 45;

function encodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Lazygit terminal tab body
// ---------------------------------------------------------------------------

function PanelMessage({
  title,
  detail,
  actionLabel,
  onAction,
  disabled,
}: {
  title: string;
  detail: string | null;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail === null ? null : (
        <p className="max-w-md text-xs text-muted-foreground">{detail}</p>
      )}
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function LazygitPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  // The effect is long-lived; always call the latest client without re-running.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<
    | { kind: "connecting"; waiting: boolean }
    | { kind: "ready" }
    | { kind: "no-repo" }
    | { kind: "exited"; exitCode: number | null }
    | { kind: "error"; message: string }
  >({ kind: "connecting", waiting: false });
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
    let observer: ResizeObserver | null = null;

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
    fit.fit();

    setPhase({ kind: "connecting", waiting: false });

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

      // Replay recent output so a remount (tab switch) restores the screen.
      let seq = 0;
      try {
        const tail = await rpcRef.current.call("lazygit_output", {
          terminalId,
          tailBytes: 131072,
        });
        if (disposed) return;
        for (const chunk of tail.chunks) {
          term.write(decodeBase64(chunk.dataBase64));
        }
        seq = tail.nextSeq;
      } catch {
        // A missing scrollback is not fatal; live output follows.
      }

      const dataSub = term.onData((data) => {
        rpcRef.current
          .call("lazygit_input", { terminalId, dataBase64: encodeText(data) })
          .catch(() => {});
      });

      let lastCols = term.cols;
      let lastRows = term.rows;
      observer = new ResizeObserver(() => {
        if (disposed) return;
        fit.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          rpcRef.current
            .call("lazygit_resize", { terminalId, cols: lastCols, rows: lastRows })
            .catch(() => {});
        }
      });
      observer.observe(container);

      let failures = 0;
      const pump = async () => {
        if (disposed || sessionEnded) return;
        try {
          const result = await rpcRef.current.call("lazygit_output", {
            terminalId,
            sinceSeq: seq,
          });
          for (const chunk of result.chunks) {
            term.write(decodeBase64(chunk.dataBase64));
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
      observer?.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, attempt]);

  const restart = () => setAttempt((value) => value + 1);
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
  return (
    <div className="relative h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <div ref={containerRef} className="h-full w-full pl-2 pt-1" />
      {phase.kind === "connecting" ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {phase.waiting
            ? "Waiting for the thread's environment…"
            : "Starting lazygit…"}
        </div>
      ) : null}
      {phase.kind === "no-repo" ? (
        <div className="absolute inset-0">
          <PanelMessage
            title="This folder isn't a git repository"
            detail="lazygit needs a git repository in the thread's folder. Initialize one to get started."
            actionLabel={
              initializing ? "Initializing…" : "Initialize git repository"
            }
            onAction={initRepo}
            disabled={initializing}
          />
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <div className="absolute inset-0">
          <PanelMessage
            title="Could not start lazygit"
            detail={phase.message}
            actionLabel="Retry"
            onAction={restart}
          />
        </div>
      ) : null}
      {phase.kind === "exited" ? (
        <div className="absolute inset-0">
          <PanelMessage
            title="lazygit is not running"
            detail={
              phase.exitCode === 127
                ? "The lazygit command was not found. Install lazygit or adjust the plugin's Lazygit command setting."
                : phase.exitCode !== null && phase.exitCode !== 0
                  ? `lazygit exited with code ${phase.exitCode}.`
                  : "You quit lazygit."
            }
            actionLabel="Restart lazygit"
            onAction={restart}
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-open overlay + Actions row
// ---------------------------------------------------------------------------

// The action's `run` is not a React hook context, so the overlay publishes
// its RPC client here once mounted. The overlay mounts at plugin activation,
// before any thread surface can invoke the action.
let sharedRpc: Rpc | null = null;

function ensureLazygit(threadId: string, force: boolean): Promise<EnsureResult> {
  if (sharedRpc === null) return Promise.reject(new Error("not ready"));
  return force
    ? sharedRpc.call("ensure_lazygit_tab", { threadId, force: true })
    : sharedRpc.call("ensure_lazygit_tab", { threadId });
}

/** Mounted once per app window; owns the on-thread-open auto creation. */
function AutoOpenOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId } = useBbContext();
  const { values } = useSettings();
  // One attempt per thread per window session. A failure removes the marker
  // so the next navigation retries (e.g. environment still provisioning).
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    sharedRpc = rpc;
    return () => {
      if (sharedRpc === rpc) sharedRpc = null;
    };
  }, [rpc]);

  useEffect(() => {
    if (threadId === null) return;
    if (values === undefined) return; // settings still loading
    if (values.autoOpen === false) return;
    if (attempted.current.has(threadId)) return;
    attempted.current.add(threadId);
    ensureLazygit(threadId, false).catch((cause: unknown) => {
      attempted.current.delete(threadId);
      console.warn(
        `[lazygit] could not create the tab for ${threadId}:`,
        cause instanceof Error ? cause.message : cause,
      );
    });
  }, [threadId, values, rpc]);

  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "lazygit-auto-open",
    component: AutoOpenOverlay,
  });

  app.slots.threadPanelAction({
    id: "lazygit",
    title: "Lazygit",
    icon: "GitBranch",
    layout: "flush",
    component: LazygitPanel,
    run: async ({ threadId, openPanel }) => {
      try {
        await ensureLazygit(threadId, true);
      } catch (cause) {
        toast.error(
          `Could not open Lazygit: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        return;
      }
      // Host-native open: replaces the "New tab" launcher (or activates the
      // existing tab) and selects it.
      openPanel({ title: "Lazygit" });
    },
  });
});
