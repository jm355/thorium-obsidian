import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { ParsedEpub, parseEpub, getChapterContent, TocItem } from "./epub-parser";
import type ThoriumReaderPlugin from "./main";

export const EPUB_VIEW_TYPE = "thorium-epub-view";

export class EpubView extends ItemView {
  plugin: ThoriumReaderPlugin;
  epub: ParsedEpub | null = null;
  currentChapter = 0;
  filePath = "";

  // DOM elements
  private iframe: HTMLIFrameElement | null = null;
  private tocContainer: HTMLElement | null = null;
  private chapterTitle: HTMLElement | null = null;
  private tocVisible = false;

  constructor(leaf: WorkspaceLeaf, plugin: ThoriumReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return EPUB_VIEW_TYPE;
  }

  getDisplayText(): string {
    if (this.epub) return this.epub.metadata.title;
    return "EPUB Reader";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("thorium-epub-container");

    // Toolbar
    const toolbar = container.createDiv({ cls: "thorium-toolbar" });

    const tocBtn = toolbar.createEl("button", { text: "☰ TOC", cls: "thorium-btn" });
    tocBtn.addEventListener("click", () => this.toggleToc());

    const prevBtn = toolbar.createEl("button", { text: "← Prev", cls: "thorium-btn" });
    prevBtn.addEventListener("click", () => this.navigateChapter(-1));

    this.chapterTitle = toolbar.createEl("span", { cls: "thorium-chapter-title" });

    const nextBtn = toolbar.createEl("button", { text: "Next →", cls: "thorium-btn" });
    nextBtn.addEventListener("click", () => this.navigateChapter(1));

    // Theme toggle
    const themeBtn = toolbar.createEl("button", { text: "◑ Theme", cls: "thorium-btn" });
    themeBtn.addEventListener("click", () => this.cycleTheme());

    // Font size controls
    const fontDown = toolbar.createEl("button", { text: "A−", cls: "thorium-btn" });
    fontDown.addEventListener("click", () => this.adjustFontSize(-2));

    const fontUp = toolbar.createEl("button", { text: "A+", cls: "thorium-btn" });
    fontUp.addEventListener("click", () => this.adjustFontSize(2));

    // Main content area
    const contentWrapper = container.createDiv({ cls: "thorium-content-wrapper" });

    // TOC sidebar
    this.tocContainer = contentWrapper.createDiv({ cls: "thorium-toc-panel" });
    this.tocContainer.style.display = "none";

    // Iframe for chapter content
    this.iframe = contentWrapper.createEl("iframe", { cls: "thorium-reader-frame" });

    if (this.filePath) {
      await this.loadEpubFile(this.filePath);
    }
  }

  async loadEpubFile(path: string): Promise<void> {
    this.filePath = path;
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) {
        new Notice(`File not found: ${path}`);
        return;
      }

      const data = await this.app.vault.readBinary(file as any);
      this.epub = await parseEpub(data);

      // Build TOC
      this.buildToc();

      // Update title
      this.leaf.updateHeader();

      // Load first chapter
      this.currentChapter = 0;
      await this.renderChapter();
    } catch (e) {
      new Notice(`Failed to open EPUB: ${(e as Error).message}`);
      console.error("EPUB parse error:", e);
    }
  }

  private buildToc(): void {
    if (!this.tocContainer || !this.epub) return;
    this.tocContainer.empty();

    const header = this.tocContainer.createEl("h3", { text: "Table of Contents" });
    header.style.margin = "0 0 8px 0";

    if (this.epub.toc.length === 0) {
      // Fallback: list spine items
      this.epub.spine.forEach((item, idx) => {
        const entry = this.tocContainer!.createEl("div", {
          text: item.href.split("/").pop() || `Chapter ${idx + 1}`,
          cls: "thorium-toc-entry",
        });
        entry.addEventListener("click", () => {
          this.currentChapter = idx;
          this.renderChapter();
        });
      });
    } else {
      this.renderTocItems(this.epub.toc, this.tocContainer);
    }
  }

  private renderTocItems(items: TocItem[], parent: HTMLElement): void {
    for (const item of items) {
      const entry = parent.createEl("div", {
        text: item.label,
        cls: "thorium-toc-entry",
      });
      entry.addEventListener("click", () => {
        // Find the spine index matching this TOC href
        const cleanHref = item.href.split("#")[0];
        const idx = this.epub!.spine.findIndex(
          (s) => s.href === cleanHref || s.href.endsWith(cleanHref)
        );
        if (idx >= 0) {
          this.currentChapter = idx;
          this.renderChapter(item.href.includes("#") ? item.href.split("#")[1] : undefined);
        }
      });
      if (item.children.length > 0) {
        const nested = parent.createDiv({ cls: "thorium-toc-nested" });
        this.renderTocItems(item.children, nested);
      }
    }
  }

  private toggleToc(): void {
    if (!this.tocContainer) return;
    this.tocVisible = !this.tocVisible;
    this.tocContainer.style.display = this.tocVisible ? "block" : "none";
  }

  private async renderChapter(fragment?: string): Promise<void> {
    if (!this.epub || !this.iframe) return;

    const spineItem = this.epub.spine[this.currentChapter];
    if (!spineItem) return;

    let html = await getChapterContent(this.epub, spineItem.href);
    console.log(`[Thorium] Chapter ${this.currentChapter}: href="${spineItem.href}", html length=${html.length}, first 200 chars:`, html.substring(0, 200));

    // Resolve internal resources (images, CSS) to data URLs
    html = await this.resolveResources(html, spineItem.href);

    // Inject reading styles
    const isDark = this.plugin.settings.theme === "dark";
    const fontSize = this.plugin.settings.fontSize;
    const fontFamily = this.plugin.settings.fontFamily;

    const styleOverride = `
      <style>
        :root {
          --reader-bg: ${isDark ? "#1e1e1e" : this.plugin.settings.theme === "sepia" ? "#f4ecd8" : "#ffffff"};
          --reader-fg: ${isDark ? "#d4d4d4" : "#1a1a1a"};
        }
        html, body {
          background: var(--reader-bg) !important;
          color: var(--reader-fg) !important;
          font-size: ${fontSize}px !important;
          font-family: ${fontFamily}, Georgia, serif !important;
          line-height: 1.7 !important;
          max-width: 45em;
          margin: 0 auto !important;
          padding: 24px 32px !important;
          overflow-x: hidden;
          word-wrap: break-word;
        }
        img { max-width: 100% !important; height: auto !important; }
        a { color: ${isDark ? "#6ba4f8" : "#2563eb"} !important; }
        pre, code { font-size: 0.9em; }
      </style>
    `;

    // Inject styles into the HTML
    if (html.includes("</head>")) {
      html = html.replace("</head>", styleOverride + "</head>");
    } else if (html.includes("<body")) {
      html = html.replace("<body", styleOverride + "<body");
    } else {
      html = styleOverride + html;
    }

    // Write to iframe using srcdoc (works reliably in Electron/Obsidian)
    this.iframe.srcdoc = html;

    // Scroll to fragment after load
    if (fragment) {
      this.iframe.onload = () => {
        try {
          const el = this.iframe?.contentDocument?.getElementById(fragment);
          el?.scrollIntoView();
        } catch {
          // cross-origin safety
        }
      };
    }

    // Update chapter title display
    if (this.chapterTitle) {
      const tocLabel = this.findTocLabel(spineItem.href);
      this.chapterTitle.textContent = tocLabel ||
        `${this.currentChapter + 1} / ${this.epub.spine.length}`;
    }
  }

  private findTocLabel(href: string): string {
    const search = (items: TocItem[]): string => {
      for (const item of items) {
        const cleanHref = item.href.split("#")[0];
        if (href === cleanHref || href.endsWith(cleanHref)) return item.label;
        const child = search(item.children);
        if (child) return child;
      }
      return "";
    };
    return this.epub ? search(this.epub.toc) : "";
  }

  private async resolveResources(html: string, chapterHref: string): Promise<string> {
    if (!this.epub) return html;

    const chapterDir = chapterHref.substring(0, chapterHref.lastIndexOf("/") + 1);

    // Resolve images
    const imgRegex = /src="([^"]+)"/g;
    const matches = [...html.matchAll(imgRegex)];
    for (const match of matches) {
      const rawSrc = match[1];
      if (rawSrc.startsWith("data:") || rawSrc.startsWith("http")) continue;
      try {
        const resolvedPath = this.resolvePath(chapterDir, rawSrc);
        const fullPath = this.epub.basePath + resolvedPath;
        const file = this.epub.zip.file(fullPath);
        if (file) {
          const base64 = await file.async("base64");
          const ext = rawSrc.split(".").pop()?.toLowerCase() || "";
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
          };
          const mime = mimeMap[ext] || "image/png";
          html = html.replace(rawSrc, `data:${mime};base64,${base64}`);
        }
      } catch { /* skip unresolvable */ }
    }

    // Inline CSS files
    const cssRegex = /href="([^"]+\.css[^"]*)"/g;
    const cssMatches = [...html.matchAll(cssRegex)];
    for (const match of cssMatches) {
      const rawHref = match[1];
      if (rawHref.startsWith("data:") || rawHref.startsWith("http")) continue;
      try {
        const resolvedPath = this.resolvePath(chapterDir, rawHref);
        const fullPath = this.epub.basePath + resolvedPath;
        const file = this.epub.zip.file(fullPath);
        if (file) {
          const cssText = await file.async("text");
          // Replace the <link> with inline <style>
          const linkTag = new RegExp(
            `<link[^>]*href="${rawHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/?>`,
            "g"
          );
          html = html.replace(linkTag, `<style>${cssText}</style>`);
        }
      } catch { /* skip */ }
    }

    return html;
  }

  private resolvePath(base: string, relative: string): string {
    if (relative.startsWith("/")) return relative.substring(1);
    const parts = (base + relative).split("/");
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === "..") resolved.pop();
      else if (p !== "." && p !== "") resolved.push(p);
    }
    return resolved.join("/");
  }

  private navigateChapter(delta: number): void {
    if (!this.epub) return;
    const next = this.currentChapter + delta;
    if (next >= 0 && next < this.epub.spine.length) {
      this.currentChapter = next;
      this.renderChapter();
    }
  }

  private currentThemeIdx = 0;
  private readonly themes = ["light", "sepia", "dark"];

  private cycleTheme(): void {
    this.currentThemeIdx = (this.currentThemeIdx + 1) % this.themes.length;
    this.plugin.settings.theme = this.themes[this.currentThemeIdx];
    this.plugin.saveSettings();
    this.renderChapter();
  }

  private adjustFontSize(delta: number): void {
    this.plugin.settings.fontSize = Math.max(
      12,
      Math.min(32, this.plugin.settings.fontSize + delta)
    );
    this.plugin.saveSettings();
    this.renderChapter();
  }

  async onClose(): Promise<void> {
    this.epub = null;
  }

  getState(): Record<string, unknown> {
    return { file: this.filePath, filePath: this.filePath, chapter: this.currentChapter };
  }

  async setState(state: Record<string, unknown>, result?: Record<string, unknown>): Promise<void> {
    // Obsidian passes { file: "path" } for registered extensions
    const path = (typeof state.file === "string" && state.file)
      ? state.file
      : (typeof state.filePath === "string" && state.filePath)
        ? state.filePath
        : "";

    if (path) {
      this.filePath = path;
      if (typeof state.chapter === "number") {
        this.currentChapter = state.chapter;
      }
      await this.loadEpubFile(this.filePath);
      if (typeof state.chapter === "number" && state.chapter > 0) {
        this.currentChapter = state.chapter;
        await this.renderChapter();
      }
    }

    await super.setState(state, result as any);
  }
}
