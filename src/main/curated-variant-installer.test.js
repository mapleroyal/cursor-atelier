import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCuratedConversionWorkspace } from "./curated-conversion-workspace.js";
import { createCuratedVariantInstaller } from "./curated-variant-installer.js";

const temporaryRoots = [];

async function fixture() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "curated-install-"),
  );
  temporaryRoots.push(root);
  const workRoot = path.join(root, "work");
  const importedPacksRoot = path.join(root, "imports");
  await fs.promises.mkdir(importedPacksRoot, { mode: 0o700 });
  const workspace = await createCuratedConversionWorkspace(workRoot);
  const artifactDirectory = path.join(workspace, "Future");
  await fs.promises.mkdir(artifactDirectory, { mode: 0o700 });
  return { root, workRoot, importedPacksRoot, artifactDirectory };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("curated variant installer", () => {
  it("moves one completed artifact through the existing transactional installer", async () => {
    const { workRoot, importedPacksRoot, artifactDirectory } = await fixture();
    const bridge = {
      validateImportedThemes: vi.fn(async () => ({ valid: true })),
      invalidateManifests: vi.fn(async () => {}),
    };
    const removeStaging = vi.fn(async () => {});
    let stagingDirectory;
    const installArtifacts = vi.fn(async ({ artifacts, validateInstalled }) => {
      expect(artifacts[0].directory).toBe(
        path.join(await fs.promises.realpath(stagingDirectory), "Future"),
      );
      await validateInstalled({ identifiers: ["Future"] });
      return { identifiers: ["Future"], importedCount: 1 };
    });
    const install = createCuratedVariantInstaller({
      workRoot,
      importedPacksRoot,
      bridge,
      createStaging: async () => {
        stagingDirectory = await fs.promises.mkdtemp(
          path.join(importedPacksRoot, ".import-"),
        );
        await fs.promises.chmod(stagingDirectory, 0o700);
        return stagingDirectory;
      },
      removeStaging,
      installArtifacts,
    });

    await expect(
      install({
        variants: [{ artifactDirectory, expectedIdentifier: "Future" }],
      }),
    ).resolves.toMatchObject({ identifiers: ["Future"] });
    expect(bridge.validateImportedThemes).toHaveBeenCalledWith(["Future"]);
    expect(bridge.invalidateManifests).toHaveBeenCalledOnce();
    expect(removeStaging).toHaveBeenCalled();
  });

  it("rejects a converter/install identifier mismatch", async () => {
    const { workRoot, importedPacksRoot, artifactDirectory } = await fixture();
    const install = createCuratedVariantInstaller({
      workRoot,
      importedPacksRoot,
      bridge: {
        validateImportedThemes: vi.fn(),
        invalidateManifests: vi.fn(),
      },
      createStaging: async () => {
        const staging = await fs.promises.mkdtemp(
          path.join(importedPacksRoot, ".import-"),
        );
        await fs.promises.chmod(staging, 0o700);
        return staging;
      },
      removeStaging: vi.fn(async () => {}),
      installArtifacts: vi.fn(async ({ validateInstalled }) => {
        await validateInstalled({ identifiers: ["Other"] });
        return { identifiers: ["Other"], importedCount: 1 };
      }),
    });

    await expect(
      install({
        variants: [{ artifactDirectory, expectedIdentifier: "Future" }],
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH" });
  });
});
