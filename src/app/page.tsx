import { redirect } from "next/navigation";

/*
 * Briefing is home (agents/product.md: briefing before browsing). The old
 * placeholder proved the identity seam; that now lives in the shell's header,
 * where it belongs.
 *
 * With three apps the root has to pick one, and Command Center is the app whose
 * question you ask first — "what is happening, what do I owe" — so the brief is
 * where the day starts. The switcher is one click from there.
 */
export default function Home() {
  redirect("/command-center/briefing");
}
