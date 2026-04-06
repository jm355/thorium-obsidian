import { ItemView, WorkspaceLeaf, Notice, Modal, App, TextAreaComponent } from "obsidian";
import { ParsedEpub, parseEpub, getChapterContent, TocItem } from "./epub-parser";
import { AnnotationManager, Annotation } from "./annotations";
import type ThoriumReaderPlugin from "./main";

export const EPUB_VIEW_TYPE = "thorium-epub-view";

export class EpubView extends ItemView {
  plugin: ThoriumReaderPlugin;
  epub: ParsedEpub | null = null;
  currentChapter = 0;
  filePath = "";

  private iframe: HTMLIFrameElement | null = null;
  private tocContainer: HTMLElement | null = null;
  private chapterTitle: HTMLElement | null = null;
  private tocVisible = false;

  private annotationMgr: AnnotationManager;
  private chapterAnnotations: Annotation[] = [];
  private savePositionTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRestore: { anchorText?: string; scrollFraction: number } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ThoriumReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.annotationMgr = new AnnotationManager(this.app);
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

    const themeBtn = toolbar.createEl("button", { text: "◑ Theme", cls: "thorium-btn" });
    themeBtn.addEventListener("click", () => this.cycleTheme());

    const fontDown = toolbar.createEl("button", { text: "A−", cls: "thorium-btn" });
    fontDown.addEventListener("click", () => this.adjustFontSize(-2));

    const fontUp = toolbar.createEl("button", { text: "A+", cls: "thorium-btn" });
    fontUp.addEventListener("click", () => this.adjustFontSize(2));

    // Content area
    const contentWrapper = container.createDiv({ cls: "thorium-content-wrapper" });

    this.tocContainer = contentWrapper.createDiv({ cls: "thorium-toc-panel" });
    this.tocContainer.style.display = "none";

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

      this.buildToc();
      this.leaf.updateHeader();

      // Restore saved reading position
      const saved = this.plugin.getReadingPosition(this.filePath);
      if (saved) {
        this.currentChapter = saved.chapter;
        if (saved.anchorText || saved.scrollFraction > 0) {
          this.pendingRestore = { anchorText: saved.anchorText, scrollFraction: saved.scrollFraction };
        }
      } else {
        this.currentChapter = 0;
      }

      await this.renderChapter();
    } catch (e) {
      new Notice(`Failed to open EPUB: ${(e as Error).message}`);
      console.error("EPUB parse error:", e);
    }
  }

  // ─── TOC ──────────────────────────────────────────────────────

  private buildToc(): void {
    if (!this.tocContainer || !this.epub) return;
    this.tocContainer.empty();

    const header = this.tocContainer.createEl("h3", { text: "Table of Contents" });
    header.style.margin = "0 0 8px 0";

    if (this.epub.toc.length === 0) {
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

  // ─── Chapter Rendering ────────────────────────────────────────

  private async renderChapter(fragment?: string): Promise<void> {
    if (!this.epub || !this.iframe) return;

    const spineItem = this.epub.spine[this.currentChapter];
    if (!spineItem) return;

    // Save position before navigating away
    this.saveReadingPosition();

    let html = await getChapterContent(this.epub, spineItem.href);
    html = await this.resolveResources(html, spineItem.href);

    // Load annotations for this chapter
    this.chapterAnnotations = await this.annotationMgr.loadChapterAnnotations(
      this.filePath,
      this.currentChapter
    );

    // Build the highlight + selection script to inject into iframe
    const annotationScript = this.buildAnnotationScript();

    // Inject styles
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

        mark.thorium-highlight {
          border-radius: 2px;
          padding: 1px 0;
          cursor: pointer;
        }
        mark.thorium-highlight[data-color="yellow"] { background: rgba(255, 235, 59, 0.45); }
        mark.thorium-highlight[data-color="green"]  { background: rgba(76, 175, 80, 0.35); }
        mark.thorium-highlight[data-color="blue"]   { background: rgba(66, 165, 245, 0.35); }
        mark.thorium-highlight[data-color="pink"]   { background: rgba(236, 64, 122, 0.30); }
        mark.thorium-highlight[data-color="orange"] { background: rgba(255, 152, 0, 0.40); }

        mark.thorium-highlight[data-has-note="true"]::after {
          content: "\\1F4DD";
          font-size: 0.6em;
          vertical-align: super;
          margin-left: 2px;
        }

        #thorium-sel-toolbar {
          display: none;
          position: absolute;
          z-index: 9999;
          background: ${isDark ? "#2d2d2d" : "#fff"};
          border: 1px solid ${isDark ? "#555" : "#ccc"};
          border-radius: 6px;
          padding: 4px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          gap: 4px;
          align-items: center;
        }
        #thorium-sel-toolbar button {
          border: none;
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 13px;
          background: ${isDark ? "#444" : "#f0f0f0"};
          color: ${isDark ? "#ddd" : "#333"};
        }
        #thorium-sel-toolbar button:hover {
          background: ${isDark ? "#555" : "#ddd"};
        }
        .thorium-color-dot {
          width: 18px; height: 18px;
          border-radius: 50%;
          border: 2px solid ${isDark ? "#666" : "#ccc"};
          cursor: pointer;
          display: inline-block;
        }
        .thorium-color-dot:hover { border-color: ${isDark ? "#aaa" : "#666"}; }

        #thorium-hl-tooltip {
          display: none;
          position: absolute;
          z-index: 9999;
          background: ${isDark ? "#2d2d2d" : "#fff"};
          border: 1px solid ${isDark ? "#555" : "#ccc"};
          border-radius: 6px;
          padding: 8px 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          max-width: 300px;
          font-size: 13px;
          color: ${isDark ? "#ddd" : "#333"};
        }
        #thorium-hl-tooltip .hl-note { margin: 4px 0; font-style: italic; }
        #thorium-hl-tooltip button {
          border: none; border-radius: 4px; padding: 3px 8px;
          cursor: pointer; font-size: 12px; margin-right: 4px;
          background: ${isDark ? "#444" : "#f0f0f0"};
          color: ${isDark ? "#ddd" : "#333"};
        }
        #thorium-hl-tooltip button:hover { background: ${isDark ? "#555" : "#ddd"}; }
      </style>
    `;

    if (html.includes("</head>")) {
      html = html.replace("</head>", styleOverride + "</head>");
    } else if (html.includes("<body")) {
      html = html.replace("<body", styleOverride + "<body");
    } else {
      html = styleOverride + html;
    }

    const toolbarHtml = `
      <div id="thorium-sel-toolbar"></div>
      <div id="thorium-hl-tooltip"></div>
      <script>${annotationScript}<\/script>
    `;
    if (html.includes("</body>")) {
      html = html.replace("</body>", toolbarHtml + "</body>");
    } else {
      html = html + toolbarHtml;
    }

    this.iframe.srcdoc = html;
    this.setupIframeListener();

    this.iframe.onload = () => {
      if (fragment) {
        try {
          const el = this.iframe?.contentDocument?.getElementById(fragment);
          el?.scrollIntoView();
        } catch { /* ignore */ }
      }

      // Restore scroll position if pending
      if (this.pendingRestore) {
        const restore = this.pendingRestore;
        this.pendingRestore = null;
        this.doScrollRestore(restore);
      }

      try {
        this.iframe?.contentDocument?.addEventListener("scroll", () => {
          this.debounceSavePosition();
        });
      } catch { /* ignore */ }
    };

    if (this.chapterTitle) {
      const tocLabel = this.findTocLabel(spineItem.href);
      this.chapterTitle.textContent = tocLabel ||
        `${this.currentChapter + 1} / ${this.epub.spine.length}`;
    }
  }

  // ─── Annotation Script (injected into iframe) ────────────────

  private buildAnnotationScript(): string {
    const highlights = this.chapterAnnotations.map((a) => ({
      id: a.id,
      text: a.selectedText,
      prefix: a.prefix,
      suffix: a.suffix,
      color: a.color,
      note: a.note,
    }));

    return `
    (function() {
      var highlights = ${JSON.stringify(highlights)};
      var colors = ["yellow", "green", "blue", "pink", "orange"];

      function applyHighlights() {
        highlights.forEach(function(hl) {
          findAndHighlight(hl);
        });
      }

      function findAndHighlight(hl) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var fullText = "";
        var nodes = [];

        while (walker.nextNode()) {
          var node = walker.currentNode;
          nodes.push({ node: node, start: fullText.length });
          fullText += node.textContent;
        }

        var searchText = hl.text;
        var idx = -1;

        if (hl.prefix && hl.suffix) {
          var anchorIdx = fullText.indexOf(hl.prefix + searchText + hl.suffix);
          if (anchorIdx >= 0) idx = anchorIdx + hl.prefix.length;
        }
        if (idx < 0 && hl.prefix) {
          var anchorIdx2 = fullText.indexOf(hl.prefix + searchText);
          if (anchorIdx2 >= 0) idx = anchorIdx2 + hl.prefix.length;
        }
        if (idx < 0) {
          idx = fullText.indexOf(searchText);
        }
        if (idx < 0) return;

        var endIdx = idx + searchText.length;

        var startNode = null, endNode = null;
        var startOffset = 0, endOffset = 0;

        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var nEnd = n.start + n.node.textContent.length;
          if (!startNode && nEnd > idx) {
            startNode = n.node;
            startOffset = idx - n.start;
          }
          if (nEnd >= endIdx) {
            endNode = n.node;
            endOffset = endIdx - n.start;
            break;
          }
        }

        if (!startNode || !endNode) return;

        try {
          var range = document.createRange();
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);

          var mark = document.createElement("mark");
          mark.className = "thorium-highlight";
          mark.setAttribute("data-color", hl.color);
          mark.setAttribute("data-annotation-id", hl.id);
          mark.setAttribute("data-has-note", hl.note ? "true" : "false");
          range.surroundContents(mark);

          mark.addEventListener("click", function(e) {
            e.stopPropagation();
            showHighlightTooltip(hl, mark);
          });
        } catch (e) {
          console.log("[Thorium] Could not highlight:", e.message);
        }
      }

      // Cached selection data so mobile taps don't lose it
      var cachedSelection = null;

      function showSelectionToolbar() {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          hideSelectionToolbar();
          return;
        }

        var toolbar = document.getElementById("thorium-sel-toolbar");
        if (!toolbar) return;

        var range = sel.getRangeAt(0);
        var rect = range.getBoundingClientRect();

        // Cache the selection data NOW before mobile clears it on tap
        var selectedText = sel.toString().trim();
        var walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var fullText = "";
        while (walker2.nextNode()) { fullText += walker2.currentNode.textContent; }
        var textIdx = fullText.indexOf(selectedText);
        cachedSelection = {
          selectedText: selectedText,
          prefix: textIdx > 0 ? fullText.substring(Math.max(0, textIdx - 30), textIdx) : "",
          suffix: fullText.substring(textIdx + selectedText.length, textIdx + selectedText.length + 30)
        };

        toolbar.innerHTML = "";
        toolbar.style.display = "flex";
        toolbar.style.left = (rect.left + window.scrollX) + "px";
        toolbar.style.top = (rect.bottom + window.scrollY + 6) + "px";

        colors.forEach(function(color) {
          var dot = document.createElement("span");
          dot.className = "thorium-color-dot";
          dot.style.background = {
            yellow: "#FFEB3B", green: "#4CAF50", blue: "#42A5F5",
            pink: "#EC407A", orange: "#FF9800"
          }[color];
          dot.title = "Highlight " + color;
          dot.addEventListener("pointerdown", function(e) {
            e.preventDefault();
            e.stopPropagation();
            createHighlight(color, false);
          });
          toolbar.appendChild(dot);
        });

        var noteBtn = document.createElement("button");
        noteBtn.textContent = "Note";
        noteBtn.addEventListener("pointerdown", function(e) {
          e.preventDefault();
          e.stopPropagation();
          createHighlight("yellow", true);
        });
        toolbar.appendChild(noteBtn);
      }

      function hideSelectionToolbar() {
        var toolbar = document.getElementById("thorium-sel-toolbar");
        if (toolbar) toolbar.style.display = "none";
      }

      function createHighlight(color, withNote) {
        if (!cachedSelection || !cachedSelection.selectedText) return;

        window.parent.postMessage({
          type: "thorium-create-annotation",
          selectedText: cachedSelection.selectedText,
          prefix: cachedSelection.prefix,
          suffix: cachedSelection.suffix,
          color: color,
          withNote: withNote
        }, "*");

        var sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        cachedSelection = null;
        hideSelectionToolbar();
      }

      function showHighlightTooltip(hl, markEl) {
        var tooltip = document.getElementById("thorium-hl-tooltip");
        if (!tooltip) return;

        var rect = markEl.getBoundingClientRect();
        tooltip.style.display = "block";
        tooltip.style.left = (rect.left + window.scrollX) + "px";
        tooltip.style.top = (rect.bottom + window.scrollY + 4) + "px";

        tooltip.innerHTML = "";

        if (hl.note) {
          var noteEl = document.createElement("div");
          noteEl.className = "hl-note";
          noteEl.textContent = hl.note;
          tooltip.appendChild(noteEl);
        }

        var editBtn = document.createElement("button");
        editBtn.textContent = "Edit Note";
        editBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          window.parent.postMessage({ type: "thorium-edit-annotation", id: hl.id }, "*");
          tooltip.style.display = "none";
        });
        tooltip.appendChild(editBtn);

        var delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          window.parent.postMessage({ type: "thorium-delete-annotation", id: hl.id }, "*");
          tooltip.style.display = "none";
        });
        tooltip.appendChild(delBtn);

        setTimeout(function() {
          document.addEventListener("click", function handler(ev) {
            if (!ev.target.closest("#thorium-hl-tooltip")) {
              tooltip.style.display = "none";
              document.removeEventListener("click", handler);
            }
          });
        }, 10);
      }

      document.addEventListener("mouseup", function() {
        setTimeout(showSelectionToolbar, 50);
      });

      // Touch support for mobile
      document.addEventListener("touchend", function() {
        setTimeout(showSelectionToolbar, 300);
      });

      // Also listen for selectionchange as a fallback (works on mobile)
      var selChangeTimer = null;
      document.addEventListener("selectionchange", function() {
        if (selChangeTimer) clearTimeout(selChangeTimer);
        selChangeTimer = setTimeout(function() {
          var sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim()) {
            showSelectionToolbar();
          }
        }, 400);
      });

      document.addEventListener("mousedown", function(e) {
        if (!e.target.closest("#thorium-sel-toolbar")) {
          hideSelectionToolbar();
        }
        if (!e.target.closest("#thorium-hl-tooltip")) {
          var tooltip = document.getElementById("thorium-hl-tooltip");
          if (tooltip) tooltip.style.display = "none";
        }
      });

      document.addEventListener("touchstart", function(e) {
        if (!e.target.closest("#thorium-sel-toolbar")) {
          hideSelectionToolbar();
        }
        if (!e.target.closest("#thorium-hl-tooltip")) {
          var tooltip = document.getElementById("thorium-hl-tooltip");
          if (tooltip) tooltip.style.display = "none";
        }
      });

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyHighlights);
      } else {
        setTimeout(applyHighlights, 0);
      }
    })();
    `;
  }

  // ─── iframe message handler ───────────────────────────────────

  private messageHandler: ((e: MessageEvent) => void) | null = null;

  private setupIframeListener(): void {
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
    }

    this.messageHandler = async (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "thorium-create-annotation") {
        await this.handleCreateAnnotation(data);
      } else if (data.type === "thorium-edit-annotation") {
        await this.handleEditAnnotation(data.id);
      } else if (data.type === "thorium-delete-annotation") {
        await this.handleDeleteAnnotation(data.id);
      }
    };

    window.addEventListener("message", this.messageHandler);
  }

  private async handleCreateAnnotation(data: {
    selectedText: string;
    prefix: string;
    suffix: string;
    color: string;
    withNote: boolean;
  }): Promise<void> {
    if (!this.epub) return;

    const chapterTitle = this.findTocLabel(this.epub.spine[this.currentChapter]?.href || "")
      || `Chapter ${this.currentChapter + 1}`;

    let note = "";
    if (data.withNote) {
      note = await this.promptForNote("");
    }

    try {
      await this.annotationMgr.createAnnotation({
        bookFile: this.filePath,
        bookTitle: this.epub.metadata.title,
        chapter: this.currentChapter,
        chapterTitle,
        selectedText: data.selectedText,
        prefix: data.prefix,
        suffix: data.suffix,
        color: data.color,
        note,
      });

      new Notice("Highlight saved");
      await this.renderChapter();
    } catch (e) {
      new Notice(`Failed to save highlight: ${(e as Error).message}`);
    }
  }

  private async handleEditAnnotation(id: string): Promise<void> {
    const ann = this.chapterAnnotations.find((a) => a.id === id);
    if (!ann) return;

    const newNote = await this.promptForNote(ann.note);
    try {
      await this.annotationMgr.updateAnnotationNote(ann, newNote);
      new Notice("Note updated");
      await this.renderChapter();
    } catch (e) {
      new Notice(`Failed to update note: ${(e as Error).message}`);
    }
  }

  private async handleDeleteAnnotation(id: string): Promise<void> {
    const ann = this.chapterAnnotations.find((a) => a.id === id);
    if (!ann) return;

    try {
      await this.annotationMgr.deleteAnnotation(ann);
      new Notice("Highlight deleted");
      await this.renderChapter();
    } catch (e) {
      new Notice(`Failed to delete highlight: ${(e as Error).message}`);
    }
  }

  private promptForNote(existingNote: string): Promise<string> {
    return new Promise((resolve) => {
      const modal = new NoteModal(this.app, existingNote, resolve);
      modal.open();
    });
  }

  // ─── Reading Position ─────────────────────────────────────────

  private debounceSavePosition(): void {
    if (this.savePositionTimer) clearTimeout(this.savePositionTimer);
    this.savePositionTimer = setTimeout(() => this.saveReadingPosition(), 1000);
  }

  private doScrollRestore(saved: { anchorText?: string; scrollFraction: number }): void {
    // Try immediately and then with delays for images/fonts loading
    const delays = [0, 200, 500, 1000];
    let restored = false;

    const tryOnce = () => {
      if (restored) return;
      try {
        const doc = this.iframe?.contentDocument;
        if (!doc) return;

        // Try anchor text first
        if (saved.anchorText) {
          const elements = doc.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, div, span");
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i] as HTMLElement;
            const text = (el.textContent || "").trim();
            if (text.length > 10 && text.substring(0, 80) === saved.anchorText) {
              el.scrollIntoView({ block: "start" });
              restored = true;
              return;
            }
          }
          // Partial match
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i] as HTMLElement;
            const text = (el.textContent || "").trim();
            if (text.length > 10 && saved.anchorText.length > 20 &&
                text.includes(saved.anchorText.substring(0, 40))) {
              el.scrollIntoView({ block: "start" });
              restored = true;
              return;
            }
          }
        }

        // Fraction fallback
        if (saved.scrollFraction > 0) {
          const maxScroll = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
          if (maxScroll > 50) {
            doc.documentElement.scrollTop = maxScroll * saved.scrollFraction;
            restored = true;
          }
        }
      } catch { /* ignore */ }
    };

    for (const d of delays) {
      setTimeout(tryOnce, d);
    }
  }

  private saveReadingPosition(): void {
    if (!this.filePath || !this.iframe) return;
    let scrollFraction = 0;
    let anchorText = "";
    try {
      const doc = this.iframe.contentDocument;
      if (doc) {
        const scrollTop = doc.documentElement.scrollTop;
        const maxScroll = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
        scrollFraction = maxScroll > 0 ? scrollTop / maxScroll : 0;

        // Find the first visible text element for robust anchoring
        const elements = doc.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, div");
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          // Element is at or below the top of the viewport
          if (rect.top >= -10 && el.textContent && el.textContent.trim().length > 10) {
            anchorText = el.textContent.trim().substring(0, 80);
            break;
          }
        }
      }
    } catch { /* ignore */ }

    this.plugin.saveReadingPosition(this.filePath, {
      chapter: this.currentChapter,
      scrollFraction,
      anchorText,
    });
  }

  // ─── Resource Resolution ──────────────────────────────────────

  private async resolveResources(html: string, chapterHref: string): Promise<string> {
    if (!this.epub) return html;

    const chapterDir = chapterHref.substring(0, chapterHref.lastIndexOf("/") + 1);

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
      } catch { /* skip */ }
    }

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

  // ─── Navigation & Preferences ─────────────────────────────────

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

  private navigateChapter(delta: number): void {
    if (!this.epub) return;
    this.saveReadingPosition();
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

  // ─── Lifecycle ────────────────────────────────────────────────

  async onClose(): Promise<void> {
    this.saveReadingPosition();
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
    }
    if (this.savePositionTimer) clearTimeout(this.savePositionTimer);
    this.epub = null;
  }

  getState(): Record<string, unknown> {
    return { file: this.filePath, filePath: this.filePath, chapter: this.currentChapter };
  }

  async setState(state: Record<string, unknown>, result?: Record<string, unknown>): Promise<void> {
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
    }

    await super.setState(state, result as any);
  }
}

// ─── Note Entry Modal ─────────────────────────────────────────

class NoteModal extends Modal {
  private note: string;
  private resolve: (note: string) => void;

  constructor(app: App, existingNote: string, resolve: (note: string) => void) {
    super(app);
    this.note = existingNote;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Annotation Note" });

    const textarea = new TextAreaComponent(contentEl);
    textarea.setValue(this.note);
    textarea.inputEl.style.width = "100%";
    textarea.inputEl.style.minHeight = "120px";
    textarea.inputEl.style.marginBottom = "12px";
    textarea.onChange((val) => (this.note = val));

    const btnRow = contentEl.createDiv();
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.justifyContent = "flex-end";

    const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      this.resolve(this.note);
      this.close();
    });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.resolve(this.note);
      this.close();
    });

    setTimeout(() => textarea.inputEl.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
