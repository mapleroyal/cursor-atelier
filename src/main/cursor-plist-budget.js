// Validate structural cost before the standard plist decoder allocates values.
// Cursor documents are shallow dictionaries with a small number of image tiers.
// This deliberately counts each reference visit, matching the decoder's work.
const MAX_OBJECT_VISITS = 100_000;
const MAX_DEPTH = 32;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

export function assertBinaryCursorPlistBudget(buffer) {
  const invalid = () => {
    const error = new Error(
      "The cursor plist has an invalid or overly complex structure.",
    );
    error.code = "INVALID_CURSOR";
    throw error;
  };
  const integer = (offset, size, end = buffer.length) => {
    if (![1, 2, 4, 8].includes(size) || offset < 0 || offset > end - size) {
      invalid();
    }
    const value =
      size === 8
        ? Number(buffer.readBigUInt64BE(offset))
        : buffer.readUIntBE(offset, size);
    if (!Number.isSafeInteger(value)) {
      invalid();
    }
    return value;
  };
  if (
    buffer.length < 40 ||
    buffer.subarray(0, 8).toString("ascii") !== "bplist00"
  ) {
    invalid();
  }
  const trailer = buffer.length - 32;
  const offsetSize = buffer[trailer + 6];
  const referenceSize = buffer[trailer + 7];
  const count = integer(trailer + 8, 8);
  const root = integer(trailer + 16, 8);
  const table = integer(trailer + 24, 8);
  if (
    count < 1 ||
    count > MAX_OBJECT_VISITS ||
    root >= count ||
    table < 8 ||
    ![1, 2, 4, 8].includes(offsetSize) ||
    ![1, 2, 4, 8].includes(referenceSize) ||
    table > trailer - count * offsetSize
  ) {
    invalid();
  }
  let visits = 0;
  let textBytes = 0;
  const ancestors = new Set();
  const visit = (index, depth, dictionaryKey = false) => {
    if (
      index >= count ||
      depth > MAX_DEPTH ||
      ++visits > MAX_OBJECT_VISITS ||
      ancestors.has(index)
    ) {
      invalid();
    }
    let offset = integer(table + index * offsetSize, offsetSize, trailer);
    if (offset < 8 || offset >= table) {
      invalid();
    }
    const marker = buffer[offset++];
    const type = marker >> 4;
    let size = marker & 15;
    if (dictionaryKey && type !== 5 && type !== 6) {
      invalid();
    }
    if ([4, 5, 6, 10, 13].includes(type) && size === 15) {
      if (offset >= table || buffer[offset] >> 4 !== 1) {
        invalid();
      }
      const width = 2 ** (buffer[offset++] & 15);
      size = integer(offset, width, table);
      offset += width;
    }
    let bytes;
    switch (type) {
      case 0:
        if (![0, 8, 9].includes(marker)) {
          invalid();
        }
        bytes = 0;
        break;
      case 1:
        bytes = 2 ** size;
        if (![1, 2, 4, 8].includes(bytes)) {
          invalid();
        }
        break;
      case 2:
        bytes = 2 ** size;
        if (![4, 8].includes(bytes)) {
          invalid();
        }
        break;
      case 3:
        if (size !== 3) {
          invalid();
        }
        bytes = 8;
        break;
      case 4:
        bytes = size;
        break;
      case 5:
      case 6:
        bytes = size * (type === 6 ? 2 : 1);
        textBytes += size * 2;
        if (textBytes > MAX_TEXT_BYTES) {
          invalid();
        }
        break;
      case 8:
        bytes = size + 1;
        if (![1, 2, 4, 8].includes(bytes)) {
          invalid();
        }
        break;
      case 10:
      case 13:
        bytes = size * referenceSize * (type === 13 ? 2 : 1);
        break;
      default:
        invalid();
    }
    if (!Number.isSafeInteger(bytes) || offset > table - bytes) {
      invalid();
    }
    if (type === 10 || type === 13) {
      const references = size * (type === 13 ? 2 : 1);
      if (references > MAX_OBJECT_VISITS - visits) {
        invalid();
      }
      ancestors.add(index);
      for (let entry = 0; entry < references; entry += 1) {
        visit(
          integer(offset + entry * referenceSize, referenceSize, table),
          depth + 1,
          type === 13 && entry < size,
        );
      }
      ancestors.delete(index);
    }
  };
  visit(root, 0);
}
