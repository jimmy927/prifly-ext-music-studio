/** Small DOM helpers: element builder and inline SVG icons (no emoji anywhere). */

export type Child = Node | string | null | false | undefined;
type Attr = string | boolean | number | ((event: Event) => void);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (typeof value === "function") node.addEventListener(name.slice(2), value);
    else if (name === "class") node.className = String(value);
    else if (typeof value === "boolean") node.toggleAttribute(name, value);
    else node.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Replaces everything inside `parent`. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(
    ...children.filter(
      (child): child is Node | string => child !== null && child !== false && child !== undefined,
    ),
  );
}

const PATHS: Record<string, string> = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  library: '<path d="M5 4v16M10 4v16M15 6l4 14"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 016 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

/** An inline SVG icon from a fixed set; the markup is ours, never data. */
export function icon(name: keyof typeof PATHS, size = 16): SVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
  return wrap.firstElementChild as SVGElement;
}
