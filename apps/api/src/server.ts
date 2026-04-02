import "dotenv/config";
import cors from "cors";
import express, { Request, Response } from "express";
import {
  fetchPolymarketData,
  fetchTopTraders,
  getHealthStatus,
  setCacheUpdateListener,
  startPolymarketAutoRefresh,
  type MarketData,
} from "./services/polymarket.service";

const DEFAULT_PORT = 4000;
const parsedPort = Number(process.env.PORT);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;

function logMarketsTable(markets: MarketData[]): void {
  const tableData = markets.map((market, index) => ({
    rank: index + 1,
    market_id: market.market_id,
    title: market.title,
    yesProbability:
      market.yesProbability === null ? "N/A" : `${(market.yesProbability * 100).toFixed(2)}%`,
    totalVolume: market.totalVolume.toFixed(2),
    data_source: market.data_source,
    sentiment_hint: market.sentiment_hint,
    whale_status: market.whale_sentiment.status,
    whale_confidence: market.whale_sentiment.confidence_score,
    last_updated: market.last_updated,
  }));
  console.table(tableData);
}

async function startServer(): Promise<void> {
  const chalkModule = await import("chalk");
  const chalk = chalkModule.default;

  const app = express();
  app.use(cors());

  setCacheUpdateListener(({ count, updatedAt }) => {
    console.log(chalk.blue(`[Cache Actualizada] ${count} mercados @ ${updatedAt}`));
  });

  startPolymarketAutoRefresh();

  app.get("/markets", async (req: Request, res: Response) => {
    try {
      const volumeWindow = req.query.volume_window === "1wk" ? "1wk" : "all";
      const markets = await fetchPolymarketData(volumeWindow);
      logMarketsTable(markets);
      return res.status(200).json(markets);
    } catch (error) {
      if (error instanceof Error) {
        console.error("Error al obtener mercados de Gamma API:", error.message);
        return res.status(502).json({
          error: "No se pudo obtener informacion de Polymarket.",
          detail: error.message,
        });
      }

      console.error("Error desconocido al obtener mercados de Gamma API.");
      return res.status(500).json({ error: "Error interno desconocido." });
    }
  });

  app.get("/health", (_req: Request, res: Response) => {
    return res.status(200).json(getHealthStatus());
  });

  app.get("/traders/top", async (req: Request, res: Response) => {
    try {
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
      const traders = await fetchTopTraders(Number.isFinite(limit) ? limit : 10);
      return res.status(200).json(traders);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(502).json({ error: "No se pudo obtener el leaderboard.", detail: error.message });
      }
      return res.status(500).json({ error: "Error interno desconocido." });
    }
  });

  app.listen(PORT, () => {
    console.log(chalk.green(`Servidor Online en http://localhost:${PORT}`));
  });
}

void startServer();
