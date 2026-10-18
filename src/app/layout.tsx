import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { clerkConfigured } from "@/lib/clerk";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Axiom",
  description: "Personal command center and knowledge operating system.",
};

/*
 * ClerkProvider throws on a missing publishable key, so it only mounts when
 * the deployment actually has Clerk configured. Without keys the tree renders
 * exactly the same, minus identity — the app stays browsable in CI and on a
 * preview that has no Clerk project yet.
 */
function AuthProvider({ children }: { children: ReactNode }) {
  if (!clerkConfigured) return children;
  return <ClerkProvider appearance={clerkAppearance}>{children}</ClerkProvider>;
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
      </body>
    </html>
  );
}
