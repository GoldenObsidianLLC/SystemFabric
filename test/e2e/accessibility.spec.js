'use strict';

const { test, expect } = require('@playwright/test');

test('sign-in form exposes labels, landmark structure, status messages, and keyboard operation', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthenticated' }) }));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Studio sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with OIDC' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();

  const labelChecks = await page.evaluate(() => ['login-email', 'login-password'].map(id => {
    const input = document.getElementById(id);
    return { id, labelCount: input?.labels?.length || 0, autocomplete: input?.getAttribute('autocomplete') || '' };
  }));
  expect(labelChecks.every(item => item.labelCount > 0)).toBe(true);
  expect(labelChecks.map(item => item.autocomplete)).toEqual(['username', 'current-password']);
  await expect(page.locator('#login-status')).toHaveAttribute('role', 'status');

  await page.keyboard.press('Tab');
  await expect(page.locator('#login-email')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#login-password')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
});

test('Platform Hub contains labeled form controls and live status regions', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthenticated' }) }));
  await page.goto('/platform');
  await expect(page).toHaveTitle('SystemFabric Platform Hub');
  await expect(page.getByRole('heading', { name: 'One platform, connected services.' })).toBeVisible();
  const unlabeled = await page.locator('input:not([type="hidden"]), select, textarea').evaluateAll(elements => elements.filter(el => {
    if (el.disabled || el.closest('[hidden], .hidden')) return false;
    return !(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
  }).map(el => `${el.tagName.toLowerCase()}#${el.id}`));
  expect(unlabeled).toEqual([]);
  await expect(page.locator('[role="status"], [aria-live="polite"]').first()).toBeAttached();
});
