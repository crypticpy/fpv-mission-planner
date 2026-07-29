// catalog/manufacturers.js — pack builders/brands.
// Pack builders/brands are separate from cell makers. This lets one custom
// builder (for example DIY500AMP) expose several cell recipes under one filter.
export const MANUFACTURERS = [
  { id: 'lumenier', name: 'Lumenier', kind: 'brand', url: 'https://www.getfpv.com/' },
  { id: 'ovonic', name: 'Ovonic', kind: 'brand', url: 'https://www.ampow.com/' },
  { id: 'cnhl', name: 'CNHL', kind: 'brand', url: 'https://chinahobbyline.com/' },
  { id: 'gnb', name: 'GNB / Gaoneng', kind: 'brand', url: 'https://www.gaoneng.shop/' },
  { id: 'geprc', name: 'GEPRC', kind: 'brand', url: 'https://geprc.com/' },
  { id: 'flywoo', name: 'Flywoo', kind: 'brand', url: 'https://flywoo.net/' },
  { id: 'rdq', name: 'RDQ', kind: 'brand', url: 'https://www.racedayquads.com/' },
  { id: 'tattu', name: 'Tattu', kind: 'brand', url: 'https://genstattu.com/' },
  { id: 'custom', name: 'Ungrouped custom', kind: 'custom-builder' },
  {
    id: 'diy500amp',
    name: 'DIY500AMP',
    kind: 'custom-builder',
    url: 'https://diy500amp.com/products/6s2p-21700-tabless-drone-edf-jet-battery-pack-0-3mm-copper-high-performance',
  },
];
