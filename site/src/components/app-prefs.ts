import { useEffect, useState } from "react";

export type Theme = "auto" | "light" | "dark";
export type Language = "en" | "ja";

/** The theme Starlight stores, so that the documentation and standalone pages share it. */
const themeKey = "starlight-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(themeKey);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

/** Shared theme and language preferences for the standalone `/demo/` and `/open/` pages. */
export function useAppPrefs(pageLanguage: Language, paths: Record<Language, string>, titles: Record<Language, string>) {
  const [language, setLanguage] = useState<Language>(pageLanguage);
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) meta.content = theme === "auto" ? "light dark" : theme;
    document.documentElement.dataset.theme = theme;
    try {
      if (theme === "auto") localStorage.removeItem(themeKey);
      else localStorage.setItem(themeKey, theme);
    } catch {
      // Storage may be unavailable (private windows); the choice then lasts for this page.
    }
  }, [theme]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === themeKey || event.key === null) setTheme(readTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = titles[language];
  }, [language, titles]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    const url = new URL(location.href);
    url.pathname = paths[next];
    history.replaceState(null, "", url);
  };

  return { language, changeLanguage, theme, setTheme };
}
