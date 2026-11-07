export const PARAGRAPH_SELECTOR =
  'p,h1,h2,h3,h4,h5,h6,li,td,th,dd,dt,blockquote,figcaption,caption,summary,label,[data-opao-paragraph]';
const phrasingTags = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'BR',
  'CITE',
  'CODE',
  'DEL',
  'EM',
  'I',
  'IMG',
  'INS',
  'KBD',
  'MARK',
  'Q',
  'RUBY',
  'RT',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR',
  'WBR',
  'MATH',
  'SVG',
  'MJX-CONTAINER',
]);
const controls = 'input,textarea,select,button,[contenteditable]:not([contenteditable=false])';
function query(root, selector) {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}
function elementMatches(node, selector) {
  return node.nodeType === Node.ELEMENT_NODE && node.matches(selector);
}
function significantSibling(node, direction) {
  let next = node[direction];
  while (next?.nodeType === Node.TEXT_NODE && !next.textContent.trim()) next = next[direction];
  return next;
}
function isParagraphBreak(node) {
  return (
    elementMatches(node, 'br') &&
    (elementMatches(significantSibling(node, 'previousSibling'), 'br') ||
      elementMatches(significantSibling(node, 'nextSibling'), 'br'))
  );
}
export function paragraphElements(
  root,
  { preferred = [], additional = [], excluded, generated, existing },
) {
  const displays = new WeakMap();
  const display = (element) => {
    if (!displays.has(element)) displays.set(element, getComputedStyle(element).display);
    return displays.get(element);
  };
  const inlineLayout = (element) =>
    /flex|grid/.test(display(element)) &&
    [...element.children].every(
      (child) => phrasingTags.has(child.tagName) && !child.matches('[data-opao-ui],.opao-target'),
    );
  const isBoundary = (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'BR') return false;
    if (node.matches('[data-opao-ui],.opao-target,' + controls)) return true;
    if (node.matches('code,kbd,math,svg,mjx-container')) return false;
    return (
      node.matches(PARAGRAPH_SELECTOR) ||
      !['inline', 'contents', 'inline-block', 'inline-flex', 'inline-grid'].includes(display(node))
    );
  };
  const nearest = (parent) => {
    for (
      let ancestor = parent;
      ancestor && root.contains(ancestor);
      ancestor = ancestor.parentElement
    )
      if (existing.has(ancestor)) return ancestor;
    let element = parent;
    while (element && root.contains(element)) {
      const parent = element.parentElement;
      if (
        parent &&
        root.contains(parent) &&
        inlineLayout(parent) &&
        !parent.matches('[data-opao-ui]')
      ) {
        element = parent;
        continue;
      }
      if (!['inline', 'contents'].includes(display(element))) return element;
      element = parent;
    }
    return null;
  };
  const selected = preferred.flatMap((selector) => query(root, selector));
  const scopes = [...new Set(selected.length ? selected : [root])];
  const candidates = new Set();
  const collectScope = (scope) => {
    if (scope.nodeType === Node.ELEMENT_NODE && scope.matches(PARAGRAPH_SELECTOR))
      candidates.add(scope);
    for (const element of query(scope, PARAGRAPH_SELECTOR)) candidates.add(element);
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent && scope instanceof ShadowRoot && walker.currentNode.textContent.trim()) {
        candidates.add(scope);
        continue;
      }
      if (
        !parent ||
        !walker.currentNode.textContent.trim() ||
        parent.closest(PARAGRAPH_SELECTOR) ||
        parent.closest('.opao-source') ||
        excluded(parent)
      )
        continue;
      const element = nearest(parent);
      if (element) candidates.add(element);
      else if (scope instanceof ShadowRoot) candidates.add(scope);
    }
  };
  for (const scope of scopes) collectScope(scope);
  for (const selector of additional) for (const scope of query(root, selector)) collectScope(scope);
  const elements = [];
  const wrapRuns = (container) => {
    let run = [];
    const flush = () => {
      const content = run
        .map((node) =>
          node.nodeType === Node.TEXT_NODE
            ? node.textContent
            : node.matches('code,kbd,math,svg,mjx-container')
              ? ''
              : node.textContent,
        )
        .join('');
      if (content.trim().length >= 2 && /[\p{L}\p{N}]/u.test(content)) {
        const wrapper = document.createElement('span');
        wrapper.dataset.opaoParagraph = 'true';
        run[0].before(wrapper);
        for (const node of run) wrapper.append(node);
        generated.add(wrapper);
        elements.push(wrapper);
      }
      run = [];
    };
    for (const node of [...container.childNodes]) {
      if (isBoundary(node) || isParagraphBreak(node)) {
        flush();
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) run.push(node);
    }
    flush();
  };
  for (const element of candidates) {
    if (element instanceof ShadowRoot) {
      wrapRuns(element);
      continue;
    }
    if (existing.has(element)) {
      elements.push(element);
      continue;
    }
    if (!(element instanceof HTMLElement) || excluded(element) || element.querySelector(controls))
      continue;
    const meaningful = [...element.childNodes].filter(
      (node) =>
        !(node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) &&
        !elementMatches(node, '.opao-target'),
    );
    const split =
      meaningful.some(isParagraphBreak) || (!inlineLayout(element) && meaningful.some(isBoundary));
    if (split || ['BODY', 'HTML'].includes(element.tagName)) wrapRuns(element);
    else elements.push(element);
  }
  return [...new Set(elements)]
    .filter((element) => !elements.some((other) => other !== element && other.contains(element)))
    .sort((a, b) => {
      const relation = a.compareDocumentPosition(b);
      return relation & Node.DOCUMENT_POSITION_DISCONNECTED
        ? 0
        : relation & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1;
    });
}
