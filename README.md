# Website Builder

A local, stdlib-only website builder. One Python file (`builder.py`) serves an
editor UI and renders the site from a single JSON model (`site/project.json`).
Preview and export share one renderer, so what you see is byte-for-byte what
gets written.

## Run it

    python3 builder.py              # opens http://localhost:8000 in your browser
    python3 builder.py --no-browser # just serve; open localhost:8000 yourself

First run seeds a two-page demo project. Everything (model, uploads, export)
lives in folders next to `builder.py`.

## Editing

Open `http://localhost:8000`. The toolbar appends blocks (heading, paragraph,
image, button, image button, divider, quote, contact card, social links,
custom HTML). The page rail adds/renames/deletes pages, edits header/footer
panels and theme (accent swatches, font, content width). Paragraph text supports
`**bold**`, `*italic*`, `[label](to:pagekey)` internal and `[label](https://…)`
external links. Changes autosave back into the model; the iframe preview refreshes.

## Export

Hit the **Export site** button (POST /api/export): writes `export/` (one HTML per
page + `style.css` + only the assets actually referenced). Also downloadable as a
zip (`/api/export/zip`) and listable at `/export-view`.

## Hosting the export

The exported folder is self-contained with relative links — any static host works:

    python3 -m http.server 9000 -d export   # quick local serve

or GitHub Pages / Netlify / Cloudflare Pages / drag-and-drop into any web server.

## Privacy

`site/` and `export/` are gitignored: your real pages and uploads stay on your
disk and are never pushed if you version-control this repo. Delete the seed demo
with "Reset to blank project" in the editor.

## Warning: custom HTML is raw

`custom_html` blocks are injected verbatim (no escaping), and their `<script>`
tags are blocked in preview by the server's CSP sandbox but **will run** when
you open the exported files. Only use it deliberately.
