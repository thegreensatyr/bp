// Real-browser test of the composer uploader in app.html. Every request to the
// Supabase project is intercepted and answered locally; any other host except
// the supabase-js CDN is aborted, so nothing reaches prod. Run via ./run.sh.
const { chromium } = require('playwright-core');
const fs = require('fs');
const FIX = process.env.FIXTURES || '/tmp/bp-ui-fixtures';
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', CID = 'a1111111-1111-4111-8111-111111111111';
const SB = 'owxaolqikmgtlegtficq.supabase.co';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, role: 'authenticated', exp: 4102444800, aud: 'authenticated', email: 'brit@example.com' }) + '.sig';
const sessionValue = JSON.stringify({ access_token: JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: { id: UID, aud: 'authenticated', role: 'authenticated', email: 'brit@example.com', user_metadata: {} } });

const results = []; let failed = 0;
function check(ok, label) { results.push((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; }

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const uploads = [], deletes = [], inserts = [], blocked = [];
  async function setup(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, ['sb-owxaolqikmgtlegtficq-auth-token', sessionValue]);
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (u.hostname === 'localhost' || u.hostname === 'cdn.jsdelivr.net') return route.continue();
      if (u.hostname !== SB) { blocked.push(u.hostname); return route.abort(); }
      const p = u.pathname, m = req.method();
      const J = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
      if (p === '/rest/v1/profiles') return J({ parent_name: 'Brit', subscription_status: 'active', tutorials_enabled: false });
      if (p === '/rest/v1/cubicles') return J([{ id: CID, user_id: UID, name: 'Satyr Coffee', color: '#5f7d54', icon_initials: 'SC', lexicon: [], signature_phrases: [], never_says: [] }]);
      if (p === '/rest/v1/social_accounts') return J(['discord', 'bluesky', 'instagram', 'facebook', 'linkedin'].map((pl, i) => ({ id: 'acc' + i, cubicle_id: CID, platform: pl, external_account_name: pl + ' acct' })));
      if (p === '/rest/v1/drafts' && m === 'GET') return J([]);
      if (p === '/rest/v1/drafts' && m === 'POST') { const row = JSON.parse(req.postData()); inserts.push(row); return J({ id: 'draft-1', ...row }, 201); }
      if (p.startsWith('/storage/v1/object/post-media/') && m === 'POST') {
        const h = req.headers();
        uploads.push({ path: decodeURIComponent(p.replace('/storage/v1/object/post-media/', '')), type: h['content-type'], upsert: h['x-upsert'], auth: h['authorization'], size: (req.postDataBuffer() || Buffer.alloc(0)).length });
        await new Promise(r => setTimeout(r, 150));
        return J({ Key: 'post-media/' + p, Id: 'x' });
      }
      if (p === '/storage/v1/object/post-media' && m === 'DELETE') { deletes.push(JSON.parse(req.postData()).prefixes); return J([]); }
      if (p === '/functions/v1/publish-post') return J({ results: { discord: { ok: true, post_id: 'm1' }, bluesky: { ok: true, post_id: 'at://x' }, linkedin: { ok: false, skipped: true, error: 'linkedin_video_unsupported: LinkedIn video posting isn\'t supported in BrandParent yet — uncheck LinkedIn or attach an image instead.' } } });
      return J({ message: 'unmocked ' + m + ' ' + p }, 500);
    });
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => { results.push('PAGEERROR ' + e.message); failed++; });
    await page.goto(BASE + '/app.html');
    await page.waitForSelector('#media-uploader .bpm-drop', { timeout: 20000 });
    return { ctx, page };
  }

  // ---------------- desktop: images
  let { ctx, page } = await setup({ width: 1280, height: 900 });
  check(await page.isVisible('#media-uploader .bpm-drop'), 'uploader drop zone renders in composer');
  check(!(await page.locator('#media-links').evaluate(e => e.open)), 'link fields are folded under "Or paste a link"');
  await page.setInputFiles('#media-uploader .bpm-input', [FIX + '/noisy.png', FIX + '/photo.jpg']);
  await page.waitForFunction(() => document.querySelectorAll('#media-uploader .bpm-tile .bpm-ok').length === 2, null, { timeout: 30000 });
  check((await page.locator('.bpm-tile').count()) === 2, 'two thumbnails shown');
  check((await page.locator('.bpm-tile img').count()) === 2, 'thumbnails are image previews');
  const pngUploads = uploads.filter(u => u.path.endsWith('.png')), copies = uploads.filter(u => u.path.endsWith('-web.jpg'));
  check(uploads.every(u => u.path.startsWith(UID + '/' + CID + '/')), 'uploads go to {user_id}/{cubicle_id}/');
  check(uploads.every(u => u.upsert === 'false' && u.auth === 'Bearer ' + JWT), 'uploads use the user session, no upsert');
  check(pngUploads.length === 1 && pngUploads[0].type === 'image/png', 'PNG uploaded as image/png');
  check(copies.length === 1 && copies[0].size <= 950000 && copies[0].type === 'image/jpeg', 'PNG over 1 MB also gets a <=950 KB JPEG copy (' + (copies[0] && copies[0].size) + ' bytes)');
  check(uploads.filter(u => u.path.endsWith('.jpg') && !u.path.endsWith('-web.jpg')).length === 1, 'small JPEG uploaded once, no copy');
  const hints = await page.locator('.bpm-hint').allInnerTexts();
  check(hints.some(h => /Instagram: PNG images are sent as JPEG/.test(h)), 'Instagram hint about PNG->JPEG');
  check(hints.some(h => /Bluesky: images over 1 MB/.test(h)), 'Bluesky hint about 1 MB copy');
  check(hints.some(h => /LinkedIn: only the first image/.test(h)), 'LinkedIn hint: first image only');
  await page.screenshot({ path: FIX + '/desktop-images.png', fullPage: false, clip: await page.locator('#panel-compose .card').first().boundingBox() });

  // mixing is refused
  await page.setInputFiles('#media-uploader .bpm-input', [FIX + '/clip.mp4']);
  check(/not both/.test(await page.locator('.bpm-flash').innerText()), 'adding a video next to images is refused with a message');
  // GIF refused
  await page.setInputFiles('#media-uploader .bpm-input', [FIX + '/anim.gif']);
  check(/isn't a PNG, JPEG or MP4/.test(await page.locator('.bpm-flash').innerText()), 'GIF refused');

  // remove the JPEG before posting -> deleted from storage
  const jpgPath = uploads.find(u => u.path.endsWith('.jpg') && !u.path.endsWith('-web.jpg')).path;
  await page.locator('.bpm-tile').nth(1).locator('.bpm-x').click();
  await page.waitForTimeout(300);
  check(deletes.length === 1 && deletes[0][0] === jpgPath, 'removing an uncommitted file deletes it from storage');

  // publish now -> drafts.media saved, URL fields nulled, skipped platform shown
  await page.fill('#draft', 'Fresh roast today');
  await page.click('#publish-btn');
  await page.waitForFunction(() => /posted/.test(document.getElementById('publish-out').innerText), null, { timeout: 10000 });
  const row = inserts[0];
  check(row && Array.isArray(row.media) && row.media.length === 1, 'draft insert carries media[]');
  check(row && row.media[0].kind === 'image' && row.media[0].mime === 'image/png' && row.media[0].jpeg_path && row.media[0].width === 1600, 'media entry has path/kind/mime/size/dims/jpeg_path');
  check(row && row.image_url === null && row.video_url === null, 'URL fields nulled when files attached');
  const outText = await page.locator('#publish-out').innerText();
  check(/LinkedIn skipped: LinkedIn video posting/.test(outText), 'skipped platform shown clearly in results: ' + JSON.stringify(outText.split('\n')));
  // after commit, removing must NOT delete
  await page.locator('.bpm-tile').first().locator('.bpm-x').click();
  await page.waitForTimeout(300);
  check(deletes.length === 1, 'removing a file used by a saved post does not delete it');
  await ctx.close();

  // ---------------- desktop: video + TikTok-less preview, too-long video, drag & drop
  ({ ctx, page } = await setup({ width: 1280, height: 900 }));
  await page.setInputFiles('#media-uploader .bpm-input', [FIX + '/long.mp4']);
  await page.waitForSelector('.bpm-tile .bpm-err', { timeout: 20000 });
  check(/must be 90 seconds or shorter/.test(await page.locator('.bpm-err').innerText()), '95 s video rejected in the browser');
  await page.locator('.bpm-tile .bpm-x').click();
  // drag & drop a real mp4
  const mp4b64 = fs.readFileSync(FIX + '/clip.mp4').toString('base64');
  await page.evaluate((b) => {
    const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'clip.mp4', { type: 'video/mp4' }));
    const drop = document.querySelector('#media-uploader .bpm-drop');
    drop.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, mp4b64);
  await page.waitForSelector('.bpm-tile .bpm-ok', { timeout: 20000 });
  check(/2s/.test(await page.locator('.bpm-badge').innerText()), 'dropped MP4 shows duration badge');
  check((await page.locator('.bpm-tile video').count()) === 1, 'video preview element shown');
  check(await page.locator('.bpm-drop').evaluate(e => e.classList.contains('bpm-full')), 'drop zone disabled once a video is attached');
  const vh = await page.locator('.bpm-hint').allInnerTexts();
  check(vh.some(h => /LinkedIn: video isn't supported here yet/.test(h)), 'LinkedIn skip warning for video');
  check(vh.some(h => /Instagram: Reels must be at least 3 seconds/.test(h)), 'Instagram skip warning for a 2 s clip (Reels need 3 s)');
  await page.screenshot({ path: FIX + '/desktop-video.png', clip: await page.locator('#panel-compose .card').first().boundingBox() });
  // schedule -> media saved as video
  inserts.length = 0;
  await page.fill('#draft', 'Watch this');
  await page.fill('#sched-date', '2026-10-20');
  await page.locator('button', { hasText: /^Schedule$/ }).click();
  await page.waitForTimeout(800);
  check(inserts[0] && inserts[0].status === 'scheduled' && inserts[0].media[0].kind === 'video' && inserts[0].media[0].duration === 2, 'scheduled draft stores the video reference');
  await ctx.close();

  // ---------------- phone layout
  ({ ctx, page } = await setup({ width: 390, height: 844 }));
  await page.setInputFiles('#media-uploader .bpm-input', [FIX + '/photo.jpg', FIX + '/story.jpg']);
  await page.waitForFunction(() => document.querySelectorAll('.bpm-tile .bpm-ok').length === 2, null, { timeout: 20000 });
  const sh = await page.locator('.bpm-hint').allInnerTexts();
  check(sh.some(h => /Instagram: "story.jpg" is 1080×1920/.test(h)), 'Instagram 9:16 photo warning');
  const box = await page.locator('#media-uploader').boundingBox();
  check(box.width <= 390, 'uploader fits a 390 px phone screen');
  await page.locator('#media-uploader').scrollIntoViewIfNeeded();
  await page.screenshot({ path: FIX + '/phone.png', clip: { x: 0, y: Math.max(0, (await page.locator('#media-uploader').boundingBox()).y - 60), width: 390, height: 620 } });
  await ctx.close();

  await browser.close();
  console.log(results.join('\n'));
  console.log('blocked non-Supabase hosts:', [...new Set(blocked)].join(', ') || 'none');
  console.log(failed ? `\n${failed} FAILED` : '\nALL UI CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
