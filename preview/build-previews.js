// PREVIEW ONLY. Builds preview-before.html (from git origin/main:app.html) and preview-after.html
// (from the working-tree app.html) with the Supabase client swapped for preview/mock-supabase.js.
// Usage: node preview/build-previews.js
const fs = require('fs'), { execSync } = require('child_process'), path = require('path');
const root = path.join(__dirname, '..');
const DEMO = `
<script>
// PREVIEW ONLY: fill a demo draft (with one cross-brand leak) once the mock workspace has loaded.
setTimeout(() => {
  const d = document.getElementById('draft');
  if (!d) return;
  d.value = "Forest rave this Friday, two hours under the trees. Pull a moon reading before you come. See you on the floor.";
  document.getElementById('draft-image').value = 'https://example.com/flyer.jpg';
  if (typeof runBleedCheck === 'function') runBleedCheck();
  if (typeof checkBlueskyLimit === 'function') checkBlueskyLimit();
  if (typeof ttRenderPreview === 'function') ttRenderPreview();
  window.__previewReady = true;
}, 600);
</script>`;
function build(src, out) {
  const re = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.js"><\/script>\s*<script src="js\/supabase-client\.js"><\/script>/;
  if (!re.test(src)) throw new Error('supabase script tags not found for ' + out);
  let html = src.replace(re, '<script src="preview/mock-supabase.js"></script>');
  html = html.replace('</body>', DEMO + '\n</body>');
  html = html.replace(/<title>([^<]*)<\/title>/, '<title>PREVIEW (mock data) — $1</title>');
  fs.writeFileSync(path.join(root, out), html);
  console.log('wrote', out);
}
build(execSync('git show origin/main:app.html', { cwd: root, maxBuffer: 1 << 26 }).toString(), 'preview-before.html');
build(fs.readFileSync(path.join(root, 'app.html'), 'utf8'), 'preview-after.html');
// Theme comparison: the same demo cubicles on the layout just before immersive styles (22820f7).
build(execSync('git show 22820f7:app.html', { cwd: root, maxBuffer: 1 << 26 }).toString(), 'preview-theme-before.html');
