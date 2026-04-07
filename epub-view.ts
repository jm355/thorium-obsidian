import { ItemView, WorkspaceLeaf, Notice, Modal, App, TextAreaComponent, EventRef } from "obsidian";
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
  private progressFill: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;

  private annotationMgr: AnnotationManager;
  private chapterAnnotations: Annotation[] = [];
  private savePositionTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRestore: { anchorText?: string; scrollFraction: number } | null = null;
  private suppressSave = false;
  private themeChangeRef: EventRef | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ThoriumReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.annotationMgr = new AnnotationManager(this.app, () => plugin.settings.annotationFolder);
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

    // Progress bar
    this.progressBar = container.createDiv({ cls: "thorium-progress-bar" });
    this.progressFill = this.progressBar.createDiv({ cls: "thorium-progress-fill" });

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

    this.themeChangeRef = this.app.workspace.on("css-change", () => {
      if (this.plugin.settings.autoTheme && this.epub) {
        this.captureCurrentPosition();
        this.renderChapter();
      }
    });

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
      const saved = await this.annotationMgr.loadPosition(this.filePath);
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

  private buildProgressTicks(): void {
    if (!this.progressBar || !this.epub) return;
    // Remove old ticks
    this.progressBar.querySelectorAll(".thorium-progress-tick").forEach((el) => el.remove());

    const collect = (items: TocItem[], depth: number): Array<{ pct: number; depth: number }> => {
      const out: Array<{ pct: number; depth: number }> = [];
      for (const item of items) {
        const cleanHref = item.href.split("#")[0];
        const spineIdx = this.epub!.spine.findIndex(
          (s) => s.href === cleanHref || s.href.endsWith(cleanHref)
        );
        if (spineIdx < 0) continue;
        const pct = item.href.includes("#")
          ? (this.epub!.tocPositions.get(item.href) ?? this.epub!.spinePositions[spineIdx])
          : this.epub!.spinePositions[spineIdx];
        out.push({ pct, depth });
        out.push(...collect(item.children, depth + 1));
      }
      return out;
    };

    const ticks = collect(this.epub.toc, 0);
    for (const { pct, depth } of ticks) {
      const tick = this.progressBar.createDiv({ cls: "thorium-progress-tick" });
      tick.style.left = pct + "%";
      tick.dataset.depth = String(depth);
    }
  }

  private updateProgressBar(): void {
    if (!this.progressFill || !this.epub) return;

    let scrollFraction = 0;
    try {
      const doc = this.iframe?.contentDocument;
      if (doc) {
        const scrollTop = doc.documentElement.scrollTop;
        const maxScroll = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
        scrollFraction = maxScroll > 0 ? scrollTop / maxScroll : 0;
      }
    } catch { /* ignore */ }

    const spine = this.epub.spinePositions;
    const currentStart = spine[this.currentChapter] ?? 0;
    const nextStart = (this.currentChapter + 1 < spine.length) ? spine[this.currentChapter + 1] : 100;
    const pct = currentStart + scrollFraction * (nextStart - currentStart);
    this.progressFill.style.width = pct + "%";
  }

  private buildToc(): void {
    if (!this.tocContainer || !this.epub) return;
    this.tocContainer.empty();

    this.tocContainer.createEl("h3", { text: "Table of Contents", cls: "thorium-toc-header" });

    if (this.epub.toc.length === 0) {
      this.epub.spine.forEach((item, idx) => {
        const entry = this.tocContainer!.createEl("div", { cls: "thorium-toc-entry" });
        entry.createSpan({ text: item.href.split("/").pop() || `Chapter ${idx + 1}`, cls: "thorium-toc-label" });
        const pct = this.epub!.spinePositions[idx];
        entry.createSpan({ text: `${pct}%`, cls: "thorium-toc-pos" });
        entry.addEventListener("click", () => {
          this.currentChapter = idx;
          this.forceChapterSave();
          this.renderChapter();
        });
      });
    } else {
      this.renderTocItems(this.epub.toc, this.tocContainer);
    }

    this.buildProgressTicks();
  }

  private renderTocItems(items: TocItem[], parent: HTMLElement): void {
    for (const item of items) {
      const entry = parent.createEl("div", { cls: "thorium-toc-entry" });
      entry.createSpan({ text: item.label, cls: "thorium-toc-label" });

      const cleanHref = item.href.split("#")[0];
      const spineIdx = this.epub!.spine.findIndex(
        (s) => s.href === cleanHref || s.href.endsWith(cleanHref)
      );
      if (spineIdx >= 0) {
        const pct = item.href.includes("#")
          ? (this.epub!.tocPositions.get(item.href) ?? this.epub!.spinePositions[spineIdx])
          : this.epub!.spinePositions[spineIdx];
        entry.createSpan({ text: `${pct}%`, cls: "thorium-toc-pos" });
      }

      entry.addEventListener("click", () => {
        const cleanHref = item.href.split("#")[0];
        const idx = this.epub!.spine.findIndex(
          (s) => s.href === cleanHref || s.href.endsWith(cleanHref)
        );
        if (idx >= 0) {
          this.currentChapter = idx;
          this.forceChapterSave();
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
    const effectiveTheme = this.getEffectiveTheme();
    const isDark = effectiveTheme === "dark";
    const fontSize = this.plugin.settings.fontSize;
    const fontFamily = this.plugin.settings.fontFamily;

    const styleOverride = `
      <style>
        :root {
          --reader-bg: ${isDark ? "#1e1e1e" : effectiveTheme === "sepia" ? "#f4ecd8" : "#ffffff"};
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

    // Capture restore data before clearing
    const restoreData = this.pendingRestore;
    this.pendingRestore = null;

    // Build scroll restore script (runs inside iframe)
    let scrollRestoreScript = "";
    if (restoreData && (restoreData.scrollFraction > 0 || restoreData.anchorText)) {
      const anchorJson = restoreData.anchorText ? JSON.stringify(restoreData.anchorText) : "null";
      const frac = restoreData.scrollFraction;
      scrollRestoreScript = `
        ;(function(){
          var anchor = ${anchorJson};
          var frac = ${frac};
          var done = false;
          function doRestore() {
            if (done) return;
            if (anchor) {
              var els = document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote");
              for (var i = 0; i < els.length; i++) {
                var t = (els[i].textContent || "").trim();
                if (t.length > 10 && t.substring(0, 80) === anchor) {
                  document.documentElement.scrollTop = els[i].offsetTop;
                  window.scrollTo(0, els[i].offsetTop);
                  done = true;
                  return;
                }
              }
              for (var i = 0; i < els.length; i++) {
                var t = (els[i].textContent || "").trim();
                if (t.length > 10 && anchor.length > 20 && t.indexOf(anchor.substring(0, 40)) >= 0) {
                  document.documentElement.scrollTop = els[i].offsetTop;
                  window.scrollTo(0, els[i].offsetTop);
                  done = true;
                  return;
                }
              }
            }
            if (frac > 0) {
              var max = document.documentElement.scrollHeight - document.documentElement.clientHeight;
              if (max > 50) {
                var target = max * frac;
                document.documentElement.scrollTop = target;
                window.scrollTo(0, target);
                done = true;
              }
            }
          }
          setTimeout(doRestore, 100);
          setTimeout(doRestore, 500);
          setTimeout(doRestore, 1200);
          window.addEventListener("load", function(){ setTimeout(doRestore, 200); });
        })();
      `;
    }

    const toolbarHtml = `
      <div id="thorium-sel-toolbar"></div>
      <div id="thorium-hl-tooltip"></div>
      <script>${annotationScript}${scrollRestoreScript}<\/script>
    `;
    if (html.includes("</body>")) {
      html = html.replace("</body>", toolbarHtml + "</body>");
    } else {
      html = html + toolbarHtml;
    }

    this.setupIframeListener();

    // Set onload BEFORE srcdoc to ensure we don't miss the event
    const isRestoring = !!scrollRestoreScript;
    this.iframe.onload = () => {
      if (fragment) {
        try {
          const el = this.iframe?.contentDocument?.getElementById(fragment);
          el?.scrollIntoView();
        } catch { /* ignore */ }
      }

      const attachScrollListener = () => {
        try {
          const iframeDoc = this.iframe?.contentDocument;
          if (iframeDoc) {
            iframeDoc.addEventListener("scroll", () => {
            this.debounceSavePosition();
            this.updateProgressBar();
          });
          }
        } catch { /* ignore */ }
      };

      if (isRestoring) {
        // Suppress saves while restore script runs, then attach listener
        this.suppressSave = true;
        setTimeout(() => {
          this.suppressSave = false;
          attachScrollListener();
        }, 3000);
      } else {
        // No restore — attach listener immediately
        attachScrollListener();
      }
    };

    // Set srcdoc AFTER onload handler is attached
    this.iframe.srcdoc = html;

    if (this.chapterTitle) {
      const tocLabel = this.findTocLabel(spineItem.href);
      this.chapterTitle.textContent = tocLabel ||
        `${this.currentChapter + 1} / ${this.epub.spine.length}`;
    }

    this.updateProgressBar();
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
        } catch {
          // Could not highlight — range may span multiple nodes
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

  /** Capture the current scroll position and set it as pendingRestore for the next renderChapter */
  private captureCurrentPosition(): void {
    if (!this.iframe) return;
    let scrollFraction = 0;
    let anchorText = "";
    try {
      const doc = this.iframe.contentDocument;
      if (doc) {
        const scrollTop = doc.documentElement.scrollTop;
        const maxScroll = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
        scrollFraction = maxScroll > 0 ? scrollTop / maxScroll : 0;

        const elements = doc.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote");
        let bestEl: HTMLElement | null = null;
        let bestDist = Infinity;
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          const text = (el.textContent || "").trim();
          if (text.length > 10 && rect.bottom > 0) {
            const dist = Math.abs(rect.top);
            if (dist < bestDist) {
              bestDist = dist;
              bestEl = el;
            }
          }
        }
        if (bestEl) {
          anchorText = (bestEl.textContent || "").trim().substring(0, 80);
        }
      }
    } catch { /* ignore */ }
    if (scrollFraction > 0 || anchorText) {
      this.lastGoodFraction = scrollFraction;
      this.lastGoodAnchor = anchorText;
    }
    this.pendingRestore = { anchorText: anchorText || this.lastGoodAnchor, scrollFraction: scrollFraction || this.lastGoodFraction };
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
      this.captureCurrentPosition();
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
      this.captureCurrentPosition();
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
      this.captureCurrentPosition();
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
    this.savePositionTimer = setTimeout(() => {
      this.saveReadingPosition().catch((e) => {
        new Notice(`Save failed: ${e}`, 5000);
      });
    }, 1000);
  }

  private savePositionCount = 0;

  private lastGoodFraction = 0;
  private lastGoodAnchor = "";

  private saveReadingPosition(): Promise<void> {
    if (!this.filePath || !this.iframe || this.suppressSave) return Promise.resolve();

    try {
      const doc = this.iframe.contentDocument;
      if (doc) {
        const scrollTop = doc.documentElement.scrollTop;
        const maxScroll = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;

        if (maxScroll > 0 && scrollTop > 0) {
          const scrollFraction = scrollTop / maxScroll;

          // Find anchor text
          let anchorText = "";
          const elements = doc.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote");
          let bestEl: HTMLElement | null = null;
          let bestDist = Infinity;
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i] as HTMLElement;
            const rect = el.getBoundingClientRect();
            const text = (el.textContent || "").trim();
            if (text.length > 10 && rect.bottom > 0) {
              const dist = Math.abs(rect.top);
              if (dist < bestDist) {
                bestDist = dist;
                bestEl = el;
              }
            }
          }
          if (bestEl) {
            anchorText = (bestEl.textContent || "").trim().substring(0, 80);
          }

          // Update cached values
          this.lastGoodFraction = scrollFraction;
          this.lastGoodAnchor = anchorText;

          // Write to file
          return this.annotationMgr.savePosition(this.filePath, {
            chapter: this.currentChapter,
            scrollFraction,
            anchorText,
          });
        }
      }
    } catch { /* ignore */ }

    // Don't write anything if we couldn't read a valid position
    return Promise.resolve();
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
    const next = this.currentChapter + delta;
    if (next >= 0 && next < this.epub.spine.length) {
      this.currentChapter = next;
      // Force-save the new chapter at scroll position 0
      this.forceChapterSave();
      this.renderChapter();
    }
  }

  /** Save current chapter with frac=0 (used after chapter navigation) */
  private forceChapterSave(): void {
    if (!this.filePath) return;
    this.lastGoodFraction = 0;
    this.lastGoodAnchor = "";
    this.annotationMgr.savePosition(this.filePath, {
      chapter: this.currentChapter,
      scrollFraction: 0,
      anchorText: "",
    });
  }

  private currentThemeIdx = 0;
  private readonly themes = ["light", "sepia", "dark"];

  private getEffectiveTheme(): string {
    if (this.plugin.settings.autoTheme) {
      return this.app.isDarkMode() ? "dark" : "light";
    }
    return this.plugin.settings.theme;
  }

  private cycleTheme(): void {
    // Cycling always switches to manual mode
    this.plugin.settings.autoTheme = false;
    this.currentThemeIdx = (this.currentThemeIdx + 1) % this.themes.length;
    this.plugin.settings.theme = this.themes[this.currentThemeIdx];
    this.plugin.saveSettings();
    this.captureCurrentPosition();
    this.renderChapter();
  }

  private adjustFontSize(delta: number): void {
    this.plugin.settings.fontSize = Math.max(
      12,
      Math.min(32, this.plugin.settings.fontSize + delta)
    );
    this.plugin.saveSettings();
    this.captureCurrentPosition();
    this.renderChapter();
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async onClose(): Promise<void> {
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
    }
    if (this.themeChangeRef) {
      this.app.workspace.offref(this.themeChangeRef);
      this.themeChangeRef = null;
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
    textarea.inputEl.addClass("thorium-note-textarea");
    textarea.onChange((val) => (this.note = val));

    const btnRow = contentEl.createDiv({ cls: "thorium-note-buttons" });

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
