-- Exported read-only from supabase_migrations.schema_migrations (20260914080407) on 2026-10-05
create table if not exists public.temp_video_chunks (
  video_key text not null,
  idx int not null,
  data text not null,
  primary key (video_key, idx)
);
