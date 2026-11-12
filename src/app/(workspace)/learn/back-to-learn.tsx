import { ArrowLeft } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

/** The one way back from a Learn subpage, beside its title. */
export function BackToLearn() {
  return <IconButton href="/learn" label="Back to Learn" icon={<ArrowLeft aria-hidden className="size-4" />} />;
}
