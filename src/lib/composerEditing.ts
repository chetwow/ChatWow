export type ComposerSelection = { value: string; start: number; end: number };

/** Match the single-line input's handling of pasted line breaks. */
export function replaceComposerSelection(selection: ComposerSelection, text: string) {
  const replacement = text.replace(/[\r\n]/g, "");
  return {
    value: selection.value.slice(0, selection.start) + replacement + selection.value.slice(selection.end),
    caret: selection.start + replacement.length,
  };
}

export async function copyComposerSelection(
  selection: ComposerSelection,
  write: (text: string) => Promise<void>,
) {
  if (selection.start === selection.end) return false;
  await write(selection.value.slice(selection.start, selection.end));
  return true;
}
