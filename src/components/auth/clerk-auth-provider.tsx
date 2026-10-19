"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { clerkAppearance } from "@/lib/clerk-appearance";

/*
 * Loaded on demand by the root layout only when Clerk is configured, so the
 * keyless browser preview never downloads Clerk's client runtime.
 */
export default function ClerkAuthProvider({ children }: { children: ReactNode }) {
  return <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>;
}
