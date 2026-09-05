import type { CSSProperties } from "react";
import type { ThemeId } from "../types";

type ThemePalette = {
  surface: string;
  surfaceRaised: string;
  surfaceHover: string;
  line: string;
  ink: string;
  inkDim: string;
  inkFaint: string;
  accent: string;
  accentDim: string;
};

export type ThemeDefinition = {
  id: ThemeId;
  name: string;
  description: string;
  palette: ThemePalette;
};

/**
 * Built-in palettes. They all keep the chat surface dark enough for the
 * backend's resolved Twitch username colors; the rest of the chrome can use
 * stronger tints because usernames are never drawn there.
 */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "twitch",
    name: "Twitch",
    description: "Classic purple",
    palette: {
      surface: "#0b0b0f",
      surfaceRaised: "#121218",
      surfaceHover: "#16161d",
      line: "#23232d",
      ink: "#ededf2",
      inkDim: "#9a9aa6",
      inkFaint: "#6a6a76",
      accent: "#a970ff",
      accentDim: "#7d4fd1",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep indigo",
    palette: {
      surface: "#080b15",
      surfaceRaised: "#0e1424",
      surfaceHover: "#151d30",
      line: "#26324a",
      ink: "#eef2ff",
      inkDim: "#a5aec4",
      inkFaint: "#6d7892",
      accent: "#829dff",
      accentDim: "#5975d6",
    },
  },
  {
    id: "lagoon",
    name: "Lagoon",
    description: "Cool teal",
    palette: {
      surface: "#071112",
      surfaceRaised: "#0c1b1d",
      surfaceHover: "#122629",
      line: "#203b3f",
      ink: "#e8f5f3",
      inkDim: "#9cb9b5",
      inkFaint: "#668986",
      accent: "#49d9c8",
      accentDim: "#289e93",
    },
  },
  {
    id: "evergreen",
    name: "Evergreen",
    description: "Quiet forest",
    palette: {
      surface: "#08110c",
      surfaceRaised: "#0e1c14",
      surfaceHover: "#15271c",
      line: "#29402f",
      ink: "#edf5ef",
      inkDim: "#a1b7a6",
      inkFaint: "#6b8a72",
      accent: "#75d990",
      accentDim: "#479b5e",
    },
  },
  {
    id: "ember",
    name: "Ember",
    description: "Warm copper",
    palette: {
      surface: "#130b08",
      surfaceRaised: "#21120d",
      surfaceHover: "#2d1912",
      line: "#472b20",
      ink: "#f8eee8",
      inkDim: "#c2a79b",
      inkFaint: "#8d7266",
      accent: "#ff9365",
      accentDim: "#cc6038",
    },
  },
  {
    id: "sakura",
    name: "Sakura",
    description: "Soft rose",
    palette: {
      surface: "#120811",
      surfaceRaised: "#20101d",
      surfaceHover: "#2c1728",
      line: "#47283f",
      ink: "#f8edf5",
      inkDim: "#c0a4b8",
      inkFaint: "#8b7084",
      accent: "#f58bc8",
      accentDim: "#bf568f",
    },
  },
];

const THEME_IDS = new Set<string>(THEMES.map((theme) => theme.id));
const THEMES_BY_ID = Object.fromEntries(THEMES.map((theme) => [theme.id, theme])) as Record<
  ThemeId,
  ThemeDefinition
>;

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

type ThemeStyle = CSSProperties & Record<`--color-${string}`, string>;

/** Apply one palette to any subtree, including the miniature settings previews. */
export function themeStyle(id: ThemeId): ThemeStyle {
  const palette = THEMES_BY_ID[id].palette;
  return {
    "--color-surface": palette.surface,
    "--color-surface-raised": palette.surfaceRaised,
    "--color-surface-hover": palette.surfaceHover,
    "--color-line": palette.line,
    "--color-ink": palette.ink,
    "--color-ink-dim": palette.inkDim,
    "--color-ink-faint": palette.inkFaint,
    "--color-accent": palette.accent,
    "--color-accent-dim": palette.accentDim,
  };
}
