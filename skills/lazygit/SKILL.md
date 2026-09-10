---
name: lazygit
description: Open a lazygit terminal tab for the current bb thread. Use when the user asks to open lazygit, stage or commit changes interactively, or wants a git TUI for the thread's worktree.
---

# Lazygit

Every thread can have a **Lazygit** terminal tab in its right panel, running
lazygit in the thread's environment worktree. The plugin creates it
automatically the first time a thread is opened; the user may also have
closed it or quit lazygit since.

## Command

| Command | Effect |
| --- | --- |
| `bb lazygit` | Create (or restart) the Lazygit tab for the current thread. |
| `bb lazygit --thread <thread-id>` | Same, for an explicit thread. |

Run it without arguments from a thread context; the CLI resolves the current
thread automatically.

## Rules

- Run `bb lazygit` when the user asks for lazygit; do not try to start
  lazygit inside your own non-interactive shell — it is a full-screen TUI
  and will not work there.
- The command only prepares the tab. Tell the user to select the **Lazygit**
  tab in the thread's right panel to use it.
- A "not installed" style failure means the machine lacks lazygit; point the
  user to https://github.com/jesseduffield/lazygit#installation or the
  plugin's **Lazygit command** setting if the binary lives elsewhere.
