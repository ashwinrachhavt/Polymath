"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/select";
import { PAGE_SIZES } from "@/lib/list-params";

export function PageSizeSelect({ value }: { value: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <label className="text-muted-foreground flex items-center gap-2 text-xs">
      <span>Rows</span>
      <Select
        aria-label="Rows per page"
        className="w-[4.5rem]"
        value={String(value)}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          next.set("size", e.target.value);
          next.delete("page");
          router.replace(`${pathname}?${next.toString()}`, { scroll: false });
        }}
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </label>
  );
}
