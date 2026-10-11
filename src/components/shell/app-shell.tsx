import type { ReactNode } from "react";
import { MobileNav } from "./mobile-nav";
import { NavRail } from "./nav-rail";
import { TopBar } from "./top-bar";

/*
 * 248 px rail, flexible canvas, optional inspector (agents/design.md § Layout).
 * The inspector is deliberately absent until a screen has something to put in
 * it — an empty panel is furniture, not a feature.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-1 flex-col">
      <TopBar />
      <div className="flex flex-1">
        <NavRail />
        <main id="content" className="flex min-w-0 flex-1 flex-col">
          {children}
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
