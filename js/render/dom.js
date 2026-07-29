// render/dom.js — shared DOM helpers.
export const $ = (id) => document.getElementById(id);

export function setTile(id, value, sub) {
  $(id).querySelector('.tile-value').textContent = value;
  if (sub !== undefined) $(id).querySelector('.tile-sub').textContent = sub;
}
