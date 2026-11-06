/*
 * The fact deck behind FactPoll. Each fact carries lowercase tags so a wait
 * surface can bias which facts show while it holds the person. The deck is
 * the product: every entry is written to be genuinely worth reading twice.
 */

export type PollFact = {
  id: string;
  topic: "science" | "philosophy";
  tags: string[];
  text: string;
};

export const pollFacts: PollFact[] = [
  {
    id: "sunlight-two-journeys",
    topic: "science",
    tags: ["light", "time", "astronomy"],
    text: "Sunlight reaches Earth in about eight minutes, yet a photon born in the Sun's core can wander a hundred thousand years before escaping the surface.",
  },
  {
    id: "honeybee-seasons",
    topic: "science",
    tags: ["time", "scale", "biology"],
    text: "A worker honeybee born in summer lives about six weeks; one born in autumn can live half a year. The season sets the length of its life.",
  },
  {
    id: "star-forged-atoms",
    topic: "science",
    tags: ["scale", "matter", "astronomy"],
    text: "Every atom in your body is older than the solar system. The hydrogen dates from the Big Bang and the rest was forged in dying stars.",
  },
  {
    id: "octopus-arm-mind",
    topic: "science",
    tags: ["biology", "mind"],
    text: "Two thirds of an octopus's neurons live in its arms. Each arm can taste and reach a decision before the central brain learns of it.",
  },
  {
    id: "ancient-water",
    topic: "science",
    tags: ["scale", "time", "water"],
    text: "Earth has held roughly the same water for four billion years. The molecules in your glass have been glacier, cloud, and ocean many times over.",
  },
  {
    id: "dna-two-meters",
    topic: "science",
    tags: ["scale", "biology", "data"],
    text: "Uncoiled, the DNA in a single one of your cells stretches about two meters. All of it, end to end, would reach past the Sun.",
  },
  {
    id: "wood-wide-web",
    topic: "science",
    tags: ["biology", "network", "connection"],
    text: "Trees trade sugar and chemical signals through underground fungal networks, and a dying tree sometimes transfers its carbon to its neighbors.",
  },
  {
    id: "neutron-star-spoon",
    topic: "science",
    tags: ["scale", "astronomy", "mass"],
    text: "A teaspoon of neutron star would weigh about as much as a mountain range. It is the collapsed core of a star that once sat quietly in the sky.",
  },
  {
    id: "glass-never-settled",
    topic: "science",
    tags: ["matter", "time", "waiting"],
    text: "Glass is a solid whose molecules never found a crystal to settle into. It is what a liquid looks like when it cools faster than it can decide.",
  },
  {
    id: "sleep-wash",
    topic: "science",
    tags: ["mind", "biology", "night"],
    text: "In deep sleep, fluid channels in the brain open and cerebrospinal fluid washes through, clearing the metabolic debris of the day's thinking.",
  },
  {
    id: "moonlight-delay",
    topic: "science",
    tags: ["light", "motion", "time"],
    text: "Light takes about 1.3 seconds to arrive from the Moon. Every look at the Moon is a look slightly into the past.",
  },
  {
    id: "prime-gaps",
    topic: "science",
    tags: ["math", "infinity", "pattern"],
    text: "Primes grow rarer as numbers grow, yet pairs like a billion-and-61 and a billion-and-63 keep appearing with no known limit and no explaining pattern.",
  },
  {
    id: "leaf-made-air",
    topic: "science",
    tags: ["light", "biology", "energy"],
    text: "Every oxygen molecule you breathe was released by a leaf, an alga, or a microbe. Photosynthesis has been re-airing the planet for over two billion years.",
  },
  {
    id: "tardigrade-tun",
    topic: "science",
    tags: ["biology", "survival", "scale"],
    text: "A tardigrade survives vacuum, near absolute zero, and a decade without water by drying into a suspended speck called a tun, then simply continuing.",
  },
  {
    id: "theseus-planks",
    topic: "philosophy",
    tags: ["identity", "time", "change"],
    text: "Replace every plank of a ship, one by one, and it looks the same when you are done. Whether it is the same ship is a question still without an owner.",
  },
  {
    id: "zhuangzi-butterfly",
    topic: "philosophy",
    tags: ["mind", "dreams", "reality"],
    text: "Zhuangzi woke from dreaming he was a butterfly, and could not settle which he was: a man who dreamt of wings, or a butterfly now dreaming of a man.",
  },
  {
    id: "descartes-doubt",
    topic: "philosophy",
    tags: ["mind", "doubt", "certainty"],
    text: "Descartes doubted everything doubtable and found one thing left standing: that the doubting itself was happening.",
  },
  {
    id: "nagel-bat",
    topic: "philosophy",
    tags: ["mind", "experience", "knowledge"],
    text: "Nagel asked what it is like to be a bat. However completely we map echolocation, the felt inside of that life stays out of reach.",
  },
  {
    id: "heraclitus-river",
    topic: "philosophy",
    tags: ["change", "time", "motion"],
    text: "Heraclitus said you cannot step into the same river twice, because new waters are always flowing past. Change was the one constant he trusted.",
  },
  {
    id: "platos-fire",
    topic: "philosophy",
    tags: ["reality", "knowledge", "light"],
    text: "Plato imagined prisoners who took wall shadows for the world itself. Philosophy, for him, is the slow turn toward the fire.",
  },
  {
    id: "camus-boulder",
    topic: "philosophy",
    tags: ["meaning", "work", "waiting"],
    text: "Camus pictured Sisyphus, mid-push, content. Meaning is not found at the top of the hill; it is made in the walking.",
  },
  {
    id: "wittgenstein-limits",
    topic: "philosophy",
    tags: ["language", "mind", "limits"],
    text: "Wittgenstein held that the limits of my language are the limits of my world, and that what cannot be said may still be shown.",
  },
  {
    id: "kant-two-wonders",
    topic: "philosophy",
    tags: ["astronomy", "awe", "mind"],
    text: "Kant named two things that filled him with growing wonder the longer he looked: the starry sky above, and the moral law within.",
  },
  {
    id: "zeno-half-gaps",
    topic: "philosophy",
    tags: ["infinity", "motion", "math"],
    text: "Zeno argued that Achilles never catches the tortoise, since he must always cross half the remaining gap first. Calculus settled the sum two thousand years later.",
  },
  {
    id: "epictetus-line",
    topic: "philosophy",
    tags: ["control", "work", "patience"],
    text: "Epictetus drew one line: some things are up to us and some are not. Judgment and desire sit inside the line; the rest merely passes.",
  },
  {
    id: "mary-red-room",
    topic: "philosophy",
    tags: ["knowledge", "experience", "color"],
    text: "Mary knows every physical fact about color but has lived her life in a black-and-white room. When she first sees red, does she learn something no fact contained?",
  },
  {
    id: "confucius-two-failures",
    topic: "philosophy",
    tags: ["learning", "knowledge", "work"],
    text: "Confucius named two failures of the mind: to learn without thinking, which is labor lost, and to think without learning, which is peril.",
  },
  {
    id: "rawls-veil",
    topic: "philosophy",
    tags: ["justice", "fairness", "design"],
    text: "Rawls asked what society you would build if you woke into it not knowing who you would be. Fairness, he thought, is design from behind that veil.",
  },
];

/**
 * Facts tagged into the wait's topics are the preferred pool, but only when
 * the intersection is deep enough to feel varied; a shallow match would
 * repeat itself inside a minute, so it falls back to the whole deck.
 */
export function selectFactPool(topics: string[]): PollFact[] {
  const preferred = pollFacts.filter((fact) => fact.tags.some((tag) => topics.includes(tag)));
  return preferred.length >= 3 ? preferred : pollFacts;
}

/** A shuffled copy of the pool; the walk never repeats until it is exhausted. */
export function buildRotation(pool: PollFact[]): PollFact[] {
  const order = [...pool];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
