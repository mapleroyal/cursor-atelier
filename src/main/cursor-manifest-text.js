const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u;

export function sanitizeCursorManifestText(value) {
  return [...String(value)]
    .map((character) =>
      CONTROL_CHARACTER_PATTERN.test(character) ? " " : character,
    )
    .join("");
}

export function isBoundedCursorManifestText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}
