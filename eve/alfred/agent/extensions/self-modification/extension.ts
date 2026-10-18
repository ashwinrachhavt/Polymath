import selfModification from "eve/self-modification/local";

/*
 * The bundled self-modification subagent inherits the root agent's model and
 * its resolver returns a bare LanguageModel with no context-window metadata,
 * which fails model selection for a model outside the AI Gateway catalog.
 * The extension's schema accepts only {model, reasoning, local.enabled} — no
 * window override — so the subagent is disabled for now; re-enable when the
 * root model is Gateway-listed.
 */
export default selfModification({
  local: { enabled: false },
});
