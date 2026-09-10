// server/repo.ts — git repository handling for environments that are not a
// repo yet. The panel checks before attaching so lazygit never shows its raw
// "not a git repository" prompt; the user can instead initialize a repo from
// the panel, which runs `git init` here.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Environment } from "./env";
import type { PluginStateApi } from "./state";

export function createRepo(
  bb: BbPluginApi,
  deps: { env: Environment; state: PluginStateApi },
) {
  async function environmentIsGitRepo(environmentId: string): Promise<boolean> {
    // Never trust bb's Environment.isGitRepo: it is a provision-time snapshot
    // that goes stale in both directions (a later `git init` does not set it,
    // and it stays true after the repo is deleted). Ask git itself.
    const exitCode = await deps.env.runEnvironmentCommand(
      environmentId,
      "git rev-parse --is-inside-work-tree",
      "git repo check",
    );
    return exitCode === 0;
  }

  async function initRepo(threadId: string): Promise<{ ok: boolean }> {
    const environmentId = await deps.env.threadEnvironmentId(threadId);
    if (await environmentIsGitRepo(environmentId)) return { ok: true };
    const exitCode = await deps.env.runEnvironmentCommand(
      environmentId,
      "git init",
      "git init",
    );
    if (exitCode !== 0) {
      throw new Error("`git init` failed in the thread's environment.");
    }
    return { ok: true };
  }

  return { environmentIsGitRepo, initRepo };
}

export type Repo = ReturnType<typeof createRepo>;