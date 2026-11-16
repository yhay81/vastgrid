import type { Language } from "./app-prefs.ts";

/** Keep the grid and any unsaved edits open when someone visits the repository. */
export function GitHubLink({ language }: { language: Language }) {
  const label = language === "ja" ? "GitHub でスター" : "Star on GitHub";
  const title = language === "ja" ? "GitHub を新しいタブで開く" : "Open GitHub in a new tab";
  return (
    <a
      className="demo__github"
      href="https://github.com/yhay81/vastgrid"
      target="_blank"
      rel="noopener noreferrer"
      title={title}
    >
      <span aria-hidden="true">☆</span> {label}
    </a>
  );
}
