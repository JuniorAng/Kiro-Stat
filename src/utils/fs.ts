import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";

export type ScanLimits = {
  maxFiles: number;
  maxDepth: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  preferNewest?: boolean;
  accept?: (name: string) => boolean;
};

export type ScanResult = {
  files: string[];
  skippedFiles: number;
  totalBytes: number;
  limited: boolean;
};

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFiles: 20_000,
  maxDepth: 10,
  maxTotalBytes: 250 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024
};

export async function listFilesBounded(root: string, limits: Partial<ScanLimits> = {}): Promise<ScanResult> {
  const resolved = { ...DEFAULT_SCAN_LIMITS, ...limits };
  const result: ScanResult = { files: [], skippedFiles: 0, totalBytes: 0, limited: false };
  const candidates: { path: string; size: number; mtimeMs: number }[] = [];
  const stack = [{ directory: root, depth: 0 }];

  // First pass: collect every candidate file (metadata only — never read contents here).
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > resolved.maxDepth) {
      result.limited = true;
      continue;
    }
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) {
        result.skippedFiles += 1;
      } else if (entry.isDirectory()) {
        stack.push({ directory: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        if (resolved.accept && !resolved.accept(entry.name)) {
          continue;
        }
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > resolved.maxFileBytes) {
            result.skippedFiles += 1;
            result.limited = true;
            continue;
          }
          candidates.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          result.skippedFiles += 1;
        }
      }
    }
  }

  if (resolved.preferNewest) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // Second pass: take files in the chosen order until a cap would be exceeded.
  for (const candidate of candidates) {
    if (result.files.length >= resolved.maxFiles || result.totalBytes + candidate.size > resolved.maxTotalBytes) {
      result.skippedFiles += 1;
      result.limited = true;
      continue;
    }
    result.files.push(candidate.path);
    result.totalBytes += candidate.size;
  }

  return result;
}
