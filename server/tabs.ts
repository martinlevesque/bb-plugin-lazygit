// server/tabs.ts — the plugin-owned panel tab. The first time a thread is
// opened the plugin appends a `plugin-panel` tab (so the host can select it
// and replace the "New tab" launcher), updating the thread's tab list through
// the compare-and-swap revision API.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EnsureResult } from "./contract";
import { PANEL_ACTION_ID, PLUGIN_ID, TAB_ID, TAB_TITLE } from "./constants";
import type { PluginStateApi } from "./state";

export type TabEntry = {
  id: string;
  kind: string;
  pluginId?: string;
  actionId?: string;
  title?: string;
  paramsJson?: string | null;
  terminalId?: string;
};

// A thread's tab list starts at revision 0 and is initialized by the app on
// first view (writing its default thread-info / git-diff tabs). Appending
// before that write loses our tab to the app's initialization, so wait for
// it. Bounded: if the panel is never opened the revision stays 0 and we
// proceed anyway — the app's initializer no-ops once revision > 0.
const TAB_INIT_POLL_MS = 400;
const TAB_INIT_WAIT_MS = 15_000;
const CAS_MAX_ATTEMPTS = 5;

export function createTabManager(
  bb: BbPluginApi,
  deps: { state: PluginStateApi },
) {
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

  function isOurPanelTab(tab: TabEntry): boolean {
    return (
      tab.kind === "plugin-panel" &&
      tab.pluginId === PLUGIN_ID &&
      tab.actionId === PANEL_ACTION_ID
    );
  }

  async function waitForTabsInitialization(threadId: string): Promise<void> {
    const deadline = Date.now() + TAB_INIT_WAIT_MS;
    let current = await bb.sdk.threads.tabs.get({ threadId });
    while (current.revision === 0 && Date.now() < deadline) {
      await sleep(TAB_INIT_POLL_MS);
      current = await bb.sdk.threads.tabs.get({ threadId });
    }
  }

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
      const state = await deps.state.read();
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
        await deps.state.recordThread(threadId, record?.terminalId ?? null);
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
  function ensure(
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

  return { ensure, isOurPanelTab };
}

export type TabManager = ReturnType<typeof createTabManager>;