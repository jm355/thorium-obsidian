import JSZip from "jszip";

export interface EpubMetadata {
  title: string;
  author: string;
  language: string;
  identifier: string;
  description: string;
}

export interface SpineItem {
  id: string;
  href: string;
  mediaType: string;
}

export interface TocItem {
  label: string;
  href: string;
  children: TocItem[];
}

export interface ParsedEpub {
  metadata: EpubMetadata;
  spine: SpineItem[];
  /** Cumulative position (0–100) at the start of each spine item, by file-size weight */
  spinePositions: number[];
  /** Position (0–100) for TOC hrefs that include a fragment, keyed by full href */
  tocPositions: Map<string, number>;
  toc: TocItem[];
  zip: JSZip;
  basePath: string;
}

export async function parseEpub(data: ArrayBuffer): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(data);

  // 1. Read container.xml to find the OPF path
  const containerXml = await zip.file("META-INF/container.xml")?.async("text");
  if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");

  const containerDoc = new DOMParser().parseFromString(containerXml, "application/xml");
  const rootfileEl = containerDoc.querySelector("rootfile");
  const opfPath = rootfileEl?.getAttribute("full-path");
  if (!opfPath) throw new Error("Invalid EPUB: no rootfile path");

  const basePath = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

  // 2. Parse the OPF
  const opfXml = await zip.file(opfPath)?.async("text");
  if (!opfXml) throw new Error("Invalid EPUB: missing OPF file");

  const opfDoc = new DOMParser().parseFromString(opfXml, "application/xml");

  // Metadata
  const getMeta = (tag: string): string => {
    const el =
      opfDoc.querySelector(`metadata > ${tag}`) ||
      opfDoc.querySelector(`metadata > *|${tag}`) ||
      opfDoc.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", tag)[0];
    return el?.textContent?.trim() || "";
  };

  const metadata: EpubMetadata = {
    title: getMeta("title") || "Untitled",
    author: getMeta("creator") || getMeta("author") || "Unknown",
    language: getMeta("language") || "en",
    identifier: getMeta("identifier") || "",
    description: getMeta("description") || "",
  };

  // Manifest items
  const manifestItems = new Map<string, { href: string; mediaType: string }>();
  opfDoc.querySelectorAll("manifest > item").forEach((item) => {
    const id = item.getAttribute("id") || "";
    const href = item.getAttribute("href") || "";
    const mediaType = item.getAttribute("media-type") || "";
    manifestItems.set(id, { href, mediaType });
  });

  // Spine
  const spine: SpineItem[] = [];
  opfDoc.querySelectorAll("spine > itemref").forEach((itemref) => {
    const idref = itemref.getAttribute("idref") || "";
    const manifestItem = manifestItems.get(idref);
    if (manifestItem) {
      spine.push({
        id: idref,
        href: manifestItem.href,
        mediaType: manifestItem.mediaType,
      });
    }
  });

  // 3. Parse TOC (try EPUB3 nav, fallback to NCX)
  const toc = await parseToc(zip, opfDoc, basePath, manifestItems);

  // 4. Compute file-size-weighted spine positions (0–100 scale)
  const spineSizes = spine.map((item) => {
    const file = zip.file(basePath + item.href);
    // Access JSZip's internal metadata for uncompressed size without decompressing
    const data = (file as any)?._data;
    return (data?.uncompressedSize as number) || 0;
  });
  const totalSize = spineSizes.reduce((a, b) => a + b, 0) || 1;
  let cumulative = 0;
  const spinePositions = spineSizes.map((size) => {
    const pos = Math.round((cumulative / totalSize) * 100);
    cumulative += size;
    return pos;
  });

  // 5. Compute fragment-level positions for TOC subsections
  const tocPositions = await computeTocPositions(toc, spine, spinePositions, zip, basePath);

  return { metadata, spine, spinePositions, tocPositions, toc, zip, basePath };
}

async function parseToc(
  zip: JSZip,
  opfDoc: Document,
  basePath: string,
  manifestItems: Map<string, { href: string; mediaType: string }>
): Promise<TocItem[]> {
  // Try EPUB3 nav document
  const navItem = Array.from(manifestItems.entries()).find(
    ([, v]) => v.mediaType === "application/xhtml+xml"
  );

  // Look for nav property
  for (const item of opfDoc.querySelectorAll("manifest > item")) {
    const props = item.getAttribute("properties") || "";
    if (props.includes("nav")) {
      const href = item.getAttribute("href") || "";
      const navXml = await zip.file(basePath + href)?.async("text");
      if (navXml) {
        const navDoc = new DOMParser().parseFromString(navXml, "application/xhtml+xml");
        const tocNav = navDoc.querySelector('nav[epub\\:type="toc"], nav[*|type="toc"], nav');
        if (tocNav) {
          return parseNavOl(tocNav.querySelector("ol"));
        }
      }
    }
  }

  // Fallback: NCX
  const ncxId = opfDoc.querySelector("spine")?.getAttribute("toc");
  if (ncxId) {
    const ncxItem = manifestItems.get(ncxId);
    if (ncxItem) {
      const ncxXml = await zip.file(basePath + ncxItem.href)?.async("text");
      if (ncxXml) {
        const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
        return parseNcxNavPoints(ncxDoc.querySelector("navMap"));
      }
    }
  }

  return [];
}

function parseNavOl(ol: Element | null): TocItem[] {
  if (!ol) return [];
  const items: TocItem[] = [];
  for (const li of ol.querySelectorAll(":scope > li")) {
    const a = li.querySelector(":scope > a");
    if (a) {
      items.push({
        label: a.textContent?.trim() || "",
        href: a.getAttribute("href") || "",
        children: parseNavOl(li.querySelector(":scope > ol")),
      });
    }
  }
  return items;
}

function parseNcxNavPoints(navMap: Element | null): TocItem[] {
  if (!navMap) return [];
  const items: TocItem[] = [];
  for (const np of navMap.querySelectorAll(":scope > navPoint")) {
    const label = np.querySelector("navLabel > text")?.textContent?.trim() || "";
    const href = np.querySelector("content")?.getAttribute("src") || "";
    items.push({
      label,
      href,
      children: parseNcxNavPoints(np),
    });
  }
  return items;
}

export async function getChapterContent(
  epub: ParsedEpub,
  href: string
): Promise<string> {
  // Strip fragment
  const cleanHref = href.split("#")[0];
  const fullPath = epub.basePath + cleanHref;
  const file = epub.zip.file(fullPath);
  if (!file) return `<p>Chapter not found: ${fullPath}</p>`;
  return await file.async("text");
}

export async function getResourceAsDataUrl(
  epub: ParsedEpub,
  path: string
): Promise<string> {
  // Resolve path relative to basePath
  const fullPath = resolvePath(epub.basePath, path);
  const file = epub.zip.file(fullPath);
  if (!file) return "";

  const data = await file.async("base64");
  const ext = fullPath.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    css: "text/css",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  const mime = mimeMap[ext] || "application/octet-stream";
  return `data:${mime};base64,${data}`;
}

/** Collect all hrefs that contain a fragment from the TOC tree */
function collectFragmentHrefs(items: TocItem[]): string[] {
  const hrefs: string[] = [];
  for (const item of items) {
    if (item.href.includes("#")) hrefs.push(item.href);
    if (item.children.length > 0) hrefs.push(...collectFragmentHrefs(item.children));
  }
  return hrefs;
}

/**
 * For TOC items with fragment hrefs (e.g. chapter3.html#section2), read the
 * chapter HTML and measure how far into the file the fragment ID appears.
 * Interpolates between the chapter's spine position and the next chapter's
 * spine position to produce a 0–100 book position.
 */
async function computeTocPositions(
  toc: TocItem[],
  spine: SpineItem[],
  spinePositions: number[],
  zip: JSZip,
  basePath: string
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  const fragmentHrefs = collectFragmentHrefs(toc);
  if (fragmentHrefs.length === 0) return result;

  // Group fragments by chapter file so we read each file at most once
  const byChapter = new Map<string, string[]>(); // chapterHref → [fragmentId, ...]
  for (const href of fragmentHrefs) {
    const [chapterHref, fragment] = href.split("#");
    if (!byChapter.has(chapterHref)) byChapter.set(chapterHref, []);
    byChapter.get(chapterHref)!.push(fragment);
  }

  for (const [chapterHref, fragments] of byChapter) {
    const spineIdx = spine.findIndex(
      (s) => s.href === chapterHref || s.href.endsWith(chapterHref)
    );
    if (spineIdx < 0) continue;

    const file = zip.file(basePath + chapterHref);
    if (!file) continue;

    const content = await file.async("text");
    const contentLen = content.length || 1;

    const chapterStart = spinePositions[spineIdx];
    const chapterEnd = spineIdx + 1 < spinePositions.length ? spinePositions[spineIdx + 1] : 100;
    const chapterSpan = chapterEnd - chapterStart;

    for (const fragment of fragments) {
      // Match id="fragment" or name="fragment" (case-insensitive)
      const pattern = new RegExp(`(?:id|name)=["']${fragment}["']`, "i");
      const match = content.search(pattern);
      const fraction = match >= 0 ? match / contentLen : 0;
      const pct = Math.round(chapterStart + chapterSpan * fraction);
      result.set(`${chapterHref}#${fragment}`, pct);
    }
  }

  return result;
}

function resolvePath(base: string, relative: string): string {
  if (relative.startsWith("/")) return relative.substring(1);
  const parts = (base + relative).split("/");
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === "..") resolved.pop();
    else if (p !== "." && p !== "") resolved.push(p);
  }
  return resolved.join("/");
}
