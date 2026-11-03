import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { OnboardingDraft } from "@/domains/agents/onboarding-assist";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { OnboardingWizard } from "../../onboarding/onboarding-wizard";
import { OnboardingWelcome } from "../../polymath/onboarding-welcome";

export const metadata = {
  title: "Onboarding fixtures",
  robots: { index: false, follow: false },
};

/*
 * Pixel fixture for the onboarding surfaces (ASH-296). The shared e2e
 * workspace is provisioned already-onboarded and no spec may flip that
 * marker, so the real /onboarding page can only ever show its gate redirect
 * in the harness. This route renders the same components, in the same
 * page-content wrapper the page uses, against fixture props - no database
 * marker moves, no Eve call, no spend. Development and CI only: a production
 * build answers 404.
 *
 * The wizard states are the page's reload decision rendered one by one:
 * fresh, the three selection steps (s1-s3), the review, and the legacy-run
 * salvage entry. Two more states are interactions, not mounts, and the e2e
 * spec drives them from `s3` and `review`: `s3-assist-pending` (the assist
 * POST is held) and `s3-assist-failed` (the assist POST is answered 500);
 * `review-conflict` is what confirming here produces, because profileVersion
 * -1 below always loses the race guard. No fixture can ever commit
 * onboarding: the wizard's confirm goes through the real
 * completeOnboardingAction, whose expectedVersion check fails against -1
 * before any write lands.
 */

const FIXTURE_BRIEF: OnboardingBrief = {
  agentName: "Polymath",
  role: "Chief of staff for a solo founder",
  tools: ["Gmail", "Linear", "Google Calendar"],
  priorities: ["Keep the inbox at zero", "Never let a renewal surprise me"],
};

const S1_DRAFT: OnboardingDraft = { role: "Founder at a two-person climate studio" };

const S2_DRAFT: OnboardingDraft = {
  role: "Founder",
  tools: ["Notion", "Gmail", "Google Calendar"],
  priorities: ["Keep the inbox at zero"],
};

const S3_DRAFT: OnboardingDraft = {
  role: "Founder",
  tools: ["Notion"],
  freeform: "I read long reports in the morning and want the claims pulled out before I'm at my desk.",
};

const SALVAGE_NOTICE =
  "The interview could not finish. What it captured is pre-filled below — correct it and continue.";

/** Always loses the confirm's race guard — the fixture can never commit. */
const CONFLICT_VERSION = -1;

export default function OnboardingFixturesPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  // Production-inaccessibility is decided before any dynamic data loads.
  if (process.env.NODE_ENV === "production") notFound();
  // URL state under cacheComponents belongs inside a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <Fixture searchParams={searchParams} />
    </Suspense>
  );
}

async function Fixture({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state = "fresh" } = await searchParams;

  const wrapper = (child: React.ReactNode) => (
    <div className="page-content flex flex-1 items-center justify-center pt-16">{child}</div>
  );

  switch (state) {
    case "fresh":
      return wrapper(<OnboardingWizard step="role" draft={null} profileVersion={CONFLICT_VERSION} />);
    case "s1":
      return wrapper(<OnboardingWizard step="role" draft={S1_DRAFT} profileVersion={CONFLICT_VERSION} />);
    case "s2":
      return wrapper(<OnboardingWizard step="priorities" draft={S2_DRAFT} profileVersion={CONFLICT_VERSION} />);
    case "s3":
      return wrapper(<OnboardingWizard step="words" draft={S3_DRAFT} profileVersion={CONFLICT_VERSION} />);
    case "review":
      return wrapper(<OnboardingWizard step="review" draft={FIXTURE_BRIEF} profileVersion={CONFLICT_VERSION} />);
    /*
     * The page's reload surface for a failed legacy interview run with
     * salvage (QA F5): the notice leads and the salvage prefills step one's
     * fields — never an auto-start.
     */
    case "salvage":
      return wrapper(
        <OnboardingWizard
          step="role"
          draft={null}
          prefill={{ agentName: "Polymath", role: "Chief of staff for a solo founder" }}
          notice={SALVAGE_NOTICE}
          profileVersion={CONFLICT_VERSION}
        />,
      );
    case "welcome":
      return wrapper(
        <OnboardingWelcome
          role="Chief of staff for a solo founder"
          tools={["Gmail", "Linear", "Google Calendar"]}
          priorities={["Keep the inbox at zero", "Never let a renewal surprise me"]}
          personifiedBrief={null}
        />,
      );
    default:
      return notFound();
  }
}
