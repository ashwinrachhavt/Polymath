"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

/*
 * Dictation's mount in the app shell. Only this file is in the initial bundle:
 * a key listener that waits for Right Option. The controller and its pill load
 * when the browser is idle, or at once on the first Right Option press, and
 * that press (and its release) are replayed into the controller so it still
 * counts. Leaving a page stops listening; what was recorded is still inserted
 * or offered for copying.
 */

const DictationIndicator = dynamic(() => import("./dictation-indicator").then((m) => m.DictationIndicator), {
  ssr: false,
});

const loadController = () => import("./dictation-controller");
const EARLY_KEY_MAX_AGE_MS = 1_000;

export function DictationMount() {
  const [installed, setInstalled] = useState(false);
  const pathname = usePathname();
  const lastPathname = useRef(pathname);

  useEffect(() => {
    let cancelled = false;
    let uninstall: (() => void) | undefined;
    let loading = false;
    const early: KeyboardEvent[] = [];

    const load = () => {
      if (loading) return;
      loading = true;
      loadController().then(
        (controller) => {
          window.removeEventListener("keydown", buffer, true);
          window.removeEventListener("keyup", buffer, true);
          if (cancelled) return;
          // A press that waited longer than this for the chunk is no longer
          // what the person is doing; replaying it would open the microphone
          // out of nowhere.
          const fresh = early.filter((event) => performance.now() - event.timeStamp < EARLY_KEY_MAX_AGE_MS);
          uninstall = controller.installDictation(fresh.length === early.length ? early : []);
          setInstalled(true);
        },
        // A failed chunk load must not end dictation for the page: the next press tries again.
        () => {
          loading = false;
          early.length = 0;
        },
      );
    };
    const buffer = (event: KeyboardEvent) => {
      if (event.code !== "AltRight") {
        // Right Option with another key is a shortcut or a special character, never dictation.
        if (event.type === "keydown") early.length = 0;
        return;
      }
      early.push(event);
      load();
    };
    window.addEventListener("keydown", buffer, true);
    window.addEventListener("keyup", buffer, true);
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(load, { timeout: 3000 })
        : window.setTimeout(load, 2000);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", buffer, true);
      window.removeEventListener("keyup", buffer, true);
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      uninstall?.();
    };
  }, []);

  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    void loadController().then((controller) => controller.stopDictation());
  }, [pathname]);

  return installed ? <DictationIndicator /> : null;
}
