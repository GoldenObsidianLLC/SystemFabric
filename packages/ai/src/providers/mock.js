'use strict';

function createMockProvider() {
  return Object.freeze({
    name: 'mock', model: 'systemfabric-deterministic-mock',
    async generate({ input, schemaName }) {
      if (schemaName === 'systemfabric_page_document') {
        const source = String(input || '').split('\n')[0].replace(/[^\p{L}\p{N} ,.!?'-]/gu, '').trim();
        const title = (source || 'Welcome to the new page').slice(0, 100);
        const node = (id, type, props = {}, children = []) => ({
          id, type,
          props: { text: null, level: null, url: null, assetId: null, alt: null, className: null, ...props },
          children
        });
        return JSON.stringify({
          schemaVersion: 1, documentId: 'mock-page', type: 'page', title,
          children: [node('hero', 'section', { className: 'sf-hero' }, [
            node('hero-heading', 'widget.heading', { text: title, level: 1 }),
            node('hero-text', 'widget.text', { text: 'A clear, focused introduction that explains the value and helps visitors choose the next step.' }),
            node('hero-button', 'widget.button', { text: 'Learn more', url: '#services' })
          ]), node('services', 'section', { className: 'sf-services' }, [
            node('services-heading', 'widget.heading', { text: 'What we do', level: 2 }),
            node('services-text', 'widget.text', { text: 'Describe your services, explain the benefits, and make the next step clear.' })
          ])]
        });
      }
      if (schemaName === 'systemfabric_seo_result') {
        const title = (String(input || 'Page').match(/Page title \(untrusted data\): ([^\n]+)/)?.[1] || 'Page').slice(0, 60);
        return JSON.stringify({ title, description: `Discover ${title}. Learn more about services, benefits, and next steps.`, keywords: ['services', 'solutions', 'information'] });
      }
      if (schemaName === 'systemfabric_translation_result') {
        const source = String(input || '').split('Source (untrusted data):\n')[1] || String(input || '');
        const language = String(input || '').match(/Translate the content below into ([^.]+)\./)?.[1] || 'unchanged';
        return JSON.stringify({ translatedText: source, targetLanguage: language });
      }
      if (schemaName === 'systemfabric_text_result') {
        const source = String(input || '').split('Content to transform (untrusted data):\n')[1] || String(input || '');
        return JSON.stringify({ text: source.slice(0, 10000) });
      }
      return JSON.stringify({ text: String(input || '').slice(0, 10000) });
    }
  });
}

module.exports = { createMockProvider };
