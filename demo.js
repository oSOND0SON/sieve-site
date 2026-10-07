/* Sieve demo mode.
   The real Sieve is a small server on the owner's computer (yt-dlp, gallery-dl, a headless browser). This file stands
   in for that server inside the browser: it answers the app's /api calls from four recorded sample pages, runs finds
   and downloads as jobs with the same stages, progress, ZIP parts, pauses and cancel, and packs real ZIP files from
   the bundled sample media. Nothing here contacts any other site. */
(function () {
  'use strict';
  const M = '/media/';
  const ENGINES = { ytdlp: 1750, gallerydl: 1034, gallerydlSites: 273 };   // counted from the engines the full app ships with
  const PART_FILES = 6;                                                      // demo parts close every 6 files so you can watch them arrive

  /* ---------------------------------------------------------------- the sample pages */
  const trip = n => ({ url: `${M}trip-${String(n).padStart(2, '0')}.jpg`, type: 'image', kind: 'direct', thumb: `${M}trip-${String(n).padStart(2, '0')}.jpg` });
  const tripTitles = ['Ridge at first light', 'The road down to the bay', 'Maples by the river', 'Second pass, late afternoon', 'Dunes past the station',
    'The town after dark', 'Leaves on the old path', 'Evening tide', 'Valley from the hut', 'Last of the red', 'Morning swim', 'Lights over the harbour', 'Sand and wind', 'Walking out'];
  const clipTitles = ['Night walk through the old town', 'Tide coming in, ten quiet minutes', 'Lantern festival, slow pan', 'Rooftops after the rain',
    'Harbour at blue hour', 'Paper lights, close up', 'Last tram home'];
  const icon = n => ({ url: `${M}icon-${n}.png`, type: 'image', kind: 'direct', thumb: `${M}icon-${n}.png`, title: null });

  const PAGES = [
    { key: 'travel', label: 'A travel blog', color: '#6EA3FF', url: 'https://slowtravel.example/a-week-in-the-mountains',
      title: 'A week in the mountains, on foot', source: 'page',
      stages: [['Reading the page', 1100]],
      items: () => [...Array.from({ length: 12 }, (_, i) => ({ ...trip(i + 1), title: tripTitles[i] })),
        { url: `${M}clip-02.mp4`, type: 'video', kind: 'direct', thumb: `${M}clip-02-poster.jpg`, title: 'The bay, filmed from the ferry' },
        icon(1), icon(2), icon(3), icon(4)],
      deepItems: () => [{ ...trip(13), title: tripTitles[12] }, { ...trip(14), title: tripTitles[13] }, { url: `${M}clip-05.mp4`, type: 'video', kind: 'direct', thumb: `${M}clip-05-poster.jpg`, title: 'Harbour, loaded by a script' }],
      dropped: 23 },
    { key: 'profile', label: 'A photo profile', color: '#C9B4FF', url: 'https://photos.example/@mira.studio',
      title: '@mira.studio', source: 'gallery', throttleAt: 9,
      stages: [['Reading as a gallery', 1500]],
      items: () => Array.from({ length: 18 }, (_, i) => { const u = `${M}mira-${String(i + 1).padStart(2, '0')}.jpg`; return { url: u, type: 'image', kind: 'direct', thumb: u, title: null }; }),
      dropped: 9 },
    { key: 'channel', label: 'A video channel', color: '#FF8A66', url: 'https://videos.example/@quietcity',
      title: 'Quiet City: short films', source: 'video',
      stages: [['Reading as a video site', 1500]],
      items: () => clipTitles.map((t, i) => { const n = String(i + 1).padStart(2, '0'); return { url: `${M}clip-${n}.mp4`, type: 'video', kind: 'ytdlp', thumb: `${M}clip-${n}-poster.jpg`, title: t, duration: 3 }; }),
      dropped: 0 },
    { key: 'lookbook', label: 'A page that hides its images', color: '#7DE3D1', url: 'https://lookbook.example/spring',
      title: 'Spring lookbook', source: 'browser',
      stages: [['Reading the page', 900], ['Rendering the page in a browser', 1300], ['Scrolling the page so everything loads', 1100]],
      items: () => Array.from({ length: 10 }, (_, i) => { const u = `${M}lookbook-${String(i + 1).padStart(2, '0')}.jpg`; return { url: u, type: 'image', kind: 'direct', thumb: u, title: `Look ${i + 1}` }; }),
      dropped: 14 },
  ];
  const norm = u => String(u || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  const pageFor = u => PAGES.find(p => norm(p.url) === norm(u));

  /* ---------------------------------------------------------------- jobs */
  const jobs = new Map();
  const blobs = new Map();          // blob url -> filename, for downloads
  let seq = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const newId = () => 'demo' + (++seq) + Math.random().toString(36).slice(2, 7);

  function snapshot(j) {
    const cur = j.current ? { ...j.current } : null;
    let percent = null;
    if (j.total) { const frac = cur && cur.percent != null && cur.percent < 100 ? cur.percent / 100 : 0; percent = Math.min(100, (j.done + j.failed.length + frac) / j.total * 100); }
    const out = { id: j.id, kind: j.kind, status: j.status, stage: j.stage, total: j.total, done: j.done, failed: j.failed.length, current: cur, percent,
      bytes: j.bytes, error: j.error, filename: j.filename, size: j.size, notes: [...j.notes], mode: j.mode,
      parts: j.parts.map(({ n, filename, size, files }) => ({ n, filename, size, files })), pauseUntil: j.pauseUntil };
    if (j.kind === 'extract' && j.status === 'done') out.result = j.result;
    return out;
  }
  function job(kind, extra) {
    const j = { id: newId(), kind, status: 'running', stage: '', total: 0, done: 0, failed: [], current: null, bytes: 0, error: null, filename: null,
      size: null, notes: [], mode: extra.mode, parts: [], pauseUntil: null, cancelled: false, ...extra };
    jobs.set(j.id, j);
    return j;
  }
  async function wait(j, ms) {          // sleeps, but wakes on cancel
    const end = Date.now() + ms;
    while (Date.now() < end) { if (j.cancelled) throw 'cancel'; await sleep(Math.min(120, end - Date.now())); }
    if (j.cancelled) throw 'cancel';
  }

  async function runExtract(j) {
    try {
      const page = pageFor(j.url);
      if (!page) {
        await wait(j, 700);
        j.status = 'error';
        j.error = "This is the demo, so Sieve only reads its four sample pages. Pick one below. The full app reads any link: pages, galleries, profiles and video sites.";
        return;
      }
      const stages = j.deep ? [['Starting the browser', 700], ['Rendering the page in a browser', 1200], ['Scrolling the page so everything loads', 1000]] : page.stages;
      for (const [s, ms] of stages) { j.stage = s; await wait(j, ms); }
      const items = page.items().concat(j.deep && page.deepItems ? page.deepItems() : []).map(it => ({ ...it, ref: page.url }));
      j.result = { source: j.deep ? 'browser' : page.source, title: page.title, url: page.url, items, deep: !!j.deep, rendered: j.deep || page.source === 'browser', browser: true,
        notes: [], dropped: page.dropped };
      j.status = 'done';
      window.dispatchEvent(new CustomEvent('sieve-demo-found', { detail: page }));
    } catch (e) { j.status = 'cancelled'; }
  }

  /* ZIP writer: stored entries, CRC-32, UTF-8 names. Enough for real, openable archives. */
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), chunks = [], central = [];
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      chunks.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cSize, true); e.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, e.buffer], { type: 'application/zip' });
  }
  function uniqueName(name, used) {
    let base = name, n = 2; const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    while (used.has(base.toLowerCase())) base = `${stem} (${n++})${ext}`;
    used.add(base.toLowerCase()); return base;
  }
  function addPart(j, blob, filename, files) {
    const url = URL.createObjectURL(blob);
    blobs.set(url, filename);
    j.parts.push({ n: j.parts.length + 1, filename, size: blob.size, files, url });
  }

  async function runDownload(j) {
    const items = j.items, zipMode = j.mode === 'zip', page = pageFor(items[0]?.ref);
    const host = (items[0]?.ref || 'sieve').replace(/^https?:\/\//, '').split('/')[0].replace(/[^\w.-]/g, '_');
    j.total = items.length;
    let open = [], used = new Set(), throttled = false;
    const closePart = (final) => {
      if (!open.length && !(final && j.failed.length)) return;
      const files = open.slice();
      if (final && j.failed.length) files.push({ name: '_could_not_download.txt', data: new TextEncoder().encode(j.failed.join('\n')) });
      addPart(j, zip(files), `sieve-${host}-${j.parts.length + 1}.zip`, open.length);
      open = []; used = new Set();
    };
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (j.cancelled) throw 'cancel';
        j.stage = zipMode ? 'Packing' : 'Fetching';
        const label = it.title || decodeURIComponent(it.url.split('/').pop());
        j.current = { name: label, percent: 0, downloaded: 0, size: null, speed: null, eta: null };
        if (j.pace === 'gentle' && i) await wait(j, 2000);
        if (page?.throttleAt && i === page.throttleAt && !throttled) {          // the profile page plays a site that starts throttling
          throttled = true;
          j.stage = 'Paused, the site is throttling'; j.pauseUntil = Date.now() / 1000 + 6;
          await wait(j, 6000);
          j.pauseUntil = null; j.stage = zipMode ? 'Packing' : 'Fetching';
        }
        const res = await fetch(it.url);
        if (!res.ok) { j.failed.push(`${it.url}\n    The file server answered with error ${res.status}.`); continue; }
        const data = new Uint8Array(await res.arrayBuffer());
        const total = data.length, ms = 380 + Math.random() * 420, t0 = Date.now();
        j.current.size = total;
        while (Date.now() - t0 < ms) {                                        // the transfer is simulated; the bytes are real
          if (j.cancelled) throw 'cancel';
          const k = Math.min(1, (Date.now() - t0) / ms);
          j.current.downloaded = Math.round(total * k); j.current.percent = k * 100;
          j.current.speed = total / (ms / 1000); j.current.eta = (ms - (Date.now() - t0)) / 1000;
          await sleep(90);
        }
        if (it.kind === 'ytdlp') { j.stage = 'Merging video and audio'; await wait(j, 450); j.stage = zipMode ? 'Packing' : 'Fetching'; }
        const name = uniqueName(it.kind === 'ytdlp' && it.title ? `${it.title}.mp4` : decodeURIComponent(it.url.split('/').pop()), used);
        if (zipMode) {
          open.push({ name, data });
          if (open.length >= PART_FILES && i < items.length - 1) closePart(false);
        } else {
          addPart(j, new Blob([data], { type: res.headers.get('content-type') || 'application/octet-stream' }), name, 1);
        }
        j.done++; j.bytes += total; j.current = null;
      }
      if (zipMode) closePart(true);
      else if (j.failed.length) addPart(j, new Blob([j.failed.join('\n')], { type: 'text/plain' }), '_could_not_download.txt', 0);
      j.stage = 'Ready'; j.status = 'done';
    } catch (e) {
      if (e !== 'cancel') { j.status = 'error'; j.error = String(e && e.message || e); return; }
      if (zipMode && open.length) { j.failed.push(`Stopped by you with ${j.total - j.done - j.failed.length} files left.`); closePart(true); }
      j.status = 'cancelled';
    } finally {
      j.current = null; j.pauseUntil = null;
      const last = j.parts[j.parts.length - 1];
      if (last) { j.filename = last.filename; j.size = j.parts.reduce((a, p) => a + p.size, 0); }
    }
  }

  /* ---------------------------------------------------------------- the fake server */
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    // document.baseURI rather than location: the portfolio renders the demo inside a srcdoc frame with a <base>
    const base = new URL(document.baseURI);
    const url = new URL(typeof input === 'string' ? input : input.url, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const path = url.pathname, method = (init.method || 'GET').toUpperCase();
    await sleep(60);
    if (path === '/api/config') return json({ needsKey: false, browser: true, autoRender: 3, partSize: 1073741824, engines: ENGINES,
      cookies: { present: false, count: 0, domains: [] }, tools: { ffmpeg: true, js: 'deno', browser: true } });
    if (path === '/api/cookies') return json({ present: false, count: 0, domains: [] });
    if (path === '/api/jobs' && method === 'POST') {
      const b = JSON.parse(init.body || '{}');
      if (b.kind === 'extract') { const j = job('extract', { url: b.url, deep: !!b.deep }); runExtract(j); return json(snapshot(j), 202); }
      if (!Array.isArray(b.items) || !b.items.length) return json({ detail: 'Nothing selected.' }, 400);
      const j = job(b.kind, { items: b.kind === 'file' ? b.items.slice(0, 1) : b.items, mode: b.kind === 'file' || b.mode === 'each' ? 'each' : 'zip', pace: b.pace });
      runDownload(j);
      return json(snapshot(j), 202);
    }
    let m = path.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
    if (m) {
      const j = jobs.get(m[1]);
      if (!j) return json({ detail: 'That job is gone. Start again.' }, 404);
      if (m[2] && method === 'POST') { j.cancelled = true; }
      return json(snapshot(j));
    }
    return json({ detail: 'The demo does not have that.' }, 404);
  };

  /* ---------------------------------------------------------------- page hooks (after the app's script has run) */
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('dm');
    const capture = new URLSearchParams(location.search).has('capture') || window.SV_CAPTURE === true;
    if (capture) document.body.classList.add('dm-capture');
    // local media load directly; there is no server-side proxy here
    window.fileUrl = it => it.url;
    window.jobFileUrl = (id, part) => { const j = jobs.get(id); const p = j && (part != null ? j.parts.find(x => x.n === +part) : j.parts[j.parts.length - 1]); return p ? p.url : '#'; };
    window.triggerDownload = href => {
      if (window.SV_CAPTURE === true) return;   // screenshots for the case study: no real downloads
      const a = document.createElement('a'); a.href = href; a.download = blobs.get(href) || '';
      document.body.append(a); a.click(); a.remove();
    };

    // banner
    const banner = document.createElement('div');
    banner.className = 'dm-banner';
    banner.innerHTML = "<span><b>You're trying the Sieve demo.</b> It reads four sample pages built for it, and the downloads are real ZIPs of sample files. Nothing here touches another site.</span><button type='button' aria-label='Hide'>×</button>";
    banner.querySelector('button').onclick = () => banner.remove();
    document.body.prepend(banner);

    // preset links under the field
    const tryEl = document.querySelector('.try');
    if (tryEl) tryEl.textContent = 'This demo reads four sample pages. Pick one:';
    const wrap = document.createElement('div');
    wrap.className = 'dm-presets';
    for (const p of PAGES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dm-chip'; b.style.setProperty('--c', p.color);
      b.innerHTML = `<i></i>${p.label}`;
      b.onclick = () => { const f = document.getElementById('url'); f.value = p.url; window.find(p.url); };
      wrap.append(b);
    }
    (tryEl || document.getElementById('findForm')).after(wrap);

    // settings: what only the full app has is hidden and explained
    const tools = document.getElementById('toolFfmpeg')?.closest('fieldset');
    if (tools) tools.id = 'toolsField';
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'In the demo, ZIP parts close every 6 files so you can watch them arrive. Cookies for logged-in sites and the server check live in the full app.';
    document.querySelector('#settingsForm fieldset:nth-of-type(3) .hint')?.after(note);
    document.getElementById('url').placeholder = 'Paste a link, or pick a sample below';
  });
})();
