"use client";

import { SignInButton, SignOutButton, useUser } from "@clerk/nextjs";
import { Popover } from "radix-ui";
import { cn } from "cn";
import { Activity, LogOut, Settings } from "lucide-react";
import { AnonymousMenu, MenuItem } from "./user-menu-shared";

/*
 * The signed-in account menu. Loaded on demand (next/dynamic from
 * user-menu.tsx) only when Clerk is configured, so the keyless browser
 * preview never downloads Clerk's client runtime. `useUser` needs a mounted
 * ClerkProvider, which the layout's lazy ClerkAuthProvider supplies.
 */
export default function SignedInMenu() {
  const { isLoaded, isSignedIn, user } = useUser();
  const initial = user?.firstName?.[0] ?? user?.primaryEmailAddress?.emailAddress?.[0] ?? "?";
  const name = user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account";

  // Hold the slot's width while Clerk resolves so the header does not jump
  // when the avatar arrives.
  if (!isLoaded) return <span aria-hidden className="size-7 rounded-full bg-muted" />;
  // Signed out but Clerk is mounted, so the sign-in row is valid here.
  if (!isSignedIn) return <AnonymousMenu signInSlot={<SignInSlot />} />;

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
