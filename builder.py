#!/usr/bin/env python3
# builder.py -- the single core file of the local website-builder app.
#
#   python3 builder.py [--no-browser]
#
# Starts a ThreadingHTTPServer on 127.0.0.1:8000. Run it from anywhere: every
# path (site/, ui/, export/) is resolved relative to this file's own directory.
# Stdlib only; portable to Python 3.9+.
#
# The selling point of the tool: render_page(data, key, base) is ONE code path.
# The live preview endpoints and the on-disk export both call it; only `base`
# differs ("" for export, "/preview/" for preview). curl
#   /preview/<key>.html?base=export
# therefore yields BYTES IDENTICAL to export/<key>.html, so preview-vs-file can
# be diffed with `diff`.
#
# ENDPOINTS (same origin as the server):
#   GET  /                       ui/index.html from disk (placeholder if missing)
#   GET  /ui/app.css /ui/app.js  exact two-file whitelist (never generic files)
#   GET  /api/project            project.json bytes
#   POST /api/project            full model JSON -> validated + atomic save
#   GET  /preview/<key>.html     rendered page (CSP: sandbox allow-forms allow-popups
#                                allow-scripts allow-same-origin -- the same grants the
#                                editor iframe asks for, so the intersection keeps
#                                video embeds and custom_html scripts alive). Extra
#                                query params (?v=N) ignored. ?base=export switches the
#                                EXPORT base for byte-diffing. /preview/index.html is
#                                aliased to the "home" page (export names it index.html).
#   GET  /preview/style.css      generated theme CSS, byte-identical to export
#   GET  /preview/assets/<name>  asset bytes ONLY if name is in model["assets"]
#                                (that dict-membership check is the traversal guard)
#   POST /api/upload?name=fn     raw bytes body (no multipart); regex+ext+size+magic
#   POST /api/export             render all pages, write style.css, copy used assets
#   GET  /api/export/zip         same rendered set as a zip (stdlib zipfile)
#   GET  /export-view            minimal HTML page linking every export/ file
#   GET  /export/<relpath>       ADDED ROUTE: serves exactly one of the files
#                                named by the last /export-view listing, so the
#                                links on that page download/open via the server.
#
# Note on custom_html: html is injected verbatim and its css is collected into the
# page <style>. The preview sandbox grants scripts + same-origin (matching the
# editor iframe), so custom script tags run BOTH in the live preview and once the
# exported files are opened. Ordinary text everywhere else is html.escape'd first.

import json
import os
import re
import shutil
import struct
import sys
import zlib
import io
import zipfile
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler
import socketserver
from html import escape as html_escape

# ---------------------------------------------------------------- paths

HERE = Path(__file__).resolve().parent
SITE = HERE / "site"
ASSETS_DIR = SITE / "assets"
PROJECT_PATH = SITE / "project.json"
UI_DIR = HERE / "ui"
EXPORT_DIR = HERE / "export"
UI_WHITELIST = {"/ui/app.css": "text/css; charset=utf-8",
                "/ui/app.js": "text/javascript; charset=utf-8"}

HOST, PORT = "127.0.0.1", 8000

# ---------------------------------------------------------------- regexes / constants

PAGE_KEY_RE = re.compile(r"\A[a-z][a-z0-9-]{0,31}\Z")
ASSET_NAME_RE = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")   # upload endpoint
ASSET_KEY_RE = re.compile(r"\A[A-Za-z0-9._-]+\Z")         # project.json assets keys
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]*)\)")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
EM_RE = re.compile(r"\*([^*]+?)\*")
SCHEME_RE = re.compile(r"\A([A-Za-z][A-Za-z0-9+.-]*):")
HEXCOLOR_RE = re.compile(r"\A#[0-9a-fA-F]{6}\Z")
HEXCOLOR3_RE = re.compile(r"\A#([0-9a-fA-F]{3})\Z")
EXPORT_REL_RE = re.compile(r"\A(?:[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+\Z")
IMG_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")
YT_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{11}\Z")
YT_PATH_RE = re.compile(r"\A/(?:embed|shorts|v|live)/([A-Za-z0-9_-]{11})\Z")
VIMEO_PATH_RE = re.compile(r"\A/video/(\d{2,20})\Z")
MAX_UPLOAD = 25 * 1024 * 1024

FONTS = {
    "sans": 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    "serif": 'Georgia, Cambria, "Times New Roman", Times, serif',
    "mono": 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
}
FONT_DEFAULT = "sans"
WIDTH_PCT = {"small": "33%", "medium": "60%", "wide": "85%", "full": "100%"}
COLOR_FALLBACK = {"accent": "#2b59c6", "background": "#f7f6f3", "text": "#1d2430"}

# ---------------------------------------------------------------- text safety

def esc(value):
    """html.escape FIRST; every user string passes through here before substitution."""
    return html_escape(str(value), quote=True)


def chip(text):
    """Visible placeholder: missing asset, dead internal link, unknown block."""
    return '<span class="chip">[%s]</span>' % html_escape(str(text), quote=True)


def safe_url(url):
    """Allow http/https/mailto; reject javascript:/data:/file: and everything
    else (unsafe -> caller renders the label as plain text, no link)."""
    u = str(url or "").strip()
    if not u:
        return None
    m = SCHEME_RE.match(u)
    if m and m.group(1).lower() in ("http", "https", "mailto"):
        return u
    return None


def page_href(key, base):
    """Internal link target. base "" (export): home page lands on index.html.
    base "/preview/" (preview): every key keeps its own <key>.html URL."""
    if base == "" and key == "home":
        return "index.html"
    return base + key + ".html"


def cache_stamp():
    """Version token for preview-mode anchor URLs: changes whenever project.json
    is rewritten. Only ever interpolated when base is the PREVIEW base, so the
    exported bytes (base "") never contain it and stay byte-diffable."""
    try:
        return int(PROJECT_PATH.stat().st_mtime)
    except OSError:
        return 1


def anchored_href(key, base, anchor):
    """Internal href + optional "#anchor". Export: "about.html#pricing".
    Preview: "/preview/about.html?v=N#pricing" -- cache-bust BEFORE the hash so
    the browser refetches instead of jumping inside a possibly stale page."""
    href = page_href(key, base)
    if not anchor:
        return href
    if base == "":
        return href + "#" + anchor
    return href + "?v=%d#%s" % (cache_stamp(), anchor)


def page_keys(model):
    return {p.get("key") for p in model.get("pages", []) if isinstance(p, dict)}


def asset_on_disk(name):
    return bool(name) and bool(ASSET_NAME_RE.match(name)) and (ASSETS_DIR / name).is_file()


def asset_href(name, base):
    return base + "assets/" + name


def _md(escaped, model, base):
    """Mini-markdown AFTER escaping: **b** <strong>, *i* <em>,
    [label](to:key) internal, [label](url) external. Emits only fixed
    attribute-free tags; every href goes through safe_url/page_href."""
    known = page_keys(model)

    def repl(m):
        label, target = m.group(1), m.group(2)
        if target.startswith("to:"):
            k = target[3:]
            if k not in known:
                return chip("Broken link: %s" % k)
            return '<a href="%s">%s</a>' % (html_escape(page_href(k, base), quote=True), label)
        u = safe_url(target)
        if u is None:
            return label
        return '<a href="%s">%s</a>' % (html_escape(u, quote=True), label)

    s = BOLD_RE.sub(r"<strong>\1</strong>", escaped)
    s = EM_RE.sub(r"<em>\1</em>", s)
    return MD_LINK_RE.sub(repl, s)


# ---------------------------------------------------------------- block renderers

def r_heading(b, model, base):
    level = b.get("level", 2)
    if level not in (1, 2, 3):
        level = 2
    return "<h%d>%s</h%d>" % (level, _md(esc(b.get("text", "")), model, base), level)


def r_paragraph(b, model, base):
    return "<p>%s</p>" % _md(esc(b.get("text", "")), model, base)


def anchor_ok(value):
    """Optional "anchor" on a button: a page-key-shaped slug, else ignored."""
    return isinstance(value, str) and bool(PAGE_KEY_RE.match(value))


def button_html(b, model, base):
    label = _md(esc(b.get("label", "")), model, base)
    style = b.get("style", "pill")
    if style not in ("pill", "box"):
        style = "pill"
    extra = ' target="_blank" rel="noopener noreferrer"' if b.get("newtab") else ""
    if b.get("to") is not None:
        key = str(b.get("to"))
        if key not in page_keys(model):
            return chip("Broken link: %s" % key)
        anchor = b.get("anchor") if anchor_ok(b.get("anchor")) else None
        href = anchored_href(key, base, anchor)
    elif b.get("url") is not None:
        href = safe_url(b.get("url"))
        if href is None:
            return label  # unsafe URL: label as plain text, no link
    else:
        return chip("Broken link: (no target)")
    return '<a class="btn %s" href="%s"%s>%s</a>' % (style, html_escape(href, quote=True), extra, label)


def r_button_block(b, model, base):
    return button_html(b, model, base)


def r_image(b, model, base):
    name = b.get("asset") or ""
    if not asset_on_disk(name):
        return chip("missing image: %s" % (name or "?"))
    width = b.get("width") or "medium"
    if width not in WIDTH_PCT:
        width = "medium"
    align = b.get("align") or "center"
    if align not in ("left", "center", "right"):
        align = "center"
    out = ['<figure class="img-align-%s">' % align]
    out.append('<img class="img-%s" src="%s" alt="%s">' % (width, html_escape(asset_href(name, base), quote=True), esc(b.get("alt", ""))))
    cap = b.get("caption")
    if cap:
        out.append('<figcaption class="img-caption">%s</figcaption>' % _md(esc(cap), model, base))
    out.append("</figure>")
    return "".join(out)


def r_image_button(b, model, base):
    name = b.get("asset") or ""
    if not asset_on_disk(name):
        return chip("missing image: %s" % (name or "?"))
    width = b.get("width") or "medium"
    if width not in ("small", "medium", "wide"):
        width = "medium"
    shape = b.get("shape") or "square"
    if shape not in ("square", "rounded"):
        shape = "square"
    label = b.get("label") or b.get("alt") or ""
    if b.get("to") is not None:
        key = str(b.get("to"))
        if key not in page_keys(model):
            return chip("Broken link: %s" % key)
        anchor = b.get("anchor") if anchor_ok(b.get("anchor")) else None
        href = anchored_href(key, base, anchor)
    elif b.get("url") is not None:
        href = safe_url(b.get("url"))
        if href is None:
            return chip("unsafe link: %s" % label)
    else:
        return chip("Broken link: (no target)")
    classes = "img-button img-%s shape-%s" % (width, shape)
    # <a> directly wraps <img>: the exported grep for '<a' finds it here.
    return ('<a class="%s" href="%s"><img class="img-%s" src="%s" alt="%s">'
            '<span class="sr-only">%s</span></a>'
            % (classes, html_escape(href, quote=True), width,
               html_escape(asset_href(name, base), quote=True), esc(b.get("alt", "")), esc(label)))


def r_divider(b, model, base):
    return "<hr>"


def r_quote(b, model, base):
    out = ["<blockquote>", "<p>%s</p>" % _md(esc(b.get("text", "")), model, base)]
    attr = b.get("attribution")
    if attr:
        out.append('<footer class="attribution">%s</footer>' % _md(esc(attr), model, base))
    out.append("</blockquote>")
    return "".join(out)


def r_contact_card(b, model, base):
    lines = b.get("lines")
    if not isinstance(lines, list):
        return chip("bad contact card")
    out = ['<div class="contact-card">']
    for ln in lines:
        if not isinstance(ln, dict):
            continue
        label = '<span class="contact-label">%s</span>' % _md(esc(ln.get("label", "")), model, base)
        url = ln.get("url")
        if url is not None:
            href = safe_url(url)
            if href is None:
                value = "<span>%s</span>" % _md(esc(ln.get("value", "")), model, base)
            else:
                value = '<a href="%s">%s</a>' % (html_escape(href, quote=True), _md(esc(ln.get("value", "")), model, base))
        else:
            value = "<span>%s</span>" % _md(esc(ln.get("value", "")), model, base)
        out.append('<div class="contact-line">%s%s</div>' % (label, value))
    out.append("</div>")
    return "".join(out)


def r_social_links(b, model, base):
    items = b.get("items")
    if not isinstance(items, list):
        return chip("bad social list")
    out = ['<div class="social-links">']
    for it in items:
        if not isinstance(it, dict):
            continue
        text = it.get("label") or it.get("network") or ""
        href = safe_url(it.get("url"))
        if href is None:
            out.append('<span class="social-link">%s</span>' % _md(esc(text), model, base))
        else:
            out.append('<a class="social-link" href="%s">%s</a>' % (html_escape(href, quote=True), _md(esc(text), model, base)))
    out.append("</div>")
    return "".join(out)


def r_custom_html(b, model, base):
    """RAW by design: html is injected verbatim, css is collected into the page <style>."""
    return str(b.get("html") or "")


def r_strip(b, model, base):
    """Full-bleed band. The escape past the content column is pure CSS
    (.strip{width:100vw;margin-left:calc(50% - 50vw)}). bg: hex via css_color;
    missing/invalid -> a light tint of the theme accent (mixed with the page bg)."""
    color = css_color(b.get("bg"), "accent") if hex_ok(b.get("bg")) else strip_tint(model)
    height = b.get("height") or "medium"
    if height not in ("low", "medium", "tall"):
        height = "medium"
    align = b.get("align") or "center"
    if align not in ("left", "center", "right"):
        align = "center"
    return ('<div class="strip strip-%s align-%s" style="background:%s">%s</div>'
            % (height, align, html_escape(color, quote=True), _md(esc(b.get("text", "")), model, base)))


def r_gallery(b, model, base):
    """CSS grid of assets. Each name must be in model["assets"] AND on disk;
    otherwise an inline chip stands in for the cell. 12-asset cap, 2-4 columns."""
    known = model.get("assets") if isinstance(model.get("assets"), dict) else {}
    names = b.get("assets")
    if not isinstance(names, list):
        return chip("bad gallery: assets must be a list")
    names = names[:12]
    cols = b.get("columns", 3)
    try:
        cols = int(cols)
    except (TypeError, ValueError):
        cols = 3
    cols = max(2, min(4, cols))
    cols = min(cols, max(2, len(names)))  # never more columns than cells
    cells = []
    for name in names:
        name = str(name or "")
        if name in known and asset_on_disk(name):
            cells.append('<img class="gallery-cell" src="%s" alt="%s">'
                         % (html_escape(asset_href(name, base), quote=True), esc(name)))
        else:
            cells.append(chip("missing asset: %s" % (name or "?")))
    out = ['<figure class="gallery-fig">', '<div class="gallery gallery-%d">%s</div>' % (cols, "".join(cells))]
    cap = b.get("caption")
    if cap:
        out.append('<figcaption class="gallery-caption">%s</figcaption>' % _md(esc(cap), model, base))
    out.append("</figure>")
    return "".join(out)


def r_box(b, model, base):
    """Padded rounded panel. outline: 1.5px accent border, transparent bg;
    filled: accent bg + theme text color; soft: accent at ~12% opacity (inline
    rgba so it tracks whatever accent the theme carries)."""
    variant = b.get("variant") or "outline"
    if variant not in ("outline", "filled", "soft"):
        variant = "outline"
    style = ""
    if variant == "soft":
        accent, _page_bg = theme_colors(model)
        style = ' style="background:%s"' % html_escape(rgba_of(accent, 0.12), quote=True)
    out = ['<div class="box-panel box-%s"%s>' % (variant, style)]
    title = b.get("title")
    if title:
        out.append('<div class="box-title">%s</div>' % _md(esc(title), model, base))
    lines = b.get("lines")
    if isinstance(lines, list):
        for ln in lines:
            out.append('<p class="box-line">%s</p>' % _md(esc(ln), model, base))
    out.append("</div>")
    return "".join(out)


def r_list(b, model, base):
    items = b.get("items")
    if not isinstance(items, list):
        return chip("bad list: items must be a list")
    ordered = b.get("ordered") is True
    tag = "ol" if ordered else "ul"
    cls = "list-ordered" if ordered else "list-plain"
    return '<%s class="%s">%s</%s>' % (tag, cls,
                                       "".join("<li>%s</li>" % _md(esc(i), model, base) for i in items), tag)


def video_embed_src(url):
    """Cookie-light embed URL for YouTube watch/shorts/embed/v/live/youtu.be and
    player.vimeo.com/video links; None otherwise. The id is regex-anchored before
    interpolation, so nothing from an arbitrary URL reaches the iframe src."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return None
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path or ""
    if host == "youtu.be":
        vid = path.lstrip("/")
        if YT_ID_RE.match(vid):
            return "https://www.youtube-nocookie.com/embed/" + vid
    elif host in ("youtube.com", "m.youtube.com"):
        if path.startswith("/watch"):
            vid = (urllib.parse.parse_qs(parsed.query).get("v") or [""])[0]
            if YT_ID_RE.match(vid):
                return "https://www.youtube-nocookie.com/embed/" + vid
        else:
            m = YT_PATH_RE.match(path)
            if m:
                return "https://www.youtube-nocookie.com/embed/" + m.group(1)
    elif host == "player.vimeo.com":
        m = VIMEO_PATH_RE.match(path)
        if m:
            return "https://player.vimeo.com/video/" + m.group(1)
    return None


def r_video(b, model, base):
    """Embeddable links -> lazy 16:9 iframe (NEVER a <script>; the iframe is an
    external document). Anything else -> styled a11y-named link card."""
    raw = b.get("url")
    href = safe_url(raw)
    if href is None:
        return chip("bad video link: %s" % (raw or "?"))
    title = str(b.get("title") or "").strip()
    embed = video_embed_src(href)
    if embed:
        return ('<div class="video-frame"><iframe class="video-iframe" loading="lazy" '
                'src="%s" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" '
                'allowfullscreen title="%s"></iframe></div>'
                % (html_escape(embed, quote=True), esc(title or "Video")))
    return ('<a class="video-card" href="%s" target="_blank" rel="noopener">%s</a>'
            % (html_escape(href, quote=True), esc(title or href)))


def r_anchor(b, model, base):
    """Invisible in-page marker; name must be a page-key-shaped slug."""
    name = b.get("name")
    if not isinstance(name, str) or not PAGE_KEY_RE.match(name):
        return chip("bad anchor: %r" % name)
    return '<a id="%s"></a>' % html_escape(name, quote=True)


def render_block(b, model, base):
    if not isinstance(b, dict):
        return chip("unknown block")
    t = b.get("type")
    fn = {"heading": r_heading, "paragraph": r_paragraph, "image": r_image,
          "button": r_button_block, "image_button": r_image_button, "divider": r_divider,
          "quote": r_quote, "contact_card": r_contact_card, "social_links": r_social_links,
          "custom_html": r_custom_html, "strip": r_strip, "gallery": r_gallery,
          "box": r_box, "list": r_list, "video": r_video, "anchor": r_anchor}.get(t)
    if fn is None:
        return chip("unknown block: %s" % t)
    try:
        return fn(b, model, base)
    except Exception:  # renderer invariant: visible placeholder, never a crash
        return chip("block failed: %s" % t)


def header_html(header, model, base):
    out = ['<header class="site-header">']
    title = header.get("title")
    if title:
        out.append('<div class="site-title">%s</div>' % esc(title))
    sub = header.get("subtitle")
    if sub:
        out.append('<div class="site-subtitle">%s</div>' % esc(sub))
    logo = header.get("logo_asset")
    if logo and asset_on_disk(str(logo)):
        out.append('<img class="logo" src="%s" alt="">' % html_escape(asset_href(str(logo), base), quote=True))
    btns = header.get("buttons")
    if isinstance(btns, list) and btns:
        out.append('<nav class="header-buttons">%s</nav>' % "".join(button_html(x, model, base) for x in btns))
    out.append("</header>")
    return "".join(out)


def footer_html(footer, model, base):
    out = ['<footer class="site-footer">']
    text = footer.get("text")
    if text:
        out.append('<div class="footer-text">%s</div>' % _md(esc(text), model, base))
    btns = footer.get("buttons")
    if isinstance(btns, list) and btns:
        out.append('<nav class="footer-buttons">%s</nav>' % "".join(button_html(x, model, base) for x in btns))
    out.append("</footer>")
    return "".join(out)


# ---------------------------------------------------------------- the one renderer

def render_page(model, key, base):
    """Render page `key` as a full HTML document. base "" -> EXPORT-relative URLs;
    base "/preview/" -> preview URLs. Deterministic: preview?base=export and the
    exported file are byte-for-byte identical."""
    pages = [p for p in model.get("pages", []) if isinstance(p, dict)]
    page = next((p for p in pages if p.get("key") == key), None)
    if page is None:
        return None
    meta = model.get("meta") if isinstance(model.get("meta"), dict) else {}
    name = str(meta.get("name") or "Site")
    lang = str(meta.get("language") or "en")

    header = page.get("header_override")
    if not isinstance(header, dict):
        header = model.get("header") if isinstance(model.get("header"), dict) else {}
    footer = page.get("footer_override")
    if not isinstance(footer, dict):
        footer = model.get("footer") if isinstance(model.get("footer"), dict) else {}

    blocks_out, css_out = [], []
    blocks = page.get("blocks")
    if not isinstance(blocks, list):
        blocks = []
    for b in blocks:
        blocks_out.append(render_block(b, model, base))
        if isinstance(b, dict) and b.get("type") == "custom_html" and b.get("css"):
            css_out.append(str(b["css"]))

    head = ['<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            "<title>%s</title>" % esc("%s — %s" % (str(page.get("title") or ""), name)),
            '<link rel="stylesheet" href="%s">' % html_escape(base + "style.css", quote=True)]
    custom_css = "\n".join(css_out)
    if custom_css:
        head.append("<style>%s</style>" % custom_css)
    head.append("<!-- custom_html injects markup verbatim; with scripts allowed by the "
                "preview sandbox, its script tags run both live and in exported files. -->")

    parts = ["<!DOCTYPE html>", '<html lang="%s">' % html_escape(lang, quote=True), "<head>"] + head + \
            ["</head>", "<body>", header_html(header, model, base),
             '<main class="content">'] + blocks_out + ["</main>", footer_html(footer, model, base),
             "</body>", "</html>"]
    return "\n".join(parts)


# ---------------------------------------------------------------- theme CSS (generated)

def css_color(value, kind):
    v = str(value or "")
    if HEXCOLOR_RE.match(v):
        return v
    m3 = HEXCOLOR3_RE.match(v)
    if m3:  # the UI accepts #abc shorthand; expand to #aabbcc
        return "#" + "".join(c * 2 for c in m3.group(1))
    return COLOR_FALLBACK[kind]


def hex_ok(value):
    """True only for real #rgb / #rrggbb hexes (css_color's fallback is for
    rendering; validation and callers need to know whether the value was valid)."""
    v = str(value or "")
    return bool(HEXCOLOR_RE.match(v) or HEXCOLOR3_RE.match(v))


def rgba_of(hex_value, alpha):
    """#rrggbb -> rgba(r,g,b,alpha). Only ever called on css_color() output."""
    return "rgba(%d,%d,%d,%g)" % (int(hex_value[1:3], 16), int(hex_value[3:5], 16),
                                  int(hex_value[5:7], 16), alpha)


def mix_hex(first, second, weight):
    """Blend two #rrggbb hexes; weight = fraction of `first` (clamped 0..1)."""
    w = max(0.0, min(1.0, float(weight)))

    def chan(i, j):
        return int(round(i * w + j * (1.0 - w)))

    return "#%02x%02x%02x" % (chan(int(first[1:3], 16), int(second[1:3], 16)),
                              chan(int(first[3:5], 16), int(second[3:5], 16)),
                              chan(int(first[5:7], 16), int(second[5:7], 16)))


def theme_colors(model):
    th = model.get("theme") if isinstance(model.get("theme"), dict) else {}
    return css_color(th.get("accent"), "accent"), css_color(th.get("background"), "background")


def strip_tint(model):
    """Fallback strip bg: a light tint of the theme accent over the page bg."""
    accent, page_bg = theme_colors(model)
    return mix_hex(accent, page_bg, 0.18)


def css_content_width(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = 720
    return max(480, min(1100, n))


def css_font(value):
    return FONTS.get(str(value or ""), FONTS[FONT_DEFAULT])


def gen_css(model):
    """Generated theme CSS. Byte-identical for /preview/style.css and export/style.css."""
    th = model.get("theme") if isinstance(model.get("theme"), dict) else {}
    accent = css_color(th.get("accent"), "accent")
    bg = css_color(th.get("background"), "background")
    text = css_color(th.get("text"), "text")
    cw = css_content_width(th.get("content_width"))
    stack = css_font(th.get("font"))
    parts = [
        ":root{--accent:%s;--bg:%s;--text:%s;--content:%dpx;--stack:%s}" % (accent, bg, text, cw, stack),
        "*{box-sizing:border-box}",
        "body{margin:0;background:var(--bg);color:var(--text);font-family:var(--stack);font-size:17px;line-height:1.6}",
        ".site-header{max-width:var(--content);margin:0 auto;padding:26px 20px 18px;text-align:center}",
        ".site-title{font-size:27px;font-weight:700;line-height:1.25}",
        ".site-subtitle{font-size:16px;opacity:.75}",
        ".logo{display:block;margin:0 auto;max-width:180px}",
        ".header-buttons{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:12px}",
        ".footer-buttons{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:10px}",
        ".site-footer{max-width:var(--content);margin:0 auto;padding:18px 20px 24px;text-align:center}",
        ".footer-text{font-size:.9em;opacity:.85}",
        ".btn{display:inline-block;padding:9px 18px;font-weight:600;text-decoration:none;text-transform:none}",
        ".pill{border-radius:999px;background:var(--accent);color:%s}" % "#ffffff",
        ".box{border-radius:3px;background:var(--accent);color:#ffffff}",
        ".btn:hover{filter:brightness(1.12)}",
        ".content{max-width:var(--content);margin:0 auto;padding:34px 22px 46px}",
        "h1{font-size:1.9em;margin:.2em 0 .4em}h2{font-size:1.45em;margin:.3em 0 .4em}h3{font-size:1.15em;margin:.4em 0 .3em}",
        "p{margin:0 0 1em}main p{margin:.2em 0 1em}",
        "figure{margin:1em 0}",
        "img{max-width:100%;height:auto}",
        ".img-small{width:%s}.img-medium{width:%s}.img-wide{width:%s}.img-full{width:100%%}" % (WIDTH_PCT["small"], WIDTH_PCT["medium"], WIDTH_PCT["wide"], ),
        ".img-align-left img{margin:0 auto 0 0}.img-align-center img{margin:0 auto}.img-align-right img{margin:0 0 0 auto}",
        ".img-caption{font-size:.85em;opacity:.8}",
        ".img-button{display:block}.img-button img{display:inline-block;vertical-align:top}.shape-square{border-radius:0}.shape-rounded{border-radius:14px}",
        "hr{border:none;border-top:1px solid var(--accent);margin:1.6em 0}",
        "blockquote{margin:1em 0;padding:.4em 0 .4em 1em;border-left:3px solid var(--accent)}",
        ".attribution{font-size:.9em;opacity:.85}",
        ".contact-card{border:1px solid var(--accent);padding:14px 18px;margin:1em 0}",
        ".contact-line{margin:.2em 0}.contact-label{font-weight:600}",
        ".social-links{display:flex;flex-wrap:wrap;gap:14px;margin:1em 0}.social-link{text-decoration:none}",
        ".chip{font-family:%s;border:1px dashed %s;background:#fff3cd;color:#713d0d;padding:2px 6px}" % (FONTS["mono"], "#b4482c"),
        ".sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(1px 1px 1px 1px);clip-path:rect(0px 0px 0px 0px)}",
        ".strip{width:100vw;margin:1.4em 0;margin-left:calc(50% - 50vw);padding:18px 26px;text-align:center}",
        ".strip-low{padding:10px 26px}.strip-medium{padding:24px 26px}.strip-tall{padding:48px 26px}",
        ".align-left{text-align:left}.align-center{text-align:center}.align-right{text-align:right}",
        ".gallery-fig{margin:1em 0}.gallery{display:grid;gap:10px;margin:0}"
        ".gallery-2{grid-template-columns:repeat(2,1fr)}.gallery-3{grid-template-columns:repeat(3,1fr)}"
        ".gallery-4{grid-template-columns:repeat(4,1fr)}",
        ".gallery img{width:100%;aspect-ratio:3/2;object-fit:cover}"
        ".gallery-fig .gallery-caption{font-size:.85em;opacity:.8;margin-top:8px}",
        ".box-panel{border-radius:12px;padding:16px 18px;margin:1em 0}"
        ".box-outline{border:1.5px solid var(--accent)}.box-filled{background:var(--accent);color:var(--text)}",
        ".box-title{font-weight:700;margin:.15em 0 .5em}.box-line{margin:.2em 0 .7em}",
        ".list-plain{margin:.2em 0 1em;padding:0 0 0 1.4em}.list-ordered{margin:.2em 0 1em;padding:0 0 0 1.6em}"
        ".list-plain li,.list-ordered li{margin:.15em 0}",
        ".video-frame{position:relative;padding-top:56.25%;margin:1.2em 0}"
        ".video-iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}",
        ".video-card{display:block;border:1.5px solid var(--accent);border-radius:10px;padding:14px 18px;margin:1em 0;text-decoration:none}"
        ".video-card:hover{filter:brightness(1.12)}",
        "@media (max-width:640px){.content{padding:22px 14px 34px}.site-header{padding:18px 12px 12px}"
        ".header-buttons{flex-direction:column;align-items:center;gap:6px}.footer-buttons{flex-direction:column;align-items:center;gap:6px}"
        ".gallery{grid-template-columns:1fr}.strip-low{padding:9px 16px}.strip-medium{padding:16px 16px}"
        ".strip-tall{padding:28px 16px}.box-panel{padding:13px 14px}.video-card{padding:11px 14px}.video-frame{margin:0.8em 0}}",
    ]
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------- export

def build_export_map(model):
    """[(relative name, bytes)] -- THE RENDERED SET. One renderer for both
    destinations: POST /api/export writes exactly these, GET /api/export/zip zips
    exactly these."""
    out = []
    for p in model.get("pages", []):
        if not isinstance(p, dict):
            continue
        key = str(p.get("key") or "")
        if not PAGE_KEY_RE.match(key):
            continue
        fname = "index.html" if key == "home" else key + ".html"
        out.append((fname, render_page(model, key, "").encode("utf-8")))
    out.append(("style.css", gen_css(model).encode("utf-8")))
    for name in sorted(referenced_assets(model)):
        if asset_on_disk(name):
            out.append(("assets/" + name, (ASSETS_DIR / name).read_bytes()))
    return out


def referenced_assets(model):
    """Asset names referenced by some block (plus header logo -- stated deviation)."""
    names = set()
    for p in model.get("pages", []):
        if not isinstance(p, dict):
            continue
        bl = p.get("blocks")
        for b in (bl if isinstance(bl, list) else []):
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t in ("image", "image_button") and b.get("asset"):
                names.add(str(b["asset"]))
            elif t == "gallery":
                gnames = b.get("assets")
                if isinstance(gnames, list):
                    for n in gnames:
                        if isinstance(n, str):
                            names.add(n)
        for ov in (p.get("header_override"),):
            if isinstance(ov, dict) and ov.get("logo_asset"):
                names.add(str(ov["logo_asset"]))
    for top in (model.get("header"), model.get("footer")):
        if isinstance(top, dict) and top.get("logo_asset"):
            names.add(str(top["logo_asset"]))
    return names


def do_export(model):
    """Write the rendered set to disk. Returns dict for the HTTP response."""
    if EXPORT_DIR.is_dir():  # drop stale files from a previous export
        shutil.rmtree(str(EXPORT_DIR))
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for name, data in build_export_map(model):
        dest = EXPORT_DIR / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if name.startswith("assets/"):
            src = ASSETS_DIR / name[len("assets/"):]
            shutil.copy2(str(src), str(dest))
        else:
            dest.write_bytes(data)
        files.append(name)
    return {"ok": True, "files": files, "path": str(EXPORT_DIR)}


def make_zip(model):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in build_export_map(model):
            zf.writestr(name, data)
    return buf.getvalue()


# ---------------------------------------------------------------- project.json (load/save)

def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_model():
    if not PROJECT_PATH.is_file():
        return None
    try:
        with PROJECT_PATH.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def save_model(model):
    """Atomic save: tmp file in the SAME dir + os.replace."""
    SITE.mkdir(parents=True, exist_ok=True)
    tmp = SITE / ("project.json.%d.tmp" % os.getpid())
    tmp.write_text(json.dumps(model, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(str(tmp), str(PROJECT_PATH))


def validate_button(b, where, errors):
    """Every button (blocks + header/footer/override rows) needs a label and a
    target. A dead "to" key is NOT an error here -- it renders as a visible
    broken-link chip, like dead [x](to:key) links."""
    if not isinstance(b, dict):
        errors.append("%s must be an object" % where)
        return
    label = b.get("label")
    if not isinstance(label, str) or label.strip() == "":
        errors.append("%s needs a label (the text shown on the button)" % where)
    to, url = b.get("to"), b.get("url")
    has_to = isinstance(to, str) and to.strip() != ""
    has_url = isinstance(url, str) and url.strip() != ""
    if not has_to and not has_url:
        errors.append('%s needs a link target: give it "to" (a page key) or "url" (a web link)' % where)
    anchor = b.get("anchor")
    if anchor is not None and has_to and (not isinstance(anchor, str) or not PAGE_KEY_RE.match(anchor)):
        errors.append('%s anchor must match ^[a-z][a-z0-9-]{0,31}$ (got: %r)' % (where, anchor))


def validate_block(b, where, asset_names, errors):
    """Per-block validation shared by page blocks and design blocks. Strict
    where the schema pins a value (a bad value is rejected at POST time);
    lenient elsewhere because the renderers chip/clamp anyway -- hand-edited
    project.json must still never crash."""
    if not isinstance(b, dict):
        errors.append("%s must be an object" % where)
        return
    t = b.get("type")
    if t in ("button", "image_button"):
        validate_button(b, where, errors)
    elif t == "strip":
        bg = b.get("bg")
        if bg is not None and not hex_ok(bg):
            errors.append('%s.bg must be #rgb or #rrggbb (got: %r)' % (where, bg))
        for field, allowed in (("height", ("low", "medium", "tall")), ("align", ("left", "center", "right"))):
            if field in b and b[field] is not None and b[field] not in allowed:
                errors.append("%s.%s must be %s (got: %r)" % (where, field, "|".join(allowed), b[field]))
        if b.get("text") is not None and not isinstance(b["text"], str):
            errors.append("%s.text must be a string" % where)
    elif t == "gallery":
        names = b.get("assets")
        if not isinstance(names, list):
            errors.append("%s.assets must be a list of asset names" % where)
        else:
            for n in names:
                if not isinstance(n, str) or n not in asset_names:
                    errors.append('gallery %s references an asset not in model.assets: %r' % (where, n))
        cols = b.get("columns", 3)
        if cols not in (2, 3, 4):
            errors.append("%s.columns must be 2, 3 or 4 (got: %r)" % (where, cols))
        if b.get("caption") is not None and not isinstance(b["caption"], str):
            errors.append("%s.caption must be a string" % where)
    elif t == "box":
        v = b.get("variant")
        if v is not None and v not in ("outline", "filled", "soft"):
            errors.append("%s.variant must be outline|filled|soft (got: %r)" % (where, v))
        if b.get("title") is not None and not isinstance(b["title"], str):
            errors.append("%s.title must be a string" % where)
        if b.get("lines") is not None and not isinstance(b["lines"], list):
            errors.append("%s.lines must be a list" % where)
    elif t == "list":
        if not isinstance(b.get("items"), list):
            errors.append("%s.items must be a list" % where)
        if "ordered" in b and b["ordered"] is not None and not isinstance(b["ordered"], bool):
            errors.append("%s.ordered must be true or false (got: %r)" % (where, b["ordered"]))
    elif t == "video":
        if safe_url(b.get("url")) is None:
            errors.append("%s.url must be a non-empty http(s)-safe link" % where)
        if b.get("title") is not None and not isinstance(b["title"], str):
            errors.append("%s.title must be a string" % where)
    elif t == "anchor":
        name = b.get("name")
        if not isinstance(name, str) or not PAGE_KEY_RE.match(name):
            errors.append('%s.name must match ^[a-z][a-z0-9-]{0,31}$ (got: %r)' % (where, name))
    # unknown block types stay unvalidated on purpose: they render as visible chips


def validate_model(m):
    errors = []
    if not isinstance(m, dict):
        return ["root must be a JSON object"]
    asset_names = set(m.get("assets")) if isinstance(m.get("assets"), dict) else set()

    th = m.get("theme")
    if not isinstance(th, dict):
        errors.append("theme must be an object")
    else:
        for k in ("accent", "background", "text", "font", "content_width"):
            if k not in th:
                errors.append("theme key missing: %s" % k)
        if "font" in th and th["font"] not in FONTS:
            errors.append("theme.font must be sans|serif|mono")
        if "content_width" in th:
            try:
                cw = int(th["content_width"])
                if not 480 <= cw <= 1100:
                    errors.append("theme.content_width must be 480-1100")
            except (TypeError, ValueError):
                errors.append("theme.content_width must be an int")

    pages = m.get("pages")
    if not isinstance(pages, list) or not pages:
        errors.append("pages must be a non-empty list")
    else:
        seen = set()
        for i, p in enumerate(pages):
            where = "pages[%d]" % i
            if not isinstance(p, dict):
                errors.append("%s must be an object" % where)
                continue
            key = p.get("key")
            if not isinstance(key, str) or not PAGE_KEY_RE.match(key):
                errors.append("%s.key must match ^[a-z][a-z0-9-]{0,31}$ (got: %r)" % (where, key))
            elif key in seen:
                errors.append("duplicate page key: %s" % key)
            else:
                seen.add(key)
            if "blocks" in p and not isinstance(p["blocks"], list):
                errors.append("%s.blocks must be a list" % where)
            else:
                for bi, b in enumerate(p.get("blocks") or []):
                    bt = b.get("type") if isinstance(b, dict) else None
                    what = "button block" if bt in ("button", "image_button") else "block"
                    validate_block(b, "%s #%d in page \"%s\""
                                   % (what, bi + 1, p.get("key") or "?"), asset_names, errors)
            for field in ("header_override", "footer_override"):
                ov = p.get(field)
                if ov is not None:
                    if not isinstance(ov, dict):
                        errors.append("%s.%s must be null or an object" % (where, field))
                    elif not isinstance(ov.get("buttons", []), list):
                        errors.append("%s.%s.buttons must be a list" % (where, field))
                    else:
                        for bi, b in enumerate(ov["buttons"]):
                            validate_button(b, "%s override button #%d in page \"%s\""
                                            % (field.replace("_override", ""), bi + 1,
                                               p.get("key") or "?"), errors)

    for field in ("header", "footer"):
        obj = m.get(field)
        if obj is None:
            continue
        if not isinstance(obj, dict):
            errors.append("%s must be an object" % field)
        elif not isinstance(obj.get("buttons", []), list):
            errors.append("%s.buttons must be a list" % field)
        else:
            for bi, b in enumerate(obj.get("buttons") or []):
                validate_button(b, "%s button #%d" % (field, bi + 1), errors)

    # "designs": the UI-managed block catalogue. Absent/null = tolerated (back-compat).
    designs = m.get("designs")
    if designs is not None and not isinstance(designs, list):
        errors.append("designs must be a list")
    if isinstance(designs, list):
        for di, d in enumerate(designs):
            where = "designs[%d]" % di
            if not isinstance(d, dict):
                errors.append("%s must be an object" % where)
                continue
            name = d.get("name")
            if not isinstance(name, str) or name.strip() == "" or len(name) > 40:
                errors.append("%s.name must be a non-empty string of at most 40 characters (got: %r)"
                              % (where, name))
            bl = d.get("blocks")
            if bl is not None and not isinstance(bl, list):
                errors.append("%s.blocks must be a list" % where)
            else:
                for bi, b in enumerate(bl or []):
                    bt = b.get("type") if isinstance(b, dict) else None
                    what = "button block" if bt in ("button", "image_button") else "block"
                    validate_block(b, "%s #%d in design \"%s\""
                                   % (what, bi + 1, name if isinstance(name, str) else "?"),
                                   asset_names, errors)

    assets = m.get("assets", {})
    if not isinstance(assets, dict):
        errors.append("assets must be an object")
    else:
        for k in assets:
            if not isinstance(k, str) or not ASSET_KEY_RE.match(k) or k in (".", ".."):
                errors.append("asset key invalid: %r" % k)
    return errors


# ---------------------------------------------------------------- upload

def sniff_image(data):
    """Magic bytes: JPEG FFD8 | PNG 89504E47 | GIF 'GIF8' | RIFF + WEBP@8:12."""
    if len(data) >= 2 and data[:2] == b"\xff\xd8":
        return True
    if len(data) >= 4 and data[:4] == b"\x89PNG":
        return True
    if len(data) >= 4 and data[:4] == b"GIF8":
        return True
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True
    return False


def handle_upload(name, data):
    """Returns a response dict (never raises)."""
    if not isinstance(name, str) or not ASSET_NAME_RE.match(name) or name in (".", ".."):
        return {"ok": False, "error": "invalid name"}
    if not name.lower().endswith(IMG_EXTS):
        return {"ok": False, "error": "bad extension (want png/jpg/jpeg/gif/webp)"}
    if len(data) > MAX_UPLOAD:
        return {"ok": False, "error": "too large (max 25MB)"}
    if not data or not sniff_image(data):
        return {"ok": False, "error": "magic bytes don't look like png/jpg/gif/webp"}
    model = load_model()
    if not isinstance(model, dict):
        return {"ok": False, "error": "no project loaded"}
    (ASSETS_DIR / name).write_bytes(data)
    assets = model.setdefault("assets", {})
    if not isinstance(assets, dict):
        return {"ok": False, "error": "assets must be an object"}
    assets[name] = {"uploaded": iso_now(), "bytes": len(data)}
    save_model(model)
    return {"ok": True, "asset": name}


# ---------------------------------------------------------------- seeding

def make_png(width, height):
    """Tiny pure-stdlib PNG writer: zlib + struct only."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter: none
        for x in range(width):
            r = (x * 255) // max(1, width - 1)
            g = (y * 255) // max(1, height - 1)
            b = 180 + (3 * (x + y)) % 60
            rows += bytes((r, g, b))

    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBB", width, height, 8, 2, 0)  # color type 2 = RGB
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def build_demo_model(photo_bytes, portrait_bytes, square_bytes):
    """The seeded demo doubles as the schema reference: it exercises every block
    type, including strip/gallery/box/list/video/anchor and anchored nav."""
    stamp = iso_now()
    header = {
        "title": "Demo Site",
        "subtitle": "A fictional site seeded by builder.py",
        "logo_asset": None,
        "buttons": [
            {"label": "Home", "to": "home"},
            {"label": "About", "to": "about"},
            {"label": "Pricing", "to": "about", "anchor": "pricing"},
            {"label": "Email", "url": "mailto:demo@example.com"},
            {"label": "Gear", "url": "https://example.com/gear", "newtab": True},
        ],
    }
    home = {
        "key": "home",
        "title": "Home",
        "header_override": None,
        "footer_override": None,
        "blocks": [
            {"type": "heading", "text": "Welcome to the Demo Site", "level": 1},
            {"type": "strip", "bg": "#173f5f",
             "text": "*Full-bleed:* this band ignores the content column and spans the whole viewport.",
             "align": "center", "height": "medium"},
            {"type": "paragraph",
             "text": ("This whole site lives in **one JSON file**. The editor writes markdown-lite: "
                      "*emphasis*, **strong**, [About](to:about) internal links and "
                      "[the external site](https://example.com) external links.")},
            {"type": "image", "asset": "demo-photo.png", "alt": "Wide gradient demo photo",
             "width": "wide", "align": "center",
             "caption": "A **generated** gradient, written to site/assets by the seed script."},
            {"type": "button", "label": "Go to About", "style": "pill", "to": "about"},
            {"type": "image_button", "asset": "demo-portrait.png", "alt": "Portrait thumbnail",
             "label": "Albums", "to": "about", "width": "medium", "shape": "rounded"},
            {"type": "divider"},
            {"type": "quote", "text": "One renderer, two destinations: preview and disk.",
             "attribution": "builder.py"},
            {"type": "box", "variant": "soft", "title": "Why one renderer?",
             "lines": ["Preview and export **share one code path**.",
                       "What you see at *localhost:8000* is exactly what lands on disk.",
                       "Panels like this one stay inside the reading column."]},
            {"type": "divider"},
            {"type": "custom_html",
             "html": ('<div class="demo-grid"><div class="demo-cell">Custom HTML is injected verbatim.</div>'
                      '<div class="demo-cell">Its CSS comes from the same model.</div></div>'),
             "css": (".demo-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}"
                     ".demo-cell{border:2px dashed var(--accent);padding:14px;background:var(--bg)}")},
        ],
    }
    about = {
        "key": "about",
        "title": "About",
        "header_override": None,
        "footer_override": {
            "text": "The About page keeps only its own two links.",
            "buttons": [{"label": "Home", "to": "home"}, {"label": "About", "to": "about"}],
        },
        "blocks": [
            {"type": "heading", "text": "About the Demo", "level": 2},
            {"type": "paragraph",
             "text": ("The header, footer and *buttons* above were inherited from the site header "
                      "(header_override is null). Back to [Home](to:home). And here is a deliberately "
                      "dead link: [Old Catalog](to:old-catalog) shows what a missing key looks like.")},
            {"type": "contact_card",
             "lines": [{"label": "Email", "value": "demo@example.com", "url": "mailto:demo@example.com"},
                       {"label": "Phone", "value": "+1 555 0134", "url": None}]},
            {"type": "anchor", "name": "pricing"},
            {"type": "heading", "text": "Pricing (fictional)", "level": 3},
            {"type": "list", "ordered": True,
             "items": ["**Starter** - 9 credits/mo", "Pro - 19 credits/mo", "Studio - 29 credits/mo"]},
            {"type": "gallery",
             "assets": ["demo-photo.png", "demo-portrait.png", "demo-square.png"],
             "columns": 3,
             "caption": "Three **generated** gradients: wide, *portrait* and square."},
            {"type": "video",
             "url": "https://www.youtube.com/watch?v=eXrd5sNdacA",
             "title": "NASA's First-Ever Tech Expo and Air Show (real embed)"},
            {"type": "list", "ordered": False,
             "items": ["Bad values become **visible chips**, never crashes",
                       "Unknown block types chip too",
                       "*Every* text field goes through html.escape first"]},
            {"type": "social_links",
             "items": [{"network": "GitHub", "url": "https://github.com/demo-org", "label": None},
                       {"network": "Mastodon", "url": "https://mastodon.social/@demo", "label": "Mastodon"}]},
        ],
    }
    return {
        "meta": {"name": "Demo Site", "language": "en"},
        "theme": {"accent": "#2b59c6", "background": "#f7f6f3", "text": "#1d2430",
                  "font": "serif", "content_width": 760},
        "header": header,
        "footer": {"text": "Made with builder.py -- preview and export share one renderer.",
                   "buttons": [
                       {"label": "Home", "to": "home"},
                       {"label": "About", "to": "about"},
                       {"label": "Email", "url": "mailto:demo@example.com"},
                       {"label": "Gear", "url": "https://example.com/gear", "newtab": True},
                   ]},
        "pages": [home, about],
        "designs": [
            {"name": "Starter strip",
             "blocks": [{"type": "strip", "bg": "#173f5f", "text": "New **tagline** band",
                        "align": "center", "height": "low"},
                        {"type": "box", "variant": "outline", "title": "Draft callout",
                         "lines": ["UI-managed catalogue entry; never rendered by the server."]}]},
        ],
        "assets": {"demo-photo.png": {"uploaded": stamp, "bytes": len(photo_bytes)},
                   "demo-portrait.png": {"uploaded": stamp, "bytes": len(portrait_bytes)},
                   "demo-square.png": {"uploaded": stamp, "bytes": len(square_bytes)}},
    }


def ensure_seed():
    """On first run (no site/project.json) write the demo project + PNG assets."""
    if PROJECT_PATH.is_file():
        return
    SITE.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    photo = make_png(300, 200)
    portrait = make_png(200, 200)
    square = make_png(240, 240)
    (ASSETS_DIR / "demo-photo.png").write_bytes(photo)
    (ASSETS_DIR / "demo-portrait.png").write_bytes(portrait)
    (ASSETS_DIR / "demo-square.png").write_bytes(square)
    save_model(build_demo_model(photo, portrait, square))


# ---------------------------------------------------------------- HTTP layer

def _threading_http_class():
    import http.server  # module import: name may or may not exist in 3.9
    cls = getattr(http.server, "ThreadingHTTPServer", None)
    if cls is None:  # Python 3.9 fallback: same recipe as 3.11+'s stdlib class
        cls = type("ThreadingHTTPServer", (socketserver.ThreadingMixIn, http.server.HTTPServer),
                   {"daemon_threads": True})
    return cls


PLACEHOLDER_UI = ("<!doctype html><meta charset=\"utf-8\"><title>Editor UI</title>"
                  "<p>editor UI loading — see ui/ (index.html, app.css, app.js go here)</p>")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return  # quiet request log; keep stderr clean for test runs

    def _send(self, code, ctype, body, extra_headers=None):
        if not isinstance(body, bytes):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def _json(self, obj, code=200):
        self._send(code, "application/json", json.dumps(obj))

    def _not_found(self, what):
        body = ("<!doctype html><meta charset=\"utf-8\"><title>404</title>"
                "<p>404 — no route for %s</p>" % esc(what))
        self._send(404, "text/html; charset=utf-8", body)

    def _guess_type(self, name):
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        return {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "gif": "image/gif", "webp": "image/webp", "html": "text/html; charset=utf-8",
                "css": "text/css; charset=utf-8", "js": "text/javascript; charset=utf-8"}.get(
                    ext, "application/octet-stream")

    def do_GET(self):
        try:
            self.route_get()
        except Exception as e:
            self._send(500, "text/plain; charset=utf-8", "handler failed: %r" % e)

    def do_POST(self):
        try:
            self.route_post()
        except Exception as e:
            self._send(500, "text/plain; charset=utf-8", "handler failed: %r" % e)

    # -- routes ------------------------------------------------------------
    def route_get(self):
        parsed = urllib.parse.urlparse(self.path)
        p, q = parsed.path, urllib.parse.parse_qs(parsed.query)

        if p == "/":
            page = UI_DIR / "index.html"
            if page.is_file():
                self._send(200, "text/html; charset=utf-8", page.read_bytes())
            else:
                self._send(200, "text/html; charset=utf-8", PLACEHOLDER_UI)
            return
        if p in UI_WHITELIST:
            f = UI_DIR / p[len("/ui/"):]
            if f.is_file():
                self._send(200, UI_WHITELIST[p], f.read_bytes())
            else:
                self._not_found(p)
            return
        if p == "/api/project":
            if PROJECT_PATH.is_file():
                self._send(200, "application/json", PROJECT_PATH.read_bytes())
            else:
                self._json({"ok": False, "error": "no project"})
            return
        if p.startswith("/preview/"):
            self.route_preview(p[len("/preview/"):], q)
            return
        if p == "/api/export/zip":
            model = load_model()
            if not isinstance(model, dict):
                self._not_found(p)
                return
            self._send(200, "application/zip", make_zip(model),
                       {"Content-Disposition": 'attachment; filename="site.zip"'})
            return
        if p == "/export-view":
            self._send(200, "text/html; charset=utf-8", self.export_view_page())
            return
        if p.startswith("/export/"):
            self.route_export_file(p[len("/export/"):])
            return
        self._not_found(p)

    def route_post(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/project":
            body = self._read_body()
            try:
                model = json.loads(body.decode("utf-8"))
            except (UnicodeError, ValueError) as e:
                self._json({"ok": False, "errors": ["invalid JSON: %s" % e]}, 400)
                return
            errors = validate_model(model)
            if errors:
                self._json({"ok": False, "errors": errors}, 400)
                return
            save_model(model)
            self._json({"ok": True})
            return
        if p == "/api/upload":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = (q.get("name") or [None])[0]
            data = self._read_body()
            result = handle_upload(name, data)
            self._json(result, 200 if result.get("ok") else 400)
            return
        if p == "/api/export":
            model = load_model()
            if not isinstance(model, dict):
                self._json({"ok": False, "errors": ["no project"]}, 400)
                return
            self._json(do_export(model))
            return
        self._not_found(p)

    def route_preview(self, tail, q):
        if tail == "style.css":
            model = load_model()
            if not isinstance(model, dict):
                self._not_found(tail)
                return
            self._send(200, "text/css; charset=utf-8", gen_css(model))
            return
        if tail.startswith("assets/"):
            # dict-membership in model["assets"] is the path-traversal guard
            name = tail[len("assets/"):]
            model = load_model()
            assets = (model or {}).get("assets") if isinstance(model, dict) else None
            if isinstance(assets, dict) and name in assets and asset_on_disk(name):
                self._send(200, self._guess_type(name), (ASSETS_DIR / name).read_bytes())
            else:
                self._not_found(tail)
            return
        if tail.endswith(".html"):
            key = tail[:-5]
            model = load_model()
            if not isinstance(model, dict):
                self._not_found(tail)
                return
            if key not in page_keys(model) and key == "index":
                key = "home"  # preview alias: the export calls the home page index.html
            if key not in page_keys(model):
                self._not_found(tail)
                return
            base = "" if (q.get("base") or [""])[0] == "export" else "/preview/"
            doc = render_page(model, key, base)
            self._send(200, "text/html; charset=utf-8", doc,
                       {"Content-Security-Policy":
                        "sandbox allow-forms allow-popups allow-scripts allow-same-origin"})
            return
        self._not_found(tail)

    def route_export_file(self, rel):
        if not EXPORT_REL_RE.match(rel):
            self._not_found("/export/" + rel)
            return
        f = EXPORT_DIR / rel
        if f.is_file():
            self._send(200, self._guess_type(rel), f.read_bytes())
        else:
            self._not_found("/export/" + rel)

    def export_view_page(self):
        names = []
        if EXPORT_DIR.is_dir():
            for f in EXPORT_DIR.rglob("*"):
                if f.is_file():
                    names.append(str(f.relative_to(EXPORT_DIR)).replace(os.sep, "/"))
        names.sort()
        links = "".join('<a href="/export/%s">%s</a><br>' % (n, esc(n)) for n in names)
        return ("<!doctype html><meta charset=\"utf-8\"><title>Export</title>"
                "<h2>export/ (%d files)</h2>%s" % (len(names), links))


# ---------------------------------------------------------------- main

def main():
    no_browser = "--no-browser" in sys.argv[1:]
    for bad in [a for a in sys.argv[1:] if a.startswith("--") and a != "--no-browser"]:
        raise SystemExit("unknown flag: %s" % bad)
    ensure_seed()
    print("open http://localhost:8000")
    if not no_browser:
        webbrowser.open("http://localhost:8000/")
    srv_cls = _threading_http_class()
    srv = srv_cls((HOST, PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
