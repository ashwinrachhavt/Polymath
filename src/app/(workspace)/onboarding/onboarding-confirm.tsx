"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OnboardingBrief } from "@/domains/agents/onboarding-brief";
import { confirmOnboardingBriefAction } from "./actions";

/*
 * The confirm card. The agent proposed a brief from the interview; nothing is
 * written until the person reads it, edits what it got wrong, and confirms.
 * The fields are the same four the form asks for — the card is the form's
 * values with the conversation as their draft.
 */
export function OnboardingConfirm({
  initial,
  profileVersion,
  onBack,
}: {
  initial: OnboardingBrief;
  profileVersion: number | null;
  /** Return to the conversation to correct something by talking instead. */
  onBack?: () => void;
}) {
  const router = useRouter();
  const [agentName, setAgentName] = useState(initial.agentName);
  const [role, setRole] = useState(initial.role);
  const [tools, setTools] = useState(initial.tools.join(", "));
  const [priorities, setPriorities] = useState(initial.priorities.join("; "));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await confirmOnboardingBriefAction({
        brief: {
          agentName: agentName.trim() || "Polymath",
          role: role.trim(),
          tools: tools.split(/[,\n]/).map((tool) => tool.trim()).filter(Boolean),
          priorities: priorities.split(/[;\n]/).map((priority) => priority.trim()).filter(Boolean),
        },
        profileVersion,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.replace("/polymath");
    } catch {
      setError("Onboarding could not be saved. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="screen-title">Is this right?</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          This is what your agent heard. Edit anything it got wrong — this brief
          is exactly what it starts knowing about you.
        </p>
      </header>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">What should your agent be called?</span>
          <Input value={agentName} onChange={(event) => setAgentName(event.target.value)} maxLength={60} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">What do you do?</span>
          <Input value={role} onChange={(event) => setRole(event.target.value)} maxLength={200} required />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Which tools do you work in? Comma-separated.</span>
          <Input value={tools} onChange={(event) => setTools(event.target.value)} maxLength={300} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">
            What do you most want to get done? Semicolon-separated.
          </span>
          <Textarea value={priorities} onChange={(event) => setPriorities(event.target.value)} rows={3} maxLength={1000} />
        </label>

        {error ? (
          <p role="status" className="text-destructive text-[12px]">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || !role.trim()}>
            {pending ? "Saving…" : "Confirm and start"}
            {!pending ? <Check aria-hidden className="size-4" /> : null}
          </Button>
          {onBack ? (
            <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
              Keep talking instead
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
