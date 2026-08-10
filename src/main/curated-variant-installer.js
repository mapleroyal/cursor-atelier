import { moveCuratedArtifactToImportStaging } from "./curated-conversion-workspace.js";

const THEME_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_BATCH_SIZE = 16;

function exactIdentifiers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((identifier, index) => identifier === expected[index])
  );
}

export function createCuratedVariantInstaller({
  workRoot,
  importedPacksRoot,
  bridge,
  createStaging,
  removeStaging,
  installArtifacts,
  onCleanupError = (error) =>
    console.error("Could not remove curated conversion staging data.", error),
} = {}) {
  if (
    typeof workRoot !== "string" ||
    typeof importedPacksRoot !== "string" ||
    !bridge ||
    typeof createStaging !== "function" ||
    typeof removeStaging !== "function" ||
    typeof installArtifacts !== "function"
  ) {
    throw new TypeError(
      "Curated variant installer dependencies are incomplete.",
    );
  }

  return async function installCuratedVariants({ variants, signal }) {
    if (
      !Array.isArray(variants) ||
      variants.length === 0 ||
      variants.length > MAX_BATCH_SIZE ||
      variants.some(
        (variant) =>
          !variant ||
          typeof variant.artifactDirectory !== "string" ||
          !THEME_ID.test(String(variant.expectedIdentifier ?? "")),
      )
    ) {
      throw new TypeError("The curated theme batch is invalid.");
    }
    const expected = variants.map((variant) => variant.expectedIdentifier);
    if (new Set(expected).size !== variants.length) {
      throw new TypeError("The curated theme batch is invalid.");
    }
    signal?.throwIfAborted();
    const stagingDirectory = await createStaging(importedPacksRoot);
    let committed = false;
    let installed;
    let failure = null;
    try {
      const movedArtifacts = [];
      for (const variant of variants) {
        movedArtifacts.push(
          await moveCuratedArtifactToImportStaging({
            root: workRoot,
            artifactDirectory: variant.artifactDirectory,
            stagingDirectory,
          }),
        );
      }
      signal?.throwIfAborted();
      installed = await installArtifacts({
        artifacts: movedArtifacts.map((directory) => ({ directory })),
        stagingDirectory,
        importedPacksRoot,
        validateInstalled: ({ identifiers }) => {
          if (!exactIdentifiers(identifiers, expected)) {
            const error = new Error(
              "The installed curated themes did not match the converted batch.",
            );
            error.code = "INSTALLATION_MISMATCH";
            throw error;
          }
          return bridge.validateImportedThemes(identifiers);
        },
      });
      if (!exactIdentifiers(installed.identifiers, expected)) {
        const error = new Error(
          "The installed curated themes did not match the converted batch.",
        );
        error.code = "INSTALLATION_MISMATCH";
        throw error;
      }
      committed = true;
      await bridge.invalidateManifests();
    } catch (error) {
      failure = error;
    } finally {
      try {
        await removeStaging({ stagingDirectory, importedPacksRoot });
      } catch (error) {
        if (committed) {
          onCleanupError(error);
        } else if (failure) {
          onCleanupError(error);
        } else {
          failure = error;
        }
      }
    }
    if (failure) {
      throw failure;
    }
    return installed;
  };
}
