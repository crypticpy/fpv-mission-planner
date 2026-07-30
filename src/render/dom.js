// render/dom.js — shared DOM helpers.
export const $ = (id) => document.getElementById(id);

/** Replace a `<select>`'s options with `items` ({ value, label }) and select `value`. */
export function fillSelect(sel, items, value) {
  sel.replaceChildren();
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  }
  sel.value = value;
}

export function setTile(id, value, sub) {
  $(id).querySelector('.tile-value').textContent = value;
  if (sub !== undefined) $(id).querySelector('.tile-sub').textContent = sub;
}
