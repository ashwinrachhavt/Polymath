import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { Geist_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
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
  title: "Axiom",
  description: "Personal command center and knowledge operating system.",
};

/*
 * ClerkProvider throws on a missing publishable key, so it only mounts when
 * the deployment actually has Clerk configured. Without keys the tree renders
 * exactly the same, minus identity — the app stays browsable in CI and on a
 * preview that has no Clerk project yet.
 */
// Lazy so the Clerk runtime only ships to deployments that actually use it;
// the keyless preview skips the chunk entirely.
const ClerkAuthProvider = dynamic(() => import("@/components/auth/clerk-auth-provider"));

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
      </body>
    </html>
  );
}
