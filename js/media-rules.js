// BrandParent post-media rules: pure functions, no DOM. Loaded by app.html as a
// classic script (sets window.BPMediaRules) and imported by the Deno unit tests,
// which also assert these numbers match supabase/functions/_shared/media.ts.
(function (root) {
  'use strict';

  var RULES = {
    maxImages: 4,                    // Bluesky's max per post (others allow more)
    maxVideos: 1,
    imageMaxBytes: 8000000,          // Instagram JPEG cap; FB 10 MB, Discord 10 MiB, TikTok 20 MB
    imageInputMaxBytes: 40000000,    // bigger camera files are refused before we even try to shrink them
    imageMaxEdge: 4096,              // when an image must be shrunk to fit 8 MB
    videoMaxBytes: 50000000,         // 50 MB, just under the project's 50 MiB Storage upload limit
    videoMaxSeconds: 90,             // "short video"
    videoMinSeconds: 1,
    blueskyImageMaxBytes: 1000000,   // Bluesky image blob limit
    jpegCopyTargetBytes: 950000,     // browser-made JPEG copy for Bluesky/Instagram stays under this
    jpegCopyMaxEdge: 2000,
    discordUploadMaxBytes: 10000000, // per message on Discord servers without boosts (conservative)
    instagramVideoMinSeconds: 3,
    instagramAspectMin: 0.8,         // 4:5
    instagramAspectMax: 1.91,
    bucket: 'post-media'
  };

  var ACCEPT = '.png,.jpg,.jpeg,.mp4,image/png,image/jpeg,video/mp4';
  var EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };
  var LABEL = { bluesky: 'Bluesky', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', discord: 'Discord', linkedin: 'LinkedIn', pinterest: 'Pinterest', tumblr: 'Tumblr' };

  function fmtBytes(n) {
    if (n >= 1000000) return (Math.round(n / 100000) / 10) + ' MB';
    if (n >= 1000) return Math.round(n / 1000) + ' KB';
    return n + ' bytes';
  }
  function fmtSecs(s) { s = Math.round(s); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + 's'; }

  /** {mime, kind, ext} from the file name / browser type, or null if not PNG/JPEG/MP4. */
  function typeOf(name, type) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    var mime = EXT[ext] || null;
    var t = String(type || '').toLowerCase();
    if (!mime && (t === 'image/png' || t === 'image/jpeg' || t === 'video/mp4')) mime = t;
    if (!mime) return null;
    // A known-but-different browser type (e.g. image/heic named .jpg) is refused.
    if (t && t !== mime && !(t === 'image/jpg' && mime === 'image/jpeg') && t !== 'application/octet-stream') return null;
    return { mime: mime, kind: mime.indexOf('video/') === 0 ? 'video' : 'image', ext: mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'mp4' };
  }

  /** Magic-byte check on the first bytes of a file. */
  function sniff(b) {
    if (!b || b.length < 3) return null;
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4';
    return null;
  }

  /** Duration in seconds from an MP4's moov/mvhd box (works when the browser can't play the codec). */
  function mp4Duration(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    function box(off, end) {
      if (off + 8 > end) return null;
      var size = dv.getUint32(off), header = 8;
      var type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
      if (size === 1) { if (off + 16 > end) return null; size = dv.getUint32(off + 8) * 4294967296 + dv.getUint32(off + 12); header = 16; }
      else if (size === 0) size = end - off;
      if (size < header) return null;
      return { type: type, start: off, header: header, end: Math.min(off + size, end) };
    }
    var off = 0;
    while (off < b.length) {
      var bx = box(off, b.length);
      if (!bx) break;
      if (bx.type === 'moov') {
        var c = bx.start + bx.header;
        while (c < bx.end) {
          var ch = box(c, bx.end);
          if (!ch) break;
          if (ch.type === 'mvhd') {
            var p = ch.start + ch.header, v = b[p], ts, dur;
            if (v === 1) { ts = dv.getUint32(p + 20); dur = dv.getUint32(p + 24) * 4294967296 + dv.getUint32(p + 28); }
            else { ts = dv.getUint32(p + 12); dur = dv.getUint32(p + 16); }
            return ts > 0 ? dur / ts : null;
          }
          c = ch.end;
        }
        return null;
      }
      off = bx.end;
    }
    return null;
  }

  /**
   * Can these new files be added next to what's already attached?
   * existing: [{kind}], incoming: [{name, type, size}] -> {accepted:[{index, mime, kind, ext}], errors:[string]}
   */
  function checkAdd(existing, incoming) {
    var errors = [], accepted = [];
    var imgs = existing.filter(function (e) { return e.kind === 'image'; }).length;
    var vids = existing.filter(function (e) { return e.kind === 'video'; }).length;
    for (var i = 0; i < incoming.length; i++) {
      var f = incoming[i], name = f.name || 'file';
      var t = typeOf(f.name, f.type);
      if (!t) { errors.push('"' + name + '" isn\'t a PNG, JPEG or MP4 file.'); continue; }
      if (t.kind === 'video') {
        if (f.size > RULES.videoMaxBytes) { errors.push('"' + name + '" is ' + fmtBytes(f.size) + ' — videos must be ' + fmtBytes(RULES.videoMaxBytes) + ' or smaller.'); continue; }
        if (imgs > 0) { errors.push('A post can have images or one video, not both — remove the images to add "' + name + '".'); continue; }
        if (vids >= RULES.maxVideos) { errors.push('Only one video per post.'); continue; }
        vids++;
      } else {
        if (f.size > RULES.imageInputMaxBytes) { errors.push('"' + name + '" is ' + fmtBytes(f.size) + ' — that\'s too big to process here. Use an image under ' + fmtBytes(RULES.imageInputMaxBytes) + '.'); continue; }
        if (vids > 0) { errors.push('A post can have images or one video, not both — remove the video to add "' + name + '".'); continue; }
        if (imgs >= RULES.maxImages) { errors.push('Up to ' + RULES.maxImages + ' images per post — "' + name + '" wasn\'t added.'); continue; }
        imgs++;
      }
      if (f.size <= 0) { errors.push('"' + name + '" is empty.'); if (t.kind === 'video') vids--; else imgs--; continue; }
      accepted.push({ index: i, mime: t.mime, kind: t.kind, ext: t.ext });
    }
    return { accepted: accepted, errors: errors };
  }

  function checkVideoDuration(sec) {
    if (!(sec > 0)) return null; // unknown: the server checks the real file
    if (sec > RULES.videoMaxSeconds + 0.5) return 'This video is ' + fmtSecs(sec) + ' — videos must be ' + RULES.videoMaxSeconds + ' seconds or shorter. Trim it and try again.';
    if (sec < RULES.videoMinSeconds) return 'This video is shorter than ' + RULES.videoMinSeconds + ' second.';
    return null;
  }

  /** Browser should also upload a small JPEG copy (Bluesky 1 MB limit, Instagram JPEG-only). */
  function needsJpegCopy(item) { return item.kind === 'image' && (item.mime === 'image/png' || item.size > RULES.blueskyImageMaxBytes); }

  function storagePath(userId, cubicleId, id, ext) { return userId + '/' + cubicleId + '/' + id + '.' + ext; }

  /** drafts.media payload from finished items. */
  function toDraftMedia(items) {
    return items.filter(function (i) { return i.status === 'done' && i.path; }).map(function (i) {
      var m = { path: i.path, kind: i.kind, mime: i.mime, size: i.size, name: String(i.name || '').slice(0, 120) };
      if (i.width) m.width = Math.round(i.width);
      if (i.height) m.height = Math.round(i.height);
      if (i.duration) m.duration = Math.round(i.duration * 100) / 100;
      if (i.alt) m.alt = String(i.alt).slice(0, 1000);
      if (i.jpegPath) { m.jpeg_path = i.jpegPath; m.jpeg_size = i.jpegSize; }
      return m;
    });
  }

  /**
   * Per-platform notes for the selected targets, mirroring planMedia() on the
   * server: [{platform, level: 'ok'|'info'|'warn'|'skip', text}]
   */
  function platformHints(items, platforms) {
    var out = [];
    var imgs = items.filter(function (i) { return i.kind === 'image'; });
    var vid = items.filter(function (i) { return i.kind === 'video'; })[0];
    if (!imgs.length && !vid) return out;
    (platforms || []).forEach(function (p) {
      var L = LABEL[p] || p;
      function add(level, text) { out.push({ platform: p, level: level, text: L + ': ' + text }); }
      if (p === 'bluesky') {
        if (vid) add('ok', 'video post.');
        else if (imgs.some(function (i) { return i.size > RULES.blueskyImageMaxBytes; })) add('info', 'images over 1 MB are sent as a smaller JPEG copy (Bluesky\'s limit).');
        else add('ok', imgs.length + ' image' + (imgs.length > 1 ? 's' : '') + '.');
      } else if (p === 'instagram') {
        if (vid) {
          if (vid.duration && vid.duration < RULES.instagramVideoMinSeconds) add('skip', 'Reels must be at least 3 seconds — Instagram will be skipped.');
          else add('ok', 'posted as a Reel.');
        } else {
          var bad = imgs.filter(function (i) { var r = i.width && i.height ? i.width / i.height : 1; return r < RULES.instagramAspectMin - 0.005 || r > RULES.instagramAspectMax + 0.005; })[0];
          if (bad) add('skip', '"' + bad.name + '" is ' + bad.width + '×' + bad.height + '; Instagram only takes 4:5 to 1.91:1 images, so Instagram will be skipped. Crop it or uncheck Instagram.');
          else if (imgs.some(function (i) { return i.mime === 'image/png'; })) add('info', 'PNG images are sent as JPEG (Instagram only accepts JPEG).' + (imgs.length > 1 ? ' Posted as a carousel.' : ''));
          else add('ok', imgs.length > 1 ? 'posted as a carousel.' : 'photo post.');
        }
      } else if (p === 'facebook') {
        add('ok', vid ? 'video post (Facebook may take a few minutes to process it).' : (imgs.length > 1 ? imgs.length + '-photo post.' : 'photo post.'));
      } else if (p === 'tiktok') {
        add('ok', vid ? 'video post.' : (imgs.length > 1 ? imgs.length + '-photo post.' : 'photo post.'));
      } else if (p === 'discord') {
        if (vid && vid.size > RULES.discordUploadMaxBytes) add('warn', 'this video is ' + fmtBytes(vid.size) + '. Discord servers without boosts reject files over 10 MB (Level 2 boost: 50 MB), so Discord may fail.');
        else {
          var total = imgs.reduce(function (a, i) { return a + i.size; }, 0);
          add('ok', vid ? 'video attached.' : (total > RULES.discordUploadMaxBytes ? 'images attached, split across messages to stay under 10 MB each.' : 'images attached.'));
        }
      } else if (p === 'tumblr') {
        add('ok', vid ? 'video post (Tumblr may take a few minutes to process it).' : (imgs.length > 30 ? 'only the first 30 images are used.' : (imgs.length > 1 ? imgs.length + '-photo post.' : 'photo post.')));
      } else if (p === 'linkedin' || p === 'pinterest') {
        if (vid) add('skip', 'video isn\'t supported here yet — ' + L + ' will be skipped.');
        else if (imgs.length > 1) add('info', 'only the first image is used.');
      }
    });
    return out;
  }

  var api = { RULES: RULES, ACCEPT: ACCEPT, typeOf: typeOf, sniff: sniff, mp4Duration: mp4Duration, checkAdd: checkAdd,
    checkVideoDuration: checkVideoDuration, needsJpegCopy: needsJpegCopy, storagePath: storagePath, toDraftMedia: toDraftMedia,
    platformHints: platformHints, fmtBytes: fmtBytes, fmtSecs: fmtSecs };
  root.BPMediaRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
