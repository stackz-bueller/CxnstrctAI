import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { HardHat, Plus, MessageSquare } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const isProjectDetail = location.startsWith("/projects/");

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-[260px] bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
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

        <div className="p-3 mt-auto border-t border-sidebar-border">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
              <MessageSquare className="size-3.5 text-primary" />
            </div>
            <span className="text-xs text-muted-foreground">ConstructAI v1.0</span>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden w-full h-[100dvh]">
        <div className={cn("h-full", isProjectDetail ? "p-0" : "p-4 md:p-8")}>
          {children}
        </div>
      </main>
    </div>
  );
}
