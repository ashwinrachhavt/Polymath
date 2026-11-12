/* Sample content shared by the boards. Every concept carries the two labels the
   mapping needs (kind, subject) and the evidence the finish is read from. */
(function (root) {
  const S = root.Stones;
  const c = (id, name, kind, subject, finish, extra) => Object.assign({ id, name, kind, subject, finish }, extra || {});
  const SAMPLES = [
    c("c-show", "Show, don't tell", "prism", "amber", "brilliant"),
    c("c-bisect", "git bisect", "point", "obsidian", "polished"),
    c("c-loops", "Feedback loops", "delta", "malachite", "polished"),
    c("c-tcp", "TCP handshake", "terrace", "hematite", "cut"),
    c("c-memory", "Working memory holds about four items", "pebble", "moonstone", "polished"),
    c("c-cv", "Cross-validation", "baton", "azurite", "star"),
  ];
  const MISSIONS = [
    {
      id: "m-rust", name: "Ship a Rust command-line tool", date: "Due 12 Dec", done: false,
      concepts: [
        c("r1", "Ownership moves by default", "prism", "obsidian", "brilliant", { reviews: 4, next: "in 23 days" }),
        c("r2", "Borrow checker", "terrace", "obsidian", "polished", { ready: true, reviews: 1, next: "today" }),
        c("r3", "Exponential backoff", "delta", "hematite", "polished", { reviews: 2, next: "in 6 days" }),
        c("r4", "Big-O notation", "point", "fluorite", "star", { reviews: 9, next: "in 4 months" }),
        c("r5", "git bisect", "point", "obsidian", "cut", { reviews: 0, next: "in 2 days" }),
        c("r6", "Exit codes: 0 means success", "pebble", "hematite", "polished", { ready: true, reviews: 1, next: "today" }),
        c("r7", "Test-driven development", "baton", "obsidian", "cut", { reviews: 0, next: "tomorrow" }),
        c("r8", "Builder pattern", "delta", "obsidian", "cut", { shards: 2 }),
        c("r9", "Closures capture their environment", "terrace", "obsidian", "cut", { shards: 1 }),
      ],
    },
    {
      id: "m-specs", name: "Write clearer product specs", date: "Due 30 Nov", done: false,
      concepts: [
        c("s1", "Show, don't tell", "prism", "amber", "brilliant", { reviews: 3, next: "in 19 days" }),
        c("s2", "Inverted pyramid", "delta", "amber", "polished", { reviews: 1, next: "in 3 days" }),
        c("s3", "Jobs to be done", "point", "copper", "polished", { ready: true, reviews: 2, next: "today" }),
        c("s4", "Visual hierarchy", "prism", "coral", "cut", { reviews: 0, next: "tomorrow" }),
        c("s5", "Working memory holds about four items", "pebble", "moonstone", "polished", { reviews: 1, next: "in 5 days" }),
        c("s6", "Active voice", "point", "amber", "cut", { shards: 2 }),
      ],
    },
    {
      id: "m-ab", name: "Trust an A/B test result", date: "Finished 2 Nov", done: true, span: "14 Oct to 2 Nov",
      concepts: [
        c("a1", "p-value", "pebble", "azurite", "brilliant", { reviews: 3, next: "in 30 days" }),
        c("a2", "Regression to the mean", "prism", "azurite", "polished", { reviews: 2, next: "in 9 days" }),
        c("a3", "Simpson's paradox", "delta", "azurite", "polished", { reviews: 1, next: "in 4 days" }),
        c("a4", "Cross-validation", "baton", "azurite", "star", { reviews: 8, next: "in 5 months" }),
        c("a5", "Pigeonhole principle", "prism", "fluorite", "polished", { reviews: 1, next: "in 6 days" }),
        c("a6", "Confirmation bias", "delta", "moonstone", "brilliant", { reviews: 3, next: "in 21 days" }),
        c("a7", "Opportunity cost", "prism", "copper", "polished", { ready: true, reviews: 1, next: "today" }),
      ],
    },
  ];
  root.StoneData = { SAMPLES, MISSIONS, SHARDS_PER_STONE: 3, spec: (x) => S.stoneForConcept(x) };
})(window);
