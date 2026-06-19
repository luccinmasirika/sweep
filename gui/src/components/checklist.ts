// Checkable, keyboard-friendly list. Used by cleanup/privacy/maintenance for
// selectable findings. Each row shows a checkbox, a label (+ optional note),
// and a right-aligned detail (typically a formatted size). Risky rows are
// visually flagged and default to unchecked. onChange fires with the ids of
// the currently checked items.

import { el } from "./dom";

export interface CheckItem {
  id: string;
  label: string;
  detail?: string;
  note?: string;
  checked?: boolean;
  risky?: boolean;
  disabled?: boolean;
}

export interface CheckListOptions {
  onChange?: (checkedIds: string[]) => void;
  className?: string;
}

export interface CheckListHandle {
  element: HTMLElement;
  checkedIds(): string[];
  setAll(checked: boolean): void;
}

export function checkList(
  items: CheckItem[],
  opts: CheckListOptions = {}
): CheckListHandle {
  const state = new Map<string, boolean>();
  const boxes = new Map<string, HTMLInputElement>();

  const root = el("ul", {
    class: ["checklist", opts.className].filter(Boolean).join(" "),
    role: "group",
  });

  const emit = () => opts.onChange?.(checkedIds());
  const checkedIds = () =>
    items.filter((i) => state.get(i.id)).map((i) => i.id);

  for (const item of items) {
    const initial = item.checked ?? !item.risky;
    state.set(item.id, initial && !item.disabled);

    const box = el("input", {
      type: "checkbox",
      class: "checklist-box",
      checked: state.get(item.id)!,
      disabled: item.disabled || false,
    }) as HTMLInputElement;
    boxes.set(item.id, box);

    box.addEventListener("change", () => {
      state.set(item.id, box.checked);
      emit();
    });

    const label = el("label", {
      class: ["checklist-row", item.risky && "is-risky", item.disabled && "is-disabled"]
        .filter(Boolean)
        .join(" "),
    }, [
      box,
      el("span", { class: "checklist-text" }, [
        el("span", { class: "checklist-label" }, item.label),
        item.note && el("span", { class: "checklist-note" }, item.note),
      ]),
      item.risky && el("span", { class: "tag tag-warn" }, "risky"),
      item.detail &&
        el("span", { class: "checklist-detail" }, item.detail),
    ]);

    root.appendChild(el("li", null, label));
  }

  return {
    element: root,
    checkedIds,
    setAll(checked: boolean) {
      for (const item of items) {
        if (item.disabled) continue;
        state.set(item.id, checked);
        const box = boxes.get(item.id);
        if (box) box.checked = checked;
      }
      emit();
    },
  };
}
