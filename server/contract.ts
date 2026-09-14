// server/contract.ts — the RPC contract shared by the backend (which
// registers handlers) and the frontend (which calls them). Both sides route
// through these zod schemas, so the wire types live here alone and never
// drift between server.ts and app.tsx.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
      // A fresh session's replay tail contains its full init from seq 0.
      created: z.boolean(),
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
  lazygit_repo_state: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ isGitRepo: z.boolean() }),
  },
  lazygit_init_repo: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
});

export type EnsureStatus = "created" | "already-present" | "suppressed";
export type EnsureResult = { status: EnsureStatus };

export type AttachResult = {
  terminalId: string;
  status: string;
  exitCode: number | null;
  created: boolean;
};