// ESLint flat config. Goal: catch real bugs (undefined names, dupes, unreachable
// code, worker-scope leaks...) in the inherited vaft code without forcing a mass
// reformat. Style rules are deliberately left out.
import fs from 'node:fs';
import js from '@eslint/js';
import globals from 'globals';

const USERSCRIPT = 'twitch-adblock.user.js';

function readUserscript() {
    try {
        return fs.readFileSync(new URL(USERSCRIPT, import.meta.url), 'utf8');
    } catch {
        return '';
    }
}

// Names declared at runtime by declareOptions(scope) (`scope.X = ...`) and used as
// bare identifiers in both the page (scope = window) and the worker (scope = self).
// Read from the source so the list never drifts from the script.
function declareOptionNames(src) {
    const names = new Set();
    const start = src.indexOf('function declareOptions(scope)');
    if (start === -1) return names;
    const end = src.indexOf('\n    }\n', start);
    const body = src.slice(start, end === -1 ? undefined : end);
    for (const m of body.matchAll(/\bscope\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
    return names;
}

// With `@grant none` the manager still exposes GM_info / GM.info; any other GM_*
// API is only defined when granted, so it must stay undefined for no-undef.
function grantedGlobals(src) {
    const out = { GM_info: 'readonly', GM: 'readonly' };
    for (const m of src.matchAll(/^\/\/ @grant\s+(\S+)/gm)) {
        if (m[1] !== 'none' && /^[A-Za-z_$][\w$]*$/.test(m[1])) out[m[1]] = 'readonly';
    }
    return out;
}

const src = readUserscript();
const optionNames = declareOptionNames(src);
const workerGlobalNames = new Set([...Object.keys(globals.worker), ...Object.keys(globals.builtin)]);

// vaft/worker-scope: functions injected into the Twitch worker via
// `${fn.toString()}` in hookWindowWorker() run in a WorkerGlobalScope, so they may
// only use worker globals, declareOptions names, names declared in the blob
// template, and other injected functions. Anything else (window, document,
// localStorage, a page-only helper...) is a ReferenceError inside the worker.
const workerScopeRule = {
    meta: {
        type: 'problem',
        docs: { description: 'Worker-injected functions must only reference worker-available names' },
        schema: [],
        messages: {
            pageGlobal: "'{{name}}' is not available in the worker (used by injected function '{{fn}}').",
            notInjected: "'{{name}}' is used by worker-injected function '{{fn}}' but is not injected in the hookWindowWorker() blob.",
        },
    },
    create(context) {
        const sourceCode = context.sourceCode;
        const injected = new Set();
        const templateNames = new Set();
        return {
            TemplateLiteral(node) {
                const fnNames = node.expressions
                    .filter((e) => e.type === 'CallExpression' && e.callee.type === 'MemberExpression'
                        && e.callee.property.name === 'toString' && e.callee.object.type === 'Identifier')
                    .map((e) => e.callee.object.name);
                if (fnNames.length < 3) return; // not the worker blob template
                fnNames.forEach((n) => injected.add(n));
                for (const q of node.quasis) {
                    for (const m of q.value.cooked.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) {
                        templateNames.add(m[1]);
                    }
                }
            },
            'Program:exit'(program) {
                if (injected.size === 0) return;
                const allowed = (name) => injected.has(name) || templateNames.has(name) || optionNames.has(name);
                const visit = (node) => {
                    if (node.type === 'FunctionDeclaration' && node.id && injected.has(node.id.name)) {
                        const fnScope = sourceCode.getScope(node);
                        const seen = new Set();
                        for (const ref of fnScope.through) {
                            const name = ref.identifier.name;
                            if (seen.has(name) || allowed(name)) continue;
                            const variable = ref.resolved;
                            const isGlobal = !variable || variable.scope.type === 'global';
                            if (isGlobal && workerGlobalNames.has(name)) continue;
                            seen.add(name);
                            context.report({
                                node: ref.identifier,
                                messageId: isGlobal ? 'pageGlobal' : 'notInjected',
                                data: { name, fn: node.id.name },
                            });
                        }
                        return; // nested functions are covered by fnScope.through
                    }
                    for (const key of Object.keys(node)) {
                        if (key === 'parent') continue;
                        const child = node[key];
                        if (Array.isArray(child)) child.forEach((c) => c && typeof c.type === 'string' && visit(c));
                        else if (child && typeof child.type === 'string') visit(child);
                    }
                };
                visit(program);
            },
        };
    },
};

// Rules on top of eslint:recommended that flag likely bugs, not style.
const bugRules = {
    'no-undef': ['error', { typeof: false }],
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
    'no-useless-assignment': 'warn', // dead stores; inherited `let x = null; x = ...` pattern
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-dupe-keys': 'error',
    'no-dupe-else-if': 'error',
    'no-duplicate-case': 'error',
    'no-self-compare': 'error',
    'no-unmodified-loop-condition': 'error',
    'no-unreachable-loop': 'error',
    'no-constant-binary-expression': 'error',
    'array-callback-return': ['error', { checkForEach: false }],
    'no-implicit-globals': 'error',
    'no-new-wrappers': 'error',
    'no-throw-literal': 'error',
    'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    'no-useless-escape': 'off', // style only; inherited regexes escape `/` everywhere
    'no-async-promise-executor': 'warn', // inherited pattern, worth a look but not a blocker
};

export default [
    {
        ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**', 'tests/artifacts/**'],
    },
    js.configs.recommended,
    {
        files: [USERSCRIPT],
        plugins: { vaft: { rules: { 'worker-scope': workerScopeRule } } },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'script',
            globals: {
                ...globals.browser,
                ...globals.worker,
                ...Object.fromEntries([...optionNames].map((n) => [n, 'writable'])),
                ...grantedGlobals(src),
                // Declared by the worker blob template before the injected functions.
                pendingFetchRequests: 'readonly',
                // hookWorkerFetch() reassigns the worker's global fetch on purpose.
                fetch: 'writable',
            },
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'warn',
        },
        rules: {
            ...bugRules,
            'vaft/worker-scope': 'error',
        },
    },
    {
        files: ['check.js', '.github/scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: bugRules,
    },
    {
        files: ['tests/**/*.{js,mjs}', 'eslint.config.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            // Smoke tests pass callbacks to page.evaluate(), which run in the browser.
            globals: { ...globals.node, ...globals.browser },
        },
        rules: bugRules,
    },
];
