// bb-plugin-lazygit — a BB plugin backend entry.
//
// Composes the submodules in server/: reads settings, wires the RPC contract
// (server/contract.ts) to the tab manager, terminal session manager, and repo
// helper, and registers the `bb lazygit` CLI. Kept deliberately thin — the
// logic lives in server/{state,env,tabs,terminal,repo}.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./server/contract";
import { createEnvironment } from "./server/env";
import { createRepo } from "./server/repo";
import { createPluginState } from "./server/state";
import { createTabManager } from "./server/tabs";
import { createTerminalManager } from "./server/terminal";

export { rpcContract } from "./server/contract";
export type { EnsureResult } from "./server/contract";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    autoOpen: {
      type: "boolean",
      label: "Auto-open Lazygit tab",
      description:
        "Add a Lazygit terminal tab the first time a thread is opened.",
      default: true,
    },
    command: {
      type: "string",
      label: "Lazygit command",
      description:
        "Command run in the terminal tab. Override if lazygit is not on PATH.",
      default: "lazygit",
    },
  });
  const { command } = await settings.get();

  const state = createPluginState(bb);
  const env = createEnvironment(bb);
  const repo = createRepo(bb, { env, state });
  const terminal = createTerminalManager(bb, { state, env, command });
  const tabs = createTabManager(bb, { state });

  bb.rpc.register(rpcContract, {
    ensure_lazygit_tab: ({ threadId, force }) =>
      tabs.ensure(threadId, force === true),
    lazygit_attach: ({ threadId, cols, rows }) => terminal.attach(threadId, cols, rows),
    lazygit_output: async ({ terminalId, sinceSeq, tailBytes }) => {
      const result = await bb.sdk.terminals.output({
        terminalId,
        ...(sinceSeq !== undefined ? { sinceSeq } : {}),
        ...(tailBytes !== undefined ? { tailBytes } : {}),
      });
      return {
        chunks: result.chunks,
        nextSeq: result.nextSeq,
        truncated: result.truncated,
      };
    },
    lazygit_input: async ({ terminalId, dataBase64 }) => {
      await bb.sdk.terminals.input({ terminalId, dataBase64 });
      return { ok: true };
    },
    lazygit_resize: async ({ terminalId, cols, rows }) => {
      await bb.sdk.terminals.resize({ terminalId, cols, rows });
      return { ok: true };
    },
    lazygit_status: async ({ terminalId }) => {
      const session = await bb.sdk.terminals.get({ terminalId });
      return { status: session.status, exitCode: session.exitCode };
    },
    lazygit_repo_state: async ({ threadId }) => {
      const environmentId = await env.threadEnvironmentId(threadId);
      const isGitRepo = await repo.environmentIsGitRepo(environmentId);
      if (!isGitRepo) {
        // A recorded session can only be stuck on lazygit's not-a-repo
        // prompt; drop it so a later attach starts fresh.
        await state.clearThreadTerminal(threadId);
      }
      return { isGitRepo };
    },
    lazygit_init_repo: ({ threadId }) => repo.initRepo(threadId),
  });

  const usage = [
    "Usage:",
    "  bb lazygit [--thread <thread-id>]",
    "",
    "Adds the Lazygit tab to a thread's panel (the lazygit process starts",
    "when the tab is opened). Uses the current thread when run from a thread",
    "context; otherwise pass --thread.",
  ].join("\n");

  bb.cli.register({
    name: "lazygit",
    summary: "Open a Lazygit terminal tab on a thread",
    commands: [
      {
        name: "open",
        summary: "Open the Lazygit tab for a thread",
        usage: "bb lazygit [--thread <thread-id>]",
      },
    ],
    async run(argv, ctx) {
      const threadFlag = argv.indexOf("--thread");
      const threadId =
        threadFlag >= 0 ? argv[threadFlag + 1] : (ctx.threadId ?? undefined);
      if (
        argv.some((arg) => arg === "help" || arg === "--help") ||
        argv.some(
          (arg, index) =>
            arg.startsWith("--") && arg !== "--thread" && index !== threadFlag + 1,
        )
      ) {
        return { exitCode: 0, stdout: usage };
      }
      if (threadId === undefined || threadId === "") {
        return { exitCode: 1, stderr: `No thread in context. ${usage}` };
      }
      try {
        const result = await tabs.ensure(threadId, true);
        switch (result.status) {
          case "created":
            return {
              exitCode: 0,
              stdout: `Lazygit tab added to thread ${threadId}. Open the thread's Lazygit panel tab to start it.`,
            };
          case "already-present":
            return {
              exitCode: 0,
              stdout: `Lazygit tab is already present on thread ${threadId}.`,
            };
          default:
            return { exitCode: 1, stderr: "Lazygit tab was not opened." };
        }
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `Failed to open Lazygit: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}