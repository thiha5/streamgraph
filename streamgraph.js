'use strict';
/* global d3, tableau */

(function () {
  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  const SETTINGS_KEYS = {
    curve: 'streamgraph.curve',
    palette: 'streamgraph.palette',
    background: 'streamgraph.background',
    accent: 'streamgraph.accent',
    legendPosition: 'streamgraph.legendPosition',
    categoryColors: 'streamgraph.categoryColors'
  };

  const DEFAULT_SETTINGS = {
    curve: 'basis',
    palette: 'categorical',
    background: '#f7f7f7',
    accent: '#4e79a7',
    legendPosition: 'right',
    categoryColors: '{}'
  };

  const CURVES = {
    basis: d3.curveBasis,
    natural: d3.curveNatural,
    cardinal: d3.curveCardinal,
    catmullRom: d3.curveCatmullRom,
    monotone: d3.curveMonotoneX,
    step: d3.curveStep,
    linear: d3.curveLinear
  };

  const PALETTES = {
    categorical: ['#4e79a7', '#e15759', '#f1ce63', '#59a14f', '#af7aa1', '#ff9da7', '#9c755f', '#76b7b2', '#f28e2c', '#bab0ab'],
    vibrant: ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe'],
    pastel: ['#a6cee3', '#b2df8a', '#fdbf6f', '#cab2d6', '#fb9a99', '#ffff99', '#8dd3c7', '#bebada', '#fccde5', '#ccebc5']
  };

  function getSettings () {
    const raw = tableau.extensions.settings.getAll();
    let categoryColors = {};
    try {
      categoryColors = JSON.parse(raw[SETTINGS_KEYS.categoryColors] || DEFAULT_SETTINGS.categoryColors);
    } catch (e) {
      categoryColors = {};
    }
    return {
      curve: raw[SETTINGS_KEYS.curve] || DEFAULT_SETTINGS.curve,
      palette: raw[SETTINGS_KEYS.palette] || DEFAULT_SETTINGS.palette,
      background: raw[SETTINGS_KEYS.background] || DEFAULT_SETTINGS.background,
      accent: raw[SETTINGS_KEYS.accent] || DEFAULT_SETTINGS.accent,
      legendPosition: raw[SETTINGS_KEYS.legendPosition] || DEFAULT_SETTINGS.legendPosition,
      categoryColors
    };
  }

  // Resolves the color for each category: an explicit per-category override
  // from the configure dialog wins; otherwise fall back to the chosen palette
  // in stacking order.
  function buildColorResolver (categories, settings) {
    const paletteColors = getPalette(settings, categories.length);
    const fallback = d3.scaleOrdinal().domain(categories).range(paletteColors);
    return (category) => settings.categoryColors[category] || fallback(category);
  }

  function monoPalette (accent, count) {
    const base = d3.hsl(accent);
    const colors = [];
    for (let i = 0; i < count; i++) {
      const t = count <= 1 ? 0.5 : i / (count - 1);
      // spread lightness from dark-ish to light-ish around the accent hue
      const l = 0.30 + t * 0.45;
      colors.push(d3.hsl(base.h, Math.min(1, base.s + 0.05), l).formatHex());
    }
    return colors;
  }

  function getPalette (settings, count) {
    if (settings.palette === 'mono') return monoPalette(settings.accent, Math.max(count, 2));
    const base = PALETTES[settings.palette] || PALETTES.categorical;
    if (count <= base.length) return base;
    // extend with interpolation if there are more categories than base colors
    const extended = base.slice();
    const scale = d3.scaleSequential(d3.interpolateRainbow).domain([0, count]);
    for (let i = base.length; i < count; i++) extended.push(scale(i));
    return extended;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let worksheet;
  let lastRows = [];
  let lastEncodingMap = {};
  let lastCategories = [];
  const selectedTupleIds = new Map();
  let lastHoveredTupleId = null;

  // Data prepared for the current render (kept around for hit-testing on mousemove)
  let renderState = null;

  // One-time diagnostic flag so we can see what Tableau is actually handing
  // us without flooding the console on every mousemove.
  let loggedHoverAttemptOnce = false;

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  window.onload = tableau.extensions.initializeAsync({ configure: openConfigureDialog }).then(() => {
    worksheet = tableau.extensions.worksheetContent.worksheet;

    tableau.extensions.settings.addEventListener(tableau.TableauEventType.SettingsChanged, () => {
      render();
    });

    worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, updateDataAndRender);

    // Workbook Formatting (fonts, etc.) can change while the extension is
    // already open. The library re-injects its own stylesheet on the
    // workbook-level event automatically, but a per-worksheet font change
    // fires this worksheet-level event instead, which it does NOT pick up
    // on its own — so re-render to re-read and re-apply it ourselves.
    worksheet.addEventListener(tableau.TableauEventType.WorksheetFormattingChanged, () => render());

    window.onresize = () => render();

    const content = document.getElementById('content');
    content.addEventListener('mousemove', onMouseMove);
    content.addEventListener('mouseleave', onMouseLeave);
    content.addEventListener('click', onClick);

    updateDataAndRender();
  });

  function openConfigureDialog () {
    const popupUrl = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}configure.html`;
    const colorFor = renderState ? renderState.colorFor : buildColorResolver(lastCategories, getSettings());
    const payload = JSON.stringify({
      categories: lastCategories.map((name) => ({ name, color: colorFor(name) }))
    });
    // Dialog height grows with the category list so every color picker is
    // reachable without the dialog itself needing internal scroll math.
    const dialogHeight = Math.min(700, 360 + lastCategories.length * 34);

    tableau.extensions.ui
      .displayDialogAsync(popupUrl, payload, { height: dialogHeight, width: 440, dialogStyle: tableau.DialogStyle.Modal })
      .then(() => render())
      .catch((error) => {
        if (error.errorCode !== tableau.ErrorCodes.DialogClosedByUser) {
          console.error(error.message);
        }
      });
  }

  // ---------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------
  async function updateDataAndRender () {
    const [rows, encodingMap] = await Promise.all([
      getSummaryDataTable(),
      getEncodingMap()
    ]);

    lastRows = rows;
    lastEncodingMap = encodingMap;

    const selection = await worksheet.getSelectedMarksAsync();
    applySelection(rows, selection);

    render();
  }

  async function getSummaryDataTable () {
    let rows = [];
    const reader = await worksheet.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
    for (let page = 0; page < reader.pageCount; page++) {
      const dataTablePage = await reader.getPageAsync(page);
      rows = rows.concat(convertToNamedRows(dataTablePage));
    }
    await reader.releaseAsync();
    // __tupleId must be a stable 1-based ordinal across the WHOLE table (it's
    // what hoverTupleAsync/selectTuplesAsync key off), so it has to be
    // assigned after every page is concatenated, not per page — otherwise
    // rows on page 2+ collide with page-1 ids whenever the data is large
    // enough to paginate, and hover/select silently target the wrong row.
    rows.forEach((row, i) => { row.__tupleId = i + 1; });
    return rows;
  }

  function convertToNamedRows (dataTablePage) {
    const rows = [];
    const columns = dataTablePage.columns;
    const data = dataTablePage.data;
    for (let i = 0; i < data.length; i++) {
      const row = {};
      for (let j = 0; j < columns.length; j++) {
        row[columns[j].fieldName] = data[i][columns[j].index];
      }
      rows.push(row);
    }
    return rows;
  }

  // Builds a map from encoding id (as declared in the .trex) to the list of
  // fields the user has dropped onto that shelf. Only encodings with at
  // least one field will show up here.
  async function getEncodingMap () {
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

  function findIdsOfSelectedMarks (allRows, columns, selectedMarks) {
    const selectedKeys = new Set();
    for (const selRow of convertToNamedRows(selectedMarks.data[0])) {
      let key = '';
      for (const col of columns) key += (selRow[col.fieldName] ? selRow[col.fieldName].value : '') + ' ';
      selectedKeys.add(key);
    }
    const ids = new Map();
    for (const row of allRows) {
      let key = '';
      for (const col of columns) key += (row[col.fieldName] ? row[col.fieldName].value : '') + ' ';
      if (selectedKeys.has(key)) ids.set(row.__tupleId, true);
    }
    return ids;
  }

  function applySelection (rows, selectedMarks) {
    selectedTupleIds.clear();
    if (!selectedMarks || !selectedMarks.data || selectedMarks.data.length === 0) return;
    if (!selectedMarks.data[0] || !selectedMarks.data[0].data || selectedMarks.data[0].data.length === 0) return;
    const columns = selectedMarks.data[0].columns;
    const ids = findIdsOfSelectedMarks(rows, columns, selectedMarks);
    for (const id of ids.keys()) selectedTupleIds.set(id, true);
  }

  // ---------------------------------------------------------------------
  // Data shaping
  // ---------------------------------------------------------------------
  function fieldOf (encodingMap, id) {
    return (encodingMap[id] && encodingMap[id][0]) || null;
  }

  function buildStreamData (rows, encodingMap) {
    const dateField = fieldOf(encodingMap, 'date');
    const categoryField = fieldOf(encodingMap, 'category');
    const measureField = fieldOf(encodingMap, 'measure');
    const colorField = fieldOf(encodingMap, 'color');

    if (!dateField || !categoryField || !measureField || rows.length === 0) return null;

    // Group rows by date, then by category, summing the measure and keeping
    // a representative row (first one seen) for tooltip / selection purposes.
    const dateOrder = [];
    const dateMap = new Map(); // sortKey -> { label, categories: Map(category -> {value, tupleId}) }
    const categorySet = new Map(); // category -> color-field value (representative)

    for (const row of rows) {
      const dateDv = row[dateField.name];
      const categoryDv = row[categoryField.name];
      const measureDv = row[measureField.name];
      if (!dateDv || !categoryDv || !measureDv) continue;

      const sortKey = dateSortKey(dateDv);
      const label = dateDv.formattedValue;
      const category = categoryDv.value;
      const value = Math.max(0, Number(measureDv.value) || 0);

      if (!dateMap.has(sortKey)) {
        dateOrder.push(sortKey);
        dateMap.set(sortKey, { sortKey, label, categories: new Map() });
      }
      const bucket = dateMap.get(sortKey);
      if (!bucket.categories.has(category)) {
        bucket.categories.set(category, { value: 0, tupleId: row.__tupleId });
      }
      const cell = bucket.categories.get(category);
      cell.value += value;

      if (!categorySet.has(category)) {
        categorySet.set(category, colorField ? row[colorField.name] : categoryDv);
      }
    }

    dateOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const categories = Array.from(categorySet.keys());

    const series = dateOrder.map((key) => {
      const bucket = dateMap.get(key);
      const point = { sortKey: key, label: bucket.label };
      for (const cat of categories) {
        const cell = bucket.categories.get(cat);
        point[cat] = cell ? cell.value : 0;
        point['__tuple_' + cat] = cell ? cell.tupleId : null;
      }
      return point;
    });

    return { series, categories, categorySet, dateField, categoryField, measureField, colorField };
  }

  function dateSortKey (dataValue) {
    const parsed = Date.parse(dataValue.value);
    if (!isNaN(parsed)) return parsed;
    if (typeof dataValue.value === 'number') return dataValue.value;
    return dataValue.formattedValue;
  }

  // ---------------------------------------------------------------------
  // Legend layout
  // ---------------------------------------------------------------------
  const LEGEND_ITEM_HEIGHT = 18;
  const LEGEND_SWATCH = 9;
  const LEGEND_GAP = 12; // gap between the plot area and the legend
  const LEGEND_ROW_GAP = 6; // vertical gap between wrapped rows (top/bottom)

  function truncateLabel (text) {
    return text.length > 24 ? text.slice(0, 23) + '…' : text;
  }

  function estimateLabelWidth (text) {
    return 6.2 * text.length;
  }

  function computeVerticalLegendWidth (categories) {
    let maxLabel = 0;
    for (const cat of categories) maxLabel = Math.max(maxLabel, estimateLabelWidth(truncateLabel(cat)));
    return Math.min(180, LEGEND_SWATCH + 6 + maxLabel + 10);
  }

  function layoutHorizontalLegend (categories, availableWidth) {
    const rows = [];
    let currentRow = [];
    let x = 0;
    const itemGapX = 16;
    for (const cat of categories) {
      const label = truncateLabel(cat);
      const w = LEGEND_SWATCH + 6 + estimateLabelWidth(label) + itemGapX;
      if (x + w > availableWidth && currentRow.length > 0) {
        rows.push(currentRow);
        currentRow = [];
        x = 0;
      }
      currentRow.push({ category: cat, x });
      x += w;
    }
    if (currentRow.length) rows.push(currentRow);
    return rows;
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  function render () {
    const content = document.getElementById('content');
    const emptyState = document.getElementById('empty-state');

    const settings = getSettings();
    document.body.style.backgroundColor = settings.background;

    const stream = buildStreamData(lastRows, lastEncodingMap);

    if (!stream) {
      content.innerHTML = '';
      emptyState.classList.add('visible');
      renderState = null;
      lastCategories = [];
      return;
    }
    emptyState.classList.remove('visible');
    lastCategories = stream.categories;

    const width = content.clientWidth;
    const height = content.clientHeight;
    if (width === 0 || height === 0) return;

    const colorFor = buildColorResolver(stream.categories, settings);

    // Reserve space for the legend on whichever side it's set to, so it
    // never overlaps the plot area or the x-axis.
    const position = settings.legendPosition;
    const margin = { top: 16, right: 16, bottom: 24, left: 16 };
    let legendLayout = null;

    if (stream.categories.length > 0 && (position === 'right' || position === 'left')) {
      const legendWidth = computeVerticalLegendWidth(stream.categories);
      if (position === 'right') margin.right += legendWidth + LEGEND_GAP;
      else margin.left += legendWidth + LEGEND_GAP;
      legendLayout = { type: 'vertical', width: legendWidth };
    }

    const wrapWidth = Math.max(10, width - margin.left - margin.right);
    if (stream.categories.length > 0 && (position === 'top' || position === 'bottom')) {
      const rows = layoutHorizontalLegend(stream.categories, wrapWidth);
      const legendHeight = rows.length * LEGEND_ITEM_HEIGHT + Math.max(0, rows.length - 1) * LEGEND_ROW_GAP;
      if (position === 'top') margin.top += legendHeight + LEGEND_GAP;
      else margin.bottom += legendHeight + LEGEND_GAP;
      legendLayout = { type: 'horizontal', rows, height: legendHeight };
    }

    const innerWidth = Math.max(10, width - margin.left - margin.right);
    const innerHeight = Math.max(10, height - margin.top - margin.bottom);

    const curve = CURVES[settings.curve] || CURVES.basis;

    const stackGen = d3.stack()
      .keys(stream.categories)
      .order(d3.stackOrderInsideOut)
      .offset(d3.stackOffsetWiggle);

    const stacked = stackGen(stream.series);

    const useTimeScale = stream.series.every((d) => typeof d.sortKey === 'number' && Math.abs(d.sortKey) > 1e6);
    const xScale = useTimeScale
      ? d3.scaleLinear().domain(d3.extent(stream.series, (d) => d.sortKey)).range([0, innerWidth])
      : d3.scalePoint().domain(stream.series.map((d) => d.sortKey)).range([0, innerWidth]).padding(0.5);

    // Start from +/-Infinity, not 0: the wiggle offset used for the stream
    // shape floats the baseline away from zero on purpose, so clamping the
    // domain to always include 0 was leaving dead space above/below the
    // bands instead of letting them fill the available height.
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const layer of stacked) {
      for (const point of layer) {
        yMin = Math.min(yMin, point[0], point[1]);
        yMax = Math.max(yMax, point[0], point[1]);
      }
    }
    if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 0; }
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([innerHeight, 0]).nice();

    const areaGen = d3.area()
      .x((d) => xScale(d.data.sortKey))
      .y0((d) => yScale(d[0]))
      .y1((d) => yScale(d[1]))
      .curve(curve);

    // Font is intentionally NOT set here. Both <body> (see
    // streamgraph.html) and this <svg> root carry Tableau's
    // .tableau-worksheet class, so text just inherits font-family from
    // whatever rule Tableau has injected for that class — no per-render
    // JS needed, and nothing here can go stale or block a future update.
    // In practice, on this Tableau Desktop version, that injected rule
    // itself only gets refreshed when the extension reloads (confirmed:
    // even this pure-CSS-inheritance approach didn't pick up a font
    // change without reloading the extension) — so a font change made
    // while the extension is open requires reloading it to show up.
    // That's a platform limitation, not something fixable from in here.

    content.innerHTML = '';
    const svg = d3.create('svg')
      .attr('class', tableau.ClassNameKey.Worksheet)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', [0, 0, width, height]);

    const plot = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    plot.append('g')
      .selectAll('path')
      .data(stacked)
      .join('path')
      .attr('class', 'band')
      .attr('data-category', (d) => d.key)
      .attr('fill', (d) => colorFor(d.key))
      .attr('d', areaGen);

    // Light x-axis with a handful of thinned tick labels.
    const tickCount = Math.min(stream.series.length, Math.max(2, Math.floor(innerWidth / 90)));
    const tickIndices = uniqueSpread(stream.series.length, tickCount);
    const axisG = plot.append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${innerHeight})`);
    axisG.append('line').attr('x1', 0).attr('x2', innerWidth).attr('y1', 0).attr('y2', 0);
    axisG.selectAll('text')
      .data(tickIndices.map((i) => stream.series[i]))
      .join('text')
      .attr('x', (d) => xScale(d.sortKey))
      .attr('y', 14)
      .attr('text-anchor', 'middle')
      .text((d) => d.label);

    const markerLayer = plot.append('g').attr('class', 'marker-layer');

    content.appendChild(svg.node());

    renderState = {
      stream, stacked, xScale, yScale, colorFor, margin, innerWidth, innerHeight, markerLayer, svgSelection: svg
    };

    renderLegendIn(svg, stream.categories, colorFor, position, legendLayout, margin, innerHeight, width, height);
    renderSelectionMarkers();
    applyDimming();
  }

  function uniqueSpread (n, count) {
    if (n <= count) return d3.range(n);
    const result = new Set();
    for (let i = 0; i < count; i++) result.add(Math.round((i * (n - 1)) / (count - 1)));
    return Array.from(result).sort((a, b) => a - b);
  }

  function renderLegendIn (svg, categories, colorFor, position, layout, margin, innerHeight, width, height) {
    if (!layout || categories.length === 0) return;
    const g = svg.append('g').attr('class', 'legend');

    if (layout.type === 'vertical') {
      const x = position === 'right' ? (width - layout.width - 4) : 4;
      const totalHeight = categories.length * LEGEND_ITEM_HEIGHT;
      const yStart = margin.top + Math.max(0, (innerHeight - totalHeight) / 2);

      categories.forEach((cat, i) => {
        const item = g.append('g').attr('transform', `translate(${x}, ${yStart + i * LEGEND_ITEM_HEIGHT})`);
        item.append('rect').attr('width', LEGEND_SWATCH).attr('height', LEGEND_SWATCH).attr('rx', 2).attr('fill', colorFor(cat));
        item.append('text').attr('x', LEGEND_SWATCH + 6).attr('y', LEGEND_SWATCH - 1).text(truncateLabel(cat));
      });
    } else {
      const yStart = position === 'top' ? 4 : height - layout.height - 4;
      layout.rows.forEach((row, rowIndex) => {
        row.forEach((entry) => {
          const item = g.append('g')
            .attr('transform', `translate(${margin.left + entry.x}, ${yStart + rowIndex * (LEGEND_ITEM_HEIGHT + LEGEND_ROW_GAP)})`);
          item.append('rect').attr('width', LEGEND_SWATCH).attr('height', LEGEND_SWATCH).attr('rx', 2).attr('fill', colorFor(entry.category));
          item.append('text').attr('x', LEGEND_SWATCH + 6).attr('y', LEGEND_SWATCH - 1).text(truncateLabel(entry.category));
        });
      });
    }
  }

  // ---------------------------------------------------------------------
  // Interactivity: hover + selection
  // ---------------------------------------------------------------------
  // Which band is under the pointer is decided by the browser's own hit
  // test on the rendered SVG path (e.target), not by re-deriving it from
  // the raw data values. The old approach inverted the pixel y-position
  // through yScale and checked it against each layer's [y0,y1] data
  // values at the nearest date index — but the visible path is drawn with
  // a curve (basis/natural/cardinal all overshoot or smooth past the
  // actual data points), so the rendered pixel shape and the raw
  // [y0,y1] band frequently disagreed, and the geometric check missed
  // most real hovers. Using e.target.closest('.band') instead reads
  // exactly what's painted on screen, the same thing every native
  // Tableau mark's hover relies on.
  function findMarkAt (e) {
    if (!renderState) return null;
    const bandEl = e.target && e.target.closest && e.target.closest('.band');
    if (!bandEl) return null;
    const category = bandEl.getAttribute('data-category');

    const content = document.getElementById('content');
    const rect = content.getBoundingClientRect();
    const x = e.clientX - rect.left - renderState.margin.left;

    const { stream, xScale } = renderState;

    // Still need the nearest date to know WHICH tuple along this band to
    // point at — the band tells us the category, the x-position tells us
    // the date.
    let index;
    if (xScale.invert) {
      const target = xScale.invert(x);
      index = d3.bisector((d) => d.sortKey).center(stream.series, target);
    } else {
      const domain = xScale.domain();
      const positions = domain.map((v) => xScale(v));
      index = d3.bisector((v) => v).center(positions, x);
    }
    index = Math.max(0, Math.min(stream.series.length - 1, index));

    const seriesPoint = stream.series[index];
    const tupleId = seriesPoint['__tuple_' + category];
    if (tupleId === null || tupleId === undefined) return null;

    // Anchor right where the cursor actually is (content-relative, same
    // convention clampAnchor expects) instead of recomputing a band
    // midpoint — we no longer have a y-value hit test to derive one from.
    return { category, sortKey: seriesPoint.sortKey, tupleId, x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  let loggedMouseMoveOnce = false;

  function onMouseMove (e) {
    const mark = findMarkAt(e);
    if (!loggedMouseMoveOnce) {
      loggedMouseMoveOnce = true;
      console.log('[streamgraph] first mousemove:', { clientX: e.clientX, clientY: e.clientY, hasRenderState: !!renderState, target: e.target && e.target.tagName, mark });
    }
    const tupleId = mark ? mark.tupleId : null;

    if (tupleId !== lastHoveredTupleId) {
      lastHoveredTupleId = tupleId;
      if (tupleId !== null && tupleId !== undefined) {
        const anchor = clampAnchor(mark.x, mark.y);
        if (!loggedHoverAttemptOnce) {
          loggedHoverAttemptOnce = true;
          console.log('[streamgraph] first hoverTupleAsync call:', { tupleId, anchor });
        }
        worksheet.hoverTupleAsync(tupleId, { tooltipAnchorPoint: anchor })
          .then(() => console.log('[streamgraph] hoverTupleAsync resolved for tuple', tupleId))
          .catch((err) => console.error('[streamgraph] hoverTupleAsync FAILED', err));
      } else {
        worksheet.hoverTupleAsync(-1).catch((err) => console.error('[streamgraph] hoverTupleAsync(-1) failed', err));
      }
    }
  }

  function onMouseLeave () {
    if (lastHoveredTupleId !== null) {
      lastHoveredTupleId = null;
      worksheet.hoverTupleAsync(-1).catch((err) => console.error('hoverTupleAsync(-1) failed', err));
    }
  }

  function onClick (e) {
    const mark = findMarkAt(e);

    if (!mark || mark.tupleId === null || mark.tupleId === undefined) {
      if (!e.ctrlKey && !e.metaKey) {
        selectedTupleIds.clear();
        worksheet.selectTuplesAsync([], tableau.SelectOptions.Simple)
          .catch((err) => console.error('selectTuplesAsync (clear) failed', err));
        applyDimming();
        renderSelectionMarkers();
      }
      return;
    }

    const id = mark.tupleId;
    if (selectedTupleIds.has(id)) {
      if (selectedTupleIds.size === 1) selectedTupleIds.clear();
      else if (e.ctrlKey || e.metaKey) selectedTupleIds.delete(id);
      else { selectedTupleIds.clear(); selectedTupleIds.set(id, true); }
    } else {
      if (!e.ctrlKey && !e.metaKey) selectedTupleIds.clear();
      selectedTupleIds.set(id, true);
    }

    const anchor = clampAnchor(mark.x, mark.y);
    worksheet.selectTuplesAsync([...selectedTupleIds.keys()], tableau.SelectOptions.Simple, { tooltipAnchorPoint: anchor })
      .catch((err) => console.error('selectTuplesAsync failed', err));

    applyDimming();
    renderSelectionMarkers();
  }

  function clampAnchor (x, y) {
    if (!renderState) return { x, y };
    const content = document.getElementById('content');
    const rect = content.getBoundingClientRect();
    const clampedX = Math.max(renderState.margin.left, Math.min(renderState.margin.left + renderState.innerWidth, x));
    const clampedY = Math.max(renderState.margin.top, Math.min(renderState.margin.top + renderState.innerHeight, y));
    return { x: rect.left + clampedX, y: rect.top + clampedY };
  }

  function applyDimming () {
    if (!renderState) return;
    const hasSelection = selectedTupleIds.size > 0;
    if (!hasSelection) {
      renderState.svgSelection.selectAll('.band').classed('dimmed', false);
      return;
    }
    const selectedCategories = new Set();
    for (const layer of renderState.stacked) {
      for (const point of layer) {
        if (selectedTupleIds.has(point.data['__tuple_' + layer.key])) {
          selectedCategories.add(layer.key);
        }
      }
    }
    renderState.svgSelection.selectAll('.band')
      .classed('dimmed', function () {
        const cat = d3.select(this).attr('data-category');
        return !selectedCategories.has(cat);
      });
  }

  function renderSelectionMarkers () {
    if (!renderState) return;
    renderState.markerLayer.selectAll('*').remove();
    if (selectedTupleIds.size === 0) return;

    const markers = [];
    for (const layer of renderState.stacked) {
      for (let i = 0; i < layer.length; i++) {
        const point = layer[i];
        const seriesPoint = renderState.stream.series[i];
        const tupleId = seriesPoint['__tuple_' + layer.key];
        if (selectedTupleIds.has(tupleId)) {
          markers.push({
            x: renderState.xScale(seriesPoint.sortKey),
            y: renderState.yScale((point[0] + point[1]) / 2)
          });
        }
      }
    }

    renderState.markerLayer.selectAll('circle')
      .data(markers)
      .join('circle')
      .attr('class', 'selection-marker')
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y)
      .attr('r', 4)
      .attr('fill', '#fff')
      .attr('stroke', '#333')
      .attr('stroke-width', 1.5);
  }
})();
