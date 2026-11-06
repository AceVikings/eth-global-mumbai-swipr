import { useEffect, useState } from "react";
import type { Ghost, Trader } from "../shared/types";
import Discover from "./components/Discover";
import Ghosts from "./components/Ghosts";
import PassSetup from "./components/PassSetup";
import { Icon } from "./components/Icons";
import { loadGhosts, saveGhosts, startGhost, removeGhost } from "./lib/ghosts";
import { previewTraders } from "./fixtures";

type Page = "discover" | "ghosts" | "matches" | "you";
const pages: Page[] = ["discover", "ghosts", "matches", "you"];
function currentPage(): Page {
  const hash = location.hash.slice(1);
  return pages.includes(hash as Page) ? (hash as Page) : "discover";
}
function readPrefs(): { amount: number; vibe: string } {
  try {
    const prefs = JSON.parse(
      localStorage.getItem("swipr.preferences.v1") ?? "{}",
    );
    return {
      amount:
        Number.isInteger(prefs.amount) &&
        prefs.amount >= 5 &&
        prefs.amount <= 50
          ? prefs.amount
          : 10,
      vibe: ["All", "Steady", "Balanced", "Spicy"].includes(prefs.vibe)
        ? prefs.vibe
        : "All",
    };
  } catch {
    return { amount: 10, vibe: "All" };
  }
}
export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [ghosts, setGhosts] = useState<Ghost[]>(() => loadGhosts());
  const [prefs, setPrefs] = useState(readPrefs);
  const [realTrader, setRealTrader] = useState<Trader | null>(null);
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [mode, setMode] = useState<"preview" | "live">("preview");
  useEffect(() => {
    const onHash = () => {
      setPage(currentPage());
      setRealTrader(null);
    };
    const onOnline = () => setOnline(navigator.onLine);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOnline);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOnline);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  const navigate = (next: Page) => {
    location.hash = next;
    setPage(next);
    setRealTrader(null);
    window.scrollTo(0, 0);
  };
  const persistGhosts = (next: Ghost[]) => {
    setGhosts(next);
    if (!saveGhosts(next))
      setNotice(
        "Browser storage is unavailable. Your ghosts will last for this visit only.",
      );
  };
  const ghost = (trader: Trader) => {
    const existing = ghosts.some((g) => g.traderId === trader.id);
    const next = startGhost(ghosts, trader.id, prefs.amount);
    setNotice(
      existing
        ? `${trader.name} is already in your ghosts. Original start time kept.`
        : `Ghost-copying ${trader.name} · $${prefs.amount}/trade · no funds moved.`,
    );
    persistGhosts(next);
  };
  const updatePrefs = (amount: number, vibe: string) => {
    const next = { amount, vibe };
    setPrefs(next);
    try {
      localStorage.setItem("swipr.preferences.v1", JSON.stringify(next));
    } catch {
      setNotice(
        "Preferences changed for this visit. Browser storage is unavailable.",
      );
    }
  };
  const traders =
    mode === "preview"
      ? previewTraders.filter(
          (t) => prefs.vibe === "All" || t.style === prefs.vibe,
        )
      : [];
  const nav = (
    <nav aria-label="Main navigation">
      {pages.map((p) => (
        <button
          key={p}
          aria-current={page === p ? "page" : undefined}
          className={page === p ? "selected" : ""}
          onClick={() => navigate(p)}
        >
          <Icon name={p} size={22} />
          <span>
            {p === "ghosts" ? "Ghosts" : p[0].toUpperCase() + p.slice(1)}
          </span>
          {p === "ghosts" && ghosts.length > 0 && (
            <small>{ghosts.length}</small>
          )}
        </button>
      ))}
    </nav>
  );
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="preview-banner">
        {mode === "preview" ? "Design preview" : "Live directory"}
        <span>
          {" "}
          ·{" "}
          {mode === "preview"
            ? "Illustrative profiles. No live trades or funds."
            : "Not connected. No verified profiles available."}
        </span>
      </div>
      {!online && (
        <div className="offline-banner" role="status">
          You’re offline. Local ghosts are available; prices and trading need a
          connection.
        </div>
      )}
      <div className={`app-shell ${realTrader ? "focused-flow" : ""}`}>
        {!realTrader && (
          <aside className="sidebar">
            <a
              className="brand"
              href="#discover"
              onClick={() => navigate("discover")}
              aria-label="Swipr home"
            >
              <img src="/assets/mark.svg" alt="" />
              swipr<span>.</span>
            </a>
            {nav}
            <div className="sidebar-bottom">
              <span className="eyebrow">A LITTLE SHARED CONVICTION</span>
              <p>
                Find your people.
                <br />
                Keep your own keys.
              </p>
              <span className="local-indicator">
                <i /> Your wallet. Your call.
              </span>
            </div>
          </aside>
        )}
        <main id="main" tabIndex={-1}>
          {realTrader ? (
            <PassSetup
              trader={realTrader}
              onClose={() => setRealTrader(null)}
              initialPerTradeUsd={prefs.amount}
            />
          ) : (
            <>
              <header className="mobile-header">
                <a
                  className="brand"
                  href="#discover"
                  onClick={() => navigate("discover")}
                >
                  <img src="/assets/mark.svg" alt="" />
                  swipr<span>.</span>
                </a>
                <button
                  className="avatar-button"
                  onClick={() => navigate("you")}
                  aria-label="Your preferences"
                >
                  You
                </button>
              </header>
              {page === "discover" && (
                <>
                  <div className="discovery-filter">
                    <span className="eyebrow">FOR YOU</span>
                    <label className="filter-select">
                      <Icon name="filter" size={16} />
                      <span className="sr-only">Trading style</span>
                      <select
                        value={prefs.vibe}
                        onChange={(e) =>
                          updatePrefs(prefs.amount, e.target.value)
                        }
                      >
                        {["All", "Steady", "Balanced", "Spicy"].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <Discover
              key={`${mode}:${prefs.vibe}`}
                    traders={traders}
                    onGhost={ghost}
                    onReal={setRealTrader}
                    perTradeUsd={prefs.amount}
                    vibe={prefs.vibe}
                  />
                </>
              )}
              {page === "ghosts" && (
                <Ghosts
                  ghosts={ghosts}
                  traders={previewTraders}
                  onReal={setRealTrader}
                  onRemove={(id) => {
                    persistGhosts(removeGhost(ghosts, id));
                    setNotice("Ghost removed from this browser.");
                  }}
                />
              )}
              {page === "matches" && (
                <section className="content-page">
                  <span className="eyebrow">YOUR PEOPLE. YOUR POSITIONS.</span>
                  <h1>
                    Your matches<span>.</span>
                  </h1>
                  <p className="page-lead">
                    A little shared conviction. A clear commitment.
                  </p>
                  <div className="empty-illustration">
                    <Icon name="matches" size={44} />
                  </div>
                  <h2>No real copies yet.</h2>
                  <p>
                    Start with a ghost. When you’re ready, choose a Copy Pass
                    and review its limits before connecting your wallet.
                  </p>
                  <div className="quiet-note">
                    <Icon name="shield" size={20} />
                    <p>
                      Accepting a seat and approving a pass are separate steps.
                      No position appears here until an actual fill is
                      confirmed.
                    </p>
                  </div>
                  <button
                    className="primary-button"
                    onClick={() => navigate("discover")}
                  >
                    Meet a trader <Icon name="arrow" size={18} />
                  </button>
                  <button
                    className="text-button"
                    onClick={() => navigate("ghosts")}
                  >
                    See your ghosts
                  </button>
                </section>
              )}
              {page === "you" && (
                <section className="content-page">
                  <span className="eyebrow">MAKE YOURSELF AT HOME</span>
                  <h1>
                    Your kind of trading<span>.</span>
                  </h1>
                  <p className="page-lead">
                    A little about you. No wallet needed yet.
                  </p>
                  <div className="settings-group">
                    <h2>Your ghost defaults</h2>
                    <label className="setting-label" htmlFor="trade-size">
                      Per-trade amount <strong>${prefs.amount}</strong>
                    </label>
                    <input
                      id="trade-size"
                      type="range"
                      min="5"
                      max="50"
                      step="1"
                      value={prefs.amount}
                      onChange={(e) =>
                        updatePrefs(Number(e.target.value), prefs.vibe)
                      }
                    />
                    <div className="range-ends">
                      <span>$5</span>
                      <span>$50</span>
                    </div>
                    <label className="setting-label" htmlFor="style">
                      Your trading style
                    </label>
                    <select
                      id="style"
                      className="wide-select"
                      value={prefs.vibe}
                      onChange={(e) =>
                        updatePrefs(prefs.amount, e.target.value)
                      }
                    >
                      {["All", "Steady", "Balanced", "Spicy"].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                    <p className="muted">
                      Applies to new ghosts. Existing ghosts keep their original
                      amount and start time.
                    </p>
                  </div>
                  <div className="settings-group">
                    <h2>Your wallet</h2>
                    <p>
                      Connect with email when you’re ready to make a copy real.
                      Wallet login and Base funding will be available when the
                      live service is connected.
                    </p>
                    <span className="status-pill">Not connected</span>
                  </div>
                  <div className="settings-group">
                    <h2>Explore the website</h2>
                    <p>
                      Design profiles let you try discovery, ghost tracking and
                      the pass review. They aren’t live traders.
                    </p>
                    <div className="segmented">
                      <button
                        aria-pressed={mode === "preview"}
                        onClick={() => setMode("preview")}
                      >
                        Design preview
                      </button>
                      <button
                        aria-pressed={mode === "live"}
                        onClick={() => setMode("live")}
                      >
                        Live directory
                      </button>
                    </div>
                  </div>
                  <div className="settings-group">
                    <h2>Take Swipr with you</h2>
                    <p>
                      On iPhone, choose Share → Add to Home Screen. On supported
                      desktop and Android browsers, use the install option in
                      the address bar or browser menu.
                    </p>
                    <p className="muted">
                      Local ghosts stay on this browser. Clearing site data
                      removes them.
                    </p>
                  </div>
                </section>
              )}
            </>
          )}
        </main>
        {!realTrader && <div className="bottom-nav">{nav}</div>}
      </div>
      <div className="notice-host" aria-live="polite" aria-atomic="true">
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button
              onClick={() => {
                navigate("ghosts");
                setNotice("");
              }}
            >
              View ghosts
            </button>
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
