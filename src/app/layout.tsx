import type { Metadata } from "next";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { MotionProvider } from "@/components/motion-config";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APPEARANCE_BOOT_SCRIPT } from "@/lib/appearance";
import { SIDEBAR_PIN_BOOT_SCRIPT } from "@/lib/sidebar-pin";
import "./globals.css";

// Text is set in the platform's own sans (see --font-system in globals.css):
// no web-font download, so nothing reflows when a font arrives.
export const metadata: Metadata = {
  title: "Polymath",
  description: "Personal command center and knowledge operating system.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <head>
        {/* Applies the saved page colour and accent before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
        {/* Marks a pinned focus-page rail before first paint, so the page
            never narrows after hydration (see lib/sidebar-pin.ts). */}
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_PIN_BOOT_SCRIPT }} />
      </head>
      {/* Auth providers sit inside <body>; cacheComponents requires it. */}
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>
            <MotionProvider>{children}</MotionProvider>
          </TooltipProvider>
          <Toaster />
        </ThemeProvider>
        {/*
          Real-user Web Vitals (INP/LCP/CLS per route) in the Vercel dashboard.
          The trace work (Oct 19) showed hero-route clicks fire zero network
          requests - prefetch hits the edge cache - so the residual navigation
          time is client render, which only real hardware can measure
          truthfully. No-op outside Vercel; free on the hobby tier.
        */}
        <SpeedInsights />
      </body>
    </html>
  );
}
