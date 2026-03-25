import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { HardHat, Plus, MessageSquare, DollarSign, LogOut } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useAuth } from "@workspace/replit-auth-web";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const isProjectDetail = location.startsWith("/projects/");
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="md:hidden flex items-center justify-between px-3 h-11 border-b border-border shrink-0 bg-sidebar">
        <Link href="/">
          <div className="flex items-center gap-2 font-display font-bold text-sm text-foreground cursor-pointer">
            <div className="size-6 rounded-md bg-primary/20 flex items-center justify-center border border-primary/30">
              <HardHat className="size-3.5 text-primary" />
            </div>
            ConstructAI
          </div>
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground/50">v1.0</span>
          <Link href="/?new=1">
            <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium cursor-pointer">
              <Plus className="size-3" />
              New
            </div>
          </Link>
        </div>
      </header>

      <div className="flex-1 flex flex-row overflow-hidden">
        <aside className="hidden md:flex w-[260px] bg-sidebar border-r border-sidebar-border flex-col shrink-0">
          <div className="p-4 pb-3">
            <Link href="/">
              <div className="flex items-center gap-2.5 font-display font-bold text-lg text-foreground cursor-pointer hover:opacity-80 transition-opacity">
                <div className="size-8 rounded-lg bg-primary/20 flex items-center justify-center border border-primary/30">
                  <HardHat className="size-4.5 text-primary" />
                </div>
                ConstructAI
              </div>
            </Link>
          </div>

          <div className="px-3 pb-2">
            <Link href="/?new=1">
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border/60 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer transition-all">
                <Plus className="size-4" />
                New project
              </div>
            </Link>
          </div>

          <div className="flex-1 overflow-y-auto px-3 space-y-0.5">
            <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider px-3 py-2">Projects</p>
          </div>

          <div className="px-3 pb-1">
            <Link href="/costs">
              <div className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all cursor-pointer",
                location === "/costs"
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}>
                <DollarSign className="size-4" />
                Cost Monitor
              </div>
            </Link>
          </div>

          <div className="p-3 mt-auto border-t border-sidebar-border">
            <div className="flex items-center justify-between px-2 py-1.5">
              <div className="flex items-center gap-2.5 min-w-0">
                {user?.profileImageUrl ? (
                  <img src={user.profileImageUrl} alt="" className="size-7 rounded-full border border-border" />
                ) : (
                  <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
                    <MessageSquare className="size-3.5 text-primary" />
                  </div>
                )}
                <span className="text-xs text-muted-foreground truncate">
                  {user?.firstName || user?.email || "User"}
                </span>
              </div>
              <button
                onClick={logout}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title="Log out"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          </div>
        </aside>

        <main className="flex-1 overflow-hidden w-full h-[100dvh] md:h-auto">
          <div className={cn("h-full", isProjectDetail ? "p-0" : "p-4 md:p-8")}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
