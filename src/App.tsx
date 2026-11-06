import { useEffect, useState } from "react";
import type { RuntimeStatus, Trader } from "../shared/types";
import { SessionPanel } from './auth/Session';
import Leaderboards from './components/Leaderboards';
import BotStudio from "./components/BotStudio";
import Discover from "./components/Discover";
import Ghosts from "./components/Ghosts";
import PassSetup from "./components/PassSetup";
import { Icon } from "./components/Icons";
import {
  createGhostStore,
  GHOSTS_KEY,
  MAX_PER_TRADE_USD,
  MIN_PER_TRADE_USD,
  type GhostChange,
} from "./lib/ghosts";
import { getBots } from "./lib/bots";
import { getRuntime } from "./lib/api";

type Page = "discover" | "ghosts" | "matches" | "bots" | "leaderboards" | "you";
const pages: Page[] = ["discover", "ghosts", "matches", "leaderboards", "bots", "you"];
const vibes = ["All", "Steady", "Balanced", "Spicy"];
const PREFS_KEY = "swipr.preferences.v1";
const SESSION_ONLY_NOTICE =
  "Browser storage is unavailable. Your ghosts will last for this visit only.";
function currentPage(): Page {
  const hash = location.hash.slice(1);
  return pages.includes(hash as Page) ? (hash as Page) : "discover";
}
function readPrefs(): { amount: number; vibe: string } {
  try {
    const prefs = JSON.parse(
      localStorage.getItem(PREFS_KEY) ?? "{}",
    );
    return {
      amount:
        Number.isInteger(prefs.amount) &&
        prefs.amount >= MIN_PER_TRADE_USD &&
        prefs.amount <= MAX_PER_TRADE_USD
          ? prefs.amount
          : 10,
      vibe: vibes.includes(prefs.vibe)
        ? prefs.vibe
        : "Balanced",
    };
  } catch {
    return { amount: 10, vibe: "Balanced" };
  }
}
export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [ghostStore] = useState(() => createGhostStore());
  const [{ ghosts, status: ghostStorage }, setGhostSnapshot] = useState(
    ghostStore.getSnapshot,
  );
  const [prefs, setPrefs] = useState(readPrefs);
  const [realTrader, setRealTrader] = useState<Trader | null>(null);
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [registeredTraders, setRegisteredTraders] = useState<Trader[]>([]);
  const [directoryVersion, setDirectoryVersion] = useState(0);
  const [directoryState, setDirectoryState] = useState("Loading registered traders…");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [serviceState, setServiceState] = useState("Not checked");
  useEffect(() => {
    const controller = new AbortController();
    setDirectoryState("Loading registered traders…");
    void getBots(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRegisteredTraders(value.profiles.filter(p => p.status === "active").map(p => ({
        id: p.id, profileId: p.id, name: p.name, ens: "",
        bio: p.bio, style: p.style, avatar: "", kind: "agent" as const, owner: `${p.owner.slice(0, 6)}…${p.owner.slice(-4)}`,
        operator: p.operator, source: "registered" as const,
      })));
      setDirectoryState(value.state === "ready" ? "Registered bot profiles · execution history unverified" : value.detail);
    }).catch(() => { if (!controller.signal.aborted) { setRegisteredTraders([]); setDirectoryState("Trader directory unavailable. Try again from Bots."); } });
    return () => controller.abort();
  }, [directoryVersion]);
  useEffect(() => {
    if (page !== "you") return;
    const controller = new AbortController();
    const timer = setTimeout(() => { setRuntime(null); setServiceState("Live service unavailable"); controller.abort(); }, 8000);
    setServiceState("Checking service…");
    void getRuntime(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRuntime(value); setServiceState("API connected · trading gates pending");
    }).catch(() => { if (!controller.signal.aborted) { setRuntime(null); setServiceState("Live service unavailable"); } })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [page]);
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
    const unsubscribe = ghostStore.subscribe(setGhostSnapshot);
    // Other tabs write the same key; storage events keep this tab current.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === GHOSTS_KEY) ghostStore.refresh();
    };
    window.addEventListener("storage", onStorage);
    ghostStore.refresh();
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
    };
  }, [ghostStore]);
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
  const ghost = (trader: Trader) => {
    const amount = prefs.amount;
    void ghostStore
      .start(trader.id, amount)
      .then(({ existed, status }: GhostChange) =>
        setNotice(
          status === "session-only"
            ? SESSION_ONLY_NOTICE
            : existed
              ? `${trader.name} is already in your ghosts. Original start time kept.`
              : `Ghost-copying ${trader.name} · $${amount}/trade · no funds moved.`,
        ),
      );
  };
  const updatePrefs = (amount: number, vibe: string) => {
    const next = { amount, vibe };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      setNotice(
        "Preferences changed for this visit. Browser storage is unavailable.",
      );
    }
  };
  const traders = registeredTraders.filter(t => prefs.vibe === "All" || t.style === prefs.vibe);
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
          <span>{p[0].toUpperCase() + p.slice(1)}</span>
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
        Trader directory
        <span> · Real registrations only · trading verification pending.</span>
      </div>
      {ghostStorage === "session-only" && (
        <div className="offline-banner" role="status">
          {SESSION_ONLY_NOTICE}
        </div>
      )}
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
                        {vibes.map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="directory-status" role="status">{directoryState} <button className="text-button" onClick={() => setDirectoryVersion(v => v + 1)}>Refresh</button> <button className="text-button" onClick={() => navigate("bots")}>Add your bot</button></p>
                  <Discover
                    key={`${prefs.vibe}:${traders.map(t => t.id).join(',')}`}
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
                  traders={registeredTraders}
                  directoryStatus={directoryState}
                  onReal={setRealTrader}
                  onRemove={(id) => {
                    void ghostStore
                      .remove(id)
                      .then(({ status }) =>
                        setNotice(
                          status === "session-only"
                            ? SESSION_ONLY_NOTICE
                            : "Ghost removed from this browser.",
                        ),
                      );
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
                  <h2>Copy Pass service unavailable.</h2>
                  <p>
                    Confirmed passes and positions cannot be loaded yet.
                    This does not mean your wallet has no holdings.
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
              {page === "bots" && <BotStudio onChanged={() => setDirectoryVersion(v => v + 1)} />}
              {page === "leaderboards" && <Leaderboards />}
              {page === "you" && (
                <section className="content-page">
                  <span className="eyebrow">MAKE YOURSELF AT HOME</span>
                  <h1>
                    Your kind of trading<span>.</span>
                  </h1>
                  <p className="page-lead">
                    Sign in with Google and make yourself at home.
                  </p>
                  <div className="settings-group">
                    <h2>Your ghost defaults</h2>
                    <label className="setting-label" htmlFor="trade-size">
                      Per-trade amount <strong>${prefs.amount}</strong>
                    </label>
                    <input
                      id="trade-size"
                      type="range"
                      min={MIN_PER_TRADE_USD}
                      max={MAX_PER_TRADE_USD}
                      step="1"
                      value={prefs.amount}
                      onChange={(e) =>
                        updatePrefs(Number(e.target.value), prefs.vibe)
                      }
                    />
                    <div className="range-ends">
                      <span>${MIN_PER_TRADE_USD}</span>
                      <span>${MAX_PER_TRADE_USD}</span>
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
                      {vibes.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                    <p className="muted">
                      Applies to new ghosts. Existing ghosts keep their original
                      amount and start time.
                    </p>
                  </div>
                  <SessionPanel />
                  <div className="settings-group">
                    <h2>Service connections</h2>
                    <p role="status">{serviceState}</p>
                    {runtime && <ul className="service-list">{runtime.integrations.map(integration => (
                      <li key={integration.name}>
                        <strong>{integration.name}</strong>
                        <span>{integration.verified ? "Verified" : integration.configured ? "Configured · verification pending" : "Not configured"}</span>
                        <small>{integration.detail}</small>
                      </li>
                    ))}</ul>}
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
