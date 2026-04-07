# Thorium EPUB Reader for Obsidian

Read EPUB ebooks directly inside Obsidian, inspired by the [Thorium Web](https://github.com/edrlab/thorium-web) reader and vibe coded by Claude.

## Features

- **Open EPUBs in-vault** — click any `.epub` file in your vault and it opens in a reading view
- **Table of Contents** — navigate chapters via the TOC sidebar
- **Reading themes** — Light, Sepia, and Dark modes
- **Font controls** — adjust font size and family
- **Image & CSS support** — inline resolution of embedded images and stylesheets
- **Chapter navigation** — prev/next buttons and keyboard-friendly
- **Remembers position** — re-opening a tab restores your chapter

## Installation

### Manual
1. Clone or download this repository into your vault's `.obsidian/plugins/thorium-epub-reader/` folder
2. Run `npm install` and `npm run build`
3. Restart Obsidian and enable the plugin in Settings → Community Plugins

### From source
```bash
git clone https://github.com/your-username/obsidian-thorium-reader.git
cd obsidian-thorium-reader
npm install
npm run build
```
Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/thorium-epub-reader/`.

## Usage

1. Drop `.epub` files into your vault
2. Click an EPUB file in the file explorer — it opens in the Thorium reader view
3. Or use the **book icon** in the ribbon / run the command **"Open an EPUB file from vault"**

## Advanced: Thorium Web Server

If you run a self-hosted [Thorium Web](https://github.com/edrlab/thorium-web) instance with the Go Toolkit backend, you can point the plugin at it in Settings for the full Thorium Web experience (Web Publication Manifest support, advanced navigation, accessibility features).

## Future Improvements
- Reading position indicator
- Search the book
- automatic theme
- open book to position with link (and add links to note/highlight files, so you can jump to the bookmark)
- display position of items in toc
