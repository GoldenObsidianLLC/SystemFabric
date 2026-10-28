#!/usr/bin/env node
'use strict';
const engine = require('../index');

async function main(argv) {
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h' || !command) return help();
  if (command !== 'build') throw new Error(`Unknown command: ${command}\nRun "enginex --help" for usage.`);
  const options = parseFlags(args);
  if (!options.root || !options.out) throw new Error('build requires --root <views-dir> and --out <manifest.json>.');
  const result = await engine.writeManifest(options.root, options.out, { entry: options.entry });
  process.stdout.write(`${JSON.stringify({ success: true, format: 'validated-ast-manifest', ...result }, null, 2)}\n`);
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!['--root', '--out', '--entry'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${arg}.`);
    result[arg.slice(2)] = value;
  }
  return result;
}
function help() {
  process.stdout.write('EnginEx AI-Native 6.2\n\nUsage:\n  enginex build --root ./views --out ./dist/templates.json --entry index.html\n\nBuilds and validates a JSON AST manifest. Rendering loads the manifest once and compiles reusable synchronous render functions; template source does not need to be read or parsed for each request.\n');
}
main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`EnginEx: ${error.message}\n`);
  process.exitCode = 1;
});
