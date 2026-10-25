-- 0249: The dossier child tables' foreign-key columns take the new singular.
-- 0248 renamed dossier_sources and dossier_questions to notebook_sources and
-- notebook_questions but left their dossier_id columns in place, so every
-- join on notebook_id failed. The columns rename with the tables.

ALTER TABLE "notebook_sources" RENAME COLUMN "dossier_id" TO "notebook_id";
ALTER TABLE "notebook_questions" RENAME COLUMN "dossier_id" TO "notebook_id";
