import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAppDataArchive,
  extractAppDataArchive,
} from "./app-data-archive.js";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-atelier-data-archive-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function validateLibrary(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("invalid library");
  }
  return { packCount: 0, identifiers: [] };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("app data archive", () => {
  it("creates, verifies, and extracts the bounded portable format", async () => {
    const root = temporaryDirectory();
    const library = path.join(root, "ImportedPacks");
    const destination = path.join(root, "backup.cursoratelier");
    fs.mkdirSync(library, { mode: 0o700 });
    const representativePack = path.join(
      library,
      "ExamplePack",
      "previews",
      "Arrow",
    );
    fs.mkdirSync(representativePack, { recursive: true, mode: 0o700 });
    const representativeBytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    fs.writeFileSync(
      path.join(representativePack, "preview.png"),
      representativeBytes,
      { mode: 0o600 },
    );
    const document = {
      schemaVersion: 1,
      product: "Cursor Atelier",
      value: "portable",
    };
    const canonicalDestination = path.join(
      fs.realpathSync(path.dirname(destination)),
      path.basename(destination),
    );

    await expect(
      createAppDataArchive({
        destination,
        importedPacksRoot: library,
        document,
        validateImportedPacksRoot: validateLibrary,
        temporaryRoot: root,
      }),
    ).resolves.toBe(canonicalDestination);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);

    const extracted = await extractAppDataArchive({
      archivePath: destination,
      stagingRoot: root,
      validateImportedPacksRoot: validateLibrary,
    });
    expect(extracted.document).toEqual(document);
    expect(extracted.library).toEqual({ packCount: 0, identifiers: [] });
    expect(fs.statSync(extracted.importedPacksRoot).isDirectory()).toBe(true);
    expect(
      fs.readFileSync(
        path.join(
          extracted.importedPacksRoot,
          "ExamplePack",
          "previews",
          "Arrow",
          "preview.png",
        ),
      ),
    ).toEqual(representativeBytes);
    await extracted.cleanup();
    expect(fs.existsSync(extracted.stage)).toBe(false);
  });

  it("rejects links before extracting archive content", async () => {
    const root = temporaryDirectory();
    const source = path.join(root, "source");
    const archivePath = path.join(root, "malicious.cursoratelier");
    fs.mkdirSync(path.join(source, "ImportedPacks"), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(path.join(source, "manifest.json"), "{}", {
      mode: 0o600,
    });
    fs.symlinkSync("manifest.json", path.join(source, "ImportedPacks", "link"));
    await tar.c({ cwd: source, file: archivePath, gzip: true }, [
      "manifest.json",
      "ImportedPacks",
    ]);

    await expect(
      extractAppDataArchive({
        archivePath,
        stagingRoot: root,
        validateImportedPacksRoot: validateLibrary,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DATA_ARCHIVE" });
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith(".data-import-")),
    ).toEqual([]);
  });

  it("does not replace an existing export when validation fails", async () => {
    const root = temporaryDirectory();
    const library = path.join(root, "ImportedPacks");
    const destination = path.join(root, "backup.cursoratelier");
    fs.mkdirSync(library, { mode: 0o700 });
    fs.writeFileSync(destination, "prior");

    await expect(
      createAppDataArchive({
        destination,
        importedPacksRoot: library,
        document: {},
        validateImportedPacksRoot: () => {
          throw new Error("invalid library");
        },
        temporaryRoot: root,
      }),
    ).rejects.toThrow("invalid library");
    expect(fs.readFileSync(destination, "utf8")).toBe("prior");
  });

  it("refuses to export inside the live cursor library", async () => {
    const root = temporaryDirectory();
    const library = path.join(root, "ImportedPacks");
    const destination = path.join(library, "backup.cursoratelier");
    fs.mkdirSync(library, { mode: 0o700 });

    await expect(
      createAppDataArchive({
        destination,
        importedPacksRoot: library,
        document: {},
        validateImportedPacksRoot: validateLibrary,
        temporaryRoot: root,
      }),
    ).rejects.toMatchObject({ code: "INVALID_EXPORT_PATH" });
    expect(fs.existsSync(destination)).toBe(false);
  });
});
