import { z } from "zod";

/*
 * The grader eval's fixtures: 50 answers to one source, each with the verdict
 * an owner reading the source would give. Agent-drafted on 2026-11-11 and
 * marked for the owner to review before the bar is set; the ten least certain
 * are named in the eval's report.
 *
 * The eval is what protects the buyer from a readiness report that lies: a
 * false pass (graded correct when the answer was partial or wrong) is counted
 * separately from overall agreement, because a grader that passes a wrong
 * answer is worse than one that fails a right one.
 */

export const GRADER_EVAL_SOURCE = {
  title: "Reliable APIs handout",
  text: `An idempotency key lets a server recognise a repeated request and answer it from the stored result of the first attempt, so the side effect happens once. Without a key the server cannot tell a retry from a new request, and a retried charge is applied twice. The write-ahead log records every change before it is applied, so a crash midway can be recovered by replaying the log. Backpressure slows a producer when its consumer cannot keep up, which protects the consumer from a queue that grows without bound. A retry policy sets how many times a failed call is attempted and how long to wait between attempts. Exactly-once delivery is a promise a system can only make when every step of the path is idempotent.`,
};

export type Grade = "correct" | "partial" | "incorrect" | "uncertain";

export type GraderEvalCase = {
  id: string;
  question: string;
  answer: string;
  /** The verdict an owner reading the source would give. A pass means "correct". */
  expected: Grade;
  /** Agent-drafted; the owner should re-read these before the bar is set. */
  draft: true;
  /** True for the ten the drafting agent is least sure about. */
  leastCertain?: true;
  note?: string;
};

const Q = {
  idempotency: "Why is an idempotency key necessary to prevent duplicate side effects when a client retries a request?",
  wal: "How does the write-ahead log let a system recover after a crash midway through an operation?",
  backpressure: "Why must a producer be slowed down when its consumer cannot keep up, and what does this prevent?",
  retry: "Why can a retry policy safely repeat a failed call only when the request carries an idempotency key?",
  exactlyOnce: "Why does a system need an idempotency key to provide exactly-once delivery?",
};

export const GRADER_EVAL_CASES: GraderEvalCase[] = [
  // --- 1..10: correct ---
  {
    id: "c01",
    question: Q.idempotency,
    answer:
      "Because the key lets the server recognise the request it already handled and return the stored result of the first attempt, so the effect only happens once.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c02",
    question: Q.idempotency,
    answer:
      "Without a key the server cannot tell a retry from a new request, so a repeated charge would be applied twice; the key lets it answer from the first attempt's stored result.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c03",
    question: Q.wal,
    answer:
      "The log records every change before it is applied, so after a crash the system replays the log to reach the state it had recorded.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c04",
    question: Q.backpressure,
    answer:
      "Slowing the producer keeps the queue from growing without bound, which protects the consumer from being overwhelmed.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c05",
    question: Q.retry,
    answer:
      "Because the key makes the server treat the repeated call as the same request and answer from the stored result, rather than applying the effect again.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c06",
    question: Q.exactlyOnce,
    answer:
      "Exactly-once delivery needs every step to be idempotent, and the idempotency key is what makes a repeated step safe, so the delivery happens once even across retries.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c07",
    question: Q.idempotency,
    answer:
      "The server matches the key to the earlier request and replays its stored result instead of charging again.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c08",
    question: Q.wal,
    answer: "Changes are written to the log before they are applied; a crash midway is repaired by replaying the log.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c09",
    question: Q.backpressure,
    answer:
      "If the consumer is slower than the producer the queue grows without bound, so the producer is slowed to bound the queue and protect the consumer.",
    expected: "correct",
    draft: true,
  },
  {
    id: "c10",
    question: Q.retry,
    answer:
      "Without a key, a retried call looks like a new call and is applied again; with the key the server recognises the retry and returns the stored result.",
    expected: "correct",
    draft: true,
  },

  // --- 11..20: wrong despite sounding close (false-pass traps) ---
  {
    id: "w01",
    question: Q.idempotency,
    answer: "Because it encrypts the request so it cannot be tampered with on the way to the server.",
    expected: "incorrect",
    draft: true,
    note: "Invokes a real mechanism, but the wrong one; a grader might reward the confident tone.",
  },
  {
    id: "w02",
    question: Q.wal,
    answer: "It caches recent reads in memory so the system answers faster after a crash.",
    expected: "incorrect",
    draft: true,
    note: "Backpressure and the log are conflated; sounds plausible.",
  },
  {
    id: "w03",
    question: Q.backpressure,
    answer: "It queues every message durably so no message is ever lost when the consumer is slow.",
    expected: "incorrect",
    draft: true,
    leastCertain: true,
    note: "A real idea (durable queue), but not what backpressure does.",
  },
  {
    id: "w04",
    question: Q.exactlyOnce,
    answer: "The key lets the delivery service retry on its own schedule until the consumer acknowledges.",
    expected: "incorrect",
    draft: true,
    note: "At-least-once retrying, not exactly-once.",
  },
  {
    id: "w05",
    question: Q.retry,
    answer: "Because the key signs the request cryptographically, proving it came from the client.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w06",
    question: Q.idempotency,
    answer: "Because the key increases throughput by allowing parallel writes.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w07",
    question: Q.wal,
    answer: "It deletes the failed operation from the log so the retry starts clean.",
    expected: "incorrect",
    draft: true,
    note: "The opposite of replay; a careless grader may see 'log' and pass it.",
  },
  {
    id: "w08",
    question: Q.backpressure,
    answer: "It speeds up the consumer so the queue drains faster.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w09",
    question: Q.exactlyOnce,
    answer: "Exactly-once is guaranteed whenever the network delivers the message once.",
    expected: "incorrect",
    draft: true,
    note: "The network cannot promise this; the source says the promise needs idempotency.",
  },
  {
    id: "w10",
    question: Q.retry,
    answer: "Because retrying a read is always safe, so the key is not really needed.",
    expected: "incorrect",
    draft: true,
  },

  // --- 21..30: partial (right idea, one part missing or muddled) ---
  {
    id: "p01",
    question: Q.idempotency,
    answer: "It stops the same request being applied twice.",
    expected: "partial",
    draft: true,
    leastCertain: true,
    note: "States the outcome but not the mechanism (stored result).",
  },
  {
    id: "p02",
    question: Q.wal,
    answer: "It records changes before they happen so counts are not duplicated on retry.",
    expected: "partial",
    draft: true,
    note: "Correct in spirit but describes idempotency, not crash recovery by replay.",
  },
  {
    id: "p03",
    question: Q.backpressure,
    answer: "It protects the consumer from too much work.",
    expected: "partial",
    draft: true,
    note: "Right direction; omits the unbounded-queue point.",
  },
  {
    id: "p04",
    question: Q.retry,
    answer: "The key lets the server know it is the same request.",
    expected: "partial",
    draft: true,
    leastCertain: true,
    note: "Right idea, does not say what the server does with that (returns stored result).",
  },
  {
    id: "p05",
    question: Q.exactlyOnce,
    answer: "Every step has to be idempotent.",
    expected: "partial",
    draft: true,
    note: "Quotes the source's last clause without explaining why the key matters.",
  },
  {
    id: "p06",
    question: Q.idempotency,
    answer:
      "Without a key a retry is treated as a new request, so it could be applied twice; the key marks it as the same one.",
    expected: "partial",
    draft: true,
    note: "Names the hazard but not the stored-result answer.",
  },
  {
    id: "p07",
    question: Q.wal,
    answer: "The log lets you undo a partial change after a crash.",
    expected: "partial",
    draft: true,
    note: "Recovery direction, but replay-to-recorded-state is the source's claim; undo is an inference.",
  },
  {
    id: "p08",
    question: Q.backpressure,
    answer: "A bounded queue is what backpressure achieves.",
    expected: "partial",
    draft: true,
  },
  {
    id: "p09",
    question: Q.retry,
    answer: "A retry policy sets a fixed number of attempts and a wait between them, so retries are paced.",
    expected: "partial",
    draft: true,
    note: "Describes the retry policy's shape but not why a key makes it safe.",
  },
  {
    id: "p10",
    question: Q.exactlyOnce,
    answer: "Exactly-once means the effect happens once even if the attempt is retried.",
    expected: "partial",
    draft: true,
    note: "Restates the goal; does not name idempotency as the requirement.",
  },

  // --- 31..40: uncertain (the source does not settle the answer) ---
  {
    id: "u01",
    question: Q.idempotency,
    answer: "It is a database-level lock that serialises the two requests.",
    expected: "uncertain",
    draft: true,
    note: "A lock is a real alternative mechanism the source does not mention; not wrong, not supported.",
  },
  {
    id: "u02",
    question: Q.wal,
    answer: "It uses checkpoints to trim the log, so recovery time is bounded.",
    expected: "uncertain",
    draft: true,
    note: "True of write-ahead logging generally; absent from this source.",
  },
  {
    id: "u03",
    question: Q.backpressure,
    answer: "It can shed load by dropping the producer's messages.",
    expected: "uncertain",
    draft: true,
    leastCertain: true,
    note: "Load shedding is one backpressure response; the source says 'slows', not 'drops'.",
  },
  {
    id: "u04",
    question: Q.retry,
    answer: "A jittered exponential backoff makes the retry policy safe.",
    expected: "uncertain",
    draft: true,
    note: "Backoff improves pacing; whether it makes retries *safe* is not settled here.",
  },
  {
    id: "u05",
    question: Q.exactlyOnce,
    answer: "Two-phase commit is what makes exactly-once possible.",
    expected: "uncertain",
    draft: true,
  },
  {
    id: "u06",
    question: Q.idempotency,
    answer: "The key should expire so storage does not grow forever.",
    expected: "uncertain",
    draft: true,
    note: "An operational concern the source does not discuss.",
  },
  {
    id: "u07",
    question: Q.wal,
    answer: "A torn write at the end of the log is discarded on recovery.",
    expected: "uncertain",
    draft: true,
  },
  {
    id: "u08",
    question: Q.backpressure,
    answer: "The producer can also buffer locally to avoid slowing down.",
    expected: "uncertain",
    draft: true,
    note: "Moves the buffer rather than bounding it; neither clearly right nor wrong here.",
  },
  {
    id: "u09",
    question: Q.retry,
    answer: "The key should be generated by the server, not the client.",
    expected: "uncertain",
    draft: true,
  },
  {
    id: "u10",
    question: Q.exactlyOnce,
    answer: "Exactly-once between two systems requires both to share the key.",
    expected: "uncertain",
    draft: true,
    note: "Arguable from 'every step of the path'; not stated.",
  },

  // --- 41..50: more wrong, including confident nonsense and a copied answer ---
  {
    id: "w11",
    question: Q.backpressure,
    answer: "It records every change before it is applied so a crash can be replayed.",
    expected: "incorrect",
    draft: true,
    note: "A copied answer to a different question; a high-performing false-pass trap.",
    leastCertain: true,
  },
  {
    id: "w12",
    question: Q.idempotency,
    answer: "Exactly-once delivery holds only when every step of the path is idempotent.",
    expected: "incorrect",
    draft: true,
    note: "A source sentence, but it answers a different question.",
    leastCertain: true,
  },
  {
    id: "w13",
    question: Q.wal,
    answer: "Because the idempotency key lets the server return the stored result.",
    expected: "incorrect",
    draft: true,
    note: "Right sentence, wrong question (same trap class).",
    leastCertain: true,
  },
  {
    id: "w14",
    question: Q.retry,
    answer: "It makes the network entirely reliable so retries never fail.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w15",
    question: Q.exactlyOnce,
    answer: "It compresses the message so duplicates fit in one delivery.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w16",
    question: Q.idempotency,
    answer: "Because it stores the user's password securely.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w17",
    question: Q.backpressure,
    answer: "It removes the oldest messages from the queue so the newest can proceed.",
    expected: "incorrect",
    draft: true,
    leastCertain: true,
    note: "Drop-oldest is a real policy; the source's claim is that the producer is slowed.",
  },
  {
    id: "w18",
    question: Q.wal,
    answer: "It keeps every version of every document for audit.",
    expected: "incorrect",
    draft: true,
  },
  {
    id: "w19",
    question: Q.retry,
    answer: "Because HTTP idempotent methods like GET are always safe to repeat.",
    expected: "partial",
    draft: true,
    leastCertain: true,
    note: "True of GET, but the question is about a failed call with a key; partial at best.",
  },
  {
    id: "w20",
    question: Q.exactlyOnce,
    answer: "The key is only needed for writes; reads are naturally once.",
    expected: "incorrect",
    draft: true,
    leastCertain: true,
  },
];

/** Validates the fixtures, so a malformed case is a loud error rather than a silent skip. */
const caseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  expected: z.enum(["correct", "partial", "incorrect", "uncertain"]),
  draft: z.literal(true),
  leastCertain: z.literal(true).optional(),
  note: z.string().optional(),
});

export function validateCases(cases: GraderEvalCase[]): void {
  for (const item of cases) caseSchema.parse(item);
  const ids = new Set(cases.map((item) => item.id));
  if (ids.size !== cases.length) throw new Error("Duplicate eval case id");
}
