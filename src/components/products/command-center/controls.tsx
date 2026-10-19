"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
export { Select } from "@/components/ui/select";

export function Destination({ screen, children }: { screen: string; children: ReactNode }) {
  return <Button variant="outline" size="sm" asChild><Link href={`/apps/command-center/${screen}`}>{children}</Link></Button>;
}
export function Inspector({ title, description, trigger, children, open, onOpenChange }: { title: string; description: string; trigger: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogTrigger asChild>{trigger}</DialogTrigger><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription>{children}</DialogContent></Dialog>;
}
export function DisabledAction({ children, reason }: { children: ReactNode; reason: string }) {
  return <div className="flex flex-col items-start gap-1.5"><Button variant="outline" size="sm" disabled>{children}</Button><p className="text-xs text-muted-foreground">{reason}</p></div>;
}
export function ConfirmDelete({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); setConfirmed(false); }}><DialogTrigger asChild><Button variant="outline">Delete {name}</Button></DialogTrigger><DialogContent><DialogTitle>Delete {name} from preview?</DialogTitle><DialogDescription>This removes the local record. No external system is changed. Related notes and tasks are retained. This cannot be undone except by resetting the whole sample workspace.</DialogDescription><Check label={`I confirm deletion of ${name}`} checked={confirmed} onChange={setConfirmed}/><Button disabled={!confirmed} onClick={() => { onConfirm(); setOpen(false); }}>Confirm local deletion</Button></DialogContent></Dialog>;
}
export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className="flex min-h-8 items-center gap-2 text-[13px]"><input type="checkbox" className="size-4 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled}/>{label}</label>;
}
