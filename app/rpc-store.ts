// app/rpc-store.ts — the app-wide RPC client, published by the overlay on
// mount so the thread-panel action's `run` (not a React context) can call it.
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { EnsureResult, rpcContract } from "../server/contract";

export type Rpc = PluginRpcClient<typeof rpcContract>;

let sharedRpc: Rpc | null = null;

/** Overlay: publish the mounted client. */
export function setSharedRpc(rpc: Rpc): void {
  sharedRpc = rpc;
}

/** Overlay: unpublish when unmounting, unless a newer client took over. */
export function clearSharedRpc(rpc: Rpc): void {
  if (sharedRpc === rpc) sharedRpc = null;
}

export function ensureLazygit(
  threadId: string,
  force: boolean,
): Promise<EnsureResult> {
  if (sharedRpc === null) return Promise.reject(new Error("not ready"));
  return force
    ? sharedRpc.call("ensure_lazygit_tab", { threadId, force: true })
    : sharedRpc.call("ensure_lazygit_tab", { threadId });
}