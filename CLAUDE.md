# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npx esbuild main.ts --bundle --external:obsidian --external:electron --format=cjs --outfile=main.js
```

There are no tests.

## Architecture

This is an [Obsidian](https://obsidian.md) plugin that renders EPUB files inside Obsidian using a custom reader view. The build output is a single `main.js` (CommonJS bundle via esbuild), plus `manifest.json` and `styles.css`.

### Source files

- **`main.ts`** — Plugin entry point. Registers the `EpubView` for `.epub` files, provides the ribbon icon and command palette entry, and manages `ThoriumReaderSettings` (font, theme, reading positions) via Obsidian's `loadData()`/`saveData()`.
- **`epub-view.ts`** — `EpubView extends ItemView`. Renders the reader UI: toolbar (TOC, prev/next, theme toggle, font size), a sidebar TOC panel, and an `<iframe>` that displays chapter HTML. Handles chapter navigation, scroll-position save/restore, theme cycling, and annotation display. Chapter content is injected into the iframe as a blob URL with all images and CSS resolved to data URLs.
- **`epub-parser.ts`** — Parses the EPUB zip (via `jszip`): reads `container.xml` → OPF file → spine + manifest. Builds the TOC from EPUB3 `<nav>` or falls back to NCX. Exports `parseEpub()`, `getChapterContent()`, and `getResourceAsDataUrl()`.
- **`annotations.ts`** — `AnnotationManager` persists highlights and reading positions as Markdown files in the vault under `epub-annotations/<book-name>/`. Each annotation is a `.md` file with YAML frontmatter. Reading position is stored in `_reading-position.md` in the same folder.

### Data flow

1. User opens an `.epub` file → Obsidian triggers `EpubView.setState()` → `loadEpubFile()` → `parseEpub()` returns a `ParsedEpub` (metadata, spine, TOC, raw JSZip handle).
2. `renderChapter(index)` fetches chapter HTML, rewrites all `src`/`href` attributes to data URLs via `getResourceAsDataUrl()`, and writes the result into the iframe via `URL.createObjectURL`.
3. Reading position is auto-saved via a debounced timer into both plugin settings (`saveData`) and `AnnotationManager` (vault markdown file). On re-open, position is restored by `scrollFraction` or `anchorText` matching.

### Release

Releases are triggered by pushing a git tag. The CI workflow (`.github/workflows/release.yml`) builds and creates a draft GitHub release with `main.js`, `manifest.json`, and `styles.css`.
