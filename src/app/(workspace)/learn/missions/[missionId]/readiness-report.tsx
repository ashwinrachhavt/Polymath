"use client";

import Link from "next/link";
import type { MissionReport } from "@/domains/learning/mission-mock";
import type { MissionView } from "@/domains/learning/missions";
import { CONCEPT_STATUS_COPY } from "@/domains/learning/concept-status";

/*
 * The readiness report: for each concept, what the sitting showed unaided,
 * in the person's own words, beside the source passage. The overall sentence
 * says "not ready yet" unless every concept is proven, and names exactly what
 * to work on. An uncertain answer is shown as "needs your own check" and is
 * never counted as a pass.
 */

export function ReadinessReport({ mission, report }: { mission: MissionView; report: MissionReport }) {
  return (
    <section aria-labelledby="readiness-title" className="panel rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="readiness-title" className="font-medium">
          Readiness report
        </h2>
        <span
          data-ready={report.ready}
          className={
            "rounded-full border px-2 py-0.5 text-xs " +
            (report.ready ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground")
          }
        >
          {report.ready ? "Ready" : "Not ready yet"}
        </span>
      </div>
      <p className="mt-2 text-sm">{report.overall}</p>
      <ul className="mt-4 flex flex-col gap-3">
        {report.perConcept.map((row) => (
          <li key={row.missionConceptId} className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 font-medium break-words">{row.name}</h3>
              <span
                data-concept-status={row.status}
                className={
                  "shrink-0 rounded-full border px-2 py-0.5 text-xs " +
                  (row.status === "proven"
                    ? "border-border text-foreground"
                    : "border-dashed border-border text-muted-foreground")
                }
              >
                {CONCEPT_STATUS_COPY[row.status].label}
              </span>
            </div>
            {row.question ? <p className="mt-2 text-sm font-medium">{row.question}</p> : null}
            {row.answer ? (
              <div className="mt-2 border-l-2 border-border pl-3">
                <p className="text-xs text-muted-foreground">You wrote</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{row.answer}</p>
              </div>
            ) : null}
            <p className="mt-2 text-sm">{row.verdict}</p>
            {row.feedback ? <p className="mt-1 text-sm text-muted-foreground">{row.feedback}</p> : null}
            {row.evidence.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {row.evidence.map((quote, index) => (
                  <li key={index} className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
                    “{quote.quote}” <span className="block">{quote.source.title}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href="/learn" className="text-sm font-medium underline underline-offset-4">
          Back to Learn
        </Link>
        <Link href={`/learn/missions/${mission.id}/mock?retake=1`} className="text-sm underline underline-offset-4">
          Retake the mock
        </Link>
      </div>{" "}
    </section>
  );
}
