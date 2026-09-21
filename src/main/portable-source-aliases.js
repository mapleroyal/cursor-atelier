import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isSafeWindowsPath } from "./platform-filesystem.js";
export const PORTABLE_ALIASES_FILE = ".cursor-atelier-aliases.json";
function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    !isSafeWindowsPath(value)
  ) {
    throw new Error("Unsafe portable source alias.");
  }
  return value;
}
function targetFor(relative, target) {
  if (
    typeof target !== "string" ||
    !target ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target.includes(":")
  ) {
    throw new Error("Unsafe portable source alias target.");
  }
  return relativePath(
    path.posix.normalize(path.posix.join(path.posix.dirname(relative), target)),
  );
}
export async function readPortableAliases(root) {
  const filename = path.join(root, PORTABLE_ALIASES_FILE);
  let stat;
  try {
    stat = await fs.promises.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 64 * 1024 * 1024
  ) {
    throw new Error("Unsafe portable source alias metadata.");
  }
  const data = JSON.parse(await fs.promises.readFile(filename, "utf8"));
  if (
    data.schemaVersion !== 1 ||
    !Array.isArray(data.aliases) ||
    data.aliases.length > 75_000
  ) {
    throw new Error("Invalid portable source aliases.");
  }
  const result = new Map();
  for (const row of data.aliases) {
    const relative = relativePath(row.relative);
    if (result.has(relative)) {
      throw new Error("Duplicate portable source alias.");
    }
    targetFor(relative, row.target);
    result.set(relative, row.target);
  }
  return result;
}
async function fileHash(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function equalTrees(left, right, depth = 0) {
  if (depth > 32) {
    throw new Error("Portable source alias exceeds directory limits.");
  }
  const [a, b] = await Promise.all([
    fs.promises.lstat(left),
    fs.promises.lstat(right),
  ]);
  if (a.isSymbolicLink() || b.isSymbolicLink()) {
    return false;
  }
  if (a.isFile() && b.isFile()) {
    return (
      a.size === b.size && (await fileHash(left)) === (await fileHash(right))
    );
  }
  if (!a.isDirectory() || !b.isDirectory()) {
    return false;
  }
  const [namesA, namesB] = await Promise.all([
    fs.promises.readdir(left),
    fs.promises.readdir(right),
  ]);
  namesA.sort();
  namesB.sort();
  if (JSON.stringify(namesA) !== JSON.stringify(namesB)) {
    return false;
  }
  for (const name of namesA) {
    if (
      !(await equalTrees(
        path.join(left, name),
        path.join(right, name),
        depth + 1,
      ))
    ) {
      return false;
    }
  }
  return true;
}
export async function verifyPortableAlias(root, relative, target) {
  const resolved = targetFor(relative, target);
  if (
    !(await equalTrees(
      path.join(root, ...relative.split("/")),
      path.join(root, ...resolved.split("/")),
    ))
  ) {
    throw new Error(
      "A materialized source alias differs from its authenticated target.",
    );
  }
  return resolved;
}
export async function createPortableAliases(
  root,
  records,
  maximumBytes,
  maximumEntries = 75_000,
) {
  const aliases = new Map(
    records.map((row) => [relativePath(row.relative), row.linkTarget]),
  );
  const finished = new Set();
  const visiting = new Set();
  let copiedBytes = 0;
  let copiedEntries = 0;
  async function materialize(relative) {
    if (finished.has(relative)) {
      return;
    }
    if (visiting.has(relative)) {
      throw new Error("Cyclic portable source alias.");
    }
    visiting.add(relative);
    const resolved = targetFor(relative, aliases.get(relative));
    for (const candidate of aliases.keys()) {
      if (candidate === resolved || candidate.startsWith(`${resolved}/`)) {
        await materialize(candidate);
      }
    }
    const source = path.join(root, ...resolved.split("/"));
    const destination = path.join(root, ...relative.split("/"));
    await fs.promises.cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (candidate) => {
        const stat = await fs.promises.lstat(candidate);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          throw new Error("Unsafe materialized alias source.");
        }
        copiedBytes += stat.isFile() ? stat.size : 0;
        copiedEntries += 1;
        if (copiedBytes > maximumBytes || copiedEntries > maximumEntries) {
          throw new Error("Materialized aliases exceed source limits.");
        }
        return true;
      },
    });
    visiting.delete(relative);
    finished.add(relative);
  }
  for (const relative of aliases.keys()) {
    await materialize(relative);
  }
  if (aliases.size) {
    await fs.promises.writeFile(
      path.join(root, PORTABLE_ALIASES_FILE),
      JSON.stringify({
        schemaVersion: 1,
        aliases: [...aliases].map(([relative, target]) => ({
          relative,
          target,
        })),
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
}
