"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { completeOnboardingAction } from "./actions";

/*
 * The onboarding interview. Three answers and a name — what the person does,
 * which tools they live in, what they most want done, and what their agent is
 * called. No progress bar, no steps: it is one conversation's worth of shape,
 * rendered as one form on purpose. What is learned becomes the supervisor
 * agent's brief; the person meets an agent that already knows them.
 */
export function OnboardingInterview({
  initial,
  notice,
}: {
  /*
   * The extraction-failure surface: when the interview's brief could not be
   * parsed, the flow routes here with whatever fields could be salvaged from
   * the thread, so the person corrects rather than re-types.
   */
  initial?: { agentName?: string; role?: string; tools?: string[]; priorities?: string[] };
  /** Why the form is standing in for the conversation; omitted on the plain form. */
  notice?: string;
} = {}) {
  const router = useRouter();
  const [agentName, setAgentName] = useState(initial?.agentName ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [tools, setTools] = useState(initial?.tools?.join(", ") ?? "");
  const [priorities, setPriorities] = useState(initial?.priorities?.join("; ") ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await completeOnboardingAction({
        agentName: agentName.trim() || "Alfred",
        role: role.trim(),
        tools: tools
          .split(/[,\n]/)
          .map((tool) => tool.trim())
          .filter(Boolean),
        priorities: priorities
          .split(/[;\n]/)
          .map((priority) => priority.trim())
          .filter(Boolean),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.replace("/alfred");
    } catch {
      setError("Onboarding could not be saved. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Meet your agent</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          This agent is yours: your representation, not a generic assistant.
          Tell it who you are and what matters; it starts knowing that.
        </p>
      </header>

      {notice ? (
        <p role="status" className="text-muted-foreground text-[13px] leading-relaxed">
          {notice}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">What should your agent be called?</span>
          <Input
            value={agentName}
            onChange={(event) => setAgentName(event.target.value)}
            placeholder="Alfred"
            maxLength={60}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">What do you do?</span>
          <Input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="Software engineer who lives in Notion, Gmail, and Linear"
            maxLength={200}
            required
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Which tools do you work in? Comma-separated.</span>
          <Input
            value={tools}
            onChange={(event) => setTools(event.target.value)}
            placeholder="Notion, Gmail, Linear, Calendly"
            maxLength={300}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">
            What do you most want to get done? Semicolon-separated.
          </span>
          <Textarea
            value={priorities}
            onChange={(event) => setPriorities(event.target.value)}
            placeholder="Turn bank statements into classified ledgers; keep the research library searchable; write technical blogs"
            rows={3}
            maxLength={1000}
          />
        </label>

        {error ? (
          <p role="status" className="text-destructive text-[12px]">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || !role.trim()}>
            {pending ? "Saving…" : "Start working"}
            {!pending ? <Check aria-hidden className="size-4" /> : null}
          </Button>
          <p className="text-muted-foreground text-[12px]">
            You can reshape your agent any time in Settings.
          </p>
        </div>
      </form>
    </div>
  );
}
