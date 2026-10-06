\set ON_ERROR_STOP 1
-- fixtures (as superuser)
insert into auth.users(id,email) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a@x'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b@x');
insert into public.cubicles(id,user_id,name) values
 ('a1111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A brand'),
 ('b2222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B brand');
insert into storage.objects(bucket_id,name) values ('post-media','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/secret.jpg');

create or replace function pg_temp.expect(ok boolean, label text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', label; end if; raise notice 'pass: %', label; end $$;

create or replace function pg_temp.try(sql text) returns boolean language plpgsql as $$
begin execute sql; return true; exception when others then return false; end $$;
create or replace function pg_temp.rows(sql text) returns int language plpgsql as $$
declare n int; begin execute sql; get diagnostics n = row_count; return n; end $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.expect((select public = false and file_size_limit = 50000000 and allowed_mime_types = array['image/png','image/jpeg','video/mp4'] from storage.buckets where id='post-media'), 'bucket is private, 50 MB, png/jpeg/mp4');

-- ---------- storage RLS as user A
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select pg_temp.expect(pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/f1.jpg')$q$), 'A can upload into own user/cubicle folder');
select pg_temp.expect(pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/v1.mp4')$q$), 'A can upload mp4');
select pg_temp.expect(not pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/b2222222-2222-4222-8222-222222222222/x.jpg')$q$), 'A cannot upload into B''s cubicle under own user folder');
select pg_temp.expect(not pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/x.jpg')$q$), 'A cannot upload into B''s user folder');
select pg_temp.expect(not pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/x.gif')$q$), 'A cannot upload a .gif');
select pg_temp.expect(not pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/deep/x.jpg')$q$), 'A cannot upload into a deeper sub-folder');
select pg_temp.expect(not pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/x.jpg')$q$), 'A cannot upload without a cubicle folder');
select pg_temp.expect((select count(*) from storage.objects where bucket_id='post-media') = 2, 'A sees only own 2 files (not B''s)');
select pg_temp.expect(pg_temp.rows($q$delete from storage.objects where name like 'bbbbbbbb%'$q$) = 0, 'A cannot delete B''s file');
select pg_temp.expect(pg_temp.rows($q$update storage.objects set name = name || 'x' where bucket_id='post-media'$q$) = 0, 'no UPDATE (overwrite/rename) allowed');
select pg_temp.expect(pg_temp.rows($q$delete from storage.objects where name like '%/v1.mp4'$q$) = 1, 'A can delete own file');
commit;

begin;
set local role anon;
select pg_temp.expect((select count(*) from storage.objects where bucket_id='post-media') = 0, 'anon sees nothing in post-media');
select pg_temp.expect(not pg_temp.try($q$insert into storage.objects(bucket_id,name) values ('post-media','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/z.jpg')$q$), 'anon cannot upload');
commit;

-- ---------- drafts.media constraint as user A
begin;
set local role authenticated;
set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
create temp table if not exists t(x int);
select pg_temp.expect(pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','hi',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/0f6c.png","kind":"image","mime":"image/png","size":2500000,"width":1200,"height":1200,"jpeg_path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/0f6c-web.jpg","jpeg_size":900000}]')$q$), 'valid image draft accepted');
select pg_temp.expect(pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','no media')$q$), 'draft without media accepted (default [])');
select pg_temp.expect(pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','vid',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/clip.mp4","kind":"video","mime":"video/mp4","size":50000000,"duration":89.5}]')$q$), 'valid 50 MB video accepted');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','steal',
  '[{"path":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/secret.jpg","kind":"image","mime":"image/jpeg","size":10}]')$q$), 'path in another user''s folder rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','steal2',
  '[{"path":"x.jpg","kind":"image","mime":"image/jpeg","size":10,"jpeg_path":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/secret.jpg"}]')$q$), 'jpeg_path outside folder rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','trav',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/../../bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/x.jpg","kind":"image","mime":"image/jpeg","size":10}]')$q$), 'path traversal rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','big',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/a.jpg","kind":"image","mime":"image/jpeg","size":8000001}]')$q$), 'image over 8 MB rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','mix',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/a.jpg","kind":"image","mime":"image/jpeg","size":1},{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/b.mp4","kind":"video","mime":"video/mp4","size":1}]')$q$), 'image + video mix rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','five',
  (select jsonb_agg(jsonb_build_object('path','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/i'||g||'.jpg','kind','image','mime','image/jpeg','size',1)) from generate_series(1,5) g))$q$), '5 images rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','gif',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/a.gif","kind":"image","mime":"image/gif","size":1}]')$q$), 'gif rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','mislabelled',
  '[{"path":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/a1111111-1111-4111-8111-111111111111/a.mp4","kind":"image","mime":"image/jpeg","size":1}]')$q$), 'mp4 labelled as image rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a1111111-1111-4111-8111-111111111111','obj',
  '{"path":"x"}')$q$), 'non-array media rejected');
select pg_temp.expect(not pg_temp.try($q$insert into public.drafts(user_id,cubicle_id,content,media) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','b2222222-2222-4222-8222-222222222222','othercub','[]')$q$), 'existing ownership policy still blocks drafts in B''s cubicle');
-- moving a draft with media to another of A's cubicles would orphan paths -> constraint must re-check on update
select pg_temp.expect(not pg_temp.try($q$update public.drafts set media = '[{"path":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/b2222222-2222-4222-8222-222222222222/secret.jpg","kind":"image","mime":"image/jpeg","size":10}]' where content='no media'$q$), 'UPDATE to a foreign path rejected');
commit;

-- token columns still hidden from the browser role
begin;
set local role authenticated;
select pg_temp.expect(not pg_temp.try('select access_token from public.social_accounts'), 'social_accounts.access_token still not selectable by authenticated');
commit;
select 'ALL MIGRATION TESTS PASSED';
