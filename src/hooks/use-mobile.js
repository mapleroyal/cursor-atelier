import { useSyncExternalStore } from "react";

// The fixed pack rail needs enough room to leave a useful detail pane.
const MOBILE_QUERY = "(max-width: 959px)";

function subscribe(onChange) {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
