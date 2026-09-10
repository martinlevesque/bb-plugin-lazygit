// server/state.ts — the plugin's persistent state: one kv record mapping
// thread id to the tab/terminal bookkeeping for that thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** kv key holding per-thread records (tab creation + terminal session). */
const STATE_KEY = "threads";
/** Bound the kv record so long-lived installs do not grow it without limit. */
const STATE_MAX_THREADS = 500;

export type ThreadState = { terminalId: string | null; createdAt: number };
export type PluginState = { threads: Record<string, ThreadState> };

/**
 * Create the bounded per-thread record. `recordThread` is the single write
 * path both tab creation and session management use; `clearThreadTerminal`
 * closes and forgets a thread's session so a later attach starts fresh.
 */
export function createPluginState(bb: BbPluginApi) {
  async function read(): Promise<PluginState> {
    return (await bb.storage.kv.get<PluginState>(STATE_KEY)) ?? {
      threads: {},
    };
  }

  async function write(state: PluginState): Promise<void> {
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
    const state = await read();
    const existing = state.threads[threadId];
    state.threads[threadId] = {
      terminalId: terminalId ?? existing?.terminalId ?? null,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await write(state);
  }

  /** Close and forget the thread's recorded lazygit session, if any. */
  async function clearThreadTerminal(threadId: string): Promise<void> {
    const state = await read();
    const record = state.threads[threadId];
    if (record === undefined) return;
    if (record.terminalId != null) {
      await bb.sdk.terminals
        .close({ terminalId: record.terminalId, mode: "force" })
        .catch(() => {});
    }
    record.terminalId = null;
    await write(state);
  }

  return { read, write, recordThread, clearThreadTerminal };
}

export type PluginStateApi = ReturnType<typeof createPluginState>;