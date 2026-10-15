import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { Attachment } from "../shared/types";
import { MediaPart } from "./providers";

/**
 * User-initiated attachment reading.
 *
 * This is the only filesystem reader in Asgard and it is deliberately not a
 * tool: the agent cannot call it. Main reads exactly the paths the user dropped
 * or pasted, once, and nothing else. Extracted text stays in main -- the
 * renderer only ever receives the `Attachment` descriptors and echoes ids back.
 */
export const LIMITS = {
  files: 40,
  fileBytes: 8 * 1024 * 1024,
  textPerFile: 128 * 1024,
  totalText: 1536 * 1024,
  /** Per-image cap; the providers reject larger single images. */
  imageBytes: 5 * 1024 * 1024,
  /** Combined raw bytes of images and PDFs in one drop. */
  totalMedia: 20 * 1024 * 1024,
  depth: 6,
  zipEntries: 300,
  pending: 200,
};
/** Image types every configured provider can read, by file extension. */
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".DS_Store",
  ".turbo",
  "target",
  "Pods",
]);
const BINARY_EXT = new Set([
  ".bmp",
  ".tiff",
  ".ico",
  ".icns",
  ".heic",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".flac",
  ".ogg",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".wasm",
  ".pyc",
  ".node",
  ".sqlite",
  ".db",
  ".dmg",
  ".7z",
  ".rar",
  ".gz",
  ".bz2",
  ".xz",
  ".tar",
  ".pack",
  ".idx",
]);
/**
 * Reject archive members by path before they are decompressed. Archives stay
 * text-only: an image inside a zip is skipped rather than inlined as media.
 */
const zipEntryWanted = (name: string) => {
  const ext = extname(name).toLowerCase();
  return (
    !name
      .split("/")
      .some((p) => SKIP_DIRS.has(p) || p.startsWith(".") || p === "..") &&
    !BINARY_EXT.has(ext) &&
    !IMAGE_TYPES[ext] &&
    ext !== ".pdf"
  );
};
export interface StoredAttachment extends Attachment {
  text: string;
  /** Present for images and PDFs; sent as a content block on one request. */
  media?: MediaPart;
}
/** Tree paths allow only letters, numbers, - and _, so names are slugified. */
export const slug = (s: string) =>
  (
    s
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file"
  ).toLowerCase();
const looksBinary = (buf: Buffer) => {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return true;
  let odd = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) odd++;
  return head.length > 0 && odd / head.length > 0.15;
};
const skip = (
  name: string,
  label: string,
  bytes: number,
  reason: string,
  kind: Attachment["kind"] = "text",
): StoredAttachment => ({
  id: randomUUID(),
  name,
  label,
  bytes,
  kind,
  included: false,
  reason,
  truncated: false,
  text: "",
});

export class Attachments {
  private pending = new Map<string, StoredAttachment>();
  /** Read dropped absolute paths. Folders are walked; .zip members expanded. */
  read(paths: string[]): Attachment[] {
    const out: StoredAttachment[] = [];
    let budget = LIMITS.totalText;
    let mediaBudget = LIMITS.totalMedia;
    const push = (a: StoredAttachment) => {
      if (out.length >= LIMITS.files) return false;
      if (a.included && a.media) {
        if (a.bytes > mediaBudget) {
          out.push(
            skip(
              a.name,
              a.label,
              a.bytes,
              "Skipped: the drop exceeded the total attachment budget.",
              a.kind,
            ),
          );
          return true;
        }
        mediaBudget -= a.bytes;
      }
      if (a.included && !a.media) {
        if (a.text.length > budget) {
          a.text = a.text.slice(0, Math.max(0, budget));
          a.truncated = true;
          if (!a.text) {
            a.included = false;
            a.reason = "Skipped: the drop exceeded the total text budget.";
          }
        }
        budget -= a.text.length;
      }
      out.push(a);
      return true;
    };
    const file = (path: string, label: string): StoredAttachment => {
      const name = basename(path);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        return skip(name, label, 0, "Skipped: could not be read.");
      }
      if (stat.isSymbolicLink())
        return skip(name, label, 0, "Skipped: symbolic link.");
      if (stat.size > LIMITS.fileBytes)
        return skip(
          name,
          label,
          stat.size,
          `Skipped: larger than ${Math.round(LIMITS.fileBytes / 1024 / 1024)} MB.`,
        );
      const ext = extname(name).toLowerCase();
      if (BINARY_EXT.has(ext))
        return skip(name, label, stat.size, "Skipped: binary file type.");
      const image = IMAGE_TYPES[ext];
      if (image && stat.size > LIMITS.imageBytes)
        return skip(
          name,
          label,
          stat.size,
          `Skipped: images must be under ${Math.round(LIMITS.imageBytes / 1024 / 1024)} MB.`,
          "image",
        );
      let buf: Buffer;
      try {
        buf = readFileSync(path);
      } catch {
        return skip(
          name,
          label,
          stat.size,
          "Skipped: could not be read.",
          image ? "image" : ext === ".pdf" ? "pdf" : "text",
        );
      }
      if (image || ext === ".pdf")
        return this.fromMedia(name, label, buf, image ?? "application/pdf");
      return this.fromBuffer(name, label, buf);
    };
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > LIMITS.depth || out.length >= LIMITS.files) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        push(skip(basename(dir), prefix, 0, "Skipped: folder is unreadable."));
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= LIMITS.files) return;
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const child = join(dir, e.name);
        const label = prefix + "/" + e.name;
        if (e.isDirectory()) walk(child, label, depth + 1);
        else if (e.isFile()) {
          if (extname(e.name).toLowerCase() === ".zip")
            this.zip(child, label, push);
          else push(file(child, label));
        }
      }
    };
    for (const path of paths.slice(0, LIMITS.files)) {
      if (out.length >= LIMITS.files) break;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        push(skip(basename(path), basename(path), 0, "Skipped: not found."));
        continue;
      }
      if (stat.isSymbolicLink()) {
        push(
          skip(basename(path), basename(path), 0, "Skipped: symbolic link."),
        );
        continue;
      }
      if (stat.isDirectory()) walk(path, basename(path), 1);
      else if (extname(path).toLowerCase() === ".zip")
        this.zip(path, basename(path), push);
      else push(file(path, basename(path)));
    }
    for (const a of out) this.pending.set(a.id, a);
    // Dropped-but-never-sent attachments would otherwise accumulate for the
    // lifetime of the process; evict the oldest beyond the cap (Map preserves
    // insertion order).
    while (this.pending.size > LIMITS.pending)
      this.pending.delete(this.pending.keys().next().value as string);
    return out.map(({ text: _text, media: _media, ...d }) => d);
  }
  /**
   * An image or PDF becomes a provider content block rather than text. The
   * bytes stay in main like every other attachment: the renderer receives the
   * descriptor only.
   */
  private fromMedia(
    name: string,
    label: string,
    buf: Buffer,
    mediaType: string,
  ): StoredAttachment {
    const kind: Attachment["kind"] =
      mediaType === "application/pdf" ? "pdf" : "image";
    if (!buf.length) return skip(name, label, 0, "Skipped: empty file.", kind);
    if (kind === "pdf" && buf.subarray(0, 5).toString("latin1") !== "%PDF-")
      return skip(name, label, buf.length, "Skipped: not a PDF.", kind);
    return {
      id: randomUUID(),
      name,
      label,
      bytes: buf.length,
      kind,
      included: true,
      truncated: false,
      text: "",
      media: {
        kind,
        mediaType,
        data: buf.toString("base64"),
        label,
      },
    };
  }
  private fromBuffer(
    name: string,
    label: string,
    buf: Buffer,
  ): StoredAttachment {
    if (looksBinary(buf))
      return skip(name, label, buf.length, "Skipped: not text.");
    let text = buf.toString("utf8");
    let truncated = false;
    if (text.length > LIMITS.textPerFile) {
      text = text.slice(0, LIMITS.textPerFile);
      truncated = true;
    }
    if (!text.trim())
      return skip(name, label, buf.length, "Skipped: empty file.");
    return {
      id: randomUUID(),
      name,
      label,
      bytes: buf.length,
      kind: "text",
      included: true,
      truncated,
      text,
    };
  }
  /** Expand a .zip. Entry count and uncompressed size are both capped. */
  private zip(
    path: string,
    label: string,
    push: (a: StoredAttachment) => boolean,
  ) {
    let entries: { name: string; buf: Buffer }[] = [];
    try {
      const raw = readFileSync(path);
      if (raw.length > LIMITS.fileBytes) {
        push(
          skip(
            basename(path),
            label,
            raw.length,
            `Skipped: archive larger than ${Math.round(LIMITS.fileBytes / 1024 / 1024)} MB.`,
          ),
        );
        return;
      }
      entries = unzipSync(raw, zipEntryWanted);
    } catch {
      push(
        skip(basename(path), label, 0, "Skipped: archive could not be read."),
      );
      return;
    }
    if (!entries.length)
      push(
        skip(basename(path), label, 0, "Skipped: archive has no text files."),
      );
    for (const e of entries)
      if (!push(this.fromBuffer(basename(e.name), label + "/" + e.name, e.buf)))
        return;
  }
  take(ids: string[]): StoredAttachment[] {
    const found: StoredAttachment[] = [];
    for (const id of ids) {
      const a = this.pending.get(id);
      if (a) {
        found.push(a);
        this.pending.delete(id);
      }
    }
    return found;
  }
  release(ids: string[]) {
    for (const id of ids) this.pending.delete(id);
  }
  get size() {
    return this.pending.size;
  }
}

/**
 * Minimal synchronous zip reader: walks the central directory and inflates
 * stored/deflated entries. Keeps the IPC path synchronous and caps every
 * entry's uncompressed size, so a crafted archive cannot exhaust memory.
 */
export function unzipSync(
  raw: Buffer,
  want: (name: string) => boolean = () => true,
): { name: string; buf: Buffer }[] {
  const out: { name: string; buf: Buffer }[] = [];
  let eocd = -1;
  for (let i = raw.length - 22; i >= 0 && i >= raw.length - 66000; i--)
    if (raw.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("Not a zip archive.");
  const total = raw.readUInt16LE(eocd + 10);
  let p = raw.readUInt32LE(eocd + 16);
  for (let n = 0; n < Math.min(total, LIMITS.zipEntries); n++) {
    if (p + 46 > raw.length || raw.readUInt32LE(p) !== 0x02014b50) break;
    const method = raw.readUInt16LE(p + 10);
    const compressed = raw.readUInt32LE(p + 20);
    const uncompressed = raw.readUInt32LE(p + 24);
    const nameLen = raw.readUInt16LE(p + 28);
    const extraLen = raw.readUInt16LE(p + 30);
    const commentLen = raw.readUInt16LE(p + 32);
    const offset = raw.readUInt32LE(p + 42);
    const name = raw.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || uncompressed === 0) continue;
    if (uncompressed > LIMITS.textPerFile * 8) continue;
    if (!want(name)) continue;
    if (offset + 30 > raw.length || raw.readUInt32LE(offset) !== 0x04034b50)
      continue;
    const lnLen = raw.readUInt16LE(offset + 26);
    const lxLen = raw.readUInt16LE(offset + 28);
    const start = offset + 30 + lnLen + lxLen;
    const body = raw.subarray(start, start + compressed);
    try {
      if (method === 0) out.push({ name, buf: Buffer.from(body) });
      else if (method === 8)
        out.push({
          name,
          buf: inflateRawSync(body, { maxOutputLength: uncompressed }),
        });
    } catch {
      /* unsupported compression or corrupt entry: skip it */
    }
  }
  return out;
}
