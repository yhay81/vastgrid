/** Colors and fonts for the canvas, read from the CSS custom properties of the grid's root element. */
export interface GridTheme {
  font: string;
  headerFont: string;
  smallFont: string;
  fontSize: number;
  fontFamily: string;
  /** Height of each further line of wrapped cell text, in pixels. */
  lineHeight: number;
  background: string;
  text: string;
  muted: string;
  headerBackground: string;
  headerText: string;
  headerActive: string;
  gutterBackground: string;
  gutterText: string;
  gutterViewText: string;
  line: string;
  lineStrong: string;
  selection: string;
  selectionBorder: string;
  activeBorder: string;
  accent: string;
  nullText: string;
  placeholder: string;
  match: string;
  error: string;
  /** Text of cells whose `cellAction` is a link. */
  link: string;
}

const colorTokens: Record<
  keyof Omit<GridTheme, "font" | "headerFont" | "smallFont" | "fontSize" | "fontFamily" | "lineHeight">,
  string
> = {
  background: "--vg-bg",
  text: "--vg-fg",
  muted: "--vg-muted",
  headerBackground: "--vg-header-bg",
  headerText: "--vg-header-fg",
  headerActive: "--vg-header-active-bg",
  gutterBackground: "--vg-gutter-bg",
  gutterText: "--vg-gutter-fg",
  gutterViewText: "--vg-gutter-view-fg",
  line: "--vg-line",
  lineStrong: "--vg-line-strong",
  selection: "--vg-selection-bg",
  selectionBorder: "--vg-selection-border",
  activeBorder: "--vg-active-border",
  accent: "--vg-accent",
  nullText: "--vg-null-fg",
  placeholder: "--vg-placeholder",
  match: "--vg-match-bg",
  error: "--vg-error-fg",
  link: "--vg-link-fg",
};

/** Resolves the theme of `root`. Colors given as `light-dark()` or system colors resolve to concrete values. */
export function resolveTheme(root: HTMLElement): GridTheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.appendChild(probe);
  try {
    const color = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const style = getComputedStyle(root);
    const fontFamily = style.getPropertyValue("--vg-font-family").trim() || style.fontFamily || "system-ui, sans-serif";
    const fontSize =
      Number.parseFloat(style.getPropertyValue("--vg-font-size")) || Number.parseFloat(style.fontSize) || 13;
    const lineHeight = Number.parseFloat(style.getPropertyValue("--vg-line-height")) || Math.round(fontSize * 1.4);
    const colors = Object.fromEntries(Object.entries(colorTokens).map(([key, token]) => [key, color(token)])) as Pick<
      GridTheme,
      keyof typeof colorTokens
    >;
    return {
      ...colors,
      fontFamily,
      fontSize,
      lineHeight,
      font: `${fontSize}px ${fontFamily}`,
      headerFont: `600 ${fontSize}px ${fontFamily}`,
      smallFont: `${Math.max(9, fontSize - 2)}px ${fontFamily}`,
    };
  } finally {
    probe.remove();
  }
}

/** Reads a length custom property in pixels, or `fallback`. */
export function cssLength(root: HTMLElement, token: string, fallback: number) {
  const value = Number.parseFloat(getComputedStyle(root).getPropertyValue(token));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
