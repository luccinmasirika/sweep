// Tiny hyperscript helper. Keeps screens free of verbose createElement chains
// while staying dependency-free. Props map to attributes/properties; a few are
// special-cased (class/className, style object, dataset, on* listeners).

export type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  className?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  children?: Child | Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;

      if (key === "class" || key === "className") {
        node.className = String(value);
      } else if (key === "style") {
        if (typeof value === "string") node.style.cssText = value;
        else Object.assign(node.style, value);
      } else if (key === "dataset") {
        Object.assign(node.dataset, value as Record<string, string>);
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(
          key.slice(2).toLowerCase(),
          value as EventListener
        );
      } else if (key in node) {
        // Set as a property when the element exposes one (e.g. value, checked).
        (node as Record<string, unknown>)[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  appendChildren(node, children);
  return node;
}

function appendChildren(node: HTMLElement, children?: Child | Child[]): void {
  if (children == null || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) appendChildren(node, child);
    return;
  }
  if (children instanceof Node) {
    node.appendChild(children);
  } else {
    node.appendChild(document.createTextNode(String(children)));
  }
}
