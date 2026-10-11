import { cn } from "cn";

/*
 * Numbers the owner reads as instrument output: counts, timers, spend, run
 * ids, state labels. Monospace plus tabular figures — the `.readout` class in
 * globals.css — so a live value does not reflow as it changes, and so a count
 * looks measured rather than written.
 *
 * This is also Axiom's inheritance from the design reference: the one motif
 * worth taking from it was monospace for machine facts against a quiet ground.
 */

export function Readout({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="readout" className={cn("readout", className)} {...props} />;
}
