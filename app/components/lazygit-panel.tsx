// app/components/lazygit-panel.tsx — the tab body: the xterm.js terminal
// bridged to the thread's persistent lazygit session (see the
// use-lazygit-terminal hook) plus the placeholder overlays for the
// connecting / no-repo / exited / error phases.
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { useLazygitTerminal } from "../hooks/use-lazygit-terminal";
import { PanelMessage } from "./panel-message";

export function LazygitPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { containerRef, phase, initializing, restart, initRepo } =
    useLazygitTerminal(threadId, rpc);

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