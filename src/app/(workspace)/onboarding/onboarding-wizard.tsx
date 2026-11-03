"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Check, Plus, Sparkles } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { motionTransition } from "@/components/motion-config";
import { ONBOARDING_STEPS, type OnboardingDraft, type OnboardingStep } from "@/domains/agents/onboarding-assist";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { completeOnboardingAction, refineOnboardingDraftAction, saveOnboardingProgressAction } from "./actions";
import { ROLE_OPTIONS, parseList, suggestionsForRole } from "./wizard-options";

/*
 * The detached onboarding wizard. Four steps of forms — role, tools and
 * priorities, the person's own words, then an editable review — where the
 * chat island used to stream an interview. There is no run anywhere in this
 * component: no stream, no poll, no spend reservation. Position is the
 * session row (the page hands in the persisted step and draft, and every
 * step change persists again), the one assist is a single awaited action,
 * and the confirm is the unchanged commit path every onboarding shape
 * shares (completeOnboarding).
 *
 * Server-derived state, per the page's contract: everything this component
 * knows about where the person is arrives as props; the client state below
 * is the working copy, never load-bearing. A reload re-renders from the row.
 */

const TOOLS_SEPARATOR = /[,\n]/;
const PRIORITIES_SEPARATOR = /[;\n]/;

const STEP_LABELS: Record<OnboardingStep, string> = {
  role: "What you do",
  priorities: "Tools and what matters",
  words: "In your own words",
  review: "Review",
};

export type OnboardingWizardProps = {
  /** The persisted step (the session row's), already collapsed to a valid one by readWizardState. */
  step: OnboardingStep;
  /** The persisted draft: selections so far plus the freeform words. Null on a fresh wizard. */
  draft: OnboardingDraft | null;
  /**
   * What a legacy interview run's thread could salvage. Seeds the fields at
   * step one — never the session draft — until the person confirms the
   * values still apply (the reload decision's contract).
   */
  prefill?: Partial<OnboardingBrief>;
  /** Why the wizard is (re)starting: a legacy run's failure or extraction notice. */
  notice?: string | null;
  /**
   * The polymath profile version this review renders at; the confirm races
   * on it. Null when no profile exists yet — a first confirm has nothing to
   * conflict with.
   */
  profileVersion: number | null;
};

export function OnboardingWizard({ step: initialStep, draft, prefill, notice, profileVersion }: OnboardingWizardProps) {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(initialStep);

  // The working copy. Persisted draft first, salvage prefill filling the
  // gaps — prefill is a suggestion the person sees in the field, not a fact.
  const [roleText, setRoleText] = useState(draft?.role ?? prefill?.role ?? "");
  const [toolsText, setToolsText] = useState((draft?.tools ?? prefill?.tools ?? []).join(", "));
  const [prioritiesText, setPrioritiesText] = useState((draft?.priorities ?? prefill?.priorities ?? []).join("; "));
  const [freeform, setFreeform] = useState(draft?.freeform ?? "");
  const [agentName, setAgentName] = useState(draft?.agentName ?? prefill?.agentName ?? "Polymath");

  // The one assist. Pending shows a status line (never a spinner — the
  // repo's rule for model passes); a token ref makes Cancel mean something
  // when the result lands after the person gave up waiting.
  const [assist, setAssist] = useState<{ status: "idle" | "pending" | "error"; error: string | null }>({
    status: "idle",
    error: null,
  });
  const assistTokenRef = useRef(0);

  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const tools = parseList(toolsText, TOOLS_SEPARATOR);
  const priorities = parseList(prioritiesText, PRIORITIES_SEPARATOR);

  /** What the wizard would persist if it stopped here. */
  const composeDraft = (): OnboardingDraft => ({
    ...(roleText.trim() ? { role: roleText.trim() } : {}),
    ...(tools.length ? { tools } : {}),
    ...(priorities.length ? { priorities } : {}),
    ...(freeform.trim() ? { freeform: freeform.trim() } : {}),
    ...(agentName.trim() && agentName.trim() !== "Polymath" ? { agentName: agentName.trim() } : {}),
  });

  const goTo = (next: OnboardingStep, draftOverride?: OnboardingDraft) => {
    setStep(next);
    // Progress is best-effort: a failed save degrades a mid-wizard reload to
    // the last persisted step — no work is lost, and the confirm commit is
    // the only truth that matters. The wizard never blocks on its own
    // bookkeeping.
    void saveOnboardingProgressAction({ step: next, draft: draftOverride ?? composeDraft() }).catch(() => {
      // Degrade by design — see the comment above.
    });
  };

  const applyBrief = (brief: OnboardingBrief) => {
    setAgentName(brief.agentName);
    setRoleText(brief.role);
    setToolsText(brief.tools.join(", "));
    setPrioritiesText(brief.priorities.join("; "));
  };

  async function runAssist() {
    const token = ++assistTokenRef.current;
    setAssist({ status: "pending", error: null });
    try {
      const result = await refineOnboardingDraftAction({
        ...(roleText.trim() ? { role: roleText.trim() } : {}),
        ...(tools.length ? { tools } : {}),
        ...(priorities.length ? { priorities } : {}),
        freeform: freeform.trim(),
      });
      if (assistTokenRef.current !== token) return; // cancelled mid-flight: the words stay as written
      if (!result.ok) {
        // Labelled failure; the manual fields are untouched and authoritative.
        setAssist({ status: "error", error: result.error });
        return;
      }
      const draftOverride: OnboardingDraft = {
        ...result.draft,
        ...(freeform.trim() ? { freeform: freeform.trim() } : {}),
      };
      applyBrief(result.draft);
      goTo("review", draftOverride);
    } catch {
      if (assistTokenRef.current !== token) return;
      setAssist({
        status: "error",
        error: "The assist could not be reached. Fill the fields in yourself — they carry the same weight.",
      });
    }
  }

  function cancelAssist() {
    assistTokenRef.current += 1;
    setAssist({ status: "idle", error: null });
  }

  async function confirm() {
    if (confirmPending) return;
    setConfirmPending(true);
    setConfirmError(null);
    try {
      const result = await completeOnboardingAction({
        agentName: agentName.trim() || "Polymath",
        role: roleText.trim(),
        tools,
        priorities,
        ...(profileVersion != null ? { expectedVersion: profileVersion } : {}),
      });
      if (!result.ok) {
        // A conflict (or any labelled failure) re-renders the review with
        // the person's draft intact — nothing to re-type.
        setConfirmError(result.message);
        return;
      }
      router.replace("/polymath");
    } catch {
      setConfirmError("Onboarding could not be saved. Check the connection and try again.");
    } finally {
      setConfirmPending(false);
    }
  }

  const suggestions = suggestionsForRole(roleText);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <ProgressDots current={step} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={motionTransition}
        >
          {step === "role" ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                goTo("priorities");
              }}
            >
              <header className="flex flex-col gap-1">
                <h1 className="screen-title">What do you do?</h1>
                <p className="screen-description">
                  Your agent is yours, not a generic assistant: it starts knowing who you are and aims every answer at
                  what matters to you.
                </p>
              </header>

              {notice ? (
                <p role="status" className="text-muted-foreground text-body-dense leading-relaxed">
                  {notice}
                </p>
              ) : null}

              <fieldset className="flex flex-col gap-2">
                <legend className="text-body-dense font-medium">Closest fit, or write your own below.</legend>
                <div className="flex flex-wrap gap-1.5">
                  {ROLE_OPTIONS.map((role) => (
                    <Chip
                      key={role}
                      pressed={roleText === role}
                      onToggle={() => setRoleText(role === roleText ? "" : role)}
                    >
                      {role}
                    </Chip>
                  ))}
                </div>
              </fieldset>

              <label className="flex flex-col gap-1.5">
                <span className="text-body-dense font-medium">Your role — team or company welcome.</span>
                <Input
                  autoFocus
                  value={roleText}
                  onChange={(event) => setRoleText(event.target.value)}
                  placeholder="Founder at a two-person climate studio"
                  maxLength={200}
                />
              </label>

              <div className="flex items-center gap-2">
                <Button type="submit" disabled={!roleText.trim()}>
                  Continue
                </Button>
                {!roleText.trim() ? <p className="text-muted-foreground text-label">One line is plenty.</p> : null}
              </div>
            </form>
          ) : null}

          {step === "priorities" ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                goTo("words");
              }}
            >
              <header className="flex flex-col gap-1">
                <h1 className="screen-title">Tools and what matters</h1>
                <p className="screen-description">
                  Skippable — pick what fits, add what&apos;s missing, or say it in words next.
                </p>
              </header>

              <ChipGroup
                legend="Tools you work in"
                options={suggestions.tools}
                selected={tools}
                onToggle={(tool) => {
                  const next = tools.includes(tool) ? tools.filter((item) => item !== tool) : [...tools, tool];
                  setToolsText(next.join(", "));
                }}
                onAdd={(tool) => setToolsText([...tools, tool].join(", "))}
                addPlaceholder="Add a tool"
                addLabel="Add tool"
              />
              <ChipGroup
                legend="What matters most right now"
                options={suggestions.priorities}
                selected={priorities}
                onToggle={(priority) => {
                  const next = priorities.includes(priority)
                    ? priorities.filter((item) => item !== priority)
                    : [...priorities, priority];
                  setPrioritiesText(next.join("; "));
                }}
                onAdd={(priority) => setPrioritiesText([...priorities, priority].join("; "))}
                addPlaceholder="Add a priority"
                addLabel="Add priority"
              />

              <div className="flex items-center gap-2">
                <Button type="submit">Continue</Button>
                <Button type="button" variant="ghost" onClick={() => goTo("role")}>
                  Back
                </Button>
              </div>
            </form>
          ) : null}

          {step === "words" ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                goTo("review");
              }}
            >
              <header className="flex flex-col gap-1">
                <h1 className="screen-title">In your own words</h1>
                <p className="screen-description">
                  Anything else your agent should know? Or let it compose the brief from what you&apos;ve told it.
                </p>
              </header>

              <Textarea
                autoFocus
                rows={6}
                maxLength={4_000}
                value={freeform}
                onChange={(event) => setFreeform(event.target.value)}
                placeholder="What's on your plate? What should come off it first?"
                aria-label="In your own words"
              />

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!freeform.trim() || assist.status === "pending"}
                    onClick={() => void runAssist()}
                  >
                    <Sparkles aria-hidden />
                    Polish with Polymath
                  </Button>
                  {assist.status === "pending" ? (
                    <span role="status" className="text-muted-foreground flex items-center gap-2 text-label">
                      Reading your answers…
                      <button
                        type="button"
                        onClick={cancelAssist}
                        className="hover:text-foreground underline underline-offset-2"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : null}
                </div>
                {assist.status === "error" && assist.error ? (
                  <p role="alert" className="text-destructive text-label">
                    {assist.error}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <Button type="submit">Continue</Button>
                <Button type="button" variant="ghost" onClick={() => goTo("priorities")}>
                  Back
                </Button>
              </div>
            </form>
          ) : null}

          {step === "review" ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              <header className="flex flex-col gap-1">
                <h1 className="screen-title">Is this right?</h1>
                <p className="screen-description">
                  This is what your agent starts knowing about you. Edit anything — the fields carry the same weight as
                  your words.
                </p>
              </header>

              <label className="flex flex-col gap-1.5">
                <span className="text-body-dense font-medium">What should your agent be called?</span>
                <Input value={agentName} onChange={(event) => setAgentName(event.target.value)} maxLength={60} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-body-dense font-medium">What do you do?</span>
                <Input
                  value={roleText}
                  onChange={(event) => setRoleText(event.target.value)}
                  maxLength={200}
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-body-dense font-medium">Which tools do you work in? Comma-separated.</span>
                <Input value={toolsText} onChange={(event) => setToolsText(event.target.value)} maxLength={300} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-body-dense font-medium">
                  What do you most want to get done? Semicolon-separated.
                </span>
                <Textarea
                  value={prioritiesText}
                  onChange={(event) => setPrioritiesText(event.target.value)}
                  rows={3}
                  maxLength={1000}
                />
              </label>

              {confirmError ? (
                <p role="alert" className="text-destructive text-label">
                  {confirmError}
                </p>
              ) : null}

              <div className="flex items-center gap-2">
                <Button type="submit" disabled={confirmPending || !roleText.trim()}>
                  {confirmPending ? "Saving…" : "Confirm and start"}
                  {!confirmPending ? <Check aria-hidden /> : null}
                </Button>
                <Button type="button" variant="ghost" disabled={confirmPending} onClick={() => goTo("words")}>
                  Back
                </Button>
              </div>
            </form>
          ) : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** The single-select role chip, in the house pill idiom. */
function Chip({ pressed, onToggle, children }: { pressed: boolean; onToggle: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "inline-flex min-h-7 items-center rounded-full border px-2.5 text-label transition-colors",
        pressed ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A multi-select chip group: the role's suggestions as chips, custom
 * entries joining them inline. Options already selected render pressed;
 * custom entries always do.
 */
function ChipGroup({
  legend,
  options,
  selected,
  onToggle,
  onAdd,
  addPlaceholder,
  addLabel,
}: {
  legend: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onAdd: (value: string) => void;
  addPlaceholder: string;
  addLabel: string;
}) {
  const [custom, setCustom] = useState("");
  const add = () => {
    const value = custom.trim();
    if (!value) return;
    onAdd(value);
    setCustom("");
  };
  const customs = selected.filter((item) => !options.includes(item));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-body-dense font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Chip key={option} pressed={selected.includes(option)} onToggle={() => onToggle(option)}>
            {option}
          </Chip>
        ))}
        {customs.map((item) => (
          <Chip key={item} pressed onToggle={() => onToggle(item)}>
            {item}
          </Chip>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder={addPlaceholder}
          maxLength={200}
          className="max-w-xs"
          aria-label={addPlaceholder}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={addLabel}
          disabled={!custom.trim()}
          onClick={add}
        >
          <Plus aria-hidden />
        </Button>
      </div>
    </fieldset>
  );
}

/** The four-step header: dots and a spoken step line, keyboard and SR readable. */
function ProgressDots({ current }: { current: OnboardingStep }) {
  const index = ONBOARDING_STEPS.indexOf(current);
  return (
    <nav aria-label="Onboarding progress" className="flex items-center gap-2">
      {ONBOARDING_STEPS.map((s, i) => (
        <span key={s} className="flex items-center gap-2">
          <span
            aria-current={s === current ? "step" : undefined}
            title={STEP_LABELS[s]}
            className={cn(
              "size-2 rounded-full transition-colors",
              i < index ? "bg-foreground/40" : i === index ? "bg-app-accent" : "bg-border",
            )}
          />
          {i < ONBOARDING_STEPS.length - 1 ? <span aria-hidden className="h-px w-8 bg-border" /> : null}
        </span>
      ))}
      <span className="sr-only">
        Step {index + 1} of {ONBOARDING_STEPS.length}: {STEP_LABELS[current]}
      </span>
    </nav>
  );
}
