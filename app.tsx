// bb-plugin-lazygit — a BB plugin frontend entry.
//
// Composes the submodules in app/: wires the three surfaces — the app-wide
// auto-open overlay (app/components/auto-open-overlay.tsx), the thread
// panel's Actions-list row, and the xterm.js tab body
// (app/components/lazygit-panel.tsx) — all backed by the RPC contract in
// server/contract.ts.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";
import { AutoOpenOverlay } from "./app/components/auto-open-overlay";
import { LazygitPanel } from "./app/components/lazygit-panel";
import { ensureLazygit } from "./app/rpc-store";

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