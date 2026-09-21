import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPortableAliases } from "./portable-source-aliases.js";
import { computeCuratedTreeDigest } from "./curated-source-acquisition.js";
import { isSafeWindowsPath } from "./platform-filesystem.js";
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
describe("portable source aliases", () => {
  it("preserves the pinned symbolic tree digest while detecting changed copies", async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "cursor-portable-alias-"),
    );
    roots.push(root);
    await fs.promises.mkdir(path.join(root, "assets"));
    await fs.promises.writeFile(
      path.join(root, "assets", "base.svg"),
      "source",
    );
    await createPortableAliases(
      root,
      [{ relative: "assets/arrow.svg", linkTarget: "base.svg" }],
      1024,
    );
    const hash = crypto.createHash("sha256");
    const value = (text) => {
      const bytes = Buffer.from(text);
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(length).update(bytes);
    };
    value("assets/arrow.svg");
    hash.update("l");
    value("base.svg");
    value("assets/base.svg");
    hash.update("f");
    value("source");
    expect(await computeCuratedTreeDigest(root, ["assets"])).toEqual({
      sha256: hash.digest("hex"),
      entries: 2,
    });
    expect(
      (
        await fs.promises.lstat(path.join(root, "assets", "arrow.svg"))
      ).isSymbolicLink(),
    ).toBe(false);
    await fs.promises.writeFile(
      path.join(root, "assets", "arrow.svg"),
      "changed",
    );
    await expect(computeCuratedTreeDigest(root, ["assets"])).rejects.toThrow(
      "differs from its authenticated target",
    );
  });
  it.each([
    "CON.cursor",
    "previews/NUL.png",
    "a:stream",
    "trailing.",
    "trailing ",
    "COM1.txt",
    "LPT2",
  ])("rejects Windows path alias %s", (value) => {
    expect(isSafeWindowsPath(value)).toBe(false);
  });
});
