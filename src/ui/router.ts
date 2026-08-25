import { useCallback, useEffect, useState } from "react";

/**
 * Path routing with no dependency, because the whole map is five screens and one detail page.
 *
 * Cloudflare serves this bundle for any path it does not have a file for, so a hard refresh on
 * /incidents/inc_123 arrives here rather than at a 404, and the back button works because the
 * history entries are real ones.
 */

export type Route =
  | { name: "deck" }
  | { name: "incidents" }
  | { name: "incident"; id: string }
  | { name: "runbooks" }
  | { name: "rota" }
  | { name: "demo" }
  | { name: "settings" }
  | { name: "missing"; path: string };

export function parseRoute(path: string): Route {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length === 0) return { name: "deck" };

  const [head, tail] = parts;
  if (head === "incidents") {
    if (parts.length === 1) return { name: "incidents" };
    if (parts.length === 2 && tail !== undefined)
      return { name: "incident", id: tail };
  }
  if (parts.length === 1) {
    if (head === "runbooks") return { name: "runbooks" };
    if (head === "rota") return { name: "rota" };
    if (head === "demo") return { name: "demo" };
    if (head === "settings") return { name: "settings" };
  }
  return { name: "missing", path };
}

export function useRoute(): [Route, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: string) => {
    window.history.pushState(null, "", next);
    setPath(next);
    // A screen reader stays where it was on a client-side navigation, so the new page's heading has
    // to be announced deliberately. Focusing the region is what does it.
    window.requestAnimationFrame(() => {
      document.getElementById("screen")?.focus();
    });
  }, []);

  return [parseRoute(path), go];
}
