// server/terminal.ts — the persistent, environment-scoped lazygit session.
// The session is created lazily when the tab is first activated, reused
// across tab switches, and replaced when it is dead or stuck on lazygit's
// "not a git repository" prompt.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decodeBase64ToUtf8 } from "../lib/base64";
import type { AttachResult } from "./contract";
import { TERMINAL_TITLE } from "./constants";
import type { Environment } from "./env";
import type { PluginStateApi } from "./state";

// TerminalSession is not a root export; derive it from the SDK area type.
type TerminalSession = Awaited<
  ReturnType<BbPluginApi["sdk"]["terminals"]["get"]>
>;

// A session started before its folder became a git repo sits on lazygit's
// "Not in a git repository…" prompt forever; attach must not reuse it.
// (lazygit's own prompt says "Not in a…", git's fatal says "not a…".)
const NOT_A_REPO_MARKERS = ["not in a git repository", "not a git repository"];
const REPO_PROMPT_TAIL_BYTES = 8192;

/**
 * Lazygit sessions are environment-scoped so bb's native terminal-tab
 * auto-lister never shows a duplicate in the thread panel.
 */
export function createTerminalManager(
  bb: BbPluginApi,
  deps: {
    state: PluginStateApi;
    env: Environment;
    /** Command run in the terminal tab (the `command` setting). */
    command: string;
  },
) {
  function isAlive(session: TerminalSession): boolean {
    return (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "disconnected"
    );
  }

  async function sessionStuckAtRepoPrompt(
    terminalId: string,
  ): Promise<boolean> {
    const tail = await bb.sdk.terminals
      .output({ terminalId, tailBytes: REPO_PROMPT_TAIL_BYTES })
      .catch(() => null);
    if (tail === null) return false;
    return tail.chunks.some((chunk) => {
      const text = decodeBase64ToUtf8(chunk.dataBase64).toLowerCase();
      return NOT_A_REPO_MARKERS.some((marker) => text.includes(marker));
    });
  }

  async function doAttach(
    threadId: string,
    cols: number,
    rows: number,
  ): Promise<AttachResult> {
    const state = await deps.state.read();
    const record = state.threads[threadId];
    if (record?.terminalId != null) {
      const existing = await bb.sdk.terminals
        .get({ terminalId: record.terminalId })
        .catch(() => null);
      if (existing !== null && isAlive(existing)) {
        if (!(await sessionStuckAtRepoPrompt(existing.id))) {
          if (existing.cols !== cols || existing.rows !== rows) {
            await bb.sdk.terminals
              .resize({ terminalId: existing.id, cols, rows })
              .catch(() => {});
          }
          return {
            terminalId: existing.id,
            status: existing.status,
            exitCode: existing.exitCode,
          };
        }
        bb.log.info(
          `replacing lazygit session ${existing.id}: stuck at the not-a-repo prompt`,
        );
      }
      if (existing !== null) {
        await bb.sdk.terminals
          .close({ terminalId: existing.id, mode: "force" })
          .catch(() => {});
      }
    }

    const environmentId = await deps.env.threadEnvironmentId(threadId);
    const session = await bb.sdk.terminals.create({
      scope: { kind: "environment", environmentId },
      cols,
      rows,
      title: TERMINAL_TITLE,
      start: { mode: "command", command: deps.command },
    });
    await deps.state.recordThread(threadId, session.id);
    bb.log.info(
      `started lazygit session ${session.id} for thread ${threadId} (env ${environmentId})`,
    );
    return {
      terminalId: session.id,
      status: session.status,
      exitCode: session.exitCode,
    };
  }

  // Deduplicate concurrent calls per thread (overlay + CLI + panel action can
  // race on one view).
  const inflightAttach = new Map<string, Promise<AttachResult>>();
  function attach(threadId: string, cols: number, rows: number) {
    const pending = inflightAttach.get(threadId);
    if (pending !== undefined) return pending;
    const run = doAttach(threadId, cols, rows).finally(() => {
      inflightAttach.delete(threadId);
    });
    inflightAttach.set(threadId, run);
    return run;
  }

  return { isAlive, sessionStuckAtRepoPrompt, attach };
}

export type TerminalManager = ReturnType<typeof createTerminalManager>;