// Coalesce desktop reset events and retry only failures while the desktop
// settles. Callers supply the shared application mutation queue.
export function createDesktopCursorReconciler({
  reconcile,
  onReconciled = () => {},
  onError = () => {},
  settleDelayMs = 250,
  retryDelaysMs = [500, 1_000, 3_000],
} = {}) {
  let stopped = false;
  let timer = null;
  let running = false;
  let pending = false;
  let selectAppearance = false;
  let retryIndex = 0;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(perform, delay);
    timer.unref?.();
  }

  async function perform() {
    timer = null;
    if (stopped || running) {
      return;
    }
    running = true;
    pending = false;
    const appearance = selectAppearance;
    selectAppearance = false;
    let nextDelay = settleDelayMs;
    try {
      const status = await reconcile({ selectAppearance: appearance });
      if (!stopped) {
        onReconciled(status);
      }
      retryIndex = 0;
    } catch (error) {
      if (!stopped) {
        // A newer event already queued another attempt. Otherwise retry this
        // incident a bounded number of times while the desktop settles.
        selectAppearance ||= appearance;
        if (!pending && retryIndex < retryDelaysMs.length) {
          nextDelay = retryDelaysMs[retryIndex++];
          pending = true;
        } else if (!pending) {
          selectAppearance = false;
          onError(error);
        }
      }
    } finally {
      running = false;
      if (!stopped && pending) {
        schedule(nextDelay);
      }
    }
  }

  function request({ selectAppearance: appearance = false } = {}) {
    if (stopped) {
      return;
    }
    pending = true;
    selectAppearance ||= appearance;
    retryIndex = 0;
    if (!running) {
      schedule(settleDelayMs);
    }
  }

  return {
    request,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
