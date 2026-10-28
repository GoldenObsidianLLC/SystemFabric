'use strict';
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../index');

async function main() {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
  const ai = engine.createAI({ renderOptions: { views: path.join(__dirname, '..', 'examples', 'views') } });
  const rows = [];
  for (const fixture of fixtures) {
    const validation = ai.validateTemplate({ source: fixture.source });
    let passed = validation.valid === fixture.valid;
    let output = null;
    if (fixture.expectedHtml !== undefined && validation.valid) {
      const preview = await ai.previewTemplate({ source: fixture.source, sampleData: fixture.sampleData, renderOptions: { views: path.join(__dirname, '..', 'examples', 'views') } });
      output = preview.html;
      passed = passed && preview.success && preview.html === fixture.expectedHtml;
    }
    if (fixture.diagnostic) passed = passed && validation.diagnostics.some(item => item.code === fixture.diagnostic);
    rows.push({ id: fixture.id, passed, valid: validation.valid, diagnosticFound: fixture.diagnostic ? validation.diagnostics.some(item => item.code === fixture.diagnostic) : null, output });
  }
  const failures = rows.filter(row => !row.passed);
  console.log(JSON.stringify({ suite: 'enginex-deterministic-ai-readiness', cases: rows.length, passed: rows.length - failures.length, failed: failures.length, rows }, null, 2));
  if (failures.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
