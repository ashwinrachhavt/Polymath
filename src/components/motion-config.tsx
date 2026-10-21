"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/*
 * The single Motion transition. Kept under 200ms so an animation never delays
 * a read, a save, or a navigation. `as const` preserves the cubic-bezier tuple
 * shape Motion expects.
 */
export const motionTransition = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const;

/*
 * `reducedMotion="user"` makes Motion honour the OS setting for every animation
 * in the tree, which the CSS block in globals.css cannot do for JS-driven
 * animation. The in-app "Reduce motion" preference is deliberately not wired in
 * here: this provider renders inside the server layout and must not read a
 * client store.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
