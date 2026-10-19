"use client";

import dynamic from "next/dynamic";
import { AnonymousMenu } from "./user-menu-shared";

/*
 * The account menu, in the header.
 *
 * Settings and Activity are shared routes rather than any one app's screens, so
 * they belong to a surface every app shares — this menu — not to the app rail.
 *
 * The menu is always present. With Clerk configured it adds identity and sign
 * in/out; without keys the app still runs (see lib/clerk.ts) and Settings must
 * still be reachable, so the surface exists and the identity rows are simply
 * absent. The Clerk variant loads lazily so previews without keys never
 * download the Clerk runtime.
 *
 * `configured` comes from the server: reading the flag inside this component
 * read `process.env` from the browser bundle, where it is inlined empty, and hid
 * the whole control.
 */
const SignedInMenu = dynamic(() => import("./user-menu-clerk"));

export function UserMenu({ configured }: { configured: boolean }) {
  return configured ? <SignedInMenu /> : <AnonymousMenu />;
}
