import { type ReactNode, useCallback, useState } from "react";
import type { SessionView } from "../domain/view.js";
import { ApiError, get, rememberToken, storedToken } from "./api.js";
import { TextField } from "./parts/fields.js";
import { Nothing, Waiting, Wrong } from "./parts/states.js";
import { usePoll } from "./poll.js";
import { type Route, useRoute } from "./router.js";
import { Deck } from "./screens/deck.js";
import { Demo } from "./screens/demo.js";
import { Incident } from "./screens/incident.js";
import { Incidents } from "./screens/incidents.js";
import { Rota } from "./screens/rota.js";
import { Runbooks } from "./screens/runbooks.js";
import { Settings } from "./screens/settings.js";
import { useTheme } from "./theme.js";

const PAGES = [
  { path: "/", label: "Deck", name: "deck" },
  { path: "/incidents", label: "Incidents", name: "incidents" },
  { path: "/runbooks", label: "Runbooks", name: "runbooks" },
  { path: "/rota", label: "Rota", name: "rota" },
  { path: "/demo", label: "Demo", name: "demo" },
  { path: "/settings", label: "Settings", name: "settings" },
] as const;

export function App(): ReactNode {
  const [route, go] = useRoute();
  const [held, setHeld] = useState(storedToken());
  const session = usePoll<SessionView>(() => get("/api/session"), null);

  const signOut = useCallback(() => setHeld(null), []);

  if (session.status === "loading") return <Waiting what="the deployment" />;
  if (session.status === "failed")
    return <Wrong error={session.error} again={session.again} />;

  const mode = session.value.admin;
  if (mode === "unavailable") return <Unavailable />;
  if (mode === "token" && held === null)
    return (
      <Gate
        onHeld={(token) => {
          rememberToken(token);
          setHeld(token);
        }}
      />
    );

  return (
    <div className={route.name === "deck" ? "shell pinned" : "shell"}>
      <a className="skip" href="#screen">
        Skip to the board
      </a>
      <Rail route={route} go={go} session={session.value} />
      <Screen route={route} go={go} session={session.value} signOut={signOut} />
    </div>
  );
}

function Rail({
  route,
  go,
  session,
}: {
  route: Route;
  go: (path: string) => void;
  session: SessionView;
}): ReactNode {
  const [theme, flip] = useTheme();

  return (
    <header className="rail">
      <a
        className="mark"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          go("/");
        }}
      >
        ring<b>bolt</b>
      </a>
      <nav aria-label="Screens">
        {PAGES.map((page) => (
          <a
            key={page.path}
            href={page.path}
            aria-current={route.name === page.name ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              go(page.path);
            }}
          >
            {page.label}
          </a>
        ))}
      </nav>
      <div className="trailing">
        {/* One badge, not two. On the public demo the stand-in is implied: that
            deployment refuses to start in live mode at all. */}
        {session.admin === "demo" ? (
          <span
            className="label"
            title="Read only, and no call can reach a telephone"
          >
            PUBLIC DEMO
          </span>
        ) : (
          session.calleMode === "fake" && (
            <span className="label" title="No call can reach a telephone">
              STAND-IN
            </span>
          )
        )}
        <button
          type="button"
          className="btn quiet"
          onClick={flip}
          aria-pressed={theme === "light"}
        >
          {theme === "dark" ? "Day" : "Night"}
        </button>
      </div>
    </header>
  );
}

function Screen({
  route,
  go,
  session,
  signOut,
}: {
  route: Route;
  go: (path: string) => void;
  session: SessionView;
  signOut: () => void;
}): ReactNode {
  const deck = route.name === "deck";
  return (
    <main
      id="screen"
      // Focusable so a client-side navigation can move a screen reader to the
      // new screen, and so the skip link lands somewhere.
      tabIndex={-1}
      className={deck ? "board" : "page"}
    >
      {route.name === "deck" && <Deck go={go} />}
      {route.name === "incidents" && <Incidents go={go} />}
      {route.name === "incident" && <Incident id={route.id} />}
      {route.name === "runbooks" && <Runbooks />}
      {route.name === "rota" && <Rota />}
      {route.name === "demo" && <Demo go={go} session={session} />}
      {route.name === "settings" && (
        <Settings session={session} onSignOut={signOut} />
      )}
      {route.name === "missing" && <Missing path={route.path} go={go} />}
    </main>
  );
}

function Missing({
  path,
  go,
}: {
  path: string;
  go: (path: string) => void;
}): ReactNode {
  return (
    <Nothing heading="There is no screen at that address">
      Nothing answers to <code>{path}</code>.{" "}
      <button type="button" className="btn quiet" onClick={() => go("/")}>
        Back to the deck
      </button>
    </Nothing>
  );
}

/**
 * The one thing this build cannot fix from the browser: outside development, every configuration
 * and audit route refuses to serve at all until the deployment has an ADMIN_TOKEN. Saying so is
 * better than a 503 behind a spinner.
 */
function Unavailable(): ReactNode {
  return (
    <div className="gate">
      <h1>This deployment has no administrator token</h1>
      <p>
        Outside development, Ringbolt refuses to serve its configuration and
        audit routes until ADMIN_TOKEN is set, which fails closed rather than
        leaving an open door nobody notices. Set it with
        <code> wrangler secret put ADMIN_TOKEN</code> and deploy again.
      </p>
    </div>
  );
}

function Gate({ onHeld }: { onHeld: (token: string) => void }): ReactNode {
  const [token, setToken] = useState("");
  const [wrong, setWrong] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setWrong(null);
    // Kept only once it has been shown to work. A token that goes straight into storage means the
    // next screen is the one that fails, and an operator debugging a board at 3am should not be
    // guessing whether they mistyped.
    rememberToken(token);
    try {
      await get("/api/audit/board");
      onHeld(token);
    } catch (error) {
      rememberToken(null);
      setWrong(
        error instanceof ApiError
          ? error
          : new ApiError(0, "that could not be checked"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="gate" onSubmit={submit}>
      <h1>Ringbolt</h1>
      <p>
        This deployment wants its administrator token before it shows you the
        board. It is the ADMIN_TOKEN secret, and it is kept for this tab only.
      </p>
      <TextField
        label="ADMINISTRATOR TOKEN"
        type="password"
        value={token}
        onChange={setToken}
        wrong={wrong === null ? undefined : wrong.message}
      />
      <button className="btn primary" type="submit" disabled={busy}>
        Open the board
      </button>
    </form>
  );
}
