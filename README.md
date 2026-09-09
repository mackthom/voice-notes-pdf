# PDF Voice Notes

Open a PDF, highlight a passage, and **talk** instead of typing. Your note appears
in the page margin — visible straight away, no hovering or clicking to reveal it.

**Your notes are saved inside the PDF itself.** Keep one annotated PDF per reading;
reopen it here any time and every note and highlight comes back, still editable.

Nothing is uploaded. No account, no API key, no cost.

---

## Setup

### What you need

| Thing | Why | Do you have it? |
| --- | --- | --- |
| **Node.js 20+** | Runs the tiny local web server (`serve.mjs`) | You already have Node 24 for bookScanner — nothing to install |
| **Microsoft Edge or Chrome** | They ship the speech recognition engine this uses | Edge is already on your machine |

Nothing to install, nothing to sign up for. The two libraries this uses
(pdf.js and pdf-lib) are already downloaded into `vendor/`, so it also works offline.

### Run it

Double-click **`start.cmd`**, or from a terminal:

```bash
node C:\Desktop\bookScanner\pdf-voice-notes\serve.mjs
```

Your browser opens at <http://localhost:8777/>. Leave the terminal window open while
you work; Ctrl+C stops it. There's a `test.pdf` in the folder if you want something
to try it on first.

> **Why a server instead of just double-clicking `index.html`?**
> Browsers only hand out the microphone on a "secure context" — `https://` or
> `http://localhost`. Open the file directly (`file:///...`) and dictation silently
> does nothing. The server exists purely to satisfy that rule; it serves this one
> folder to your own machine and nothing else.

### First run: allow the microphone

The first time you press a mic button, Edge asks for microphone permission.
**You have to click Allow yourself** — I can't grant it for you. Choose "Allow on
every visit" so it stops asking.

If you accidentally block it: click the padlock in the address bar → Permissions →
set Microphone to Allow → reload.

---

## Using it

1. **Open PDF…** — or drag a PDF onto the page.
2. **Select the sentence** you're reacting to. It highlights in yellow and a note
   opens beside it — no button to press, nothing covering the text you just picked.
   No particular sentence in mind? Hit **+ Add note** (or <kbd>N</kbd>) and click
   anywhere on the page instead.
   Highlighted something by accident? The **×** on the note removes both. Want the
   highlight without a comment? Just leave the note empty.
3. **Dictation starts automatically.** Talk. Words appear in the margin as you speak;
   grey italic text is what it's still deciding on. Press the mic again to stop.
4. Repeat. Drag a marker to move a note up or down — the margin text follows it.
5. **Save annotated PDF…** — pick where it goes. Default name is
   `yourbook - notes.pdf`.

The white sheet on screen — page plus margin column — is the same shape the saved
page will be, so what you see is what you get.

Highlighting needs a real text layer, so it works on any normal PDF but not on a
photographed page that has never been OCR'd. Point notes work on those either way.

### Notes as…

The **Notes as** dropdown in the toolbar decides what ends up in the file:

| Setting | What the saved PDF looks like |
| --- | --- |
| **Margin text** (default) | The page is widened by 170pt and your notes are printed in that new column in blue, level with the paragraph they're about. Always visible, prints, survives any reader. |
| **Sticky notes** | Page size untouched. Each note becomes a standard PDF comment — a small yellow icon you hover or click. This is what Edge's own comment tool makes. |
| **Both** | Margin text *and* a clickable comment, for when you want the full text recoverable even if a note got trimmed. |

Notes that would collide are pushed down the column, in reading order, so they never
overlap each other.

### Voice punctuation

While the "Voice punctuation" box is ticked, these spoken words become symbols:

`period` · `comma` · `question mark` · `exclamation mark` · `colon` · `semicolon` ·
`dash` · `new line` · `new paragraph`

So *"the author overstates this comma especially in chapter four period new paragraph
worth revisiting"* comes out properly punctuated across two paragraphs. Untick the box
if you actually need to write the word "period".

### Summary pages

Tick **Summary pages** before saving to append a plain, printable list of every note
with its page number at the end of the PDF. Margin notes are great while reading;
the list is what you actually reread when you're trying to remember the book.

---

## Saving, and where your work lives

**The PDF is the save file.** Every time you save, this tool writes your notes into
the document twice over: once as the visible highlights and margin text that any
reader shows, and once as hidden structured data that only this app reads. Reopening
that PDF here restores all of it — text, highlights, positions — fully editable.

That gives you exactly the workflow you want: **one annotated PDF per reading.**
Open it, talk, save. Come back next week, open the same file, and pick up where you
stopped. Re-saving never stacks duplicates or widens the page a second time; the tool
strips its own previous marks and redraws them from the data.

Two ways to save:

- **Save annotated PDF…** asks where to put it. After saving, that new file becomes
  the one you're editing, so you can keep talking and save again.
- **Overwrite original** replaces the file you opened, in place. It only appears when
  you opened the file through the **Open PDF…** button — that's what gives the browser
  permission to write back, and drag-and-drop doesn't. It confirms first.

Notes also autosave to the browser as you talk, keyed to the file's name and size.
That's only a crash net for the current session — if the tab dies before you save,
reopen the same PDF and your notes are waiting. The durable copy is the one in the
file.

## Limits worth knowing

- **Firefox and Safari have no built-in speech recognition.** The app says so and
  typing still works, but for dictation use Edge or Chrome.
- Edge/Chrome dictation sends audio to Microsoft's/Google's speech service. That's
  how the browser API works. The **PDF** never leaves your machine — only the audio
  while the mic is on.
- **Highlighting needs selectable text.** A scanned page with no OCR layer can't be
  highlighted; point notes still work on it.
- Because selecting text is what creates a highlight, selecting a line just to copy it
  leaves one behind. The **×** on the note clears it.
- **Margin text mode changes the page size** (adds 170pt of width). That's deliberate
  — it guarantees the notes never cover the text you're annotating. Use *Sticky notes*
  if you need the original page dimensions preserved exactly.
- Printed margin text uses a Latin-1 font: smart quotes and dashes are folded to plain
  ones, and non-Western characters become `?`. The editable copy inside the file keeps
  full Unicode, so nothing you dictate is ever lost — only its printed form is folded.
- Notes anchor to a position on a page, not to the words. Re-export the source PDF
  with different pagination and they won't follow.
- Editing a note in another PDF reader (Acrobat, Edge) changes what that reader shows,
  but not the hidden data this app reads — so your next save here will overwrite it.
  Edit notes in this app.

---

## How it works

| Piece | Job |
| --- | --- |
| `vendor/pdf.min.js` (pdf.js) | Renders pages to canvas and builds the invisible text layer that makes highlighting possible. Pages paint lazily as you scroll, so a 400-page book opens instantly |
| Web Speech API | Dictation. Restarts itself when the engine times out on a pause, so long thoughts don't get cut off |
| `vendor/pdf-lib.min.js` | Widens each annotated page, writes the highlights and margin text as annotations, and embeds the note JSON in the document catalog |
| `serve.mjs` | ~40 lines of Node. Exists only to make `localhost` a secure context |

**Why the notes stay editable.** Everything this tool draws goes in as *annotations*
carrying a private `/PVN` tag, never as page content — content, once drawn, can't be
taken back out. On save it deletes every tagged annotation and regenerates the lot
from the JSON. That is what makes reopening, editing and re-saving the same file
lossless, and why the page is widened only once no matter how often you save.

Each annotation carries an appearance stream this tool draws itself rather than
relying on the reader to invent one, so the highlight and the margin text look the
same in Edge, Acrobat and Preview. Highlights use a multiply blend, which is why the
page text stays readable through the ink.

Note positions are stored as fractions of the *content* area (0–1), excluding any
margin column an earlier save added. That's what keeps a note anchored to the same
sentence no matter how many times the file is reopened and re-saved.

All layout happens in "visual space" — the page as you see it, origin top-left,
`/Rotate` already applied — and is converted back to PDF user space at the last
moment. That's why margin notes read upright and land in the right-hand column even
on a sideways-scanned page.

## Verified

Checked against the real exported file rather than by eye:

- Save → reopen with browser storage wiped → all notes, text and highlights return
  from the file, editable.
- Reopen → edit a note → add a highlight → save again: 3 margin notes + 2 highlights,
  every annotation tagged, none missing an appearance stream, page width unchanged at
  782pt (no double-widening, no stacked duplicates).
- Overwrite-in-place writes the bytes, re-keys autosave, and reloads the view from
  what it just wrote, with all notes intact.
- Margin baselines land on `ny × pageHeight` at `contentWidth + padding`; a rotated
  page puts upright text in the right column while its body text runs sideways.
- Rendered through mupdf, an independent PDF engine: yellow highlights over the right
  sentences, blue margin notes level with them.
- On-screen highlight ink measured against black text: 5.7:1 contrast at rest, 7.0:1
  when selected — both above the 4.5:1 readability threshold, so the words stay legible
  under the ink.
