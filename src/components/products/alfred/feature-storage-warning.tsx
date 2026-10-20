"use client";

import { Button } from "@/components/ui/button";
import { useAlfredPreview } from "./preview-state";

export default function AlfredStorageWarning() {
  const { storageWarning, exportMetadata } = useAlfredPreview();
  if (!storageWarning) return null;
  return <div role="alert" className="panel mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-lg border-destructive/30 bg-destructive/10 p-3 text-[13px] md:mx-6"><p className="min-w-0 flex-1 leading-relaxed">{storageWarning}</p><Button type="button" variant="outline" onClick={exportMetadata}>Export feature history</Button></div>;
}
