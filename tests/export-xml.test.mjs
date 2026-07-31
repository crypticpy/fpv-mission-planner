import test from 'node:test';
import assert from 'node:assert/strict';

import { XML_DECLARATION, buildXml, escapeXml, localName, parseXml, xmlNode } from '../src/infrastructure/export/xml.js';

/* This is the import security gate (ADR 0010 §4). An imported .gpx or .mission
 * is a file a stranger produced, and the two attacks XML invites — XXE through
 * an external entity, and entity expansion through a nested one — are refused
 * here rather than survived: no DOCTYPE, no ENTITY, no processing instruction
 * but the declaration, and only the five predefined entities decode. So most of
 * what follows asserts a *refusal*, with the machine-readable code that says
 * which one, because "it didn't crash" is not the property we need. The rest
 * asserts that what does get through is inert text. */

/** Control characters, built rather than typed, so this file stays plain text. */
const ch = (code) => String.fromCharCode(code);

const codeOf = (result) => result.errors[0]?.code;

/** Every refusal has the same shape: not ok, no tree, exactly one named error. */
function refused(xml, expected, note = '') {
  const result = parseXml(xml);
  assert.equal(result.ok, false, `should have been refused: ${xml.slice(0, 60)}`);
  assert.equal(result.root, null, 'a refused document yields no tree');
  assert.equal(result.errors.length, 1, 'the first fault is the reported one');
  assert.equal(codeOf(result), expected, note || `expected ${expected} for ${xml.slice(0, 60)}`);
  assert.equal(typeof result.errors[0].message, 'string');
  assert.equal(typeof result.errors[0].index, 'number');
  return result;
}

const parsed = (xml) => {
  const result = parseXml(xml);
  assert.equal(result.ok, true, `should have parsed: ${JSON.stringify(result.errors)}`);
  return result.root;
};

/* ---------- 1. the refusals ---------- */

test('a DOCTYPE is refused, external identifier and all', () => {
  refused('<!DOCTYPE gpx SYSTEM "http://example.invalid/gpx.dtd"><gpx/>', 'X-DOCTYPE-FORBIDDEN');
  refused(`${XML_DECLARATION}<!DOCTYPE gpx SYSTEM "file:///etc/passwd"><gpx/>`, 'X-DOCTYPE-FORBIDDEN');
  refused('<!doctype gpx><gpx/>', 'X-DOCTYPE-FORBIDDEN', 'case is not a way around it');
});

test('an XXE payload never reaches a file read', () => {
  const xxe = `${XML_DECLARATION}
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<gpx><name>&xxe;</name></gpx>`;
  const result = refused(xxe, 'X-DOCTYPE-FORBIDDEN');
  assert.match(result.errors[0].message, /DOCTYPE/);
});

test('a standalone ENTITY declaration is refused on its own account', () => {
  refused('<!ENTITY lol "ha"><gpx/>', 'X-ENTITY-FORBIDDEN');
});

test('billion laughs is refused at the door, not survived by an expansion budget', () => {
  const bomb = `${XML_DECLARATION}
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;
  refused(bomb, 'X-DOCTYPE-FORBIDDEN');
});

test('a custom entity dies a second time even with no declaration in sight', () => {
  // The DOCTYPE is the first door; this is the second. Neither is load-bearing
  // alone, which is the point.
  refused('<lolz>&lol3;</lolz>', 'X-ENTITY-UNKNOWN');
  refused('<a x="&custom;"/>', 'X-ENTITY-UNKNOWN');
});

test('processing instructions are refused wherever they appear', () => {
  refused('<?php system($_GET["c"]); ?><gpx/>', 'X-PI-FORBIDDEN');
  refused('<?xml-stylesheet type="text/xsl" href="evil.xsl"?><gpx/>', 'X-PI-FORBIDDEN');
  refused('<gpx><?php echo 1; ?></gpx>', 'X-PI-FORBIDDEN');
  refused(`${XML_DECLARATION}<?xml version="1.0"?><gpx/>`, 'X-PI-FORBIDDEN');
});

test('a leading XML declaration is the one processing instruction allowed', () => {
  assert.equal(parsed(`${XML_DECLARATION}<gpx/>`).name, 'gpx');
  assert.equal(parsed('<?xml version="1.0"?>\n<gpx/>').name, 'gpx');
  assert.equal(parsed(`${ch(0xFEFF)}${XML_DECLARATION}<gpx/>`).name, 'gpx', 'a BOM is skipped');
  refused('<?xml version="1.0"', 'X-DECL-UNTERMINATED');
});

test('mismatched, unclosed and stray tags end the parse', () => {
  refused('<a><b></a></b>', 'X-TAG-MISMATCH');
  refused('<a><b></b>', 'X-UNEXPECTED-EOF');
  refused('</a>', 'X-TAG-MISMATCH');
  refused('<a><b</a>', 'X-NAME-EXPECTED');
  refused('<a></a x>', 'X-TAG-UNTERMINATED');
  refused('<a /x>', 'X-TAG-UNTERMINATED');
  refused('<a>text', 'X-UNEXPECTED-EOF');
});

test('one root, and nothing outside it', () => {
  refused('<a/><b/>', 'X-TRAILING-CONTENT');
  refused('loose text<a/>', 'X-TEXT-OUTSIDE-ROOT');
  refused('<a/>trailing', 'X-TRAILING-CONTENT');
  refused('', 'X-EMPTY');
  refused('<!-- only a comment -->', 'X-EMPTY');
});

test('nesting is bounded, so a deeply nested document is an error not a stack overflow', () => {
  const deep = `${'<a>'.repeat(400)}${'</a>'.repeat(400)}`;
  refused(deep, 'X-DEPTH-EXCEEDED');
  assert.equal(parsed(`${'<a>'.repeat(200)}${'</a>'.repeat(200)}`).name, 'a');
});

test('input that is not text is refused rather than coerced', () => {
  for (const value of [null, undefined, 42, {}, ['<a/>']]) {
    const result = parseXml(value);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'X-INPUT-TYPE');
  }
});

/* ---------- 2. entities: the five, and numeric references ---------- */

test('the five predefined entities decode and nothing else does', () => {
  assert.equal(parsed('<a>&amp;&lt;&gt;&quot;&apos;</a>').text, '&<>"\'');
  refused('<a>&nbsp;</a>', 'X-ENTITY-UNKNOWN');
  refused('<a>&AMP;</a>', 'X-ENTITY-UNKNOWN', 'the names are case-sensitive');
  refused('<a>bare & ampersand</a>', 'X-ENTITY-UNTERMINATED');
  refused('<a>&unterminated</a>', 'X-ENTITY-UNTERMINATED');
});

test('numeric character references decode when the character is one we hold', () => {
  assert.equal(parsed('<a>&#65;&#x42;&#x43;</a>').text, 'ABC');
  assert.equal(parsed('<a>&#233;&#xE9;</a>').text, 'éé');
  assert.equal(parsed('<a>&#9;&#10;</a>').text, `${ch(9)}${ch(10)}`, 'tab and newline are legal');
  assert.equal(parsed('<a>&#128512;</a>').text, String.fromCodePoint(128512), 'astral planes survive');
});

test('a character reference to a control character is refused', () => {
  for (const ref of ['&#0;', '&#8;', '&#11;', '&#13;', '&#27;', '&#x7F;', '&#x85;', '&#x9F;']) {
    refused(`<a>${ref}</a>`, 'X-ENTITY-ILLEGAL-CHAR');
  }
  refused('<a>&#xD800;</a>', 'X-ENTITY-ILLEGAL-CHAR', 'a lone surrogate is not a character');
  refused('<a>&#x110000;</a>', 'X-ENTITY-ILLEGAL-CHAR', 'past the last code point');
  refused('<a>&#xZZ;</a>', 'X-ENTITY-MALFORMED');
  refused('<a>&#;</a>', 'X-ENTITY-MALFORMED');
});

/* ---------- 3. what does get through is inert ---------- */

test('escaped markup decodes to text and is never re-read as markup', () => {
  const root = parsed('<name>&lt;script&gt;alert(1)&lt;/script&gt;</name>');
  assert.equal(root.text, '<script>alert(1)</script>');
  assert.deepEqual(root.children, [], 'a decoded < opens no element');
});

test('a literal script element is just a node with a name, carrying inert text', () => {
  const root = parsed('<desc><script>alert(1)</script></desc>');
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].name, 'script');
  assert.equal(root.children[0].text, 'alert(1)');
  // And writing it back out escapes it, so a round trip cannot promote text
  // into markup.
  assert.equal(buildXml(xmlNode('desc', {}, [], root.children[0].text)), '<desc>alert(1)</desc>');
  assert.equal(
    buildXml(xmlNode('desc', {}, [], '<script>alert(1)</script>')),
    '<desc>&lt;script&gt;alert(1)&lt;/script&gt;</desc>',
  );
});

test('CDATA is text, taken verbatim, with no entity decoding inside it', () => {
  assert.equal(parsed('<a><![CDATA[<not markup> & raw &lol;]]></a>').text, '<not markup> & raw &lol;');
  assert.equal(parsed('<a>before<![CDATA[ mid ]]>after</a>').text, 'before mid after');
  refused('<a><![CDATA[unclosed</a>', 'X-CDATA-UNTERMINATED');
});

test("an element's text is its own character data, not its descendants'", () => {
  const root = parsed('<trk>name<trkseg>inner</trkseg>tail</trk>');
  assert.equal(root.text, 'nametail');
  assert.equal(root.children[0].text, 'inner');
});

/* ---------- 4. attributes ---------- */

test('attributes take either quote style and decode their entities', () => {
  const root = parsed(`<wpt lat="30.2672" lon='-97.7431' name="Bell &amp; Howell"/>`);
  assert.deepEqual(root.attrs, { lat: '30.2672', lon: '-97.7431', name: 'Bell & Howell' });
});

test('a malformed attribute is an error, not a guess', () => {
  refused('<a x=unquoted/>', 'X-ATTR-QUOTE');
  refused('<a x/>', 'X-ATTR-SYNTAX');
  refused('<a x="never closed/>', 'X-ATTR-UNTERMINATED');
  refused('<a x="1" x="2"/>', 'X-ATTR-DUPLICATE');
  refused('<a x="a<b"/>', 'X-ATTR-MARKUP');
});

test('a hostile attribute name lands as an own property and pollutes nothing', () => {
  const root = parsed('<a __proto__="polluted" constructor="also"/>');
  assert.equal(Object.hasOwn(root.attrs, '__proto__'), true);
  assert.equal(root.attrs.__proto__, 'polluted');
  assert.equal(Object.getPrototypeOf(root.attrs), Object.prototype, 'the prototype chain is untouched');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

/* ---------- 5. names, comments, namespaces ---------- */

test('namespace prefixes are kept verbatim and stripped on demand', () => {
  const root = parsed('<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1"><gpx:trk/></gpx:gpx>');
  assert.equal(root.name, 'gpx:gpx');
  assert.equal(localName(root.name), 'gpx');
  assert.equal(localName(root.children[0].name), 'trk');
  assert.equal(localName('trkpt'), 'trkpt');
  assert.equal(root.attrs['xmlns:gpx'], 'http://www.topografix.com/GPX/1/1');
});

test('comments are skipped wherever they are legal, and refused when unterminated', () => {
  const root = parsed('<!-- before --><a><!-- inside -->text<!-- more --></a><!-- after -->');
  assert.equal(root.text, 'text');
  assert.deepEqual(root.children, []);
  refused('<a><!-- unterminated </a>', 'X-COMMENT-UNTERMINATED');
});

test('a self-closing root is a document', () => {
  const root = parsed('<gpx version="1.1"/>');
  assert.deepEqual(root, { name: 'gpx', attrs: { version: '1.1' }, children: [], text: '' });
});

/* ---------- 6. the writer ---------- */

test('escapeXml is safe in both text and attribute position', () => {
  const hostile = `<script>alert("x" & 'y')</script>`;
  assert.equal(escapeXml(hostile), '&lt;script&gt;alert(&quot;x&quot; &amp; &apos;y&apos;)&lt;/script&gt;');
  assert.equal(escapeXml('a & b'), 'a &amp; b');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(42), '42');
});

test('escapeXml will not emit a character its own reader refuses', () => {
  assert.equal(escapeXml(`a${ch(0)}${ch(7)}${ch(27)}${ch(13)}b`), 'ab');
  assert.equal(escapeXml(`a${ch(9)}${ch(10)}b`), `a${ch(9)}${ch(10)}b`, 'tab and newline survive');
});

test('hostile strings round-trip through the writer and back', () => {
  for (const hostile of [
    `<script>alert("pwn")</script>`,
    `Bell & Howell's "ridge" <run>`,
    `]]> & &amp; &#0; <!DOCTYPE evil>`,
    `emoji 🛩 and accents éü`,
  ]) {
    const xml = buildXml(xmlNode('name', { title: hostile }, [], hostile));
    const root = parsed(xml);
    assert.equal(root.text, hostile, 'text survives the round trip unchanged');
    assert.equal(root.attrs.title, hostile, 'and so does an attribute value');
  }
});

test('buildXml emits a tree the reader accepts', () => {
  const tree = xmlNode('gpx', { version: '1.1', creator: 'fpv-planner' }, [
    xmlNode('metadata', {}, [xmlNode('name', {}, [], 'Pedernales ridge run')]),
    xmlNode('wpt', { lat: 30.2672, lon: -97.7431 }, [xmlNode('ele', {}, [], '168')]),
    xmlNode('empty', { dropped: null, kept: 0 }),
  ]);
  const xml = `${XML_DECLARATION}\n${buildXml(tree)}`;

  const root = parsed(xml);
  assert.equal(root.name, 'gpx');
  assert.deepEqual(root.attrs, { version: '1.1', creator: 'fpv-planner' });
  assert.equal(root.children[0].children[0].text, 'Pedernales ridge run');
  assert.deepEqual(root.children[1].attrs, { lat: '30.2672', lon: '-97.7431' });
  assert.equal(root.children[1].children[0].text, '168');
  assert.deepEqual(root.children[2].attrs, { kept: '0' }, 'a null attribute is dropped, a zero is not');
  assert.match(xml, /\n {2}<metadata>/, 'indented for a human reading the file');
});
