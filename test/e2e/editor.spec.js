'use strict';

const { test, expect } = require('@playwright/test');
const siteId = '11111111-1111-4111-8111-111111111111';
const contentId = '22222222-2222-4222-8222-222222222222';
const savedPages = [];

async function installMocks(page) {
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    user: { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.test', displayName: 'E2E Owner' },
    sites: [{ siteId, siteSlug: 'e2e', siteName: 'E2E Site', roles: ['site-owner'], capabilities: ['*'] }]
  }) }));
  await page.route('**/api/v1/pages/drafts', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 405, body: 'Method not allowed' });
    const body = route.request().postDataJSON();
    const item = { id: contentId, siteId, title: body.document.title, slug: body.slug, status: 'draft', version: 1, updated_at: new Date().toISOString() };
    savedPages.splice(0, savedPages.length, item);
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ content: { ...item, body: body.document } }) });
  });
  await page.route('**/api/v1/pages**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/v1/pages') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: savedPages }) });
    return route.fallback();
  });
  await page.route('**/api/v1/pages/validate', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, errors: [] }) }));
  await page.route('**/api/v1/preview', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h1>Preview fixture</h1></body></html>' }));
}

test.beforeEach(async ({ page }) => { savedPages.length = 0; await installMocks(page); await page.goto('/admin'); await expect(page.locator('#app-shell')).toBeVisible(); });

test('editor adds widgets, changes viewport, supports undo, and renders preview', async ({ page }) => {
  await page.locator('[data-component="widget.heading"]').click();
  await expect(page.locator('#canvas-root h2')).toBeVisible();
  await expect(page.locator('#node-count')).toContainText('2 components');
  await page.locator('[data-viewport="mobile"]').click();
  await expect(page.locator('#canvas-frame')).toHaveClass(/mobile/);
  await page.locator('#undo').click();
  await expect(page.locator('#node-count')).toContainText('1 component');
  await page.locator('#preview-button').click();
  await expect(page.locator('#preview-dialog')).toBeVisible();
  await expect.poll(() => page.locator('#preview-frame').evaluate(el => el.srcdoc)).toContain('Preview fixture');
});

test('editor saves a draft and displays the returned revision', async ({ page }) => {
  await page.locator('#document-title').fill('A Playwright Page');
  await page.locator('#page-slug').fill('playwright-page');
  await page.locator('#save-button').click();
  await expect(page.locator('#version-label')).toContainText('v1');
  await expect(page.locator('#page-list')).toContainText('A Playwright Page');
  await expect(page.locator('#dirty-status')).toContainText('All changes saved');
});
