"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { IDLE } from "./dictation-machine";
import { DICTATED_EVENT } from "./dictation-target";

/*
 * A mic button for one text field. It latches dictation on and off for that
 * field, the click twin of tapping Right Option, and never takes focus from
 * the field. The controller loads when the button mounts, as its own chunk
 * after hydration, so pages with no button pay nothing; until it arrives the
 * button reads idle and a click waits for it.
 */

type Controller = typeof import("./dictation-controller");

const loadController = () => import("./dictation-controller");
const noSubscription = () => () => {};

export function DictationButton({
  field,
  onDictated,
  size = "icon",
  variant = "ghost",
  disabled = false,
  className,
}: {
  /** The field's element; a getter because refs and editor views are only readable after mount. */
  field: () => Element | null;
  /** Dictated words were just inserted into the field (it must be mounted with the button). */
  onDictated?: () => void;
  size?: "icon" | "icon-sm";
  variant?: "ghost" | "outline";
  /** The field cannot take words right now. */
  disabled?: boolean;
  className?: string;
}) {
  const [controller, setController] = useState<Controller | null>(null);
  useEffect(() => {
    let live = true;
    void loadController().then((loaded) => live && setController(loaded));
    return () => {
      live = false;
    };
  }, []);

  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getDictationState ?? (() => IDLE),
    () => IDLE,
  );
  const mine = state.kind === "listening" && controller?.getDictationTarget() === field();
  // A session in another field, or one still transcribing or failed, owns the single recorder.
  const busy = state.kind === "transcribing" || state.kind === "error" || (state.kind === "listening" && !mine);

  const latest = useRef({ field, onDictated });
  useEffect(() => {
    latest.current = { field, onDictated };
  });
  const listens = onDictated !== undefined;
  useEffect(() => {
    const element = latest.current.field();
    if (!controller || !listens || !element) return;
    const onEvent = () => latest.current.onDictated?.();
    element.addEventListener(DICTATED_EVENT, onEvent);
    return () => element.removeEventListener(DICTATED_EVENT, onEvent);
  }, [controller, listens]);

  const label = mine ? "Stop dictating" : "Dictate";
  return (
    <Hint label={mine ? label : "Dictate (or hold Right Option)"}>
      <Button
        type="button"
        variant={mine ? "secondary" : variant}
        size={size}
        className={className}
        aria-label={label}
        aria-pressed={mine}
        disabled={busy || disabled}
        // Pressing a button moves focus to it; the field must keep its caret.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const target = field();
          void (controller ? Promise.resolve(controller) : loadController()).then((loaded) => {
            if (loaded.getDictationState().kind === "listening") loaded.stopDictation();
            else if (target) loaded.startDictation(target);
          });
        }}
      >
        {mine ? <Square aria-hidden className="size-3.5 text-destructive" /> : <Mic aria-hidden />}
      </Button>
    </Hint>
  );
}
