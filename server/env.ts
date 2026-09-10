// server/env.ts — generic helpers for poking the thread's environment:
// resolving a thread to its environment id and running short throwaway
// commands there (repo checks, `git init`).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const COMMAND_POLL_MS = 500;
const COMMAND_WAIT_MS = 30_000;

export function createEnvironment(bb: BbPluginApi) {
  async function threadEnvironmentId(threadId: string): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId });
    const environmentId = (thread as { environmentId?: string | null })
      .environmentId;
    if (environmentId == null || environmentId === "") {
      throw new Error(
        "The thread's environment is not ready yet. Retry in a moment.",
      );
    }
    return environmentId;
  }

  /**
   * Run a short command in the environment; resolves with its exit code
   * (null when it did not exit within the timeout).
   */
  async function runEnvironmentCommand(
    environmentId: string,
    command: string,
    title: string,
  ): Promise<number | null> {
    const session = await bb.sdk.terminals.create({
      scope: { kind: "environment", environmentId },
      cols: 80,
      rows: 24,
      title,
      start: { mode: "command", command },
    });
    try {
      const deadline = Date.now() + COMMAND_WAIT_MS;
      let current = session;
      while (current.status !== "exited" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_MS));
        current = await bb.sdk.terminals.get({ terminalId: session.id });
      }
      return current.status === "exited" ? current.exitCode : null;
    } finally {
      await bb.sdk.terminals
        .close({ terminalId: session.id, mode: "force" })
        .catch(() => {});
    }
  }

  return { threadEnvironmentId, runEnvironmentCommand };
}

export type Environment = ReturnType<typeof createEnvironment>;