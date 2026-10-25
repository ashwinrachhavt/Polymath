"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { clerkAppearance } from "@/lib/clerk-appearance";

/*
 * Mounted by the workspace layout and the sign-in/sign-up pages only when
 * Clerk is configured, so the keyless browser preview - and the public
 * landing route - never downloads Clerk's client runtime. Imported
 * statically: `next/dynamic` here broke instant validation.
 */
export function ClerkAuthProvider({ children }: { children: ReactNode }) {
  return <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>;
}
