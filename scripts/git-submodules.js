'use strict';

const { spawnSync } = require('node:child_process');

function parseSubmoduleStatus(output) {
  if (typeof output !== 'string') {
    throw new TypeError('Git submodule status output must be a string.');
  }

  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) continue;

    const marker = line[0];
    if (![' ', '+', '-', 'U'].includes(marker)) {
      throw new Error('Git returned an unrecognized submodule status line.');
    }

    const remainder = line.slice(1).trimStart();
    const separator = remainder.indexOf(' ');
    if (separator < 1) {
      throw new Error('Git returned an unrecognized submodule status line.');
    }

    const commit = remainder.slice(0, separator);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
      throw new Error('Git returned an unrecognized submodule commit identifier.');
    }

    let submodulePath = remainder.slice(separator + 1).trim();
    const annotationStart = submodulePath.lastIndexOf(' (');
    if (annotationStart >= 0 && submodulePath.endsWith(')')) {
      submodulePath = submodulePath.slice(0, annotationStart);
    }
    if (!submodulePath) {
      throw new Error('Git returned an empty submodule path.');
    }

    entries.push({ marker, commit: commit.toLowerCase(), path: submodulePath });
  }
  return entries;
}

/**
 * Verify recursive submodules against commits pinned by the superproject.
 * This is read-only: it never initializes, checks out, resets, or cleans.
 */
function assertGitSubmodulesReady({ cwd, spawnSyncImpl = spawnSync } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('A repository working directory is required.');
  }
  if (typeof spawnSyncImpl !== 'function') {
    throw new TypeError('spawnSyncImpl must be a function.');
  }

  const result = spawnSyncImpl(
    'git',
    ['submodule', 'status', '--recursive'],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 5000 }
  );

  if (!result || result.error || result.status !== 0) {
    throw new Error(
      'Unable to inspect Git submodule state. Run development bootstrap from a full Git checkout with Git available.'
    );
  }

  const entries = parseSubmoduleStatus(result.stdout || '');
  const paths = items => items.map(item => item.path).join(', ');

  const uninitialized = entries.filter(item => item.marker === '-');
  if (uninitialized.length > 0) {
    throw new Error(
      'Required Git submodule(s) are not initialized: ' + paths(uninitialized) +
      '. Run git submodule update --init --recursive from the repository root, then retry. ' +
      'For a fresh checkout, use git clone --recurse-submodules.'
    );
  }

  const conflicts = entries.filter(item => item.marker === 'U');
  if (conflicts.length > 0) {
    throw new Error(
      'Git reports unresolved submodule conflicts: ' + paths(conflicts) +
      '. Resolve the submodule conflict before running development bootstrap.'
    );
  }

  const mismatched = entries.filter(item => item.marker === '+');
  if (mismatched.length > 0) {
    throw new Error(
      'Git submodule checkout(s) differ from the commits pinned by this repository: ' +
      paths(mismatched) +
      '. Inspect local submodule status and preserve any work before deciding whether to run ' +
      'git submodule update --init --recursive. Bootstrap will not overwrite or reset a developer checkout.'
    );
  }

  return entries.map(({ commit, path }) => ({ commit, path }));
}

module.exports = { assertGitSubmodulesReady, parseSubmoduleStatus };
