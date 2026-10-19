"use client";

import { UserProfile } from "@clerk/nextjs";
import type { Appearance } from "@clerk/types";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/*
 * Clerk's full profile management, hosted in a right-side panel rather than a
 * centered modal or a /user route: the owner's account is something they visit
 * from the avatar and leave, so it slides in over the workspace and slides
 * away. `routing="virtual"` keeps Clerk's internal navigation in memory, so
 * the panel never touches the URL.
 *
 * The appearance overrides flatten Clerk's own card chrome — the panel already
 * supplies the border, fill and shadow, and a card inside a card is the
 * clunkiness this shell is removing. Colors still come from the provider-level
 * clerkAppearance, so light and dark stay in sync with ThemeProvider.
 */
const panelAppearance = {
  elements: {
    rootBox: "h-full w-full",
    cardBox: "h-full w-full border-0 shadow-none",
    card: "h-full w-full max-w-none rounded-none border-0 bg-transparent shadow-none",
  },
} satisfies Appearance;

export function UserProfilePanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-border border-b">
          <SheetTitle>Account</SheetTitle>
          <SheetDescription>Profile, security and sign-in methods, managed by Clerk.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {open ? <UserProfile routing="virtual" appearance={panelAppearance} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
