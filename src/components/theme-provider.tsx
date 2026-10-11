"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/*
 * next-themes is a client island at the shell, the one place a provider is
 * worth it: it owns the `.dark` class the token block in globals.css reads.
 */
export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props} />;
}
