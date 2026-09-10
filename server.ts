// bb-plugin-lazygit — a BB plugin backend entry.
//
// Auto-creates a "Lazygit" panel tab in a thread's right panel the first time
// the thread is opened — like the built-in Thread Info and Diff tabs. The tab
// is plugin-owned (a `plugin-panel` tab) so the host can select it and replace
// the "New tab" launcher when the user picks Lazygit from the panel's Actions
// list; the actual lazygit process runs in a persistent environment-scoped
// terminal session that the frontend panel attaches to over RPC (xterm.js).
//
// Session creation is lazy: the tab is cheap and appears on first view, the
// lazygit process starts when the tab is first activated.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// TerminalSession is not a root export; derive it from the SDK area type.
type TerminalSession = Awaited<
  ReturnType<BbPluginApi["sdk"]["terminals"]["get"]>
>;

/** Identity of the plugin-owned panel tab in a thread's tab list. */
const PLUGIN_ID = "lazygit";
const PANEL_ACTION_ID = "lazygit";
const TAB_ID = "lazygit";
const TAB_TITLE = "Lazygit";
const TERMINAL_TITLE = "Lazygit";
/** kv key holding per-thread records (tab creation + terminal session). */
const STATE_KEY = "threads";
/** Bound the kv record so long-lived installs do not grow it without limit. */
const STATE_MAX_THREADS = 500;
/** Bytes of scrollback replayed when a panel (re)attaches to a live session. */
const REPLAY_TAIL_BYTES = 128 * 1024;

export const rpcContract = defineRpcContract({
  ensure_lazygit_tab: {
    input: z.object({
      threadId: z.string().min(1),
      // force bypasses the user-closed-tab suppression (Actions row, CLI).
      force: z.boolean().optional(),
    }),
    output: z.object({
      status: z.enum(["created", "already-present", "suppressed"]),
    }),
  },
  lazygit_attach: {
    input: z.object({
      threadId: z.string().min(1),
      cols: z.number().int().min(2),
      rows: z.number().int().min(2),
    }),
    output: z.object({
      terminalId: z.string(),
      status: z.string(),
      exitCode: z.number().nullable(),
    }),
  },
  lazygit_output: {
    input: z.object({
      terminalId: z.string().min(1),
      sinceSeq: z.number().int().nonnegative().optional(),
      tailBytes: z.number().int().positive().optional(),
    }),
    output: z.object({
      chunks: z.array(z.object({ dataBase64: z.string(), seq: z.number() })),
      nextSeq: z.number(),
      truncated: z.boolean(),
    }),
  },
  lazygit_input: {
    input: z.object({
      terminalId: z.string().min(1),
      dataBase64: z.string(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  lazygit_resize: {
    input: z.object({
      terminalId: z.string().min(1),
      cols: z.number().int().min(2),
      rows: z.number().int().min(2),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  lazygit_status: {
    input: z.object({ terminalId: z.string().min(1) }),
    output: z.object({
      status: z.string(),
      exitCode: z.number().nullable(),
    }),
  },
});

type EnsureStatus = "created" | "already-present" | "suppressed";
export type EnsureResult = { status: EnsureStatus };

type ThreadState = { terminalId: string | null; createdAt: number };
type PluginState = { threads: Record<string, ThreadState> };

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

  async function readState(): Promise<PluginState> {
    return (await bb.storage.kv.get<PluginState>(STATE_KEY)) ?? {
      threads: {},
    };
  }
  async function writeState(state: PluginState): Promise<void> {
    // FIFO-trim oldest entries to keep the record bounded.
    const ids = Object.keys(state.threads);
    if (ids.length > STATE_MAX_THREADS) {
      ids
        .sort((a, b) => state.threads[a].createdAt - state.threads[b].createdAt)
        .slice(0, ids.length - STATE_MAX_THREADS)
        .forEach((id) => delete state.threads[id]);
    }
    await bb.storage.kv.set(STATE_KEY, state);
  }
  async function recordThread(
    threadId: string,
    terminalId: string | null,
  ): Promise<void> {
    const state = await readState();
    const existing = state.threads[threadId];
    state.threads[threadId] = {
      terminalId: terminalId ?? existing?.terminalId ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await writeState(state);
  }

  function isAlive(session: TerminalSession): boolean {
    return (
      session.status === "starting" ||
      session.status === "running" ||
      session.status === "disconnected"
    );
  }

  function isOurPanelTab(tab: {
    kind: string;
    pluginId?: string;
    actionId?: string;
  }): boolean {
    return (
      tab.kind === "plugin-panel" &&
      tab.pluginId === PLUGIN_ID &&
      tab.actionId === PANEL_ACTION_ID
    );
  }

  // ---------------------------------------------------------------------
  // Tab management (ensure)
  // ---------------------------------------------------------------------

  type TabEntry = {
    id: string;
    kind: string;
    pluginId?: string;
    actionId?: string;
    title?: string;
    paramsJson?: string | null;
    terminalId?: string;
  };

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isTabsConflict(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "thread_tabs_conflict"
    );
  }

  // A thread's tab list starts at revision 0 and is initialized by the app on
  // first view (writing its default thread-info / git-diff tabs). Appending
  // before that write loses our tab to the app's initialization, so wait for
  // it. Bounded: if the panel is never opened the revision stays 0 and we
  // proceed anyway — the app's initializer no-ops once revision > 0.
  const TAB_INIT_POLL_MS = 400;
  const TAB_INIT_WAIT_MS = 15_000;
  async function waitForTabsInitialization(threadId: string): Promise<void> {
    const deadline = Date.now() + TAB_INIT_WAIT_MS;
    let current = await bb.sdk.threads.tabs.get({ threadId });
    while (current.revision === 0 && Date.now() < deadline) {
      await sleep(TAB_INIT_POLL_MS);
      current = await bb.sdk.threads.tabs.get({ threadId });
    }
  }

  const CAS_MAX_ATTEMPTS = 5;
  async function doEnsure(
    threadId: string,
    force: boolean,
  ): Promise<EnsureResult> {
    await waitForTabsInitialization(threadId);
    let lastError: unknown;
    // The tabs update is compare-and-swap on revision; retry with backoff
    // when another writer (the app, another plugin) changes the list first.
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const tabs = current.tabs as unknown as TabEntry[];
      const state = await readState();
      const record = state.threads[threadId];

      const hasPanel = tabs.some(isOurPanelTab);
      // Pre-0.2 versions used a native terminal tab; migrate it in place.
      const legacy = tabs.find(
        (tab) =>
          tab.kind === "terminal" &&
          (tab.id === TAB_ID ||
            (record?.terminalId != null &&
              tab.terminalId === record.terminalId)),
      );

      if (hasPanel && legacy === undefined) {
        return { status: "already-present" };
      }
      if (!hasPanel && legacy === undefined && !force && record !== undefined) {
        // We created this tab before and it is gone: the user closed it.
        return { status: "suppressed" };
      }

      const nextTabs: TabEntry[] = tabs.filter((tab) => tab !== legacy);
      if (!hasPanel) {
        nextTabs.push({
          id: TAB_ID,
          kind: "plugin-panel",
          pluginId: PLUGIN_ID,
          actionId: PANEL_ACTION_ID,
          title: TAB_TITLE,
          paramsJson: null,
        });
      }
      try {
        await bb.sdk.threads.tabs.update({
          threadId,
          expectedRevision: current.revision,
          tabs: nextTabs as never,
        });
      } catch (error) {
        if (!isTabsConflict(error)) throw error;
        lastError = error;
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (legacy !== undefined && legacy.terminalId !== undefined) {
        // The old thread-scoped session is superseded by lazy attach.
        await bb.sdk.terminals
          .close({ terminalId: legacy.terminalId, mode: "force" })
          .catch(() => {});
      }
      if (!hasPanel) {
        await recordThread(threadId, record?.terminalId ?? null);
        bb.log.info(`created lazygit tab for thread ${threadId}`);
      }
      return { status: hasPanel ? "already-present" : "created" };
    }
    throw new Error(
      `Could not update thread tabs after retries: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  // Deduplicate concurrent calls per thread (overlay + CLI + panel action can
  // race on one view).
  const inflightEnsure = new Map<string, Promise<EnsureResult>>();
  function ensureLazygitTab(
    threadId: string,
    force: boolean,
  ): Promise<EnsureResult> {
    const pending = inflightEnsure.get(threadId);
    if (pending !== undefined) return pending;
    const run = doEnsure(threadId, force).finally(() => {
      inflightEnsure.delete(threadId);
    });
    inflightEnsure.set(threadId, run);
    return run;
  }

  // ---------------------------------------------------------------------
  // Terminal session (lazy, environment-scoped so bb's native terminal-tab
  // auto-lister never shows a duplicate in the thread panel)
  // ---------------------------------------------------------------------

  type AttachResult = {
    terminalId: string;
    status: string;
    exitCode: number | null;
  };

  async function doAttach(
    threadId: string,
    cols: number,
    rows: number,
  ): Promise<AttachResult> {
    const state = await readState();
    const record = state.threads[threadId];
    if (record?.terminalId != null) {
      const existing = await bb.sdk.terminals
        .get({ terminalId: record.terminalId })
        .catch(() => null);
      if (existing !== null && isAlive(existing)) {
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
      if (existing !== null) {
        await bb.sdk.terminals
          .close({ terminalId: existing.id, mode: "force" })
          .catch(() => {});
      }
    }

    const thread = await bb.sdk.threads.get({ threadId });
    const environmentId = (
      thread as { environmentId?: string | null }
    ).environmentId;
    if (environmentId == null || environmentId === "") {
      throw new Error(
        "The thread's environment is not ready yet. Retry in a moment.",
      );
    }
    const session = await bb.sdk.terminals.create({
      scope: { kind: "environment", environmentId },
      cols,
      rows,
      title: TERMINAL_TITLE,
      start: { mode: "command", command },
    });
    await recordThread(threadId, session.id);
    bb.log.info(
      `started lazygit session ${session.id} for thread ${threadId} (env ${environmentId})`,
    );
    return {
      terminalId: session.id,
      status: session.status,
      exitCode: session.exitCode,
    };
  }

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

  bb.rpc.register(rpcContract, {
    ensure_lazygit_tab: ({ threadId, force }) =>
      ensureLazygitTab(threadId, force === true),
    lazygit_attach: ({ threadId, cols, rows }) => attach(threadId, cols, rows),
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
        const result = await ensureLazygitTab(threadId, true);
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
