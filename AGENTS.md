# Instructions for AI coding assistants

Read [README.md](./README.md) first (architecture, data model, how-to recipes).

## Rules
- No build step. Edit `index.html`, `app.js`, `style.css` directly; libraries load from CDNs.
- Validate with `node --check app.js` and `git diff --check`. Then test in a browser at a phone size (440x956) and a desktop size.
- Primary device: iPhone 16 Pro Max. Tap targets >= 44px, respect `env(safe-area-inset-*)`, avoid horizontal scroll.
- Never decide selection from marker styling. Use `isStopSelected()`; after changes call `updateSelectionCount()` and `updateUndoButtonState()`.
- Layout is phone at `window.innerWidth <= 900`. Shared buttons are moved by `placeDeliveryControls()`; update both branches.
- `style.css` has many later "override" blocks. Search every occurrence of a selector before editing; the last one wins.
- Delivery saves overwrite the whole workbook in Supabase. Update in-memory rows only after the upload succeeds.
- When you change `app.js` or `style.css`, bump the `?v=` cache-buster in `index.html`.
- Never commit secrets. The Supabase key in `app.js` is a publishable (public) key by design; do not add service keys.
- Test with sample data and fake saves; do not upload to or delete from the real storage bucket.
- Keep comments short and only where behavior is non-obvious. Update README.md when architecture changes.
