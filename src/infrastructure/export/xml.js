// xml.js — a strict XML subset, read and written by hand (ADR 0010 §4).
//
// GPX, KML and the INAV mission format are XML, so importing them means parsing
// XML from a file a stranger produced. `DOMParser` is not available in a worker
// or in node, and a vendor parser is a production dependency this app does not
// have — but the deciding reason is neither: a general XML parser is a large
// attack surface aimed squarely at the two attacks this format invites, and
// **the only XML security posture a hand-rolled reader can honestly claim is
// refusal**.
//
// So this reader refuses rather than survives:
//
//   `<!DOCTYPE` and `<!ENTITY` are rejected outright, before any content is
//     read. That is XXE (`SYSTEM "file:///etc/passwd"`) and entity expansion
//     (billion laughs) declined at the door rather than mitigated with an
//     expansion budget — there is no legitimate DOCTYPE in a flight plan.
//
//   processing instructions are rejected, except a leading `<?xml …?>`
//     declaration. `<?php`, `<?xml-stylesheet href="…">` and friends carry
//     instructions for somebody else's engine and have no business here.
//
//   only five entities decode — `&amp; &lt; &gt; &quot; &apos;` — plus numeric
//     references that land on a character this reader is willing to hold. Any
//     other reference is an error, which is the second place a declared custom
//     entity dies even if the first were somehow passed.
//
//   there is no recovery. A mismatched tag, an unterminated attribute or a
//     stray reference ends the parse with a machine-readable code. A parser that
//     guesses what a malformed document meant is a parser that disagrees with
//     the tool that wrote it, and disagreement about a flight plan is how a
//     waypoint moves.
//
// What survives is text. `<script>alert(1)</script>` inside an element parses to
// the literal characters of an inert text node, and every string leaving here
// goes through `sanitizeText` and reaches the DOM only as `textContent`.
//
// Namespace prefixes are kept verbatim in `name` — resolving them properly needs
// the namespace machinery this subset deliberately lacks, and vendor files bind
// prefixes inconsistently. Callers match on `localName(name)`.

/** @typedef {{ name: string, attrs: Record<string, string>, children: XmlNode[], text: string }} XmlNode */
/** @typedef {{ code: string, message: string, index: number }} XmlError */
/** @typedef {{ ok: boolean, root: XmlNode|null, errors: XmlError[] }} XmlParseResult */
/** @typedef {{ text: string, i: number, fault: XmlError|null }} Cursor */

/** The declaration a document this app writes opens with. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Deep enough for any exchange format, shallow enough that nesting is not a bomb. */
const MAX_DEPTH = 256;

/** `&#x10FFFF;` is the longest reference this reader accepts, at 10 characters. */
const MAX_REFERENCE_LEN = 12;

const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;
const NAME_CHAR = /[-A-Za-z0-9_:.\u00B7\u00C0-\uFFFF]/;
const WS = /[ \t\r\n]/;

/** The five, and only the five. A Map so no key of this table is inherited. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
]);

/* ---------- reading ---------- */

/**
 * The prefix-free part of a possibly namespaced name: `gpx:trkpt` → `trkpt`.
 * @param {string} name
 * @returns {string}
 */
export function localName(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Record the first fault and stop. Later faults are noise from a document that
 * already failed, and reporting the first is what points at the cause.
 * @param {Cursor} s @param {string} code @param {string} message @param {number} [index]
 * @returns {null}
 */
function bail(s, code, message, index) {
  if (!s.fault) s.fault = { code, message, index: index ?? s.i };
  return null;
}

/** @param {Cursor} s */
function skipWs(s) {
  while (s.i < s.text.length && WS.test(s.text[s.i])) s.i++;
}

/**
 * A character this reader will hold: XML's own set, minus the carriage return
 * and the C1 block. `\r` is refused with the rest of the control characters
 * because every string leaving here has its whitespace collapsed anyway, so a
 * reference to one carries nothing this app can keep.
 * @param {number} cp
 */
function isAllowedChar(cp) {
  if (cp === 0x09 || cp === 0x0A) return true;
  if (cp < 0x20 || cp === 0x7F) return false;
  if (cp >= 0x80 && cp <= 0x9F) return false;
  if (cp >= 0xD800 && cp <= 0xDFFF) return false;
  return cp <= 0x10FFFF;
}

/**
 * One reference body — what sat between `&` and `;`.
 * @param {string} body
 * @returns {{ value: string }|{ code: string, message: string }}
 */
function decodeReference(body) {
  const named = NAMED_ENTITIES.get(body);
  if (named !== undefined) return { value: named };
  if (body[0] !== '#') {
    return {
      code: 'X-ENTITY-UNKNOWN',
      message: `'&${body};' is not one of the five predefined entities, and this reader declares none.`,
    };
  }
  const hex = body[1] === 'x' || body[1] === 'X';
  const digits = hex ? body.slice(2) : body.slice(1);
  const shape = hex ? /^[0-9a-fA-F]{1,8}$/ : /^[0-9]{1,9}$/;
  if (!shape.test(digits)) {
    return { code: 'X-ENTITY-MALFORMED', message: `'&${body};' is not a well-formed character reference.` };
  }
  const cp = Number.parseInt(digits, hex ? 16 : 10);
  if (!isAllowedChar(cp)) {
    return {
      code: 'X-ENTITY-ILLEGAL-CHAR',
      message: `'&${body};' decodes to a character this reader refuses (control, surrogate, or out of range).`,
    };
  }
  return { value: String.fromCodePoint(cp) };
}

/**
 * `raw` with its references decoded, or null with the fault recorded.
 * @param {Cursor} s @param {string} raw @param {number} base absolute index of raw[0]
 * @returns {string|null}
 */
function decodeEntities(s, raw, base) {
  if (!raw.includes('&')) return raw;
  let out = '';
  let at = 0;
  while (at < raw.length) {
    const amp = raw.indexOf('&', at);
    if (amp === -1) { out += raw.slice(at); break; }
    out += raw.slice(at, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > MAX_REFERENCE_LEN) {
      return bail(s, 'X-ENTITY-UNTERMINATED',
        'A bare & is not text here; write &amp; or a terminated reference.', base + amp);
    }
    const decoded = decodeReference(raw.slice(amp + 1, semi));
    if (!('value' in decoded)) return bail(s, decoded.code, decoded.message, base + amp);
    out += decoded.value;
    at = semi + 1;
  }
  return out;
}

/** @param {Cursor} s @returns {string|null} */
function parseName(s) {
  const start = s.i;
  if (s.i >= s.text.length || !NAME_START.test(s.text[s.i])) {
    return bail(s, 'X-NAME-EXPECTED', 'Expected an element or attribute name.');
  }
  s.i++;
  while (s.i < s.text.length && NAME_CHAR.test(s.text[s.i])) s.i++;
  return s.text.slice(start, s.i);
}

/**
 * Attributes up to the `>` or `/>` that ends the start tag.
 *
 * Written with `defineProperty` rather than assignment: `__proto__` is a legal
 * XML name, and `attrs.__proto__ = value` on a plain object walks the prototype
 * chain instead of storing a key. This keeps hostile names as ordinary own
 * properties on an ordinary object.
 *
 * @param {Cursor} s @param {Record<string, string>} attrs
 * @returns {Record<string, string>|null}
 */
function parseAttrs(s, attrs) {
  for (;;) {
    skipWs(s);
    if (s.i >= s.text.length) return bail(s, 'X-UNEXPECTED-EOF', 'The document ended inside a start tag.');
    const c = s.text[s.i];
    if (c === '>' || c === '/') return attrs;

    const name = parseName(s);
    if (name === null) return null;
    skipWs(s);
    if (s.text[s.i] !== '=') {
      return bail(s, 'X-ATTR-SYNTAX', `Attribute '${name}' has no value; this reader requires name="value".`);
    }
    s.i++;
    skipWs(s);
    const quote = s.text[s.i];
    if (quote !== '"' && quote !== "'") {
      return bail(s, 'X-ATTR-QUOTE', `Attribute '${name}' must be quoted with " or '.`);
    }
    const end = s.text.indexOf(quote, s.i + 1);
    if (end === -1) return bail(s, 'X-ATTR-UNTERMINATED', `Attribute '${name}' is never closed.`);
    const raw = s.text.slice(s.i + 1, end);
    if (raw.includes('<')) {
      return bail(s, 'X-ATTR-MARKUP', `A '<' in attribute '${name}' is markup, not text.`, s.i + 1);
    }
    const value = decodeEntities(s, raw, s.i + 1);
    if (value === null) return null;
    if (Object.hasOwn(attrs, name)) return bail(s, 'X-ATTR-DUPLICATE', `Attribute '${name}' appears twice.`);
    Object.defineProperty(attrs, name, { value, writable: true, enumerable: true, configurable: true });
    s.i = end + 1;
  }
}

/**
 * The refusals, checked wherever markup can begin.
 * @param {Cursor} s @returns {null}
 */
function refuseDeclaration(s) {
  const ahead = s.text.slice(s.i, s.i + 9).toUpperCase();
  if (ahead.startsWith('<!DOCTYPE')) {
    return bail(s, 'X-DOCTYPE-FORBIDDEN',
      'A DOCTYPE declaration is refused: it is the door external entities and entity expansion come through.');
  }
  if (ahead.startsWith('<!ENTITY')) {
    return bail(s, 'X-ENTITY-FORBIDDEN', 'An ENTITY declaration is refused; only the five predefined entities decode.');
  }
  return bail(s, 'X-DECL-FORBIDDEN', 'Markup declarations are not part of the XML subset this reader accepts.');
}

/**
 * The element tree, walked with an explicit stack rather than recursion so a
 * deeply nested document is a bounded error instead of a blown call stack.
 * @param {Cursor} s
 * @returns {XmlNode|null}
 */
function parseElement(s) {
  /** @type {XmlNode[]} */ const stack = [];
  /** @type {XmlNode|null} */ let root = null;
  // Every branch below consumes at least one character, so this only ever fires
  // on a bug in this file — but the input is hostile, and a parse that cannot
  // loop forever is worth one counter (ADR 0010 §4).
  let budget = s.text.length * 2 + 64;

  for (;;) {
    if (budget-- <= 0) return bail(s, 'X-PARSE-BUDGET', 'This document did not parse within its input-length budget.');
    const t = s.text;
    if (s.i >= t.length) return bail(s, 'X-UNEXPECTED-EOF', 'The document ended inside an element.');
    const open = stack[stack.length - 1];

    if (t[s.i] !== '<') {
      const start = s.i;
      while (s.i < t.length && t[s.i] !== '<') s.i++;
      const chunk = decodeEntities(s, t.slice(start, s.i), start);
      if (chunk === null) return null;
      if (open) open.text += chunk;
      else if (chunk.trim() !== '') {
        return bail(s, 'X-TEXT-OUTSIDE-ROOT', 'Character data outside the root element.', start);
      }
      continue;
    }

    if (t.startsWith('<!--', s.i)) {
      const end = t.indexOf('-->', s.i + 4);
      if (end === -1) return bail(s, 'X-COMMENT-UNTERMINATED', 'A comment is never closed.');
      s.i = end + 3;
      continue;
    }

    if (t.startsWith('<![CDATA[', s.i)) {
      const end = t.indexOf(']]>', s.i + 9);
      if (end === -1) return bail(s, 'X-CDATA-UNTERMINATED', 'A CDATA section is never closed.');
      if (!open) return bail(s, 'X-TEXT-OUTSIDE-ROOT', 'Character data outside the root element.');
      open.text += t.slice(s.i + 9, end);
      s.i = end + 3;
      continue;
    }

    if (t.startsWith('<!', s.i)) return refuseDeclaration(s);

    if (t.startsWith('<?', s.i)) {
      return bail(s, 'X-PI-FORBIDDEN',
        'A processing instruction is refused; only a leading <?xml …?> declaration is accepted.');
    }

    if (t.startsWith('</', s.i)) {
      s.i += 2;
      const name = parseName(s);
      if (name === null) return null;
      skipWs(s);
      if (s.text[s.i] !== '>') return bail(s, 'X-TAG-UNTERMINATED', `The closing tag for '${name}' is malformed.`);
      s.i++;
      if (!open) return bail(s, 'X-TAG-MISMATCH', `Closing tag '${name}' has nothing open to close.`);
      if (open.name !== name) {
        return bail(s, 'X-TAG-MISMATCH', `Closing tag '${name}' does not match open element '${open.name}'.`);
      }
      stack.pop();
      if (stack.length === 0) return root;
      continue;
    }

    s.i++;
    const name = parseName(s);
    if (name === null) return null;
    /** @type {XmlNode} */ const node = { name, attrs: {}, children: [], text: '' };
    if (parseAttrs(s, node.attrs) === null) return null;

    const selfClosing = s.text[s.i] === '/';
    if (selfClosing) s.i++;
    if (s.text[s.i] !== '>') return bail(s, 'X-TAG-UNTERMINATED', `The start tag for '${name}' is malformed.`);
    s.i++;

    if (open) open.children.push(node);
    else root = node;

    if (selfClosing) {
      if (!open) return root;
      continue;
    }
    if (stack.length >= MAX_DEPTH) {
      return bail(s, 'X-DEPTH-EXCEEDED', `Elements are nested deeper than ${MAX_DEPTH}, which this reader refuses.`);
    }
    stack.push(node);
  }
}

/**
 * Parse a document in this subset.
 *
 * Never throws and never recovers: `ok` is false with one machine-readable
 * error, or true with a root. The caller is expected to have run
 * `assertSafeSize` first.
 *
 * @param {unknown} text
 * @returns {XmlParseResult}
 */
export function parseXml(text) {
  if (typeof text !== 'string') {
    return { ok: false, root: null, errors: [{ code: 'X-INPUT-TYPE', message: 'XML input must be text.', index: 0 }] };
  }
  /** @type {Cursor} */
  const s = { text, i: text.charCodeAt(0) === 0xFEFF ? 1 : 0, fault: null };
  /** @returns {XmlParseResult} */
  const failed = () => ({
    ok: false,
    root: null,
    errors: [s.fault ?? { code: 'X-PARSE', message: 'This document is not well-formed XML.', index: s.i }],
  });

  skipWs(s);
  // The one processing instruction with a place here, and only in first place.
  if (text.startsWith('<?xml', s.i) && (WS.test(text[s.i + 5] ?? '') || text.startsWith('?>', s.i + 5))) {
    const end = text.indexOf('?>', s.i);
    if (end === -1) { bail(s, 'X-DECL-UNTERMINATED', 'The XML declaration is never closed.'); return failed(); }
    s.i = end + 2;
  }

  // Whitespace and comments may precede the root; declarations may not.
  for (;;) {
    skipWs(s);
    if (!text.startsWith('<!--', s.i)) break;
    const end = text.indexOf('-->', s.i + 4);
    if (end === -1) { bail(s, 'X-COMMENT-UNTERMINATED', 'A comment is never closed.'); return failed(); }
    s.i = end + 3;
  }
  if (text.startsWith('<!', s.i)) { refuseDeclaration(s); return failed(); }
  if (text.startsWith('<?', s.i)) {
    bail(s, 'X-PI-FORBIDDEN', 'A processing instruction is refused; only a leading <?xml …?> declaration is accepted.');
    return failed();
  }
  if (s.i >= text.length) { bail(s, 'X-EMPTY', 'This document has no root element.'); return failed(); }

  const root = parseElement(s);
  if (!root) return failed();

  for (;;) {
    skipWs(s);
    if (!text.startsWith('<!--', s.i)) break;
    const end = text.indexOf('-->', s.i + 4);
    if (end === -1) { bail(s, 'X-COMMENT-UNTERMINATED', 'A comment is never closed.'); return failed(); }
    s.i = end + 3;
  }
  if (s.i < text.length) {
    bail(s, 'X-TRAILING-CONTENT', 'Content follows the root element; a document has exactly one root.');
    return failed();
  }

  return { ok: true, root, errors: [] };
}

/* ---------- writing ---------- */

/** @type {Record<string, string>} */
const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' });

/**
 * Text or an attribute value, safe in either position — `'` and `"` are escaped
 * along with the markup characters, so one function serves both and no caller
 * has to pick.
 *
 * Control characters are dropped rather than escaped: this writer will not emit
 * a character its own reader refuses to decode.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    if (!isAllowedChar(ch.codePointAt(0) ?? 0)) continue;
    out += ESCAPES[ch] ?? ch;
  }
  return out;
}

/**
 * A node for the writer, in the shape the reader produces.
 * @param {string} name
 * @param {Record<string, string|number|null|undefined>} [attrs]  null/undefined entries are dropped
 * @param {XmlNode[]} [children]
 * @param {string} [text]  emitted only when there are no children
 * @returns {XmlNode}
 */
export function xmlNode(name, attrs = {}, children = [], text = '') {
  /** @type {Record<string, string>} */ const kept = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) kept[key] = String(value);
  }
  return { name, attrs: kept, children, text };
}

/**
 * Serialize a node tree. Element and attribute *names* are not escaped — they
 * come from an adapter's own format knowledge, never from imported data, and
 * escaping them would produce a document no reader could parse.
 *
 * @param {XmlNode} node
 * @param {{ indent?: string, level?: number }} [options]
 * @returns {string}
 */
export function buildXml(node, { indent = '  ', level = 0 } = {}) {
  const pad = indent.repeat(level);
  const attrs = Object.entries(node.attrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  const children = node.children ?? [];
  if (children.length === 0) {
    const text = node.text ?? '';
    if (text === '') return `${pad}<${node.name}${attrs}/>`;
    return `${pad}<${node.name}${attrs}>${escapeXml(text)}</${node.name}>`;
  }
  const inner = children.map((child) => buildXml(child, { indent, level: level + 1 })).join('\n');
  return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`;
}
