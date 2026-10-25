-- 0249: finish the rename 0248 started. The dossier tables took the notebook
-- name, but their FK columns kept the dossier name, so every drizzle query
-- against notebook_sources / notebook_questions failed with
-- "column ps.notebook_id does not exist" (the /projects list 500s on main).

ALTER TABLE "notebook_sources" RENAME COLUMN "dossier_id" TO "notebook_id";
ALTER TABLE "notebook_questions" RENAME COLUMN "dossier_id" TO "notebook_id";
