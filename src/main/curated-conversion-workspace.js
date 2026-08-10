import fs from "node:fs";
import path from "node:path";

const WORKSPACE_PREFIX = ".family-";
const WORKSPACE_NAME = /^\.family-[A-Za-z0-9]{6}$/;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(message) {
  const error = new Error(message);
  error.code = "UNSAFE_CURATED_WORKSPACE";
  throw error;
}

function ownedByCurrentUser(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function privateDirectory(stat) {
  return (
    stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
  );
}

async function ensurePrivateRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    fail("The curated conversion root must be an absolute path.");
  }
  try {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const stat = await fs.promises.lstat(root);
  if (!privateDirectory(stat) || !ownedByCurrentUser(stat)) {
    fail("The curated conversion root is not private.");
  }
  await fs.promises.chmod(root, 0o700);
  return fs.promises.realpath(root);
}

async function inspectWorkspace(root, workspace) {
  const canonicalRoot = await ensurePrivateRoot(root);
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
    fail("The curated conversion workspace is invalid.");
  }
  const stat = await fs.promises.lstat(workspace);
  if (!privateDirectory(stat) || !ownedByCurrentUser(stat)) {
    fail("The curated conversion workspace is not private.");
  }
  const canonicalWorkspace = await fs.promises.realpath(workspace);
  if (
    path.dirname(canonicalWorkspace) !== canonicalRoot ||
    !WORKSPACE_NAME.test(path.basename(canonicalWorkspace))
  ) {
    fail("The curated conversion workspace escaped its private root.");
  }
  return { canonicalRoot, canonicalWorkspace };
}

async function inspectTreeForRemoval(workspace) {
  const entries = [];
  const pending = [workspace];
  while (pending.length) {
    const current = pending.pop();
    const relative = path.relative(workspace, current);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("A curated conversion path escaped its workspace.");
    }
    const stat = await fs.promises.lstat(current);
    if (!ownedByCurrentUser(stat)) {
      fail("The curated conversion workspace contains foreign-owned data.");
    }
    if (stat.isSymbolicLink()) {
      entries.push({ path: current, type: "file" });
      continue;
    }
    if (stat.isDirectory()) {
      entries.push({ path: current, type: "directory" });
      for (const name of await fs.promises.readdir(current)) {
        pending.push(path.join(current, name));
      }
      continue;
    }
    if (stat.isFile() && stat.nlink === 1) {
      entries.push({ path: current, type: "file" });
      continue;
    }
    fail("The curated conversion workspace contains unsafe filesystem data.");
  }
  return entries.sort(
    (left, right) =>
      right.path.split(path.sep).length - left.path.split(path.sep).length,
  );
}

export async function createCuratedConversionWorkspace(root) {
  const canonicalRoot = await ensurePrivateRoot(root);
  const workspace = await fs.promises.mkdtemp(
    path.join(canonicalRoot, WORKSPACE_PREFIX),
  );
  await fs.promises.chmod(workspace, 0o700);
  return workspace;
}

export async function removeCuratedConversionWorkspace({ root, workspace }) {
  let inspected;
  try {
    inspected = await inspectWorkspace(root, workspace);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const entries = await inspectTreeForRemoval(inspected.canonicalWorkspace);
  for (const entry of entries) {
    if (entry.type === "directory") {
      await fs.promises.rmdir(entry.path);
    } else {
      await fs.promises.unlink(entry.path);
    }
  }
}

export async function reconcileCuratedConversionWorkspaces(root) {
  const canonicalRoot = await ensurePrivateRoot(root);
  const removed = [];
  const pending = [];
  for (const entry of await fs.promises.readdir(canonicalRoot, {
    withFileTypes: true,
  })) {
    if (!WORKSPACE_NAME.test(entry.name)) {
      continue;
    }
    const workspace = path.join(canonicalRoot, entry.name);
    try {
      await removeCuratedConversionWorkspace({
        root: canonicalRoot,
        workspace,
      });
      removed.push(entry.name);
    } catch {
      pending.push(entry.name);
    }
  }
  return { removed, pending, cleanupPending: pending.length > 0 };
}

export async function moveCuratedArtifactToImportStaging({
  root,
  artifactDirectory,
  stagingDirectory,
}) {
  const workspace = path.dirname(artifactDirectory);
  const { canonicalWorkspace } = await inspectWorkspace(root, workspace);
  const artifactStat = await fs.promises.lstat(artifactDirectory);
  const stagingStat = await fs.promises.lstat(stagingDirectory);
  if (
    !artifactStat.isDirectory() ||
    artifactStat.isSymbolicLink() ||
    !privateDirectory(stagingStat) ||
    !ownedByCurrentUser(stagingStat)
  ) {
    fail("The curated conversion artifact is unsafe.");
  }
  const canonicalArtifact = await fs.promises.realpath(artifactDirectory);
  const canonicalStaging = await fs.promises.realpath(stagingDirectory);
  const artifactName = path.basename(canonicalArtifact);
  if (
    path.dirname(canonicalArtifact) !== canonicalWorkspace ||
    !SAFE_ARTIFACT_NAME.test(artifactName)
  ) {
    fail("The curated conversion artifact escaped its workspace.");
  }
  const destination = path.join(canonicalStaging, artifactName);
  if (path.dirname(destination) !== canonicalStaging) {
    fail("The curated conversion artifact destination is invalid.");
  }
  await fs.promises.rename(canonicalArtifact, destination);
  return destination;
}
