/* Imported numerical fields and explicit scenarios. No fabricated sensor maps. */
(function () {
  'use strict';
  const fields = {
    radiation: { title: 'Radiação', suffix: 'Radiation', unit: 'µSv/h', quantity: 'radiationDoseEquivalentRate', fileUnit: 'uSv/h', value: 26.7, hot: 1000 },
    temperature: { title: 'Temperatura', suffix: 'Temperature', unit: '°C', quantity: 'airTemperature', fileUnit: 'degC', value: -60, hot: -120 },
    magnetism: { title: 'Magnetismo', suffix: 'Magnetism', unit: 'nT', quantity: 'magneticFieldMagnitude', fileUnit: 'nT', value: 200, hot: 5000 }
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
        + '<label>Peso <input id="' + prefix + 'Weight" type="number" min="0" max="100" step="any" value="0" /></label>'
        + '<label>Fonte <select id="' + prefix + 'Mode"><option value="off">Desligado</option><option value="uniform">Cenário uniforme — simulação</option><option value="raster">Grade numérica importada</option></select></label>'
        + '<label id="' + prefix + 'UniformRow" hidden>Valor constante do cenário (' + spec.unit + ')'
        + '<input id="' + prefix + 'Value" type="number" step="any" value="' + spec.value + '" /></label>'
        + '<label>Importar grade JSON (' + spec.unit + ') <input id="' + prefix + 'File" type="file" accept=".json,application/json" /></label>'
        + '<div class="environment-info" id="' + prefix + 'Info"></div>'
        + '<button id="' + prefix + 'Demo" type="button" class="preset-btn">Usar exemplo SINTÉTICO</button>'
        + '<button id="' + prefix + 'Remove" type="button" class="preset-btn" disabled>Remover grade da sessão</button>';
      el('environmentLayers').appendChild(card);
      el(prefix + 'Value').min = field === 'temperature' ? '-273.15' : '0';
      for (const suffix of ['Weight', 'Mode', 'Value']) el(prefix + suffix).addEventListener('input', changed);
      el(prefix + 'File').onchange = async event => {
        const file = event.target.files[0]; if (!file) return;
        try {
          if (file.size > 20000000) throw new Error('Use arquivos de até 20 MB.');
          const validated = api.validateEnvironmentRaster(JSON.parse(await file.text()), field);
          rasters[field] = validated; el(prefix + 'Mode').value = 'raster';
          changed(); message('Grade de ' + spec.title.toLowerCase() + ' importada. A procedência é declarada pelo arquivo, não verificada pelo aplicativo.');
        } catch (error) { message('Importação recusada: ' + error.message); }
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
          }), source: { title: 'EXEMPLO SINTÉTICO — ' + spec.title, kind: 'scenario', url: '', reference: 'surface',
            resolutionM, temporalContext: 'Cenário artificial estático; não é observação de Marte.',
            note: 'Valores criados apenas para testar o efeito dos pesos. A região central é artificial.' } }, field);
        el(prefix + 'Mode').value = 'raster'; changed();
        message('Exemplo SINTÉTICO carregado. Defina um peso maior que zero para testar; não representa medições de Marte.');
      };
      el(prefix + 'Remove').onclick = () => {
        delete rasters[field]; el(prefix + 'Mode').value = 'off'; el(prefix + 'Weight').value = '0'; changed();
      };
    }

    function getSnapshot() {
      const settings = {}, weights = {};
      for (const [key, id] of Object.entries(settingIds)) {
        if (!el(id).checkValidity() || el(id).value.trim() === '') throw new Error('Revise os parâmetros ambientais.');
        settings[key] = Number(el(id).value);
      }
      settings.layers = {};
      for (const [field, spec] of Object.entries(fields)) {
        const prefix = 'environment' + spec.suffix;
        for (const suffix of ['Weight', 'Value']) if (!el(prefix + suffix).checkValidity() || el(prefix + suffix).value.trim() === '') {
          throw new Error('Revise peso e valor de ' + spec.title.toLowerCase() + '.');
        }
        weights[field] = Number(el(prefix + 'Weight').value);
        settings.layers[field] = { mode: el(prefix + 'Mode').value, value: Number(el(prefix + 'Value').value), raster: rasters[field] || null };
        if (weights[field] > 0 && settings.layers[field].mode === 'off') throw new Error('Escolha cenário ou grade para ' + spec.title.toLowerCase() + ', ou deixe seu peso em zero.');
      }
      return { settings: api.normalizeEnvironment(settings), weights };
    }
    function renderInfo() {
      for (const [field, spec] of Object.entries(fields)) {
        const prefix = 'environment' + spec.suffix, mode = el(prefix + 'Mode').value, data = rasters[field];
        el(prefix + 'UniformRow').hidden = mode !== 'uniform';
        el(prefix + 'Remove').disabled = !data;
        let text = mode === 'off' ? 'Desligado.' : mode === 'uniform'
          ? 'CENÁRIO: valor uniforme, sem variação espacial. Não é medição atual nem mapa local.'
          : data ? (data.source.kind === 'scenario' ? 'CENÁRIO SINTÉTICO: ' : 'PROCEDÊNCIA DECLARADA PELO ARQUIVO: ')
            + data.source.title + ' · ' + data.width + ' × ' + data.height + ' · resolução declarada '
            + Math.round(data.source.resolutionM).toLocaleString('pt-BR') + ' m · ' + data.quantity + ' · ' + data.source.temporalContext
          : 'Nenhuma grade importada. Importe JSON com valores físicos e procedência.';
        if (Number(el(prefix + 'Weight').value) === 0) text += ' Peso zero: não influencia a rota.';
        el(prefix + 'Info').textContent = text;
      }
    }
    function changed() {
      renderInfo(); onChange();
      try { getSnapshot(); message('Configuração ambiental alterada. Recalcule a rota.'); }
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
        if (file.size > 20000000) throw new Error('Use arquivos de até 20 MB.');
        const data = JSON.parse(await file.text());
        if (data.schemaVersion !== 1 || data.type !== 'mars-environment-config' || data.planet !== 'Mars') throw new Error('Configuração ambiental de Marte inválida.');
        const settings = api.normalizeEnvironment(data.settings);
        for (const field of Object.keys(fields)) {
          if (!Number.isFinite(data.weights?.[field]) || data.weights[field] < 0 || data.weights[field] > 100
              || (data.weights[field] > 0 && settings.layers[field].mode === 'off')) throw new Error('Pesos e fontes ambientais incompatíveis.');
        }
        for (const [key, id] of Object.entries(settingIds)) el(id).value = settings[key];
        for (const [field, spec] of Object.entries(fields)) {
          const prefix = 'environment' + spec.suffix;
          rasters[field] = settings.layers[field].raster;
          el(prefix + 'Mode').value = settings.layers[field].mode; el(prefix + 'Value').value = settings.layers[field].value;
          el(prefix + 'Weight').value = data.weights[field];
        }
        changed(); message('Configuração e grades importadas. Recalcule a rota.');
      } catch (error) { message('Importação recusada: ' + error.message); }
      finally { event.target.value = ''; }
    };
    renderInfo();
    return { getSnapshot };
  }
  globalThis.PeixonautasEnvironment = { createEditor };
})();
