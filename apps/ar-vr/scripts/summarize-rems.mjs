import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Usage: node summarize-rems.mjs <MODRDR .TAB file>');

const data = fs.readFileSync(input, 'utf8');
const values = { airTempC: [], pressurePa: [], humidityPct: [] };
let rows = 0;

for (const line of data.split(/\r?\n/)) {
  if (!line) continue;
  const columns = line.split(',');
  if (columns.length < 40) continue;
  rows++;

  const ambientK = Number(columns[15]);
  const humidity = Number(columns[30]);
  const pressure = Number(columns[37]);
  if (Number.isFinite(ambientK) && ambientK > 100 && ambientK < 350) values.airTempC.push(ambientK - 273.15);
  if (Number.isFinite(humidity) && humidity >= 0 && humidity <= 100) values.humidityPct.push(humidity);
  if (Number.isFinite(pressure) && pressure > 100 && pressure < 1500) values.pressurePa.push(pressure);
}

const summarize = (items) => {
  if (!items.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of items) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return { min, mean: sum / items.length, max, n: items.length };
};

const match = path.basename(input).match(/RMD(\d{4})/);
const sol = match ? Number(match[1]) : null;
console.log(JSON.stringify({ sol, sourceFile: path.basename(input), rows, airTempC: summarize(values.airTempC), pressurePa: summarize(values.pressurePa), humidityPct: summarize(values.humidityPct) }));
