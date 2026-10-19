INSERT INTO "integration_catalog" ("provider", "display_name", "capabilities", "risk_by_capability", "requires_approval")
VALUES (
	'notion',
	'Notion',
	'["read_pages", "read_databases"]'::jsonb,
	'{"read_pages": "read", "read_databases": "read"}'::jsonb,
	false
)
ON CONFLICT ("provider") DO NOTHING;--> statement-breakpoint
