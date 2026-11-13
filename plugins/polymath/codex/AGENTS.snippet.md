## Polymath explainers

When the user asks to explain a change with Polymath, or types /polymath-explain, use the `polymath` MCP tools in this order. Never run them unprompted, and never push or commit anything.

1. Call `what_do_i_know` with the main topics of the change.
2. Call `explain_change` with `summary` written from this session: what the user asked for, the decisions made, the dead ends, and what is risky. Pass `range` only when the user gave one.
3. Show the user the note URL it returns.
4. Ask whether they want the understanding check now. If yes, call `check_understanding` with the `explainer_id`, ask the questions one at a time, then call it again with `answers` as a list of `{question_id, value}` (`value` is null for "I don't know").
5. Report the score, the missed concepts, and that the missed concepts were added to their daily practice in Polymath.
