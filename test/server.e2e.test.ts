// test/server.e2e.test.ts — end-to-end tests for the plugin backend.
//
// These tests load server.ts into the official fake plugin host
// (`@get-bb/plugin-sdk/testing`) and drive it the way the BB app would:
// every call goes through `harness.behavior.callRpc` / `runCli`, which apply
// the RPC contract's zod schemas and a strict JSON round-trip like the real
// wire. The `bb.sdk` surface the plugin depends on (thread tabs, terminals)
// is stubbed by a small in-memory "world" with the same compare-and-swap
// semantics as the host.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

type SdkOverrides = NonNullable<Parameters<typeof createFakePluginHost>[0]>["sdk"];

type TabRecord = {
  id: string;
  kind: string;
  pluginId?: string;
  actionId?: string;
  title?: string;
  paramsJson?: string | null;
  terminalId?: string;
};

type TerminalRecord = {
  id: string;
  scope: { kind: string; environmentId: string };
  cols: number;
  rows: number;
  title: string | undefined;
  command: string | null;
  status: string;
  exitCode: number | null;
};

const THREAD_ID = "th_e2e";
const ENVIRONMENT_ID = "env-e2e";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * A minimal in-memory stand-in for the parts of BB the plugin talks to:
 * per-thread tab lists with revision CAS, and environment terminal sessions.
 */
function createWorld() {
  const tabsByThread = new Map<string, { revision: number; tabs: TabRecord[] }>();
  const terminals = new Map<string, TerminalRecord>();
  const inputs: { terminalId: string; dataBase64: string }[] = [];
  let nextTerminalSeq = 1;

  function tabEntry(threadId: string) {
    let entry = tabsByThread.get(threadId);
    if (entry === undefined) {
      // The app initializes every thread with its default tabs (revision 1).
      entry = {
        revision: 1,
        tabs: [
          { id: "thread-info", kind: "thread-info" },
          { id: "git-diff", kind: "git-diff" },
        ],
      };
      tabsByThread.set(threadId, entry);
    }
    return entry;
  }

  const sdk: SdkOverrides = {
    threads: {
      get: async ({ threadId }) => ({ id: threadId, environmentId: ENVIRONMENT_ID }),
      tabs: {
        get: async ({ threadId }) => clone(tabEntry(threadId)),
        update: async ({ threadId, expectedRevision, tabs }) => {
          const entry = tabEntry(threadId);
          if (expectedRevision !== entry.revision) {
            throw Object.assign(new Error("tab list changed"), {
              code: "thread_tabs_conflict",
            });
          }
          entry.tabs = clone(tabs) as TabRecord[];
          entry.revision += 1;
          return { revision: entry.revision };
        },
      },
    },
    terminals: {
      create: async ({ scope, cols, rows, title, start }) => {
        const id = `term_${nextTerminalSeq}`;
        nextTerminalSeq += 1;
        const session: TerminalRecord = {
          id,
          scope: scope as TerminalRecord["scope"],
          cols,
          rows,
          title,
          command:
            start !== undefined && "command" in start
              ? (start.command ?? null)
              : null,
          status: "running",
          exitCode: null,
        };
        terminals.set(id, session);
        return clone(session);
      },
      get: async ({ terminalId }) => {
        const session = terminals.get(terminalId);
        if (session === undefined) throw new Error(`unknown terminal ${terminalId}`);
        return clone(session);
      },
      close: async ({ terminalId }) => {
        const session = terminals.get(terminalId);
        if (session !== undefined) {
          session.status = "exited";
          session.exitCode = 0;
        }
        return { ok: true };
      },
      resize: async ({ terminalId, cols, rows }) => {
        const session = terminals.get(terminalId);
        if (session !== undefined) {
          session.cols = cols;
          session.rows = rows;
        }
        return { ok: true };
      },
      input: async ({ terminalId, dataBase64 }) => {
        inputs.push({ terminalId, dataBase64 });
        return { ok: true };
      },
      output: async ({ terminalId }) => ({
        chunks: [
          {
            dataBase64: Buffer.from(`ui:${terminalId}`).toString("base64"),
            seq: 1,
          },
        ],
        nextSeq: 2,
        truncated: false,
      }),
    },
  };

  return {
    sdk,
    inputs,
    tabsFor: (threadId: string) => clone(tabEntry(threadId).tabs),
    terminal: (id: string) => {
      const session = terminals.get(id);
      return session === undefined ? undefined : clone(session);
    },
    terminalCount: () => terminals.size,
    /** Simulate the user closing the Lazygit panel tab in the app. */
    closeLazygitTab: (threadId: string) => {
      const entry = tabEntry(threadId);
      entry.tabs = entry.tabs.filter((tab) => tab.id !== "lazygit");
      entry.revision += 1;
    },
  };
}

async function setup() {
  const world = createWorld();
  const { bb, harness } = createFakePluginHost({
    pluginId: "lazygit",
    sdk: world.sdk,
  });
  await plugin(bb);
  return { world, harness };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("bb-plugin-lazygit backend e2e", () => {
  it("adds the Lazygit tab, then runs a persistent lazygit session over RPC", async () => {
    const { world, harness } = await setup();
    cleanup = () => harness.lifecycle.dispose();

    // 1. First open of the thread creates the plugin-owned panel tab.
    const ensured = (await harness.behavior.callRpc("ensure_lazygit_tab", {
      threadId: THREAD_ID,
    })) as { status: string };
    expect(ensured.status).toBe("created");
    expect(world.tabsFor(THREAD_ID)).toContainEqual({
      id: "lazygit",
      kind: "plugin-panel",
      pluginId: "lazygit",
      actionId: "lazygit",
      title: "Lazygit",
      paramsJson: null,
    });

    // 2. Ensuring again is a no-op while the tab is present.
    const again = (await harness.behavior.callRpc("ensure_lazygit_tab", {
      threadId: THREAD_ID,
    })) as { status: string };
    expect(again.status).toBe("already-present");

    // 3. Opening the tab attaches: one environment-scoped lazygit terminal.
    const attached = (await harness.behavior.callRpc("lazygit_attach", {
      threadId: THREAD_ID,
      cols: 80,
      rows: 24,
    })) as { terminalId: string; status: string; exitCode: number | null };
    expect(attached.terminalId).toBe("term_1");
    expect(attached.status).toBe("running");
    expect(attached.exitCode).toBeNull();

    const session = world.terminal(attached.terminalId);
    expect(session?.scope).toEqual({
      kind: "environment",
      environmentId: ENVIRONMENT_ID,
    });
    expect(session?.command).toBe("lazygit");
    expect(session?.title).toBe("Lazygit");

    // 4. Re-attaching reuses the live session instead of spawning another.
    const reattached = (await harness.behavior.callRpc("lazygit_attach", {
      threadId: THREAD_ID,
      cols: 120,
      rows: 40,
    })) as { terminalId: string };
    expect(reattached.terminalId).toBe(attached.terminalId);
    expect(world.terminalCount()).toBe(1);
    // ...and the session is resized to the panel's dimensions.
    expect(world.terminal(attached.terminalId)).toMatchObject({
      cols: 120,
      rows: 40,
    });

    // 5. Keystrokes flow to the session and screen output flows back.
    const typed = Buffer.from("q").toString("base64");
    const inputResult = (await harness.behavior.callRpc("lazygit_input", {
      terminalId: attached.terminalId,
      dataBase64: typed,
    })) as { ok: boolean };
    expect(inputResult.ok).toBe(true);
    expect(world.inputs).toEqual([
      { terminalId: attached.terminalId, dataBase64: typed },
    ]);

    const output = (await harness.behavior.callRpc("lazygit_output", {
      terminalId: attached.terminalId,
    })) as {
      chunks: { dataBase64: string; seq: number }[];
      nextSeq: number;
      truncated: boolean;
    };
    expect(output.truncated).toBe(false);
    expect(
      Buffer.from(output.chunks[0]?.dataBase64 ?? "", "base64").toString(),
    ).toBe(`ui:${attached.terminalId}`);

    const status = (await harness.behavior.callRpc("lazygit_status", {
      terminalId: attached.terminalId,
    })) as { status: string; exitCode: number | null };
    expect(status).toEqual({ status: "running", exitCode: null });
  });

  it("stays closed once the user closes the tab, unless forced", async () => {
    const { world, harness } = await setup();
    cleanup = () => harness.lifecycle.dispose();

    const created = (await harness.behavior.callRpc("ensure_lazygit_tab", {
      threadId: THREAD_ID,
    })) as { status: string };
    expect(created.status).toBe("created");

    // The user closes the tab: ensure must not resurrect it on later opens.
    world.closeLazygitTab(THREAD_ID);
    const suppressed = (await harness.behavior.callRpc("ensure_lazygit_tab", {
      threadId: THREAD_ID,
    })) as { status: string };
    expect(suppressed.status).toBe("suppressed");
    expect(
      world.tabsFor(THREAD_ID).some((tab) => tab.id === "lazygit"),
    ).toBe(false);

    // An explicit action (Actions row / bb lazygit) forces it back.
    const forced = (await harness.behavior.callRpc("ensure_lazygit_tab", {
      threadId: THREAD_ID,
      force: true,
    })) as { status: string };
    expect(forced.status).toBe("created");
    expect(
      world.tabsFor(THREAD_ID).some((tab) => tab.id === "lazygit"),
    ).toBe(true);
  });

  it("exposes the bb lazygit CLI command", async () => {
    const { world, harness } = await setup();
    cleanup = () => harness.lifecycle.dispose();

    // Without a thread in context (and no --thread) the command fails.
    const noThread = await harness.behavior.runCli([]);
    expect(noThread.exitCode).toBe(1);
    expect(noThread.stderr).toContain("No thread in context");

    // --help prints usage successfully.
    const help = await harness.behavior.runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb lazygit");

    // With a thread it force-adds the tab.
    const opened = await harness.behavior.runCli(["--thread", "th_cli"]);
    expect(opened.exitCode).toBe(0);
    expect(opened.stdout).toContain("th_cli");
    expect(
      world.tabsFor("th_cli").some((tab) => tab.id === "lazygit"),
    ).toBe(true);
  });
});
