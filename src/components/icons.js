// components/icons.js — <use> references into the inline fpv-symbols sprite
// (index.html carries it; design-concepts/round-2/final/developer-assets/ is
// the source asset). Every component icon goes through here, so a renamed or
// missing symbol is a one-file find rather than a hunt through templates.

/**
 * An inline SVG icon drawn from the sprite. Decorative always — components put
 * the meaning in visible text beside it, never in the icon alone (the round-2
 * accessibility rule: icon + label + severity + action, not color or shape).
 * @param {string} sym  symbol name without the `sym-` prefix, e.g. 'wind'
 * @param {string} cls  class for sizing/color
 */
export function icon(sym, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#sym-${sym}`);
  svg.appendChild(use);
  return svg;
}
