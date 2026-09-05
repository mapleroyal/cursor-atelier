import {
  cursorMatchesIdentifier,
  getCursorPreferenceId,
} from "../lib/cursor-preferences.js";

export async function reconcileCursorAtLogin({
  bridge,
  preferencesStore,
  getSystemAppearance,
}) {
  const status = await bridge.status();
  // Restore disables cursor persistence even if a selected theme is retained.
  if (status.desiredEnabled !== true) {
    return bridge.reconcileLoginItems();
  }
  const themes = await bridge.listThemes();
  const appearance = getSystemAppearance();
  const preference = `${appearance}CursorId`;
  const identifier = preferencesStore.get().appearance[preference];
  const assigned = themes.find(
    (theme) =>
      theme.canApply === true && cursorMatchesIdentifier(theme, identifier),
  );
  const assignmentIsCurrent = () =>
    getSystemAppearance() === appearance &&
    preferencesStore.get().appearance[preference] === identifier;
  // A cursor can be applied directly without either appearance assignment.
  const result = assigned
    ? await bridge.applyTheme(getCursorPreferenceId(assigned), {
        shouldApply: assignmentIsCurrent,
      })
    : await bridge.reconcileLoginItems();
  // Encoding and desktop application can outlast an appearance change. Finish
  // with the current assignment before a one-shot login process exits.
  if (result?.applySkipped === true || !assignmentIsCurrent()) {
    return reconcileCursorAtLogin({
      bridge,
      preferencesStore,
      getSystemAppearance,
    });
  }
  return result;
}
