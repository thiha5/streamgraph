# Stream Graph Viz Extension

A Tableau Viz Extension (2024.2+) that renders a stream graph — a stacked
area chart with a "wiggle" baseline (d3's `stackOffsetWiggle` +
`stackOrderInsideOut`), in the style of the [reference viz](https://public.tableau.com/app/profile/ludovic.tavernier/viz/MakeOverMonday-PayingThePresident/PayingThePresident).

## Marks card

| Shelf | Role | Notes |
|---|---|---|
| Date | temporal, discrete or continuous | x axis |
| Category | discrete dimension | one band per value |
| Measure | continuous measure | controls band thickness |
| Color | discrete dimension, optional | colors bands; falls back to Category |
| Detail | built in | add fields for extra granularity, same as any Viz Extension |
| Tooltip | built in | fields shown in Tableau's native tooltip on hover |

Detail and Tooltip are provided automatically by the Extensions API — they
don't need to be declared in the manifest.

Click a band to select it (and every mark it's made of) across the whole
worksheet; click empty space to clear the selection. Hovering a band shows
Tableau's normal tooltip via `hoverTupleAsync`.

## Settings

Click the gear icon / **Format Extension** button on the Marks card to open
the settings dialog:

- **Curve style** — smooth (basis/cardinal), natural, monotone, step, or
  linear (pointed) edges between dates.
- **Background color** — behind the chart.
- **Show legend** — toggles a swatch legend the extension draws below the
  chart. Clicking a swatch selects every mark for that value, same as
  clicking a band.
- **Band colors** — one color picker per value currently on the Color (or
  Category) shelf, prefilled with whatever color that band is drawn with now.

Custom Marks card encodings (like this extension's Color shelf) don't get
Tableau's native legend or "Edit Colors" dialog — that machinery only exists
for the standard Color shelf on built-in mark types. So the legend and color
editing here are both fully self-drawn and self-managed by the extension via
the dialog above, not a native Color tab.

Settings are stored with `tableau.extensions.settings` and are saved with the
workbook.

## Files

```
streamgraph.trex     manifest — encodings, config menu entry
streamgraph.html      viz page
streamgraph.css
streamgraph.js         data fetch + d3 rendering
config.html            settings dialog
config.js
lib/tableau.extensions.1.latest.min.js   bundled Extensions API library
```

d3 v7 loads from a CDN (`cdn.jsdelivr.net`); everything else is local, so the
extension works offline once loaded except for that one script tag.

## Run it locally (Tableau Desktop)

1. Serve this folder over HTTP. From this directory:

   ```
   python3 -m http.server 8765
   ```

   (Any static file server works — the `.trex` just needs to match whatever
   port/host you use. It currently points at `http://localhost:8765/streamgraph.html`.)

2. In Tableau Desktop, build a worksheet, open the **Marks card** mark-type
   dropdown, choose **Add Extension** under *Viz Extensions*, then **Access
   Local Extensions** and select `streamgraph.trex`.

3. Drag a date field to **Date**, a dimension to **Category**, and a measure
   to **Measure**. Optionally add a **Color** dimension.

4. Click the Marks card gear / **Format Extension** to open settings.

## Packaging / deploying

- For sharing a self-contained package, zip everything into a single
  `.trex` (Tableau supports zipped Viz Extension packages) — see
  [Tableau's packaging docs](https://tableau.github.io/extensions-api/docs/vizext/trex_viz_manifest/).
- For Tableau Cloud/Server or sharing with others, host these files on an
  HTTPS server and update `<source-location><url>` in `streamgraph.trex`
  (and the `popupUrl` origin lookup in `streamgraph.js`, which already uses
  `window.location.origin` so no change is needed there) to that URL.
- `min-api-version` is set to `1.12`, which is when Viz Extensions custom
  encodings shipped — Tableau 2024.2 or newer is required.

## Known limitations / next steps

- Color is assigned from a fixed 10-color qualitative palette keyed by the
  Color (or Category) field's distinct values — it doesn't yet read
  Tableau's own color legend/palette assignment.
- Selection highlighting uses a simple opacity fade rather than the
  "fogging" blend Tableau's native marks use.
- No legend is drawn yet; band identity currently relies on tooltip/hover.
