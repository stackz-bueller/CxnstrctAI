import { useState, useEffect } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import {
  Shield, Users, DollarSign, Zap, FileText, MessageSquare,
  TrendingUp, RefreshCw, Crown, UserX, UserCheck,
} from "lucide-react";

interface ManagedUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  role: string;
  createdAt: string;
}

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

type AdminTab = "users" | "costs";

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<AdminTab>("users");

  if (user?.role !== "superuser") {
    return (
      <div className="flex items-center justify-center h-full py-20">
        <div className="text-center space-y-3">
          <Shield className="size-12 text-muted-foreground/30 mx-auto" />
          <h2 className="text-lg font-semibold text-foreground">Access Denied</h2>
          <p className="text-sm text-muted-foreground">This page is restricted to superusers.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="size-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30">
          <Shield className="size-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Admin Panel</h1>
          <p className="text-sm text-muted-foreground">Manage users and monitor system costs</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        <button
          onClick={() => setTab("users")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "users"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-2">
            <Users className="size-4" />
            Users
          </span>
        </button>
        <button
          onClick={() => setTab("costs")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === "costs"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-2">
            <DollarSign className="size-4" />
            Cost Monitor
          </span>
        </button>
      </div>

      {tab === "users" ? <UsersTab /> : <CostsTab />}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  async function fetchUsers() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function toggleRole(userId: string, currentRole: string) {
    const newRole = currentRole === "superuser" ? "user" : "superuser";
    setUpdating(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
      }
    } catch { /* ignore */ }
    setUpdating(null);
  }

  useEffect(() => { fetchUsers(); }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <div className="size-5 border-2 border-current border-t-transparent rounded-full animate-spin mr-3" />
        Loading users...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{users.length} registered user{users.length !== 1 ? "s" : ""}</p>
        <button onClick={fetchUsers} className="p-2 rounded-lg border border-border hover:bg-muted/50 transition-colors">
          <RefreshCw className="size-4" />
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {users.map((u) => (
          <div key={u.id} className="px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {u.profileImageUrl ? (
                <img src={u.profileImageUrl} alt="" className="size-9 rounded-full border border-border" />
              ) : (
                <div className="size-9 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
                  <Users className="size-4 text-primary" />
                </div>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground truncate">
                    {u.firstName || u.email || `User ${u.id}`}
                    {u.lastName ? ` ${u.lastName}` : ""}
                  </p>
                  {u.role === "superuser" && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-500 text-[10px] font-semibold uppercase tracking-wider">
                      <Crown className="size-2.5" />
                      Super
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {u.email || "No email"} · ID: {u.id} · Joined {new Date(u.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
            <button
              onClick={() => toggleRole(u.id, u.role)}
              disabled={updating === u.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                u.role === "superuser"
                  ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                  : "bg-primary/10 text-primary hover:bg-primary/20"
              } disabled:opacity-50`}
              title={u.role === "superuser" ? "Demote to user" : "Promote to superuser"}
            >
              {u.role === "superuser" ? (
                <>
                  <UserX className="size-3" />
                  Demote
                </>
              ) : (
                <>
                  <UserCheck className="size-3" />
                  Promote
                </>
              )}
            </button>
          </div>
        ))}
        {users.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No users registered yet.
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border/50 bg-card/50 p-4">
        <p className="text-xs text-muted-foreground">
          <strong>Access Control:</strong> Login is restricted by the ALLOWED_USER_IDS environment variable.
          Add Replit user IDs (comma-separated) to allow new users. Superuser status can be toggled here or via the SUPERUSER_IDS environment variable.
        </p>
      </div>
    </div>
  );
}

function CostsTab() {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">AI extraction and chat costs across all pipelines</p>
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
