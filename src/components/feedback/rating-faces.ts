/*
 * The five faces of a 1-5 rating, worst to best. A plain module (not the
 * client control) so the server-rendered readout can label its bars with the
 * same faces the person picked from.
 */
export const RATING_FACES = [
  { score: 1, face: "😞", label: "awful" },
  { score: 2, face: "🙁", label: "poor" },
  { score: 3, face: "😐", label: "okay" },
  { score: 4, face: "🙂", label: "good" },
  { score: 5, face: "😄", label: "great" },
] as const;
