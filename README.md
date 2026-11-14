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

Open `http://localhost:8000`. The collapsible sidebar works in Wix order:

- **Add Elements** chips: Text (heading, paragraph), Image, Button (incl. photo
  buttons), Strip (full-bleed band), Decorative (divider, quote, box), Gallery,
  Video (YouTube/Vimeo embed or link card), List (bullets/numbered), Anchor
  (in-page jump target, buttons can carry `anchor`), Embed Code (raw HTML/CSS),
  Social, Contact card.
- **Add Sections** presets: Welcome, About Me, Features, Pricing, Promo strip,
  Photo gallery, Contact — each inserts a ready-made block group.
- **Pages & Menu**: add/rename/re-key/reorder/delete pages, site menu + footer
  links, per-page header/footer overrides.
- **Site Design**: accent (swatches or hex), page/text colors, font, content
  width. **My Designs**: save any blocks as a named design in `model.designs`
  and re-add them to any page later.
- **Page Structure** cards (edit in place, reorder by drag, duplicate, delete)
  and **Export & Reset**.
- The preview iframe dominates the window; Desktop / Tablet / Phone buttons
  reflow the page at 768 px / 390 px without touching the model.

Paragraph text supports `**bold**`, `*italic*`, `[label](to:pagekey)` internal
and `[label](https://…)` external links. Changes autosave to `POST /api/project`.

## Export

Hit **Export site** (`POST /api/export`): writes `export/` — one HTML per page +
`style.css` + only the referenced assets (gallery assets included). Also
downloadable as a zip (`/api/export/zip`) and listable at `/export-view`.

## Hosting the export

The exported folder is self-contained with relative links — any static host works:

    python3 -m http.server 9000 -d export   # quick local serve

or GitHub Pages / Netlify / Cloudflare Pages / drag-and-drop into any web server.
Video embeds load their iframe from YouTube/Vimeo, so they need internet while
you view a page; everything else (pages, styles, images) works offline.

Out of scope, unlike Wix: its CMS apps — Blog, Store, Bookings, Events,
Restaurants, Community — need a dynamic service; this static-file builder only
renders pages and copies assets. External services are reached via buttons and
video embeds.

## Privacy

`site/` and `export/` are gitignored: your real pages and uploads stay on your
disk and are never pushed if you version-control this repo. Delete the seed demo
with "Reset to blank project" in the editor.

## Warning: custom HTML is raw

`custom_html` blocks are injected verbatim (no escaping) and the preview sandbox
grants scripts, so their `<script>` tags run **both** in the live preview and in
the exported files. Ordinary text everywhere else is escaped first. Use it
deliberately.
