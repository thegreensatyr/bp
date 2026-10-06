-- Optional immersive workspace style per cubicle (background texture/photo, page tone, card style,
-- card opacity, corner radius). NULL = "Classic": the cubicle renders exactly as before.
-- Shape (v1): {"v":1,"bg":"starfield","tone":"deep","card":"frosted","opacity":0.8,"radius":"soft"}
-- Existing RLS policies on public.cubicles already cover this column (owner-only read/update).
alter table public.cubicles
  add column if not exists theme_style jsonb
  check (theme_style is null or jsonb_typeof(theme_style) = 'object');
