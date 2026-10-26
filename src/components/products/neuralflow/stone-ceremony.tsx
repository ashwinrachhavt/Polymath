"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StoneArt } from "./stone-art";
import { stoneCatalog } from "./stones";
import "./stone-ceremony.css";

/*
 * ASH-311: completing meaningful work triggers a short, beautiful,
 * non-blocking ceremony. It fires ONLY on the canonical award result -
 * completeTaskAction/completeTasksAction returning quartzEarned from the
 * recordDailyQuartz call inside the completion transaction - so the card can
 * never claim a stone the ledger did not record, and the once-a-day
 * idempotency key makes it naturally replay-safe across single and bulk
 * completion. The archive stays quiet: the stone lives on the existing
 * rewards surface, linked here, not on a new dashboard.
 *
 * Sound is light and optional: a two-note chime, OFF by default, enabled
 * only by the explicit checkbox below (persisted in localStorage so it never
 * touches the canonical schema), and attempted once per ceremony. Audio is
 * best-effort - a blocked or missing AudioContext fails silent.
 */

const CHIME_KEY = "polymath.stone-ceremony.chime";
const AUTO_DISMISS_MS = 9000;

function chimeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHIME_KEY) === "on";
  } catch {
    return false;
  }
}

function playChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [523.25, 783.99]; // C5, G5 - a soft rising fifth
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.75);
    });
    window.setTimeout(() => void ctx.close().catch(() => {}), 1600);
  } catch {
    // Audio unavailable or blocked: the ceremony is visual first.
  }
}

const quartz = stoneCatalog[0];

export function StoneCeremony({ sentence, onDismiss }: { sentence?: string; onDismiss: () => void }) {
  const [sound, setSound] = useState(chimeEnabled);
  const dismissed = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    // Chime once per ceremony, only when the person opted in. Deliberately
    // not keyed on `sound`: flipping the checkbox mid-ceremony must not
    // replay the chime or reset the dismiss timer.
    if (chimeEnabled()) playChime();
    const timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [dismiss]);

  function toggleSound(next: boolean) {
    setSound(next);
    try {
      window.localStorage.setItem(CHIME_KEY, next ? "on" : "off");
    } catch {
      // Storage unavailable: the checkbox still holds for this ceremony.
    }
    if (next) playChime();
  }

  return (
    <div className="stone-ceremony" role="status" aria-live="polite">
      <div className="stone-ceremony-card">
        <span className="stone-ceremony-art">
          <StoneArt stone={quartz} size={56} sheen />
        </span>
        <div className="stone-ceremony-body">
          <p className="stone-ceremony-title">Quartz earned</p>
          <p className="stone-ceremony-line">First completed task of the day.</p>
          {sentence ? <p className="stone-ceremony-line stone-ceremony-sentence">&ldquo;{sentence}&rdquo;</p> : null}
          <div className="stone-ceremony-actions">
            <Link href="/apps/neuralflow/rewards" className="text-xs text-primary hover:underline" onClick={dismiss}>
              View collection
            </Link>
            <label className="stone-ceremony-sound">
              <input type="checkbox" checked={sound} onChange={(event) => toggleSound(event.target.checked)} />
              Soft chime
            </label>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="stone-ceremony-dismiss" aria-label="Dismiss" onClick={dismiss}>
          <X aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
