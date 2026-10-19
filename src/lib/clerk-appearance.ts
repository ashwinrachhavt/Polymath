import type { Appearance } from "@clerk/types";

/*
 * Clerk UI follows Polymath tokens (globals.css) so sign-in, sign-up, and the
 * UserButton match the machined shell instead of Clerk's default marketing
 * palette. CSS variables keep light/dark in sync with ThemeProvider.
 */

export const clerkAppearance = {
  variables: {
    colorPrimary: "var(--primary)",
    colorBackground: "var(--card)",
    colorForeground: "var(--foreground)",
    colorText: "var(--foreground)",
    colorTextSecondary: "var(--muted-foreground)",
    colorTextOnPrimaryBackground: "var(--primary-foreground)",
    colorInputBackground: "var(--background)",
    colorInputText: "var(--foreground)",
    colorDanger: "var(--destructive)",
    colorNeutral: "var(--muted-foreground)",
    colorMuted: "var(--muted)",
    colorMutedForeground: "var(--muted-foreground)",
    colorBorder: "var(--border)",
    colorRing: "var(--ring)",
    borderRadius: "var(--radius)",
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    fontFamilyButtons: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    rootBox: "mx-auto w-full max-w-[400px]",
    card: "border border-border bg-card text-card-foreground shadow-[var(--shadow)]",
    headerTitle: "text-foreground tracking-tight",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButton:
      "border border-border bg-background text-foreground hover:bg-muted",
    formFieldLabel: "text-foreground",
    formFieldInput:
      "border border-input bg-background text-foreground focus:ring-2 focus:ring-ring",
    formButtonPrimary:
      "bg-primary text-primary-foreground hover:opacity-90 focus:ring-2 focus:ring-ring",
    footerActionLink: "text-primary hover:underline",
    identityPreviewEditButton: "text-primary",
    userButtonPopoverCard: "border border-border bg-card shadow-[var(--shadow)]",
    userButtonPopoverActionButton: "text-foreground hover:bg-muted",
    userButtonPopoverFooter: "hidden",
  },
} satisfies Appearance;

/** Post-auth landing — briefing before browsing (agents/product.md). */
export const afterAuthUrl = "/apps/command-center/briefing";
