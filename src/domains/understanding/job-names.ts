/*
 * How explainer jobs are named. No imports, so the job runner registry and the
 * explainer commands can both use it without importing each other.
 */

export const EXPLAINER_JOB_KIND = "understanding.explain";

export const explainerJobKey = (explainerId: string) => `explainer:${explainerId}`;
