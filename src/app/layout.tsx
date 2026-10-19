import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ClerkAuthProvider } from "@/components/auth/clerk-auth-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { clerkConfigured } from "@/lib/clerk";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Polymath",
  description: "Personal command center and knowledge operating system.",
};

/*
 * ClerkProvider throws on a missing publishable key, so it only mounts when
 * the deployment actually has Clerk configured. Without keys the tree renders
 * exactly the same, minus identity — the app stays browsable in CI and on a
 * preview that has no Clerk project yet.
 *
 * Statically imported on purpose. `next/dynamic` here broke instant
 * validation: the validation pass re-renders the route in a separate render
 * and could not resolve the dynamically imported client reference, so every
 * workspace route reported "Could not validate `instant`" with a "module
 * factory is not available" cause. A client reference proxy is enough to keep
 * the server tree intact while the Clerk runtime ships only when the provider
 * actually mounts.
 */
function AuthProvider({ children }: { children: ReactNode }) {
  if (!clerkConfigured) return children;
  return <ClerkAuthProvider>{children}</ClerkAuthProvider>;
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Auth providers sit inside <body>; cacheComponents requires it. */}
      <body className="flex min-h-full flex-col">
        <AuthProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        </AuthProvider>
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
