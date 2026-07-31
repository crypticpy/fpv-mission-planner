# Developer assets

- `tokens.json` is a platform-neutral starting token set extracted from the
  approved direction. Convert it into CSS variables, native theme values, or
  your design-token pipeline.
- `fpv-symbols.svg` contains reusable symbols for launch, waypoint, subject,
  recovery, bailout, wind, camera volume, radio link, terrain, and altitude.
  Inline the file into the app's SVG sprite and render a symbol with
  `<use href="#waypoint" />`; size and color should come from component state.

The SVGs are deliberately monochrome. Safety meaning must also appear as text
and icon shape, never color alone. Route corridors, Fresnel volumes, camera
frustums, and terrain heat ribbons should be rendered from live geometry rather
than exported as static images.
