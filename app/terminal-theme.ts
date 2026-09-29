// app/terminal-theme.ts — maps the bb theme's terminal CSS variables onto
// xterm's ITheme. bb themes style terminals through --sidebar (background /
// cursor accent), --foreground (foreground / cursor), --muted (selection)
// and the --ansi-0…15 palette — the same variables bb's own terminal panel
// reads — so following them keeps the lazygit screen in sync with the
// selected bb theme, including custom and plugin-contributed themes.
import type { ITheme } from "@xterm/xterm";

// bb's terminal font stack when the theme sets no --font-terminal; the
// Nerd Font stacks lead because lazygit draws file-icon glyphs.
export const TERMINAL_FONT_FAMILY_FALLBACK =
  '"JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * Pure mapping: bb theme variable values → xterm ITheme. Keys left
 * `undefined` fall back to xterm defaults (xterm ignores missing or
 * unparsable entries), so a theme that declares no terminal colors at all
 * still works.
 */
export function buildTerminalTheme(
  read: (variable: string) => string | undefined,
): ITheme {
  const theme: ITheme = {
    background: read("--sidebar"),
    foreground: read("--foreground"),
    cursor: read("--foreground"),
    cursorAccent: read("--sidebar"),
    selectionBackground: read("--muted"),
  };
  ANSI_THEME_KEYS.forEach((key, index) => {
    theme[key] = read(`--ansi-${index}`);
  });
  return theme;
}

/**
 * Reads the theme variables in `element`'s scope (so panel-scoped overrides
 * apply) and normalizes them through a probe element: values such as
 * `color-mix(in oklch, …)` are valid CSS but not xterm colors — the probe's
 * computed `color` evaluates them to a form xterm parses. This is the same
 * normalization bb's own terminal panel applies.
 */
export function readTerminalTheme(element: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  try {
    return buildTerminalTheme((variable) => {
      const raw = getComputedStyle(element).getPropertyValue(variable).trim();
      if (raw === "") return undefined;
      probe.style.color = raw;
      if (probe.style.color === "") return undefined; // not a color token
      return getComputedStyle(probe).color || undefined;
    });
  } finally {
    probe.remove();
  }
}

export function readTerminalFontFamily(element: HTMLElement): string {
  const value = getComputedStyle(element)
    .getPropertyValue("--font-terminal")
    .trim();
  return value === "" ? TERMINAL_FONT_FAMILY_FALLBACK : value;
}
