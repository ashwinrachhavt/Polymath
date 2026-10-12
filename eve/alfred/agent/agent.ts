// Spike agent: hello-world with one test hook. Throwaway — the verified API
// shapes are recorded in the spec, the code is deleted when the real
// eve/alfred/ lands (Task 5).
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
});
