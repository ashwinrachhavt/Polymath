"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { clerkAppearance } from "@/lib/clerk-appearance";

/*
 * Mounted by the root layout only when Clerk is configured, so the keyless
 * browser preview never downloads Clerk's client runtime. Imported statically:
 * `next/dynamic` here broke instant validation (see src/app/layout.tsx).
 */
export function ClerkAuthProvider({ children }: { children: ReactNode }) {
  return <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>;
}
