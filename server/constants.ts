// server/constants.ts — identity strings shared across the backend modules.
// The plugin-id/tab/action/terminal ids all use "lazygit" so a record stored
// by any name (tab entry, kv state) can be recognized from any module.

export const PLUGIN_ID = "lazygit";
export const PANEL_ACTION_ID = "lazygit";
export const TAB_TITLE = "Lazygit";
export const TERMINAL_TITLE = "Lazygit";

// Legacy pre-0.2 native terminal tab id (still matched during migration).
export const LEGACY_TERMINAL_TAB_ID = "lazygit";

// The id bb's host app derives for a plugin-panel tab record
// (`plugin-panel:<pluginId>:<actionId>:<params>`, each segment
// encodeURIComponent-escaped). The plugin writes the same id so bb's
// per-thread panel-state reconciliation keeps the tab's active selection
// when you navigate away from a thread and back; a different id makes bb
// treat the records as different tabs and fall back to thread-info.
export const PLUGIN_PANEL_TAB_ID = `plugin-panel:${encodeURIComponent(
  `${PLUGIN_ID}:${PANEL_ACTION_ID}:`,
)}:none`;