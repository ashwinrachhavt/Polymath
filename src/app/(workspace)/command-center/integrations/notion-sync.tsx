"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { syncNotionAction } from "./actions";

/*
 * Sync a Notion account from one page: paste the link of the page that holds
 * your study material and Polymath reads it and everything under it. The link
 * is remembered in this browser, so the next sync is one click. Left empty,
 * the sync reads every page the connection can see.
 */

const storageKey = (accountId: string) => `polymath:notion-root:${accountId}`;

function remembered(accountId: string): string {
  try {
    return window.localStorage.getItem(storageKey(accountId)) ?? "";
  } catch {
    return "";
  }
}

export function NotionSync({ accountId }: { accountId: string }) {
  const [rootUrl, setRootUrl] = useState(() => (typeof window === "undefined" ? "" : remembered(accountId)));
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function sync() {
    setMessage(null);
    startTransition(async () => {
      const result = await syncNotionAction({ accountId, rootUrl });
      if (result.ok) {
        try {
          if (rootUrl.trim()) window.localStorage.setItem(storageKey(accountId), rootUrl.trim());
        } catch {
          // Remembering the link is a convenience; the sync already ran.
        }
        setMessage({ text: result.summary, failed: false });
      } else {
        setMessage({ text: result.error, failed: true });
      }
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={rootUrl}
          onChange={(event) => setRootUrl(event.target.value)}
          placeholder="Link to the Notion page to import (optional)"
          aria-label="Link to the Notion page to import"
          className="h-8 min-w-0 flex-1"
          disabled={pending}
        />
        <IconButton
          label={pending ? "Starting…" : "Sync now"}
          size="icon-sm"
          icon={<RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} />}
          disabled={pending}
          onClick={sync}
        />
      </div>
      {message ? (
        <p role={message.failed ? "alert" : "status"} className="text-body-dense text-muted-foreground">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
