import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCuratedConversionWorkspace,
  moveCuratedArtifactToImportStaging,
  reconcileCuratedConversionWorkspaces,
  removeCuratedConversionWorkspace,
} from "./curated-conversion-workspace.js";

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "curated-workspace-test-"),
  );
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

describe("curated conversion workspaces", () => {
  it("creates private workspaces and moves a completed artifact into staging", async () => {
    const root = await temporaryRoot();
    const workspace = await createCuratedConversionWorkspace(root);
    const artifact = path.join(workspace, "Future");
    const staging = path.join(root, "staging");
    await fs.promises.mkdir(artifact, { mode: 0o700 });
    await fs.promises.mkdir(staging, { mode: 0o700 });
    await fs.promises.writeFile(path.join(artifact, "manifest.json"), "{}", {
      mode: 0o600,
    });

    const destination = await moveCuratedArtifactToImportStaging({
      root,
      artifactDirectory: artifact,
      stagingDirectory: staging,
    });

    expect(destination).toBe(
      path.join(await fs.promises.realpath(staging), "Future"),
    );
    expect(
      await fs.promises.readFile(
        path.join(destination, "manifest.json"),
        "utf8",
      ),
    ).toBe("{}");
    await removeCuratedConversionWorkspace({ root, workspace });
    await expect(fs.promises.access(workspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not follow symlinks while cleaning interrupted work", async () => {
    const root = await temporaryRoot();
    const outside = path.join(root, "outside.txt");
    await fs.promises.writeFile(outside, "keep");
    const workspace = await createCuratedConversionWorkspace(root);
    await fs.promises.symlink(outside, path.join(workspace, "link"));

    await removeCuratedConversionWorkspace({ root, workspace });

    expect(await fs.promises.readFile(outside, "utf8")).toBe("keep");
  });

  it("reconciles only exact private workspace names", async () => {
    const root = await temporaryRoot();
    const workspace = await createCuratedConversionWorkspace(root);
    const unrelated = path.join(root, "family-user-data");
    await fs.promises.mkdir(unrelated);

    const result = await reconcileCuratedConversionWorkspaces(root);

    expect(result).toEqual({
      removed: [path.basename(workspace)],
      pending: [],
      cleanupPending: false,
    });
    expect((await fs.promises.stat(unrelated)).isDirectory()).toBe(true);
  });

  it("rejects artifacts outside the active workspace", async () => {
    const root = await temporaryRoot();
    const outside = path.join(root, "Outside");
    const staging = path.join(root, "staging");
    await fs.promises.mkdir(outside, { mode: 0o700 });
    await fs.promises.mkdir(staging, { mode: 0o700 });

    await expect(
      moveCuratedArtifactToImportStaging({
        root,
        artifactDirectory: outside,
        stagingDirectory: staging,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CURATED_WORKSPACE" });
  });
});
