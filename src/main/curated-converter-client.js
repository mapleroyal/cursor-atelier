import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import sharp from "sharp";

const FAMILY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THEME_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_RENDER_DIMENSION = 8192;
const MAX_SVG_BYTES = 16 * 1024 * 1024;

function clientError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function integerDimension(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) &&
    number > 0 &&
    number <= MAX_RENDER_DIMENSION
    ? number
    : null;
}

async function regularFileWithin(roots, candidate, extensions) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    return null;
  }
  let canonical;
  let stat;
  try {
    canonical = await fs.promises.realpath(candidate);
    stat = await fs.promises.lstat(canonical);
  } catch {
    return null;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_SVG_BYTES ||
    !extensions.has(path.extname(canonical).toLocaleLowerCase()) ||
    !roots.some((root) => isWithin(root, canonical))
  ) {
    return null;
  }
  return canonical;
}

async function safeNewOutput(roots, candidate) {
  if (
    typeof candidate !== "string" ||
    !path.isAbsolute(candidate) ||
    path.extname(candidate).toLocaleLowerCase() !== ".png"
  ) {
    return null;
  }
  let parent;
  try {
    parent = await fs.promises.realpath(path.dirname(candidate));
    const stat = await fs.promises.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    await fs.promises.lstat(candidate);
    return null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return null;
    }
  }
  if (!roots.some((root) => isWithin(root, parent))) {
    return null;
  }
  const output = path.join(parent, path.basename(candidate));
  return path.dirname(output) === parent ? output : null;
}

async function renderSvgRequest(event, { sourceRoot, outputRoot, sharpImpl }) {
  const requestId = String(event?.requestId ?? "");
  if (!requestId || requestId.length > 160) {
    throw clientError(
      "INVALID_RENDER_REQUEST",
      "The curated converter emitted an invalid render request.",
    );
  }
  const roots = [sourceRoot, outputRoot];
  const sourcePath = await regularFileWithin(
    roots,
    event.sourcePath,
    new Set([".svg", ".svgz"]),
  );
  const outputPath = await safeNewOutput([outputRoot], event.outputPath);
  const width = integerDimension(event.width, event.size);
  const height = integerDimension(event.height, event.size);
  if (!sourcePath || !outputPath || !width || !height) {
    throw clientError(
      "INVALID_RENDER_REQUEST",
      "The curated converter emitted an unsafe render request.",
    );
  }

  const metadata = await sharpImpl(sourcePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw clientError(
      "SVG_RENDER_FAILED",
      "The curated SVG has no renderable dimensions.",
    );
  }
  const baseDensity = Number(metadata.density) || 72;
  const density = Math.min(
    100_000,
    Math.max(
      baseDensity,
      baseDensity * Math.max(width / metadata.width, height / metadata.height),
    ),
  );
  const temporaryPath = `${outputPath}.rendering-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await sharpImpl(sourcePath, { density })
      .resize(width, height, { fit: "fill" })
      .png()
      .toFile(temporaryPath);
    const rendered = await sharpImpl(temporaryPath).metadata();
    if (rendered.width !== width || rendered.height !== height) {
      throw clientError(
        "SVG_RENDER_FAILED",
        "The curated SVG renderer produced unexpected dimensions.",
      );
    }
    await fs.promises.rename(temporaryPath, outputPath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
  return requestId;
}

async function validateArtifactEvent(event, outputRoot) {
  if (
    !THEME_ID.test(String(event.identifier ?? "")) ||
    typeof event.artifactDirectory !== "string" ||
    !path.isAbsolute(event.artifactDirectory)
  ) {
    throw clientError(
      "INVALID_CONVERTER_EVENT",
      "The curated converter emitted an invalid completed variant.",
    );
  }
  const artifact = await fs.promises.realpath(event.artifactDirectory);
  const stat = await fs.promises.lstat(artifact);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    path.dirname(artifact) !== outputRoot ||
    !SAFE_ARTIFACT_NAME.test(path.basename(artifact))
  ) {
    throw clientError(
      "INVALID_CONVERTER_EVENT",
      "The curated converter artifact escaped its output directory.",
    );
  }
  return { ...event, artifactDirectory: artifact };
}

function writeProtocol(child, value) {
  return new Promise((resolve, reject) => {
    if (child.stdin.destroyed || !child.stdin.writable) {
      reject(
        clientError(
          "CURATED_CONVERSION_FAILED",
          "The curated converter protocol closed unexpectedly.",
        ),
      );
      return;
    }
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export async function convertCuratedFamily({
  command,
  commandArguments = [],
  familyId,
  sourceRoot,
  outputRoot,
  skipIdentifiers = [],
  onEvent = async () => {},
  signal,
  spawnImpl = spawn,
  sharpImpl = sharp,
  environment = process.env,
  idleTimeoutMs = 5 * 60 * 1_000,
  totalTimeoutMs = 2 * 60 * 60 * 1_000,
} = {}) {
  if (
    typeof command !== "string" ||
    !command ||
    !Array.isArray(commandArguments) ||
    !FAMILY_ID.test(String(familyId ?? "")) ||
    !Array.isArray(skipIdentifiers) ||
    skipIdentifiers.some((identifier) => !THEME_ID.test(identifier)) ||
    typeof onEvent !== "function" ||
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 1_000 ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < idleTimeoutMs
  ) {
    throw new TypeError("Curated converter options are invalid.");
  }
  signal?.throwIfAborted();
  const canonicalSource = await fs.promises.realpath(sourceRoot);
  const canonicalOutput = await fs.promises.realpath(outputRoot);
  const sourceStat = await fs.promises.lstat(canonicalSource);
  const outputStat = await fs.promises.lstat(canonicalOutput);
  if (
    !sourceStat.isDirectory() ||
    sourceStat.isSymbolicLink() ||
    !outputStat.isDirectory() ||
    outputStat.isSymbolicLink()
  ) {
    throw clientError(
      "INVALID_CONVERTER_ROOT",
      "The curated converter roots are invalid.",
    );
  }

  const arguments_ = [
    ...commandArguments,
    "convert",
    "--source-root",
    canonicalSource,
    "--output-root",
    canonicalOutput,
    "--family",
    familyId,
    ...skipIdentifiers.flatMap((identifier) => [
      "--skip-identifier",
      identifier,
    ]),
  ];
  const child = spawnImpl(command, arguments_, {
    cwd: canonicalOutput,
    env: { ...environment, CURSOR_ATELIER_SVG_RENDERER: "stdio" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let sawDone = false;
  let protocolError = null;
  let killTimer = null;
  let idleTimer = null;
  const terminate = () => {
    child.kill("SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref?.();
    }
  };
  const abort = () => terminate();
  const timedOut = (message) => {
    protocolError ??= clientError("CURATED_CONVERSION_TIMEOUT", message);
    terminate();
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => timedOut("The curated converter stopped responding."),
      idleTimeoutMs,
    );
    idleTimer.unref?.();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    terminate();
  }
  resetIdleTimer();
  const totalTimer = setTimeout(
    () => timedOut("The curated conversion took too long."),
    totalTimeoutMs,
  );
  totalTimer.unref?.();
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => {
    if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) {
      stderr += String(chunk).slice(
        0,
        MAX_STDERR_BYTES - Buffer.byteLength(stderr),
      );
    }
  });

  const exit = new Promise((resolve) => {
    child.once("error", (error) => {
      child.stdout.destroy();
      resolve({ error });
    });
    child.once("close", (code, childSignal) => resolve({ code, childSignal }));
  });

  let result;
  try {
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      resetIdleTimer();
      if (!line.trim()) {
        continue;
      }
      if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
        throw clientError(
          "INVALID_CONVERTER_EVENT",
          "The curated converter emitted an oversized event.",
        );
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw clientError(
          "INVALID_CONVERTER_EVENT",
          "The curated converter emitted malformed output.",
          error,
        );
      }
      if (event?.type === "render-svg") {
        try {
          const requestId = await renderSvgRequest(event, {
            sourceRoot: canonicalSource,
            outputRoot: canonicalOutput,
            sharpImpl,
          });
          await writeProtocol(child, {
            type: "render-svg-result",
            requestId,
            ok: true,
          });
        } catch (error) {
          await writeProtocol(child, {
            type: "render-svg-result",
            requestId: String(event?.requestId ?? ""),
            ok: false,
            error: error.message,
          });
        }
        continue;
      }
      if (event?.type === "variant-complete") {
        event = await validateArtifactEvent(event, canonicalOutput);
      }
      if (
        ["variant-started", "variant-complete", "family-complete"].includes(
          event?.type,
        ) &&
        event.familyId !== familyId
      ) {
        throw clientError(
          "INVALID_CONVERTER_EVENT",
          "The curated converter reported the wrong family.",
        );
      }
      if (event?.type === "variant-started") {
        event = { ...event, type: "variant-start" };
      }
      if (event?.type === "done") {
        sawDone = true;
      }
      await onEvent(event);
    }
  } catch (error) {
    protocolError = error;
    terminate();
  } finally {
    result = await exit;
    signal?.removeEventListener("abort", abort);
    if (killTimer) {
      clearTimeout(killTimer);
    }
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
  if (protocolError) {
    throw protocolError;
  }
  signal?.throwIfAborted();
  if (result.error) {
    throw clientError(
      "CURATED_CONVERSION_FAILED",
      "The curated converter could not be started.",
      result.error,
    );
  }
  if (result.code !== 0 || !sawDone) {
    throw clientError(
      "CURATED_CONVERSION_FAILED",
      stderr.trim() ||
        `The curated converter exited ${result.code ?? result.childSignal ?? "without completing"}.`,
    );
  }
}
