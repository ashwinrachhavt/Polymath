import { focusRecords } from "@/components/workspace/rewards";
import type { Task, WorkspaceState } from "@/components/workspace/types";

/*
 * The NeuralFlow stone catalog: names, themes and art come from the frozen
 * NeuralFlow donor (`src/lib/gamification/catalog.ts`, `public/*.png`), resized
 * into `public/neuralflow/stones`. Only stones with a `rewardTitle` are awarded
 * in Polymath; the rest are shown locked so the collection keeps its shape without
 * implying a rule that does not exist yet.
 */
export type StoneSlug = "quartz" | "garnet" | "topaz" | "emerald" | "sapphire" | "ruby" | "diamond";
export type Stone = { slug: StoneSlug; name: string; theme: string; rarity: "Common" | "Rare" | "Epic" | "Legendary"; image: string; rewardTitle?: string; rule: string };

export const stoneCatalog: Stone[] = [
  { slug: "quartz", name: "Quartz of Clarity", theme: "Clarity and starting", rarity: "Common", image: "/neuralflow/stones/quartz.webp", rewardTitle: "Clarity stone", rule: "Finish a task-linked focus interval and record its outcome." },
  { slug: "garnet", name: "Garnet of Recovery", theme: "Recovery and reflection", rarity: "Common", image: "/neuralflow/stones/garnet.webp", rule: "No earning rule in Polymath yet." },
  { slug: "topaz", name: "Topaz of Consistency", theme: "Consistency", rarity: "Rare", image: "/neuralflow/stones/topaz.webp", rule: "No earning rule in Polymath yet." },
  { slug: "emerald", name: "Emerald of Learning", theme: "Learning and growth", rarity: "Rare", image: "/neuralflow/stones/emerald.webp", rule: "No earning rule in Polymath yet." },
  { slug: "sapphire", name: "Sapphire of Deep Focus", theme: "Deep focus", rarity: "Epic", image: "/neuralflow/stones/sapphire.webp", rule: "No earning rule in Polymath yet." },
  { slug: "ruby", name: "Ruby of Courage", theme: "Courage and shipping", rarity: "Epic", image: "/neuralflow/stones/ruby.webp", rule: "No earning rule in Polymath yet." },
  { slug: "diamond", name: "Diamond of Mastery", theme: "Mastery", rarity: "Legendary", image: "/neuralflow/stones/diamond.webp", rule: "No earning rule in Polymath yet." },
];

export function stoneForReward(title: string): Stone | undefined {
  return stoneCatalog.find((stone) => stone.rewardTitle === title);
}

export type CollectionEntry = { key: string; title: string; stone?: Stone; earnable: boolean; earned: WorkspaceState["rewards"] };

/*
 * Every count comes from ledger entries. Earnable stones always appear, locked
 * catalog stones appear only under "all", and a ledger title with no catalog
 * stone is still listed so no recorded reward disappears from the collection.
 */
export function stoneCollection(rewards: WorkspaceState["rewards"], filter: "all" | "earned"): CollectionEntry[] {
  const catalog: CollectionEntry[] = stoneCatalog.map((stone) => ({ key: stone.slug, title: stone.rewardTitle ?? stone.name, stone, earnable: !!stone.rewardTitle, earned: stone.rewardTitle ? rewards.filter((reward) => reward.title === stone.rewardTitle) : [] }));
  const unmapped = [...new Set(rewards.map((reward) => reward.title))].filter((title) => !stoneForReward(title)).map((title) => ({ key: `ledger:${title}`, title, earnable: true, earned: rewards.filter((reward) => reward.title === title) }));
  const entries = [...catalog, ...unmapped];
  return filter === "earned" ? entries.filter((entry) => entry.earned.length > 0) : entries;
}

/* Share of the current interval completed, clamped for the forming-stone layer. */
export function formingProgress(elapsedSeconds: number, totalSeconds: number) {
  if (!(totalSeconds > 0)) return 0;
  return Math.min(1, Math.max(0, elapsedSeconds / totalSeconds));
}

/*
 * Every earned stone answers "what did I do that earned this?" from its own
 * session key. A key that does not parse says so rather than guessing.
 */
export function stoneReason(reward: WorkspaceState["rewards"][number], tasks: Pick<Task, "id" | "title">[]): string {
  const record = focusRecords([reward])[0];
  if (!record) return "Recorded in the local reward ledger; the session detail is not available.";
  const task = tasks.find((item) => item.id === record.taskId);
  return task ? `Completed a focus interval on "${task.title}".` : "Completed a focus interval on a task that is no longer in this preview.";
}
