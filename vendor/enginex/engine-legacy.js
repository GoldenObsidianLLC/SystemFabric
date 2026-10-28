'use strict';

/**
 * EnginEx Deep — dependency-free HTML template engine with interpolation and nested blocks.
 *
 * Compatibility:
 *   engine(filePath, options, callback)  // Express-compatible
 *   await engine(filePath, options)      // Promise API
 *
 * Template syntax:
 *   <h1>Hello</h1>
 *   <?njs echo(window.name); ?>
 *   <?njs echo(escapeHtml(window.untrustedName)); ?>
 *   <?njs include('partials/header'); ?>
 *   {{ user.profile.name }}       escaped interpolation
 *   {{{ trustedHtml }}}          raw interpolation
 *   {{#if user}}...{{else}}...{{/if}}
 *   {{#each items as item, index}}...{{/each}}
 *   {{#with user as account}}...{{/with}}
 *   {{> cards/user user}}         partial with context overrides
 *
 * The engine deliberately does not parse JavaScript into an AST. Template text
 * is emitted as JSON-escaped literals, and JavaScript blocks are compiled with
 * the built-in Function constructor. Only trusted templates should be executed.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const nodeRequire = require;

const OPEN_DELIMITER = '<?njs';
const CLOSE_DELIMITER = '?>';
const DEFAULT_EXTENSION = '.html';
const DEFAULT_MAX_CACHE_ENTRIES = 500;
const DEFAULT_MAX_INCLUDE_DEPTH = 64;
const RESERVED_TEMPLATE_BINDINGS = [
    'window', 'globals', 'echo', 'include', 'require',
    '__enginexEcho', '__enginexEscapeHtml', '__enginexEntries', '__enginexRoot'
];
const GLOBAL_BINDINGS = new Set(Object.getOwnPropertyNames(globalThis).concat(
    RESERVED_TEMPLATE_BINDINGS, ['arguments', 'eval']
));

const BUILTIN_HELPERS = Object.freeze({
    upper: value => String(value ?? '').toUpperCase(),
    lower: value => String(value ?? '').toLowerCase(),
    capitalize: value => {
        const text = String(value ?? '');
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    },
    defaultValue: (value, fallback = '') => value == null || value === '' ? fallback : value,
    join: (value, separator = ', ') => Array.isArray(value) ? value.join(separator) : value == null ? '' : String(value),
    length: value => {
        if (value == null) return 0;
        if (typeof value.length === 'number') return value.length;
        if (typeof value.size === 'number') return value.size;
        if (typeof value === 'object') return Object.keys(value).length;
        return String(value).length;
    },
    urlencode: value => encodeURIComponent(String(value ?? '')),
    formatNumber: (value, locale = 'en-US', options = {}) => new Intl.NumberFormat(locale, options).format(Number(value)),
    formatCurrency: (value, currency = 'USD', locale = 'en-US') => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(value)),
    json: (value, space = 0) => JSON.stringify(value, null, space)
});

// A bounded LRU cache. In the default mode entries remain cached until cleared;
// `cache: 'mtime'` additionally checks file metadata on each access.
const compiledTemplateCache = new Map();
const compilationInFlight = new Map();
const cacheCounters = { hits: 0, misses: 0, compiles: 0, evictions: 0 };
const HTML_ESCAPE_PATTERN = /[&<>\"']/g;
const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/y;
const NUMBER_PATTERN = /(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;',
    "'": '&#39;'
};

function escapeHtml(value) {
    return String(value ?? '').replace(HTML_ESCAPE_PATTERN, character => HTML_ESCAPE_MAP[character]);
}

class TemplateEngineError extends Error {
    constructor(message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'TemplateEngineError';
        if (options.code) this.code = options.code;
        if (options.templatePath) this.templatePath = options.templatePath;
    }
}

function ensureTemplateExtension(templateName) {
    const name = String(templateName);
    return path.extname(name) ? name : name + DEFAULT_EXTENSION;
}

function getViewsRoot(options) {
    const configuredRoot = options.root ?? options.views;
    if (Array.isArray(configuredRoot)) return configuredRoot[0] ? path.resolve(configuredRoot[0]) : null;
    return configuredRoot ? path.resolve(configuredRoot) : null;
}

function isInsideDirectory(rootDirectory, candidatePath) {
    const relativePath = path.relative(rootDirectory, candidatePath);
    return relativePath === '' || (
        relativePath !== '..' &&
        !relativePath.startsWith('..' + path.sep) &&
        !path.isAbsolute(relativePath)
    );
}

function assertPathAllowed(candidatePath, options, templatePathForError) {
    if (!options.strictPaths) return candidatePath;

    const rootDirectory = getViewsRoot(options);
    if (!rootDirectory) {
        throw new TemplateEngineError(
            'strictPaths requires an options.root or options.views directory.',
            { code: 'ERR_TEMPLATE_ROOT_REQUIRED', templatePath: templatePathForError }
        );
    }

    if (!isInsideDirectory(rootDirectory, candidatePath)) {
        throw new TemplateEngineError(
            'Template path is outside the configured template root: ' + candidatePath,
            { code: 'ERR_TEMPLATE_PATH_OUTSIDE_ROOT', templatePath: templatePathForError }
        );
    }

    return candidatePath;
}

async function canonicalizeTemplatePathAsync(candidatePath, options) {
    if (!options.strictPaths) return candidatePath;

    const rootDirectory = getViewsRoot(options);
    try {
        const [realRoot, realCandidate] = await Promise.all([
            fsp.realpath(rootDirectory),
            fsp.realpath(candidatePath)
        ]);
        if (!isInsideDirectory(realRoot, realCandidate)) {
            throw new TemplateEngineError(
                'Template resolves outside the configured template root: ' + candidatePath,
                { code: 'ERR_TEMPLATE_PATH_OUTSIDE_ROOT', templatePath: candidatePath }
            );
        }
        return realCandidate;
    } catch (error) {
        if (error instanceof TemplateEngineError) throw error;
        throw new TemplateEngineError(
            'Unable to resolve template path (' + candidatePath + '): ' + error.message,
            { code: 'ERR_TEMPLATE_REALPATH', templatePath: candidatePath, cause: error }
        );
    }
}

function canonicalizeTemplatePathSync(candidatePath, options) {
    if (!options.strictPaths) return candidatePath;

    const rootDirectory = getViewsRoot(options);
    try {
        const realRoot = fs.realpathSync(rootDirectory);
        const realCandidate = fs.realpathSync(candidatePath);
        if (!isInsideDirectory(realRoot, realCandidate)) {
            throw new TemplateEngineError(
                'Template resolves outside the configured template root: ' + candidatePath,
                { code: 'ERR_TEMPLATE_PATH_OUTSIDE_ROOT', templatePath: candidatePath }
            );
        }
        return realCandidate;
    } catch (error) {
        if (error instanceof TemplateEngineError) throw error;
        throw new TemplateEngineError(
            'Unable to resolve included template path (' + candidatePath + '): ' + error.message,
            { code: 'ERR_TEMPLATE_REALPATH', templatePath: candidatePath, cause: error }
        );
    }
}

function resolveInitialTemplatePath(templateFilePath, options) {
    if (typeof templateFilePath !== 'string' || templateFilePath.trim() === '') {
        throw new TypeError('A template file path is required.');
    }

    const templateName = ensureTemplateExtension(templateFilePath);
    const viewsRoot = getViewsRoot(options);
    const candidatePath = path.isAbsolute(templateName)
        ? path.resolve(templateName)
        : path.resolve(viewsRoot || process.cwd(), templateName);

    return assertPathAllowed(candidatePath, options, candidatePath);
}

function resolveIncludedTemplatePath(templateName, parentTemplatePath, options) {
    if (typeof templateName !== 'string' || templateName.trim() === '') {
        throw new TypeError('include() requires a non-empty string template name.');
    }

    const requestedName = ensureTemplateExtension(templateName);
    const candidatePath = path.isAbsolute(requestedName)
        ? path.resolve(requestedName)
        : path.resolve(path.dirname(parentTemplatePath), requestedName);

    return assertPathAllowed(candidatePath, options, parentTemplatePath);
}

function getFileSignature(stats) {
    return [stats.mtimeMs, stats.ctimeMs, stats.size].join(':');
}

function normalizeCacheMode(options) {
    if (options.cache === false || options.cache === 0) return false;
    if (options.cache === 'mtime') return 'mtime';
    return true;
}

function getMaxCacheEntries(options) {
    const value = options.cacheMaxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError('cacheMaxEntries must be a non-negative integer.');
    }
    return value;
}

function getCacheEntry(templatePath) {
    const entry = compiledTemplateCache.get(templatePath);
    if (!entry) return undefined;

    // Refresh recency without creating another collection.
    compiledTemplateCache.delete(templatePath);
    compiledTemplateCache.set(templatePath, entry);
    return entry;
}

function setCacheEntry(templatePath, entry, maxEntries) {
    if (maxEntries === 0) return;

    compiledTemplateCache.delete(templatePath);
    compiledTemplateCache.set(templatePath, entry);

    while (compiledTemplateCache.size > maxEntries) {
        const oldestKey = compiledTemplateCache.keys().next().value;
        if (oldestKey === undefined) break;
        compiledTemplateCache.delete(oldestKey);
        cacheCounters.evictions++;
    }
}

function shouldCache(cacheMode, maxEntries) {
    return cacheMode !== false && maxEntries > 0;
}

/**
 * Find the closing ?> delimiter without mistaking it for a delimiter inside
 * quoted strings, template literals, regular-expression literals, or comments.
 * This is a lightweight delimiter scanner, not a full JavaScript parser.
 */
function matchAt(pattern, source, index) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    return match && match.index === index ? match[0] : null;
}

function findCodeBlockEnd(source, startIndex) {
    let index = startIndex;
    let regexMayStart = true;

    while (index < source.length) {
        if (source.startsWith(CLOSE_DELIMITER, index)) return index;

        const character = source[index];
        const nextCharacter = source[index + 1];

        if (character === "'" || character === '"') {
            index = skipQuotedString(source, index, character);
            regexMayStart = false;
            continue;
        }

        if (character === '`') {
            index = skipTemplateLiteral(source, index);
            regexMayStart = false;
            continue;
        }

        if (character === '/' && nextCharacter === '/') {
            index = skipLineComment(source, index + 2);
            continue;
        }

        if (character === '/' && nextCharacter === '*') {
            index = skipBlockComment(source, index + 2);
            continue;
        }

        if (character === '/' && regexMayStart) {
            const regexEnd = skipRegExpLiteral(source, index);
            if (regexEnd !== -1) {
                index = regexEnd;
                regexMayStart = false;
                continue;
            }
        }

        if (/\s/.test(character)) {
            index++;
            continue;
        }

        const identifier = matchAt(IDENTIFIER_PATTERN, source, index);
        if (identifier) {
            regexMayStart = REGEX_PREFIX_KEYWORDS.has(identifier);
            index += identifier.length;
            continue;
        }

        if (/[0-9]/.test(character) || character === '.' && /[0-9]/.test(nextCharacter || '')) {
            const number = matchAt(NUMBER_PATTERN, source, index);
            index += number ? number.length : 1;
            regexMayStart = false;
            continue;
        }

        if (character === '+' && nextCharacter === '+' || character === '-' && nextCharacter === '-') {
            index += 2;
            regexMayStart = false;
            continue;
        }

        if (character === '.' || character === ')' || character === ']' || character === '}') {
            regexMayStart = false;
        } else if ('([{,:;=!?~*%&|^<>+-'.includes(character)) {
            regexMayStart = true;
        } else {
            regexMayStart = false;
        }

        index++;
    }

    return -1;
}

const REGEX_PREFIX_KEYWORDS = new Set([
    'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
    'of', 'return', 'throw', 'typeof', 'void', 'yield'
]);

function skipQuotedString(source, startIndex, quote) {
    let index = startIndex + 1;
    while (index < source.length) {
        const character = source[index];
        if (character === '\\') {
            index += 2;
            continue;
        }
        if (character === quote) return index + 1;
        index++;
    }
    return source.length;
}

function skipTemplateLiteral(source, startIndex) {
    let index = startIndex + 1;
    while (index < source.length) {
        const character = source[index];
        if (character === '\\') {
            index += 2;
            continue;
        }
        if (character === '`') return index + 1;
        if (character === '$' && source[index + 1] === '{') {
            index = skipTemplateExpression(source, index + 2);
            continue;
        }
        index++;
    }
    return source.length;
}

function skipTemplateExpression(source, startIndex) {
    let index = startIndex;
    let braceDepth = 1;
    let regexMayStart = true;

    while (index < source.length) {
        const character = source[index];
        const nextCharacter = source[index + 1];

        if (character === "'" || character === '"') {
            index = skipQuotedString(source, index, character);
            regexMayStart = false;
            continue;
        }
        if (character === '`') {
            index = skipTemplateLiteral(source, index);
            regexMayStart = false;
            continue;
        }
        if (character === '/' && nextCharacter === '/') {
            index = skipLineComment(source, index + 2);
            continue;
        }
        if (character === '/' && nextCharacter === '*') {
            index = skipBlockComment(source, index + 2);
            continue;
        }
        if (character === '/' && regexMayStart) {
            const regexEnd = skipRegExpLiteral(source, index);
            if (regexEnd !== -1) {
                index = regexEnd;
                regexMayStart = false;
                continue;
            }
        }
        if (/\s/.test(character)) {
            index++;
            continue;
        }

        const identifier = matchAt(IDENTIFIER_PATTERN, source, index);
        if (identifier) {
            regexMayStart = REGEX_PREFIX_KEYWORDS.has(identifier);
            index += identifier.length;
            continue;
        }

        if (character === '{') {
            braceDepth++;
            regexMayStart = true;
            index++;
            continue;
        }
        if (character === '}') {
            braceDepth--;
            index++;
            if (braceDepth === 0) return index;
            regexMayStart = false;
            continue;
        }
        if (character === '+' && nextCharacter === '+' || character === '-' && nextCharacter === '-') {
            index += 2;
            regexMayStart = false;
            continue;
        }

        if (character === '.' || character === ')' || character === ']') {
            regexMayStart = false;
        } else if ('([{,:;=!?~*%&|^<>+-'.includes(character)) {
            regexMayStart = true;
        } else {
            regexMayStart = false;
        }
        index++;
    }

    return source.length;
}

function skipLineComment(source, index) {
    while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
    return index;
}

function skipBlockComment(source, index) {
    const endIndex = source.indexOf('*/', index);
    return endIndex === -1 ? source.length : endIndex + 2;
}

function skipRegExpLiteral(source, startIndex) {
    let index = startIndex + 1;
    let insideCharacterClass = false;

    while (index < source.length) {
        const character = source[index];
        if (character === '\\') {
            index += 2;
            continue;
        }
        if (character === '\n' || character === '\r') return -1;
        if (character === '[') insideCharacterClass = true;
        else if (character === ']') insideCharacterClass = false;
        else if (character === '/' && !insideCharacterClass) {
            index++;
            while (index < source.length && /[a-z]/i.test(source[index])) index++;
            return index;
        }
        index++;
    }
    return -1;
}

function compileTemplateSource(source, templatePath) {
    const generatedStatements = [];
    const blockStack = [];
    let cursor = 0;
    let generatedBlockId = 0;

    while (cursor < source.length) {
        const njsIndex = source.indexOf(OPEN_DELIMITER, cursor);
        const mustacheIndex = source.indexOf('{{', cursor);
        let openingIndex;
        let kind;

        if (njsIndex === -1 && mustacheIndex === -1) {
            appendText(source.slice(cursor));
            cursor = source.length;
            break;
        }
        if (njsIndex !== -1 && (mustacheIndex === -1 || njsIndex < mustacheIndex)) {
            openingIndex = njsIndex;
            kind = 'njs';
        } else {
            openingIndex = mustacheIndex;
            kind = 'mustache';
        }

        if (openingIndex > cursor) appendText(source.slice(cursor, openingIndex));

        if (kind === 'njs') {
            const codeStart = openingIndex + OPEN_DELIMITER.length;
            const closingIndex = findCodeBlockEnd(source, codeStart);
            if (closingIndex === -1) {
                throw new TemplateEngineError(
                    'Unclosed <?njs block in template: ' + templatePath,
                    { code: 'ERR_TEMPLATE_UNCLOSED_BLOCK', templatePath }
                );
            }
            const javascript = source.slice(codeStart, closingIndex);
            if (javascript.trim()) generatedStatements.push(javascript);
            cursor = closingIndex + CLOSE_DELIMITER.length;
            continue;
        }

        const isRaw = source.startsWith('{{{', openingIndex);
        const expressionStart = openingIndex + (isRaw ? 3 : 2);
        const delimiter = isRaw ? '}}}' : '}}';
        const closingIndex = findInterpolationEnd(source, expressionStart, delimiter);
        if (closingIndex === -1) {
            throw new TemplateEngineError(
                'Unclosed ' + (isRaw ? '{{{' : '{{') + ' interpolation in template: ' + templatePath,
                { code: 'ERR_TEMPLATE_UNCLOSED_INTERPOLATION', templatePath }
            );
        }

        const content = source.slice(expressionStart, closingIndex).trim();
        processMustache(content, isRaw);
        cursor = closingIndex + delimiter.length;
    }

    if (source.length === 0) generatedStatements.length = 0;
    if (blockStack.length) {
        const unclosed = blockStack[blockStack.length - 1];
        throw new TemplateEngineError(
            'Unclosed template block {{#' + unclosed.type + '}} in ' + templatePath,
            { code: 'ERR_TEMPLATE_UNCLOSED_BLOCK_DIRECTIVE', templatePath }
        );
    }

    // All blocks run in a non-strict with-scope so locals like `user.name`
    // resolve naturally, while NJS templates may continue to use `window.name`.
    // Reserved runtime bindings are removed from the locals object before render.
    const sourceURL = String(templatePath).replace(/[\r\n]/g, '_').replace(/\\/g, '/');
    const generatedBody = 'with (window) {\n' + generatedStatements.join('\n') + '\n}\n//# sourceURL=' + sourceURL;

    let compiledFunction;
    try {
        compiledFunction = new Function(
            'window',
            'globals',
            'echo',
            'include',
            'require',
            'escapeHtml',
            '__enginexEcho',
            '__enginexEscapeHtml',
            '__enginexEntries',
            '__enginexRoot',
            generatedBody
        );
    } catch (error) {
        throw new TemplateEngineError(
            'Unable to compile template ' + templatePath + ': ' + error.message,
            { code: 'ERR_TEMPLATE_COMPILE', templatePath, cause: error }
        );
    }

    return compiledFunction;

    function appendText(text) {
        if (text.length > 0) generatedStatements.push('echo(' + JSON.stringify(text) + ');');
    }

    function appendInterpolation(expression, raw) {
        if (!expression) {
            throw new TemplateEngineError(
                'Empty interpolation in template: ' + templatePath,
                { code: 'ERR_TEMPLATE_EMPTY_INTERPOLATION', templatePath }
            );
        }
        const normalizedExpression = translateLoopMetadata(expression, blockStack);
        if (raw) {
            generatedStatements.push('__enginexEcho((' + normalizedExpression + '));');
        } else {
            generatedStatements.push('__enginexEcho(__enginexEscapeHtml((' + normalizedExpression + ')));');
        }
    }

    function processMustache(content, raw) {
        if (!raw && content.startsWith('!')) return; // {{! comment }}

        if (!raw && content.startsWith('#')) {
            openBlock(content.slice(1).trim());
            return;
        }
        if (!raw && content === 'else') {
            switchElse();
            return;
        }
        if (!raw && content.startsWith('/')) {
            closeBlock(content.slice(1).trim());
            return;
        }
        if (!raw && content.startsWith('>')) {
            appendPartial(content.slice(1).trim());
            return;
        }
        if (raw && (content.startsWith('#') || content === 'else' || content.startsWith('/') || content.startsWith('>'))) {
            throw new TemplateEngineError(
                'Control directives and partials must use double braces in ' + templatePath,
                { code: 'ERR_TEMPLATE_INVALID_DIRECTIVE', templatePath }
            );
        }
        appendInterpolation(content, raw);
    }

    function openBlock(directive) {
        const ifMatch = directive.match(/^(if|unless)\s+([\s\S]+)$/);
        if (ifMatch) {
            const type = ifMatch[1];
            const expression = translateLoopMetadata(ifMatch[2].trim(), blockStack);
            generatedStatements.push(type === 'if' ? 'if (' + expression + ') {' : 'if (!(' + expression + ')) {');
            blockStack.push({ type, hasElse: false });
            return;
        }

        const eachMatch = directive.match(/^each\s+([\s\S]+?)(?:\s+as\s+([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?)?$/);
        if (eachMatch) {
            const expression = translateLoopMetadata(eachMatch[1].trim(), blockStack);
            const itemName = eachMatch[2] || 'item';
            const indexName = eachMatch[3] || 'index';
            const id = generatedBlockId++;
            const names = {
                items: '__enginexItems' + id,
                record: '__enginexRecord' + id,
                key: '__enginexKey' + id,
                value: '__enginexValue' + id,
                index: '__enginexIndex' + id
            };
            generatedStatements.push(
                'const ' + names.items + ' = __enginexEntries((' + expression + '));' +
                ' if (' + names.items + '.length > 0) {' +
                ' for (let ' + names.record + ' = 0; ' + names.record + ' < ' + names.items + '.length; ' + names.record + '++) {' +
                ' const [' + names.key + ', ' + names.value + '] = ' + names.items + '[' + names.record + '];' +
                ' const ' + names.index + ' = ' + names.record + ';' +
                ' const ' + itemName + ' = ' + names.value + ';' +
                ' const ' + indexName + ' = ' + names.index + ';'
            );
            blockStack.push({ type: 'each', hasElse: false, names });
            return;
        }

        const withMatch = directive.match(/^with\s+([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (withMatch) {
            const expression = translateLoopMetadata(withMatch[1].trim(), blockStack);
            generatedStatements.push('{ const ' + withMatch[2] + ' = (' + expression + ');');
            blockStack.push({ type: 'with', hasElse: false });
            return;
        }

        throw new TemplateEngineError(
            'Unknown template block directive: {{#' + directive + '}} in ' + templatePath,
            { code: 'ERR_TEMPLATE_UNKNOWN_DIRECTIVE', templatePath }
        );
    }

    function switchElse() {
        const block = blockStack[blockStack.length - 1];
        if (!block || !['if', 'unless', 'each'].includes(block.type)) {
            throw new TemplateEngineError(
                '{{else}} must be inside an {{#if}}, {{#unless}}, or {{#each}} block in ' + templatePath,
                { code: 'ERR_TEMPLATE_UNEXPECTED_ELSE', templatePath }
            );
        }
        if (block.hasElse) {
            throw new TemplateEngineError(
                'A template block may contain only one {{else}} in ' + templatePath,
                { code: 'ERR_TEMPLATE_DUPLICATE_ELSE', templatePath }
            );
        }
        block.hasElse = true;
        generatedStatements.push(block.type === 'each' ? '} } else {' : '} else {');
    }

    function closeBlock(type) {
        const block = blockStack.pop();
        if (!block || block.type !== type) {
            if (block) blockStack.push(block);
            throw new TemplateEngineError(
                'Mismatched closing template block {{/' + type + '}} in ' + templatePath,
                { code: 'ERR_TEMPLATE_MISMATCHED_BLOCK', templatePath }
            );
        }
        generatedStatements.push(block.type === 'each' && !block.hasElse ? '} }' : '}');
    }

    function appendPartial(directive) {
        const partialMatch = directive.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
        if (!partialMatch) {
            throw new TemplateEngineError(
                'A partial directive requires a template name in ' + templatePath,
                { code: 'ERR_TEMPLATE_INVALID_PARTIAL', templatePath }
            );
        }
        const partialName = partialMatch[1].replace(/^['"]|['"]$/g, '');
        const contextExpression = partialMatch[2] && translateLoopMetadata(partialMatch[2].trim(), blockStack);
        const call = 'include(' + JSON.stringify(partialName) +
            (contextExpression ? ', (' + contextExpression + ')' : '') + ');';
        generatedStatements.push(call);
    }
}

/**
 * Locate a mustache closing delimiter while skipping JavaScript strings,
 * template literals, comments, regular expressions, and nested object braces.
 */
function findInterpolationEnd(source, startIndex, delimiter) {
    let index = startIndex;
    let braceDepth = 0;
    let regexMayStart = !/^\s*\/(?:if|each|with|unless)\b/.test(source.slice(startIndex));

    while (index < source.length) {
        if (braceDepth === 0 && source.startsWith(delimiter, index)) return index;
        const character = source[index];
        const nextCharacter = source[index + 1];

        if (character === "'" || character === '"') {
            index = skipQuotedString(source, index, character);
            regexMayStart = false;
            continue;
        }
        if (character === '`') {
            index = skipTemplateLiteral(source, index);
            regexMayStart = false;
            continue;
        }
        if (character === '/' && nextCharacter === '/') {
            index = skipLineComment(source, index + 2);
            continue;
        }
        if (character === '/' && nextCharacter === '*') {
            index = skipBlockComment(source, index + 2);
            continue;
        }
        if (character === '/' && regexMayStart) {
            const regexEnd = skipRegExpLiteral(source, index);
            if (regexEnd !== -1) {
                index = regexEnd;
                regexMayStart = false;
                continue;
            }
        }
        if (/\s/.test(character)) {
            index++;
            continue;
        }
        const identifier = matchAt(IDENTIFIER_PATTERN, source, index);
        if (identifier) {
            regexMayStart = REGEX_PREFIX_KEYWORDS.has(identifier);
            index += identifier.length;
            continue;
        }
        if (/[0-9]/.test(character) || character === '.' && /[0-9]/.test(nextCharacter || '')) {
            const number = matchAt(NUMBER_PATTERN, source, index);
            index += number ? number.length : 1;
            regexMayStart = false;
            continue;
        }
        if (character === '{') {
            braceDepth++;
            regexMayStart = true;
            index++;
            continue;
        }
        if (character === '}' && braceDepth > 0) {
            braceDepth--;
            regexMayStart = false;
            index++;
            continue;
        }
        if (character === '+' && nextCharacter === '+' || character === '-' && nextCharacter === '-') {
            index += 2;
            regexMayStart = false;
            continue;
        }
        if (character === '.' || character === ')' || character === ']') {
            regexMayStart = false;
        } else if ('([{,:;=!?~*%&|^<>+-'.includes(character)) {
            regexMayStart = true;
        } else {
            regexMayStart = false;
        }
        index++;
    }
    return -1;
}

function translateLoopMetadata(expression, blockStack) {
    // Keep the conventional metadata forms unambiguous and avoid replacing text
    // inside JavaScript strings. Use `index` and `item` aliases for expressions
    // that combine loop metadata with other JavaScript operators.
    const trimmed = expression.trim();
    const exact = trimmed.match(/^@(index|key|first|last|root)(?:\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))?$/);
    if (!exact) return expression;

    const metadata = exact[1];
    const propertyPath = exact[2] ? '.' + exact[2] : '';
    if (metadata === 'root') return '__enginexRoot' + propertyPath;

    const activeEach = [...blockStack].reverse().find(block => block.type === 'each');
    if (!activeEach) {
        throw new TemplateEngineError(
            '{{@' + metadata + '}} is only available inside an {{#each}} block.',
            { code: 'ERR_TEMPLATE_METADATA_OUTSIDE_EACH' }
        );
    }
    if (metadata === 'index') return activeEach.names.index + propertyPath;
    if (metadata === 'key') return activeEach.names.key + propertyPath;
    if (metadata === 'first') return '(' + activeEach.names.index + ' === 0)' + propertyPath;
    if (metadata === 'last') return '(' + activeEach.names.index + ' === ' + activeEach.names.items + '.length - 1)' + propertyPath;
    return expression;
}

function entriesForEach(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value.map((item, index) => [index, item]);
    if (typeof value === 'string') return Array.from(value, (item, index) => [index, item]);
    if (value instanceof Map) return Array.from(value.entries());
    if (value instanceof Set) {
        let index = 0;
        return Array.from(value, item => [index++, item]);
    }
    if (typeof value[Symbol.iterator] === 'function') {
        let index = 0;
        return Array.from(value, item => [index++, item]);
    }
    if (typeof value === 'object') return Object.entries(value);
    return [];
}

async function getCompiledTemplateAsync(templatePath, options, cacheMode, maxEntries) {
    const cacheable = shouldCache(cacheMode, maxEntries);
    let signature;
    let inFlightKey;
    let stats;

    if (cacheable && cacheMode === true) {
        const cached = getCacheEntry(templatePath);
        if (cached) {
            cacheCounters.hits++;
            return cached.compiledFunction;
        }
        inFlightKey = 'cached:' + templatePath;
    } else if (cacheable && cacheMode === 'mtime') {
        try {
            stats = await fsp.stat(templatePath);
        } catch (error) {
            throw new TemplateEngineError(
                'Unable to access template (' + templatePath + '): ' + error.message,
                { code: 'ERR_TEMPLATE_STAT', templatePath, cause: error }
            );
        }
        signature = getFileSignature(stats);
        const cached = getCacheEntry(templatePath);
        if (cached && cached.signature === signature) {
            cacheCounters.hits++;
            return cached.compiledFunction;
        }
        inFlightKey = 'mtime:' + templatePath + ':' + signature;
    }

    if (inFlightKey) {
        const pending = compilationInFlight.get(inFlightKey);
        if (pending) {
            cacheCounters.hits++;
            return pending;
        }
    }

    const compilePromise = (async () => {
        cacheCounters.misses++;
        let source;
        try {
            source = await fsp.readFile(templatePath, 'utf8');
        } catch (error) {
            throw new TemplateEngineError(
                'Unable to read template (' + templatePath + '): ' + error.message,
                { code: 'ERR_TEMPLATE_READ', templatePath, cause: error }
            );
        }

        const compiledFunction = compileTemplateSource(source, templatePath);
        cacheCounters.compiles++;

        if (cacheable) {
            if (cacheMode === 'mtime' && !stats) {
                try {
                    stats = await fsp.stat(templatePath);
                    signature = getFileSignature(stats);
                } catch (error) {
                    throw new TemplateEngineError(
                        'Unable to access template (' + templatePath + '): ' + error.message,
                        { code: 'ERR_TEMPLATE_STAT', templatePath, cause: error }
                    );
                }
            }
            setCacheEntry(templatePath, {
                signature: cacheMode === 'mtime' ? signature : undefined,
                compiledFunction
            }, maxEntries);
        }

        return compiledFunction;
    })();

    if (inFlightKey) compilationInFlight.set(inFlightKey, compilePromise);
    try {
        return await compilePromise;
    } finally {
        if (inFlightKey && compilationInFlight.get(inFlightKey) === compilePromise) {
            compilationInFlight.delete(inFlightKey);
        }
    }
}

function getCompiledTemplateSync(templatePath, options, cacheMode, maxEntries) {
    const cacheable = shouldCache(cacheMode, maxEntries);

    if (cacheable && cacheMode === true) {
        const cached = getCacheEntry(templatePath);
        if (cached) {
            cacheCounters.hits++;
            return cached.compiledFunction;
        }
    }

    let stats;
    if (cacheable && cacheMode === 'mtime') {
        try {
            stats = fs.statSync(templatePath);
        } catch (error) {
            throw new TemplateEngineError(
                'Unable to access included template (' + templatePath + '): ' + error.message,
                { code: 'ERR_TEMPLATE_STAT', templatePath, cause: error }
            );
        }

        const signature = getFileSignature(stats);
        const cached = getCacheEntry(templatePath);
        if (cached && cached.signature === signature) {
            cacheCounters.hits++;
            return cached.compiledFunction;
        }
    }

    cacheCounters.misses++;
    let source;
    try {
        source = fs.readFileSync(templatePath, 'utf8');
    } catch (error) {
        throw new TemplateEngineError(
            'Unable to read included template (' + templatePath + '): ' + error.message,
            { code: 'ERR_TEMPLATE_READ', templatePath, cause: error }
        );
    }

    const compiledFunction = compileTemplateSource(source, templatePath);
    cacheCounters.compiles++;

    if (cacheable) {
        if (cacheMode === 'mtime' && !stats) stats = fs.statSync(templatePath);
        setCacheEntry(templatePath, {
            signature: cacheMode === 'mtime' ? getFileSignature(stats) : undefined,
            compiledFunction
        }, maxEntries);
    }

    return compiledFunction;
}

function normalizeLocals(options, allowRequire, echo, baseContext) {
    const sourceLocals = options.locals || options;
    const windowContext = Object.assign(
        Object.create(null),
        BUILTIN_HELPERS,
        baseContext || {},
        sourceLocals,
        options.helpers || {}
    );
    windowContext.r = echo;
    windowContext.escapeHtml = escapeHtml;
    if (allowRequire) windowContext.require = nodeRequire;
    else delete windowContext.require;

    // Prevent supplied locals from masking the engine's lexical runtime bindings.
    for (const name of RESERVED_TEMPLATE_BINDINGS) delete windowContext[name];
    windowContext.r = echo;
    windowContext.escapeHtml = escapeHtml;
    if (allowRequire) windowContext.require = nodeRequire;

    // Missing locals resolve to undefined, so {{missing}} renders as empty rather
    // than throwing ReferenceError. Existing properties, lexical bindings, and
    // standard JavaScript/Node globals still resolve normally.
    return new Proxy(windowContext, {
        has(target, property) {
            if (typeof property === 'symbol') return Reflect.has(target, property);
            if (Reflect.has(target, property)) return true;
            if (GLOBAL_BINDINGS.has(property)) return false;
            return true;
        }
    });
}

function createRenderState(options, cacheMode, maxEntries) {
    const outputChunks = [];
    const echo = value => {
        if (value !== null && value !== undefined) {
            outputChunks.push(typeof value === 'string' ? value : String(value));
        }
    };

    const allowRequire = options.allowRequire !== false;
    const windowContext = normalizeLocals(options, allowRequire, echo);

    return {
        outputChunks,
        echo,
        windowContext,
        rootContext: windowContext,
        globals: Object.create(null),
        options,
        cacheMode,
        maxEntries,
        allowRequire,
        activePaths: [],
        activePathSet: new Set(),
        maxIncludeDepth: options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    };
}

function executeCompiledTemplate(compiledFunction, templatePath, renderState, parentContext, contextOverrides) {
    const currentContext = parentContext || renderState.windowContext;
    let windowContext = currentContext;

    if (contextOverrides !== undefined) {
        if (contextOverrides === null || typeof contextOverrides !== 'object') {
            throw new TemplateEngineError(
                'A partial context must be an object, array, or null-prototype object.',
                { code: 'ERR_TEMPLATE_PARTIAL_CONTEXT', templatePath }
            );
        }
        windowContext = normalizeLocals(
            { locals: contextOverrides, helpers: renderState.options.helpers },
            renderState.allowRequire,
            renderState.echo,
            currentContext
        );
    }

    const include = (includedTemplateName, includeContext) => {
        const includedPath = resolveIncludedTemplatePath(
            includedTemplateName,
            templatePath,
            renderState.options
        );
        renderTemplateSync(
            canonicalizeTemplatePathSync(includedPath, renderState.options),
            renderState,
            undefined,
            windowContext,
            includeContext
        );
    };

    windowContext.r = renderState.echo;
    windowContext.escapeHtml = escapeHtml;
    if (renderState.allowRequire) windowContext.require = nodeRequire;

    compiledFunction.call(
        windowContext,
        windowContext,
        renderState.globals,
        renderState.echo,
        include,
        renderState.allowRequire ? nodeRequire : undefined,
        escapeHtml,
        renderState.echo,
        escapeHtml,
        entriesForEach,
        renderState.rootContext
    );
}

function renderTemplateSync(templatePath, renderState, knownCompiledFunction, parentContext, contextOverrides) {
    const normalizedPath = path.resolve(templatePath);

    if (renderState.activePathSet.has(normalizedPath)) {
        const chain = renderState.activePaths.concat(normalizedPath).join(' -> ');
        throw new TemplateEngineError(
            'Circular template include detected: ' + chain,
            { code: 'ERR_TEMPLATE_CIRCULAR_INCLUDE', templatePath: normalizedPath }
        );
    }

    if (renderState.activePaths.length >= renderState.maxIncludeDepth + 1) {
        throw new TemplateEngineError(
            'Maximum template include depth (' + renderState.maxIncludeDepth + ') exceeded at ' + normalizedPath,
            { code: 'ERR_TEMPLATE_MAX_INCLUDE_DEPTH', templatePath: normalizedPath }
        );
    }

    renderState.activePaths.push(normalizedPath);
    renderState.activePathSet.add(normalizedPath);

    try {
        const compiledFunction = knownCompiledFunction || getCompiledTemplateSync(
            normalizedPath,
            renderState.options,
            renderState.cacheMode,
            renderState.maxEntries
        );
        executeCompiledTemplate(compiledFunction, normalizedPath, renderState, parentContext, contextOverrides);
    } finally {
        renderState.activePaths.pop();
        renderState.activePathSet.delete(normalizedPath);
    }
}

async function renderTemplate(templateFilePath, options) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    let absoluteTemplatePath = resolveInitialTemplatePath(templateFilePath, normalizedOptions);
    absoluteTemplatePath = await canonicalizeTemplatePathAsync(absoluteTemplatePath, normalizedOptions);
    const cacheMode = normalizeCacheMode(normalizedOptions);
    const maxEntries = getMaxCacheEntries(normalizedOptions);
    const maxIncludeDepth = normalizedOptions.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
    if (!Number.isInteger(maxIncludeDepth) || maxIncludeDepth < 1) {
        throw new TypeError('maxIncludeDepth must be a positive integer.');
    }
    const compiledFunction = await getCompiledTemplateAsync(
        absoluteTemplatePath,
        normalizedOptions,
        cacheMode,
        maxEntries
    );
    const renderState = createRenderState(normalizedOptions, cacheMode, maxEntries);

    // Mark the root template active before executing it so self-includes are caught.
    renderState.activePaths.push(absoluteTemplatePath);
    renderState.activePathSet.add(absoluteTemplatePath);
    try {
        executeCompiledTemplate(compiledFunction, absoluteTemplatePath, renderState);
    } finally {
        renderState.activePaths.pop();
        renderState.activePathSet.delete(absoluteTemplatePath);
    }

    return renderState.outputChunks.join('');
}

/**
 * Express-compatible API plus a Promise API when no callback is supplied.
 *
 * Options:
 *   views: string | string[]   Base directory for relative root template paths
 *   root: string              Alias for the template root
 *   cache: true | false | 'mtime' (default true)
 *   cacheMaxEntries: number    Maximum compiled templates retained (default 500)
 *   locals: object             Explicit template locals; otherwise options are locals
 *   allowRequire: boolean      Expose Node's require() to templates (default true for compatibility)
 *   helpers: object            Custom interpolation helpers, e.g. { money: value => ... }
 *   strictPaths: boolean      Prevent lexical paths outside root/views
 *   maxIncludeDepth: number    Maximum nested include depth (default 64)
 */
function engine(templateFilePath, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    options = options || {};

    let renderPromise;
    try {
        renderPromise = renderTemplate(templateFilePath, options);
    } catch (error) {
        renderPromise = Promise.reject(error);
    }

    if (typeof callback === 'function') {
        renderPromise.then(
            html => callback(null, html),
            error => callback(error)
        );
        return undefined;
    }

    return renderPromise;
}

engine.clearCache = function clearCache(templateFilePath) {
    if (templateFilePath) {
        compiledTemplateCache.delete(path.resolve(templateFilePath));
        try {
            compiledTemplateCache.delete(fs.realpathSync(templateFilePath));
        } catch {
            // The lexical path was still cleared. The file may already be gone.
        }
    } else {
        compiledTemplateCache.clear();
    }
};

engine.precompile = async function precompile(templateFilePath, options = {}) {
    options = options && typeof options === 'object' ? options : {};
    const resolvedPath = resolveInitialTemplatePath(templateFilePath, options);
    const canonicalPath = await canonicalizeTemplatePathAsync(resolvedPath, options);
    const cacheMode = normalizeCacheMode(options);
    const maxEntries = getMaxCacheEntries(options);
    await getCompiledTemplateAsync(canonicalPath, options, cacheMode, maxEntries);
    return canonicalPath;
};

engine.cacheStats = function getCacheStats() {
    return {
        size: compiledTemplateCache.size,
        hits: cacheCounters.hits,
        misses: cacheCounters.misses,
        compiles: cacheCounters.compiles,
        evictions: cacheCounters.evictions
    };
};

engine.TemplateEngineError = TemplateEngineError;
engine.escapeHtml = escapeHtml;
engine.__engine = engine;
engine.__express = engine;

module.exports = engine;
