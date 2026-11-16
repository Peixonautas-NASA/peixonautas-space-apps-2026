/* Imported numerical fields and explicit scenarios. No fabricated sensor maps. */
(function () {
  'use strict';
  const fields = {
    radiation: { title: 'Radiation', suffix: 'Radiation', unit: 'µSv/h', quantity: 'radiationDoseEquivalentRate', fileUnit: 'uSv/h', value: 26.7, hot: 1000 },
    temperature: { title: 'Temperature', suffix: 'Temperature', unit: '°C', quantity: 'airTemperature', fileUnit: 'degC', value: -60, hot: -120 },
    magnetism: { title: 'Magnetism', suffix: 'Magnetism', unit: 'nT', quantity: 'magneticFieldMagnitude', fileUnit: 'nT', value: 200, hot: 5000 }
  };
  const settingIds = { speedMps: 'environmentSpeed', doseReferenceUSv: 'environmentDoseReference',
    temperatureMinC: 'environmentTemperatureMin', temperatureMaxC: 'environmentTemperatureMax',
    temperatureReferenceC: 'environmentTemperatureReference', magneticLimitNT: 'environmentMagneticLimit', magneticReferenceNT: 'environmentMagneticReference' };
  function createEditor({ onChange, getGrid }) {
    const api = globalThis.PeixonautasNavigation, rasters = {};
    const el = id => document.getElementById(id);
    const message = text => { el('environmentStatus').textContent = text; };
    for (const [field, spec] of Object.entries(fields)) {
      const card = document.createElement('fieldset');
      const prefix = 'environment' + spec.suffix;
      // All interpolated strings below are static application constants.
      card.innerHTML = '<legend>' + spec.title + '</legend>'
        + '<label>Weight <input id="' + prefix + 'Weight" type="number" min="0" max="100" step="any" value="0" /></label>'
        + '<label>Source <select id="' + prefix + 'Mode"><option value="off">Off</option><option value="uniform">Uniform scenario — simulation</option><option value="raster">Imported numerical grid</option></select></label>'
        + '<label id="' + prefix + 'UniformRow" hidden>Constant scenario value (' + spec.unit + ')'
        + '<input id="' + prefix + 'Value" type="number" step="any" value="' + spec.value + '" /></label>'
        + '<label>Import JSON grid (' + spec.unit + ') <input id="' + prefix + 'File" type="file" accept=".json,application/json" /></label>'
        + '<div class="environment-info" id="' + prefix + 'Info"></div>'
        + '<button id="' + prefix + 'Demo" type="button" class="preset-btn">Use SYNTHETIC example</button>'
        + '<button id="' + prefix + 'Remove" type="button" class="preset-btn" disabled>Remove grid from session</button>';
      el('environmentLayers').appendChild(card);
      el(prefix + 'Value').min = field === 'temperature' ? '-273.15' : '0';
      for (const suffix of ['Weight', 'Mode', 'Value']) el(prefix + suffix).addEventListener('input', changed);
      el(prefix + 'File').onchange = async event => {
        const file = event.target.files[0]; if (!file) return;
        try {
          if (file.size > 20000000) throw new Error('Use files up to 20 MB.');
          const validated = api.validateEnvironmentRaster(JSON.parse(await file.text()), field);
          rasters[field] = validated; el(prefix + 'Mode').value = 'raster';
          changed(); message('Grid for ' + spec.title.toLowerCase() + ' imported. Provenance is declared by the file, not verified by the app.');
        } catch (error) { message('Import rejected: ' + error.message); }
        finally { event.target.value = ''; }
      };
      el(prefix + 'Demo').onclick = () => {
        const grid = getGrid(), bounds = { ...grid.bounds }, width = 9, height = 9;
        const resolutionM = Math.max((bounds.latMax - bounds.latMin) * 3396190 * Math.PI / 180 / height,
          (bounds.lonMax - bounds.lonMin) * 3396190 * Math.PI / 180 / width);
        rasters[field] = api.validateEnvironmentRaster({ schemaVersion: 1, planet: 'Mars', quantity: spec.quantity, unit: spec.fileUnit,
          width, height, bounds, values: Array.from({ length: 81 }, (_, i) => {
            const x = i % 9, y = Math.floor(i / 9);
            return x >= 3 && x <= 5 && y >= 3 && y <= 5 ? spec.hot : spec.value;
          }), source: { title: 'SYNTHETIC EXAMPLE — ' + spec.title, kind: 'scenario', url: '', reference: 'surface',
            resolutionM, temporalContext: 'Static artificial scenario; not an observation of Mars.',
            note: 'Values created only to test the effect of weights. The central region is artificial.' } }, field);
        el(prefix + 'Mode').value = 'raster'; changed();
        message('SYNTHETIC example loaded. Set a positive weight to test; this does not represent Mars measurements.');
      };
      el(prefix + 'Remove').onclick = () => {
        delete rasters[field]; el(prefix + 'Mode').value = 'off'; el(prefix + 'Weight').value = '0'; changed();
      };
    }

    function getSnapshot() {
      const settings = {}, weights = {};
      for (const [key, id] of Object.entries(settingIds)) {
        if (!el(id).checkValidity() || el(id).value.trim() === '') throw new Error('Check environmental parameters.');
        settings[key] = Number(el(id).value);
      }
      settings.layers = {};
      for (const [field, spec] of Object.entries(fields)) {
        const prefix = 'environment' + spec.suffix;
        for (const suffix of ['Weight', 'Value']) if (!el(prefix + suffix).checkValidity() || el(prefix + suffix).value.trim() === '') {
          throw new Error('Check weight and value for ' + spec.title.toLowerCase() + '.');
        }
        weights[field] = Number(el(prefix + 'Weight').value);
        settings.layers[field] = { mode: el(prefix + 'Mode').value, value: Number(el(prefix + 'Value').value), raster: rasters[field] || null };
        if (weights[field] > 0 && settings.layers[field].mode === 'off') throw new Error('Choose a scenario or grid for ' + spec.title.toLowerCase() + ', or leave its weight at zero.');
      }
      return { settings: api.normalizeEnvironment(settings), weights };
    }
    function renderInfo() {
      for (const [field, spec] of Object.entries(fields)) {
        const prefix = 'environment' + spec.suffix, mode = el(prefix + 'Mode').value, data = rasters[field];
        el(prefix + 'UniformRow').hidden = mode !== 'uniform';
        el(prefix + 'Remove').disabled = !data;
        let text = mode === 'off' ? 'Off.' : mode === 'uniform'
          ? 'SCENARIO: uniform value with no spatial variation. Not a current measurement or local map.'
          : data ? (data.source.kind === 'scenario' ? 'SYNTHETIC SCENARIO: ' : 'PROVENANCE DECLARED BY FILE: ')
            + data.source.title + ' · ' + data.width + ' × ' + data.height + ' · declared resolution '
            + Math.round(data.source.resolutionM).toLocaleString('en-US') + ' m · ' + data.quantity + ' · ' + data.source.temporalContext
          : 'No grid imported. Import JSON with physical values and provenance.';
        if (Number(el(prefix + 'Weight').value) === 0) text += ' Zero weight: does not influence the route.';
        el(prefix + 'Info').textContent = text;
      }
    }
    function changed() {
      renderInfo(); onChange();
      try { getSnapshot(); message('Environmental configuration changed. Recalculate the route.'); }
      catch (error) { message(error.message); }
    }
    for (const id of Object.values(settingIds)) el(id).addEventListener('input', changed);
    el('resetEnvironment').onclick = () => {
      for (const spec of Object.values(fields)) { el('environment' + spec.suffix + 'Weight').value = '0'; el('environment' + spec.suffix + 'Mode').value = 'off'; }
      changed();
    };
    el('exportEnvironment').onclick = () => {
      try {
        const data = { schemaVersion: 1, type: 'mars-environment-config', planet: 'Mars', ...getSnapshot() };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'mars-environment.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { message(error.message); }
    };
    el('importEnvironment').onchange = async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        if (file.size > 20000000) throw new Error('Use files up to 20 MB.');
        const data = JSON.parse(await file.text());
        if (data.schemaVersion !== 1 || data.type !== 'mars-environment-config' || data.planet !== 'Mars') throw new Error('Invalid Mars environmental configuration.');
        const settings = api.normalizeEnvironment(data.settings);
        for (const field of Object.keys(fields)) {
          if (!Number.isFinite(data.weights?.[field]) || data.weights[field] < 0 || data.weights[field] > 100
              || (data.weights[field] > 0 && settings.layers[field].mode === 'off')) throw new Error('Incompatible environmental weights and sources.');
        }
        for (const [key, id] of Object.entries(settingIds)) el(id).value = settings[key];
        for (const [field, spec] of Object.entries(fields)) {
          const prefix = 'environment' + spec.suffix;
          rasters[field] = settings.layers[field].raster;
          el(prefix + 'Mode').value = settings.layers[field].mode; el(prefix + 'Value').value = settings.layers[field].value;
          el(prefix + 'Weight').value = data.weights[field];
        }
        changed(); message('Configuration and grids imported. Recalculate the route.');
      } catch (error) { message('Import rejected: ' + error.message); }
      finally { event.target.value = ''; }
    };
    renderInfo();
    return { getSnapshot };
  }
  globalThis.PeixonautasEnvironment = { createEditor };
})();
