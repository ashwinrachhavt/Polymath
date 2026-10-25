"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * The hard-blocked front door. When the agent runtime is not configured there
 * is no interview to have, and a form here would promise an agent the
 * deployment cannot run — so the page says what is missing, in product words,
 * and offers a retry. Deliberate: one polished path, no silent fallback.
 */
export function OnboardingStatusCard({ reason }: { reason: string }) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Agent runtime unavailable</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">{reason}</p>
      </header>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            router.refresh();
            // A refresh that changes nothing leaves the button live again.
            setTimeout(() => setChecking(false), 1500);
          }}
        >
          {checking ? "Checking…" : "Retry"}
        </Button>
        <p className="text-muted-foreground text-[12px]">
          Onboarding continues the moment the runtime is back.
        </p>
      </div>
    </div>
  );
}
