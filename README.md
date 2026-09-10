# bb-plugin-lazygit

A BB plugin that auto-creates a **Lazygit** tab in every thread you open —
like the built-in Thread Info and Diff tabs — running
[lazygit](https://github.com/jesseduffield/lazygit) in the thread's worktree.

- `server.ts` — the thin backend entry: reads the settings and wires the RPC
  contract and the `bb lazygit` CLI command to the submodules in `server/`.
  The logic lives in `server/contract.ts` (the RPC contract shared with the
  frontend), `server/tabs.ts` (appending the plugin-owned panel tab through
  the compare-and-swap `bb.sdk.threads.tabs` API), `server/terminal.ts` (the
  persistent environment-scoped lazygit session: `attach` / `input` /
  `output` / `resize` / `status`), `server/repo.ts` (`repo_state` /
  `init_repo` for environments that are not git repositories), plus
  `server/state.ts` (bounded per-thread kv records) and `server/env.ts`
  (thread→environment and throwaway command helpers). The `autoOpen` /
  `command` settings live here too.
- `app.tsx` — the thin frontend entry: `app.slots.experimental_appOverlay`
  and the **Lazygit** row in the thread panel's Actions list
  (`app.slots.threadPanelAction`, host-native select-on-open via
  `openPanel`), delegating to the submodules in `app/`: the auto-open
  overlay (`app/components/auto-open-overlay.tsx`), the xterm.js tab body
  (`app/components/lazygit-panel.tsx` + the `use-lazygit-terminal` hook that
  bridges the terminal to the session over RPC), and the shared RPC client
  (`app/rpc-store.ts`). `lib/base64.ts` holds the wire codec both sides use.
- `skills/lazygit/SKILL.md` — a skill that tells agents to open lazygit with
  `bb lazygit`. BB imports it into agent threads automatically.
- `PLUGIN_OVERVIEW.md` — the store listing text: a longer version of
  `bb.description` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

The tab is plugin-owned (a `plugin-panel` tab) rather than a native terminal
tab on purpose: bb gives plugins no API to select a native terminal tab or
dismiss the "New tab" launcher, while `openPanel` does both for plugin
panels. The lazygit process starts lazily the first time the tab is
activated. If the thread's environment is not a git repository, lazygit is
never started; the tab shows a panel offering to `git init` the folder
instead.

Try it: install the plugin, open any thread — a **Lazygit** tab appears in
the right panel's tab strip. Closing the tab is respected (it stays closed
for that thread); use the Actions list or `bb lazygit` to reopen it.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins them alongside the SDK. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.4.47`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload lazygit
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config lazygit
bb plugin config lazygit set autoOpen false     # no auto tab on thread open
bb plugin config lazygit set command lazygit    # binary/path to run
bb plugin reload lazygit
```

Settings are read once per load, so reload after changing them.

## Tests

`test/server.e2e.test.ts` drives the backend end-to-end: it loads `server.ts`
into the fake plugin host from `@get-bb/plugin-sdk/testing` and exercises
the `ensure_lazygit_tab` / `lazygit_*` RPCs and the `bb lazygit` CLI through
their wire contract, against an in-memory stand-in for the thread-tabs and
terminal `bb.sdk` surfaces.

```
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.4.47` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
