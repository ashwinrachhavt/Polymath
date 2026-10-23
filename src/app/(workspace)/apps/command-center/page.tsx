import CommandCenterScreen from "@/components/products/command-center/screen-dispatch";
import { clerkConfigured } from "@/lib/clerk";

export default function Page() {
  return <CommandCenterScreen screen="briefing" browserPreview={!clerkConfigured}/>;
}
