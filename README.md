# Moving Head Batch Editor

A browser tool for xLights shows. It scans your rendered sequences and shows which ones drop the moving head beams below a tilt value you set. It can also add the fix in bulk: a whole-song **Additive DMX lift** on `MH Tilt` › Strand 1, the same thing you'd otherwise add by hand in every sequence.

**Open it:** https://g-hancox.github.io/Moving-Head-Batch-Editor-/ (use Chrome or Edge on your PC)

## How it works

1. **Pick your show folder** (`XLIGHTS\Show DIR`). The tool reads your layout (`xlights_rgbeffects.xml` and `xlights_networks.xml`) to find each moving head's tilt and dimmer channels.
2. **Set the limit.** This is the lowest tilt DMX value (0–255) the beams may reach. You can override it per head.
3. **Scan.** The tool reads every rendered `.fseq` and records each head's tilt, frame by frame, while its beam is on. A tilt of 0 means nothing is sequenced on that head at that moment, so it's skipped, and only real tilt commands are compared with the limit. In a sequence that already has the whole-song lift, "nothing sequenced" reads as the lift value, so that's skipped too. This is read-only. Big shows take 10–30 seconds per song.
4. **Fix.** For each sequence that dips too low, the tool works out the lift, which you can edit. Then you tick the sequences to change and confirm. It:
   - backs up each `.xsq` to `Show DIR\Tilt Lift Backups\<date time>\` first
   - adds one DMX effect across the whole song on `MH Tilt` › Strand 1, blended **Additive**, with DMX1–DMX8 set to each head's lift. If that lift already exists, its values are raised instead.
   - can switch the sequence's existing tilt DMX effects to **Additive** so they sum with the lift. This only changes effects that move the tilt channel, on the head models, groups containing heads, and `MH Tilt`'s own rows.
   - re-reads every saved file to check it.
5. **Batch render** in xLights (Tools → Batch Render). The show plays the `.fseq` files, so nothing changes on the lights until you re-render. Then scan again to confirm.

Your `.fseq` files are never written. Every edit can be undone from the page, or by copying the file back from the backup folder.

### What it won't touch

The tool skips these sequences and lists them for a hand fix:

- `MH Tilt` › Strand 1 already has its own tilt effects. A strand row can't hold two overlapping effects.
- The `.xsq` was saved after its last render. The scan numbers would be stale, and adding a lift twice would double it.
- A sequence was already edited in this session. Render it and rescan first.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/app.css`, `js/app.js` | The page |
| `js/fseq-scan.js`, `js/zstd.js`, `js/scan-worker.js` | Reads `.fseq` render files, including the Zstandard decompression they use |
| `js/layout.js` | Reads the xLights layout: heads, channels, `MH Tilt` strings, groups |
| `js/xsq-lift.js` | Reads and edits `.xsq` sequence files |
| `tests/` | `npm test` (Node 22+) |

## Running it locally

Run `npm run serve`, then open http://localhost:8000. The browser needs a real web address for folder access and background scanning, so opening `index.html` straight from disk won't work.
