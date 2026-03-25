import { Router, type IRouter, type Request, type Response } from "express";
import { db, costEventsTable } from "@workspace/db";
import { sql, desc, eq, and, gte } from "drizzle-orm";
import { requireAuth } from "../lib/require-auth";

const router: IRouter = Router();

router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const { category, projectId, days } = req.query;

    const conditions = [];
    if (category && typeof category === "string") {
      conditions.push(eq(costEventsTable.category, category));
    }
    if (projectId && typeof projectId === "string") {
      conditions.push(eq(costEventsTable.projectId, Number(projectId)));
    }
    if (days && typeof days === "string") {
      const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
      conditions.push(gte(costEventsTable.createdAt, since));
    }

    const events = await db
      .select()
      .from(costEventsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(costEventsTable.createdAt))
      .limit(500);

    const summaryRows = await db
      .select({
        category: costEventsTable.category,
        totalEvents: sql<number>`count(*)::int`,
        totalInputTokens: sql<number>`coalesce(sum(${costEventsTable.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${costEventsTable.outputTokens}), 0)::int`,
        totalTokens: sql<number>`coalesce(sum(${costEventsTable.totalTokens}), 0)::int`,
        totalCostUsd: sql<number>`coalesce(sum(${costEventsTable.estimatedCostUsd}), 0)::float`,
      })
      .from(costEventsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(costEventsTable.category);

    const grandTotal = summaryRows.reduce((sum, r) => sum + (r.totalCostUsd || 0), 0);

    res.json({
      events,
      summary: summaryRows,
      grandTotalUsd: Math.round(grandTotal * 10000) / 10000,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch cost events");
    res.status(500).json({ error: "Failed to fetch cost data" });
  }
});

router.get("/summary", requireAuth, async (req: Request, res: Response) => {
  try {
    const { days } = req.query;
    const since = days && typeof days === "string"
      ? new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const byCategory = await db
      .select({
        category: costEventsTable.category,
        eventCount: sql<number>`count(*)::int`,
        totalTokens: sql<number>`coalesce(sum(${costEventsTable.totalTokens}), 0)::int`,
        totalCostUsd: sql<number>`coalesce(sum(${costEventsTable.estimatedCostUsd}), 0)::float`,
      })
      .from(costEventsTable)
      .where(gte(costEventsTable.createdAt, since))
      .groupBy(costEventsTable.category);

    const byDay = await db
      .select({
        date: sql<string>`to_char(${costEventsTable.createdAt}, 'YYYY-MM-DD')`,
        eventCount: sql<number>`count(*)::int`,
        totalCostUsd: sql<number>`coalesce(sum(${costEventsTable.estimatedCostUsd}), 0)::float`,
      })
      .from(costEventsTable)
      .where(gte(costEventsTable.createdAt, since))
      .groupBy(sql`to_char(${costEventsTable.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${costEventsTable.createdAt}, 'YYYY-MM-DD')`);

    const grandTotal = byCategory.reduce((sum, r) => sum + (r.totalCostUsd || 0), 0);

    res.json({
      period: { since: since.toISOString(), days: days || 30 },
      byCategory,
      byDay,
      grandTotalUsd: Math.round(grandTotal * 10000) / 10000,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch cost summary");
    res.status(500).json({ error: "Failed to fetch cost summary" });
  }
});

export default router;
