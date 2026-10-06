// BrandParent composer media uploader: file picker + drag-and-drop (tap to pick
// on phones), previews with remove buttons, per-file upload progress, image
// shrinking, and a JPEG copy for Bluesky/Instagram when needed.
//
// Files go straight from the browser to the PRIVATE Storage bucket `post-media`
// at {user_id}/{cubicle_id}/{random}.{ext}, authenticated with the user's own
// session (RLS enforces the folder). Nothing here is public.
//
// app.html wires it up with BPMedia.init({...}); see the "Media uploads" section there.
(function (root) {
  'use strict';
  var R = root.BPMediaRules;
  var cfg = null;               // { mount, getContext(), onChange(), getPlatforms(), supabaseUrl, apiKey, getToken() }
  var byBrand = {};             // cubicleId -> [item]
  var currentBrand = null;
  var flash = '';               // last add() error text

  function items() { return currentBrand ? (byBrand[currentBrand] = byBrand[currentBrand] || []) : []; }
  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    var a = new Uint8Array(16); root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function changed() { render(); if (cfg && cfg.onChange) try { cfg.onChange(); } catch (e) { console.error(e); } }


  var CSS = [
    '.bpm{margin-top:14px}',
    '.bpm-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;border:2px dashed var(--line,#e8e4dc);border-radius:14px;padding:18px 14px;background:var(--cream,#faf7f2);cursor:pointer;text-transform:none;letter-spacing:0;margin:0;transition:border-color .15s,background .15s;min-height:84px}',
    '.bpm-drop:hover,.bpm-drop:focus,.bpm-over{border-color:var(--brand,#9B7FC4);background:var(--brand-soft,rgba(155,127,196,.14));outline:none}',
    '.bpm-drop.bpm-full{opacity:.55;pointer-events:none}',
    '.bpm-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
    '.bpm-drop-title{font-size:.92rem;font-weight:700;color:var(--ink,#1c1b2e)}',
    '.bpm-drop-sub{font-size:.76rem;font-weight:500;color:var(--muted,#6b6880);line-height:1.35}',
    '.bpm-flash{margin-top:8px;font-size:.8rem;font-weight:600;color:#c0392b}',
    '.bpm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;margin-top:10px}',
    '.bpm-tile{position:relative;border-radius:12px;overflow:hidden;background:#000;aspect-ratio:1/1;border:1.5px solid var(--line,#e8e4dc)}',
    '.bpm-tile img,.bpm-tile video{width:100%;height:100%;object-fit:cover;display:block}',
    '.bpm-x{position:absolute;top:6px;right:6px;width:30px;height:30px;border-radius:50%;border:none;background:rgba(0,0,0,.65);color:#fff;font-size:.9rem;line-height:30px;padding:0;cursor:pointer}',
    '.bpm-x:hover{background:#c0392b}',
    '.bpm-badge{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.65);color:#fff;font-size:.7rem;font-weight:700;padding:2px 7px;border-radius:999px}',
    '.bpm-status{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.68);color:#fff;font-size:.7rem;font-weight:600;padding:6px 8px;display:flex;align-items:center;gap:6px;line-height:1.25}',
    '.bpm-bar{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.3);overflow:hidden}',
    '.bpm-bar>i{display:block;height:100%;background:var(--brand,#9B7FC4);transition:width .2s}',
    '.bpm-err{background:rgba(192,57,43,.92);flex-wrap:wrap;max-height:70%;overflow:auto}',
    '.bpm-retry{border:none;border-radius:999px;background:#fff;color:#c0392b;font-weight:700;font-size:.7rem;padding:2px 8px;cursor:pointer}',
    '.bpm-ok{background:rgba(0,0,0,.55)}',
    '.bpm-hints{margin-top:10px;display:flex;flex-direction:column;gap:4px}',
    '.bpm-hint{font-size:.78rem;line-height:1.35;color:var(--muted,#6b6880)}',
    '.bpm-hint.bpm-h-ok{background:none;color:var(--muted,#6b6880)}',
    '.bpm-hint.bpm-h-info{color:var(--ink-soft,#2a2940)}',
    '.bpm-hint.bpm-h-warn{color:#b9770e;font-weight:600}',
    '.bpm-hint.bpm-h-skip{color:#c0392b;font-weight:600}',
    '.bpm-links{margin-top:12px}',
    '.bpm-links>summary{cursor:pointer;font-size:.8rem;font-weight:600;color:var(--muted,#6b6880)}',
    '@media(max-width:600px){.bpm-grid{grid-template-columns:repeat(2,1fr)}.bpm-drop{padding:22px 12px}}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('bpm-css')) return;
    var st = document.createElement('style'); st.id = 'bpm-css'; st.textContent = CSS; document.head.appendChild(st);
  }

  // ------------------------------------------------------------ image helpers
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This image couldn\'t be opened.')); };
      img.src = url;
    });
  }
  function draw(img, maxEdge) {
    var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, maxEdge / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); // transparent PNG -> white, not black
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  function toBlob(c, q) { return new Promise(function (r) { c.toBlob(r, 'image/jpeg', q); }); }
  async function jpegUnder(img, maxBytes, maxEdge) {
    var edge = Math.min(maxEdge, Math.max(img.naturalWidth, img.naturalHeight));
    for (var t = 0; t < 7; t++) {
      var c = draw(img, edge);
      var qs = [0.9, 0.82, 0.74, 0.66, 0.58];
      for (var i = 0; i < qs.length; i++) {
        var b = await toBlob(c, qs[i]);
        if (b && b.size <= maxBytes) return { blob: b, width: c.width, height: c.height };
      }
      edge = Math.round(edge * 0.8);
    }
    throw new Error('This image couldn\'t be shrunk enough.');
  }
  function videoMeta(blob) {
    return new Promise(function (resolve) {
      var v = document.createElement('video'), url = URL.createObjectURL(blob), done = false;
      function fin(m) { if (done) return; done = true; URL.revokeObjectURL(url); resolve(m); }
      v.preload = 'metadata'; v.muted = true; v.playsInline = true;
      v.onloadedmetadata = function () { fin(isFinite(v.duration) ? { duration: v.duration, width: v.videoWidth, height: v.videoHeight } : null); };
      v.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 10000);
      v.src = url;
    });
  }

  // ------------------------------------------------------------ add / process / upload
  async function add(fileList) {
    if (!cfg) return;
    var ctx = cfg.getContext();
    if (!ctx || !ctx.userId || !ctx.cubicleId) { flash = 'Pick a brand first.'; render(); return; }
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var list = items();
    var res = R.checkAdd(list, files.map(function (f) { return { name: f.name, type: f.type, size: f.size }; }));
    var errors = res.errors.slice();
    for (var k = 0; k < res.accepted.length; k++) {
      var a = res.accepted[k], f = files[a.index];
      // Magic bytes: a renamed HEIC/GIF/MOV must not get through.
      var head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
      if (R.sniff(head) !== a.mime) { errors.push('"' + f.name + '" doesn\'t look like a real ' + a.ext.toUpperCase() + ' file.'); continue; }
      var item = {
        id: uid(), file: f, kind: a.kind, mime: a.mime, ext: a.ext, name: f.name, size: f.size,
        previewUrl: URL.createObjectURL(f), status: 'processing', progress: 0, error: '', note: '',
        cubicleId: ctx.cubicleId, userId: ctx.userId, xhrs: [], committed: false
      };
      list.push(item);
      process(item);
    }
    flash = errors.join(' ');
    changed();
  }

  async function process(item) {
    try {
      if (item.kind === 'image') {
        var li = await loadImage(item.file);
        item.width = li.img.naturalWidth; item.height = li.img.naturalHeight;
        item.uploadBlob = item.file;
        if (item.file.size > R.RULES.imageMaxBytes) {
          var shrunk = await jpegUnder(li.img, R.RULES.imageMaxBytes - 50000, R.RULES.imageMaxEdge);
          item.uploadBlob = shrunk.blob; item.mime = 'image/jpeg'; item.ext = 'jpg';
          item.size = shrunk.blob.size; item.width = shrunk.width; item.height = shrunk.height;
          item.note = 'shrunk to ' + R.fmtBytes(item.size) + (item.file.type === 'image/png' ? ' (as JPEG)' : '');
        }
        if (R.needsJpegCopy(item)) {
          var copy = await jpegUnder(li.img, R.RULES.jpegCopyTargetBytes, R.RULES.jpegCopyMaxEdge);
          item.jpegBlob = copy.blob; item.jpegSize = copy.blob.size;
        }
        URL.revokeObjectURL(li.url);
      } else {
        item.uploadBlob = item.file;
        var meta = await videoMeta(item.file);
        if (meta) { item.duration = meta.duration; item.width = meta.width; item.height = meta.height; }
        else {
          // Browser can't decode it (e.g. HEVC on some desktops): read the length from the MP4 header.
          try { item.duration = R.mp4Duration(new Uint8Array(await item.file.arrayBuffer())) || undefined; } catch (e) {}
          item.note = 'no preview in this browser';
        }
        var derr = R.checkVideoDuration(item.duration);
        if (derr) throw new Error(derr);
        if (!item.duration) throw new Error('Couldn\'t read this video\'s length — make sure it\'s a standard MP4 (H.264).');
      }
      await upload(item);
    } catch (e) {
      if (item.status === 'removed') return;
      item.status = 'error'; item.error = (e && e.message) || String(e);
      changed();
    }
  }

  function putObject(item, path, blob, contentType, onProgress) {
    return new Promise(async function (resolve, reject) {
      var token;
      try { token = await cfg.getToken(); } catch (e) { reject(new Error('You\'re signed out — sign in again.')); return; }
      var xhr = new XMLHttpRequest();
      item.xhrs.push(xhr);
      xhr.open('POST', cfg.supabaseUrl + '/storage/v1/object/' + R.RULES.bucket + '/' + path.split('/').map(encodeURIComponent).join('/'));
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('apikey', cfg.apiKey);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', 'max-age=3600');
      xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
        var msg = 'Upload failed (HTTP ' + xhr.status + ')';
        try { var j = JSON.parse(xhr.responseText); msg = j.message || j.error || msg; } catch (e) {}
        if (/maximum allowed size|too large|413/i.test(msg) || xhr.status === 413) msg = 'This file is larger than the upload limit.';
        if (/mime type|not supported/i.test(msg)) msg = 'Only PNG, JPEG and MP4 files can be uploaded.';
        if (/row-level security|unauthorized|403/i.test(msg)) msg = 'Upload refused — make sure you\'re signed in and this brand is yours.';
        reject(new Error(msg));
      };
      xhr.onerror = function () { reject(new Error('Network error while uploading — check your connection and retry.')); };
      xhr.onabort = function () { reject(new Error('aborted')); };
      xhr.send(blob);
    });
  }

  async function upload(item) {
    item.status = 'uploading'; item.progress = 0; item.error = ''; changed();
    var base = item.userId + '/' + item.cubicleId + '/' + item.id;
    var total = item.uploadBlob.size + (item.jpegBlob ? item.jpegBlob.size : 0), sent = 0;
    var path = base + '.' + item.ext;
    await putObject(item, path, item.uploadBlob, item.mime, function (n) { item.progress = Math.min(1, n / total); renderProgress(item); });
    item.path = path; sent = item.uploadBlob.size;
    if (item.jpegBlob) {
      var jp = base + '-web.jpg';
      await putObject(item, jp, item.jpegBlob, 'image/jpeg', function (n) { item.progress = Math.min(1, (sent + n) / total); renderProgress(item); });
      item.jpegPath = jp;
    }
    item.xhrs = [];
    if (item.status === 'removed') { cleanup(item); return; }
    item.status = 'done'; item.progress = 1;
    changed();
  }

  function cleanup(item) {
    var paths = [item.path, item.jpegPath].filter(Boolean);
    if (paths.length && !item.committed && cfg.sb) {
      cfg.sb.storage.from(R.RULES.bucket).remove(paths).catch(function () {});
    }
  }

  function remove(id) {
    var list = items(), i = list.findIndex(function (x) { return x.id === id; });
    if (i < 0) return;
    var item = list[i];
    item.status = 'removed';
    item.xhrs.forEach(function (x) { try { x.abort(); } catch (e) {} });
    // Deletes whatever already landed in storage, unless a saved/scheduled post
    // uses these files (committed) - then they are only detached from the composer.
    cleanup(item);
    try { URL.revokeObjectURL(item.previewUrl); } catch (e) {}
    list.splice(i, 1);
    flash = '';
    changed();
  }

  function retry(id) {
    var item = items().find(function (x) { return x.id === id; });
    if (!item || item.status !== 'error') return;
    if (!item.uploadBlob) { item.status = 'processing'; changed(); process(item); return; }
    upload(item).catch(function (e) { if (item.status === 'removed') return; item.status = 'error'; item.error = e.message; changed(); });
  }

  // ------------------------------------------------------------ rendering
  function renderProgress(item) {
    var el = cfg && cfg.mount && cfg.mount.querySelector('[data-bpm-id="' + item.id + '"] .bpm-bar > i');
    if (el) el.style.width = Math.round(item.progress * 100) + '%';
    var pct = cfg && cfg.mount && cfg.mount.querySelector('[data-bpm-id="' + item.id + '"] .bpm-pct');
    if (pct) pct.textContent = Math.round(item.progress * 100) + '%';
  }

  function tile(item) {
    var media = item.kind === 'video'
      ? '<video src="' + esc(item.previewUrl) + '" muted playsinline preload="metadata"></video><span class="bpm-badge">▶ ' + (item.duration ? R.fmtSecs(item.duration) : 'video') + '</span>'
      : '<img src="' + esc(item.previewUrl) + '" alt="">';
    var status = '';
    if (item.status === 'processing') status = '<div class="bpm-status">Preparing…</div>';
    else if (item.status === 'uploading') status = '<div class="bpm-status"><div class="bpm-bar"><i style="width:' + Math.round(item.progress * 100) + '%"></i></div><span class="bpm-pct">' + Math.round(item.progress * 100) + '%</span></div>';
    else if (item.status === 'error') status = '<div class="bpm-status bpm-err" title="' + esc(item.error) + '">⚠ ' + esc(item.error) + ' <button type="button" class="bpm-retry" data-bpm-retry="' + item.id + '">Retry</button></div>';
    else if (item.status === 'done') status = '<div class="bpm-status bpm-ok">✓ ' + R.fmtBytes(item.size) + (item.note ? ' · ' + esc(item.note) : '') + '</div>';
    return '<div class="bpm-tile" data-bpm-id="' + item.id + '">' + media +
      '<button type="button" class="bpm-x" data-bpm-remove="' + item.id + '" aria-label="Remove ' + esc(item.name) + '">✕</button>' + status + '</div>';
  }

  function render() {
    if (!cfg || !cfg.mount) return;
    var list = items();
    var grid = cfg.mount.querySelector('.bpm-grid');
    grid.innerHTML = list.map(tile).join('');
    grid.style.display = list.length ? '' : 'none';
    var err = cfg.mount.querySelector('.bpm-flash');
    err.textContent = flash; err.style.display = flash ? '' : 'none';
    var imgs = list.filter(function (i) { return i.kind === 'image'; }).length;
    var full = list.some(function (i) { return i.kind === 'video'; }) || imgs >= R.RULES.maxImages;
    cfg.mount.querySelector('.bpm-drop').classList.toggle('bpm-full', full);
    cfg.mount.querySelector('.bpm-drop-title').textContent = full ? 'Media limit reached for this post' : (list.length ? 'Add more images' : 'Add images or a video');
    refreshHints();
  }

  function refreshHints(platforms) {
    if (!cfg || !cfg.mount) return;
    var box = cfg.mount.querySelector('.bpm-hints');
    var ps = platforms || (cfg.getPlatforms ? cfg.getPlatforms() : []);
    var hints = R.platformHints(items().filter(function (i) { return i.status !== 'error'; }), ps);
    box.innerHTML = hints.map(function (h) { return '<div class="bpm-hint bpm-h-' + h.level + '">' + esc(h.text) + '</div>'; }).join('');
    box.style.display = hints.length ? '' : 'none';
  }

  function buildUI(mount) {
    injectCss();
    mount.classList.add('bpm');
    mount.innerHTML =
      '<label class="bpm-drop" tabindex="0">' +
        '<input type="file" class="bpm-input" accept="' + R.ACCEPT + '" multiple>' +
        '<span class="bpm-drop-title">Add images or a video</span>' +
        '<span class="bpm-drop-sub">Drag &amp; drop, or tap to choose · PNG/JPEG up to 4 (8 MB each) or one MP4 up to ' + R.RULES.videoMaxSeconds + 's / 50 MB</span>' +
      '</label>' +
      '<div class="bpm-flash" role="alert" style="display:none"></div>' +
      '<div class="bpm-grid" style="display:none"></div>' +
      '<div class="bpm-hints" style="display:none"></div>';
    var input = mount.querySelector('.bpm-input'), drop = mount.querySelector('.bpm-drop');
    input.addEventListener('change', function () { add(input.files); input.value = ''; });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('bpm-over'); }); });
    ['dragleave', 'dragend'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('bpm-over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('bpm-over'); if (e.dataTransfer) add(e.dataTransfer.files); });
    mount.addEventListener('click', function (e) {
      var r = e.target.closest('[data-bpm-remove]'); if (r) { e.preventDefault(); remove(r.getAttribute('data-bpm-remove')); return; }
      var t = e.target.closest('[data-bpm-retry]'); if (t) { e.preventDefault(); retry(t.getAttribute('data-bpm-retry')); }
    });
  }

  // ------------------------------------------------------------ public API
  root.BPMedia = {
    init: function (c) { cfg = c; buildUI(c.mount); var ctx = c.getContext(); currentBrand = ctx && ctx.cubicleId; render(); },
    setBrand: function (cubicleId) { currentBrand = cubicleId; flash = ''; render(); },
    items: function () { return items().slice(); },
    hasMedia: function () { return items().length > 0; },
    hasVideo: function () { return items().some(function (i) { return i.kind === 'video'; }); },
    /** Reason the post can't go yet (uploads running / failed), or null. */
    busy: function () {
      var l = items();
      if (l.some(function (i) { return i.status === 'processing' || i.status === 'uploading'; })) return 'Your files are still uploading — wait for them to finish, then try again.';
      if (l.some(function (i) { return i.status === 'error'; })) return 'One of your files failed to upload — retry it or remove it first.';
      return null;
    },
    draftMedia: function () { return R.toDraftMedia(items()); },
    /** First attached item for previews: {kind, src, duration} or null. */
    preview: function () { var i = items()[0]; return i ? { kind: i.kind, src: i.previewUrl, duration: i.duration } : null; },
    /** After a post/schedule saved these files: keep showing them, but never delete them from storage on remove. */
    markCommitted: function () { items().forEach(function (i) { if (i.status === 'done') i.committed = true; }); },
    /** Clear the composer without deleting files (they belong to a saved post now). */
    clearAfterPost: function () { items().forEach(function (i) { i.committed = true; try { URL.revokeObjectURL(i.previewUrl); } catch (e) {} }); byBrand[currentBrand] = []; flash = ''; changed(); },
    refreshHints: refreshHints,
    _add: add
  };
})(window);
