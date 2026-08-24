import { useCallback, useState } from "react";

export type Theme = "dark" | "light";

const KEY = "ringbolt-theme";

/**
 * The theme the document is already in. It is read off the element rather than worked out again,
 * because the inline script in index.html has already decided and painted, and a second opinion
 * here would be a flash of the wrong colours on every load.
 */
function current(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);

  const flip = useCallback(() => {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    setTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // The choice holds for this page view, which is better than refusing to switch at all.
    }
  }, []);

  return [theme, flip];
}
