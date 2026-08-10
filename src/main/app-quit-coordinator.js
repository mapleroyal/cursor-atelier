export function createAppQuitCoordinator({
  cleanup,
  exit,
  queueExit = setImmediate,
  onError = (error) => console.error("App shutdown cleanup failed.", error),
} = {}) {
  if (
    typeof cleanup !== "function" ||
    typeof exit !== "function" ||
    typeof queueExit !== "function" ||
    typeof onError !== "function"
  ) {
    throw new TypeError("App quit coordinator dependencies are incomplete.");
  }
  let stopping = false;
  let exiting = false;

  return {
    handleBeforeQuit(event) {
      if (exiting) {
        return;
      }
      event.preventDefault();
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        cleanup();
      } catch (error) {
        try {
          onError(error);
        } catch (reportingError) {
          console.error("App shutdown error reporter failed.", reportingError);
        }
      }
      queueExit(() => {
        if (exiting) {
          return;
        }
        exiting = true;
        exit(0);
      });
    },
  };
}
