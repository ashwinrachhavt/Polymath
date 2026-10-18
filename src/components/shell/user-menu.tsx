"use client";

import Link from "next/link";
import { SignInButton, SignOutButton, useUser } from "@clerk/nextjs";
import { Popover } from "radix-ui";
import { cn } from "cn";
import { Activity, LogOut, Settings, UserRound } from "lucide-react";

/*
 * The account menu, in the header.
 *
 * Settings and Activity are shared routes rather than any one app's screens, so
 * they belong to a surface every app shares — this menu — not to the app rail.
 * That is also how Notion reads: the avatar opens your account, and your account
 * is where settings live.
 *
 * The menu is always present. With Clerk configured it adds identity and sign
 * in/out; without keys the app still runs (see lib/clerk.ts) and Settings must
 * still be reachable, so the surface exists and the identity rows are simply
 * absent.
 *
 * `configured` comes from the server: reading the flag inside this component
 * read `process.env` from the browser bundle, where it is inlined empty, and hid
 * the whole control. The inner split is not decoration — `useUser` needs a
 * mounted ClerkProvider, and without keys there is none.
 */
export function UserMenu({ configured }: { configured: boolean }) {
  return configured ? <SignedInMenu /> : <AnonymousMenu canSignIn={false} />;
}

function MenuItem({ href, icon: Icon, children }: { href: string; icon: typeof Settings; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="hover:bg-accent focus-visible:ring-ring flex h-7 items-center gap-2 rounded-md px-2 text-[13px] outline-none focus-visible:ring-3"
    >
      <Icon aria-hidden className="size-4 opacity-70" />
      {children}
    </Link>
  );
}

function SignedInMenu() {
  const { isLoaded, isSignedIn, user } = useUser();
  const initial = user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "?";
  const name = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account";

  // Hold the slot's width while Clerk resolves so the header does not jump
  // when the avatar arrives.
  if (!isLoaded) return <span aria-hidden className="size-7 rounded-full bg-muted" />;
  // Signed out but Clerk is mounted, so the sign-in row is valid here.
  if (!isSignedIn) return <AnonymousMenu canSignIn />;

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Open account menu"
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-medium uppercase outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:text-foreground",
        )}
      >
        {initial}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="panel bg-popover text-popover-foreground z-50 w-56 rounded-lg p-1 outline-none">
          <p className="text-muted-foreground truncate px-2 py-1.5 text-[11px]">{name}</p>
          <div aria-hidden className="bg-border my-1 h-px" />
          <MenuItem href="/settings" icon={Settings}>Settings</MenuItem>
          <MenuItem href="/activity" icon={Activity}>Activity</MenuItem>
          <div aria-hidden className="bg-border my-1 h-px" />
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="hover:bg-accent focus-visible:ring-ring flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-3"
            >
              <LogOut aria-hidden className="size-4 opacity-70" />
              Sign out
            </button>
          </SignOutButton>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AnonymousMenu({ canSignIn }: { canSignIn: boolean }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Open account menu"
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
        )}
      >
        <UserRound aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="panel bg-popover text-popover-foreground z-50 w-56 rounded-lg p-1 outline-none">
          <MenuItem href="/settings" icon={Settings}>Settings</MenuItem>
          <MenuItem href="/activity" icon={Activity}>Activity</MenuItem>
          {canSignIn ? <SignInSlot /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/*
 * Rendered only when a ClerkProvider is mounted, which `SignedInMenu` already
 * established by reaching this component through it.
 */
function SignInSlot() {
  return (
    <>
      <div aria-hidden className="bg-border my-1 h-px" />
      <SignInButton mode="modal">
        <button
          type="button"
          className="hover:bg-accent focus-visible:ring-ring flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-3"
        >
          Sign in
        </button>
      </SignInButton>
    </>
  );
}
