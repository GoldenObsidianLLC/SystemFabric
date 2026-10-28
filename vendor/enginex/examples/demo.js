'use strict';
const path = require('node:path');
const engine = require('../index');
const views = path.join(__dirname, 'views');

async function main() {
  const ai = engine.createAI({ renderOptions: { views } });
  const source = '<h1>Hello, {{ user.name }}!</h1>{{#each items as item}}<p>{{ item | upper }}</p>{{/each}}';
  console.log('Capabilities:', JSON.stringify(ai.describe(), null, 2));
  console.log('Analysis:', JSON.stringify(ai.explainTemplate({ source }), null, 2));
  const preview = await ai.previewTemplate({
    source,
    sampleData: { user: { name: 'Ada & Grace' }, items: ['templating', 'AI'] },
    renderOptions: { views }
  });
  if (!preview.success) throw new Error(JSON.stringify(preview.diagnostics));
  console.log('Preview:', preview.html);
  const html = await engine('product-list.html', {
    views,
    locals: {
      siteName: 'Northstar Store',
      products: [{ name: 'Notebook', price: 8.5 }, { name: 'Pen', price: 2.25 }]
    }
  });
  console.log('Layout render:', html);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
