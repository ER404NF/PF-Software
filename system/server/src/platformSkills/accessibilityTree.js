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
    if (node.visible === false || node.visible === "false" || node.enabled === false || node.enabled === "false"
      || node.hidden === true || node.hidden === "true") return;
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
  const stack = [];
  const tagPattern = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)\b([^>]*)>/g;
  let tag;
  while ((tag = tagPattern.exec(xml))) {
    const closing = tag[1] === "/";
    const name = tag[2];
    if (closing) {
      const index = stack.findLastIndex(entry => entry.name === name);
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = Object.create(null);
    const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrPattern.exec(tag[3]))) attrs[attr[1]] = decodeXml(attr[2] ?? attr[3] ?? "");
    const parent = stack.at(-1) ?? null;
    const hasGeometry = ["x", "y", "width", "height", "w", "h"].some(key => Object.hasOwn(attrs, key));
    const frame = frameFrom(attrs);
    const clipFrame = frame ?? parent?.clipFrame ?? null;
    const outsideParent = Boolean(frame && parent?.clipFrame
      && (frame.x + frame.width <= parent.clipFrame.x || frame.y + frame.height <= parent.clipFrame.y
        || frame.x >= parent.clipFrame.x + parent.clipFrame.width
        || frame.y >= parent.clipFrame.y + parent.clipFrame.height));
    const blocked = Boolean(parent?.blocked || attrs.visible === "false" || attrs.enabled === "false"
      || attrs.hidden === "true" || (hasGeometry && !frame) || outsideParent);
    const text = [name, attrs.type, attrs.name, attrs.label, attrs.value, attrs.identifier]
      .filter(Boolean).join(" ");
    if (!blocked) elements.push({ text: normalizeUiText(text), frame, raw: attrs });
    if (!/\/\s*$/.test(tag[3])) stack.push({ name, blocked, clipFrame });
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

export function findAccessibleElement(tree, patterns = [], eligible = () => true) {
  const needles = patterns.map(normalizeUiText).filter(Boolean);
  return uiElements(tree).find((element) => {
    if (!element.frame || !eligible(element)) return false;
    const tokens = new Set(element.text.split(" ").filter(Boolean));
    return needles.some((needle) => needle.length <= 2
      ? tokens.has(needle)
      : element.text === needle || element.text.includes(needle));
  }) ?? null;
}

export function normalizedCenter(tree, element) {
  if (!element?.frame) throw new Error("accessible target has no usable frame");
  const viewport = tree && typeof tree === "object"
    ? frameFrom({ x: 0, y: 0, ...(tree.viewport ?? tree.window ?? tree) })
    : uiElements(tree).find(candidate => /XCUIElementType(?:Application|Window)/i.test(candidate.text.replaceAll(" ", "")))?.frame;
  if (!viewport) throw new Error("UI tree has no explicit screen viewport");
  const x = element.frame.x + element.frame.width / 2;
  const y = element.frame.y + element.frame.height / 2;
  if (x < viewport.x || y < viewport.y || x > viewport.x + viewport.width || y > viewport.y + viewport.height) {
    throw new Error("accessible target is outside the viewport");
  }
  return { x: (x - viewport.x) / viewport.width, y: (y - viewport.y) / viewport.height };
}

export function observationTree(observation) {
  return observation?.ui_tree ?? null;
}
