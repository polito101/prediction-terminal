export interface FalconWhaleSignal {
  yesCount: number;
  noCount: number;
  sampleSize: number;
}

const FALCON_BASE_URL = "https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized";
const DEFAULT_AGENT_ID = 555;

function asArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((i) => typeof i === "object") as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const candidates = [obj.data, obj.results, obj.records, obj.items];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate.filter((i) => typeof i === "object") as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function normalizeSide(raw: unknown): "yes" | "no" | null {
  if (typeof raw !== "string") return null;
  const side = raw.trim().toLowerCase();
  if (side.includes("yes") || side === "buy") return "yes";
  if (side.includes("no") || side === "sell") return "no";
  return null;
}

export async function fetchFalconWhaleSignals(
  marketIds: string[],
): Promise<Record<string, FalconWhaleSignal>> {
  const token = process.env.FALCON_API_TOKEN;
  if (!token) return {};

  const agentId = Number(process.env.FALCON_AGENT_ID ?? DEFAULT_AGENT_ID);
  const response = await fetch(FALCON_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: Number.isFinite(agentId) ? agentId : DEFAULT_AGENT_ID,
      params: {
        platform: "polymarket",
        market_ids: marketIds,
        closed: "False",
      },
      pagination: {
        limit: 500,
        offset: 0,
      },
      formatter_config: {
        format_type: "raw",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Falcon API respondio ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  const rows = asArray(payload);
  const signals: Record<string, FalconWhaleSignal> = {};

  for (const marketId of marketIds) {
    signals[marketId] = { yesCount: 0, noCount: 0, sampleSize: 0 };
  }

  for (const row of rows) {
    const marketIdRaw = row.market_id ?? row.marketId ?? row.condition_id;
    const marketId = typeof marketIdRaw === "string" ? marketIdRaw : String(marketIdRaw ?? "");
    if (!marketId || !signals[marketId]) continue;

    const side = normalizeSide(row.side ?? row.position_side ?? row.outcome);
    if (!side) continue;

    if (side === "yes") signals[marketId].yesCount += 1;
    if (side === "no") signals[marketId].noCount += 1;
    signals[marketId].sampleSize += 1;
  }

  return signals;
}
