/* PDF Voice Notes — dictate notes into the margin of a PDF, entirely in the browser.

   The saved PDF is the single source of truth. Every note is stored twice:
     1. as JSON embedded in the PDF catalog, which is what this app reads back, and
     2. as removable annotations (highlight + margin text) that any reader can show.
   Re-saving strips the annotations this tool wrote and regenerates them from the
   JSON, so a file can be opened, edited and saved over and over without drift. */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const {
  PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString,
  StandardFonts, rgb, degrees, decodePDFRawStream,
} = PDFLib;

const $ = (id) => document.getElementById(id);
const el = {
  openBtn: $('openBtn'), fileInput: $('fileInput'), fileName: $('fileName'),
  placeBtn: $('placeBtn'), zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomLabel: $('zoomLabel'),
  saveBtn: $('saveBtn'), overwriteBtn: $('overwriteBtn'), summaryChk: $('summaryChk'),
  styleSelect: $('styleSelect'), hint: $('hint'), viewer: $('viewer'), viewerPane: $('viewerPane'),
  empty: $('empty'), noteList: $('noteList'), noteCount: $('noteCount'), railEmpty: $('railEmpty'),
  langSelect: $('langSelect'), cmdChk: $('cmdChk'), micWarn: $('micWarn'), toast: $('toast'),
};

/* Margin geometry, in PDF points. The on-screen margin uses the same numbers scaled
   by the zoom level, so what you see is close to what gets printed. */
const MARGIN = {
  gutter: 170,   // width added to the right of each annotated page
  pad: 14,       // breathing room on each side of the note text
  size: 8.5,     // font size
  lead: 11.2,    // line height
  gap: 9,        // vertical space between two notes that would collide
  edge: 14,      // keep-out at the very top and bottom of the column
};
const INK = [0.11, 0.32, 0.75];        // margin text blue
const HILITE = [1, 0.93, 0.35];        // highlighter yellow

/* Private keys this tool stamps on the file so it can recognise its own work. */
const K_NOTES = PDFName.of('PVNNotes');    // catalog -> stream of JSON
const K_GUTTER = PDFName.of('PVNGutter');  // page -> width already added
const K_TAG = PDFName.of('PVN');           // annotation -> note id

const state = {
  bytes: null,          // pristine copy of the PDF currently open
  pdf: null,            // pdf.js document
  fileHandle: null,     // File System Access handle, when the browser gave us one
  name: 'document.pdf',
  key: null,            // localStorage key for this file
  notes: [],            // { id, page, nx, ny, text, quads, createdAt }
  gutters: new Map(),   // page number -> gutter already baked into that page
  scale: 1.25,
  placing: false,
  activeId: null,
  listeningId: null,
};

/* ---------------------------------------------------------------- utilities */

let toastTimer;
function toast(msg, ms = 3200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp01 = (n) => Math.min(Math.max(n, 0), 1);
const marginMode = () => el.styleSelect.value !== 'sticky';
const hasContent = (n) => Boolean(n.text.trim()) || (n.quads && n.quads.length);

/* Gutter already baked into a page by an earlier save. */
function pageGutter(page) {
  const v = page.node.lookup(K_GUTTER);
  const n = v && typeof v.asNumber === 'function' ? v.asNumber() : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ------------------------------------------------------------- persistence */
/* localStorage is only a crash net for the current session. The durable copy is
   the JSON embedded in the PDF itself. */

function saveLocal() {
  if (!state.key) return;
  try {
    localStorage.setItem(state.key, JSON.stringify({ name: state.name, notes: state.notes }));
  } catch { /* quota or private mode — not worth interrupting the user over */ }
}

function loadLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw).notes || []) : [];
  } catch { return []; }
}

/* Read back what a previous save embedded: the notes, and how much each page was
   already widened. */
async function readEmbedded(bytes) {
  const result = { notes: null, gutters: new Map() };
  try {
    const doc = await PDFDocument.load(bytes.slice(), {
      updateMetadata: false, ignoreEncryption: true,
    });
    for (let i = 0; i < doc.getPageCount(); i++) {
      const g = pageGutter(doc.getPage(i));
      if (g) result.gutters.set(i + 1, g);
    }
    const raw = doc.catalog.lookup(K_NOTES);
    if (raw && typeof raw.getContents === 'function') {
      const json = new TextDecoder().decode(decodePDFRawStream(raw).decode());
      const data = JSON.parse(json);
      if (Array.isArray(data.notes)) result.notes = data.notes;
    }
  } catch (err) {
    console.warn('Could not read embedded notes:', err);
  }
  return result;
}

function normaliseNotes(list) {
  return list
    .filter((n) => n && typeof n.page === 'number')
    .map((n) => ({
      id: n.id || uid(),
      page: n.page,
      nx: clamp01(Number(n.nx) || 0),
      ny: clamp01(Number(n.ny) || 0),
      text: typeof n.text === 'string' ? n.text : '',
      quads: Array.isArray(n.quads) ? n.quads.filter((q) => Array.isArray(q) && q.length === 4) : [],
      createdAt: n.createdAt || new Date().toISOString(),
    }))
    .sort((a, b) => a.page - b.page || a.ny - b.ny);
}

/* -------------------------------------------------------------- opening a PDF */

el.openBtn.addEventListener('click', async () => {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      state.fileHandle = handle;
      await openFile(file);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // user cancelled the dialog
      // Any other failure (permissions policy, sandboxed frame) — fall through.
    }
  }
  el.fileInput.click();
});

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.fileHandle = null;
  await openFile(file);
  e.target.value = '';
});

el.viewerPane.addEventListener('dragover', (e) => { e.preventDefault(); });
el.viewerPane.addEventListener('drop', async (e) => {
  const file = e.dataTransfer.files[0];
  if (!file || file.type !== 'application/pdf') return;
  e.preventDefault();
  state.fileHandle = null;              // a dropped file gives us no write access
  await openFile(file);
});

async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const embedded = await readEmbedded(bytes);

  state.bytes = bytes;
  state.name = file.name || 'document.pdf';
  state.key = `pvn:${state.name}:${bytes.length}`;
  state.gutters = embedded.gutters;
  state.activeId = null;
  stopListening();

  // The file wins when it carries notes; otherwise fall back to the crash net.
  const local = loadLocal(state.key);
  state.notes = normaliseNotes(embedded.notes && embedded.notes.length ? embedded.notes : local);

  await loadIntoViewer(bytes);

  el.fileName.textContent = state.name;
  el.empty.hidden = true;
  for (const b of [el.placeBtn, el.zoomIn, el.zoomOut, el.saveBtn]) b.disabled = false;
  el.overwriteBtn.hidden = !state.fileHandle;
  el.overwriteBtn.disabled = !state.fileHandle;

  renderNotes();
  if (!embedded.notes && embedded.gutters.size) {
    // Widened by an older build that printed notes straight into the page and did
    // not embed the JSON, so there is nothing here to make editable again.
    toast(
      'This file was annotated by an earlier version, so its notes are printed in and '
      + 'cannot be edited. Open the original PDF instead — the notes for it are still '
      + 'saved in this browser.',
      11000,
    );
  } else if (state.notes.length) {
    const from = embedded.notes && embedded.notes.length ? 'from the file' : 'from this browser';
    toast(`Loaded ${state.notes.length} note${state.notes.length === 1 ? '' : 's'} ${from}.`);
  }
}

/* Swap in a new set of bytes (after saving over the file) without losing the notes
   held in memory, so the view always matches what is on disk. */
async function loadIntoViewer(bytes) {
  // pdf.js takes ownership of whatever buffer it is handed, so give it a copy.
  state.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  await renderAll();
}

/* ------------------------------------------------------------------ rendering */
/* Each page sits in a .pageRow next to its margin column — the row is the white
   sheet, which is the shape the saved page has. When a page was already widened by
   an earlier save, the canvas is drawn full width but the shell is clipped to the
   content area, so the margin column lands exactly over the existing gutter. */

let pageObserver = null;

async function renderAll() {
  if (pageObserver) pageObserver.disconnect();
  el.viewer.innerHTML = '';
  el.viewer.classList.toggle('showMargin', marginMode());

  const shells = [];
  for (let n = 1; n <= state.pdf.numPages; n++) {
    const page = await state.pdf.getPage(n);
    const vp = page.getViewport({ scale: state.scale });
    const gutterPx = (state.gutters.get(n) || 0) * state.scale;
    const contentW = Math.round(vp.width - gutterPx);

    const block = document.createElement('div');
    block.className = 'pageBlock';

    const label = document.createElement('div');
    label.className = 'pageLabel';
    label.textContent = `Page ${n}`;

    const row = document.createElement('div');
    row.className = 'pageRow';

    const shell = document.createElement('div');
    shell.className = 'page';
    shell.dataset.page = String(n);
    shell.style.width = `${contentW}px`;
    shell.style.height = `${Math.round(vp.height)}px`;
    shell._pdfPage = page;
    shell._fullWidth = Math.round(vp.width);
    shell._rendered = false;
    shell.addEventListener('click', onPageClick);

    const hl = document.createElement('div');
    hl.className = 'hlLayer';
    shell.append(hl);

    const margin = document.createElement('div');
    margin.className = 'margin';
    margin.dataset.page = String(n);
    margin.style.width = `${MARGIN.gutter * state.scale}px`;
    margin.style.height = `${Math.round(vp.height)}px`;

    row.append(shell, margin);
    block.append(label, row);
    el.viewer.append(block);
    shells.push(shell);
  }

  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) paintPage(entry.target);
    }
  }, { root: el.viewerPane, rootMargin: '600px 0px' });
  shells.forEach((s) => pageObserver.observe(s));

  drawHighlights();
  drawMarkers();
  renderMargins();
  updatePlacingClass();
}

async function paintPage(shell) {
  if (shell._rendered) return;
  shell._rendered = true;

  const page = shell._pdfPage;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: state.scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${Math.round(vp.width)}px`;
  canvas.style.height = `${Math.round(vp.height)}px`;
  shell.prepend(canvas);

  try {
    await page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport: page.getViewport({ scale: state.scale * dpr }),
      // Our own annotations are drawn live from JSON; painting the baked ones too
      // would double every note on a reopened file.
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    }).promise;
  } catch {
    shell._rendered = false;   // a cancelled render (e.g. zoom mid-flight) can retry
    return;
  }

  // Invisible selectable text on top of the canvas, so passages can be highlighted.
  try {
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.style.width = `${Math.round(vp.width)}px`;
    layer.style.height = `${Math.round(vp.height)}px`;
    layer.style.setProperty('--scale-factor', String(state.scale));
    shell.append(layer);
    await pdfjsLib.renderTextLayer({
      textContent: await page.getTextContent(),
      container: layer,
      viewport: vp,
      textDivs: [],
    }).promise;
  } catch { /* a page with no text layer (pure scan) simply cannot be highlighted */ }
}

/* --------------------------------------------------------------- highlights */

function drawHighlights() {
  el.viewer.querySelectorAll('.hlLayer').forEach((l) => { l.innerHTML = ''; });
  for (const note of state.notes) {
    if (!note.quads || !note.quads.length) continue;
    const shell = el.viewer.querySelector(`.page[data-page="${note.page}"]`);
    const layer = shell && shell.querySelector('.hlLayer');
    if (!layer) continue;
    for (const [x0, y0, x1, y1] of note.quads) {
      const d = document.createElement('div');
      d.className = 'hl' + (note.id === state.activeId ? ' active' : '');
      d.dataset.id = note.id;
      d.style.left = `${x0 * 100}%`;
      d.style.top = `${y0 * 100}%`;
      d.style.width = `${(x1 - x0) * 100}%`;
      d.style.height = `${(y1 - y0) * 100}%`;
      layer.append(d);
    }
  }
}

/* getClientRects() hands back both span-level and line-level rectangles, which
   overlap. Multiply blending would darken those twice, so fold rectangles that sit
   on the same line and touch into a single band. Rects on the same line but far
   apart — two columns of a paper — are left alone. */
function mergeQuads(quads) {
  const out = [];
  for (const q of quads.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const hit = out.find((o) => {
      const overlap = Math.min(o[3], q[3]) - Math.max(o[1], q[1]);
      const minH = Math.min(o[3] - o[1], q[3] - q[1]);
      const sameLine = minH > 0 && overlap > minH * 0.5;
      const xGap = Math.max(o[0], q[0]) - Math.min(o[2], q[2]);
      return sameLine && xGap < 0.01;
    });
    if (hit) {
      hit[0] = Math.min(hit[0], q[0]);
      hit[1] = Math.min(hit[1], q[1]);
      hit[2] = Math.max(hit[2], q[2]);
      hit[3] = Math.max(hit[3], q[3]);
    } else {
      out.push(q.slice());
    }
  }
  return out;
}

/* Turn the current text selection into normalised rectangles on one page. */
function selectionQuads() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

  const range = sel.getRangeAt(0);
  // A stray drag or a click that nudged a pixel is not an annotation.
  if (range.toString().replace(/\s/g, '').length < 2) return null;
  const node = range.commonAncestorContainer;
  const holder = (node.nodeType === 1 ? node : node.parentElement);
  const shell = holder && holder.closest('.page');
  if (!shell) return null;

  const base = shell.getBoundingClientRect();
  const quads = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const q = [
      clamp01((r.left - base.left) / base.width),
      clamp01((r.top - base.top) / base.height),
      clamp01((r.right - base.left) / base.width),
      clamp01((r.bottom - base.top) / base.height),
    ];
    if (q[2] - q[0] > 0.0005 && q[3] - q[1] > 0.0005) quads.push(q);
  }
  if (!quads.length) return null;
  return {
    page: Number(shell.dataset.page),
    quads: mergeQuads(quads),
    rect: range.getBoundingClientRect(),
  };
}

/* Letting go of a text selection highlights it and opens a note straight away.
   No confirmation step: a floating toolbar would sit on top of the very sentence you
   just picked. A highlight you did not want is one click on the note's x to remove.
   Leave the note empty and it saves as a highlight on its own. */
document.addEventListener('mouseup', () => {
  // Let the browser finish settling the selection before reading it.
  setTimeout(commitSelection, 10);
});

function commitSelection() {
  if (state.placing) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;

  const found = selectionQuads();
  if (!found) return;
  window.getSelection().removeAllRanges();

  // Anchor the note to the top-left of the passage, so the margin text lines up
  // with the first highlighted line.
  const top = Math.min(...found.quads.map((q) => q[1]));
  const left = Math.min(...found.quads.map((q) => q[0]));
  return addNote(found.page, left, top, found.quads, true);
}

/* --------------------------------------------------------------- placing notes */

el.placeBtn.addEventListener('click', () => setPlacing(!state.placing));

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape' && state.placing) setPlacing(false);
  if (e.key.toLowerCase() === 'n' && !typing && !el.placeBtn.disabled) setPlacing(!state.placing);
});

function setPlacing(on) {
  state.placing = on;
  el.placeBtn.classList.toggle('on', on);
  el.hint.hidden = !on;
  updatePlacingClass();
}

function updatePlacingClass() {
  el.viewer.querySelectorAll('.page').forEach((p) => p.classList.toggle('placing', state.placing));
}

function onPageClick(e) {
  if (!state.placing) return;
  const shell = e.currentTarget;
  const rect = shell.getBoundingClientRect();
  addNote(
    Number(shell.dataset.page),
    (e.clientX - rect.left) / rect.width,
    (e.clientY - rect.top) / rect.height,
  );
  setPlacing(false);
}

function addNote(page, nx, ny, quads = [], dictate = true) {
  const note = {
    id: uid(),
    page,
    nx: clamp01(nx),
    ny: clamp01(ny),
    text: '',
    quads,
    createdAt: new Date().toISOString(),
  };
  // Reading order: down the page, then page by page.
  state.notes.push(note);
  state.notes.sort((a, b) => a.page - b.page || a.ny - b.ny);
  state.activeId = note.id;
  saveLocal();
  renderNotes();
  drawHighlights();
  drawMarkers();
  renderMargins();

  const target = marginMode()
    ? el.viewer.querySelector(`.mNote[data-id="${note.id}"] textarea`)
    : el.noteList.querySelector(`[data-id="${note.id}"] textarea`);
  if (target) target.focus();

  if (dictate) startListening(note.id);
  return note;
}

function deleteNote(id) {
  if (state.listeningId === id) stopListening();
  state.notes = state.notes.filter((n) => n.id !== id);
  if (state.activeId === id) state.activeId = null;
  saveLocal();
  renderNotes();
  drawHighlights();
  drawMarkers();
  renderMargins();
}

/* ------------------------------------------------------------------- markers */

function drawMarkers() {
  el.viewer.querySelectorAll('.marker').forEach((m) => m.remove());
  state.notes.forEach((note, i) => {
    const shell = el.viewer.querySelector(`.page[data-page="${note.page}"]`);
    if (!shell) return;
    const m = document.createElement('div');
    m.className = 'marker' + (note.id === state.activeId ? ' active' : '');
    m.style.left = `${note.nx * 100}%`;
    m.style.top = `${note.ny * 100}%`;
    m.textContent = String(i + 1);
    m.title = note.text ? note.text.slice(0, 120) : 'Empty note — drag to move';
    m.dataset.id = note.id;
    m.addEventListener('pointerdown', onMarkerDown);
    shell.append(m);
  });
}

function onMarkerDown(e) {
  e.stopPropagation();
  const marker = e.currentTarget;
  const note = state.notes.find((n) => n.id === marker.dataset.id);
  if (!note) return;

  const rect = marker.parentElement.getBoundingClientRect();
  let moved = false;

  marker.setPointerCapture(e.pointerId);
  marker.classList.add('dragging');

  const onMove = (ev) => {
    if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 3) moved = true;
    if (!moved) return;
    note.nx = clamp01((ev.clientX - rect.left) / rect.width);
    note.ny = clamp01((ev.clientY - rect.top) / rect.height);
    marker.style.left = `${note.nx * 100}%`;
    marker.style.top = `${note.ny * 100}%`;
    layoutMargins();          // the margin note follows the marker down the page
  };

  const onUp = () => {
    marker.removeEventListener('pointermove', onMove);
    marker.removeEventListener('pointerup', onUp);
    marker.classList.remove('dragging');
    if (moved) saveLocal();
    else focusNote(note.id);
  };

  marker.addEventListener('pointermove', onMove);
  marker.addEventListener('pointerup', onUp);
}

function focusNote(id) {
  setActive(id);
  const target = marginMode()
    ? el.viewer.querySelector(`.mNote[data-id="${id}"] textarea`)
    : el.noteList.querySelector(`[data-id="${id}"] textarea`);
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus();
  }
}

function scrollToNote(note) {
  const shell = el.viewer.querySelector(`.page[data-page="${note.page}"]`);
  if (shell) shell.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* Light-touch state refreshes. A full re-render would steal the caret out of
   whichever box the user is typing or dictating into. */

function setActive(id) {
  state.activeId = id;
  el.viewer.querySelectorAll('.marker').forEach((m) => m.classList.toggle('active', m.dataset.id === id));
  el.viewer.querySelectorAll('.hl').forEach((m) => m.classList.toggle('active', m.dataset.id === id));
  el.viewer.querySelectorAll('.mNote').forEach((m) => m.classList.toggle('active', m.dataset.id === id));
  el.noteList.querySelectorAll('.note').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
}

function refreshMicButtons() {
  document.querySelectorAll('.mic').forEach((b) => {
    const on = b.dataset.id === state.listeningId;
    b.classList.toggle('rec', on);
    b.title = on ? 'Stop dictating' : 'Dictate into this note';
  });
}

/* --------------------------------------------------------- margin note boxes */

const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
  + '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>'
  + '<path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v4"/></svg>';

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function renderMargins() {
  el.viewer.querySelectorAll('.margin').forEach((m) => { m.innerHTML = ''; });
  if (!marginMode()) return;

  for (const note of state.notes) {
    const margin = el.viewer.querySelector(`.margin[data-page="${note.page}"]`);
    if (!margin) continue;

    const box = document.createElement('div');
    box.className = 'mNote' + (note.id === state.activeId ? ' active' : '');
    box.dataset.id = note.id;
    box.style.left = `${MARGIN.pad * state.scale}px`;
    box.style.width = `${(MARGIN.gutter - MARGIN.pad * 2) * state.scale}px`;

    const ta = document.createElement('textarea');
    ta.value = note.text;
    ta.rows = 1;
    ta.placeholder = 'Talk, or type…';
    ta.style.fontSize = `${Math.max(MARGIN.size * state.scale, 9)}px`;
    ta.style.lineHeight = `${MARGIN.lead / MARGIN.size}`;
    ta.addEventListener('input', () => {
      note.text = ta.value;
      syncText(note, ta);
      autoGrow(ta);
      layoutMargins();
      saveLocal();
    });
    ta.addEventListener('focus', () => setActive(note.id));

    const tools = document.createElement('div');
    tools.className = 'mTools';

    const mic = document.createElement('button');
    mic.className = 'mic tiny' + (state.listeningId === note.id ? ' rec' : '');
    mic.dataset.id = note.id;
    mic.innerHTML = MIC_SVG;
    mic.title = state.listeningId === note.id ? 'Stop dictating' : 'Dictate into this note';
    mic.addEventListener('click', () => {
      if (state.listeningId === note.id) stopListening();
      else startListening(note.id);
    });

    const del = document.createElement('button');
    del.className = 'del tiny';
    del.textContent = '×';
    del.title = 'Delete note';
    del.addEventListener('click', () => deleteNote(note.id));

    tools.append(mic, del);

    const interim = document.createElement('div');
    interim.className = 'interim';
    interim.dataset.interimFor = note.id;

    box.append(tools, ta, interim);
    margin.append(box);
    autoGrow(ta);
  }
  layoutMargins();
}

/* Place each note beside its paragraph, then push it down if the note above
   already occupies that space. Same rule the exporter uses. */
function layoutMargins() {
  el.viewer.querySelectorAll('.margin').forEach((margin) => {
    const pageNum = Number(margin.dataset.page);
    const height = margin.clientHeight;
    const items = state.notes
      .filter((n) => n.page === pageNum)
      .sort((a, b) => a.ny - b.ny);

    let cursor = MARGIN.edge * state.scale;
    for (const note of items) {
      const box = margin.querySelector(`.mNote[data-id="${note.id}"]`);
      if (!box) continue;
      const h = box.offsetHeight;
      const desired = note.ny * height;
      const latest = height - MARGIN.edge * state.scale - h;
      const top = Math.max(cursor, Math.min(desired, Math.max(latest, cursor)));
      box.style.top = `${top}px`;
      cursor = top + h + MARGIN.gap * state.scale;
    }
  });
}

/* Keep the margin box and the rail card showing the same text. */
function syncText(note, source) {
  document.querySelectorAll(`[data-id="${note.id}"] textarea`).forEach((ta) => {
    if (ta === source) return;
    ta.value = note.text;
    if (ta.closest('.mNote')) autoGrow(ta);
  });
  const marker = el.viewer.querySelector(`.marker[data-id="${note.id}"]`);
  if (marker) marker.title = note.text.slice(0, 120) || 'Empty note — drag to move';
}

/* ---------------------------------------------------------------- note cards */

function renderNotes() {
  el.noteList.innerHTML = '';
  el.noteCount.textContent = String(state.notes.length);
  el.railEmpty.hidden = state.notes.length > 0;

  state.notes.forEach((note, i) => {
    const card = document.createElement('div');
    card.className = 'note' + (note.id === state.activeId ? ' active' : '');
    card.dataset.id = note.id;

    const top = document.createElement('div');
    top.className = 'noteTop';

    const idx = document.createElement('span');
    idx.className = 'noteIdx';
    idx.textContent = String(i + 1);

    const pageLink = document.createElement('span');
    pageLink.className = 'notePage';
    pageLink.textContent = `Page ${note.page}${note.quads && note.quads.length ? ' ·' : ''}`;
    pageLink.title = note.quads && note.quads.length ? 'Has a highlight' : '';
    pageLink.addEventListener('click', () => { setActive(note.id); scrollToNote(note); });

    const mic = document.createElement('button');
    mic.className = 'mic' + (state.listeningId === note.id ? ' rec' : '');
    mic.dataset.id = note.id;
    mic.innerHTML = MIC_SVG;
    mic.title = state.listeningId === note.id ? 'Stop dictating' : 'Dictate into this note';
    mic.addEventListener('click', () => {
      if (state.listeningId === note.id) stopListening();
      else startListening(note.id);
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete note';
    del.addEventListener('click', () => deleteNote(note.id));

    top.append(idx, pageLink, mic, del);

    const ta = document.createElement('textarea');
    ta.value = note.text;
    ta.placeholder = 'Talk, or type…';
    ta.addEventListener('input', () => {
      note.text = ta.value;
      syncText(note, ta);
      layoutMargins();
      saveLocal();
    });
    ta.addEventListener('focus', () => setActive(note.id));

    const interim = document.createElement('div');
    interim.className = 'interim';
    interim.dataset.interimFor = note.id;

    card.append(top, ta, interim);
    el.noteList.append(card);
  });
}

/* ------------------------------------------------------------------ dictation */
/* Web Speech API. Edge and Chrome ship it; Firefox and Safari do not, hence the
   warning banner — typing still works there. */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let wantListening = false;   // distinguishes "user stopped" from "engine timed out"

if (!SpeechRec) el.micWarn.hidden = false;

const PUNCT = [
  [/\b(new paragraph)\b/gi, '\n\n'],
  [/\b(new line|newline)\b/gi, '\n'],
  [/\b(full stop|period)\b/gi, '.'],
  [/\b(comma)\b/gi, ','],
  [/\b(question mark)\b/gi, '?'],
  [/\b(exclamation mark|exclamation point)\b/gi, '!'],
  [/\b(colon)\b/gi, ':'],
  [/\b(semicolon)\b/gi, ';'],
  [/\b(dash|hyphen)\b/gi, '—'],
];

function applyCommands(text) {
  if (!el.cmdChk.checked) return text;
  let out = text;
  for (const [re, ch] of PUNCT) out = out.replace(re, ch);
  return out
    .replace(/\s+([.,?!:;])/g, '$1')      // no space before punctuation
    .replace(/\s*\n\s*/g, '\n');          // tidy up around line breaks
}

function appendTranscript(note, chunk) {
  let text = applyCommands(chunk.trim());
  if (!text) return;

  const prev = note.text;
  const needsSpace = prev.length > 0 && !/[\s\n]$/.test(prev);
  // Capitalise when we are starting a fresh sentence.
  const startsSentence = !prev.trim() || /[.!?\n]["')\]]?\s*$/.test(prev);
  if (startsSentence && /^[a-z]/.test(text)) text = text[0].toUpperCase() + text.slice(1);

  note.text = prev + (needsSpace ? ' ' : '') + text;

  document.querySelectorAll(`[data-id="${note.id}"] textarea`).forEach((ta) => {
    ta.value = note.text;
    if (ta.closest('.mNote')) autoGrow(ta);
    else ta.scrollTop = ta.scrollHeight;
  });
  layoutMargins();
  saveLocal();
}

function setInterim(id, text) {
  document.querySelectorAll(`[data-interim-for="${id}"]`).forEach((box) => { box.textContent = text; });
  layoutMargins();
}

function startListening(id) {
  if (!SpeechRec) { el.micWarn.hidden = false; return; }
  if (state.listeningId && state.listeningId !== id) stopListening();

  const note = state.notes.find((n) => n.id === id);
  if (!note) return;

  recognition = new SpeechRec();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = el.langSelect.value;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) appendTranscript(note, res[0].transcript);
      else interim += res[0].transcript;
    }
    setInterim(id, interim);
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;  // benign; onend restarts
    wantListening = false;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast('Microphone blocked. Allow mic access for this page, then press the mic again.', 5000);
    } else {
      toast(`Dictation stopped: ${event.error}`);
    }
    stopListening();
  };

  // The engine cuts itself off after a pause; restart it until the user says stop.
  recognition.onend = () => {
    if (wantListening && state.listeningId === id) {
      try { recognition.start(); } catch { stopListening(); }
    }
  };

  wantListening = true;
  state.listeningId = id;
  try {
    recognition.start();
  } catch {
    wantListening = false;
    state.listeningId = null;
    toast('Could not start the microphone.');
  }
  setActive(id);
  refreshMicButtons();
}

function stopListening() {
  wantListening = false;
  const id = state.listeningId;
  state.listeningId = null;
  if (recognition) {
    recognition.onend = null;
    try { recognition.stop(); } catch { /* already stopped */ }
    recognition = null;
  }
  if (id) setInterim(id, '');
  refreshMicButtons();
}

const LANGS = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR'];
el.langSelect.value = LANGS.includes(navigator.language) ? navigator.language : 'en-US';
el.langSelect.addEventListener('change', () => {
  if (state.listeningId) {
    const id = state.listeningId;
    stopListening();
    startListening(id);
  }
});

/* ------------------------------------------------------------ style / zoom */

el.styleSelect.addEventListener('change', () => {
  el.viewer.classList.toggle('showMargin', marginMode());
  renderMargins();
});

el.zoomIn.addEventListener('click', () => setScale(state.scale + 0.25));
el.zoomOut.addEventListener('click', () => setScale(state.scale - 0.25));

async function setScale(next) {
  state.scale = Math.min(Math.max(next, 0.5), 3);
  el.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  if (state.pdf) await renderAll();
}

/* ------------------------------------------------------- page geometry maths */
/* Everything is laid out in "visual space": the page as the reader sees it, origin
   top-left, /Rotate already applied. These helpers convert that back into PDF user
   space, which is bottom-left and rotation-free. */

const normRot = (angle) => ((Math.round(angle / 90) * 90) % 360 + 360) % 360;

// pdf.js renders the CropBox, so that — not the MediaBox — is the visible page.
function visualBox(page) {
  const crop = page.getCropBox();
  return (crop && crop.width && crop.height) ? crop : page.getMediaBox();
}

// Absolute point in visual space -> absolute point in PDF user space.
function visualToUser(vx, vy, box, rot) {
  const W = box.width, H = box.height;
  let u, v;
  switch (rot) {
    case 90:  u = vy;      v = vx;      break;
    case 180: u = W - vx;  v = vy;      break;
    case 270: u = W - vy;  v = H - vx;  break;
    default:  u = vx;      v = H - vy;  break;
  }
  return { x: box.x + u, y: box.y + v };
}

// Rectangle in visual space -> [x0, y0, x1, y1] in user space.
function visualRectToUser(vx0, vy0, vx1, vy1, box, rot) {
  const a = visualToUser(vx0, vy0, box, rot);
  const b = visualToUser(vx1, vy1, box, rot);
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

/* An appearance stream is authored upright and then rotated into place by /Matrix,
   which is why the same content works on a sideways-scanned page. */
const ROT_MATRIX = {
  0: [1, 0, 0, 1, 0, 0],
  90: [0, 1, -1, 0, 0, 0],
  180: [-1, 0, 0, -1, 0, 0],
  270: [0, -1, 1, 0, 0, 0],
};

/* Extend the page box so a blank column appears to the right of the content.
   Which user-space edge that is depends on /Rotate. */
function widenBox(page, box, rot, gutter) {
  let { x, y, width, height } = box;
  switch (rot) {
    case 90:  height += gutter; break;
    case 180: x -= gutter; width += gutter; break;
    case 270: y -= gutter; height += gutter; break;
    default:  width += gutter; break;
  }
  page.setMediaBox(x, y, width, height);
  page.setCropBox(x, y, width, height);
  return { x, y, width, height };
}

function wrapLines(text, font, size, maxWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let cur = '';
    for (const word of para.split(/\s+/)) {
      const test = cur ? `${cur} ${word}` : word;
      if (cur && font.widthOfTextAtSize(test, size) > maxWidth) { out.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/* StandardFonts are Latin-1 only. Drawn margin text has to be folded; the JSON and
   the annotation /Contents keep full Unicode. */
function latin1(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x00-\xFF]/g, '?');
}

const pdfEscape = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = (n) => (Math.round(n * 1000) / 1000).toString();

/* --------------------------------------------------------------- PDF export */

function addAnnot(doc, page, dict) {
  const ref = doc.context.register(doc.context.obj(dict));
  // Untyped lookup: the typed form throws when the page has no /Annots yet.
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

/* Remove every annotation this tool wrote on an earlier save, so regenerating from
   the JSON never stacks two copies of the same note. */
function stripOurAnnots(page) {
  const arr = page.node.lookup(PDFName.of('Annots'));
  if (!(arr instanceof PDFArray)) return;
  for (let i = arr.size() - 1; i >= 0; i--) {
    let entry;
    try { entry = arr.lookup(i); } catch { continue; }
    if (entry instanceof PDFDict && entry.get(K_TAG)) arr.remove(i);
  }
}

function highlightAppearance(doc, quads, vx0, vy0, vx1, vy1, rot) {
  const w = vx1 - vx0, h = vy1 - vy0;
  const ops = ['/GSm gs', `${num(HILITE[0])} ${num(HILITE[1])} ${num(HILITE[2])} rg`];
  for (const [qx0, qy0, qx1, qy1] of quads) {
    // Form space is bottom-up; visual space is top-down.
    ops.push(`${num(qx0 - vx0)} ${num(h - (qy1 - vy0))} ${num(qx1 - qx0)} ${num(qy1 - qy0)} re f`);
  }
  return doc.context.register(doc.context.flateStream(new TextEncoder().encode(ops.join('\n')), {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, w, h],
    Matrix: ROT_MATRIX[rot],
    // Multiply lets the page text show through the ink, like a real highlighter.
    Resources: { ExtGState: { GSm: { Type: 'ExtGState', BM: 'Multiply', ca: 1, CA: 1 } } },
  }));
}

function marginAppearance(doc, font, lines, w, h, rot) {
  const ops = ['BT', `${num(INK[0])} ${num(INK[1])} ${num(INK[2])} rg`, `/F1 ${num(MARGIN.size)} Tf`,
    `1 0 0 1 0 ${num(h - MARGIN.size)} Tm`];
  lines.forEach((line, i) => {
    if (i > 0) ops.push(`0 ${num(-MARGIN.lead)} Td`);
    if (line) ops.push(`(${pdfEscape(line)}) Tj`);
  });
  ops.push('ET');
  return doc.context.register(doc.context.flateStream(new TextEncoder().encode(ops.join('\n')), {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, w, h],
    Matrix: ROT_MATRIX[rot],
    Resources: { Font: { F1: font.ref } },
  }));
}

async function buildAnnotatedPdf() {
  const doc = await PDFDocument.load(state.bytes.slice(), { ignoreEncryption: true });
  const style = el.styleSelect.value;
  const wantMargin = style === 'margin' || style === 'both';
  const wantSticky = style === 'sticky' || style === 'both';
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const now = new Date();

  const byPage = new Map();
  state.notes.forEach((note, i) => {
    if (!hasContent(note)) return;
    const p = Math.min(Math.max(note.page, 1), doc.getPageCount());
    if (!byPage.has(p)) byPage.set(p, []);
    byPage.get(p).push({ note, index: i + 1 });
  });

  // Any page we touched before must be cleaned, even if its notes are all gone now.
  const pagesToClean = new Set([...byPage.keys()]);
  for (let i = 1; i <= doc.getPageCount(); i++) {
    if (pageGutter(doc.getPage(i - 1))) pagesToClean.add(i);
  }
  for (const p of pagesToClean) stripOurAnnots(doc.getPage(p - 1));

  for (const [pageNum, items] of byPage) {
    const page = doc.getPage(pageNum - 1);
    const rot = normRot(page.getRotation().angle);
    const box = visualBox(page);

    // Visual size as the reader sees it, minus any gutter an earlier save added.
    const Wfull = rot % 180 === 0 ? box.width : box.height;
    const Hv = rot % 180 === 0 ? box.height : box.width;
    const already = pageGutter(page);
    const Wc = Wfull - already;

    // Highlights sit under everything else and are independent of the note style.
    for (const { note } of items) {
      if (!note.quads || !note.quads.length) continue;
      drawHighlight(doc, page, note, box, rot, Wc, Hv, now);
    }

    if (wantSticky) {
      for (const { note, index } of items) {
        if (!note.text.trim()) continue;
        addSticky(doc, page, note, index, box, rot, Wc, Hv, now);
      }
    }

    if (wantMargin) {
      const wide = already ? box : widenBox(page, box, rot, MARGIN.gutter);
      if (!already) page.node.set(K_GUTTER, doc.context.obj(MARGIN.gutter));
      drawMarginColumn(doc, page, items, font, wide, rot, Wc, Hv, now);
    }
  }

  // The durable copy: whatever we just drew can be rebuilt from this.
  const json = JSON.stringify({ v: 1, savedAt: now.toISOString(), notes: state.notes });
  const stream = doc.context.flateStream(new TextEncoder().encode(json), { Type: 'PVNData' });
  doc.catalog.set(K_NOTES, doc.context.register(stream));

  if (el.summaryChk.checked) await appendSummary(doc, font);

  doc.setModificationDate(now);
  return doc.save();
}

function drawHighlight(doc, page, note, box, rot, Wc, Hv, now) {
  const vq = note.quads.map(([x0, y0, x1, y1]) => [x0 * Wc, y0 * Hv, x1 * Wc, y1 * Hv]);
  const vx0 = Math.min(...vq.map((q) => q[0]));
  const vy0 = Math.min(...vq.map((q) => q[1]));
  const vx1 = Math.max(...vq.map((q) => q[2]));
  const vy1 = Math.max(...vq.map((q) => q[3]));

  // QuadPoints run upper-left, upper-right, lower-left, lower-right per quad.
  const quadPoints = [];
  for (const [qx0, qy0, qx1, qy1] of vq) {
    for (const [vx, vy] of [[qx0, qy0], [qx1, qy0], [qx0, qy1], [qx1, qy1]]) {
      const p = visualToUser(vx, vy, box, rot);
      quadPoints.push(p.x, p.y);
    }
  }

  addAnnot(doc, page, {
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: visualRectToUser(vx0, vy0, vx1, vy1, box, rot),
    QuadPoints: quadPoints,
    C: HILITE,
    CA: 1,
    F: 4,
    Contents: PDFHexString.fromText(note.text.trim()),
    T: PDFHexString.fromText('Voice notes'),
    M: PDFString.fromDate(now),
    P: page.ref,
    AP: { N: highlightAppearance(doc, vq, vx0, vy0, vx1, vy1, rot) },
    PVN: PDFHexString.fromText(note.id),
  });
}

function addSticky(doc, page, note, index, box, rot, Wc, Hv, now) {
  const ICON = 22;
  const vx = Math.min(note.nx * Wc, Math.max(Wc - ICON, 0));
  const vy = Math.min(Math.max(note.ny * Hv, 0), Math.max(Hv - ICON, 0));

  addAnnot(doc, page, {
    Type: 'Annot',
    Subtype: 'Text',
    Name: 'Comment',
    Rect: visualRectToUser(vx, vy, vx + ICON, vy + ICON, box, rot),
    Contents: PDFHexString.fromText(note.text.trim()),
    T: PDFHexString.fromText('Voice notes'),
    Subj: PDFHexString.fromText(`Note ${index}`),
    C: [0.95, 0.76, 0.31],
    CA: 1,
    F: 4,
    M: PDFString.fromDate(new Date(note.createdAt)),
    P: page.ref,
    Open: false,
    PVN: PDFHexString.fromText(note.id),
  });
}

/* Draw the notes into the blank column, each beside its paragraph, pushed down when
   the note above would overlap it. Mirrors layoutMargins() on screen. */
function drawMarginColumn(doc, page, items, font, box, rot, Wc, Hv, now) {
  const colX = Wc + MARGIN.pad;
  const colW = MARGIN.gutter - MARGIN.pad * 2;

  let cursor = MARGIN.edge;
  for (const { note } of items.slice().sort((a, b) => a.note.ny - b.note.ny)) {
    const text = note.text.trim();
    if (!text) continue;
    const lines = wrapLines(latin1(text), font, MARGIN.size, colW);
    const blockH = lines.length * MARGIN.lead;
    const latest = Hv - MARGIN.edge - blockH;
    const top = Math.max(cursor, Math.min(note.ny * Hv, Math.max(latest, cursor)));

    addAnnot(doc, page, {
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: visualRectToUser(colX, top, colX + colW, top + blockH, box, rot),
      Contents: PDFHexString.fromText(text),
      T: PDFHexString.fromText('Voice notes'),
      DA: PDFString.of(`/Helv ${num(MARGIN.size)} Tf ${num(INK[0])} ${num(INK[1])} ${num(INK[2])} rg`),
      Q: 0,
      F: 4,
      C: [],
      BS: { W: 0, S: 'S' },
      M: PDFString.fromDate(now),
      P: page.ref,
      AP: { N: marginAppearance(doc, font, lines, colW, blockH, rot) },
      PVN: PDFHexString.fromText(note.id),
    });

    cursor = top + blockH + MARGIN.gap;
  }
}

async function appendSummary(doc, font) {
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 56, SIZE = 11, LEAD = 15.5;

  let page = doc.addPage([W, H]);
  let y = H - M;

  const line = (str, f, size, color) => {
    if (y < M) { page = doc.addPage([W, H]); y = H - M; }
    page.drawText(str, { x: M, y, size, font: f, color });
    y -= size === SIZE ? LEAD : size + 7;
  };

  line('Voice notes', bold, 20, rgb(0, 0, 0));
  line(state.name, font, 10, rgb(0.45, 0.45, 0.45));
  y -= 10;

  state.notes.forEach((note, i) => {
    const text = note.text.trim();
    if (!text) return;
    if (y < M + 60) { page = doc.addPage([W, H]); y = H - M; }
    line(`${i + 1}.  Page ${note.page}`, bold, 11, rgb(0.62, 0.32, 0.15));
    for (const l of wrapLines(latin1(text), font, SIZE, W - M * 2)) {
      line(l, font, SIZE, rgb(0.1, 0.1, 0.1));
    }
    y -= 8;
  });
}

/* ------------------------------------------------------------------- saving */

function suggestedName() {
  return /\bnotes\b/i.test(state.name)
    ? state.name
    : `${state.name.replace(/\.pdf$/i, '')} - notes.pdf`;
}

/* After writing to a file we now hold, re-open those bytes so the view, the
   autosave key and the file on disk all describe the same thing. */
async function adoptSavedBytes(bytes, name, handle) {
  state.bytes = bytes.slice();
  state.name = name;
  if (handle) state.fileHandle = handle;
  state.key = `pvn:${state.name}:${state.bytes.length}`;
  const embedded = await readEmbedded(state.bytes);
  state.gutters = embedded.gutters;
  saveLocal();
  await loadIntoViewer(state.bytes);
  renderNotes();
  el.fileName.textContent = state.name;
  el.overwriteBtn.hidden = !state.fileHandle;
  el.overwriteBtn.disabled = !state.fileHandle;
}

el.saveBtn.addEventListener('click', async () => {
  if (!state.pdf) return;
  if (!state.notes.some(hasContent)) { toast('Nothing to save yet — add a note or a highlight.'); return; }

  el.saveBtn.disabled = true;
  el.saveBtn.textContent = 'Saving…';
  try {
    const bytes = await buildAnnotatedPdf();

    if (window.showSaveFilePicker) {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: suggestedName(),
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return;   // user cancelled
      }
      if (handle) {
        const w = await handle.createWritable();
        await w.write(bytes);
        await w.close();
        await adoptSavedBytes(bytes, handle.name, handle);
        toast(`Saved to ${handle.name}. Keep editing — this file is now the one open.`, 5000);
        return;
      }
    }

    download(bytes, suggestedName());
    toast('Saved to your Downloads folder.');
  } catch (err) {
    console.error(err);
    toast(`Could not save: ${err.message}`, 6000);
  } finally {
    el.saveBtn.disabled = false;
    el.saveBtn.textContent = 'Save annotated PDF…';
  }
});

el.overwriteBtn.addEventListener('click', async () => {
  if (!state.fileHandle) return;
  const ok = confirm(
    `Overwrite "${state.name}" in place?\n\n`
    + 'The file is replaced by the annotated version. Your notes stay editable — '
    + 'reopening this file brings them all back.',
  );
  if (!ok) return;

  el.overwriteBtn.disabled = true;
  try {
    const bytes = await buildAnnotatedPdf();
    const w = await state.fileHandle.createWritable();
    await w.write(bytes);
    await w.close();
    await adoptSavedBytes(bytes, state.name, state.fileHandle);
    toast(`Saved over ${state.name}.`);
  } catch (err) {
    console.error(err);
    toast(`Could not overwrite: ${err.message}`, 6000);
  } finally {
    el.overwriteBtn.disabled = false;
  }
});

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

window.addEventListener('beforeunload', (e) => {
  if (state.notes.some(hasContent)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
