'use strict';
/* global tableau */

(function () {
  const SETTINGS_KEYS = {
    curve: 'streamgraph.curve',
    palette: 'streamgraph.palette',
    background: 'streamgraph.background',
    accent: 'streamgraph.accent',
    legendPosition: 'streamgraph.legendPosition',
    categoryColors: 'streamgraph.categoryColors'
  };

  const DEFAULTS = {
    curve: 'basis',
    palette: 'categorical',
    background: '#f7f7f7',
    accent: '#4e79a7',
    legendPosition: 'right'
  };

  document.addEventListener('DOMContentLoaded', () => {
    tableau.extensions.initializeDialogAsync().then((openPayload) => {
      const current = tableau.extensions.settings.getAll();

      let payload = { categories: [] };
      try {
        payload = JSON.parse(openPayload || '{}');
      } catch (e) {
        payload = { categories: [] };
      }
      const categories = payload.categories || [];

      let categoryColors = {};
      try {
        categoryColors = JSON.parse(current[SETTINGS_KEYS.categoryColors] || '{}');
      } catch (e) {
        categoryColors = {};
      }

      const curveEl = document.getElementById('curve');
      const paletteEl = document.getElementById('palette');
      const accentEl = document.getElementById('accent');
      const backgroundEl = document.getElementById('background');
      const accentRow = document.getElementById('accent-row');
      const legendGrid = document.getElementById('legend-position-grid');
      const categoryListEl = document.getElementById('category-list');
      const resetColorsLink = document.getElementById('reset-colors');

      curveEl.value = current[SETTINGS_KEYS.curve] || DEFAULTS.curve;
      paletteEl.value = current[SETTINGS_KEYS.palette] || DEFAULTS.palette;
      accentEl.value = current[SETTINGS_KEYS.accent] || DEFAULTS.accent;
      backgroundEl.value = current[SETTINGS_KEYS.background] || DEFAULTS.background;

      const currentLegendPosition = current[SETTINGS_KEYS.legendPosition] || DEFAULTS.legendPosition;
      setLegendPositionUI(currentLegendPosition);

      function setLegendPositionUI (value) {
        legendGrid.querySelectorAll('input[name="legendPosition"]').forEach((input) => {
          input.checked = input.value === value;
          input.closest('label').classList.toggle('selected', input.value === value);
        });
      }

      legendGrid.addEventListener('change', (e) => {
        if (e.target.name !== 'legendPosition') return;
        setLegendPositionUI(e.target.value);
      });

      function updateAccentVisibility () {
        accentRow.classList.toggle('visible', paletteEl.value === 'mono');
      }
      updateAccentVisibility();
      paletteEl.addEventListener('change', updateAccentVisibility);

      // ---- Per-category color pickers ----
      function renderCategoryList () {
        categoryListEl.innerHTML = '';
        if (categories.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'no-categories';
          empty.textContent = 'Add a Date, Category and Measure field to the Marks card to see your categories here.';
          categoryListEl.appendChild(empty);
          return;
        }
        for (const cat of categories) {
          const row = document.createElement('div');
          row.className = 'category-row';

          const swatch = document.createElement('input');
          swatch.type = 'color';
          swatch.value = toHex(categoryColors[cat.name] || cat.color);
          swatch.dataset.category = cat.name;

          const name = document.createElement('span');
          name.className = 'category-name';
          name.textContent = cat.name;
          name.title = cat.name;

          row.appendChild(swatch);
          row.appendChild(name);
          categoryListEl.appendChild(row);
        }
      }
      renderCategoryList();

      resetColorsLink.addEventListener('click', () => {
        categoryColors = {};
        renderCategoryList();
      });

      document.getElementById('apply').addEventListener('click', () => {
        const newCategoryColors = {};
        categoryListEl.querySelectorAll('input[type="color"]').forEach((input) => {
          newCategoryColors[input.dataset.category] = input.value;
        });

        const selectedPosition = legendGrid.querySelector('input[name="legendPosition"]:checked');

        tableau.extensions.settings.set(SETTINGS_KEYS.curve, curveEl.value);
        tableau.extensions.settings.set(SETTINGS_KEYS.palette, paletteEl.value);
        tableau.extensions.settings.set(SETTINGS_KEYS.accent, accentEl.value);
        tableau.extensions.settings.set(SETTINGS_KEYS.background, backgroundEl.value);
        tableau.extensions.settings.set(SETTINGS_KEYS.legendPosition, selectedPosition ? selectedPosition.value : DEFAULTS.legendPosition);
        tableau.extensions.settings.set(SETTINGS_KEYS.categoryColors, JSON.stringify(newCategoryColors));

        tableau.extensions.settings.saveAsync().then(() => {
          tableau.extensions.ui.closeDialog('applied');
        });
      });

      document.getElementById('cancel').addEventListener('click', () => {
        tableau.extensions.ui.closeDialog('cancelled');
      });
    });
  });

  // <input type="color"> requires a #rrggbb value; fall back to a neutral
  // gray if a stored/computed color ever comes in another format (e.g. an
  // hsl() string) so the picker doesn't silently reject it.
  function toHex (value) {
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value;
    const probe = document.createElement('canvas').getContext('2d');
    try {
      probe.fillStyle = value;
      return probe.fillStyle.length === 7 ? probe.fillStyle : '#888888';
    } catch (e) {
      return '#888888';
    }
  }
})();
