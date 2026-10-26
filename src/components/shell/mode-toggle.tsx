"use client";

import { BookOpen, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { loadPreferencesAction, savePreferencesAction } from "@/app/(workspace)/settings/actions";
import type { InterfaceModeValue } from "@/domains/identity/preferences";

/*
 * ASH-312: the deliberate switch. The header shows the resolved language and
 * one tap pins the other to the account; "auto" (the default) resolves by
 * time of day until the owner pins a side here or in Settings. The server
 * re-renders the shell in the saved mode, so the phone picks it up on next
 * load - the row, not this browser, is the record.
 */
export function ModeToggle({ resolved }: { resolved: "library" | "action" }) {
  const router = useRouter();
  const [version, setVersion] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void loadPreferencesAction()
      .then((result) => { if (result.ok) setVersion(result.preferences.version); })
      .catch(() => {});
  }, []);

  async function flip() {
    if (version === null || pending) return;
    const target: InterfaceModeValue = resolved === "library" ? "action" : "library";
    setPending(true);
    const result = await savePreferencesAction({ expectedVersion: version, interfaceMode: target }).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      // A version conflict means another device moved first; reload the row
      // and let the next tap decide against the fresh version.
      const fresh = await loadPreferencesAction().catch(() => null);
      if (fresh?.ok) setVersion(fresh.preferences.version);
      return;
    }
    setVersion(result.preferences.version);
    router.refresh();
  }

  const Icon = resolved === "library" ? BookOpen : Zap;
  return (
    <button
      type="button"
      onClick={() => void flip()}
      disabled={pending}
      aria-label={resolved === "library" ? "Switch to Action mode" : "Switch to Library mode"}
      title={resolved === "library" ? "Library mode - switch to Action" : "Action mode - switch to Library"}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md"
    >
      <Icon aria-hidden className="size-4" />
    </button>
  );
}
