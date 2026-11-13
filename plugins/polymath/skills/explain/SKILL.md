---
description: Explain a code change in Polymath, then optionally check your understanding of it.
argument-hint: "[git range, for example main..HEAD]"
disable-model-invocation: true
---

The user asked for a Polymath explainer of a code change. The git range, if any, is: $ARGUMENTS

Use the `polymath` MCP tools in this order. Never push or commit anything.

1. Call `what_do_i_know` with the main topics of the change, so the explainer can skip what the user already knows.
2. Call `explain_change` with `summary` written from this session: what the user asked for, the decisions made, the dead ends, and what is risky. Pass `range` only when the user gave one. If the tool reports that no key is set or Polymath is unreachable, tell the user plainly and stop.
3. Show the user the note URL it returns.
4. Ask whether they want the understanding check now. If they decline, stop.
5. If they accept, call `check_understanding` with the `explainer_id` to get the questions. Ask them one at a time in the terminal. Use the AskUserQuestion tool with the choice labels when it is available, and plain text otherwise. Offer "I don't know" as an option. Collect every answer, then call `check_understanding` again with `answers` as a list of `{question_id, value}`, where `value` is the choice value or null for "I don't know".
6. Report the score, the missed concepts, and that the missed concepts were added to their daily practice in Polymath.
