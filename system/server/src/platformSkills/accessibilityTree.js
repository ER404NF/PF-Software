function decodeXml(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function normalizeUiText(value) {
  return String(value ?? "").toLowerCase().replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function frameFrom(node) {
  const frame = node?.frame && typeof node.frame === "object" ? node.frame : node;
  const x = Number(frame?.x);
  const y = Number(frame?.y);
  const width = Number(frame?.width ?? frame?.w);
  const height = Number(frame?.height ?? frame?.h);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height } : null;
}

function jsonElements(tree) {
  const elements = [];
  const seen = new WeakSet();
  function visit(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const fields = ["type", "role", "id", "identifier", "name", "label", "value", "text", "screen", "app"];
    const text = fields.map((key) => node[key]).filter((value) => typeof value === "string").join(" ");
    const frame = frameFrom(node);
    if (text || frame) elements.push({ text: normalizeUiText(text), frame, raw: node });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  visit(tree);
  return elements;
}

function xmlElements(xml) {
  const elements = [];
  const tagPattern = /<([A-Za-z][\w:.-]*)\b([^>]*)>/g;
  let tag;
  while ((tag = tagPattern.exec(xml))) {
    const attrs = Object.create(null);
    const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrPattern.exec(tag[2]))) attrs[attr[1]] = decodeXml(attr[2] ?? attr[3] ?? "");
    if (attrs.visible === "false" || attrs.enabled === "false") continue;
    const text = [tag[1], attrs.type, attrs.name, attrs.label, attrs.value, attrs.identifier]
      .filter(Boolean).join(" ");
    elements.push({ text: normalizeUiText(text), frame: frameFrom(attrs), raw: attrs });
  }
  return elements;
}

export function uiElements(tree) {
  if (typeof tree === "string") return xmlElements(tree);
  if (tree && typeof tree === "object") return jsonElements(tree);
  return [];
}

export function uiText(tree) {
  return uiElements(tree).map((element) => element.text).filter(Boolean).join(" ");
}

export function includesAny(text, patterns = []) {
  const normalized = normalizeUiText(text);
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  return patterns.some((pattern) => {
    const needle = normalizeUiText(pattern);
    if (!needle) return false;
    // A one- or two-character app name such as X must match a standalone
    // accessibility token. Plain substring matching would treat every
    // XCUIElementType* node as an X target and could tap the application
    // frame instead of the actual icon.
    return needle.length <= 2 ? tokens.has(needle) : normalized.includes(needle);
  });
}

export function findAccessibleElement(tree, patterns = []) {
  const needles = patterns.map(normalizeUiText).filter(Boolean);
  return uiElements(tree).find((element) => {
    if (!element.frame) return false;
    const tokens = new Set(element.text.split(" ").filter(Boolean));
    return needles.some((needle) => needle.length <= 2
      ? tokens.has(needle)
      : element.text === needle || element.text.includes(needle));
  }) ?? null;
}

export function normalizedCenter(tree, element) {
  if (!element?.frame) throw new Error("accessible target has no usable frame");
  const framed = uiElements(tree).filter((candidate) => candidate.frame);
  const width = Math.max(...framed.map(({ frame }) => frame.x + frame.width), 0);
  const height = Math.max(...framed.map(({ frame }) => frame.y + frame.height), 0);
  if (!(width > 0 && height > 0)) throw new Error("UI tree has no usable viewport");
  return {
    x: Math.max(0, Math.min(1, (element.frame.x + element.frame.width / 2) / width)),
    y: Math.max(0, Math.min(1, (element.frame.y + element.frame.height / 2) / height)),
  };
}

export function observationTree(observation) {
  return observation?.ui_tree ?? null;
}
