import fs from 'node:fs';

const [file, solArg] = process.argv.slice(2);
if (!file) {
  console.error('Uso: node scripts/summarize-rad.mjs <arquivo-RAD-RDR.TXT> [sol]');
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const sol = Number(solArg ?? text.match(/START_SOL=(\d+)/)?.[1]);
const values = [...text.matchAll(/\[DOSIMETRY_TOTAL_DOSE_E:\s*\d+\]\s*\r?\n\s*([-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?)/g)]
  .map((match) => Number(match[1]))
  .filter((value) => Number.isFinite(value) && value >= 0);

if (!values.length) {
  throw new Error(`Nenhuma leitura válida de DOSIMETRY_TOTAL_DOSE_E em ${file}`);
}

const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
console.log(JSON.stringify({
  sol: Number.isFinite(sol) ? sol : null,
  quantity: 'RAD E-detector dose rate',
  unit: 'microGy/hour',
  min: Math.min(...values),
  mean,
  max: Math.max(...values),
  meanMicroGyPerDay: mean * 24,
  observations: values.length,
  source: 'NASA PDS MSL-M-RAD-3-RDR-V1.0',
}, null, 2));
