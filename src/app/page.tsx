import { redirect } from "next/navigation";

/*
 * Briefing is home (agents/product.md: briefing before browsing). The old
 * placeholder proved the identity seam; that now lives in the shell's header,
 * where it belongs.
 */
export default function Home() {
  redirect("/apps/command-center/briefing");
}
