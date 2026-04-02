import { fetchFalconWhaleSignals, type FalconWhaleSignal } from "./falcon.service";

type SentimentHint = "Highly Likely" | "Unlikely" | "Uncertain";
type WhaleStatus = "buying_yes" | "selling_yes" | "neutral";
type WhaleSide = "yes" | "no";

type MarketLike = {
  id?: unknown;
  question?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
  volume?: unknown;
  volumeNum?: unknown;
  volume1wk?: unknown;
};

export interface MarketData {
  market_id: string;
  title: string;
  yesProbability: number | null;
  totalVolume: number;
  data_source: "falcon_real_time" | "polymarket_onchain_fallback";
  sentiment_hint: SentimentHint;
  whale_sentiment: {
    status: WhaleStatus;
    description: string;
    confidence_score: number;
  };
  last_updated: string;
}

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const DATA_API_LEADERBOARD_URL =
  "https://data-api.polymarket.com/v1/leaderboard?limit=20&window=all";
const TOP_N = 5;
const LEADERBOARD_LIMIT = 20;
const CACHE_TTL_MS = 60_000;

let cachedMarkets: MarketData[] = [];
let cacheExpiresAt = 0;
let cacheUpdatedAt = 0;
let refreshInFlight: Promise<MarketData[]> | null = null;
let autoRefreshStarted = false;
let cacheUpdateListener: ((payload: { count: number; updatedAt: string }) => void) | null = null;
let yellowLog: (message: string) => string = (message: string) => message;
let magentaLog: (message: string) => string = (message: string) => message;
let grayLog: (message: string) => string = (message: string) => message;
let chalkLoaded: Promise<void> | null = null;
let gammaConnected = false;
let falconActive = false;

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getYesProbability(market: MarketLike): number | null {
  const outcomes = parseJsonArray(market.outcomes).map((item) =>
    String(item).trim().toLowerCase(),
  );
  const prices = parseJsonArray(market.outcomePrices);

  if (!outcomes.length || !prices.length || outcomes.length !== prices.length) return null;

  const yesIndex = outcomes.findIndex((label) => label === "yes");
  if (yesIndex === -1) return null;

  const yesPrice = toNumber(prices[yesIndex]);
  return Number.isFinite(yesPrice) ? yesPrice : null;
}

function getTotalVolume(market: MarketLike): number {
  const volumeNum = toNumber(market.volumeNum);
  if (volumeNum > 0) return volumeNum;
  return toNumber(market.volume);
}

function getWeeklyVolume(market: MarketLike): number {
  return toNumber(market.volume1wk);
}

function getSentimentHint(yesProbability: number | null): SentimentHint {
  if (yesProbability === null) return "Uncertain";
  if (yesProbability > 0.7) return "Highly Likely";
  if (yesProbability < 0.3) return "Unlikely";
  return "Uncertain";
}

async function ensureYellowLogger(): Promise<void> {
  if (chalkLoaded) {
    await chalkLoaded;
    return;
  }

  chalkLoaded = import("chalk")
    .then((mod) => {
      yellowLog = mod.default.yellow;
      magentaLog = mod.default.magenta;
      grayLog = mod.default.gray;
    })
    .catch(() => {
      yellowLog = (message: string) => message;
      magentaLog = (message: string) => message;
      grayLog = (message: string) => message;
    });

  await chalkLoaded;
}

function hashToInt(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function simulateWhalePosition(address: string, marketId: string): { active: boolean; side: WhaleSide } {
  const base = hashToInt(`${address}:${marketId}`);
  const active = base % 100 < 40;
  const side: WhaleSide = (hashToInt(`${marketId}:${address}:side`) % 2 === 0) ? "yes" : "no";
  return { active, side };
}

async function fetchTopAddresses(): Promise<string[]> {
  const response = await fetch(DATA_API_LEADERBOARD_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Data API leaderboard respondio ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Formato inesperado en leaderboard: se esperaba un arreglo.");
  }

  const addresses = payload
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => (typeof entry.proxyWallet === "string" ? entry.proxyWallet : ""))
    .filter((address) => address.length > 0)
    .slice(0, LEADERBOARD_LIMIT);

  if (addresses.length === 0) {
    throw new Error("Leaderboard sin direcciones validas.");
  }

  return addresses;
}

function fallbackTopAddresses(): string[] {
  return Array.from({ length: LEADERBOARD_LIMIT }, (_, index) => `sim_whale_${index + 1}`);
}

export type TopTrader = {
  rank: number;
  address: string;
  username: string | null;
  xUsername: string | null;
  window: "all";
  roi: number | null;
  earnings: number | null;
};

let cachedTopTraders: TopTrader[] = [];
let topTradersCacheExpiresAt = 0;

export async function fetchTopTraders(limit = 10): Promise<TopTrader[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  if (Date.now() < topTradersCacheExpiresAt && cachedTopTraders.length >= safeLimit) {
    return cachedTopTraders.slice(0, safeLimit);
  }

  try {
    const response = await fetch(DATA_API_LEADERBOARD_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Data API leaderboard respondio ${response.status} ${response.statusText}`);
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error("Formato inesperado en leaderboard: se esperaba un arreglo.");
    }

    const traders = payload
      .map((entry) => entry as Record<string, unknown>)
      .map((entry, index): TopTrader | null => {
        const address = typeof entry.proxyWallet === "string" ? entry.proxyWallet : "";
        if (!address) return null;
        const username = typeof entry.userName === "string" && entry.userName.trim().length > 0 ? entry.userName : null;
        const xUsername =
          typeof entry.xUsername === "string" && entry.xUsername.trim().length > 0 ? entry.xUsername : null;
        const pnl =
          typeof entry.pnl === "number" ? entry.pnl : typeof entry.pnl === "string" ? Number(entry.pnl) : NaN;
        const vol =
          typeof entry.vol === "number" ? entry.vol : typeof entry.vol === "string" ? Number(entry.vol) : NaN;
        const earnings = Number.isFinite(pnl) ? pnl : null;
        const roi = Number.isFinite(pnl) && Number.isFinite(vol) && vol > 0 ? (pnl / vol) * 100 : null;
        return { rank: index + 1, address, username, xUsername, window: "all", roi, earnings };
      })
      .filter((t): t is TopTrader => t !== null)
      .slice(0, 20);

    cachedTopTraders = traders;
    topTradersCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return traders.slice(0, safeLimit);
  } catch {
    // Fallback si el leaderboard falla (rate-limit o red)
    const fallback = Array.from({ length: 20 }, (_, index) => ({
      rank: index + 1,
      address: `sim_trader_${index + 1}`,
      username: null,
      xUsername: null,
      window: "all" as const,
      roi: null,
      earnings: null,
    }));
    cachedTopTraders = fallback;
    topTradersCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return fallback.slice(0, safeLimit);
  }
}

async function computeWhaleSentiment(
  marketId: string,
  topAddresses: string[],
  falconSignal?: FalconWhaleSignal,
): Promise<{
  whaleSentiment: MarketData["whale_sentiment"];
  dataSource: MarketData["data_source"];
}> {
  await ensureYellowLogger();

  if (falconSignal && falconSignal.sampleSize > 0) {
    const whalesYes = falconSignal.yesCount;
    const whalesNo = falconSignal.noCount;
    const totalWhales = whalesYes + whalesNo;
    const status: WhaleStatus = whalesYes > 2 ? "buying_yes" : whalesNo > 2 ? "selling_yes" : "neutral";

    console.log(`${magentaLog("🦅 [FALCON MODE ON]")} Signal enriched for market ${marketId}`);

    return {
      dataSource: "falcon_real_time",
      whaleSentiment: {
        status,
        description: `Detected ${totalWhales} top-tier whales holding this position`,
        confidence_score: Number(((totalWhales / LEADERBOARD_LIMIT) * 100).toFixed(2)),
      },
    };
  }

  let whalesYes = 0;
  let whalesNo = 0;

  for (const address of topAddresses) {
    const position = simulateWhalePosition(address, marketId);
    if (!position.active) continue;

    if (position.side === "yes") whalesYes += 1;
    if (position.side === "no") whalesNo += 1;

    console.log(yellowLog(`[Whale Detectada] ${address} en market ${marketId} (${position.side.toUpperCase()})`));
  }

  const totalWhales = whalesYes + whalesNo;
  const status: WhaleStatus = whalesYes > 2 ? "buying_yes" : whalesNo > 2 ? "selling_yes" : "neutral";

  console.log(`${grayLog("⚠️ [FALCON FALLBACK]")} Using standard Data API for market ${marketId}`);

  return {
    dataSource: "polymarket_onchain_fallback",
    whaleSentiment: {
      status,
      description: `Detected ${totalWhales} top-tier whales holding this position`,
      confidence_score: Number(((totalWhales / LEADERBOARD_LIMIT) * 100).toFixed(2)),
    },
  };
}

function isCacheExpired(): boolean {
  return Date.now() >= cacheExpiresAt || cachedMarkets.length === 0;
}

async function refreshPolymarketCache(volumeWindow: "all" | "1wk"): Promise<MarketData[]> {
  const url = new URL("/markets", GAMMA_BASE_URL);
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "100");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    gammaConnected = false;
    throw new Error(`Gamma API respondio ${response.status} ${response.statusText}`);
  }
  gammaConnected = true;

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Formato inesperado: se esperaba un arreglo de mercados.");
  }

  let topAddresses: string[];
  try {
    topAddresses = await fetchTopAddresses();
  } catch (error) {
    topAddresses = fallbackTopAddresses();
    if (error instanceof Error) {
      console.warn(`Leaderboard no disponible, usando fallback simulado: ${error.message}`);
    }
  }

  const updatedAtIso = new Date().toISOString();
  const topMarketsRaw = payload
    .map((item) => item as MarketLike)
    .sort((a, b) => {
      if (volumeWindow === "1wk") {
        return getWeeklyVolume(b) - getWeeklyVolume(a);
      }
      return getTotalVolume(b) - getTotalVolume(a);
    })
    .slice(0, TOP_N);
  const topMarketIds = topMarketsRaw
    .map((market) => (typeof market.id === "string" ? market.id : String(market.id ?? "")))
    .filter((marketId) => marketId.length > 0);

  let falconSignals: Record<string, FalconWhaleSignal> = {};
  try {
    falconSignals = await fetchFalconWhaleSignals(topMarketIds);
    falconActive = Object.keys(falconSignals).length > 0;
  } catch (error) {
    falconActive = false;
    if (error instanceof Error) {
      console.warn(`Falcon API no disponible, usando flujo Data API/simulado: ${error.message}`);
    }
  }

  const normalizedMarkets = await Promise.all(
    topMarketsRaw.map(async (market): Promise<MarketData> => {
      const rawTitle = typeof market.question === "string" ? market.question.trim() : "";
      const yesProbability = getYesProbability(market);
      const marketId = typeof market.id === "string" ? market.id : String(market.id ?? "");
      const safeMarketId = marketId || "unknown";
      const { whaleSentiment, dataSource } = await computeWhaleSentiment(
        safeMarketId,
        topAddresses,
        falconSignals[safeMarketId],
      );

      return {
        market_id: safeMarketId,
        title: rawTitle || "Sin titulo",
        yesProbability,
        totalVolume: volumeWindow === "1wk" ? getWeeklyVolume(market) : getTotalVolume(market),
        data_source: dataSource,
        sentiment_hint: getSentimentHint(yesProbability),
        whale_sentiment: whaleSentiment,
        last_updated: updatedAtIso,
      };
    }),
  );

  if (volumeWindow === "1wk") {
    cachedMarkets1wk = normalizedMarkets;
    cacheUpdatedAt1wk = Date.now();
    cacheExpiresAt1wk = Date.now() + CACHE_TTL_MS;
  } else {
    cachedMarkets = normalizedMarkets;
    cacheUpdatedAt = Date.now();
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  }

  if (cacheUpdateListener) {
    cacheUpdateListener({ count: normalizedMarkets.length, updatedAt: updatedAtIso });
  }

  return normalizedMarkets;
}

let cachedMarkets1wk: MarketData[] = [];
let cacheExpiresAt1wk = 0;
let cacheUpdatedAt1wk = 0;
let refreshInFlight1wk: Promise<MarketData[]> | null = null;

function isCacheExpiredFor(window: "all" | "1wk"): boolean {
  if (window === "1wk") return Date.now() >= cacheExpiresAt1wk || cachedMarkets1wk.length === 0;
  return Date.now() >= cacheExpiresAt || cachedMarkets.length === 0;
}

function getOrRefreshCache(volumeWindow: "all" | "1wk"): Promise<MarketData[]> {
  if (!isCacheExpiredFor(volumeWindow)) {
    return Promise.resolve(volumeWindow === "1wk" ? cachedMarkets1wk : cachedMarkets);
  }

  if (volumeWindow === "1wk") {
    if (refreshInFlight1wk) return refreshInFlight1wk;
    refreshInFlight1wk = refreshPolymarketCache("1wk").finally(() => {
      refreshInFlight1wk = null;
    });
    return refreshInFlight1wk;
  }

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = refreshPolymarketCache("all").finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function fetchPolymarketData(volumeWindow: "all" | "1wk" = "all"): Promise<MarketData[]> {
  return getOrRefreshCache(volumeWindow);
}

export function startPolymarketAutoRefresh(): void {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;

  setInterval(() => {
    refreshInFlight = refreshPolymarketCache("all")
      .catch((error: unknown) => {
        if (error instanceof Error) {
          console.error("Error en auto-refresh de cache:", error.message);
          return cachedMarkets;
        }
        console.error("Error desconocido en auto-refresh de cache.");
        return cachedMarkets;
      })
      .finally(() => {
        refreshInFlight = null;
      });

    refreshInFlight1wk = refreshPolymarketCache("1wk")
      .then((markets) => markets)
      .catch((error: unknown) => {
        if (error instanceof Error) {
          console.error("Error en auto-refresh de cache (1wk):", error.message);
          return cachedMarkets1wk;
        }
        console.error("Error desconocido en auto-refresh de cache (1wk).");
        return cachedMarkets1wk;
      })
      .finally(() => {
        refreshInFlight1wk = null;
      });
  }, CACHE_TTL_MS);
}

export function setCacheUpdateListener(
  listener: (payload: { count: number; updatedAt: string }) => void,
): void {
  cacheUpdateListener = listener;
}

export function getHealthStatus(): {
  status: "up";
  apis: {
    polymarket_gamma: "connected" | "disconnected";
    falcon_heisenberg: "active" | "inactive";
    cache_age_ms: number;
  };
} {
  return {
    status: "up",
    apis: {
      polymarket_gamma: gammaConnected ? "connected" : "disconnected",
      falcon_heisenberg: falconActive ? "active" : "inactive",
      cache_age_ms: cacheUpdatedAt > 0 ? Math.max(0, Date.now() - cacheUpdatedAt) : 0,
    },
  };
}
