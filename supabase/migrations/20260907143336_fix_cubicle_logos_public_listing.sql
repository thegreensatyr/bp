-- Exported read-only from supabase_migrations.schema_migrations (20260907143336) on 2026-10-05
-- The bucket is already public:true, so individual logo files are served
-- directly via their public CDN URL without going through RLS at all.
-- This SELECT policy on storage.objects adds nothing for that path — it only
-- enables enumerating/listing every file in the bucket via the Storage API's
-- list()/select() calls, which is what the security advisor flagged.
drop policy if exists "cubicle-logos public read" on storage.objects;
