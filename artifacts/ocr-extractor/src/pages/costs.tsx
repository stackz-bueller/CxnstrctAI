import { useState, useEffect } from "react";
import { DollarSign, Zap, FileText, MessageSquare, TrendingUp, RefreshCw } from "lucide-react";

interface CostSummaryCategory {
  category: string;
  eventCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

interface CostDayEntry {
  date: string;
  eventCount: number;
  totalCostUsd: number;
}

interface CostSummary {
  period: { since: string; days: number };
  byCategory: CostSummaryCategory[];
  byDay: CostDayEntry[];
  grandTotalUsd: number;
}

const CATEGORY_META: Record<string, { label: string; icon: typeof DollarSign; color: string }> = {
  construction_extraction: { label: "Construction Drawings", icon: FileText, color: "text-blue-500" },
  ocr_extraction: { label: "OCR Extraction", icon: Zap, color: "text-amber-500" },
  spec_extraction: { label: "Specifications", icon: FileText, color: "text-green-500" },
  financial_extraction: { label: "Financial Docs", icon: DollarSign, color: "text-emerald-500" },
  chat: { label: "Project Chat", icon: MessageSquare, color: "text-violet-500" },
  embedding: { label: "Embeddings", icon: TrendingUp, color: "text-gray-500" },
};

export default function CostsPage() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  async function fetchSummary() {
    setLoading(true);
    try {
      const res = await fetch(`/api/costs/summary?days=${days}`, { credentials: "include" });
      if (res.ok) {
        setSummary(await res.json());
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  useEffect(() => { fetchSummary(); }, [days]);

  const formatCost = (usd: number) => {
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  };

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cost Monitor</h1>
          <p className="text-sm text-muted-foreground mt-1">Track AI extraction and chat costs across all pipelines</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-sm border border-border rounded-lg px-3 py-1.5 bg-background"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <button onClick={fetchSummary} className="p-2 rounded-lg border border-border hover:bg-muted/50 transition-colors">
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {loading && !summary ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <div className="size-5 border-2 border-current border-t-transparent rounded-full animate-spin mr-3" />
          Loading cost data...
        </div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Cost</p>
              <p className="text-3xl font-bold text-foreground mt-2">{formatCost(summary.grandTotalUsd)}</p>
              <p className="text-xs text-muted-foreground mt-1">Last {days} days</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">API Calls</p>
              <p className="text-3xl font-bold text-foreground mt-2">
                {summary.byCategory.reduce((sum, c) => sum + c.eventCount, 0).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Across all pipelines</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Tokens</p>
              <p className="text-3xl font-bold text-foreground mt-2">
                {formatTokens(summary.byCategory.reduce((sum, c) => sum + c.totalTokens, 0))}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Input + output</p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Cost by Category</h2>
            </div>
            <div className="divide-y divide-border">
              {summary.byCategory.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No cost events recorded yet. Costs will appear after extraction or chat operations.
                </div>
              ) : (
                summary.byCategory.map((cat) => {
                  const meta = CATEGORY_META[cat.category] || {
                    label: cat.category,
                    icon: DollarSign,
                    color: "text-gray-500",
                  };
                  const Icon = meta.icon;
                  return (
                    <div key={cat.category} className="px-5 py-3.5 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Icon className={`size-4 ${meta.color}`} />
                        <div>
                          <p className="text-sm font-medium text-foreground">{meta.label}</p>
                          <p className="text-xs text-muted-foreground">{cat.eventCount} calls / {formatTokens(cat.totalTokens)} tokens</p>
                        </div>
                      </div>
                      <p className="text-sm font-semibold text-foreground">{formatCost(cat.totalCostUsd)}</p>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {summary.byDay.length > 0 && (
            <div className="rounded-xl border border-border bg-card">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">Daily Costs</h2>
              </div>
              <div className="p-5">
                <div className="space-y-2">
                  {summary.byDay.map((day) => {
                    const maxCost = Math.max(...summary.byDay.map((d) => d.totalCostUsd));
                    const barWidth = maxCost > 0 ? (day.totalCostUsd / maxCost) * 100 : 0;
                    return (
                      <div key={day.date} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-20 shrink-0">{day.date.slice(5)}</span>
                        <div className="flex-1 h-6 bg-muted/30 rounded-md overflow-hidden">
                          <div
                            className="h-full bg-primary/20 rounded-md flex items-center px-2"
                            style={{ width: `${Math.max(barWidth, 2)}%` }}
                          >
                            <span className="text-[10px] font-medium text-foreground whitespace-nowrap">{formatCost(day.totalCostUsd)}</span>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground w-12 text-right">{day.eventCount}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="text-center py-20 text-sm text-muted-foreground">
          Failed to load cost data. Please try again.
        </div>
      )}
    </div>
  );
}
