#!/usr/bin/env python3
"""Split docs/GUIDE.md into one markdown article per numbered section for the
openzo site (Projects/openzo-site/docs). The guide stays the single source;
run this after editing it."""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
site_docs = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / "openzo-site" / "docs"
guide = (root / "docs" / "GUIDE.md").read_text()

sections = re.split(r"^## (\d+)\. (.+)$", guide, flags=re.M)
site_docs.mkdir(parents=True, exist_ok=True)
for old in site_docs.glob("*.md"):
    old.unlink()

slugs = {}
for i in range(1, len(sections), 3):
    num, title, body = int(sections[i]), sections[i + 1].strip(), sections[i + 2]
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    slugs[f"#{num}-{re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')}"] = f"/docs/{slug}"
    body = body.strip().rstrip("-").strip()
    (site_docs / f"{slug}.md").write_text(f"---\ntitle: {title}\norder: {num}\n---\n\n{body}\n")

# Rewrite in-guide anchors (§ references) to site paths.
for f in site_docs.glob("*.md"):
    text = f.read_text()
    for anchor, path in slugs.items():
        text = text.replace(f"]({anchor})", f"]({path})")
    text = text.replace("](docs/GUIDE.md)", "](/docs)")
    f.write_text(text)
print(f"wrote {len(slugs)} articles to {site_docs}")
