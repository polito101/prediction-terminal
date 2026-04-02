"use client";

import axios from "axios";
import { useEffect, useMemo, useRef, useState } from "react";

import { Progress } from "@/components/ui/progress";

type WhaleStatus = "buying_yes" | "selling_yes" | "neutral";

type MarketData = {
  market_id: string;
  title: string;
  yesProbability: number | null;
  totalVolume: number;
  data_source: "falcon_real_time" | "polymarket_onchain_fallback";
  sentiment_hint: "Highly Likely" | "Unlikely" | "Uncertain";
  whale_sentiment: {
    status: WhaleStatus;
    description: string;
    confidence_score: number;
  };
  last_updated: string;
};

type WhaleFeedItem = {
  id: string;
  createdAt: number;
  walletShort: string;
  action: "Bought YES" | "Sold YES" | "Neutral Flow";
  market: string;
};

type MarketSnapshot = {
  whaleStatus: WhaleStatus;
  yesProbability: number | null;
};

type TopTrader = {
  rank: number;
  address: string;
  window: "all";
  username: string | null;
  xUsername: string | null;
  roi: number | null;
  earnings: number | null;
};

const REFRESH_INTERVAL_MS = 30_000;
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

function formatVolume(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUpdated(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}

function asPercent(value: number | null): number {
  if (value === null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value * 100));
}

function centsFromProbability(p: number | null, side: "yes" | "no"): number {
  if (p === null || Number.isNaN(p)) return 0;
  const yes = Math.max(0, Math.min(1, p));
  const no = 1 - yes;
  return Math.round((side === "yes" ? yes : no) * 100);
}

function categoryGlyph(title: string): string {
  const t = title.toLowerCase();
  if (/\b(nba|nfl|soccer|world cup|fifa|mlb|ufc|tennis|olympic)\b/i.test(t)) return "⚽";
  if (/\b(trump|biden|election|congress|senate|politic|president)\b/i.test(t)) return "🏛️";
  if (/\b(bitcoin|btc|eth|crypto|solana|defi)\b/i.test(t)) return "₿";
  if (/\b(ai|openai|gpt|tech|apple|google)\b/i.test(t)) return "◆";
  return title.trim().charAt(0).toUpperCase() || "?";
}

function whaleSentimentLabel(status: WhaleStatus): string {
  if (status === "buying_yes") return "Buying YES";
  if (status === "selling_yes") return "Selling YES";
  return "Neutral";
}

function shortWallet(seed: string): string {
  const clean = seed.replace("sim_whale_", "0x").replace(/[^a-zA-Z0-9]/g, "");
  const base = clean.length > 8 ? clean : `${clean}${Math.random().toString(16).slice(2, 10)}`;
  return `${base.slice(0, 5)}...${base.slice(-2)}`;
}

function minutesAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.max(0, Math.floor(diff / 60_000));
  if (mins < 1) return "Just now";
  return `${mins}m ago`;
}

function formatMoney(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatRoi(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function displayTraderName(trader: TopTrader): string {
  if (trader.xUsername) return `@${trader.xUsername}`;
  if (trader.username) return trader.username;
  return shortWallet(trader.address);
}

export default function Home() {
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [feed, setFeed] = useState<WhaleFeedItem[]>([]);
  const [topTraders, setTopTraders] = useState<TopTrader[]>([]);
  const previousSnapshotRef = useRef<Record<string, MarketSnapshot>>({});

  useEffect(() => {
    let active = true;

    async function loadMarkets() {
      try {
        if (!markets.length) setLoading(true);
        setIsRefreshing(true);
        setError(null);
        const [marketsRes, tradersRes] = await Promise.all([
          axios.get<MarketData[]>(`${API_BASE_URL}/markets?volume_window=1wk`),
          axios.get<TopTrader[]>(`${API_BASE_URL}/traders/top?limit=10`),
        ]);
        if (active) {
          const nextMarkets = [...marketsRes.data].sort((a, b) => b.totalVolume - a.totalVolume);
          setMarkets(nextMarkets);
          setTopTraders(tradersRes.data);

          const prevSnapshot = previousSnapshotRef.current;
          const nextSnapshot: Record<string, MarketSnapshot> = {};
          const now = Date.now();

          const newFeedItems: WhaleFeedItem[] = nextMarkets
            .filter((market) => {
              const prev = prevSnapshot[market.market_id];
              const yesChanged =
                prev && prev.yesProbability !== null && market.yesProbability !== null
                  ? Math.abs(prev.yesProbability - market.yesProbability) >= 0.01
                  : false;
              const statusChanged = prev ? prev.whaleStatus !== market.whale_sentiment.status : false;
              return Boolean(prev) && (statusChanged || yesChanged);
            })
            .map((market) => {
              const action =
                market.whale_sentiment.status === "buying_yes"
                  ? "Bought YES"
                  : market.whale_sentiment.status === "selling_yes"
                    ? "Sold YES"
                    : "Neutral Flow";

              return {
                id: `${market.market_id}-${now}`,
                createdAt: now,
                walletShort: shortWallet(market.market_id),
                action,
                market: market.title,
              };
            });

          nextMarkets.forEach((market) => {
            nextSnapshot[market.market_id] = {
              whaleStatus: market.whale_sentiment.status,
              yesProbability: market.yesProbability,
            };
          });
          previousSnapshotRef.current = nextSnapshot;

          if (newFeedItems.length > 0) {
            setFeed((prev) => [...newFeedItems, ...prev].slice(0, 10));
          }
        }
      } catch {
        if (active) setError("Could not load markets from Polymarket.");
      } finally {
        if (active) {
          setLoading(false);
          window.setTimeout(() => setIsRefreshing(false), 650);
        }
      }
    }

    void loadMarkets();
    const interval = window.setInterval(() => {
      void loadMarkets();
    }, REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const marketCards = useMemo(() => {
    if (loading || error) return null;

    return (
      <div className="grid gap-4 sm:grid-cols-1 xl:grid-cols-2">
        {markets.map((market) => {
          const yesPct = asPercent(market.yesProbability);
          const yesCents = centsFromProbability(market.yesProbability, "yes");
          const noCents = centsFromProbability(market.yesProbability, "no");
          const glyph = categoryGlyph(market.title);
          const falcon = market.data_source === "falcon_real_time";

          return (
            <article
              key={market.market_id}
              className="group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-[#161922] p-5 shadow-sm transition-all duration-300 hover:border-white/[0.1] hover:shadow-lg"
            >
              {falcon && (
                <span className="absolute right-4 top-4 z-10 inline-flex items-center rounded-full border border-blue-500/30 bg-blue-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-sky-300">
                  🦅 Falcon Verified
                </span>
              )}

              <div className="flex gap-4 pr-24">
                <div
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-600/80 to-slate-800 text-lg font-semibold text-white shadow-inner"
                  aria-hidden
                >
                  {glyph.length === 1 ? glyph : <span className="text-xl">{glyph}</span>}
                </div>

                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-semibold leading-snug text-slate-50">{market.title}</h3>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      className="rounded-xl bg-sky-500/15 px-4 py-3 text-center text-sm font-semibold text-sky-400 transition hover:bg-sky-500/25"
                    >
                      Buy Yes {yesCents}¢
                    </button>
                    <button
                      type="button"
                      className="rounded-xl bg-rose-500/15 px-4 py-3 text-center text-sm font-semibold text-rose-400 transition hover:bg-rose-500/25"
                    >
                      Buy No {noCents}¢
                    </button>
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                      <span>Yes {yesPct.toFixed(1)}%</span>
                      <span>No {(100 - yesPct).toFixed(1)}%</span>
                    </div>
                    <Progress value={yesPct} />
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-slate-500">
                    <span>Vol {formatVolume(market.totalVolume)}</span>
                    <span className="text-slate-600">·</span>
                    <span>Updated {formatUpdated(market.last_updated)}</span>
                  </div>

                  <p className="mt-3 border-t border-white/[0.06] pt-3 text-xs text-slate-500">
                    <span className="mr-1.5" aria-hidden>
                      🐳
                    </span>
                    Whale Sentiment:{" "}
                    <span className="font-medium text-slate-300">{whaleSentimentLabel(market.whale_sentiment.status)}</span>
                  </p>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    );
  }, [error, loading, markets]);

  return (
    <div className="min-h-screen bg-[#0f111a] text-slate-100">
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#12141a]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-bold text-white">
              C
            </div>
            <span className="hidden font-semibold tracking-tight text-slate-100 sm:inline">Chiri</span>
          </div>

          <div className="mx-auto hidden max-w-md flex-1 sm:block">
            <div className="pointer-events-none rounded-full border border-white/[0.08] bg-[#0f111a] px-4 py-2.5 text-sm text-slate-500 shadow-inner">
              Search markets…
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span
              className={`hidden h-2 w-2 rounded-full bg-emerald-400 sm:inline-block ${isRefreshing ? "animate-ping-once" : "opacity-80"}`}
              title="Live refresh"
            />
            <button
              type="button"
              className="rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-blue-500/20 transition hover:brightness-110"
            >
              Connect Wallet
            </button>
          </div>
        </div>
        <div className="border-t border-white/[0.06] px-4 py-2 sm:hidden">
          <div className="pointer-events-none rounded-full border border-white/[0.08] bg-[#0f111a] px-4 py-2.5 text-sm text-slate-500">
            Search markets…
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Markets</h1>
          <p className="mt-1 text-sm text-slate-500">Top volume Polymarket markets · auto-refresh / 30s</p>
        </div>

        {loading && (
          <p className="text-center text-sm text-slate-500">Loading markets…</p>
        )}
        {error && <p className="text-center text-sm text-rose-400">{error}</p>}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <section className="lg:col-span-8">{marketCards}</section>

          <aside className="lg:col-span-4">
            <div className="sticky top-24 rounded-2xl border border-white/[0.06] bg-[#161922] p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-slate-200">Top Traders</h2>
              <div className="mb-6 space-y-2">
                {topTraders.length === 0 ? (
                  <p className="text-xs text-slate-500">Loading leaderboard…</p>
                ) : (
                  topTraders.map((t) => (
                    <div
                      key={`${t.rank}-${t.address}`}
                      className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#12141a] px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-8 text-slate-500">#{t.rank}</span>
                        <div className="min-w-0">
                          <p className="truncate text-slate-200">{displayTraderName(t)}</p>
                          <p className="font-mono text-[11px] text-slate-500">{shortWallet(t.address)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 font-mono">
                        <span className="text-slate-400" title="ROI (approx)">
                          {formatRoi(t.roi)}
                        </span>
                        <span className="text-emerald-300" title="Earnings / PnL (approx)">
                          {formatMoney(t.earnings)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <h2 className="mb-3 text-sm font-semibold text-slate-200">Whale Live Feed</h2>
              <div className="space-y-2">
                {feed.length === 0 ? (
                  <p className="text-xs text-slate-500">No recent activity yet.</p>
                ) : (
                  feed.map((item) => (
                    <article
                      key={item.id}
                      className="feed-fade-in rounded-xl border border-white/[0.06] bg-[#12141a] p-3 text-xs"
                    >
                      <div className="mb-1 flex items-center justify-between text-slate-500">
                        <span>{minutesAgo(item.createdAt)}</span>
                        <span className="font-mono text-slate-400">{item.walletShort}</span>
                      </div>
                      <p className="font-medium text-slate-200">{item.action}</p>
                      <p className="mt-1 line-clamp-2 text-slate-500" title={item.market}>
                        {item.market}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
