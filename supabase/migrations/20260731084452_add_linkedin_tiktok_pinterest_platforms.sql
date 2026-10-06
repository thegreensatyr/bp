-- Exported read-only from supabase_migrations.schema_migrations (20260731084452) on 2026-10-05
ALTER TABLE social_accounts DROP CONSTRAINT social_accounts_platform_check;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (platform = ANY (ARRAY['facebook'::text, 'instagram'::text, 'bluesky'::text, 'linkedin'::text, 'tiktok'::text, 'pinterest'::text]));
