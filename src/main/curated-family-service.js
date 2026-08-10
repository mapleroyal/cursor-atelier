const FAMILY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const THEME_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const INSTALL_BATCH_SIZE = 8;
const DEFAULT_ACQUISITION_CONCURRENCY = 4;
const MAX_FAILURE_DETAIL_LENGTH = 1_200;

function serviceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function normalizeProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  const percentage = number > 0 && number <= 1 ? number * 100 : number;
  return Math.round(Math.min(100, Math.max(0, percentage)));
}

function userFacingFailure(error) {
  if (error?.code === "INTEGRITY_FAILED") {
    return "The source download could not be verified. Try again.";
  }
  if (
    [
      "DOWNLOAD_FAILED",
      "SOURCE_TOO_LARGE",
      "NETWORK_FAILED",
      "LIMIT_EXCEEDED",
    ].includes(error?.code)
  ) {
    return "Download failed. Try again.";
  }
  if (error?.name === "AbortError") {
    return "Interrupted. Try again.";
  }
  return "Conversion failed. Try again.";
}

function failureDetail(error) {
  const code = ERROR_CODE.test(String(error?.code ?? ""))
    ? error.code
    : "CURATED_FAMILY_FAILED";
  const message = String(error?.message ?? "Curated family import failed.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FAILURE_DETAIL_LENGTH);
  return {
    code,
    message: message || "Curated family import failed.",
  };
}

function createConcurrencyGate(limit) {
  let active = 0;
  const waiting = [];

  const release = () => {
    active -= 1;
    while (waiting.length) {
      const entry = waiting.shift();
      if (entry.signal?.aborted) {
        continue;
      }
      entry.signal?.removeEventListener("abort", entry.abort);
      active += 1;
      entry.resolve(release);
      return;
    }
  };

  const acquire = (signal) => {
    signal?.throwIfAborted();
    if (active < limit) {
      active += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        abort: null,
        reject,
        resolve,
        signal,
      };
      entry.abort = () => {
        const index = waiting.indexOf(entry);
        if (index !== -1) {
          waiting.splice(index, 1);
        }
        reject(signal.reason);
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      waiting.push(entry);
    });
  };

  return async (signal, operation) => {
    const releaseSlot = await acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      releaseSlot();
    }
  };
}

function assertFamilyIds(familyIds, allowedFamilyIds) {
  if (!Array.isArray(familyIds)) {
    throw new TypeError("The starter family selection is invalid.");
  }
  const unique = new Set(familyIds);
  if (
    unique.size !== familyIds.length ||
    familyIds.some(
      (familyId) =>
        !FAMILY_ID.test(String(familyId ?? "")) ||
        !allowedFamilyIds.has(familyId),
    )
  ) {
    throw new TypeError("The starter family selection is invalid.");
  }
  return [...familyIds];
}

function variantEvent(event) {
  if (!event || typeof event !== "object") {
    throw serviceError(
      "INVALID_CONVERTER_EVENT",
      "The curated converter emitted an invalid event.",
    );
  }
  const identifier = String(event.identifier ?? "").trim();
  if (
    ["variant-start", "variant-complete"].includes(event.type) &&
    !THEME_ID.test(identifier)
  ) {
    throw serviceError(
      "INVALID_CONVERTER_EVENT",
      "The curated converter emitted an invalid theme identifier.",
    );
  }
  return {
    ...event,
    identifier: identifier || null,
    displayName:
      typeof event.displayName === "string" && event.displayName.trim()
        ? event.displayName.trim().slice(0, 160)
        : null,
    progress: normalizeProgress(event.progress),
  };
}

/**
 * Acquires a bounded number of curated families concurrently, while conversion
 * remains serial. Only transactional promotions use the global import lock.
 */
export function createCuratedFamilyService({
  familyIds,
  variantsByFamily,
  store,
  acquireFamilySources,
  releaseFamilySources = async () => {},
  getInstalledVariantIds = async () => null,
  convertFamily,
  installVariants,
  runInstallExclusive = (operation) => operation(),
  acquisitionConcurrency = DEFAULT_ACQUISITION_CONCURRENCY,
  onLibraryChanged = () => {},
  onError = (error, { familyId }) =>
    console.error(`Curated family ${familyId} failed.`, error),
} = {}) {
  const allowedFamilyIds = new Set(familyIds);
  const expectedVariants =
    variantsByFamily instanceof Map
      ? new Map(variantsByFamily)
      : new Map(Object.entries(variantsByFamily ?? {}));
  if (
    !Array.isArray(familyIds) ||
    familyIds.length !== allowedFamilyIds.size ||
    familyIds.some((familyId) => !FAMILY_ID.test(familyId)) ||
    expectedVariants.size !== allowedFamilyIds.size ||
    familyIds.some((familyId) => {
      const identifiers = expectedVariants.get(familyId);
      return (
        !Array.isArray(identifiers) ||
        identifiers.length === 0 ||
        identifiers.some((identifier) => !THEME_ID.test(identifier)) ||
        new Set(identifiers).size !== identifiers.length
      );
    }) ||
    !store ||
    typeof acquireFamilySources !== "function" ||
    typeof releaseFamilySources !== "function" ||
    typeof getInstalledVariantIds !== "function" ||
    typeof convertFamily !== "function" ||
    typeof installVariants !== "function" ||
    typeof runInstallExclusive !== "function" ||
    !Number.isSafeInteger(acquisitionConcurrency) ||
    acquisitionConcurrency < 1
  ) {
    throw new TypeError("Curated family service dependencies are incomplete.");
  }

  const withAcquisitionSlot = createConcurrencyGate(acquisitionConcurrency);
  let conversionQueue = Promise.resolve();
  let stopped = false;
  const running = new Map();
  const operations = new Set();

  const enqueueConversion = (operation) => {
    const result = conversionQueue.then(operation);
    conversionQueue = result.catch(() => undefined);
    return result;
  };

  const setJob = (familyId, patch) => {
    if (!stopped) {
      store.updateJob(familyId, patch);
    }
  };

  const reportError = (error, context) => {
    try {
      onError(error, context);
    } catch (reportingError) {
      console.error("Curated family error reporter failed.", reportingError);
    }
  };

  const run = async (familyId) => {
    if (stopped) {
      return;
    }
    const controller = new AbortController();
    running.set(familyId, controller);
    const persistedInstalled =
      store.get().jobs.find((job) => job.familyId === familyId)
        ?.installedVariantIds ?? [];
    const expected = new Set(expectedVariants.get(familyId));
    const installed = new Set(
      persistedInstalled.filter((identifier) => expected.has(identifier)),
    );
    const pending = [];
    let completed = false;
    const flushPending = async () => {
      if (!pending.length) {
        return;
      }
      const batch = pending.splice(0, pending.length);
      const last = batch.at(-1);
      setJob(familyId, {
        status: "installing",
        progress: last.progress,
        currentVariant: last.displayName ?? last.identifier,
      });
      const result = await runInstallExclusive(() =>
        installVariants({
          familyId,
          variants: batch.map((event) => ({
            artifactDirectory: event.artifactDirectory,
            expectedIdentifier: event.identifier,
          })),
          signal: controller.signal,
        }),
      );
      const identifiers = Array.isArray(result?.identifiers)
        ? result.identifiers
        : [];
      const batchIdentifiers = batch.map((event) => event.identifier);
      if (
        identifiers.length !== batch.length ||
        identifiers.some(
          (identifier, index) => identifier !== batchIdentifiers[index],
        )
      ) {
        throw serviceError(
          "INSTALLATION_MISMATCH",
          "The installed curated themes did not match the converted batch.",
        );
      }
      for (const identifier of batchIdentifiers) {
        installed.add(identifier);
      }
      setJob(familyId, {
        status: "converting",
        progress: last.progress,
        currentVariant: null,
        installedVariantIds: [...installed],
      });
      onLibraryChanged({
        reason: "curated-variants-installed",
        familyId,
        identifiers: batchIdentifiers,
      });
    };
    try {
      const discoveredInstalled = await getInstalledVariantIds({ familyId });
      if (Array.isArray(discoveredInstalled)) {
        installed.clear();
        for (const identifier of discoveredInstalled) {
          if (expected.has(identifier)) {
            installed.add(identifier);
          }
        }
      }
      if (installed.size === expected.size) {
        setJob(familyId, {
          status: "completed",
          progress: 100,
          error: null,
          failure: null,
          currentVariant: null,
          installedVariantIds: [...installed],
        });
        completed = true;
        return;
      }
      const acquired = await withAcquisitionSlot(
        controller.signal,
        async () => {
          setJob(familyId, {
            status: "downloading",
            progress: 0,
            error: null,
            failure: null,
            currentVariant: null,
            installedVariantIds: [...installed],
          });
          return acquireFamilySources({
            familyId,
            signal: controller.signal,
            onProgress: (progress) =>
              setJob(familyId, {
                status: "downloading",
                progress: normalizeProgress(progress),
              }),
          });
        },
      );
      if (!acquired || typeof acquired.sourceRoot !== "string") {
        throw serviceError(
          "INVALID_SOURCE_ROOT",
          "The curated source acquisition result is invalid.",
        );
      }

      await enqueueConversion(async () => {
        controller.signal.throwIfAborted();
        setJob(familyId, {
          status: "converting",
          progress: 0,
          error: null,
          failure: null,
          currentVariant: null,
        });
        await convertFamily({
          familyId,
          sourceRoot: acquired.sourceRoot,
          skipIdentifiers: [...installed],
          signal: controller.signal,
          onEvent: async (rawEvent) => {
            const event = variantEvent(rawEvent);
            if (event.type === "variant-start") {
              setJob(familyId, {
                status: "converting",
                progress: event.progress,
                currentVariant: event.displayName ?? event.identifier,
              });
              return;
            }
            if (event.type === "progress") {
              setJob(familyId, {
                status: "converting",
                progress: event.progress,
                currentVariant: event.displayName,
              });
              return;
            }
            if (["family-complete", "done", "failed"].includes(event.type)) {
              await flushPending();
              return;
            }
            if (event.type !== "variant-complete") {
              return;
            }
            if (!expected.has(event.identifier)) {
              throw serviceError(
                "INVALID_CONVERTER_EVENT",
                "The curated converter emitted a variant outside its family.",
              );
            }
            pending.push(event);
            if (pending.length >= INSTALL_BATCH_SIZE) {
              await flushPending();
            }
          },
        });
        const missing = [...expected].filter(
          (identifier) => !installed.has(identifier),
        );
        if (missing.length) {
          throw serviceError(
            "INCOMPLETE_CONVERSION",
            `The curated converter did not install ${missing[0]}.`,
          );
        }
        setJob(familyId, {
          status: "completed",
          progress: 100,
          error: null,
          failure: null,
          currentVariant: null,
          installedVariantIds: [...installed],
        });
        completed = true;
      });
    } catch (error) {
      if (!stopped) {
        setJob(familyId, {
          status: "failed",
          progress: null,
          error: userFacingFailure(error),
          failure: failureDetail(error),
          currentVariant: null,
          installedVariantIds: [...installed],
        });
        reportError(error, { familyId });
      }
    } finally {
      if (completed) {
        try {
          await releaseFamilySources({ familyId });
        } catch (error) {
          reportError(error, { familyId, cleanup: true });
        }
      }
      running.delete(familyId);
    }
  };

  const schedule = (familyId) => {
    const operation = run(familyId);
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
  };

  store.interruptRunning();

  return {
    getState() {
      return store.get();
    },
    start(selectedFamilyIds) {
      const selected = assertFamilyIds(selectedFamilyIds, allowedFamilyIds);
      const wasCompleted = store.get().completed;
      const state = store.start(selected);
      if (!wasCompleted) {
        for (const familyId of selected) {
          schedule(familyId);
        }
      }
      return state;
    },
    retry(familyId) {
      assertFamilyIds([familyId], allowedFamilyIds);
      if (running.has(familyId)) {
        throw new TypeError("The starter family retry is invalid.");
      }
      const state = store.retry(familyId);
      schedule(familyId);
      return state;
    },
    subscribe(listener) {
      return store.subscribe(listener);
    },
    stop() {
      stopped = true;
      for (const controller of running.values()) {
        controller.abort();
      }
    },
    async whenIdle() {
      while (operations.size) {
        await Promise.allSettled([...operations]);
      }
    },
  };
}
