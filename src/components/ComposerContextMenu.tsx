import { useEffect, useState } from "react";
import { ContextMenu, type ContextMenuOption } from "./ContextMenu";
import { openAccountSettings } from "../store/settings";
import { useChat } from "../store/chat";
import { ANONYMOUS } from "../types";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { copyComposerSelection, replaceComposerSelection, type ComposerSelection } from "../lib/composerEditing";

export type ComposerMenuState = {
  x: number;
  y: number;
  selection?: ComposerSelection;
  clipboard?: Promise<string>;
};

export function ComposerContextMenu({ tabId, menu, onEdit, onError, onClose }: {
  tabId: string;
  menu: ComposerMenuState;
  onEdit: (value: string, caret: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const accounts = useChat((state) => state.auth.accounts);
  const account = useChat((state) => state.tabs.find((tab) => tab.id === tabId)?.account);
  const [canPaste, setCanPaste] = useState(false);
  useEffect(() => {
    let active = true;
    setCanPaste(false);
    void menu.clipboard?.then(
      (text) => { if (active) setCanPaste(text.replace(/[\r\n]/g, "").length > 0); },
      () => { if (active) setCanPaste(false); },
    );
    return () => { active = false; };
  }, [menu]);

  const selection = menu.selection;
  const hasSelection = !!selection && selection.start !== selection.end;
  const replace = (text: string) => {
    if (!selection) return;
    const next = replaceComposerSelection(selection, text);
    onEdit(next.value, next.caret);
  };
  const copy = async (cut: boolean) => {
    if (!selection) return;
    if (await copyComposerSelection(selection, writeClipboardText) && cut) replace("");
  };
  const run = (action: () => Promise<void>) => {
    void action().catch(() => onError("Couldn't access the clipboard. Try again."));
  };
  const options: ContextMenuOption[] = [{
    label: "Active account",
    submenu: [...[...accounts.map((item) => ({ id: item.id, login: item.login })),
      { id: ANONYMOUS, login: "Anonymous" }].map((item) => ({
      label: `${item.login}${item.id === account ? " ✓" : ""}`,
      onSelect: () => { void useChat.getState().setTabAccount(tabId, item.id); },
    })), { separator: true }, { label: "Add new account...", onSelect: openAccountSettings }],
  }];
  if (selection) options.push(
    { separator: true },
    { label: "Cut", disabled: !hasSelection, onSelect: () => run(() => copy(true)) },
    { label: "Copy", disabled: !hasSelection, onSelect: () => run(() => copy(false)) },
    { label: "Paste", disabled: !canPaste, onSelect: () => run(async () => {
      const text = await readClipboardText();
      if (text.replace(/[\r\n]/g, "")) replace(text);
    }) },
  );
  return <ContextMenu x={menu.x} y={menu.y} options={options} onClose={onClose}
    autoFocus label={selection ? "Composer" : "Composer account"} />;
}
