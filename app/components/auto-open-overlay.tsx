// app/components/auto-open-overlay.tsx — mounted once per app window; owns
// the on-thread-open auto creation of the Lazygit tab, and publishes the RPC
// client for the thread-panel action (see app/rpc-store.ts).
import { useEffect, useRef } from "react";
import { useBbContext, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server/contract";
import { clearSharedRpc, ensureLazygit, setSharedRpc } from "../rpc-store";

export function AutoOpenOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId } = useBbContext();
  const { values } = useSettings();
  // One attempt per thread per window session. A failure removes the marker
  // so the next navigation retries (e.g. environment still provisioning).
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    setSharedRpc(rpc);
    return () => {
      clearSharedRpc(rpc);
    };
  }, [rpc]);

  useEffect(() => {
    if (threadId === null) return;
    if (values === undefined) return; // settings still loading
    if (values.autoOpen === false) return;
    if (attempted.current.has(threadId)) return;
    attempted.current.add(threadId);
    ensureLazygit(threadId, false).catch((cause: unknown) => {
      attempted.current.delete(threadId);
      console.warn(
        `[lazygit] could not create the tab for ${threadId}:`,
        cause instanceof Error ? cause.message : cause,
      );
    });
  }, [threadId, values, rpc]);

  return null;
}