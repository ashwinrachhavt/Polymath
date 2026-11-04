"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Switch } from "@/components/ui/switch";

/*
 * The "Show technical events" toggle, URL state like every other filter on
 * this page: technical rows (Tier 2 defaults and unknown actions) stay hidden
 * until the viewer asks for them, and turning them on is a link the back
 * button undoes. Changing it restarts the Load more walk at one page.
 */

const PAGER_KEYS = ["page", "cpage", "rpage", "pages"];

export function TechnicalToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const checked = params.get("technical") === "1";

  function toggle(next: boolean) {
    const search = new URLSearchParams(params.toString());
    if (next) search.set("technical", "1");
    else search.delete("technical");
    for (const key of PAGER_KEYS) search.delete(key);
    const qs = search.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <label className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
      <Switch checked={checked} onCheckedChange={toggle} aria-label="Show technical events" />
      Show technical events
    </label>
  );
}
