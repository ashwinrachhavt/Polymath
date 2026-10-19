"use client";

import { UserProfile } from "@clerk/nextjs";
import type { Appearance } from "@clerk/types";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/*
 * Clerk's full profile management, hosted in a right-side panel rather than a
 * centered modal or a /user route: the owner's account is something they visit
 * from the avatar and leave, so it slides in over the workspace and slides
 * away. `routing="hash"` keeps Clerk's internal navigation in the URL hash
 * (the only embed mode the component types allow); the hash is stripped when
 * the panel closes so the workspace URL stays clean.
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
  function handleOpenChange(next: boolean) {
    if (!next && window.location.hash.startsWith("#/")) {
      // Clerk's hash routing owns "#/..." while the panel is open; do not let
      // it leak into the workspace URL after the panel closes.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    onOpenChange(next);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-border border-b">
          <SheetTitle>Account</SheetTitle>
          <SheetDescription>Profile, security and sign-in methods, managed by Clerk.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {open ? <UserProfile routing="hash" appearance={panelAppearance} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
