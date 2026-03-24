import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { HardHat, FolderOpen, MessageSquare } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Projects", icon: FolderOpen },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="p-6">
          <Link href="/">
            <div className="flex items-center gap-3 font-display font-bold text-xl text-foreground cursor-pointer">
              <div className="size-8 rounded-lg bg-primary/20 flex items-center justify-center border border-primary/30">
                <HardHat className="size-5 text-primary" />
              </div>
              ConstructAI
            </div>
          </Link>
          <p className="text-xs text-muted-foreground mt-2 pl-11">AI assistant for construction documents</p>
        </div>

        <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = item.href === "/" ? location === "/" : location.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group text-sm font-medium",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                <item.icon className={cn("size-5", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 mt-auto">
          <div className="p-4 rounded-xl bg-card border border-border/50 shadow-inner">
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20">
                <MessageSquare className="size-5 text-primary" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium">ConstructAI</span>
                <span className="text-xs text-muted-foreground">v1.0</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto w-full h-[100dvh]">
        <div className="h-full p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
