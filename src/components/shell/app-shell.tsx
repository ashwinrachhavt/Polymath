import type { ReactNode } from "react";
import { PreviewStorageWarning, WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { MobileNav } from "./mobile-nav";
import { NavRail } from "./nav-rail";
import { TopBar } from "./top-bar";
import { PreviewBanner } from "./preview-banner";
import { PathBreadcrumb } from "./path-breadcrumb";

export function AppShell({ children, storageScope = "anonymous" }: { children: ReactNode; storageScope?: string }) {
  return <WorkspaceProvider key={storageScope} storageScope={storageScope}><a href="#content" className="skip-link">Skip to content</a><div className="flex min-h-dvh flex-1 flex-col"><TopBar/><div className="flex flex-1"><NavRail/><main id="content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col"><PreviewBanner/><PreviewStorageWarning/><div className="px-5 pt-4 md:px-8"><PathBreadcrumb/></div>{children}</main></div><MobileNav/></div></WorkspaceProvider>;
}
