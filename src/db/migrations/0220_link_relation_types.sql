-- 0220: typed zettel relationships (ASH-110 section 6). Adds the relation
-- types a link can mean (explains, applies, extends, contrasts) and 'dismissed',
-- the owner's rejection of a machine suggestion so a re-embed does not
-- propose it again. link_type is text with a CHECK, so this is a constraint
-- swap, not a type change.
ALTER TABLE "artifact_links" DROP CONSTRAINT "artifact_links_link_type_check";--> statement-breakpoint
ALTER TABLE "artifact_links" ADD CONSTRAINT "artifact_links_link_type_check" CHECK (link_type in ('reference', 'related', 'supports', 'contradicts', 'source', 'semantic', 'explains', 'applies', 'extends', 'contrasts', 'dismissed'));
