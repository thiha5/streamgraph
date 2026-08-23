'use strict';

/**
 * Stream Graph Viz Extension
 *
 * Marks card encodings (see streamgraph.trex):
 *   date     - temporal, x axis
 *   category - discrete dimension, one band per value
 *   measure  - continuous measure, controls band thickness
 *   color    - optional discrete dimension used to color bands (falls back to category)
 *   Detail / Tooltip - built in to every Viz Extension automatically
 *
 * Settings (see config.html / config.js), reached via the "Format Extension"
 * button on the Marks card:
 *   curveStyle       - d3 curve used to interpolate band edges between dates
 *   backgroundColor  - background color behind the stream graph
 *   showLegend       - whether the self-drawn legend is shown
 *   categoryColors   - JSON map of {colorValue: hex} overriding the default palette
 *
 * Note: custom Marks card encodings (like our Color shelf) don't get
 * Tableau's native legend or "Edit Colors" dialog the way built-in mark
 * types do - that machinery only exists for the standard Color shelf on
 * native marks. So both the legend and the color editor here are drawn and
 * managed entirely by this extension, via the settings dialog above.
 */

const CURVES = {
  basis: d3.curveBasis,
  cardinal: d3.curveCardinal,
  natural: d3.curveNatural,
  monotoneX: d3.curveMonotoneX,
  step: d3.curveStep,
  linear: d3.curveLinear
};

const PALETTE = [
  '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'
];

const MARGIN = { top: 24, right: 24, bottom: 32, left: 24 };
const MAX_TICKS = 10;

let currentData = [];       // raw rows, in reader order (row index + 1 == tupleId)
let currentEncodingMap = {};
let selectedTupleIds = new Map();
const hoveredTupleIds = new Map();
let lastModel = null;       // set on every render(); used to prefill the settings dialog

window.onload = tableau.extensions.initializeAsync({ configure }).then(async () => {
  const worksheet = getWorksheet();

  tableau.extensions.settings.addEventListener(
    tableau.TableauEventType.SettingsChanged,
    () => renderFromCurrentState()
  );

  worksheet.addEventListener(
    tableau.TableauEventType.SummaryDataChanged,
    updateDataAndRender
  );

  onresize = () => renderFromCurrentState();

  // Clicking the empty background (not a band) clears the current selection.
  document.body.addEventListener('click', (e) => {
    if (e.target.tagName === 'path') return;
    if (selectedTupleIds.size === 0) return;
    selectedTupleIds.clear();
    getWorksheet().selectTuplesAsync([], tableau.SelectOptions.Simple);
    renderFromCurrentState();
  });

  await updateDataAndRender();
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function configure () {
  const popupUrl = `${window.location.origin}/config.html`;

  // Pass along the current settings plus the color values actually on the
  // viz right now (with their resolved colors), so the dialog can offer a
  // picker per value instead of an empty form.
  const settings = getSettings();
  const colorDomain = lastModel?.colorDomain || [];
  const resolvedColors = {};
  colorDomain.forEach((value, i) => {
    resolvedColors[value] = settings.categoryColors[value] || PALETTE[i % PALETTE.length];
  });

  const openPayload = JSON.stringify({ ...settings, colorDomain, resolvedColors });

  tableau.extensions.ui
    .displayDialogAsync(popupUrl, openPayload, { height: 520, width: 420 })
    .then(() => renderFromCurrentState())
    .catch((error) => {
      if (error.errorCode !== tableau.ErrorCodes.DialogClosedByUser) {
        console.error(error.message);
      }
    });
}

function getSettings () {
  let categoryColors = {};
  try {
    categoryColors = JSON.parse(tableau.extensions.settings.get('categoryColors') || '{}');
  } catch (e) {
    console.warn('Could not parse categoryColors setting', e);
  }

  return {
    curveStyle: tableau.extensions.settings.get('curveStyle') || 'basis',
    backgroundColor: tableau.extensions.settings.get('backgroundColor') || '#ffffff',
    showLegend: tableau.extensions.settings.get('showLegend') !== 'false',
    categoryColors
  };
}

// ---------------------------------------------------------------------------
// Data fetch + render pipeline
// ---------------------------------------------------------------------------

async function updateDataAndRender () {
  const worksheet = getWorksheet();

  [currentData, currentEncodingMap] = await Promise.all([
    getSummaryDataTable(worksheet),
    getEncodingMap(worksheet)
  ]);

  selectedTupleIds = await getSelection(worksheet, currentData);

  renderFromCurrentState();
}

function renderFromCurrentState () {
  const settings = getSettings();
  document.body.style.backgroundColor = settings.backgroundColor;
  render(currentData, currentEncodingMap, settings, selectedTupleIds, hoveredTupleIds);
}

// Uses getVisualSpecificationAsync to build a map of encoding identifiers
// (defined in the .trex file) to the field(s) the user dropped on that shelf.
async function getEncodingMap (worksheet) {
  const visualSpec = await worksheet.getVisualSpecificationAsync();
  const encodingMap = {};

  if (visualSpec.activeMarksSpecificationIndex < 0) return encodingMap;

  const marksCard = visualSpec.marksSpecifications[visualSpec.activeMarksSpecificationIndex];
  for (const encoding of marksCard.encodings) {
    if (!encodingMap[encoding.id]) encodingMap[encoding.id] = [];
    encodingMap[encoding.id].push(encoding.field);
  }

  return encodingMap;
}

// Reads every page of summary data and returns a flat list of rows keyed by
// field name. Row order is stable and 1-indexed order == tupleId, matching
// what worksheet.selectTuplesAsync / hoverTupleAsync expect.
async function getSummaryDataTable (worksheet) {
  let rows = [];

  const reader = await worksheet.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
  for (let page = 0; page < reader.pageCount; page++) {
    const dataTablePage = await reader.getPageAsync(page);
    rows = rows.concat(convertToListOfNamedRows(dataTablePage, rows.length));
  }
  await reader.releaseAsync();

  return rows;
}

function convertToListOfNamedRows (dataTablePage, offset) {
  const rows = [];
  const columns = dataTablePage.columns;
  const data = dataTablePage.data;

  for (let i = 0; i < data.length; i++) {
    const row = {};
    for (let j = 0; j < columns.length; j++) {
      row[columns[j].fieldName] = data[i][columns[j].index];
    }
    row.tupleId = offset + i + 1;
    rows.push(row);
  }

  return rows;
}

async function getSelection (worksheet, allRows) {
  const selectedMarks = await worksheet.getSelectedMarksAsync();
  if (!selectedMarks.data.length) return new Map();

  const columns = selectedMarks.data[0].columns;
  const selectedKeys = new Set();

  for (const namedRow of convertToListOfNamedRows(selectedMarks.data[0], 0)) {
    selectedKeys.add(rowKey(namedRow, columns));
  }

  const selected = new Map();
  for (const row of allRows) {
    if (selectedKeys.has(rowKey(row, columns))) selected.set(row.tupleId, true);
  }

  return selected;
}

function rowKey (row, columns) {
  let key = '';
  for (const col of columns) key += row[col.fieldName]?.value + '\x00';
  return key;
}

// ---------------------------------------------------------------------------
// Shape the flat rows into stacked stream-graph series
// ---------------------------------------------------------------------------

function buildStreamModel (rows, encodingMap) {
  const dateField = encodingMap.date?.[0];
  const categoryField = encodingMap.category?.[0];
  const measureField = encodingMap.measure?.[0];
  const colorField = encodingMap.color?.[0] || categoryField;

  if (!dateField || !categoryField || !measureField) return null;

  // dateKey -> { label, values: Map(category -> measure sum), tupleIds: Map(category -> [ids]) }
  const byDate = new Map();
  const categoryTotals = new Map();
  const categoryColorValue = new Map();

  for (const row of rows) {
    const dateValue = row[dateField.name];
    const categoryValue = row[categoryField.name];
    const measureValue = row[measureField.name];
    if (dateValue == null || categoryValue == null) continue;

    const dateKey = String(dateValue.value);
    const category = String(categoryValue.value);
    const measure = Number(measureValue?.value) || 0;

    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, { label: dateValue.formattedValue, values: new Map(), tupleIds: new Map() });
    }
    const bucket = byDate.get(dateKey);
    bucket.values.set(category, (bucket.values.get(category) || 0) + measure);
    if (!bucket.tupleIds.has(category)) bucket.tupleIds.set(category, []);
    bucket.tupleIds.get(category).push(row.tupleId);

    categoryTotals.set(category, (categoryTotals.get(category) || 0) + Math.abs(measure));

    if (colorField && !categoryColorValue.has(category)) {
      const colorValue = colorField === categoryField ? categoryValue : row[colorField.name];
      categoryColorValue.set(category, colorValue ? String(colorValue.value) : category);
    }
  }

  const sortedDateKeys = [...byDate.keys()].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  const categories = [...categoryTotals.keys()].sort((a, b) => categoryTotals.get(b) - categoryTotals.get(a));

  const pivot = sortedDateKeys.map((dateKey) => {
    const bucket = byDate.get(dateKey);
    const point = { dateKey, label: bucket.label };
    for (const category of categories) {
      point[category] = bucket.values.get(category) || 0;
      point[`__tuples__${category}`] = bucket.tupleIds.get(category) || [];
    }
    return point;
  });

  const colorDomain = [...new Set(categories.map((c) => categoryColorValue.get(c) || c))];

  return { pivot, categories, colorDomain, categoryColorValue };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render (rows, encodingMap, settings, selected, hovered) {
  const content = document.getElementById('content');
  const emptyState = document.getElementById('empty-state');
  content.innerHTML = '';

  const model = buildStreamModel(rows, encodingMap);
  lastModel = model;

  if (!model || model.pivot.length === 0 || model.categories.length === 0) {
    emptyState.classList.remove('hidden');
    renderLegend(null, null, settings);
    return;
  }
  emptyState.classList.add('hidden');

  // Reserve room at the bottom for the legend so it doesn't overlap the chart.
  const legendHeight = settings.showLegend ? 28 : 0;
  const width = content.clientWidth || window.innerWidth;
  const height = (content.clientHeight || window.innerHeight) - legendHeight;

  const styles = tableau.extensions.environment.workbookFormatting?.formattingSheets
    ?.find((x) => x.classNameKey === 'tableau-worksheet')?.cssProperties;

  // Default palette by position, overridden per-value by whatever the user
  // picked in the settings dialog (settings.categoryColors).
  const defaultColorByValue = new Map(model.colorDomain.map((v, i) => [v, PALETTE[i % PALETTE.length]]));
  const colorScale = (value) => settings.categoryColors[value] || defaultColorByValue.get(value) || '#999999';
  const curve = CURVES[settings.curveStyle] || d3.curveBasis;

  const stack = d3.stack()
    .keys(model.categories)
    .order(d3.stackOrderInsideOut)
    .offset(d3.stackOffsetWiggle);

  const series = stack(model.pivot);

  const x = d3.scalePoint()
    .domain(model.pivot.map((d) => d.dateKey))
    .range([MARGIN.left, width - MARGIN.right])
    .padding(0.5);

  const yMin = d3.min(series, (s) => d3.min(s, (d) => d[0]));
  const yMax = d3.max(series, (s) => d3.max(s, (d) => d[1]));
  const y = d3.scaleLinear()
    .domain([yMin, yMax])
    .range([height - MARGIN.bottom, MARGIN.top]);

  const area = d3.area()
    .x((d) => x(d.data.dateKey))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]))
    .curve(curve);

  const svg = d3.create('svg')
    .attr('class', tableau.ClassNameKey.Worksheet)
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height])
    .attr('font-family', styles?.fontFamily)
    .attr('font-size', styles?.fontSize)
    .attr('font-style', styles?.fontStyle);

  const hasSelection = selected.size > 0;

  const bandsLayer = svg.append('g');

  bandsLayer.selectAll('path')
    .data(series)
    .join('path')
    .attr('class', 'stream-band')
    .attr('d', area)
    .attr('fill', (d) => colorScale(model.categoryColorValue.get(d.key) || d.key))
    .classed('is-fogged', (d) => hasSelection && !seriesIsSelected(d, selected))
    .on('mousemove', (event, d) => onBandHover(event, d, x, y, model, hovered))
    .on('mouseleave', () => clearHover(hovered))
    .on('click', (event, d) => onBandClick(event, d, x, y, model, selected));

  // X axis with a thinned-out set of date labels so long ranges stay readable.
  const tickValues = thinTicks(model.pivot.map((d) => d.dateKey), MAX_TICKS);
  const labelByKey = new Map(model.pivot.map((d) => [d.dateKey, d.label]));

  svg.append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(0, ${height - MARGIN.bottom})`)
    .call(
      d3.axisBottom(x)
        .tickValues(tickValues)
        .tickFormat((k) => labelByKey.get(k))
    )
    .call((g) => g.select('.domain').attr('stroke', styles?.color || '#ccc'))
    .selectAll('text')
    .attr('fill', styles?.color || '#666');

  content.appendChild(svg.node());

  renderLegend(model, colorScale, settings);
}

// Draws (or removes) a simple swatch legend below the chart. This is fully
// self-managed by the extension - see the note at the top of this file for
// why it can't hook into Tableau's native Color/legend UI.
function renderLegend (model, colorScale, settings) {
  let legend = document.getElementById('legend');
  if (legend) legend.remove();

  if (!settings.showLegend || !model) return;

  legend = document.createElement('div');
  legend.id = 'legend';
  legend.className = 'stream-legend';

  for (const value of model.colorDomain) {
    const item = document.createElement('span');
    item.className = 'legend-item';

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = colorScale(value);

    const label = document.createElement('span');
    label.textContent = value;

    item.appendChild(swatch);
    item.appendChild(label);
    item.addEventListener('click', (event) => onLegendClick(event, value, model, selectedTupleIds));

    legend.appendChild(item);
  }

  document.body.appendChild(legend);
}

function onLegendClick (event, colorValue, model, selected) {
  const allIds = [];
  for (const category of model.categories) {
    if ((model.categoryColorValue.get(category) || category) !== colorValue) continue;
    for (const point of model.pivot) allIds.push(...(point[`__tuples__${category}`] || []));
  }

  const alreadySelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  selected.clear();
  if (!alreadySelected) {
    for (const id of allIds) selected.set(id, true);
  }

  getWorksheet().selectTuplesAsync([...selected.keys()], tableau.SelectOptions.Simple, {
    tooltipAnchorPoint: { x: event.pageX, y: event.pageY }
  });

  renderFromCurrentState();
}

function seriesIsSelected (series, selected) {
  return series.some((d) => {
    const ids = d.data[`__tuples__${series.key}`] || [];
    return ids.some((id) => selected.has(id));
  });
}

function thinTicks (keys, maxTicks) {
  if (keys.length <= maxTicks) return keys;
  const step = Math.ceil(keys.length / maxTicks);
  return keys.filter((_, i) => i % step === 0);
}

// Tableau's native tooltip is what actually renders on hover (we just tell it
// which tuple via hoverTupleAsync). Calling that on every mousemove pixel -
// and worse, clearing (-1) before every re-set - is what caused the
// flickering/lagging tooltip: each call is an async round trip, and firing
// a hide+show pair dozens of times a second races itself. So we only talk
// to Tableau when the hovered tuple actually changes, and only send -1 when
// the mouse truly leaves a mark (mouseleave), never mid-hover.
let lastHoveredId = null;

function onBandHover (event, series, x, y, model, hovered) {
  const dateKey = nearestDateKey(event, x, model.pivot);
  const point = series.find((d) => d.data.dateKey === dateKey);
  const ids = point?.data[`__tuples__${series.key}`] || [];
  const id = ids[0];
  if (!id || id === lastHoveredId) return;

  lastHoveredId = id;
  hovered.clear();
  hovered.set(id, true);

  getWorksheet().hoverTupleAsync(id, {
    tooltipAnchorPoint: markAnchorPoint(point, x, y, dateKey)
  });
}

function clearHover (hovered) {
  if (lastHoveredId === null) return;
  hovered.clear();
  lastHoveredId = null;
  getWorksheet().hoverTupleAsync(-1);
}

function onBandClick (event, series, x, y, model, selected) {
  event.stopPropagation();

  const dateKey = nearestDateKey(event, x, model.pivot);
  const point = series.find((d) => d.data.dateKey === dateKey);

  const allIds = [];
  for (const p of model.pivot) {
    const ids = p[`__tuples__${series.key}`] || [];
    allIds.push(...ids);
  }

  const alreadySelected = allIds.every((id) => selected.has(id)) && allIds.length > 0;

  selected.clear();
  if (!alreadySelected) {
    for (const id of allIds) selected.set(id, true);
  }

  getWorksheet().selectTuplesAsync([...selected.keys()], tableau.SelectOptions.Simple, {
    tooltipAnchorPoint: markAnchorPoint(point, x, y, dateKey)
  });

  renderFromCurrentState();
}

// Anchors Tableau's native tooltip/selection popover at the mark's actual
// screen position (center of the band at this date), clamped to stay inside
// the plot's margins - rather than the raw cursor position. Marks near the
// edge of the pane (e.g. the most recent date) could otherwise anchor a
// tooltip that renders partly outside the chart's visible border.
function markAnchorPoint (point, x, y, dateKey) {
  const content = document.getElementById('content');
  const rect = content.getBoundingClientRect();

  const rawX = x(dateKey);
  const rawY = point ? (y(point[0]) + y(point[1])) / 2 : rect.height / 2;

  const clampedX = clamp(rawX, MARGIN.left, rect.width - MARGIN.right);
  const clampedY = clamp(rawY, MARGIN.top, rect.height - MARGIN.bottom);

  return { x: rect.left + clampedX, y: rect.top + clampedY };
}

function clamp (value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

function nearestDateKey (event, x, pivot) {
  const [mx] = d3.pointer(event);
  let closest = pivot[0].dateKey;
  let closestDist = Infinity;
  for (const point of pivot) {
    const dist = Math.abs(x(point.dateKey) - mx);
    if (dist < closestDist) {
      closestDist = dist;
      closest = point.dateKey;
    }
  }
  return closest;
}

function getWorksheet () {
  return tableau.extensions.worksheetContent
    ? tableau.extensions.worksheetContent.worksheet
    : tableau.extensions.dashboardContent.dashboard.worksheets[0];
}
