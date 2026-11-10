"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
export { Select } from "@/components/ui/select";

export function Destination({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href}>{children}</Link>
    </Button>
  );
}
export function Inspector({
  title,
  description,
  trigger,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function DisabledAction({ children, reason }: { children: ReactNode; reason: string }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
      <p className="text-xs text-muted-foreground">{reason}</p>
    </div>
  );
}
export function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-8 items-center gap-2 text-body-dense">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      {label}
    </label>
  );
}
