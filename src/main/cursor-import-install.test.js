import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assignImportedCursorFamily,
  createCursorImportStaging,
  DELETE_TRANSACTION_MANIFEST,
  DELETE_TRANSACTION_NATIVE_STARTED,
  installImportedArtifacts,
  IMPORT_PROMOTION_COMMIT,
  IMPORT_PROMOTION_MANIFEST,
  prepareImportedCursorArtifactRemoval,
  reconcileCursorImportTransactions,
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

function addCorruptInstalledPack(source, store, identifier = "Broken") {
  const directory = path.join(store, `${identifier}-deadbeef0000`);
  copyArtifactWithIdentifier(source, directory, identifier);
  fs.appendFileSync(path.join(directory, "Example.cursor"), "corrupt");
  makeTreePrivate(directory);
  return directory;
}

function addUnsafeManifestPack(source, store, identifier = "Unsafe") {
  const directory = path.join(store, `${identifier}-badbadbadbad`);
  copyArtifactWithIdentifier(source, directory, identifier);
  makeTreePrivate(directory);
  const manifestPath = path.join(directory, "manifest.json");
  fs.unlinkSync(manifestPath);
  fs.symlinkSync(path.join(source, "manifest.json"), manifestPath);
  return directory;
}

function makeTreePrivate(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeTreePrivate(entryPath);
      fs.chmodSync(entryPath, 0o700);
    } else {
      fs.chmodSync(entryPath, 0o600);
    }
  }
  fs.chmodSync(root, 0o700);
}

function deletionNativeRecovery(overrides = {}) {
  return {
    previousSelectedIdentifier: "Example",
    previousEffectiveIdentifier: "Example",
    previousCursorWasLive: true,
    previousDesiredEnabled: true,
    previousLaunchAtLoginDesired: true,
    previousLoginItemRegistrationCurrent: true,
    previousTransactionPending: false,
    teardownPlanned: true,
    ...overrides,
  };
}

function observeFilesystemDurability({ onRename, onRenamed, onSync } = {}) {
  const events = [];
  const originalOpen = fs.promises.open.bind(fs.promises);
  const originalRename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(
    async (filePath, ...arguments_) => {
      const handle = await originalOpen(filePath, ...arguments_);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async (...syncArguments) => {
              const event = { type: "sync", path: String(filePath) };
              events.push(event);
              onSync?.(event);
              return target.sync(...syncArguments);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  );
  vi.spyOn(fs.promises, "rename").mockImplementation(
    async (source, destination) => {
      const event = {
        type: "rename",
        source: String(source),
        destination: String(destination),
        nativeRecoveryDurable: fs.existsSync(
          path.join(
            path.dirname(String(destination)),
            DELETE_TRANSACTION_NATIVE_STARTED,
          ),
        ),
      };
      events.push(event);
      onRename?.(event);
      const result = await originalRename(source, destination);
      onRenamed?.(event);
      return result;
    },
  );
  return events;
}

function directorySyncsAfter(events, eventIndex, directories) {
  const expected = new Set(directories);
  return events
    .slice(eventIndex + 1)
    .filter((event) => event.type === "sync" && expected.has(event.path))
    .map((event) => event.path);
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

  it("assigns a healthy pack without validating an unrelated corrupt pack", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const corruptDirectory = addCorruptInstalledPack(
      data.destination,
      data.store,
    );

    await expect(
      assignImportedCursorFamily({
        identifiers: ["Example"],
        family: "Studio",
        importedPacksRoot: data.store,
      }),
    ).resolves.toMatchObject({
      identifiers: ["Example"],
      family: "Studio",
      updatedCount: 1,
    });
    expect(fs.existsSync(corruptDirectory)).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(data.destination, "manifest.json"), "utf8"),
      ).themes[0].Group,
    ).toBe("Studio");
  });

  it("assigns a healthy pack without opening an unrelated unsafe manifest", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const unsafeDirectory = addUnsafeManifestPack(data.destination, data.store);

    await expect(
      assignImportedCursorFamily({
        identifiers: ["Example"],
        family: "Studio",
        importedPacksRoot: data.store,
      }),
    ).resolves.toMatchObject({ updatedCount: 1 });
    expect(
      fs
        .lstatSync(path.join(unsafeDirectory, "manifest.json"))
        .isSymbolicLink(),
    ).toBe(true);
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

  it("removes a healthy pack without validating an unrelated corrupt pack", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const corruptDirectory = addCorruptInstalledPack(
      data.destination,
      data.store,
    );

    await expect(
      removeImportedCursorArtifacts({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
      }),
    ).resolves.toMatchObject({
      identifiers: ["Example"],
      removedCount: 1,
    });
    expect(fs.existsSync(data.destination)).toBe(false);
    expect(fs.existsSync(corruptDirectory)).toBe(true);
  });

  it("quarantines an exact removal set and can roll it back before disposal", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const disposeArtifact = vi.fn();

    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
      disposeArtifact,
    });
    expect(fs.existsSync(data.destination)).toBe(false);

    await removal.rollback();

    expect(fs.existsSync(data.destination)).toBe(true);
    expect(disposeArtifact).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(data.store).filter((name) => name.startsWith(".delete-")),
    ).toEqual([]);
  });

  it("durably records native recovery and the transaction directory before quarantining", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const canonicalStore = fs.realpathSync(data.store);
    const canonicalDestination = path.join(
      canonicalStore,
      path.basename(data.destination),
    );
    const snapshotStore = path.join(path.dirname(data.store), "SnapshotPacks");
    const events = observeFilesystemDurability({
      onRename(event) {
        if (
          event.source === canonicalDestination &&
          !fs.existsSync(snapshotStore)
        ) {
          fs.cpSync(data.store, snapshotStore, { recursive: true });
        }
      },
    });

    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
      nativeRecovery: deletionNativeRecovery(),
      recoverNativeState: vi.fn(),
    });
    const quarantineIndex = events.findIndex(
      (event) =>
        event.type === "rename" && event.source === canonicalDestination,
    );
    expect(quarantineIndex).toBeGreaterThan(-1);
    const quarantine = events[quarantineIndex];
    const deletionDirectory = path.dirname(quarantine.destination);

    expect(quarantine.nativeRecoveryDurable).toBe(true);
    expect(
      events
        .slice(0, quarantineIndex)
        .some(
          (event) => event.type === "sync" && event.path === canonicalStore,
        ),
    ).toBe(true);
    expect(
      directorySyncsAfter(events, quarantineIndex, [
        deletionDirectory,
        canonicalStore,
      ]).slice(0, 2),
    ).toEqual([deletionDirectory, canonicalStore]);

    await removal.rollback();

    makeTreePrivate(snapshotStore);
    const recoverDeletionNativeState = vi.fn();
    await expect(
      reconcileCursorImportTransactions({
        importedPacksRoot: snapshotStore,
        recoverDeletionNativeState,
      }),
    ).resolves.toMatchObject({ cleanupPending: false });
    expect(recoverDeletionNativeState).toHaveBeenCalledWith(
      deletionNativeRecovery(),
    );
    expect(
      fs.existsSync(path.join(snapshotStore, path.basename(data.destination))),
    ).toBe(true);
    expect(
      fs.readdirSync(snapshotStore).some((name) => name.startsWith(".delete-")),
    ).toBe(false);
  });

  it("does not compensate native state when the initial transaction-directory fsync fails", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const canonicalStore = fs.realpathSync(data.store);
    let injectedFailure = false;
    observeFilesystemDurability({
      onSync(event) {
        if (event.path === canonicalStore && !injectedFailure) {
          injectedFailure = true;
          throw new Error("initial transaction fsync failed");
        }
      },
    });
    const recoverNativeState = vi.fn();

    await expect(
      prepareImportedCursorArtifactRemoval({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
        nativeRecovery: deletionNativeRecovery(),
        recoverNativeState,
      }),
    ).rejects.toThrow("initial transaction fsync failed");

    expect(injectedFailure).toBe(true);
    expect(recoverNativeState).not.toHaveBeenCalled();
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(
      fs.readdirSync(data.store).some((name) => name.startsWith(".delete-")),
    ).toBe(false);
  });

  it.each([
    ["prepared", DELETE_TRANSACTION_MANIFEST],
    ["native-started", DELETE_TRANSACTION_NATIVE_STARTED],
  ])(
    "does not compensate native state when %s marker publication fails before quarantine",
    async (_phase, failedMarker) => {
      const data = fixture();
      await installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      });
      await removeCursorImportStaging({
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      });
      let injectedFailure = false;
      observeFilesystemDurability({
        onRename(event) {
          if (
            path.basename(event.destination) === failedMarker &&
            !injectedFailure
          ) {
            injectedFailure = true;
            throw new Error(`${failedMarker} publication failed`);
          }
        },
      });
      const recoverNativeState = vi.fn();

      await expect(
        prepareImportedCursorArtifactRemoval({
          identifiers: ["Example"],
          importedPacksRoot: data.store,
          nativeRecovery: deletionNativeRecovery(),
          recoverNativeState,
        }),
      ).rejects.toThrow(`${failedMarker} publication failed`);

      expect(injectedFailure).toBe(true);
      expect(recoverNativeState).not.toHaveBeenCalled();
      expect(fs.existsSync(data.destination)).toBe(true);
      expect(
        fs.readdirSync(data.store).some((name) => name.startsWith(".delete-")),
      ).toBe(false);
    },
  );

  it("compensates helper drift before clearing a failed quarantine journal", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const canonicalStore = fs.realpathSync(data.store);
    const canonicalDestination = path.join(
      canonicalStore,
      path.basename(data.destination),
    );
    let deletionDirectory = null;
    let helperState = "original";
    let injectedFailure = false;
    let recoveryMarkerWasDurable = false;
    observeFilesystemDurability({
      onRenamed(event) {
        if (event.source === canonicalDestination) {
          deletionDirectory = path.dirname(event.destination);
          helperState = "drifted";
        }
      },
      onSync(event) {
        if (
          helperState === "drifted" &&
          event.path === deletionDirectory &&
          !injectedFailure
        ) {
          injectedFailure = true;
          throw new Error("quarantine fsync failed");
        }
      },
    });
    const recoverNativeState = vi.fn(async () => {
      recoveryMarkerWasDurable = fs.existsSync(
        path.join(deletionDirectory, DELETE_TRANSACTION_NATIVE_STARTED),
      );
      helperState = "original";
    });

    await expect(
      prepareImportedCursorArtifactRemoval({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
        nativeRecovery: deletionNativeRecovery(),
        recoverNativeState,
      }),
    ).rejects.toThrow("quarantine fsync failed");

    expect(injectedFailure).toBe(true);
    expect(recoveryMarkerWasDurable).toBe(true);
    expect(recoverNativeState).toHaveBeenCalledWith(deletionNativeRecovery());
    expect(helperState).toBe("original");
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(
      fs.readdirSync(data.store).some((name) => name.startsWith(".delete-")),
    ).toBe(false);
  });

  it("retains the durable journal when quarantine compensation fails", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const canonicalStore = fs.realpathSync(data.store);
    const canonicalDestination = path.join(
      canonicalStore,
      path.basename(data.destination),
    );
    let deletionDirectory = null;
    let helperState = "original";
    let injectedFailure = false;
    observeFilesystemDurability({
      onRenamed(event) {
        if (event.source === canonicalDestination) {
          deletionDirectory = path.dirname(event.destination);
          helperState = "drifted";
        }
      },
      onSync(event) {
        if (
          helperState === "drifted" &&
          event.path === deletionDirectory &&
          !injectedFailure
        ) {
          injectedFailure = true;
          throw new Error("quarantine fsync failed");
        }
      },
    });
    const recoverNativeState = vi
      .fn()
      .mockRejectedValue(new Error("native compensation failed"));

    await expect(
      prepareImportedCursorArtifactRemoval({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
        nativeRecovery: deletionNativeRecovery(),
        recoverNativeState,
      }),
    ).rejects.toMatchObject({ code: "DELETE_ROLLBACK_FAILED" });

    expect(fs.existsSync(data.destination)).toBe(true);
    expect(fs.existsSync(deletionDirectory)).toBe(true);
    expect(
      fs.existsSync(
        path.join(deletionDirectory, DELETE_TRANSACTION_NATIVE_STARTED),
      ),
    ).toBe(true);

    const startupRecovery = vi.fn(async () => {
      helperState = "original";
    });
    await expect(
      reconcileCursorImportTransactions({
        importedPacksRoot: data.store,
        recoverDeletionNativeState: startupRecovery,
      }),
    ).resolves.toMatchObject({ cleanupPending: false });
    expect(startupRecovery).toHaveBeenCalledWith(deletionNativeRecovery());
    expect(helperState).toBe("original");
    expect(fs.existsSync(deletionDirectory)).toBe(false);
  });

  it.each(["rollback", "commit"])(
    "rejects journal-digest changes during live %s",
    async (operation) => {
      const data = fixture();
      await installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      });
      await removeCursorImportStaging({
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      });
      const disposeArtifact = vi.fn();
      const removal = await prepareImportedCursorArtifactRemoval({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
        disposeArtifact,
      });
      const deletionDirectory = fs
        .readdirSync(data.store)
        .map((name) => path.join(data.store, name))
        .find((entry) => path.basename(entry).startsWith(".delete-"));
      fs.appendFileSync(
        path.join(
          deletionDirectory,
          path.basename(data.destination),
          "previews",
          "Example",
          "default.png",
        ),
        Buffer.from([1]),
      );

      if (operation === "commit") {
        await removal.markCommitted();
        await expect(removal.commit()).resolves.toMatchObject({
          cleanupPending: true,
        });
        expect(disposeArtifact).not.toHaveBeenCalled();
      } else {
        await expect(removal.rollback()).rejects.toMatchObject({
          code: "DELETE_ROLLBACK_FAILED",
        });
      }
      expect(fs.existsSync(deletionDirectory)).toBe(true);
      expect(fs.existsSync(data.destination)).toBe(false);
    },
  );

  it("reconciles stale staging, metadata, and deletion transactions", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const staleStaging = fs.mkdtempSync(path.join(data.store, ".import-"));
    const interruptedExtraction = path.join(staleStaging, "extracted");
    fs.mkdirSync(interruptedExtraction, { mode: 0o755 });
    fs.chmodSync(interruptedExtraction, 0o755);
    fs.writeFileSync(path.join(interruptedExtraction, "source.txt"), "stale");
    const metadata = fs.mkdtempSync(path.join(data.store, ".metadata-"));
    fs.chmodSync(metadata, 0o700);
    fs.writeFileSync(path.join(metadata, "manifest.json"), "temporary");
    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
    });
    expect(removal.removedCount).toBe(1);
    const disposed = [];

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      async disposeArtifact(artifactPath) {
        disposed.push(path.basename(artifactPath));
        await fs.promises.rm(artifactPath, { recursive: true, force: false });
      },
      persistPendingThemeSizeCleanup: vi.fn(),
    });

    expect(result.cleanupPending).toBe(false);
    expect(result.removed).toHaveLength(3);
    expect(disposed).toEqual([]);
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(
      fs
        .readdirSync(data.store)
        .filter((name) => /^\.(?:import|metadata|delete)-/.test(name)),
    ).toEqual([]);
  });

  it("finishes only a durably committed deletion after a crash", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
    });
    await removal.markCommitted();
    const disposed = [];
    const persistPendingThemeSizeCleanup = vi.fn();

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      async disposeArtifact(artifactPath) {
        disposed.push(path.basename(artifactPath));
        await fs.promises.rm(artifactPath, { recursive: true, force: false });
      },
      persistPendingThemeSizeCleanup,
    });

    expect(result).toMatchObject({ cleanupPending: false, pending: [] });
    expect(disposed).toEqual([path.basename(data.destination)]);
    expect(persistPendingThemeSizeCleanup).toHaveBeenCalledWith(["Example"]);
    expect(fs.existsSync(data.destination)).toBe(false);
  });

  it.each([
    ["before marker cleanup", []],
    ["after prepared marker cleanup", [DELETE_TRANSACTION_MANIFEST]],
    [
      "after native-started marker cleanup",
      [DELETE_TRANSACTION_MANIFEST, DELETE_TRANSACTION_NATIVE_STARTED],
    ],
  ])("finishes a committed deletion %s", async (_label, removedMarkers) => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
      nativeRecovery: deletionNativeRecovery(),
      recoverNativeState: vi.fn(),
    });
    await removal.markCommitted();
    const deletionDirectory = fs
      .readdirSync(data.store)
      .map((name) => path.join(data.store, name))
      .find((entry) => path.basename(entry).startsWith(".delete-"));
    for (const marker of removedMarkers) {
      fs.unlinkSync(path.join(deletionDirectory, marker));
    }

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      disposeArtifact: (artifactPath) =>
        fs.promises.rm(artifactPath, { recursive: true, force: false }),
      recoverDeletionNativeState: vi.fn(),
      persistPendingThemeSizeCleanup: vi.fn(),
    });

    expect(result.cleanupPending).toBe(false);
    expect(fs.existsSync(data.destination)).toBe(false);
    expect(fs.existsSync(deletionDirectory)).toBe(false);
  });

  it("retains committed deletion cleanup IDs until durable persistence succeeds", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
    });
    await removal.markCommitted();
    const disposeArtifact = vi.fn((artifactPath) =>
      fs.promises.rm(artifactPath, { recursive: true, force: false }),
    );
    const persistPendingThemeSizeCleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    const first = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      disposeArtifact,
      persistPendingThemeSizeCleanup,
    });
    expect(first.cleanupPending).toBe(true);
    expect(disposeArtifact).toHaveBeenCalledTimes(1);

    const second = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      disposeArtifact,
      persistPendingThemeSizeCleanup,
    });
    expect(second.cleanupPending).toBe(false);
    expect(disposeArtifact).toHaveBeenCalledTimes(1);
    expect(persistPendingThemeSizeCleanup).toHaveBeenNthCalledWith(1, [
      "Example",
    ]);
    expect(persistPendingThemeSizeCleanup).toHaveBeenNthCalledWith(2, [
      "Example",
    ]);
  });

  it("restores artifacts and native state for a started deletion before clearing recovery metadata", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
      nativeRecovery: deletionNativeRecovery(),
      recoverNativeState: vi.fn(),
    });
    const recoverDeletionNativeState = vi.fn();

    const first = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      recoverDeletionNativeState: async () => {
        throw new Error("native bridge still unavailable");
      },
    });
    expect(first.cleanupPending).toBe(true);
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(
      fs.readdirSync(data.store).some((name) => name.startsWith(".delete-")),
    ).toBe(true);

    const second = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      recoverDeletionNativeState,
    });
    expect(second.cleanupPending).toBe(false);
    expect(recoverDeletionNativeState).toHaveBeenCalledWith({
      previousSelectedIdentifier: "Example",
      previousEffectiveIdentifier: "Example",
      previousCursorWasLive: true,
      previousDesiredEnabled: true,
      previousLaunchAtLoginDesired: true,
      previousLoginItemRegistrationCurrent: true,
      previousTransactionPending: false,
      teardownPlanned: true,
    });
    expect(
      fs.readdirSync(data.store).some((name) => name.startsWith(".delete-")),
    ).toBe(false);
  });

  it("refuses unidentifiable native deletion recovery intent", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await expect(
      prepareImportedCursorArtifactRemoval({
        identifiers: ["Example"],
        importedPacksRoot: data.store,
        nativeRecovery: deletionNativeRecovery({
          previousSelectedIdentifier: null,
          previousEffectiveIdentifier: null,
        }),
        recoverNativeState: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_STORE" });
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(
      fs.readdirSync(data.store).some((name) => name.startsWith(".delete-")),
    ).toBe(false);
  });

  it("fails closed when deletion phase metadata or artifact placement is ambiguous", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
    });
    const deletionDirectory = fs
      .readdirSync(data.store)
      .map((name) => path.join(data.store, name))
      .find((entry) => path.basename(entry).startsWith(".delete-"));
    fs.cpSync(
      path.join(deletionDirectory, path.basename(data.destination)),
      data.destination,
      { recursive: true },
    );

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
    });

    expect(result.cleanupPending).toBe(true);
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(fs.existsSync(deletionDirectory)).toBe(true);
  });

  it("does not dispose a same-name deletion artifact whose journaled digest changed", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
    });
    await removal.markCommitted();
    const deletionDirectory = fs
      .readdirSync(data.store)
      .map((name) => path.join(data.store, name))
      .find((entry) => path.basename(entry).startsWith(".delete-"));
    fs.appendFileSync(
      path.join(
        deletionDirectory,
        path.basename(data.destination),
        "previews",
        "Example",
        "default.png",
      ),
      Buffer.from([1]),
    );
    const disposeArtifact = vi.fn();

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
      disposeArtifact,
    });

    expect(result.cleanupPending).toBe(true);
    expect(disposeArtifact).not.toHaveBeenCalled();
    expect(fs.existsSync(deletionDirectory)).toBe(true);
  });

  it("does not follow links or remove multiply-linked files during reconciliation", async () => {
    const data = fixture();
    const linkTransaction = path.join(data.store, ".import-ABC123");
    fs.mkdirSync(linkTransaction, { mode: 0o700 });
    const outsideTarget = path.join(path.dirname(data.store), "outside.txt");
    fs.writeFileSync(outsideTarget, "keep me");
    fs.symlinkSync(outsideTarget, path.join(linkTransaction, "linked.txt"));

    const hardLinkTransaction = path.join(data.store, ".metadata-ABC124");
    fs.mkdirSync(hardLinkTransaction, { mode: 0o700 });
    const outsideHardLink = path.join(
      path.dirname(data.store),
      "outside-hardlink.txt",
    );
    fs.writeFileSync(outsideHardLink, "keep me too");
    fs.linkSync(
      outsideHardLink,
      path.join(hardLinkTransaction, "manifest.json"),
    );

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
    });

    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("keep me");
    expect(fs.existsSync(linkTransaction)).toBe(false);
    expect(fs.readFileSync(outsideHardLink, "utf8")).toBe("keep me too");
    expect(fs.existsSync(hardLinkTransaction)).toBe(true);
    expect(result.pending).toContain(".metadata-ABC124");
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

  it("fsyncs the staging destination before the store after live promotion rollback", async () => {
    const data = fixture();
    const canonicalStore = fs.realpathSync(data.store);
    const canonicalStaging = fs.realpathSync(data.staging);
    const canonicalDestination = path.join(
      canonicalStore,
      path.basename(data.destination),
    );
    const canonicalArtifact = path.join(
      canonicalStaging,
      path.basename(data.artifact.directory),
    );
    const events = observeFilesystemDurability();

    await expect(
      installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
        validateInstalled() {
          throw new Error("native validation failed");
        },
      }),
    ).rejects.toThrow("native validation failed");

    const rollbackIndex = events.findIndex(
      (event) =>
        event.type === "rename" &&
        event.source === canonicalDestination &&
        event.destination === canonicalArtifact,
    );
    expect(rollbackIndex).toBeGreaterThan(-1);
    expect(
      directorySyncsAfter(events, rollbackIndex, [
        canonicalStaging,
        canonicalStore,
      ]).slice(0, 2),
    ).toEqual([canonicalStaging, canonicalStore]);
  });

  it("rolls back a partially promoted multi-pack import after a crash", async () => {
    const data = fixture();
    const secondDirectory = path.join(data.staging, "Second-a1b2c3d4e5f7");
    const secondArtifact = copyArtifactWithIdentifier(
      data.artifact.directory,
      secondDirectory,
      "Second",
    );
    const snapshotStore = path.join(path.dirname(data.store), "SnapshotPacks");
    await installImportedArtifacts({
      artifacts: [data.artifact, secondArtifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
      validateInstalled() {
        fs.cpSync(data.store, snapshotStore, { recursive: true });
      },
    });
    makeTreePrivate(snapshotStore);
    const snapshotStaging = fs
      .readdirSync(snapshotStore)
      .map((name) => path.join(snapshotStore, name))
      .find((entry) => path.basename(entry).startsWith(".import-"));
    const snapshotExample = path.join(
      snapshotStore,
      path.basename(data.destination),
    );
    const snapshotSecond = path.join(
      snapshotStore,
      path.basename(secondDirectory),
    );
    fs.renameSync(
      snapshotSecond,
      path.join(snapshotStaging, path.basename(snapshotSecond)),
    );
    fs.writeFileSync(
      path.join(snapshotStaging, `${IMPORT_PROMOTION_COMMIT}.publishing`),
      "{torn",
      { mode: 0o600 },
    );

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: snapshotStore,
    });

    expect(result).toMatchObject({ cleanupPending: false, pending: [] });
    expect(fs.existsSync(snapshotExample)).toBe(false);
    expect(fs.existsSync(snapshotSecond)).toBe(false);
    expect(fs.existsSync(snapshotStaging)).toBe(false);
  });

  it("fsyncs the staging destination before the store during startup promotion rollback", async () => {
    const data = fixture();
    const snapshotStore = path.join(path.dirname(data.store), "SnapshotPacks");
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
      validateInstalled() {
        fs.cpSync(data.store, snapshotStore, { recursive: true });
      },
    });
    makeTreePrivate(snapshotStore);
    const canonicalSnapshotStore = fs.realpathSync(snapshotStore);
    const snapshotStaging = fs
      .readdirSync(canonicalSnapshotStore)
      .map((name) => path.join(canonicalSnapshotStore, name))
      .find((entry) => path.basename(entry).startsWith(".import-"));
    const snapshotDestination = path.join(
      canonicalSnapshotStore,
      path.basename(data.destination),
    );
    const events = observeFilesystemDurability();

    await expect(
      reconcileCursorImportTransactions({
        importedPacksRoot: canonicalSnapshotStore,
      }),
    ).resolves.toMatchObject({ cleanupPending: false });

    const rollbackIndex = events.findIndex(
      (event) =>
        event.type === "rename" &&
        event.source === snapshotDestination &&
        event.destination ===
          path.join(snapshotStaging, path.basename(data.destination)),
    );
    expect(rollbackIndex).toBeGreaterThan(-1);
    expect(
      directorySyncsAfter(events, rollbackIndex, [
        snapshotStaging,
        canonicalSnapshotStore,
      ]).slice(0, 2),
    ).toEqual([snapshotStaging, canonicalSnapshotStore]);
  });

  it("keeps promoted artifacts when durable native validation committed before a crash", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
      validateInstalled: vi.fn(),
    });
    expect(fs.existsSync(data.staging)).toBe(true);

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
    });

    expect(result).toMatchObject({ cleanupPending: false, pending: [] });
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(fs.existsSync(data.staging)).toBe(false);
  });

  it.each([
    ["before marker cleanup", []],
    ["after prepared marker cleanup", [IMPORT_PROMOTION_MANIFEST]],
    [
      "after commit marker cleanup",
      [IMPORT_PROMOTION_MANIFEST, IMPORT_PROMOTION_COMMIT],
    ],
  ])("keeps a committed promotion %s", async (_label, removedMarkers) => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
      validateInstalled: vi.fn(),
    });
    for (const marker of removedMarkers) {
      fs.unlinkSync(path.join(data.staging, marker));
    }

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
    });

    expect(result.cleanupPending).toBe(false);
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(fs.existsSync(data.staging)).toBe(false);
  });

  it("ignores a torn unpublished deletion commit marker", async () => {
    const data = fixture();
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    await prepareImportedCursorArtifactRemoval({
      identifiers: ["Example"],
      importedPacksRoot: data.store,
    });
    const deletionDirectory = fs
      .readdirSync(data.store)
      .map((name) => path.join(data.store, name))
      .find((entry) => path.basename(entry).startsWith(".delete-"));
    fs.writeFileSync(
      path.join(deletionDirectory, ".committed.json.publishing"),
      "{torn",
      { mode: 0o600 },
    );

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
    });

    expect(result.cleanupPending).toBe(false);
    expect(fs.existsSync(data.destination)).toBe(true);
    expect(fs.existsSync(deletionDirectory)).toBe(false);
  });

  it("fails closed on malformed import promotion state", async () => {
    const data = fixture();
    fs.writeFileSync(
      path.join(data.staging, ".promotion.json"),
      JSON.stringify({ schemaVersion: 1, phase: "prepared" }),
      { mode: 0o600 },
    );

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: data.store,
    });

    expect(result.cleanupPending).toBe(true);
    expect(fs.existsSync(data.staging)).toBe(true);
    expect(fs.existsSync(data.artifact.directory)).toBe(true);
  });

  it("does not roll back a promoted artifact whose journaled digest changed", async () => {
    const data = fixture();
    const snapshotStore = path.join(path.dirname(data.store), "SnapshotPacks");
    await installImportedArtifacts({
      artifacts: [data.artifact],
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
      validateInstalled() {
        fs.cpSync(data.store, snapshotStore, { recursive: true });
      },
    });
    makeTreePrivate(snapshotStore);
    const snapshotDestination = path.join(
      snapshotStore,
      path.basename(data.destination),
    );
    fs.appendFileSync(
      path.join(snapshotDestination, "previews", "Example", "default.png"),
      Buffer.from([1]),
    );

    const result = await reconcileCursorImportTransactions({
      importedPacksRoot: snapshotStore,
    });

    expect(result.cleanupPending).toBe(true);
    expect(fs.existsSync(snapshotDestination)).toBe(true);
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

  it("rejects staging names outside the exact transaction grammar", async () => {
    const data = fixture();
    const invalidStaging = path.join(data.store, ".import-ABC123-extra");
    fs.renameSync(data.staging, invalidStaging);
    const invalidArtifact = path.join(
      invalidStaging,
      path.basename(data.artifact.directory),
    );

    await expect(
      installImportedArtifacts({
        artifacts: [{ directory: invalidArtifact }],
        stagingDirectory: invalidStaging,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_STORE" });
    await expect(
      removeCursorImportStaging({
        stagingDirectory: invalidStaging,
        importedPacksRoot: data.store,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_STORE" });
    expect(fs.existsSync(invalidStaging)).toBe(true);
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
    for (let index = 0; index < 512; index += 1) {
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

  it("does not count owned transaction directories against the store quota", async () => {
    const data = fixture();
    for (let index = 0; index < 513; index += 1) {
      fs.mkdirSync(
        path.join(data.store, `.metadata-${String(index).padStart(6, "0")}`),
        { mode: 0o700 },
      );
    }

    await expect(
      installImportedArtifacts({
        artifacts: [data.artifact],
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
      }),
    ).resolves.toMatchObject({ importedCount: 1 });
  });

  it("round-trips maximum-size promotion and deletion metadata", async () => {
    const data = fixture();
    const artifacts = [];
    const identifiers = [];
    for (let index = 0; index < 256; index += 1) {
      const sequence = String(index).padStart(3, "0");
      const packName = `Pack${sequence}${"p".repeat(121)}`;
      const identifier = `I${sequence}${"i".repeat(124)}`;
      identifiers.push(identifier);
      artifacts.push(
        copyArtifactWithIdentifier(
          data.artifact.directory,
          path.join(data.staging, packName),
          identifier,
        ),
      );
    }

    await expect(
      installImportedArtifacts({
        artifacts,
        stagingDirectory: data.staging,
        importedPacksRoot: data.store,
        validateInstalled: vi.fn(),
      }),
    ).resolves.toMatchObject({ importedCount: 256 });
    await removeCursorImportStaging({
      stagingDirectory: data.staging,
      importedPacksRoot: data.store,
    });
    const removal = await prepareImportedCursorArtifactRemoval({
      identifiers,
      importedPacksRoot: data.store,
    });
    expect(removal.removedCount).toBe(256);

    await removal.rollback();
    expect(
      fs.readdirSync(data.store).filter((name) => name.startsWith(".delete-")),
    ).toEqual([]);
  }, 30_000);
});
