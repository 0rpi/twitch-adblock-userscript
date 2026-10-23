#!/usr/bin/env node
// Browser smoke test for twitch-adblock.user.js (Playwright + Chromium).
//
//   npm run smoke                  local mode (default): offline stub of www.twitch.tv,
//                                  zero network. Runs in CI and on dev machines.
//   SMOKE_LIVE=1 npm run smoke     live mode: real twitch.tv (GitHub runners only,
//   npm run smoke:live             Twitch changes often: failures are signals).
//
// Flags/env: --headed, SMOKE_LIVE_CHANNEL=<login> (live, skip directory lookup),
// SMOKE_LIVE_WAIT_MS (live, default 20000, max 600000), SMOKE_VERBOSE=1 (dump browser console),
// SMOKE_SCRIPT=<path> (test another copy of the userscript, e.g. a deliberately broken one).
//
// The userscript is injected with addInitScript, guarded by its own @match /
// @exclude-match header lines, so it only runs where a script manager would run it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = 'twitch-adblock.user.js';
const SCRIPT_PATH = process.env.SMOKE_SCRIPT ? path.resolve(process.env.SMOKE_SCRIPT) : path.join(ROOT, SCRIPT_NAME);
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const LIVE = process.env.SMOKE_LIVE === '1' || process.argv.includes('--live');
const HEADED = process.argv.includes('--headed');
const VERBOSE = process.env.SMOKE_VERBOSE === '1';
const IN_GHA = process.env.GITHUB_ACTIONS === 'true';
// Live: watch time before the checks, clamped to 10 min (smoke-live.yml job timeout is 15 min).
const LIVE_WAIT_MS = Math.min(Math.max(Number(process.env.SMOKE_LIVE_WAIT_MS) || 20000, 1000), 600000);

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.error('playwright is not installed: run `npm ci` (then `npx playwright install chromium` if no browser is installed).');
    process.exit(2);
}

// ---------- userscript loading ----------

function parseHeader(src) {
    const block = src.match(/^\/\/ ==UserScript==([\s\S]*?)^\/\/ ==\/UserScript==/m);
    if (!block) throw new Error('userscript metadata block missing');
    const meta = {};
    for (const m of block[1].matchAll(/^\/\/ @(\S+)[ \t]+(.*?)[ \t]*$/gm)) {
        (meta[m[1]] ||= []).push(m[2]);
    }
    return meta;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Chrome-style match pattern -> RegExp source (what Violentmonkey/Tampermonkey use for @match).
function matchPatternToRegExp(pattern) {
    if (pattern === '<all_urls>') return '^(?:https?|file|ftp)://';
    const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!m) throw new Error(`unsupported @match pattern: ${pattern}`);
    const [, scheme, host, pathPart] = m;
    const schemeRe = scheme === '*' ? 'https?' : escapeRe(scheme);
    let hostRe = escapeRe(host);
    if (host === '*') hostRe = '[^/]*';
    else if (host.startsWith('*.')) hostRe = `(?:[^/]*\\.)?${escapeRe(host.slice(2))}`;
    const pathRe = pathPart.split('*').map(escapeRe).join('.*');
    return `^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`;
}

// @include / @exclude: /regex/ or a glob where only `*` is special.
function includeToRegExp(rule) {
    if (rule.length > 2 && rule.startsWith('/') && rule.endsWith('/')) return rule.slice(1, -1);
    return `^${rule.split('*').map(escapeRe).join('.*')}$`;
}

function loadUserscript() {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const meta = parseHeader(src);
    const include = [...(meta.match || []).map(matchPatternToRegExp), ...(meta.include || []).map(includeToRegExp)];
    const exclude = [...(meta['exclude-match'] || []).map(matchPatternToRegExp), ...(meta.exclude || []).map(includeToRegExp)];
    const matches = (url) => include.some((r) => new RegExp(r).test(url)) && !exclude.some((r) => new RegExp(r).test(url));
    // Guard goes on line 1 (the `// ==UserScript==` comment line) so stack trace line
    // numbers still match the file; sourceURL lets us attribute errors to the script.
    const guard = `if ((() => { try { const u = location.href; return ${JSON.stringify(include)}.some((r) => new RegExp(r).test(u)) && !${JSON.stringify(exclude)}.some((r) => new RegExp(r).test(u)); } catch { return false; } })()) { `;
    return {
        version: (meta.version || [])[0],
        meta,
        matches,
        initScript: `${guard}${src}\n}\n//# sourceURL=${SCRIPT_NAME}\n`,
    };
}

// ---------- reporting ----------

const results = [];
function check(name, ok, detail = '', { soft = false } = {}) {
    results.push({ name, ok: !!ok, detail, soft });
    const tag = ok ? 'ok  ' : soft ? 'WARN' : 'FAIL';
    console.log(`  ${tag} ${name}${detail && !ok ? ` -- ${detail}` : ''}`);
    if (!ok && IN_GHA) console.log(`::${soft ? 'warning' : 'error'} title=smoke${LIVE ? ' (live)' : ''}::${name}${detail ? `: ${detail}` : ''}`);
    return !!ok;
}

function writeStepSummary(title) {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    const rows = results.map((r) => `| ${r.ok ? 'ok' : r.soft ? 'warn' : '**FAIL**'} | ${r.name} | ${String(r.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`);
    try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n| | check | detail |\n|---|---|---|\n${rows.join('\n')}\n\n`);
    } catch {}
}

// Playwright wraps init scripts in its own code (one extra line in 1.56): measured
// once per run so the reported userscript line numbers match the file.
let lineOffset = 0;
async function measureLineOffset(browser) {
    const context = await browser.newContext();
    try {
        await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>probe</p>' }));
        await context.addInitScript({ content: 'window.__smokeProbe = String(new Error().stack);\n//# sourceURL=smoke-line-probe.js\n' });
        const page = await context.newPage();
        await page.goto('https://smoke.invalid/', { timeout: 10000 });
        const m = String(await page.evaluate(() => window.__smokeProbe)).match(/smoke-line-probe\.js:(\d+):/);
        return m ? Number(m[1]) - 1 : 0;
    } catch {
        return 0;
    } finally {
        await context.close();
    }
}
const fixLines = (text) => String(text || '').replace(/twitch-adblock\.user\.js:(\d+)/g, (m, n) => `${SCRIPT_NAME}:${Number(n) - lineOffset}`);

function collectBrowserEvents(page, sink) {
    page.on('pageerror', (err) => sink.pageErrors.push({ message: err.message, stack: fixLines(err.stack) }));
    page.on('console', (msg) => {
        const loc = msg.location?.() || {};
        sink.console.push({ type: msg.type(), text: msg.text(), url: loc.url ? `${fixLines(loc.url)}:${(loc.lineNumber ?? -1) + 1 - lineOffset}` : '' });
    });
}

const fromScript = (e) => `${e.stack || ''}\n${e.message || ''}\n${e.url || ''}`.includes(SCRIPT_NAME);

function dumpConsole(sink, filter = () => true, max = 60) {
    const lines = sink.console.filter(filter).slice(-max);
    if (!lines.length) return;
    console.log(`  --- browser console (last ${lines.length}) ---`);
    for (const l of lines) console.log(`  [${l.type}] ${l.text.slice(0, 400)}`);
}

async function screenshot(page, name) {
    try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        const file = path.join(ARTIFACTS, `${name}.png`);
        await page.screenshot({ path: file, fullPage: false, timeout: 10000 });
        console.log(`  screenshot: ${path.relative(ROOT, file)}`);
    } catch (err) {
        console.log(`  (screenshot failed: ${err.message})`);
    }
}

// ---------- local mode: offline fake Twitch ----------

const STUB_ORIGIN = 'https://www.twitch.tv';
const STUB_URL = `${STUB_ORIGIN}/vaft_smoke`;
const WEAVER_HOST = 'video-weaver.smoke.hls.ttvnw.net';
const SEGMENT_HOST = 'video-edge-smoke.abs.hls.ttvnw.net';

// Stand-in for Twitch's player worker: it fetches HLS through the (vaft-hooked)
// worker fetch exactly like the real one, and reports what the player would get.
const FAKE_TWITCH_WORKER = String.raw`
self.addEventListener('message', async (e) => {
    if (!e.data || e.data.key !== 'SmokeRun') return;
    const { id, channel, variant, adSegment } = e.data.value;
    const out = { id, channel };
    try {
        out.variant = variant;
        if (!out.variant) {
            const usher = 'https://usher.ttvnw.net/api/channel/hls/' + channel + '.m3u8?allow_source=true&parent_domains=smoke&p=1';
            const master = await (await fetch(usher)).text();
            out.variant = master.split('\n').find((l) => l.startsWith('https://') && l.includes('.m3u8'));
        }
        out.media = await (await fetch(out.variant)).text();
        if (adSegment) {
            const r = await fetch(adSegment);
            out.adSegment = { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
        }
    } catch (err) {
        out.error = String((err && err.stack) || err);
    }
    postMessage({ key: 'SmokeResult', value: out });
});
postMessage({ key: 'SmokeReady', value: {
    vaftInjected: typeof stripAdSegments === 'function' && typeof processM3U8 === 'function' && typeof declareOptions === 'function',
    fetchHooked: !String(fetch).includes('[native code]'),
} });
`;

const STUB_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>vaft smoke stub</title></head>
<body>
<div id="root">
  <div class="video-player"><video muted playsinline></video></div>
  <div class="channel-info-content">
    <div class="channel-header"><div data-target="channel-header-right" id="stub-header"><div><button type="button" data-a-target="follow-button">Follow</button></div><div><button type="button" data-a-target="subscribe-button">Subscribe</button></div></div></div>
    <div class="metadata-layout__secondary-button-spacing"><button type="button" data-a-target="share-button">Share</button></div>
  </div>
</div>
<script type="text/plain" id="fake-twitch-worker">${FAKE_TWITCH_WORKER}</script>
<script>
  window.__smoke = { workerErrors: [] };
  // Fake webpack registry (webpack 5 semantics: cache entry written before the factory runs).
  // Twitch's client-side ad manager arrives in a later bundle, before its dependency's chunk.
  (function () {
    var factories = {}, cache = {};
    var req = function (id) {
      if (cache[id]) return cache[id].exports;
      var module = cache[id] = { exports: {} };
      factories[id](module, module.exports, req);
      return module.exports;
    };
    req.m = factories;
    req.c = cache;
    factories['1'] = function (e, t, n) { /* unrelated module */ e.exports = {}; };
    var chunks = window.webpackChunktwilight = window.webpackChunktwilight || [];
    var parentPush = chunks.push.bind(chunks);
    chunks.push = function (data) {
      if (data && typeof data[2] === 'function') data[2](req);
      // FrankerFaceZ-style wrapper: chunk ids are stringified.
      data[0].map(function (x) { return typeof x !== 'string' ? '' + x : x; });
      return parentPush(data);
    };
    var AdManager = function () {};
    AdManager.declineReason = null;
    AdManager.startProcessingRequests = function () {};
    AdManager.decline = function (reason, options) { AdManager.declineReason = reason; AdManager.lastOptions = options; };
    setTimeout(function () {
      window.__smoke.adManager = AdManager;
      factories[2] = function (e, t, n) { /* startProcessingRequests ... declineReason */ n(3); e.exports = { AdManager: AdManager }; };
    }, 1200);
    setTimeout(function () {
      factories[3] = function (e, t, n) { e.exports = { dependency: true }; };
    }, 2000);
  })();
  window.__smoke.startWorker = () => new Promise((resolve, reject) => {
    const src = document.getElementById('fake-twitch-worker').textContent;
    // blob: URL created here has origin https://www.twitch.tv, so vaft treats it as Twitch's worker.
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    window.__smoke.worker = worker;
    const timer = setTimeout(() => reject(new Error('fake Twitch worker never became ready')), 10000);
    worker.addEventListener('error', (e) => window.__smoke.workerErrors.push(String(e.message || e.type)));
    worker.addEventListener('message', (e) => {
      if (e.data && e.data.key === 'SmokeReady') { clearTimeout(timer); resolve(e.data.value); }
    });
  });
  window.__smoke.run = (value) => new Promise((resolve, reject) => {
    const worker = window.__smoke.worker;
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => reject(new Error('fake Twitch worker did not answer')), 25000);
    const onMessage = (e) => {
      if (e.data && e.data.key === 'SmokeResult' && e.data.value.id === id) {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        resolve(e.data.value);
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ key: 'SmokeRun', value: Object.assign({}, value, { id }) });
  });
</script>
</body>
</html>`;

function masterPlaylist(channel, kind) {
    const variant = (res) => `https://${WEAVER_HOST}/v1/playlist/${channel}/${kind}/${res}.m3u8`;
    return [
        '#EXTM3U',
        '#EXT-X-TWITCH-INFO:NODE="smoke",SERVER-TIME="1727600000.00",USER-IP="127.0.0.1"',
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
        variant('1080p60'),
        '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p30",NAME="720p",AUTOSELECT=YES,DEFAULT=YES',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p30",FRAME-RATE=30.000',
        variant('720p30'),
        '',
    ].join('\n');
}

function mediaPlaylist(channel, kind, withAd) {
    const seg = (name) => `https://${SEGMENT_HOST}/${channel}/${kind}/${name}.ts`;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:100'];
    if (withAd) {
        lines.push(
            '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-01-01T00:00:00.000Z",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="PREROLL",X-TV-TWITCH-AD-URL="https://ads.smoke.invalid/ad",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://ads.smoke.invalid/click"',
            '#EXTINF:2.000,Amazon|smoke', seg('ad-0'),
            '#EXTINF:2.000,Amazon|smoke', seg('ad-1'),
            `#EXT-X-TWITCH-PREFETCH:${seg('ad-2')}`,
        );
    } else {
        lines.push('#EXTINF:2.000,live', seg('live-0'), '#EXTINF:2.000,live', seg('live-1'), `#EXT-X-TWITCH-PREFETCH:${seg('live-2')}`);
    }
    return `${lines.join('\n')}\n`;
}

// Fake usher / video-weaver / gql / segment hosts. Everything else is aborted.
// smokebackup: gql hands out backup tokens, backup feeds are ad-free.
// smokestrip:  gql fails, so vaft has to strip the ad segments itself.
function createFakeTwitch() {
    const state = { adActive: new Set(['smokebackup', 'smokestrip']), gql: [], segmentHits: [], unexpected: [] };
    const handler = async (route) => {
        const req = route.request();
        let url;
        try {
            url = new URL(req.url());
        } catch {
            return route.abort();
        }
        const cors = {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*',
        };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (url.href === STUB_URL) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: STUB_HTML });
        if (url.origin === STUB_ORIGIN && url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
        const hls = 'application/vnd.apple.mpegurl';
        if (url.hostname === 'usher.ttvnw.net') {
            const m = url.pathname.match(/\/channel\/hls\/([^/]+)\.m3u8$/);
            if (m) {
                const token = url.searchParams.get('token') || '';
                const kind = token.startsWith('backup-') ? token : 'primary';
                return route.fulfill({ status: 200, contentType: hls, headers: cors, body: masterPlaylist(m[1], kind) });
            }
        }
        if (url.hostname === WEAVER_HOST) {
            const [, , , channel, kind] = url.pathname.split('/');
            const withAd = kind === 'primary' && state.adActive.has(channel);
            return route.fulfill({ status: 200, contentType: hls, headers: cors, body: mediaPlaylist(channel, kind, withAd) });
        }
        if (url.hostname === 'gql.twitch.tv') {
            let body = null;
            try {
                body = JSON.parse(req.postData() || 'null');
            } catch {}
            const op = Array.isArray(body) ? body[0] : body;
            const login = op?.variables?.login;
            const playerType = op?.variables?.playerType;
            state.gql.push({ operationName: op?.operationName, login, playerType, platform: op?.variables?.platform });
            if (op?.operationName !== 'PlaybackAccessToken' || login === 'smokestrip') {
                return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"smoke: no token"}' });
            }
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: cors,
                body: JSON.stringify({ data: { streamPlaybackAccessToken: { value: `backup-${playerType}`, signature: 'smoke-sig' } } }),
            });
        }
        if (url.hostname === SEGMENT_HOST) {
            state.segmentHits.push(url.pathname);
            return route.fulfill({ status: 200, contentType: 'video/mp2t', headers: cors, body: `SEGMENT ${url.pathname}` });
        }
        state.unexpected.push(`${req.method()} ${url.href}`);
        return route.abort('blockedbyclient');
    };
    return { state, handler };
}

async function waitFor(page, fn, arg, timeout = 5000) {
    try {
        await page.waitForFunction(fn, arg, { timeout, polling: 100 });
        return true;
    } catch {
        return false;
    }
}

async function runLocal(browser, us) {
    console.log(`local smoke: ${SCRIPT_NAME} @version ${us.version} on fake ${STUB_URL} (offline)`);
    if (!check('@match covers the stub page (www.twitch.tv)', us.matches(STUB_URL), `@match ${JSON.stringify(us.meta.match || [])}`)) return;

    // full: whole ad cycle + UI toggles. storageBlocked: window.localStorage throws (site
    // data blocked); the UI may degrade but ad blocking must keep working.
    const scenarios = [
        { name: 'en-US', locale: 'en-US', full: true },
        { name: 'fr-FR', locale: 'fr-FR' },
        { name: 'en-US, localStorage blocked', locale: 'en-US', storageBlocked: true },
    ];
    for (const scenario of scenarios) {
        const { locale, storageBlocked } = scenario;
        const fr = locale.startsWith('fr');
        console.log(`\n[${scenario.name}]`);
        const sink = { pageErrors: [], console: [] };
        const fake = createFakeTwitch();
        const context = await browser.newContext({ locale, serviceWorkers: 'block', viewport: { width: 1280, height: 720 } });
        await context.route('**/*', fake.handler);
        if (storageBlocked) {
            await context.addInitScript(() => {
                Object.defineProperty(window, 'localStorage', {
                    configurable: true,
                    get() {
                        throw new DOMException('smoke: storage blocked', 'SecurityError');
                    },
                });
            });
        }
        await context.addInitScript({ content: us.initScript });
        context.setDefaultTimeout(5000);
        const page = await context.newPage();
        collectBrowserEvents(page, sink);
        try {
            await page.goto(STUB_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

            const basics = await page.evaluate(() => {
                let status = null;
                let statusError = null;
                try {
                    status = typeof window.vaftStatus === 'function' ? window.vaftStatus() : null;
                } catch (err) {
                    statusError = String(err);
                }
                return {
                    tas: window.twitchAdSolutionsVersion,
                    hasStatusFn: typeof window.vaftStatus === 'function',
                    status,
                    statusError,
                    hasSetAdBackupMode: typeof window.setAdBackupMode === 'function',
                };
            });
            check('window.twitchAdSolutionsVersion === 24', basics.tas === 24, `got ${basics.tas}`);
            check('window.vaftStatus() returns an object', basics.hasStatusFn && basics.status && typeof basics.status === 'object', basics.statusError || `got ${JSON.stringify(basics.status)}`);
            check('vaftStatus().version matches @version', basics.status?.version === us.version, `status ${basics.status?.version} vs header ${us.version}`);
            check('window.setAdBackupMode exists', basics.hasSetAdBackupMode);

            const uiReady = await waitFor(page, () => !!document.querySelector('#vaft-ad-mode'), null, 6000);
            const ui = await page.evaluate(() => {
                const box = document.querySelector('#vaft-ad-mode');
                const header = document.querySelector('[data-target="channel-header-right"]');
                if (!box || !header) return { present: !!box };
                return {
                    present: true,
                    inHeader: box.parentElement === header && header.firstElementChild === box,
                    text: box.textContent,
                    adButtons: box.querySelectorAll('button[data-kind="ad"]').length,
                    backupMode: window.vaftStatus?.().backupMode,
                    qualityPressed: box.querySelector('button[data-kind="quality"][aria-pressed="true"]')?.dataset.mode || null,
                };
            });
            const soft = { soft: !!storageBlocked };
            check('#vaft-ad-mode UI appears', uiReady && ui.present, '', soft);
            check('#vaft-ad-mode sits first in the channel header (left of Follow)', ui.inHeader, '', soft);
            if (ui.present) {
                // No channel header (theater mode, header not rendered yet): falls back to before Share, then moves back.
                const header = await page.evaluate(() => { const h = document.getElementById('stub-header'); window.__smoke.header = h; h.remove(); return true; });
                const fallback = header && await waitFor(page, () => {
                    const box = document.querySelector('#vaft-ad-mode');
                    const share = document.querySelector('[data-a-target="share-button"]');
                    return !!box && !!share && box.nextElementSibling === share && box.dataset.anchor === 'share';
                }, null, 3000);
                check('#vaft-ad-mode falls back to before Share without the header', fallback, '', soft);
                await page.evaluate(() => document.querySelector('.channel-header').append(window.__smoke.header));
                const back = await waitFor(page, () => {
                    const box = document.querySelector('#vaft-ad-mode');
                    return !!box && box.parentElement?.id === 'stub-header' && box.dataset.anchor === 'header' && document.querySelectorAll('#vaft-ad-mode').length === 1;
                }, null, 3000);
                check('#vaft-ad-mode moves back into the header once it is rendered (single copy)', back, '', soft);
            }
            const label = fr ? ['Pub', 'Qualité'] : ['Ad', 'Quality'];
            check(`UI labels are ${fr ? 'French' : 'English'} (${label.join(', ')})`, label.every((l) => ui.text?.includes(l)), `text: ${JSON.stringify(ui.text)}`, soft);
            check('defaults: 360p last resort (no 360p/Source buttons any more), Quality Auto', ui.adButtons === 0 && ui.backupMode === '360p' && ui.qualityPressed === 'on', `adButtons=${ui.adButtons} backupMode=${ui.backupMode} quality=${ui.qualityPressed}`, soft);
            const names = await page.evaluate(() => ({
                pill: document.querySelector('#vaft-ad-mode [data-vaft="label"]')?.textContent,
                head: document.querySelector('#vaft-panel .vaft-head')?.textContent,
                title: document.querySelector('#vaft-ad-mode [data-vaft="toggle"]')?.getAttribute('title'),
            }));
            check('idle pill says what it does (not "vaft"), panel named Twitch Adblock', names.pill === (fr ? 'Anti-pub actif' : 'Ad block on') && names.head?.startsWith('Twitch Adblock') && names.title?.startsWith('Twitch Adblock '), JSON.stringify(names), soft);

            if (scenario.full) await runWorkerFlow(page, fake.state, ui.present);
            else if (storageBlocked) await runBackupOnly(page);
            await page.waitForTimeout(500);
        } catch (err) {
            check(`[${scenario.name}] run completed`, false, err.stack || String(err));
        } finally {
            // Always reported, even when a step above threw.
            check('no uncaught page errors', sink.pageErrors.length === 0, sink.pageErrors.map((e) => e.stack || e.message).join('\n'));
            const consoleErrors = sink.console.filter((c) => c.type === 'error' && !c.text.startsWith('Failed to load resource'));
            check('no console.error output', consoleErrors.length === 0, consoleErrors.map((c) => c.text).join(' | '));
            check('no unexpected network requests (offline)', fake.state.unexpected.length === 0, fake.state.unexpected.join(', '));
            if (VERBOSE || results.some((r) => !r.ok && !r.soft)) dumpConsole(sink);
            if (results.some((r) => !r.ok && !r.soft)) await screenshot(page, `local-${scenario.name.replace(/[^\w-]+/g, '-')}`);
            await context.close();
        }
    }
}

// Minimal ad-blocking check (used when storage is blocked): worker hooked + backup swap.
async function runBackupOnly(page) {
    const ready = await page.evaluate(() => window.__smoke.startWorker().then((v) => ({ v }), (err) => ({ error: String(err) })));
    check('fake Twitch worker starts inside the vaft blob', !ready.error && ready.v?.vaftInjected, ready.error || JSON.stringify(ready.v));
    if (ready.error) return;
    const backup = await page.evaluate(() => window.__smoke.run({ channel: 'smokebackup' }));
    check('backup: player gets the ad-free mobile_feed feed', !backup.error && backup.media?.includes('/smokebackup/backup-mobile_feed/live-0.ts'), backup.error || backup.media);
    const workerErrors = await page.evaluate(() => window.__smoke.workerErrors);
    check('no worker errors', workerErrors.length === 0, workerErrors.join(' | '));
}

// Ad cycle through the real vaft worker injection: backup feed swap, ad end, Source
// mode propagated to the worker, segment stripping when no backup is available.
async function runWorkerFlow(page, state, hasUi) {
    const ready = await page.evaluate(() => window.__smoke.startWorker().then((v) => ({ v }), (err) => ({ error: String(err) })));
    check('fake Twitch worker starts inside the vaft blob', !ready.error && ready.v?.vaftInjected, ready.error || JSON.stringify(ready.v));
    check('worker fetch is hooked', ready.v?.fetchHooked);
    const afterStart = await page.evaluate(() => ({ status: window.vaftStatus?.(), workerErrors: window.__smoke.workerErrors }));
    check('vaftStatus().workerCount === 1', afterStart.status?.workerCount === 1, `got ${afterStart.status?.workerCount}`);
    if (afterStart.status?.health) {
        check('vaftStatus().health.workerHooked === true', afterStart.status.health.workerHooked === true, JSON.stringify(afterStart.status.health));
    }
    if (ready.error) return;

    // 1) Ad on a channel with clean backup feeds -> player gets the backup playlist.
    const backup = await page.evaluate(() => window.__smoke.run({ channel: 'smokebackup' }));
    check('backup: worker run without error', !backup.error, backup.error);
    check('backup: player gets the ad-free mobile_feed feed', backup.media?.includes('/smokebackup/backup-mobile_feed/live-0.ts') && !backup.media.includes('stitched'), backup.media);
    const mobileToken = state.gql.find((g) => g.login === 'smokebackup' && g.playerType === 'mobile_feed');
    check('backup: mobile_feed token asked as android', mobileToken?.platform === 'android', JSON.stringify(mobileToken));
    let st = await page.evaluate(() => window.vaftStatus());
    check('backup: vaftStatus shows ad + mobile_feed backup', st.showingAd === true && st.backupPlayerType === 'mobile_feed' && st.channel === 'smokebackup', JSON.stringify(st));
    check('backup: ad overlay element created', await page.evaluate(() => !!document.querySelector('.video-player .adblock-overlay')));

    // 2) Ad ends.
    state.adActive.delete('smokebackup');
    const ended = await page.evaluate((variant) => window.__smoke.run({ channel: 'smokebackup', variant }), backup.variant);
    check('ad end: primary feed is back', ended.media?.includes('/smokebackup/primary/live-0.ts'), ended.error || ended.media);
    st = await page.evaluate(() => window.vaftStatus());
    check('ad end: vaftStatus().showingAd === false', st.showingAd === false, JSON.stringify(st));

    // 3) Source mode (console only since 38.0) + quality Off (panel), persisted and pushed to the worker.
    //    Without the UI, use the console API so the worker part still runs.
    await page.evaluate(() => window.setAdBackupMode?.('source'));
    if (hasUi) {
        // The toggles live in the settings popover: open it from the pill first.
        await page.click('#vaft-ad-mode [data-vaft="toggle"]');
        check('settings panel opens from the pill', await page.evaluate(() => document.querySelector('#vaft-ad-mode [data-vaft="toggle"]')?.getAttribute('aria-expanded') === 'true' && !document.querySelector('#vaft-panel')?.hidden));
        const earn = await page.evaluate(() => {
            const sec = document.querySelector('#vaft-panel [data-vaft="earn"]');
            return sec && { text: sec.textContent, lost: document.querySelector('#vaft-panel [data-vaft="earn-lost"]')?.textContent };
        });
        check('panel shows what the streamer gets (sub 2.08 €, blocked ad counted), marked as not exact', !!earn && /2[,.]08/.test(earn.text) && /pas exacts|not exact/.test(earn.text) && /^≈ /.test(earn.lost || '') && !/^≈ 0 cent/.test(earn.lost), JSON.stringify(earn));
        // Tabs: one pane visible at a time, same panel height for every tab, arrows move between tabs.
        const tabState = () => page.evaluate(() => {
            const panel = document.querySelector('#vaft-panel');
            const selected = [...panel.querySelectorAll('[role="tab"][aria-selected="true"]')].map((t) => t.dataset.tab);
            const visible = [...panel.querySelectorAll('[role="tabpanel"]')].filter((p) => getComputedStyle(p).visibility === 'visible').map((p) => p.dataset.pane);
            return { selected, visible, height: Math.round(panel.getBoundingClientRect().height), focused: document.activeElement?.dataset?.tab || null };
        });
        const tabSel = (id) => `#vaft-panel [data-vaft="tab"][data-tab="${id}"]`;
        const seen = [];
        for (const id of ['ads', 'support', 'quality']) {
            await page.click(tabSel(id));
            seen.push({ id, ...(await tabState()) });
        }
        check('tabs: a click shows only that pane', seen.every((t) => t.selected.join() === t.id && t.visible.join() === t.id), JSON.stringify(seen));
        check('tabs: the panel keeps one height whatever the tab (nothing moves under the mouse)', new Set(seen.map((t) => t.height)).size === 1, JSON.stringify(seen.map((t) => t.height)));
        await page.focus(tabSel('quality'));
        await page.keyboard.press('ArrowRight');
        const wrapped = await tabState();
        await page.keyboard.press('End');
        const ended = await tabState();
        check('tabs: arrow keys move and wrap, End goes to the last tab', wrapped.selected.join() === 'ads' && wrapped.focused === 'ads' && ended.selected.join() === 'quality' && ended.focused === 'quality', JSON.stringify({ wrapped, ended }));
        check('tabs: last tab remembered', await page.evaluate(() => localStorage.getItem('vaftPanelTab')) === 'quality');
        // Ads tab: last ad blocked (the smokebackup ad above, replaced by the mobile_feed copy) and banner state.
        await page.click(tabSel('ads'));
        const adsTab = await page.evaluate(() => Object.fromEntries(['last-where', 'last-len', 'last-how', 'banners'].map((k) => [k, document.querySelector(`#vaft-panel [data-vaft="${k}"]`)?.textContent])));
        check('Ads tab: last ad blocked (channel, type, how it was replaced) and banner state', /^smokebackup · /.test(adsTab['last-where'] || '') && /roll · /.test(adsTab['last-len'] || '')
            && adsTab['last-how'] === 'Replaced by an ad-free copy, full quality' && !!adsTab.banners && adsTab.banners !== '–', JSON.stringify(adsTab));
        // Quality tab: what is playing, read from Twitch's player (stubbed here: the fake page has no player).
        // The real function on the stub page (a <video>, no Twitch player): an answer, never a throw, and it says the player is missing.
        const real = await page.evaluate(() => { try { return window.vaftGetPlaybackInfo(); } catch (err) { return { error: String(err) }; } });
        check('vaftGetPlaybackInfo() without Twitch\'s player: answers from the <video>, reports the player missing', !!real && !real.error && Array.isArray(real.missing) && real.missing.includes('player'), JSON.stringify(real));
        await page.evaluate(() => { window.vaftGetPlaybackInfo = () => ({ quality: '1080p60', source: true, width: 1920, height: 1080, framerate: 59.94, codecs: 'hev1.1.6.L150.90.0.0.0.0.0,mp4a.40.2', bitrate: 8950000, bandwidth: 1000000, latency: 3.08, lowLatency: true, buffer: 2.62, dropped: 0, available: ['1080p60', '720p60', '480p'] }); });
        await page.click(tabSel('quality'));
        const playing = await page.evaluate(() => Object.fromEntries(['q-now', 'q-bitrate', 'q-bandwidth', 'q-latency', 'q-buffer', 'q-dropped', 'q-size', 'q-offered'].map((k) => [k, document.querySelector(`#vaft-panel [data-vaft="${k}"]`)?.textContent])));
        check('Quality tab: now playing (quality, codec, video stats like Twitch\'s overlay) and the stream\'s qualities, target missing noted', JSON.stringify(playing) === JSON.stringify({
            'q-now': '1080p60 (source) · HEVC', 'q-bitrate': '9.0 Mb/s', 'q-bandwidth': '1.0 Mb/s', 'q-latency': '3.1 s · low', 'q-buffer': '2.6 s', 'q-dropped': '0', 'q-size': '1920×1080',
            'q-offered': 'Offered by this stream: 1080p60 · 720p60 · 480p. No 1440p60.' }), JSON.stringify(playing));

        await page.click('#vaft-ad-mode button[data-kind="quality"][data-mode="off"]');
        await page.keyboard.press('Escape');
        check('Escape closes the settings panel', await page.evaluate(() => !!document.querySelector('#vaft-panel')?.hidden));
    } else {
        await page.evaluate(() => window.setAutoQuality?.('off'));
    }
    const prefs = await page.evaluate(() => ({
        adBackupMode: localStorage.getItem('adBackupMode'),
        autoQuality: localStorage.getItem('vaftAutoQuality'),
        status: window.vaftStatus(),
        pressed: [...document.querySelectorAll('#vaft-ad-mode button[aria-pressed="true"]')].map((b) => `${b.dataset.kind}:${b.dataset.mode}`),
    }));
    check('setAdBackupMode("source"): adBackupMode=source, backupMode=source', prefs.adBackupMode === 'source' && prefs.status.backupMode === 'source', JSON.stringify(prefs));
    check('Off click: vaftAutoQuality=off, autoQuality=off', prefs.autoQuality === 'off' && prefs.status.autoQuality === 'off', JSON.stringify(prefs));
    check('buttons reflect Off', prefs.pressed.includes('quality:off') && !prefs.pressed.some((p) => p.startsWith('ad:')), prefs.pressed.join(','));

    // 4) Ad with no backup token -> vaft strips; Source mode must not try 360p (autoplay).
    const adSegment = `https://${SEGMENT_HOST}/smokestrip/primary/ad-1.ts`;
    const strip = await page.evaluate((seg) => window.__smoke.run({ channel: 'smokestrip', adSegment: seg }), adSegment);
    check('strip: worker run without error', !strip.error, strip.error);
    const tried = state.gql.filter((g) => g.login === 'smokestrip').map((g) => g.playerType);
    check('strip: Source mode reached the worker (no autoplay token request)', tried.length > 0 && !tried.includes('autoplay'), `player types tried: ${tried.join(',')}`);
    check('strip: prefetch + ad tracking URLs removed', strip.media && !strip.media.includes('#EXT-X-TWITCH-PREFETCH') && !strip.media.includes('ads.smoke.invalid'), strip.media);
    check('strip: ad segment replaced by blank video', strip.adSegment?.type === 'video/mp4' && !state.segmentHits.includes('/smokestrip/primary/ad-1.ts'), JSON.stringify(strip.adSegment));
    st = await page.evaluate(() => window.vaftStatus());
    check('strip: vaftStatus shows stripping', st.strippingSegments === true && st.numStrippedAdSegments >= 1 && st.channel === 'smokestrip', JSON.stringify(st));

    state.adActive.delete('smokestrip');
    const stripEnd = await page.evaluate((variant) => window.__smoke.run({ channel: 'smokestrip', variant }), strip.variant);
    st = await page.evaluate(() => window.vaftStatus());
    check('strip end: showingAd/strippingSegments back to false', !stripEnd.error && st.showingAd === false && st.strippingSegments === false, stripEnd.error || JSON.stringify(st));

    // 5) Allowlisted channel: Twitch's ad plays and counts as watched (support stats), not as blocked.
    const blockedBefore = await page.evaluate(() => window.getVaftAdStats().breaks);
    await page.evaluate(() => window.setVaftAllowlist(['smokeallow']));
    state.adActive.add('smokeallow');
    const allowed = await page.evaluate(() => window.__smoke.run({ channel: 'smokeallow' }));
    check('allowlisted: Twitch\'s ad left in the playlist', !allowed.error && allowed.media?.includes('/smokeallow/primary/ad-0.ts'), allowed.error || allowed.media);
    const counted = await waitFor(page, () => window.getVaftWatchedAds?.().smokeallow?.breaks === 1, null, 3000);
    const support = await page.evaluate(() => ({ watched: window.getVaftWatchedAds(), blocked: window.getVaftAdStats().breaks, status: window.vaftStatus().watchedAds }));
    check('allowlisted: ad counted as watched for that channel, not as blocked', counted && support.blocked === blockedBefore && support.status?.smokeallow?.breaks === 1, JSON.stringify({ blockedBefore, ...support }));
    state.adActive.delete('smokeallow');
    await page.evaluate((variant) => window.__smoke.run({ channel: 'smokeallow', variant }), allowed.variant);
    await page.evaluate(() => window.setVaftAllowlist([]));

    const workerErrors = await page.evaluate(() => window.__smoke.workerErrors);
    check('no worker errors', workerErrors.length === 0, workerErrors.join(' | '));

    if (hasUi) await runIndicatorAndAllowlist(page);
    if (hasUi) await runSupportedList(page);
}

// Panel list of supported channels: estimate from the ads watched there, × twice removes a channel.
async function runSupportedList(page) {
    const rowsSel = '#vaft-panel [data-vaft="supported"] .vaft-row';
    await page.evaluate(() => window.setVaftAllowlist(['smokeallow', 'otherstreamer']));
    await page.click('#vaft-ad-mode [data-vaft="toggle"]');
    await page.click('#vaft-panel [data-vaft="tab"][data-tab="support"]');
    const listed = await waitFor(page, (sel) => document.querySelectorAll(sel).length === 2, rowsSel, 3000);
    const rows = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((r) => r.textContent), rowsSel);
    const title = await page.evaluate(() => document.querySelector('#vaft-panel [data-vaft="supported-title"]')?.textContent);
    check('panel lists the supported channels (watched ad estimated, none on the other)', listed && /\(2\)$/.test(title || '') && /^smokeallow≈ \S/.test(rows[0]) && rows[1] === 'otherstreamer–×', JSON.stringify({ title, rows }));
    const given = await page.evaluate(() => document.querySelector('#vaft-panel [data-vaft="earn-given"]')?.textContent);
    check('"Given" row counts the watched ad', /^≈ (?!0 )/.test(given || ''), given);
    // The Support switch adds this channel to the list: the panel must not resize or move (it often sits
    // above the pill, anchored by its bottom edge), whatever the number of channels.
    const geometry = () => page.evaluate(() => {
        const panel = document.querySelector('#vaft-panel').getBoundingClientRect();
        const card = document.querySelector('#vaft-panel [data-vaft="allow"]');
        // Relative to the pill: the stub's fake ad banners reappear on an allowlisted channel and push the pill down.
        const pill = document.querySelector('#vaft-ad-mode').getBoundingClientRect();
        return { height: Math.round(panel.height), cardTop: Math.round(card.getBoundingClientRect().top - pill.top), pressed: card.getAttribute('aria-pressed'), rows: document.querySelectorAll('#vaft-panel [data-vaft="supported"] .vaft-row').length };
    });
    const before = await geometry();
    await page.click('#vaft-panel [data-vaft="allow"]');
    const after = await geometry();
    await page.click('#vaft-panel [data-vaft="allow"]');
    const back = await geometry();
    check('Support switch: channel added to the list, panel neither resized nor moved', after.pressed === 'true' && after.rows === before.rows + 1 && back.rows === before.rows
        && after.height === before.height && after.cardTop === before.cardTop && back.height === before.height, JSON.stringify({ before, after, back }));
    const remove = '#vaft-panel button[data-vaft="remove"][data-login="otherstreamer"]';
    await page.focus(remove);
    await page.keyboard.press('Enter');
    const armed = await page.evaluate((sel) => ({ list: window.getVaftAllowlist(), text: document.querySelector(sel)?.textContent, label: document.querySelector(sel)?.getAttribute('aria-label'), focused: document.activeElement === document.querySelector(sel) }), remove);
    await page.keyboard.press('Enter');
    const gone = await waitFor(page, () => !window.getVaftAllowlist().includes('otherstreamer') && !document.querySelector('#vaft-panel [data-login="otherstreamer"]')
        && /otherstreamer/.test(document.querySelector('#vaft-panel [data-vaft="status"]')?.textContent || ''), null, 3000);
    const after2 = await page.evaluate(() => ({ focusInPanel: !!document.activeElement?.closest('#vaft-panel'), status: document.querySelector('#vaft-panel [data-vaft="status"]')?.textContent }));
    check('remove: first press asks (label says so, focus kept), second press removes the channel', armed.list.includes('otherstreamer') && armed.text !== '×' && /otherstreamer/.test(armed.label || '') && armed.focused && gone, JSON.stringify(armed));
    check('remove: focus stays in the panel and the removal is announced', after2.focusInPanel && /otherstreamer/.test(after2.status || ''), JSON.stringify(after2));
    // The two-step confirm cannot be passed by a double-click or a held Enter.
    await page.evaluate(() => window.setVaftAllowlist(['smokeallow', 'dblclick', 'heldkey']));
    await waitFor(page, () => !!document.querySelector('#vaft-panel [data-vaft="remove"][data-login="heldkey"]'), null, 3000);
    await page.dblclick('#vaft-panel [data-vaft="remove"][data-login="dblclick"]');
    await page.focus('#vaft-panel [data-vaft="remove"][data-login="heldkey"]');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');// repeat
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    const kept = await page.evaluate(() => window.getVaftAllowlist());
    check('remove: a double-click or a held Enter only asks, removes nothing', kept.includes('dblclick') && kept.includes('heldkey'), JSON.stringify(kept));
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.setVaftAllowlist([]));
}

// Pill state follows the page's channel; allowlisting shows Twitch's own ad label again.
async function runIndicatorAndAllowlist(page) {
    const channel = new URL(STUB_URL).pathname.slice(1);
    const pillState = () => page.evaluate(() => document.querySelector('#vaft-ad-mode')?.dataset.state);
    const waitState = (state) => waitFor(page, (s) => document.querySelector('#vaft-ad-mode')?.dataset.state === s, state, 3000);
    await page.evaluate((c) => window.dispatchEvent(new CustomEvent('vaft-ad-state', { detail: { showingAd: true, channel: c, backupPlayerType: 'embed' } })), channel);
    check('indicator: ad on this channel -> "ad"', await waitState('ad'), `state ${await pillState()}`);
    await page.evaluate(() => history.pushState(null, '', '/videos/123456'));
    check('indicator: VOD page (no channel) -> back to idle, not stuck on "ad"', await waitState('idle'), `state ${await pillState()}`);
    await page.evaluate((c) => history.pushState(null, '', `/${c}`), channel);
    await page.evaluate((c) => window.dispatchEvent(new CustomEvent('vaft-ad-state', { detail: { showingAd: false, channel: c } })), channel);
    check('indicator: ad end -> idle', await waitState('idle'), `state ${await pillState()}`);

    // Fake leftover Twitch ad UI (what the CSS hides while vaft swaps the stream), and a display ad
    // wrapper laid out as on twitch.tv (sibling of the video inside .video-player__container).
    await page.evaluate(() => {
        const bar = document.createElement('div');
        bar.id = 'smoke-ad-bar';
        const label = document.createElement('span');
        label.setAttribute('data-a-target', 'video-ad-label');
        label.textContent = 'Ad';
        bar.append(label);
        document.querySelector('.video-player').append(bar);
        const sda = document.createElement('div');
        sda.id = 'smoke-sda';
        sda.setAttribute('data-test-selector', 'sda-wrapper');
        sda.className = 'stream-display-ad__wrapper stream-display-ad__wrapper_squeezeback';
        sda.innerHTML = '<div data-test-selector="sda-container" class="stream-display-ad__container_squeezeback">banner</div>';
        document.querySelector('.video-player').append(sda);
    });
    const labelShown = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-a-target="video-ad-label"]')).display !== 'none' && getComputedStyle(document.getElementById('smoke-ad-bar')).display !== 'none');
    const sdaShown = () => page.evaluate(() => getComputedStyle(document.getElementById('smoke-sda')).display !== 'none');
    const videoShown = () => page.evaluate(() => getComputedStyle(document.querySelector('.video-player video')).display !== 'none');
    check('Twitch ad label hidden by default', !(await labelShown()));
    check('display ad banner (sda-wrapper) hidden by default, video untouched', !(await sdaShown()) && (await videoShown()));
    // Display ads: Twitch's ad manager (fake, loaded 1.2s after the page) is found and declined.
    // Raw declineReason (null before any decline in the stub): an undo must restore exactly that.
    const displayState = () => page.evaluate(() => ({ status: window.vaftStatus().displayAds, reason: window.__smoke.adManager ? String(window.__smoke.adManager.declineReason) : 'no manager', options: window.__smoke.adManager?.lastOptions ?? null }));
    const declined = await waitFor(page, () => window.vaftStatus().displayAds.state === 'declined', null, 6000);
    let display = await displayState();
    check('display ads: late-loaded ad manager found and declined', declined && display.reason === 'player_size' && display.options?.sendEvent === false && display.status.moduleId === '2.AdManager', JSON.stringify(display));
    // Same synchronous evaluate: the decline is undone by the toggle itself, not by a later tick.
    const toggledNow = await page.evaluate((c) => ({ result: window.toggleVaftAllowlist(c), state: window.vaftStatus().displayAds.state, reason: String(window.__smoke.adManager.declineReason) }), channel);
    const toggled = toggledNow.result;
    const flagged = await waitFor(page, () => document.documentElement.hasAttribute('data-vaft-allow'), null, 3000);
    check('allowlisted: html[data-vaft-allow] set', toggled === true && flagged, `toggle returned ${toggled}`);
    check('allowlisted: display ads allowed again (decline undone at once, previous value restored)', toggledNow.state === 'allowed' && toggledNow.reason === 'null', JSON.stringify(toggledNow));
    check('allowlisted: Twitch ad label + its bar visible again', await labelShown());
    check('allowlisted: display ad banner visible again', await sdaShown());
    check('allowlisted: indicator "allow"', await waitState('allow'), `state ${await pillState()}`);
    const refused = await page.evaluate((c) => ({ result: window.setVaftAllowlist(c), list: window.getVaftAllowlist() }), channel);
    check('setVaftAllowlist("login") refused, list kept', refused.list.includes(channel) && refused.result.includes(channel), JSON.stringify(refused));
    const removedNow = await page.evaluate((c) => ({ result: window.toggleVaftAllowlist(c), state: window.vaftStatus().displayAds.state, reason: String(window.__smoke.adManager.declineReason) }), channel);
    const unflagged = await waitFor(page, () => !document.documentElement.hasAttribute('data-vaft-allow'), null, 3000);
    check('removed from the allowlist: label hidden again', unflagged && !(await labelShown()) && !(await sdaShown()));
    check('removed from the allowlist: display ads declined again at once', removedNow.result === false && removedNow.state === 'declined' && removedNow.reason === 'player_size', JSON.stringify(removedNow));
}

// ---------- live mode: real twitch.tv ----------

const RESERVED_PATHS = new Set(['directory', 'videos', 'settings', 'search', 'downloads', 'turbo', 'p', 'jobs', 'store', 'subscriptions', 'inventory', 'drops', 'wallet', 'friends', 'u', 'moderator', 'login', 'signup']);

async function runLive(browser, us) {
    const waitMs = LIVE_WAIT_MS;
    console.log(`live smoke: ${SCRIPT_NAME} @version ${us.version} on https://www.twitch.tv (wait ${waitMs} ms)`);
    const major = browser.version().split('.')[0];
    const context = await browser.newContext({
        locale: 'en-US',
        viewport: { width: 1366, height: 768 },
        // Headless UA says "HeadlessChrome", which Twitch may treat differently.
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    });
    await context.addInitScript({ content: us.initScript });
    const page = await context.newPage();
    const sink = { pageErrors: [], console: [] };
    collectBrowserEvents(page, sink);
    try {
        const wanted = (process.env.SMOKE_LIVE_CHANNEL || '').trim().replace(/^\/+/, '');
        if (wanted && !check('SMOKE_LIVE_CHANNEL is a Twitch login', /^[A-Za-z0-9_]{1,25}$/.test(wanted), JSON.stringify(wanted))) return;
        let channelUrl = wanted ? `https://www.twitch.tv/${wanted}` : null;
        if (!channelUrl) {
            await page.goto('https://www.twitch.tv/directory/all', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForSelector('a[data-a-target="preview-card-image-link"], a[data-a-target="preview-card-channel-link"], article a[href^="/"]', { timeout: 45000 }).catch(() => {});
            const href = await page.evaluate((reserved) => {
                const links = [...document.querySelectorAll('a[data-a-target="preview-card-image-link"], a[data-a-target="preview-card-channel-link"], article a[href^="/"]')];
                for (const a of links) {
                    const p = new URL(a.getAttribute('href'), location.href).pathname.split('/').filter(Boolean);
                    if (p.length === 1 && /^[A-Za-z0-9_]{2,25}$/.test(p[0]) && !reserved.includes(p[0].toLowerCase())) return new URL(`/${p[0]}`, location.href).href;
                }
                return null;
            }, [...RESERVED_PATHS]);
            if (!check('found a live channel in /directory/all', !!href, 'no preview-card link (Twitch layout changed or page blocked?)')) {
                await screenshot(page, 'live-directory');
                return;
            }
            channelUrl = href;
        }
        console.log(`  channel: ${channelUrl}`);
        await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // Best effort: mature-content / classification gates.
        for (const sel of ['[data-a-target="content-classification-gate-overlay-start-watching-button"]', '[data-a-target="player-overlay-mature-accept"]']) {
            await page.click(sel, { timeout: 3000 }).catch(() => {});
        }
        await page.waitForTimeout(waitMs);

        const snap = await page.evaluate(async () => {
            const out = { tas: window.twitchAdSolutionsVersion, hasStatusFn: typeof window.vaftStatus === 'function', ui: !!document.querySelector('#vaft-ad-mode'), uiAnchor: document.querySelector('#vaft-ad-mode')?.dataset.anchor || null };
            try {
                out.status = out.hasStatusFn ? window.vaftStatus() : null;
            } catch (err) {
                out.statusError = String(err);
            }
            const v = window.vaftGetPlayerVideoElement?.() || document.querySelector('video');
            if (v) {
                const t0 = v.currentTime;
                await new Promise((r) => setTimeout(r, 3000));
                out.video = { readyState: v.readyState, paused: v.paused, width: v.videoWidth, height: v.videoHeight, advanced: v.currentTime - t0 };
            }
            return out;
        });
        console.log(`  vaftStatus(): ${JSON.stringify(snap.status)}`);
        console.log(`  video: ${JSON.stringify(snap.video || null)}`);

        const scriptErrors = sink.pageErrors.filter(fromScript);
        check('no uncaught page errors from the userscript', scriptErrors.length === 0, scriptErrors.map((e) => e.stack || e.message).join('\n'));
        if (sink.pageErrors.length > scriptErrors.length) console.log(`  (ignored ${sink.pageErrors.length - scriptErrors.length} page error(s) from Twitch's own code)`);
        check('window.twitchAdSolutionsVersion === 24', snap.tas === 24, `got ${snap.tas}`);
        check('vaftStatus() works and matches @version', snap.status?.version === us.version, snap.statusError || `got ${snap.status?.version}`);
        if (snap.status?.health) {
            check('vaftStatus().health.workerHooked === true', snap.status.health.workerHooked === true, JSON.stringify(snap.status.health));
        } else {
            check('Twitch worker hooked (vaftStatus().workerCount >= 1)', snap.status?.workerCount >= 1, `workerCount ${snap.status?.workerCount}`);
        }
        check('#vaft-ad-mode UI mounted', snap.ui, 'channel-header-right and share-button selectors may have changed', { soft: true });
        check('#vaft-ad-mode in the channel header', snap.uiAnchor === 'header', `anchor ${snap.uiAnchor}`, { soft: true });
        check('display ads: Twitch ad manager found (declined)', ['declined', 'twitch'].includes(snap.status?.displayAds?.state), `displayAds ${JSON.stringify(snap.status?.displayAds)}; 'searching' after the wait = webpack markers (startProcessingRequests/declineReason) may have changed`, { soft: true });
        check('video is playing', snap.video && snap.video.readyState >= 2 && snap.video.advanced > 0.5, JSON.stringify(snap.video || null), { soft: true });
        const scriptConsoleErrors = sink.console.filter((c) => c.type === 'error' && fromScript(c));
        check('no console.error from the userscript', scriptConsoleErrors.length === 0, scriptConsoleErrors.map((c) => c.text).join(' | '), { soft: true });
    } catch (err) {
        check('live run completed', false, err.stack || String(err));
    } finally {
        dumpConsole(sink, VERBOSE ? () => true : (c) => /vaft|ads|worker|twitch-adblock/i.test(c.text) || fromScript(c));
        await screenshot(page, 'live');
        await context.close();
    }
}

// ---------- main ----------

const us = loadUserscript();
// Live worst case before the checks: ~170 s of page loads and gates + the wait (+ margin).
const deadlineMs = LIVE ? LIVE_WAIT_MS + 200000 : 90000;
const deadline = setTimeout(() => {
    console.error(`smoke: timed out after ${deadlineMs / 1000} s`);
    process.exit(1);
}, deadlineMs);
deadline.unref();

let browser;
try {
    browser = await chromium.launch({ headless: !HEADED });
    lineOffset = await measureLineOffset(browser);
    if (LIVE) await runLive(browser, us);
    else await runLocal(browser, us);
} catch (err) {
    check('browser run', false, err.stack || String(err));
} finally {
    await browser?.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok && !r.soft);
const warned = results.filter((r) => !r.ok && r.soft);
writeStepSummary(`Smoke test (${LIVE ? 'live' : 'local'}) - ${failed.length ? 'FAILED' : 'passed'}`);
console.log(`\nsmoke (${LIVE ? 'live' : 'local'}): ${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failure(s)`);
process.exit(failed.length ? 1 : 0);
