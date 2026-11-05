"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

/*
 * The command layer's mount, in TopBar. The two triggers are cheap and always
 * visible; the palette behind them (dialog, search state, recorder, the
 * shortcuts list and the shell-action clients) loads on first open instead of
 * riding in every page's bundle. Keyboard open intents are answered here —
 * Cmd+K and Cmd+Shift+C must work before the palette module exists — and
 * stand down once it is mounted, because CommandLayer then owns its own
 * listener and toggling. An idle warm-up fetches the chunk after load, so the
 * first open still pays no visible network.
 */

const CommandLayer = dynamic(() => import("./command-layer").then((m) => m.CommandLayer), { ssr: false });

// Same hydration gate the triggers inside CommandLayer use: controls are
// enabled only once the client has hydrated, so a pre-hydration click is
// never swallowed by markup the server rendered.
const subscribeToHydration = () => () => {};

export function CommandLayerMount() {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [mountedWith, setMountedWith] = useState<null | "search" | "capture">(null);

  useEffect(() => {
    if (mountedWith) return;
    const warm = () => void import("./command-layer");
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(id);
  }, [mountedWith]);

  useEffect(() => {
    if (mountedWith) return;
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMountedWith("search");
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setMountedWith("capture");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [mountedWith]);

  if (mountedWith) {
    return <CommandLayer initialMode={mountedWith} withTriggers={false} />;
  }

  // The same two triggers CommandLayer renders for itself — the markup is
  // duplicated here so the palette bundle can stay out of the shell. Keep the
  // data-search-trigger attribute: the dialog's focus restore finds it.
  return (
    <>
      <span className="contents md:hidden">
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => setMountedWith("search")}
          aria-label="Search workspace"
          aria-keyshortcuts="Meta+K Control+K"
          data-search-trigger
          className="global-search disabled:opacity-50"
        >
          <Search aria-hidden className="size-4 shrink-0" />
          <span className="hidden lg:inline">Search your workspace</span>
        </button>
      </span>
      <Button
        size="sm"
        disabled={!hydrated}
        onClick={() => setMountedWith("capture")}
        aria-keyshortcuts="Meta+Shift+C Control+Shift+C"
      >
        <Plus aria-hidden />
        <span className="hidden sm:inline">Capture</span>
        <span className="sr-only sm:hidden">Capture</span>
      </Button>
    </>
  );
}
