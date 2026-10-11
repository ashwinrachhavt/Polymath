import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";

/*
 * Every destination shares the shell. A route group rather than a path
 * segment, so the shell never appears in a URL.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
