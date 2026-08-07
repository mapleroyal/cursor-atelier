import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assignImportedCursorFamily,
  createCursorImportStaging,
  installImportedArtifacts,
  removeImportedCursorArtifacts,
  removeCursorImportStaging,
} from "./cursor-import-install";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-install-test-"));
  roots.push(root);
  const store = path.join(root, "ImportedPacks");
  fs.mkdirSync(store, { mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(store, ".import-"));
  const directory = path.join(staging, "Example-a1b2c3d4e5f6");
  const previewDirectory = path.join(directory, "previews", "Example");
  fs.mkdirSync(previewDirectory, { recursive: true });
  const cursor = Buffer.from("valid cursor fixture");
  fs.writeFileSync(path.join(directory, "Example.cursor"), cursor);
  const preview = "previews/Example/default.png";
  fs.writeFileSync(
    path.join(previewDirectory, "default.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      roleCount: 47,
      themes: [
        {
          Identifier: "Example",
          DisplayName: "Example",
          Resource: "Example.cursor",
          SHA256: crypto.createHash("sha256").update(cursor).digest("hex"),
          UUID: "193513CE-4C25-5E1A-9E28-878E5850BB6E",
          ThemeName: "Example",
          Group: "Imported",
          preview,
          rolePreviews: Array.from({ length: 47 }, () => ({
            asset: preview,
          })),
        },
      ],
    }),
  );
  return {
    store,
    staging,
    artifact: { directory },
    destination: path.join(store, path.basename(directory)),
  };
}

function copyArtifactWithIdentifier(source, directory, identifier) {
  fs.cpSync(source, directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const [theme] = manifest.themes;
  const previousIdentifier = theme.Identifier;
  const previousPreviewPrefix = `previews/${previousIdentifier}/`;
  const nextPreviewPrefix = `previews/${identifier}/`;
  const previousPreviewDirectory = path.join(
    directory,
    "previews",
    previousIdentifier,
  );
  const temporaryPreviewDirectory = path.join(
    directory,
    "previews",
    ".case-change",
  );
  fs.renameSync(previousPreviewDirectory, temporaryPreviewDirectory);
  fs.renameSync(
    temporaryPreviewDirectory,
    path.join(directory, "previews", identifier),
  );
  theme.Identifier = identifier;
  theme.preview = theme.preview.replace(
    previousPreviewPrefix,
    nextPreviewPrefix,
  );
  theme.rolePreviews = theme.rolePreviews.map((role) => ({
    ...role,
    asset: role.asset.replace(previousPreviewPrefix, nextPreviewPrefix),
  }));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { directory };
}

describe("imported cursor installation", () => {
  it("atomically promotes a validated artifact and converges exact duplicates", async () => {
    const first = fixture();
    await expect(
      installImportedArtifacts({
        artifacts: [first.artifact],
        stagingDirectory: first.staging,
        importedPacksRoot: first.store,
      }),
    ).resolves.toMatchObject({
      identifiers: ["Example"],
      importedCount: 1,
      duplicateCount: 0,
    });
    expect(fs.existsSync(path.join(first.destination, "manifest.json"))).toBe(
      true,
    );
    expect(fs.statSync(first.destination).mode & 0o077).toBe(0);
    expect(
      fs.statSync(path.join(first.destination, "Example.cursor")).mode & 0o077,
    ).toBe(0);

    const secondStaging = fs.mkdtempSync(path.join(first.store, ".import-"));
    const duplicate = path.join(
      secondStaging,
      path.basename(first.destination),
    );
    fs.cpSync(first.destination, duplicate, { recursive: true });
    await expect(
      installImportedArtifacts({
        artifacts: [{ directory: duplicate }],
        stagingDirectory: secondStaging,
        importedPacksRoot: first.store,
      }),
    ).resolves.toMatchObject({ importedCount: 0, duplicateCount: 1 });
  });

  it("rejects case-insensitive identifier collisions within and across imports", async () => {
    const batched = fixture();
    const batchedVariant = copyArtifactWithIdentifier(
      batched.artifact.directory,
      path.join(batched.staging, "example-case-variant"),
      "example",
    );
    await expect(
      installImportedArtifacts({
        artifacts: [batched.artifact, batchedVariant],
        stagingDirectory: batched.staging,
        importedPacksRoot: batched.store,
      }),
    ).rejects.toMatchObject({ code: "IDENTIFIER_COLLISION" });
    expect(fs.existsSync(batched.destination)).toBe(false);

    const sequential = fixture();
    await installImportedArtifacts({
      artifacts: [sequential.artifact],
      stagingDirectory: sequential.staging,
      importedPacksRoot: sequential.store,
    });
    const nextStaging = fs.mkdtempSync(path.join(sequential.store, ".import-"));
    const sequentialVariant = copyArtifactWithIdentifier(
      sequential.destination,
      path.join(nextStaging, "example-case-variant"),
      "example",
    );
    await expect(
      installImportedArtifacts({
        artifacts: [sequentialVariant],
        stagingDirectory: nextStaging,
        importedPacksRoot: sequential.store,
      }),
    ).rejects.toMatchObject({ code: "IDENTIFIER_COLLISION" });
    expect(fs.existsSync(sequential.destination)).toBe(true);
  });

  it("persists family metadata without changing duplicate content identity", async () => {
    const first = fixture();
    await installImportedArtifacts({
      artifacts: [first.artifact],
      stagingDirectory: first.staging,
      importedPacksRoot: first.store,
    });
    const cursorPath = path.join(first.destination, "Example.cursor");
    const cursorBefore = fs.readFileSync(cursorPath);

    await expect(
      assignImportedCursorFamily({
        identifiers: ["Example"],
        family: "  Vimix  ",
        importedPacksRoot: first.store,
      }),
    ).resolves.toMatchObject({ family: "Vimix", updatedCount: 1 });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(first.destination, "manifest.json"), "utf8"),
      ).themes[0].Group,
    ).toBe("Vimix");
    expect(fs.readFileSync(cursorPath)).toEqual(cursorBefore);

    const secondStaging = fs.mkdtempSync(path.join(first.store, ".import-"));
    const duplicate = path.join(
      secondStaging,
      path.basename(first.destination),
    );
    fs.cpSync(first.destination, duplicate, { recursive: true });
    const duplicateManifestPath = path.join(duplicate, "manifest.json");
    const duplicateManifest = JSON.parse(
      fs.readFileSync(duplicateManifestPath, "utf8"),
    );
    duplicateManifest.themes[0].Group = "Imported";
    fs.writeFileSync(duplicateManifestPath, JSON.stringify(duplicateManifest));

    await expect(
      installImportedArtifacts({
        artifacts: [{ directory: duplicate }],
        stagingDirectory: secondStaging,
        importedPacksRoot: first.store,
      }),
    ).resolves.toMatchObject({ importedCount: 0, duplicateCount: 1 });
  });

  it("rejects family names containing native-invalid Unicode controls", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });

    await expect(
      assignImportedCursorFamily({
        identifiers: ["Example"],
        family: "Studio\u200bCursors",
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "INVALID_FAMILY" });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(data.destination, "manifest.json"), "utf8"),
      ).themes[0].Group,
    ).toBe("Imported");
  });

  it("removes only validated imported artifacts after resolving every target", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });

    await expect(
      removeImportedCursorArtifacts({
        identifiers: ["Missing"],
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_NOT_FOUND" });
    expect(fs.existsSync(data.destination)).toBe(true);

    const disposed = [];
    await expect(
      removeImportedCursorArtifacts({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
        async disposeArtifact(artifactPath) {
          disposed.push(path.basename(artifactPath));
          await fs.promises.rm(artifactPath, { recursive: true, force: false });
        },
      }),
    ).resolves.toMatchObject({
      identifiers: ["Example"],
      removedCount: 1,
      recoverable: true,
      cleanupPending: false,
    });
    expect(disposed).toEqual([path.basename(data.destination)]);
    expect(fs.existsSync(data.destination)).toBe(false);
  });

  it("rolls back every newly promoted artifact when native validation fails", async () => {
    const data = fixture();
    let validationInput;

    await expect(
      installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
        validateInstalled(input) {
          validationInput = input;
          expect(fs.existsSync(data.destination)).toBe(true);
          throw new Error("native decoder rejected the cursor");
        },
      }),
    ).rejects.toThrow("native decoder rejected the cursor");

    expect(validationInput).toEqual({
      identifiers: ["Example"],
      installedDirectories: [
        path.join(fs.realpathSync(data.store), path.basename(data.destination)),
      ],
    });
    expect(fs.existsSync(data.destination)).toBe(false);
    expect(fs.existsSync(data.artifact.directory)).toBe(true);
  });

  it("rejects tampering and artifact paths outside staging", async () => {
    const data = fixture();
    fs.appendFileSync(
      path.join(data.artifact.directory, "Example.cursor"),
      "tampered",
    );
    await expect(
      installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });

    const outside = fixture();
    await expect(
      installImportedArtifacts({
        artifacts: [outside.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARTIFACT" });
  });

  it("rejects manifests and previews larger than downstream readers accept", async () => {
    const oversizedManifest = fixture();
    fs.truncateSync(
      path.join(oversizedManifest.artifact.directory, "manifest.json"),
      16 * 1024 * 1024 + 1,
    );
    await expect(
      installImportedArtifacts({
        artifacts: [oversizedManifest.artifact],
        stagingDirectory: oversizedManifest.staging,
        importedPacksRoot: oversizedManifest.store,
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    const oversizedPreview = fixture();
    fs.truncateSync(
      path.join(
        oversizedPreview.artifact.directory,
        "previews",
        "Example",
        "default.png",
      ),
      16 * 1024 * 1024 + 1,
    );
    await expect(
      installImportedArtifacts({
        artifacts: [oversizedPreview.artifact],
        stagingDirectory: oversizedPreview.staging,
        importedPacksRoot: oversizedPreview.store,
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("rejects symlinks and different content at the same pack identity", async () => {
    const data = fixture();
    fs.symlinkSync(
      path.join(data.artifact.directory, "Example.cursor"),
      path.join(data.artifact.directory, "previews", "Example", "unsafe.png"),
    );
    await expect(
      installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARTIFACT" });

    const hardlinked = fixture();
    fs.linkSync(
      path.join(hardlinked.artifact.directory, "Example.cursor"),
      path.join(path.dirname(hardlinked.store), "hardlinked.cursor"),
    );
    await expect(
      installImportedArtifacts({
        artifacts: [hardlinked.artifact],
        stagingDirectory: hardlinked.staging,
        importedPacksRoot: hardlinked.store,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_ARTIFACT" });

    const first = fixture();
    await installImportedArtifacts({
      artifacts: [first.artifact],
      stagingDirectory: first.staging,
      importedPacksRoot: first.store,
    });
    const staging = fs.mkdtempSync(path.join(first.store, ".import-"));
    const collision = path.join(staging, path.basename(first.destination));
    fs.cpSync(first.destination, collision, { recursive: true });
    fs.writeFileSync(
      path.join(collision, "previews", "Example", "default.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    );
    await expect(
      installImportedArtifacts({
        artifacts: [{ directory: collision }],
        stagingDirectory: staging,
        importedPacksRoot: first.store,
      }),
    ).rejects.toMatchObject({ code: "IDENTIFIER_COLLISION" });
  });

  it("removes only a direct private staging directory", async () => {
    const data = fixture();
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    expect(fs.existsSync(data.staging)).toBe(false);
    await expect(
      removeCursorImportStaging({
        stagingDirectory: data.store,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_STORE" });
  });

  it("creates staging only beneath a non-symlink private store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-store-test-"));
    roots.push(root);
    const store = path.join(root, "ImportedPacks");
    const staging = await createCursorImportStaging(store);
    expect(path.dirname(staging)).toBe(fs.realpathSync(store));
    expect(path.basename(staging)).toMatch(/^\.import-/);

    const target = path.join(root, "target");
    const linkedStore = path.join(root, "linked-store");
    fs.mkdirSync(target);
    fs.symlinkSync(target, linkedStore);
    await expect(createCursorImportStaging(linkedStore)).rejects.toMatchObject({
      code: "UNSAFE_STORE",
    });
  });

  it("refuses to exceed the native imported-pack store limit", async () => {
    const data = fixture();
    for (let index = 0; index < 256; index += 1) {
      fs.mkdirSync(path.join(data.store, `Existing-${index}`), { mode: 0o700 });
    }

    await expect(
      installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(fs.existsSync(data.destination)).toBe(false);
  });
});
