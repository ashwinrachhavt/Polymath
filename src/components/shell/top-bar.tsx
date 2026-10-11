import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { clerkConfigured } from "@/lib/clerk";
import { AppSwitcher } from "./app-switcher";
import { CommandLayer } from "./command-layer";

export function TopBar() {
  return <header className="suite-topbar sticky top-0 z-30 flex h-[60px] shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:gap-4 md:px-5"><Link href="/apps/command-center/briefing" aria-label="Axiom home" className="mr-1 flex items-center gap-2 rounded-md font-medium tracking-tight"><span aria-hidden className="axiom-mark">a</span><span className="hidden text-base xl:block">axiom</span></Link><span aria-hidden className="mx-1 hidden h-6 w-px bg-border sm:block"/><AppSwitcher/><div className="ml-auto flex min-w-0 items-center gap-2"><CommandLayer/><Link href="/apps/command-center/reviews" aria-label="Open shared reviews" title="Shared reviews" className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"><ShieldCheck aria-hidden className="size-4"/></Link><ThemeToggle/>{clerkConfigured && <><SignedIn><UserButton/></SignedIn><SignedOut><Link href="/sign-in" className="text-xs">Sign in</Link></SignedOut></>}</div></header>;
}
