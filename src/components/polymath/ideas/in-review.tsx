"use client";

import { AnimatePresence, motion } from "motion/react";
import { ZettelDecisions } from "@/app/(workspace)/polymath/knowledge/decision-buttons";
import { motionTransition } from "@/components/motion-config";
import type { PendingZettelProposal } from "@/domains/knowledge/zettels";

/*
 * The "In review" queue on Ideas: every pending zettel proposal in the
 * workspace, from both source kinds, each one decision away from leaving.
 * The vault's decision buttons are reused as-is, so an accept here and an
 * accept in the workbench are the same control with the same errors. Rows
 * read like the vault's list (hairline dividers, no boxes) to distinguish
 * the working queue from the saved cards below, and get the same motion: a
 * decided row fades out where it stood and the queue closes up behind it.
 */

export function InReview({ proposals }: { proposals: PendingZettelProposal[] }) {
  return (
    <section id="in-review" aria-label="Proposals in review" className="scroll-mt-16 pb-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-ui font-medium">In review</h2>
        <span className="text-label text-muted-foreground tabular-nums">{proposals.length} waiting</span>
      </div>
      <motion.ul layout className="flex flex-col">
        <AnimatePresence initial={false}>
          {proposals.map((proposal) => (
            <motion.li
              key={proposal.id}
              layout
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={motionTransition}
              className="border-border flex flex-col gap-1.5 border-b py-3 last:border-b-0"
            >
              <h3 className="text-body font-medium">{proposal.title}</h3>
              <p className="text-body-dense">{proposal.claim}</p>
              <blockquote className="border-border/60 text-muted-foreground line-clamp-2 border-l-2 pl-2 text-label italic">
                {proposal.quote}
              </blockquote>
              <p className="text-label text-muted-foreground">from {proposal.source.title}</p>
              {proposal.duplicateOf ? (
                <p className="text-label text-muted-foreground">
                  Possible duplicate of &ldquo;{proposal.duplicateOf.title}&rdquo;
                </p>
              ) : null}
              <ZettelDecisions proposalId={proposal.id} />
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
    </section>
  );
}
