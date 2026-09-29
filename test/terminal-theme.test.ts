// test/terminal-theme.test.ts — unit tests for the bb-theme → xterm ITheme
// mapping in app/terminal-theme.ts: the lazygit screen must follow the
// terminal color contract bb themes declare (--sidebar / --foreground /
// --muted / --ansi-0…15), and undeclared variables must stay undefined so
// xterm falls back to its own defaults.
import { describe, expect, it } from "vitest";
import { buildTerminalTheme } from "../app/terminal-theme";

// bb's built-in dark palette, as declared in the app's stylesheet.
const BB_DARK_VARS: Record<string, string> = {
  "--sidebar": "#141414",
  "--foreground": "#e3e3dd",
  "--muted": "#404040",
  "--ansi-0": "#858585",
  "--ansi-1": "#d85e5e",
  "--ansi-2": "#0dbc79",
  "--ansi-3": "#e5e510",
  "--ansi-4": "#3c88dc",
  "--ansi-5": "#c85ac8",
  "--ansi-6": "#11a8cd",
  "--ansi-7": "#e5e5e5",
  "--ansi-8": "#9a9a9a",
  "--ansi-9": "#ff6f6f",
  "--ansi-10": "#23d18b",
  "--ansi-11": "#f5f543",
  "--ansi-12": "#5aaaf2",
  "--ansi-13": "#d670d6",
  "--ansi-14": "#29b8db",
  "--ansi-15": "#fff",
};

function readFrom(vars: Record<string, string>) {
  return (variable: string) => vars[variable];
}

describe("buildTerminalTheme", () => {
  it("maps the bb terminal variables onto xterm theme keys", () => {
    const theme = buildTerminalTheme(readFrom(BB_DARK_VARS));
    expect(theme).toEqual({
      background: "#141414",
      foreground: "#e3e3dd",
      cursor: "#e3e3dd",
      cursorAccent: "#141414",
      selectionBackground: "#404040",
      black: "#858585",
      red: "#d85e5e",
      green: "#0dbc79",
      yellow: "#e5e510",
      blue: "#3c88dc",
      magenta: "#c85ac8",
      cyan: "#11a8cd",
      white: "#e5e5e5",
      brightBlack: "#9a9a9a",
      brightRed: "#ff6f6f",
      brightGreen: "#23d18b",
      brightYellow: "#f5f543",
      brightBlue: "#5aaaf2",
      brightMagenta: "#d670d6",
      brightCyan: "#29b8db",
      brightWhite: "#fff",
    });
  });

  it("reads the ANSI slots in the standard 0-15 order", () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i <= 15; i++) vars[`--ansi-${i}`] = `ansi${i}`;
    const theme = buildTerminalTheme(readFrom(vars));
    expect(theme.black).toBe("ansi0");
    expect(theme.white).toBe("ansi7");
    expect(theme.brightBlack).toBe("ansi8");
    expect(theme.brightWhite).toBe("ansi15");
  });

  it("leaves undeclared variables undefined so xterm falls back", () => {
    const theme = buildTerminalTheme(() => undefined);
    expect(theme.background).toBeUndefined();
    expect(theme.foreground).toBeUndefined();
    expect(theme.selectionBackground).toBeUndefined();
    expect(theme.red).toBeUndefined();
    expect(theme.brightWhite).toBeUndefined();
  });

  it("tolerates a theme that declares only some ANSI slots", () => {
    const theme = buildTerminalTheme(
      readFrom({ "--foreground": "#abcdef", "--ansi-1": "#ff0000" }),
    );
    expect(theme.foreground).toBe("#abcdef");
    expect(theme.red).toBe("#ff0000");
    expect(theme.background).toBeUndefined();
    expect(theme.green).toBeUndefined();
  });
});
