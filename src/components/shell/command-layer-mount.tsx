"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

/*
 * The command layer's mount, in TopBar. The two triggers are cheap, persistent
 * chrome; the palette behind them (dialog, search state, recorder, the
 * shortcuts list and the shell-action clients) loads on first open instead of
 * riding in every page's bundle. Keyboard open intents are answered here —
 * Cmd+K and Cmd+Shift+C must work before the palette module exists — and stand
 * down while the layer is open, because CommandLayer then owns its own
 * listener and toggling; closing the layer hands the chrome back. An idle
 * warm-up fetches the chunk after load, so the first open still pays no
 * visible network.
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

  // The two triggers are persistent chrome: cheap, always visible, and the
  // focus-restore targets for both dialog exits. The palette itself mounts
  // beside them only while open (below), so a save or an escape never removes
  // the buttons — before this fix, first open swapped the triggers out and
  // they never came back (the e2e suite caught the Capture button missing).
  // data-search-trigger / data-capture-trigger are the layer's focus anchors.
  const triggers = (
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
        data-capture-trigger
      >
        <Plus aria-hidden />
        <span className="hidden sm:inline">Capture</span>
        <span className="sr-only sm:hidden">Capture</span>
      </Button>
    </>
  );

  if (mountedWith) {
    return (
      <>
        {triggers}
        <CommandLayer
          initialMode={mountedWith}
          withTriggers={false}
          onOpenChange={(open) => {
            // The layer closed itself (save, escape, action picked): back to
            // the standalone triggers, focus restore targets them, and the
            // next open re-mounts the (already cached) palette module.
            if (!open) setMountedWith(null);
          }}
        />
      </>
    );
  }

  return triggers;
}
