import { botPortrait } from './lib/profile-images';
import Matches from './components/Matches';
import { useEffect, useState } from "react";
import type { Trader } from "./contracts/types";
import { SessionPanel, WalletBalance, useSession } from './auth/Session';
import Dropdown from './components/Dropdown';
import Leaderboards from './components/Leaderboards';
import BotStudio from "./components/BotStudio";
import Discover from "./components/Discover";
import Ghosts from "./components/Ghosts";
import PassSetup from "./components/PassSetup";
import { Icon } from "./components/Icons";
import {
  MAX_PER_TRADE_USD,
  MIN_PER_TRADE_USD,
} from "./lib/ghosts";
import { getBots } from "./lib/bots";
import { useWalletGhosts } from "./auth/useWalletGhosts";

type Page = "discover" | "ghosts" | "matches" | "bots" | "leaderboards" | "you";
const pages: Page[] = ["discover", "ghosts", "matches", "leaderboards", "bots", "you"];
const vibes = ["All", "Steady", "Balanced", "Spicy"];
const PREFS_KEY = "swipr.preferences.v1";
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
function AccountButton({ onAccount }: { onAccount: () => void }) {
  const session = useSession();
  return <button type="button" className="account-button"
    onClick={session.authenticated ? onAccount : session.login}
    disabled={!session.ready || !session.configured}>
    {!session.ready ? 'Loading…' : session.authenticated ? 'Your account' : 'Sign in'}
  </button>;
}

export default function App() {
  const session = useSession();
  const [page, setPage] = useState<Page>(currentPage);
  const { store: ghostStore, ghosts, loading: ghostsLoading, busy: ghostsBusy, error: ghostsError } = useWalletGhosts(session);
  const [prefs, setPrefs] = useState(readPrefs);
  const [realTrader, setRealTrader] = useState<Trader | null>(null);
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [registeredTraders, setRegisteredTraders] = useState<Trader[]>([]);
  const [directoryVersion, setDirectoryVersion] = useState(0);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setDirectoryVersion(v => v + 1); };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void getBots(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRegisteredTraders(value.profiles.filter(p => p.status === "active").map(p => ({
        id: p.id, profileId: p.id, name: p.name, ens: "",
        bio: p.bio, style: p.style, avatar: botPortrait(p), kind: "agent" as const, owner: p.owner,
        operator: p.operator, source: "registered" as const,
      })));
    }).catch(() => { if (!controller.signal.aborted) { setRegisteredTraders([]);  } });
    return () => controller.abort();
  }, [directoryVersion]);
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
  const ghost = async (trader: Trader): Promise<boolean> => {
    if (!ghostStore) { session.login(); return false; }
    if (!online) { setNotice("Reconnect to save your ghost."); return false; }
    setNotice("Saving your ghost…");
    try {
      const { existed } = await ghostStore.start(trader.id, prefs.amount);
      setNotice(existed ? `${trader.name} is already in your ghosts. Original start time kept.`
        : `Ghost-copying ${trader.name} · $${prefs.amount}/trade · no funds moved.`);
      return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : "Your ghost could not be saved."); return false; }
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
      {!online && (
        <div className="offline-banner" role="status">
          You’re offline. Reconnect to sync ghosts and load prices.
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
            <div className="sidebar-account"><AccountButton onAccount={() => navigate("you")} /></div>
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
                <AccountButton onAccount={() => navigate("you")} />
              </header>
              {session.error && page !== "you" && <p className="account-error" role="alert">{session.error}</p>}
              {page === "discover" && (
                <>
                  <div className="discovery-filter">
                    <div className="discovery-actions">
                      <button className="text-button" onClick={() => navigate("bots")}>Add your bot</button>
                    </div>
                    <div className="filter-select">
                      <WalletBalance />
                      <Dropdown icon={<Icon name="filter" size={20} />} label="Trading style" value={prefs.vibe} options={vibes.map(v => [v, v])}
                        onChange={v => updatePrefs(prefs.amount, v)} />
                    </div>
                  </div>
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
                  onReal={setRealTrader}
                  loading={ghostsLoading}
                  busy={ghostsBusy}
                  error={ghostsError}
                  signedIn={!!ghostStore}
                  onSignIn={session.login}
                  onRefresh={() => { void ghostStore?.refresh(); }}
                  onRemove={(id) => {
                    if (!ghostStore) return;
                    void ghostStore.remove(id).then(() => setNotice("Ghost removed."))
                      .catch(error => setNotice(error instanceof Error ? error.message : "Your ghost could not be removed."));
                  }}
                />
              )}
              {page === "matches" && <Matches onDiscover={() => navigate("discover")} onJoin={id => { const trader = registeredTraders.find(t => t.id === id); if (trader) setRealTrader(trader); }} />}
              {page === "bots" && <BotStudio onChanged={() => setDirectoryVersion(v => v + 1)} />}
              {page === "leaderboards" && <Leaderboards />}
              {page === "you" && (
                <section className="content-page">
                  <span className="eyebrow">MAKE YOURSELF AT HOME</span>
                  <h1>
                    Your kind of trading<span>.</span>
                  </h1>
                  {!session.authenticated && <p className="page-lead">Sign in and make yourself at home.</p>}
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
                  <SessionPanel showBalance />
                  <div className="settings-group">
                    <h2>Take Swipr with you</h2>
                    <p>
                      On iPhone, choose Share → Add to Home Screen. On supported
                      desktop and Android browsers, use the install option in
                      the address bar or browser menu.
                    </p>
                    <p className="muted">
                      Your ghosts follow your wallet across browsers and devices.
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
