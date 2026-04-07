import { App, TFolder, TFile, normalizePath } from "obsidian";

export interface Annotation {
  id: string;
  bookFile: string;
  bookTitle: string;
  chapter: number;
  chapterTitle: string;
  selectedText: string;
  prefix: string;   // ~30 chars before selection for anchoring
  suffix: string;   // ~30 chars after selection for anchoring
  color: string;
  note: string;
  created: string;  // ISO 8601
  filePath: string; // path of the .md file in vault
}

export interface ReadingPosition {
  chapter: number;
  scrollFraction: number; // 0-1
  anchorText?: string;
}

const ANNOTATION_FOLDER = "epub-annotations";
const POSITION_FILENAME = "_reading-position.md";

export class AnnotationManager {
  app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** Get the folder name for a given book (based on epub filename without extension) */
  private bookFolderName(bookFile: string): string {
    const basename = bookFile.split("/").pop() || bookFile;
    return basename.replace(/\.epub$/i, "");
  }

  private bookFolderPath(bookFile: string): string {
    return normalizePath(`${ANNOTATION_FOLDER}/${this.bookFolderName(bookFile)}`);
  }

  /** Ensure the annotation folder exists */
  private async ensureFolder(path: string): Promise<void> {
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!existing) {
        await this.app.vault.createFolder(path);
      }
    } catch {
      // Folder might already exist despite cache miss
    }
  }

  // ─── Reading Position ─────────────────────────────────────────

  /** Save reading position to a markdown file */
  async savePosition(bookFile: string, pos: ReadingPosition): Promise<void> {
    const folderPath = this.bookFolderPath(bookFile);
    await this.ensureFolder(normalizePath(ANNOTATION_FOLDER));
    await this.ensureFolder(folderPath);

    const filePath = normalizePath(`${folderPath}/${POSITION_FILENAME}`);
    const content = [
      "---",
      `bookFile: "${bookFile}"`,
      `chapter: ${pos.chapter}`,
      `scrollFraction: ${pos.scrollFraction}`,
      `anchorText: "${(pos.anchorText || "").replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      `updated: "${new Date().toISOString()}"`,
      "---",
      "",
      "This file tracks your reading position. It is managed automatically by the Thorium EPUB Reader plugin.",
      "",
    ].join("\n");

    try {
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing && existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        if (existing) {
          await this.app.vault.delete(existing);
        }
        await this.app.vault.create(filePath, content);
      }
    } catch (e) {
      try {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file && file instanceof TFile) {
          await this.app.vault.modify(file, content);
        }
      } catch (e2) {
        throw new Error(`Position save failed: ${e}, retry: ${e2}`);
      }
    }
  }

  /** Load reading position from the markdown file */
  async loadPosition(bookFile: string): Promise<ReadingPosition | null> {
    const folderPath = this.bookFolderPath(bookFile);
    const filePath = normalizePath(`${folderPath}/${POSITION_FILENAME}`);

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return null;

    try {
      const content = await this.app.vault.read(file);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;

      const fm = fmMatch[1];
      const get = (key: string): string => {
        const m = fm.match(new RegExp(`^${key}:\\s*"(.*?)"\\s*$`, "m"));
        return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") : "";
      };
      const getNum = (key: string): number => {
        const m = fm.match(new RegExp(`^${key}:\\s*([\\d.]+)`, "m"));
        return m ? parseFloat(m[1]) : 0;
      };

      return {
        chapter: getNum("chapter"),
        scrollFraction: getNum("scrollFraction"),
        anchorText: get("anchorText") || undefined,
      };
    } catch {
      return null;
    }
  }

  /** Generate a unique annotation filename */
  private annotationFileName(ann: Omit<Annotation, "id" | "filePath">): string {
    const date = new Date(ann.created);
    const ts = date.toISOString().replace(/[:.]/g, "-").replace("T", "_").substring(0, 19);
    const slug = ann.selectedText.substring(0, 30).replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
    return `ch${ann.chapter}_${ts}_${slug}.md`;
  }

  /** Create a new annotation and save it as a markdown file */
  async createAnnotation(params: {
    bookFile: string;
    bookTitle: string;
    chapter: number;
    chapterTitle: string;
    selectedText: string;
    prefix: string;
    suffix: string;
    color: string;
    note: string;
  }): Promise<Annotation> {
    const created = new Date().toISOString();
    const folderPath = this.bookFolderPath(params.bookFile);
    await this.ensureFolder(normalizePath(ANNOTATION_FOLDER));
    await this.ensureFolder(folderPath);

    const fileName = this.annotationFileName({ ...params, created });
    const filePath = normalizePath(`${folderPath}/${fileName}`);
    const id = filePath;

    const frontmatter = [
      "---",
      `book: "${params.bookTitle}"`,
      `bookFile: "${params.bookFile}"`,
      `chapter: ${params.chapter}`,
      `chapterTitle: "${params.chapterTitle.replace(/"/g, '\\"')}"`,
      `color: "${params.color}"`,
      `created: "${created}"`,
      `selectedText: "${params.selectedText.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      `prefix: "${params.prefix.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      `suffix: "${params.suffix.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      "---",
      "",
    ].join("\n");

    const quote = `> ${params.selectedText.split("\n").join("\n> ")}\n`;
    const body = params.note ? `\n${quote}\n${params.note}\n` : `\n${quote}\n`;

    await this.app.vault.create(filePath, frontmatter + body);

    return {
      id,
      filePath,
      created,
      ...params,
    };
  }

  /** Load all annotations for a given book */
  async loadAnnotations(bookFile: string): Promise<Annotation[]> {
    const folderPath = this.bookFolderPath(bookFile);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) return [];

    const annotations: Annotation[] = [];

    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      if (child.name === "_reading-position.md") continue;

      try {
        const content = await this.app.vault.read(child);
        const ann = this.parseAnnotationFile(child.path, content);
        if (ann && ann.bookFile === bookFile) {
          annotations.push(ann);
        }
      } catch {
        // skip unparseable files
      }
    }

    return annotations;
  }

  /** Load annotations for a specific chapter */
  async loadChapterAnnotations(bookFile: string, chapter: number): Promise<Annotation[]> {
    const all = await this.loadAnnotations(bookFile);
    return all.filter((a) => a.chapter === chapter);
  }

  /** Parse a markdown annotation file back into an Annotation */
  private parseAnnotationFile(filePath: string, content: string): Annotation | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m"));
      return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") : "";
    };
    const getNum = (key: string): number => {
      const m = fm.match(new RegExp(`^${key}:\\s*(\\d+)`, "m"));
      return m ? parseInt(m[1], 10) : 0;
    };

    // Extract note: everything after frontmatter, skip the blockquote
    const afterFm = content.substring(fmMatch[0].length).trim();
    const lines = afterFm.split("\n");
    const noteLines: string[] = [];
    let pastQuote = false;
    for (const line of lines) {
      if (!pastQuote && line.startsWith(">")) continue;
      if (!pastQuote && line.trim() === "") {
        pastQuote = true;
        continue;
      }
      pastQuote = true;
      noteLines.push(line);
    }
    const note = noteLines.join("\n").trim();

    return {
      id: filePath,
      filePath,
      bookFile: get("bookFile"),
      bookTitle: get("book"),
      chapter: getNum("chapter"),
      chapterTitle: get("chapterTitle"),
      selectedText: get("selectedText"),
      prefix: get("prefix"),
      suffix: get("suffix"),
      color: get("color") || "yellow",
      note,
      created: get("created"),
    };
  }

  /** Update the note text of an existing annotation */
  async updateAnnotationNote(annotation: Annotation, newNote: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
    if (!file || !(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
    if (!fmMatch) return;

    const quote = `> ${annotation.selectedText.split("\n").join("\n> ")}`;
    const newContent = fmMatch[0] + "\n\n" + quote + "\n\n" + (newNote || "") + "\n";

    await this.app.vault.modify(file, newContent);
    annotation.note = newNote;
  }

  /** Delete an annotation and its file */
  async deleteAnnotation(annotation: Annotation): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
    if (file && file instanceof TFile) {
      await this.app.vault.delete(file);
    }

    // Clean up empty folder
    const folderPath = this.bookFolderPath(annotation.bookFile);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder && folder instanceof TFolder && folder.children.length === 0) {
      await this.app.vault.delete(folder);
    }
  }
}
