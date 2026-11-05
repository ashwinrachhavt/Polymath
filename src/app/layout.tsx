import type { Metadata } from "next";
import { Red_Hat_Display, Red_Hat_Mono, Red_Hat_Text } from "next/font/google";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { MotionProvider } from "@/components/motion-config";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const redHatDisplay = Red_Hat_Display({
  variable: "--font-red-hat-display",
  subsets: ["latin"],
});

const redHatText = Red_Hat_Text({
  variable: "--font-red-hat-text",
  subsets: ["latin"],
});

const redHatMono = Red_Hat_Mono({
  variable: "--font-red-hat-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Polymath",
  description: "Personal command center and knowledge operating system.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${redHatDisplay.variable} ${redHatText.variable} ${redHatMono.variable} h-full antialiased`}
    >
      {/* Auth providers sit inside <body>; cacheComponents requires it. */}
      <body className="flex min-h-full flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <MotionProvider>{children}</MotionProvider>
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
