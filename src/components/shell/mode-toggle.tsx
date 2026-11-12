"use client";

import { BookOpen, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import type { SaveShellPreference } from "@/components/shell/shell-preferences";
import { IconButton } from "@/components/ui/icon-button";

/*
 * ASH-312: the deliberate switch. The header shows the resolved language and
 * one tap pins the other to the account; "auto" (the default) resolves by
 * time of day until the owner pins a side here or in Settings. The server
 * re-renders the shell in the saved mode, so the phone picks it up on next
 * load - the row, not this browser, is the record.
 */
export function ModeToggle({
  resolved,
  disabled,
  onSave,
}: {
  resolved: "library" | "action";
  disabled: boolean;
  onSave: SaveShellPreference;
}) {
  const router = useRouter();

  async function flip() {
    const target = resolved === "library" ? "action" : "library";
    if (await onSave({ interfaceMode: target })) router.refresh();
  }

  const Icon = resolved === "library" ? BookOpen : Zap;
  return (
    <IconButton
      label={resolved === "library" ? "Switch to Action mode" : "Switch to Library mode"}
      icon={<Icon aria-hidden className="size-4" />}
      onClick={() => void flip()}
      disabled={disabled}
      className="text-muted-foreground"
    />
  );
}
