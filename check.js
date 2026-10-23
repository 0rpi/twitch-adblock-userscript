// Unit checks for twitch-adblock.user.js. Plain node + assert, no dependencies: `node check.js` prints OK.
// Functions are extracted from the userscript source as-is (extract()) and run against the
// synthetic Twitch playlists in tests/fixtures/. The worker part is run for real: the
// hookWindowWorker() blob template is built and evaluated in a node:vm context that plays
// the Twitch worker, with a fake usher / weaver / GQL behind it.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = 'twitch-adblock.user.js';
const src = fs.readFileSync(path.join(__dirname, SCRIPT), 'utf8');
const uiStart = src.lastIndexOf('\n(() => {');
assert(uiStart > 0, 'UI IIFE "(() => {" not found at the end of the userscript');
const coreSrc = src.slice(0, uiStart);// vaft core IIFE (page + worker code)
const uiSrc = src.slice(uiStart);// Small UI IIFE (settings pill/panel, auto quality)
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', name), 'utf8');

// ---------------------------------------------------------------------------------------------
// Helpers

function parses(code) {
    try {
        new vm.Script(code);
        return true;
    } catch {
        return false;
    }
}

// Source of one declaration: `[async] function name(...) {...}` or `const|let name = ...;`.
// The end is the first `}` (function) or `;` (const) that makes the slice parse, so braces
// or semicolons inside strings, regexes and templates cannot cut it short.
function extract(name, from = coreSrc) {
    const declaration = new RegExp(`^[ \\t]*((?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(|(?:const|let)[ \\t]+${name}[ \\t]*=)`, 'gm');
    const hits = [...from.matchAll(declaration)];
    assert.strictEqual(hits.length, 1, `expected exactly one declaration of ${name}, found ${hits.length}`);
    const start = hits[0].index + hits[0][0].length - hits[0][1].length;
    const terminator = hits[0][1].includes('function') ? '}' : ';';
    for (let i = from.indexOf(terminator, start); i !== -1; i = from.indexOf(terminator, i + 1)) {
        const code = from.slice(start, i + 1);
        if (parses(code)) return code;
    }
    throw new Error(`cannot find the end of ${name}`);
}

// Values created in a node:vm context have that context's prototypes: compare them as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));
const lf = (text) => text.replaceAll('\r', '');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Minimal HLS reading for assertions (independent of the code under test).
function segmentsOf(playlist) {
    const lines = lf(playlist).split('\n');
    const segments = [];
    lines.forEach((line, i) => {
        if (line.startsWith('#EXTINF:')) segments.push({ title: line.slice(line.indexOf(',') + 1), url: lines[i + 1] });
    });
    return segments;
}
const prefetchOf = (playlist) => lf(playlist).split('\n').filter((l) => l.startsWith('#EXT-X-TWITCH-PREFETCH:')).map((l) => l.slice(l.indexOf(':') + 1));
// URL line that follows the #EXT-X-STREAM-INF line containing `needle` (e.g. 'VIDEO="720p60"').
function urlAfter(master, needle) {
    const lines = lf(master).split('\n');
    const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:') && l.includes(needle));
    assert(i !== -1 && lines[i + 1], `no variant with ${needle}`);
    return lines[i + 1];
}
function variantsOf(master) {
    const lines = lf(master).split('\n');
    return lines.flatMap((l, i) => (l.startsWith('#EXT-X-STREAM-INF:') ? [{ inf: l, url: lines[i + 1] }] : []));
}
// Master with only the variants whose #EXT-X-MEDIA + #EXT-X-STREAM-INF block matches `pattern`.
function keepVariants(master, pattern) {
    const [head, ...blocks] = master.split(/(?=^#EXT-X-MEDIA:)/m);
    return head + blocks.filter((block) => pattern.test(block)).join('');
}
// Same master with RESOLUTION moved first in every #EXT-X-STREAM-INF (the pre-38.0.0 parseAttributes miss).
const resolutionFirst = (master) => master.replace(/^#EXT-X-STREAM-INF:(.*)$/gm, (line, list) => {
    const attrs = list.match(/[A-Z0-9-]+=(?:"[^"]*"|[^,]*)/g);
    return '#EXT-X-STREAM-INF:' + [...attrs.filter((a) => a.startsWith('RESOLUTION=')), ...attrs.filter((a) => !a.startsWith('RESOLUTION='))].join(',');
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const MASTER_AVC = fixture('master-avc.m3u8');
const MASTER_ENHANCED = fixture('master-enhanced.m3u8');
const LIVE = fixture('media-live.m3u8');
const AD = fixture('media-ad.m3u8');// Stitched MIDROLL
const PREROLL = AD.replace('X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"', 'X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"');
const AD_SEGMENTS = segmentsOf(AD).filter((s) => s.title !== 'live').map((s) => s.url);
const LIVE_SEGMENTS_IN_AD = segmentsOf(AD).filter((s) => s.title === 'live').map((s) => s.url);

// Defaults as declared by the script (worker and page both start from declareOptions()).
const defaults = new Function(`'use strict'; ${extract('declareOptions')} const o = {}; declareOptions(o); return o;`)();

// ---------------------------------------------------------------------------------------------
// Metadata and versions

function userscriptMeta() {
    const block = /^\/\/ ==UserScript==\r?\n([\s\S]*?)\r?\n\/\/ ==\/UserScript==\r?\n/.exec(src);
    assert(block, 'the file must start with the // ==UserScript== metadata block');
    const meta = new Map();
    for (const line of block[1].split(/\r?\n/)) {
        const kv = /^\/\/ @(\S+)\s+(.*)$/.exec(line);
        assert(kv, `malformed metadata line: ${line}`);
        meta.set(kv[1], [...(meta.get(kv[1]) || []), kv[2].trim()]);
    }
    return meta;
}
const meta = userscriptMeta();
const VERSION = (meta.get('version') || [])[0];

test('userscript parses as a script', () => {
    new vm.Script(src, { filename: SCRIPT });
});

test('@version is semver and matches SCRIPT_VERSION and CHANGELOG.md', () => {
    assert.strictEqual((meta.get('version') || []).length, 1, 'exactly one @version line');
    // x.y.z, optionally -prerelease (release.yml publishes those as GitHub prereleases).
    assert.match(VERSION, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/, `@version ${VERSION} is not semver`);
    const scriptVersion = new Function(`${extract('SCRIPT_VERSION')} return SCRIPT_VERSION;`)();
    assert.strictEqual(scriptVersion, VERSION, 'SCRIPT_VERSION (vaftStatus, self-check warnings) must equal @version');
    const changelog = path.join(__dirname, 'CHANGELOG.md');
    if (fs.existsSync(changelog)) {
        assert.match(fs.readFileSync(changelog, 'utf8'), new RegExp(`^## \\[${escapeRegExp(VERSION)}\\]`, 'm'), `CHANGELOG.md has no "## [${VERSION}]" section`);
    }
});

test('ourTwitchAdSolutionsVersion stays 24 (anti-conflict mutex shared with other vaft copies)', () => {
    assert.strictEqual(new Function(`${extract('ourTwitchAdSolutionsVersion')} return ourTwitchAdSolutionsVersion;`)(), 24);
});

test('metadata keeps auto-update and early page injection working', () => {
    const one = (key) => {
        assert.strictEqual((meta.get(key) || []).length, 1, `exactly one @${key}`);
        return meta.get(key)[0];
    };
    // Renaming either makes script managers treat it as another script (no auto-update).
    assert.strictEqual(one('name'), 'Twitch Adblock Userscript');
    assert.strictEqual(one('namespace'), 'https://github.com/0rpi/twitch-adblock-userscript');
    const raw = 'https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js';
    assert.strictEqual(one('updateURL'), raw);
    assert.strictEqual(one('downloadURL'), raw);
    // vaft must run in the page, before Twitch creates its worker.
    assert.strictEqual(one('run-at'), 'document-start');
    assert.strictEqual(one('inject-into'), 'page');
    assert.strictEqual(one('grant'), 'none');
    const matches = meta.get('match') || [];
    // www + player (embeds) + m (mobile web, matched since 37.2.2: dropping it would silently unprotect users).
    for (const page of ['*://www.twitch.tv/*', '*://m.twitch.tv/*', '*://player.twitch.tv/*']) assert(matches.includes(page), `@match ${page} missing`);
});

// ---------------------------------------------------------------------------------------------
// Worker-side m3u8 helpers

const M3U8_HELPERS = ['parseAttributes', 'videoCodecFamily', 'getServerTimeFromM3u8', 'replaceServerTimeInM3u8', 'getFirstM3u8Url', 'getStreamUrlForResolution', 'stripAdSegments'];
// Fresh helpers with their worker globals (AdSegmentCache, V2API, ...) as local state.
function m3u8Helpers(options = {}) {
    return new Function('opts', `'use strict';
        let V2API = !!opts.V2API;
        const AllSegmentsAreAdSegments = !!opts.AllSegmentsAreAdSegments;
        const AdSignifier = opts.AdSignifier;
        const AdSegmentCache = new Map();
        ${M3U8_HELPERS.map((name) => extract(name)).join('\n')}
        return { ${M3U8_HELPERS.join(', ')}, AdSegmentCache, setV2: (v) => { V2API = v; } };
    `)({ AdSignifier: defaults.AdSignifier, ...options });
}

test('parseAttributes: Twitch master playlist lines (full tag lines and bare lists)', () => {
    const { parseAttributes } = m3u8Helpers();
    const expected = [
        { BANDWIDTH: 8534030, RESOLUTION: '1920x1080', CODECS: 'avc1.64002A,mp4a.40.2', VIDEO: 'chunked', 'FRAME-RATE': 60 },
        { BANDWIDTH: 3422999, RESOLUTION: '1280x720', CODECS: 'avc1.4D401F,mp4a.40.2', VIDEO: '720p60', 'FRAME-RATE': 60 },
        { BANDWIDTH: 2373000, RESOLUTION: '1280x720', CODECS: 'avc1.4D401F,mp4a.40.2', VIDEO: '720p30', 'FRAME-RATE': 30 },
        { BANDWIDTH: 1427999, RESOLUTION: '852x480', CODECS: 'avc1.4D401F,mp4a.40.2', VIDEO: '480p30', 'FRAME-RATE': 30 },
        { BANDWIDTH: 630000, RESOLUTION: '640x360', CODECS: 'avc1.4D401E,mp4a.40.2', VIDEO: '360p30', 'FRAME-RATE': 30 },
        { BANDWIDTH: 230000, RESOLUTION: '284x160', CODECS: 'avc1.4D400C,mp4a.40.2', VIDEO: '160p30', 'FRAME-RATE': 30 },
        { BANDWIDTH: 160000, CODECS: 'mp4a.40.2', VIDEO: 'audio_only' },
    ];
    const infs = variantsOf(MASTER_AVC).map((v) => v.inf);
    assert.deepStrictEqual(infs.map((line) => parseAttributes(line)), expected, 'whole #EXT-X-STREAM-INF lines');
    assert.deepStrictEqual(infs.map((line) => parseAttributes(line.slice(line.indexOf(':') + 1))), expected, 'bare attribute lists');
    // RESOLUTION first: before 38.0.0 the whole-line call produced a "#EXT-X-STREAM-INF:RESOLUTION" key.
    const reorderedLines = variantsOf(resolutionFirst(MASTER_AVC)).map((v) => v.inf);
    assert(reorderedLines[0].startsWith('#EXT-X-STREAM-INF:RESOLUTION='));
    const reordered = reorderedLines.map((line) => parseAttributes(line));
    assert.deepStrictEqual(reordered, expected);
    assert(reordered.every((attrs) => Object.keys(attrs).every((k) => !k.includes('#') && !k.includes(':'))));

    const media = lf(MASTER_AVC).split('\n').find((l) => l.startsWith('#EXT-X-MEDIA:'));
    assert.deepStrictEqual(parseAttributes(media), { TYPE: 'VIDEO', 'GROUP-ID': 'chunked', NAME: '1080p60 (source)', AUTOSELECT: 'YES', DEFAULT: 'YES' });
    const info = parseAttributes(lf(MASTER_AVC).split('\n').find((l) => l.startsWith('#EXT-X-TWITCH-INFO:')));
    assert.strictEqual(info['SERVER-TIME'], '1792758380.42');
    assert.strictEqual(info['USER-COUNTRY'], 'FR');
    assert.match(info.C, /^[A-Za-z0-9+/]+=*$/, 'quoted value containing "=" kept whole');
});

test('parseAttributes: stitched-ad #EXT-X-DATERANGE (quoted commas and "=")', () => {
    const { parseAttributes } = m3u8Helpers();
    const daterange = parseAttributes(lf(AD).split('\n').find((l) => l.includes('CLASS="twitch-stitched-ad"')));
    assert.strictEqual(daterange.ID, 'stitched-ad-1792758376-30');
    assert.strictEqual(daterange.CLASS, 'twitch-stitched-ad');
    assert.strictEqual(daterange.DURATION, 30.03);
    assert.strictEqual(daterange['X-TV-TWITCH-AD-ROLL-TYPE'], 'MIDROLL');
    assert.strictEqual(daterange['X-TV-TWITCH-AD-POD-LENGTH'], '1', 'quoted numbers stay strings');
    assert.strictEqual(daterange['X-TV-TWITCH-AD-COMMERCIAL-ID'], '');
    assert.strictEqual(daterange['X-TV-TWITCH-AD-CLICK-TRACKING-URL'], 'https://ads.example.net/click?c=5198374420&rt=MIDROLL&pos=0,1');
});

test('videoCodecFamily: AVC / HEVC / AV1 / unknown', () => {
    const { videoCodecFamily } = m3u8Helpers();
    const families = variantsOf(MASTER_ENHANCED).map((v) => videoCodecFamily(/CODECS="([^"]*)"/.exec(v.inf)[1]));
    assert.deepStrictEqual(families, ['hevc', 'av1', 'avc', 'avc', 'avc', 'avc', 'avc', 'unknown']);
    assert.strictEqual(videoCodecFamily('hvc1.2.4.L123.B0,mp4a.40.2'), 'hevc');
    assert.strictEqual(videoCodecFamily('mp4a.40.2, avc3.640028'), 'avc', 'order and spaces do not matter');
    assert.strictEqual(videoCodecFamily('AV01.0.08M.08'), 'av1');
    for (const value of ['', '  ', undefined, null, 42]) assert.strictEqual(videoCodecFamily(value), 'unknown');
});

test('getServerTimeFromM3u8 / replaceServerTimeInM3u8 (v1 TWITCH-INFO and v2 SESSION-DATA)', () => {
    const h = m3u8Helpers();
    assert.strictEqual(h.getServerTimeFromM3u8(MASTER_AVC), '1792758380.42');
    assert.strictEqual(h.getServerTimeFromM3u8(MASTER_ENHANCED), '1792758380.42');
    assert.strictEqual(h.getServerTimeFromM3u8('#EXTM3U\n'), null);
    const replaced = h.replaceServerTimeInM3u8(MASTER_AVC, '1792758399.99');
    assert.strictEqual(replaced, MASTER_AVC.replace('SERVER-TIME="1792758380.42"', 'SERVER-TIME="1792758399.99"'), 'only SERVER-TIME changes');
    assert.strictEqual(h.replaceServerTimeInM3u8(MASTER_AVC, null), MASTER_AVC);

    const v2 = MASTER_AVC.replace(/^#EXT-X-TWITCH-INFO:.*$/m, '#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1792758380.42"');
    h.setV2(true);
    assert.strictEqual(h.getServerTimeFromM3u8(v2), '1792758380.42');
    assert.strictEqual(h.getServerTimeFromM3u8(MASTER_AVC), null);
    assert.strictEqual(h.replaceServerTimeInM3u8(v2, '1792758399.99'), v2.replace('VALUE="1792758380.42"', 'VALUE="1792758399.99"'));
    assert.strictEqual(h.replaceServerTimeInM3u8(v2, null), v2);
});

test('getFirstM3u8Url: first https .m3u8 line, never throws', () => {
    const { getFirstM3u8Url } = m3u8Helpers();
    const first = variantsOf(MASTER_AVC)[0].url;
    assert.strictEqual(getFirstM3u8Url(MASTER_AVC), first);
    assert.strictEqual(getFirstM3u8Url(MASTER_AVC.replaceAll('\n', '\r\n')), first);
    assert.strictEqual(getFirstM3u8Url(MASTER_AVC.replace(first, `${first}   `)), first, 'trailing spaces (ModifiedM3U8 lines) trimmed');
    assert.strictEqual(getFirstM3u8Url(MASTER_AVC.replace(first, `${first}?token=abc`)), `${first}?token=abc`, 'query string allowed');
    assert.strictEqual(getFirstM3u8Url(LIVE), null, 'media playlists only list segments');
    assert.strictEqual(getFirstM3u8Url('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://insecure.example/a.m3u8\nnot a url.m3u8'), null);
    for (const value of ['#EXTM3U', '', null, undefined, 42]) assert.strictEqual(getFirstM3u8Url(value), null);
});

test('getStreamUrlForResolution: same codec family, then exact resolution + frame rate, then closest', () => {
    const { getStreamUrlForResolution } = m3u8Helpers();
    const pick = (master, Resolution, FrameRate, Codecs) => getStreamUrlForResolution(master, { Resolution, FrameRate, Codecs });
    const avc = 'avc1.4D401F,mp4a.40.2';
    for (const master of [MASTER_AVC, resolutionFirst(MASTER_AVC), MASTER_AVC.replaceAll('\n', '\r\n')]) {
        assert.strictEqual(pick(master, '1920x1080', 60, 'avc1.64002A,mp4a.40.2'), urlAfter(MASTER_AVC, 'VIDEO="chunked"'));
        assert.strictEqual(pick(master, '1280x720', 60, avc), urlAfter(MASTER_AVC, 'VIDEO="720p60"'));
        assert.strictEqual(pick(master, '1280x720', 30, avc), urlAfter(MASTER_AVC, 'VIDEO="720p30"'), 'frame rate breaks the tie');
        assert.strictEqual(pick(master, '1280x720', 60, ''), urlAfter(MASTER_AVC, 'VIDEO="720p60"'), 'missing CODECS: any family');
    }
    assert.strictEqual(pick(MASTER_AVC, '1664x936', 60, avc), urlAfter(MASTER_AVC, 'VIDEO="chunked"'), 'no 936p: closest pixel count');
    assert.strictEqual(pick(MASTER_AVC, '2560x1440', 60, 'hev1.1.6.L150.90.0.0.0.0.0,mp4a.40.2'), urlAfter(MASTER_AVC, 'VIDEO="chunked"'), 'no HEVC in backup: closest AVC');
    // Enhanced Broadcasting: AV1 and AVC both have 1920x1080@60.
    assert.strictEqual(pick(MASTER_ENHANCED, '2560x1440', 60, 'hvc1.1.6.L150.90'), urlAfter(MASTER_ENHANCED, 'VIDEO="chunked"'));
    assert.strictEqual(pick(MASTER_ENHANCED, '1920x1080', 60, 'av01.0.09M.08,mp4a.40.2'), urlAfter(MASTER_ENHANCED, 'VIDEO="1080p60"'));
    assert.strictEqual(pick(MASTER_ENHANCED, '1920x1080', 60, 'avc1.64002A,mp4a.40.2'), urlAfter(MASTER_ENHANCED, 'VIDEO="1080p60_h264"'));
    assert.strictEqual(pick(MASTER_ENHANCED, '2560x1440', 60, 'avc1.640032'), urlAfter(MASTER_ENHANCED, 'VIDEO="1080p60_h264"'), 'same family beats an exact HEVC match');

    const selection = {};
    getStreamUrlForResolution(MASTER_ENHANCED, { Resolution: '1920x1080', FrameRate: 60, Codecs: 'av01.0.09M.08' }, selection);
    assert.deepStrictEqual(selection, { url: urlAfter(MASTER_ENHANCED, 'VIDEO="1080p60"'), codecs: 'av01.0.09M.08,mp4a.40.2', resolution: '1920x1080', frameRate: 60, family: 'av1' });
    const audioOnly = keepVariants(MASTER_AVC, /VIDEO="audio_only"/);
    assert.strictEqual(variantsOf(audioOnly).length, 1);
    assert.strictEqual(pick(audioOnly, '1920x1080', 60, 'avc1.64002A'), null, 'audio_only (no RESOLUTION) is never picked');
});

test('stripAdSegments: stitched ad cached for blanking, live kept, prefetch dropped, ad URLs neutralised', () => {
    const h = m3u8Helpers();
    const info = { NumStrippedAdSegments: 0 };
    const out = h.stripAdSegments(AD, false, info);
    assert.strictEqual(AD_SEGMENTS.length, 4);
    assert.deepStrictEqual(segmentsOf(out), segmentsOf(AD), 'segment list unchanged (ad segments are blanked on fetch)');
    assert.deepStrictEqual([...h.AdSegmentCache.keys()].sort(), [...AD_SEGMENTS].sort(), '"Amazon|..." and empty titles cached, ",live" not');
    assert.deepStrictEqual(prefetchOf(out), [], 'prefetch hints (ad segments) dropped');
    assert(!out.includes('example.com') && !out.includes('ads.example.net'), 'ad landing / click-tracking URLs neutralised');
    const expected = lf(AD).split('\n').map((l) => (l.startsWith('#EXT-X-TWITCH-PREFETCH:') ? '' : l)).join('\n')
        .replace(/(X-TV-TWITCH-AD-URL=")[^"]*"/, '$1https://twitch.tv"')
        .replace(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")[^"]*"/, '$1https://twitch.tv"');
    assert.strictEqual(out, expected, 'nothing else changes (prefetch lines blanked, not removed)');
    assert.strictEqual(info.NumStrippedAdSegments, 4);
    assert.strictEqual(info.IsStrippingAdSegments, true);
    h.stripAdSegments(AD.replaceAll('\n', '\r\n'), false, info);
    assert.strictEqual(info.NumStrippedAdSegments, 4, 'already cached segments are not counted twice (CRLF too)');

    // Cache entries expire after 2 minutes.
    h.AdSegmentCache.set('https://old.example/seg.ts', Date.now() - 121000);
    h.stripAdSegments(AD, false, info);
    assert(!h.AdSegmentCache.has('https://old.example/seg.ts'));
    // stripAllSegments (HEVC reload) and AllSegmentsAreAdSegments blank live segments too.
    h.stripAdSegments(AD, true, info);
    assert(LIVE_SEGMENTS_IN_AD.every((url) => h.AdSegmentCache.has(url)));
    const all = m3u8Helpers({ AllSegmentsAreAdSegments: true });
    all.stripAdSegments(LIVE, false, { NumStrippedAdSegments: 0 });
    assert.strictEqual(all.AdSegmentCache.size, segmentsOf(LIVE).length);
});

test('stripAdSegments: playlist without ads is left as is', () => {
    const h = m3u8Helpers();
    const info = { NumStrippedAdSegments: 3, IsStrippingAdSegments: true };
    assert.strictEqual(h.stripAdSegments(LIVE, false, info), LIVE);
    assert.strictEqual(h.stripAdSegments(LIVE.replaceAll('\n', '\r\n'), false, info), LIVE, 'CRLF normalised, same content');
    assert.strictEqual(h.AdSegmentCache.size, 0);
    assert.strictEqual(prefetchOf(LIVE).length, 2);
    assert.strictEqual(info.NumStrippedAdSegments, 0);
    assert.strictEqual(info.IsStrippingAdSegments, false);
});

// ---------------------------------------------------------------------------------------------
// Page-side pure helpers (settings, allowlist, ad stats, self-check)

const CORE_PURE = ['backupPlayerTypesForMode', 'normalizeAutoQualityMode', 'normalizeAllowlist', 'parseStoredAllowlist', 'isChannelAllowlisted',
    'normalizeAdStats', 'addAdStats', 'normalizeWatchedAds', 'addWatchedAds', 'adBlockMethod', 'normalizeAdMethods', 'normalizeLastAd', 'updateAdBreakTracker', 'removeAdBreakSource', 'expireAdBreaks', 'allowlistReloadNeeded', 'parseChannelPage', 'vaftHealthProblem', 'isDocumentActuallyHidden'];
const core = new Function('document', 'nativeHiddenGetter', 'nativeWebkitHiddenGetter', `'use strict';
    ${CORE_PURE.map((name) => extract(name)).join('\n')}
    return { ${CORE_PURE.join(', ')} };
`);
const pure = core(null, null, null);

test('declareOptions defaults keep the established behaviour (new features opt-in)', () => {
    assert.deepStrictEqual(defaults.BackupPlayerTypes, ['mobile_feed', 'embed', 'popout', 'autoplay']);
    assert.strictEqual(defaults.FallbackPlayerType, 'embed');
    assert.strictEqual(defaults.ForceAccessTokenPlayerType, 'popout');
    assert.strictEqual(defaults.AdSignifier, 'stitched');
    assert.strictEqual(defaults.IsAdStrippingEnabled, true);
    assert.strictEqual(defaults.PlayerBufferingFix, true);
    assert.strictEqual(defaults.SkipPlayerReloadOnHevc, false);
    assert.deepStrictEqual(defaults.AllowlistedChannels, [], 'allowlist empty by default');
    assert(defaults.WorkerFetchTimeoutMs > 0 && defaults.WorkerFetchTimeoutMs <= 60000);
});

test('38.0: a Source choice from the removed 360p | Source buttons is dropped once, the console choice after it is kept', () => {
    const start = coreSrc.indexOf("        if (localStorage.getItem('vaftBackupModeReset') !== '38') {");
    assert(start > 0 && start < coreSrc.indexOf("        applyAdBackupMode(localStorage.getItem('adBackupMode'));"), 'reset runs before the stored mode is applied');
    const block = coreSrc.slice(start, coreSrc.indexOf('\n        }\n', start) + 10);
    const run = (store) => {
        const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
        new Function('localStorage', block)(localStorage);
        return store;
    };
    const old = run(new Map([['adBackupMode', 'source']]));
    assert.strictEqual(old.get('adBackupMode'), undefined, 'old Source choice dropped');
    assert.strictEqual(old.get('vaftBackupModeReset'), '38');
    old.set('adBackupMode', 'source');// setAdBackupMode('source') from the console afterwards
    run(old);
    assert.strictEqual(old.get('adBackupMode'), 'source', 'kept on the next loads');
    assert.strictEqual(run(new Map()).get('adBackupMode'), undefined, 'fresh install: default (360p last resort)');
});

test('ad fallback mode and auto-quality mode', () => {
    const all = defaults.BackupPlayerTypes;
    assert.deepStrictEqual(pure.backupPlayerTypesForMode('source', all), ['mobile_feed', 'embed', 'popout'], 'Source drops the 360p autoplay backup');
    for (const mode of [null, undefined, '', '360p', 'audio', 'SOURCE']) assert.deepStrictEqual(pure.backupPlayerTypesForMode(mode, all), all, `mode ${mode}`);
    assert.deepStrictEqual(all, ['mobile_feed', 'embed', 'popout', 'autoplay'], 'input not mutated');
    for (const value of [null, undefined, '', 'on', 'auto', 'OFF']) assert.strictEqual(pure.normalizeAutoQualityMode(value), 'on', `value ${value}`);
    assert.strictEqual(pure.normalizeAutoQualityMode('off'), 'off');
});

test('allowlist normalisation (also what reaches the worker blob)', () => {
    assert.deepStrictEqual(pure.normalizeAllowlist([' SomeStreamer ', 'somestreamer', 'other_1', 'bad name', '', 7, null, 'a'.repeat(26), 'a'.repeat(25), "x'];alert(1)//"]),
        ['somestreamer', 'other_1', 'a'.repeat(25)]);
    for (const value of ['somestreamer', null, undefined, {}, 42]) assert.deepStrictEqual(pure.normalizeAllowlist(value), []);
    assert.deepStrictEqual(pure.parseStoredAllowlist('["A","b","A"]'), ['a', 'b']);
    for (const raw of [null, '', '{bad', '"x"', '{"a":1}']) assert.deepStrictEqual(pure.parseStoredAllowlist(raw), [], `raw ${raw}`);
    assert.strictEqual(pure.isChannelAllowlisted('SomeStreamer', ['somestreamer']), true);
    assert.strictEqual(pure.isChannelAllowlisted('somestreamer', []), false);
    assert.strictEqual(pure.isChannelAllowlisted(undefined, ['somestreamer']), false);
    assert.strictEqual(pure.isChannelAllowlisted('somestreamer', null), false);
});

test('ad stats: totals sanitised, one break per ad across workers, capped gaps', () => {
    assert.deepStrictEqual(pure.normalizeAdStats(null), { breaks: 0, seconds: 0, since: null });
    assert.deepStrictEqual(pure.normalizeAdStats({ breaks: -1, seconds: 'x', since: 'y' }), { breaks: 0, seconds: 0, since: null });
    assert.deepStrictEqual(pure.normalizeAdStats({ breaks: 2.9, seconds: 12.34, since: 5 }), { breaks: 2, seconds: 12.3, since: 5 });
    assert.deepStrictEqual(pure.addAdStats(null, 1, 2.25, 1000), { breaks: 1, seconds: 2.3, since: 1000 });
    assert.deepStrictEqual(pure.addAdStats({ breaks: 2, seconds: 10, since: 5 }, 0, 1, 1000), { breaks: 2, seconds: 11, since: 5 });

    const tracker = new Map();
    const workerA = {};
    const workerB = {};
    const step = (worker, hasAds, at, backup = null) => pure.updateAdBreakTracker(tracker, worker, 'somestreamer', hasAds, backup, at);
    assert.deepStrictEqual(step(workerA, true, 0), { newBreak: true, seconds: 0, changed: true });
    assert.deepStrictEqual(step(workerB, true, 1000), { newBreak: false, seconds: 1, changed: false }, 'second worker, same break');
    assert.deepStrictEqual(step(workerA, true, 2000, 'embed'), { newBreak: false, seconds: 1, changed: true }, 'backup type change is reported');
    assert.deepStrictEqual(step(workerA, false, 3000), { newBreak: false, seconds: 1, changed: false }, 'B still reports the ad');
    assert.deepStrictEqual(step(workerB, false, 20000), { newBreak: false, seconds: 10, changed: true }, 'gap capped at 10 s, break over');
    assert.strictEqual(tracker.size, 0);
    assert.deepStrictEqual(pure.updateAdBreakTracker(tracker, workerA, null, true, null, 0), { newBreak: false, seconds: 0, changed: false }, 'no channel: ignored');
    step(workerA, true, 0);
    assert.strictEqual(step(workerB, true, 61000).newBreak, true, 'no update for 60 s: the old break is over');

    const ended = new Map();
    pure.updateAdBreakTracker(ended, workerA, 'x', true, null, 0);
    pure.updateAdBreakTracker(ended, workerB, 'y', true, null, 0);
    pure.updateAdBreakTracker(ended, workerA, 'y', true, null, 0);
    assert.deepStrictEqual(pure.removeAdBreakSource(ended, workerA, 3000), { seconds: 3, ended: ['x'] }, 'terminated worker ends only its own breaks');
    assert(ended.has('y'));

    // Same worker now reporting another channel: its other breaks end, the kept channel stays.
    const moved = new Map();
    pure.updateAdBreakTracker(moved, workerA, 'x', true, null, 0);
    pure.updateAdBreakTracker(moved, workerA, 'y', true, null, 0);
    assert.deepStrictEqual(pure.removeAdBreakSource(moved, workerA, 2000, 'y'), { seconds: 2, ended: ['x'] });
    assert.deepStrictEqual([...moved.keys()], ['y']);
    assert.deepStrictEqual(pure.removeAdBreakSource(moved, workerA, 2000, 'y'), { seconds: 0, ended: [] }, 'nothing else to end');

    // Expiry sweep: no update for 60 s ends the break without adding time.
    const idle = new Map();
    pure.updateAdBreakTracker(idle, workerA, 'x', true, null, 0);
    pure.updateAdBreakTracker(idle, workerA, 'y', true, null, 50000);
    assert.deepStrictEqual(pure.expireAdBreaks(idle, 60000), [], '60 s is not over yet');
    assert.deepStrictEqual(pure.expireAdBreaks(idle, 60001), ['x']);
    assert.deepStrictEqual([...idle.keys()], ['y']);
});

// trackAdState / sweepAdBreaks with their page state (Date.now() faked).
function adStateHarness() {
    const clock = { t: 0 };
    const h = new Function('Date', `'use strict';
        const adBreakTracker = new Map();
        const recorded = [];
        const dispatched = [];
        const banners = [];
        const vaftRuntimeStatus = { channel: null, showingAd: false, strippingSegments: false, backupPlayerType: null };
        const recordAdStats = (breaks, seconds) => { if (breaks || seconds) recorded.push([breaks, seconds]); };
        const watchedAdTracker = new Map();
        const watched = [];
        const recordWatchedAds = (channel, breaks, seconds) => { if (breaks || seconds) watched.push([channel, breaks, seconds]); };
        const methods = [];
        const lastAds = [];
        const recordAdMethod = (method, seconds) => { if (method && seconds > 0) methods.push([method, seconds]); };
        const recordLastAd = (lastAd) => lastAds.push(lastAd);
        const dispatchAdState = (channel) => dispatched.push(channel);
        const updateAdblockBanner = (data) => banners.push(data);
        ${['adBlockMethod', 'updateAdBreakTracker', 'removeAdBreakSource', 'expireAdBreaks', 'trackAdState', 'lastAdBreakSweepAt', 'sweepAdBreaks', 'forgetAdStateSource'].map((name) => extract(name)).join('\n')}
        return { trackAdState, sweepAdBreaks, forgetAdStateSource, adBreakTracker, watchedAdTracker, recorded, watched, methods, lastAds, dispatched, banners, vaftRuntimeStatus };
    `)({ now: () => clock.t });
    h.clock = clock;
    h.msg = (worker, channel, hasAds, at) => {
        clock.t = at;
        h.trackAdState(worker, { hasAds, runtimeStatus: { channel, backupPlayerType: hasAds ? 'embed' : null } });
    };
    // Allowlisted channel: Twitch's ad plays (hasAds stays false), the worker reports watchingAd.
    h.watch = (worker, channel, watchingAd, at) => {
        clock.t = at;
        h.trackAdState(worker, { hasAds: false, watchingAd, runtimeStatus: { channel, backupPlayerType: null, allowlisted: true } });
    };
    return h;
}

test('ad details: time per replacement method, last break blocked', () => {
    assert.strictEqual(pure.adBlockMethod({ backupPlayerType: 'mobile_feed' }), 'full');
    assert.strictEqual(pure.adBlockMethod({ backupPlayerType: 'embed' }), 'full');
    assert.strictEqual(pure.adBlockMethod({ backupPlayerType: 'autoplay' }), 'low');
    assert.strictEqual(pure.adBlockMethod({ backupPlayerType: 'embed', strippingSegments: true }), 'strip', 'stripping wins over the fallback type');
    for (const value of [null, {}, { backupPlayerType: null }, { backupPlayerType: '' }]) assert.strictEqual(pure.adBlockMethod(value), null);
    assert.deepStrictEqual(plain(pure.normalizeAdMethods({ full: 12.34, low: -1, strip: 'x', other: 5 })), { full: 12.3, low: 0, strip: 0 });
    assert.deepStrictEqual(plain(pure.normalizeAdMethods(null)), { full: 0, low: 0, strip: 0 });
    assert.deepStrictEqual(plain(pure.normalizeLastAd({ channel: 'abc', at: 5, seconds: 30.04, midroll: true, method: 'low' })), { channel: 'abc', at: 5, seconds: 30, midroll: true, method: 'low' });
    assert.deepStrictEqual(plain(pure.normalizeLastAd({ channel: 'abc', at: 5, method: 'evil', midroll: 'yes' })), { channel: 'abc', at: 5, seconds: 0, midroll: false, method: null });
    for (const value of [null, 'x', { channel: 'Bad!', at: 5 }, { channel: 'abc', at: 0 }, { channel: 'abc' }]) assert.strictEqual(pure.normalizeLastAd(value), null);

    const h = adStateHarness();
    const w = {};
    const msg = (status, hasAds, at) => { h.clock.t = at; h.trackAdState(w, { hasAds, runtimeStatus: { channel: 'a', ...status } }); };
    msg({ backupPlayerType: null }, true, 0);// ad found, no backup chosen yet
    msg({ backupPlayerType: 'mobile_feed', isMidroll: true }, true, 2000);
    msg({ backupPlayerType: 'mobile_feed', isMidroll: true }, true, 4000);
    msg({ backupPlayerType: 'embed', strippingSegments: true, isMidroll: true }, true, 6000);// the gap before went to mobile_feed
    msg({ backupPlayerType: 'embed', strippingSegments: true }, true, 8000);
    msg({}, false, 9000);// ad over
    assert.deepStrictEqual(h.methods, [['full', 2], ['full', 2], ['full', 2], ['strip', 2], ['strip', 1]]);
    assert.deepStrictEqual(plain(h.lastAds.at(-1)), { channel: 'a', at: 9000, seconds: 9, midroll: true, method: 'strip' });
    assert.deepStrictEqual(h.recorded.reduce((sum, [, seconds]) => sum + seconds, 0), 9, 'same time as the blocked stats');
    msg({ backupPlayerType: 'autoplay' }, true, 100000);
    assert.deepStrictEqual(plain(h.lastAds.at(-1)), { channel: 'a', at: 100000, seconds: 0, midroll: false, method: 'low' }, 'a new break starts fresh');
    const reported = h.lastAds.length;
    msg({}, false, 200000);// no update for 100 s: the tracker drops that break
    assert.strictEqual(h.lastAds.length, reported, 'a stale break is not reported again with a new date');
    msg({}, false, 202000);
    assert.strictEqual(h.lastAds.length, reported, 'plain live playback reports nothing');
});

test('playback info for the Quality tab: optional player calls, finite numbers only, <video> fallbacks', () => {
    const playbackInfo = new Function(`${extract('PLAYBACK_METHODS')} ${extract('playbackInfo')} return playbackInfo;`)();
    const player = {
        getQuality: () => ({ name: '1080p60', group: 'chunked', width: 1920, height: 1080, framerate: 60, codecs: 'avc1.64002A,mp4a.40.2' }),
        getQualities: () => [{ name: '1080p60', group: 'chunked' }, { name: '720p60' }, { bogus: 1 }, { name: 5 }],
        getVideoFrameRate: () => 59.94,
        getVideoBitRate: () => 6200000,
        getBandwidthEstimate: () => 1000000,
        getLiveLatency: () => { throw new Error('not live'); },
        isLiveLowLatency: () => true,
        getBufferDuration: () => 2.62,
        getDroppedFrames: () => 3,
    };
    assert.deepStrictEqual(plain(playbackInfo(player, { videoWidth: 1920, videoHeight: 1080 })), {
        quality: '1080p60', source: true, width: 1920, height: 1080, framerate: 59.94, codecs: 'avc1.64002A,mp4a.40.2', bitrate: 6200000, bandwidth: 1000000,
        latency: null, lowLatency: true, buffer: 2.62, dropped: 3, available: ['1080p60', '720p60'], missing: [] });
    assert.deepStrictEqual(plain(playbackInfo({ getVideoBitRate: () => NaN, getQuality: () => null, getLiveLatency: () => -1, isLiveLowLatency: () => 'yes' }, { videoWidth: 0, videoHeight: 0 })),
        { quality: null, source: false, width: null, height: null, framerate: null, codecs: null, bitrate: null, bandwidth: null, latency: null, lowLatency: null, buffer: null, dropped: null, available: [],
            missing: ['getQualities', 'getVideoFrameRate', 'getBandwidthEstimate', 'getBufferDuration', 'getDroppedFrames'] });
    // No player found: what the <video> element itself says.
    const video = { videoWidth: 2560, videoHeight: 1440, currentTime: 10, buffered: { length: 2, end: (i) => [5, 12.5][i] }, getVideoPlaybackQuality: () => ({ droppedVideoFrames: 0 }) };
    const fallback = plain(playbackInfo(null, video));
    assert.deepStrictEqual({ quality: fallback.quality, width: fallback.width, height: fallback.height, buffer: fallback.buffer, dropped: fallback.dropped, missing: fallback.missing },
        { quality: '1440p', width: 2560, height: 1440, buffer: 2.5, dropped: 0, missing: ['player'] });
    assert.deepStrictEqual(plain(playbackInfo(null, { buffered: { length: 0 }, getVideoPlaybackQuality: () => { throw new Error('x'); } })).buffer, null);
});

test('ads watched on allowlisted channels: counted per channel, never as blocked', () => {
    assert.deepStrictEqual(plain(pure.normalizeWatchedAds({ abc: { breaks: 2, seconds: 61.26, since: 5 }, 'Bad!': { breaks: 1 }, zero: { breaks: 0 }, __proto__x: 1 })),
        { abc: { breaks: 2, seconds: 61.3, since: 5 } });
    for (const value of [null, 'x', [], 5]) assert.deepStrictEqual(plain(pure.normalizeWatchedAds(value)), {});
    assert.deepStrictEqual(plain(pure.addWatchedAds(null, 'abc', 1, 0, 1000)), { abc: { breaks: 1, seconds: 0, since: 1000 } });
    assert.deepStrictEqual(plain(pure.addWatchedAds({ abc: { breaks: 1, seconds: 4, since: 5 }, def: { breaks: 1, seconds: 1, since: 6 } }, 'abc', 0, 2, 1000)),
        { abc: { breaks: 1, seconds: 6, since: 5 }, def: { breaks: 1, seconds: 1, since: 6 } }, 'other channels kept, since kept');
    const proto = pure.addWatchedAds({}, '__proto__', 1, 0, 1000);
    assert.strictEqual(Object.getPrototypeOf(proto), Object.prototype, 'a "__proto__" login cannot replace the prototype');
    assert.strictEqual(JSON.stringify(proto), '{"__proto__":{"breaks":1,"seconds":0,"since":1000}}', 'kept as a plain own key');

    const h = adStateHarness();
    const w = {};
    h.watch(w, 'a', true, 0);
    h.watch(w, 'a', true, 2000);
    h.watch(w, 'a', true, 4000);
    h.watch(w, 'a', false, 30000);
    assert.deepStrictEqual(h.watched, [['a', 1, 0], ['a', 0, 2], ['a', 0, 2], ['a', 0, 10]], 'one break, gaps capped at 10 s');
    assert.deepStrictEqual(h.recorded, [], 'nothing counted as blocked');
    assert.deepStrictEqual(h.dispatched, [], 'the pill stays on "allowed"');
    h.watch(w, 'a', true, 40000);
    assert.deepStrictEqual(h.watched.at(-1), ['a', 1, 0], 'next ad: new break');
    h.watch(w, 'b', false, 41000);// SPA navigation mid-ad: a's watched ad ends, no time added later
    assert(!h.watchedAdTracker.has('a'));
    h.watch(w, 'a', false, 45000);
    assert.deepStrictEqual(h.watched.at(-1), ['a', 1, 0]);
    h.watch(w, 'b', true, 50000);
    h.forgetAdStateSource(w);// worker terminated mid-ad
    assert.strictEqual(h.watchedAdTracker.size, 0);
    h.watch(w, 'c', true, 60000);
    h.clock.t = 200000;
    h.sweepAdBreaks();
    assert.strictEqual(h.watchedAdTracker.size, 0, 'the sweep ends watched ads no message will close');
});

test('ad state: leaving a channel mid-ad (same worker) ends that break, no phantom time on return', () => {
    const h = adStateHarness();
    const w = {};
    h.msg(w, 'a', true, 0);
    h.msg(w, 'a', true, 2000);
    assert.deepStrictEqual(h.dispatched, ['a']);
    h.msg(w, 'b', false, 4000);// SPA navigation to b while a was in an ad
    assert.deepStrictEqual(h.dispatched, ['a', 'a'], 'a: ad over');
    assert(!h.adBreakTracker.has('a'));
    h.msg(w, 'a', false, 6000);
    assert.deepStrictEqual(h.recorded, [[1, 0], [0, 2], [0, 2]], 'one break, 4 s, nothing added on return');
    h.msg(w, 'a', true, 8000);
    assert.deepStrictEqual(h.recorded.at(-1), [1, 0], 'a new ad on return is a new break');

    const shared = adStateHarness();
    const w1 = {};
    const w2 = {};
    shared.msg(w1, 'a', true, 0);
    shared.msg(w2, 'a', true, 1000);
    shared.msg(w1, 'b', false, 2000);
    assert(shared.adBreakTracker.has('a'), 'another worker still reports the ad on a');
});

test('ad state: the sweep ends breaks no message will close (stream ended mid-ad, VOD page)', () => {
    const h = adStateHarness();
    const w = {};
    h.msg(w, 'a', true, 0);
    Object.assign(h.vaftRuntimeStatus, { channel: 'a', showingAd: true, strippingSegments: true, backupPlayerType: 'embed' });
    h.clock.t = 30000;
    h.sweepAdBreaks();
    assert(h.adBreakTracker.has('a'));
    h.clock.t = 33000;
    h.sweepAdBreaks();
    h.clock.t = 61000;
    h.sweepAdBreaks();
    assert(!h.adBreakTracker.has('a'));
    assert.deepStrictEqual(h.dispatched, ['a', 'a']);
    assert.deepStrictEqual({ ...h.vaftRuntimeStatus }, { channel: 'a', showingAd: false, strippingSegments: false, backupPlayerType: null }, 'vaftStatus() no longer shows the ad');
    assert.deepStrictEqual(h.banners, [{ hasAds: false, isStrippingAdSegments: false }], 'vaft overlay hidden (auto quality waits on it)');
    h.clock.t = 63000;
    h.msg(w, 'b', true, 63000);
    h.clock.t = 130000;
    h.sweepAdBreaks();
    assert.deepStrictEqual(h.banners.length, 1, 'another channel than the one shown: overlay left alone');
});

test('parseChannelPage: live channel pages only', () => {
    const page = (pathname, hostname = 'www.twitch.tv', search = '') => pure.parseChannelPage(hostname, pathname, search);
    assert.deepStrictEqual(page('/SomeStreamer'), { channel: 'somestreamer', isLive: true });
    assert.deepStrictEqual(page('/somestreamer/'), { channel: 'somestreamer', isLive: true });
    for (const p of ['/somestreamer/videos', '/somestreamer/clip/FunnySlug-abc', '/somestreamer/about']) assert.deepStrictEqual(page(p), { channel: 'somestreamer', isLive: false }, p);
    for (const p of ['/', '', '/directory', '/directory/category/just-chatting', '/videos/2291928374', '/settings/profile', '/moderator/somestreamer', '/popout/somestreamer/chat', '/search', '/bad-name!',
        '/collections/AbC123xyz', '/subs/somestreamer', '/redeem', '/giftcard', '/checkout/x']) {
        assert.deepStrictEqual(page(p), { channel: null, isLive: false }, p);
    }
    assert.deepStrictEqual(page('/', 'player.twitch.tv', '?channel=SomeStreamer&parent=example.com'), { channel: 'somestreamer', isLive: true });
    assert.deepStrictEqual(page('/', 'player.twitch.tv', '?channel=somestreamer&video=v2291928374'), { channel: 'somestreamer', isLive: false });
    assert.deepStrictEqual(page('/', 'player.twitch.tv', '?video=v2291928374&parent=example.com'), { channel: null, isLive: false });
    assert.deepStrictEqual(page('/SomeStreamer', 'm.twitch.tv'), { channel: 'somestreamer', isLive: true }, 'mobile web');
});

test('allowlist change: reload only when the live channel on screen flipped', () => {
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', [], ['somestreamer'], 'live'), true);
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', ['somestreamer'], [], 'live'), true);
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', ['somestreamer'], ['somestreamer', 'other'], 'live'), false, 'unchanged for this channel');
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', [], ['other'], 'live'), false);
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', [], ['somestreamer'], 'archive'), false, 'VOD');
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', [], ['somestreamer'], undefined), false, 'no player');
    assert.strictEqual(pure.allowlistReloadNeeded(null, [], ['somestreamer'], 'live'), false, 'no channel page');
    assert.strictEqual(pure.allowlistReloadNeeded('somestreamer', 'clobbered', ['somestreamer'], 'live'), true, 'bad previous value');
});

// setAllowlist / applyAllowlist with the page state they use.
function pageAllowlist({ initial = [], href = 'https://www.twitch.tv/somestreamer', contentType = 'live', setItemThrows = false } = {}) {
    const u = new URL(href);
    const log = { posted: [], reloads: [], warnings: [], storage: new Map(), displaySyncs: [] };
    let currentList = () => null;
    const localStorage = { setItem: (key, value) => { if (setItemThrows) throw new Error('QuotaExceededError'); log.storage.set(key, value); } };
    const api = new Function('localStorage', 'location', 'console', 'postTwitchWorkerMessage', 'doTwitchPlayerTask', 'getPlayerAndState', 'syncDisplayAds', 'initial', `'use strict';
        let AllowlistedChannels = initial;
        const playerForMonitoringBuffering = null;
        ${['normalizeAllowlist', 'isChannelAllowlisted', 'parseChannelPage', 'allowlistReloadNeeded', 'applyAllowlist', 'setAllowlist'].map((name) => extract(name)).join('\n')}
        return { setAllowlist, current: () => AllowlistedChannels };
    `)(localStorage, { hostname: u.hostname, pathname: u.pathname, search: u.search }, { warn: (m) => log.warnings.push(m) },
        (key, value) => log.posted.push([key, value]), (pausePlay, reload) => log.reloads.push([pausePlay, reload]),
        () => ({ player: {}, state: { props: { content: { type: contentType } } } }), () => { log.displaySyncs.push(currentList()); }, initial);
    currentList = api.current;
    return { ...api, log };
}

test('setVaftAllowlist: array only (a string no longer wipes the list); reload on a flip of the channel on screen', () => {
    for (const bad of ['somestreamer', undefined, null, { a: 1 }]) {
        const page = pageAllowlist({ initial: ['keepme', 'other'] });
        assert.deepStrictEqual(page.setAllowlist(bad), ['keepme', 'other'], `${bad}: list unchanged`);
        assert.deepStrictEqual(page.current(), ['keepme', 'other']);
        assert.strictEqual(page.log.storage.size, 0, 'nothing saved');
        assert.deepStrictEqual(page.log.posted, [], 'nothing sent to the workers');
        assert.deepStrictEqual(page.log.displaySyncs, [], 'display ad decline untouched');
        assert.strictEqual(page.log.warnings.length, 1, 'console warning with the right call');
        assert.match(page.log.warnings[0], /toggleVaftAllowlist/);
    }
    const page = pageAllowlist();
    assert.deepStrictEqual(page.setAllowlist(['SomeStreamer', 'bad name']), ['somestreamer']);
    assert.strictEqual(page.log.storage.get('vaftAllowlist'), '["somestreamer"]');
    assert.deepStrictEqual(page.log.posted, [['UpdateAllowlist', ['somestreamer']]]);
    assert.deepStrictEqual(page.log.reloads, [[false, true]], 'player reloaded: Twitch\'s own token this time');
    assert.deepStrictEqual(page.log.displaySyncs, [['somestreamer']], 'display ad decline re-evaluated with the new list already in place');
    page.setAllowlist(['somestreamer', 'other']);
    assert.strictEqual(page.log.reloads.length, 1, 'unchanged for the channel on screen: no reload');
    page.setAllowlist([]);
    assert.strictEqual(page.log.reloads.length, 2, 'removed: reload onto the forced popout token');

    const vod = pageAllowlist({ href: 'https://www.twitch.tv/somestreamer/videos', contentType: 'archive' });
    vod.setAllowlist(['somestreamer']);
    assert.deepStrictEqual(vod.log.reloads, [], 'not live: no reload');
    const blocked = pageAllowlist({ setItemThrows: true });
    assert.deepStrictEqual(blocked.setAllowlist(['somestreamer']), ['somestreamer'], 'storage blocked: still applied for this page');
    assert.deepStrictEqual(blocked.log.posted.length, 1);
});

// Display ads: Twitch's client-side ad manager, found through a fake webpack registry.
const DISPLAY_FNS = ['getWebpackRequire', 'webpackRequireParam', 'webpackDepsLoaded', 'findClientAdManager', 'watchTwitchDeclines', 'applyDisplayAdPolicy'];
function displayAdFns() {
    return new Function(`'use strict';
        ${DISPLAY_FNS.map((name) => extract(name)).join('\n')}
        return { ${DISPLAY_FNS.join(', ')} };
    `)();
}
// Twitch's manager: static queue methods on a class, declineReason read when the queue drains.
function fakeAdManagerClass(initialReason = undefined) {
    class AdManager {
        static startProcessingRequests() {}
        static decline(reason, options) {
            AdManager.declines.push([reason, options]);
            AdManager.declineReason = reason;
        }
    }
    AdManager.declines = [];
    AdManager.declineReason = initialReason;
    return AdManager;
}
// Webpack 5 runtime semantics: the cache entry is written before the factory runs and kept when it
// throws; a chunk's factories land in req.m as soon as that chunk is pushed.
function fakeWebpack(factories, { exposeCache = true } = {}) {
    const cache = {};
    const runs = [];
    const req = (id) => {
        if (cache[id]) return cache[id].exports;
        const module = cache[id] = { exports: {} };
        runs.push(String(id));
        factories[id](module, module.exports, req);
        return module.exports;
    };
    req.m = factories;
    if (exposeCache) req.c = cache;
    // Once webpack owns the array, push runs the entry's runtime callback with its require.
    const queue = [];
    queue.push = function(entry) {
        if (typeof entry?.[2] === 'function') entry[2](req);
        return Array.prototype.push.call(this, entry);
    };
    return { req, queue, cache, runs };
}
// Markers sit in comments: the lookup reads factory sources and never runs unrelated modules.
function adManagerModules(manager) {
    return {
        100: function(e, t, n) { /* unrelated module */ throw new Error('unrelated module must not run'); },
        200: function(e, t, n) { /* component calling startProcessingRequests only */ throw new Error('component must not run'); },
        300: function(e, t, n) {
            /* class with startProcessingRequests and declineReason, after decoys */
            n(400);
            const decoyObject = { startProcessingRequests() {}, decline() {} };
            const decoyFunction = Object.assign(function() {}, { startProcessingRequests() {} });
            e.exports = { helper: 1, decoyObject, decoyFunction, AdManager: manager };
        },
        400: function(e, t, n) { e.exports = { dependency: true }; },
    };
}

test('display ads: webpack require handed over, also through a FrankerFaceZ-style push wrapper', () => {
    const { getWebpackRequire } = displayAdFns();
    assert.strictEqual(getWebpackRequire(undefined), null, 'no webpack yet');
    const plain = [];
    assert.strictEqual(getWebpackRequire(plain), null, 'plain array (webpack not running yet)');
    assert.strictEqual(plain.length, 0, 'our entry is taken back out of the plain array');

    const pack = fakeWebpack(adManagerModules(fakeAdManagerClass()));
    assert.strictEqual(getWebpackRequire(pack.queue), pack.req, 'require handed over by webpack');

    // FrankerFaceZ wraps the push and stringifies the chunk ids with a template literal.
    const ffz = fakeWebpack({});
    const webpackPush = ffz.queue.push;
    ffz.queue.push = function(data) {
        data[0].map((x) => (typeof x !== 'string' ? `${x}` : x));
        return webpackPush.call(this, data);
    };
    assert.strictEqual(getWebpackRequire(ffz.queue), ffz.req, 'string chunk id: the wrapper does not throw');
    // A wrapper that throws after webpack handed its require over: the require is kept.
    const late = fakeWebpack({});
    late.queue.push = function(data) { data[2](late.req); throw new Error('wrapper bug'); };
    assert.strictEqual(getWebpackRequire(late.queue), late.req);
    const broken = [];
    broken.push = () => { throw new Error('wrapper bug'); };
    assert.strictEqual(getWebpackRequire(broken), null, 'a throwing push never escapes');
    const odd = [];
    odd.push = function(data) { data[2]({ not: 'a require' }); };
    assert.strictEqual(getWebpackRequire(odd), null, 'only a require function is accepted');
});

test('display ads: webpack factory parameters and dependency check', () => {
    const { webpackRequireParam, webpackDepsLoaded } = displayAdFns();
    const params = { 'function(e,t,n){n(1)}': 'n', '(e,t,n)=>{n(1)}': 'n', '12345(e,t,n){}': 'n', 'function (e, t, $r) {}': '$r', '(e,t)=>{}': '', 'e=>{}': '', 'function(e){}': '', 'nonsense': null };
    for (const [source, name] of Object.entries(params)) assert.strictEqual(webpackRequireParam(source), name, source);
    const req = () => {};
    req.m = { 1: (e, t, n) => { n(2); n.n(e); n.d(t, {}); n(7); }, 2: (e, t, n) => {}, 7: (e, t, r) => { r(3); } };
    assert.strictEqual(webpackDepsLoaded(req, '1'), false, 'module 3 (needed by 7) not loaded');
    req.m[3] = () => {};
    assert.strictEqual(webpackDepsLoaded(req, '1'), true);
    // The minifier writes round ids in e-notation: n(381e3) is module 381000.
    req.m = { 381494: function(e, t, n) { e.exports = [n(381e3), n(12e2)]; } };
    assert.strictEqual(webpackDepsLoaded(req, '381494'), false, 'module 381000 not loaded');
    req.m[381000] = () => {};
    assert.strictEqual(webpackDepsLoaded(req, '381494'), false, 'module 1200 not loaded');
    req.m[1200] = () => {};
    assert.strictEqual(webpackDepsLoaded(req, '381494'), true);
    // A local variable shadowing the require name with a string argument is not a dependency.
    req.m = { 5: function(e, t, n) { const f = (n) => n('empty'); e.exports = { f }; } };
    assert.strictEqual(webpackDepsLoaded(req, '5'), true, 'string arguments are not module ids');
    // Same-named member calls (x.n(1), $n(1)) are not requires either.
    req.m = { 6: function(e, t, n) { const o = { n() {} }; o.n(99); const $n = () => {}; $n(98); } };
    assert.strictEqual(webpackDepsLoaded(req, '6'), true);
    req.m = { 8: function(e, t, n) { n(99);n(98) } };
    assert.strictEqual(webpackDepsLoaded(req, '8'), false, 'back-to-back requires both read');
    req.m[99] = () => {};
    assert.strictEqual(webpackDepsLoaded(req, '8'), false);
    req.m[98] = () => {};
    assert.strictEqual(webpackDepsLoaded(req, '8'), true);
    req.m = { 1: (e, t, n) => { n(2); }, 2: (e, t, n) => { n(1); } };
    assert.strictEqual(webpackDepsLoaded(req, '1'), true, 'cycles end');
    req.m = { 1: (e, t, n) => { n(2); } };
    req.c = { 2: { exports: {} } };
    assert.strictEqual(webpackDepsLoaded(req, '1'), true, 'a dependency that already ran counts as loaded');
    req.m = { 1: 'not a function' };
    assert.strictEqual(webpackDepsLoaded(req, '1'), false);
});

test('display ads: the ad manager is found by its markers, never run before its dependencies are loaded', () => {
    const { findClientAdManager } = displayAdFns();
    for (const exposeCache of [true, false]) {
        const manager = fakeAdManagerClass();
        const all = adManagerModules(manager);
        const loaded = { 100: all[100], 200: all[200] };
        const pack = fakeWebpack(loaded, { exposeCache });
        const scanned = new Set();
        assert.strictEqual(findClientAdManager(pack.req, scanned), null, 'bundle with the manager not loaded yet');
        assert.deepStrictEqual([...scanned].sort(), ['100', '200'], 'non-matching modules are remembered');

        // The manager's chunk arrives before its dependency's chunk: it must not run (webpack would
        // keep a broken cache entry and Twitch's own code would crash on it later).
        let rereads = 0;
        Object.defineProperty(loaded, '100', { get() { rereads++; return all[100]; }, enumerable: true, configurable: true });
        loaded[300] = all[300];
        assert.strictEqual(findClientAdManager(pack.req, scanned), null, `${exposeCache}: dependency missing`);
        assert.deepStrictEqual(pack.runs, [], 'nothing ran');
        assert.ok(!('300' in pack.cache) && !('400' in pack.cache), 'no cache entry left behind');
        assert.ok(!scanned.has('300'), 'retried on the next tick');
        loaded[400] = all[400];
        const found = findClientAdManager(pack.req, scanned);
        assert.strictEqual(found?.manager, manager, `${exposeCache}: found once the dependency is loaded`);
        assert.strictEqual(found.moduleId, '300.AdManager');
        assert.deepStrictEqual(pack.runs, ['300', '400']);
        assert.strictEqual(rereads, 0, 'module 100 not read again');
    }

    // Already run by Twitch: taken from webpack's cache, nothing executed.
    const manager = fakeAdManagerClass();
    const pack = fakeWebpack(adManagerModules(manager));
    pack.req('300');
    pack.runs.length = 0;
    pack.req.m[300] = function(e, t, n) { /* startProcessingRequests declineReason */ throw new Error('must not run twice'); };
    assert.strictEqual(findClientAdManager(pack.req, new Set())?.manager, manager);
    assert.deepStrictEqual(pack.runs, []);
    assert.strictEqual(findClientAdManager(null, new Set()), null, 'no require: nothing found');
});

test('display ads: declined off the allowlist, our decline undone on allowlisted channels, Twitch\'s own never touched', () => {
    const { applyDisplayAdPolicy, watchTwitchDeclines } = displayAdFns();
    const R = 'player_size';
    const newCtl = () => ({ ours: false, before: undefined, failed: false });

    const m = fakeAdManagerClass();
    const ctl = newCtl();
    assert.strictEqual(applyDisplayAdPolicy(m, ctl, false, R), 'declined');
    assert.deepStrictEqual(m.declines, [[R, { sendEvent: false }]], 'Twitch\'s decline, without reporting it');
    assert.strictEqual(m.declineReason, R);
    assert.strictEqual(applyDisplayAdPolicy(m, ctl, false, R), 'declined');
    assert.strictEqual(m.declines.length, 1, 'not declined twice');
    assert.strictEqual(applyDisplayAdPolicy(m, ctl, true, R), 'allowed', 'allowlisted channel');
    assert.strictEqual(m.declineReason, undefined, 'previous value restored: display ad requests flow again');
    assert.strictEqual(applyDisplayAdPolicy(m, ctl, true, R), 'allowed');
    assert.strictEqual(applyDisplayAdPolicy(m, ctl, false, R), 'declined', 'back on a normal channel');
    assert.strictEqual(m.declines.length, 2);

    for (const initial of [null, '', 0]) {
        const n = fakeAdManagerClass(initial);
        const nctl = newCtl();
        assert.strictEqual(applyDisplayAdPolicy(n, nctl, false, R), 'declined', `initial ${JSON.stringify(initial)}`);
        assert.strictEqual(applyDisplayAdPolicy(n, nctl, true, R), 'allowed');
        assert.strictEqual(n.declineReason, initial, `exact previous value restored (${JSON.stringify(initial)})`);
    }

    // Twitch declined on its own (Turbo, ad-free sub, experiment): left exactly as it is.
    const t = fakeAdManagerClass();
    t.declineReason = 'turbo';
    const tctl = newCtl();
    assert.strictEqual(applyDisplayAdPolicy(t, tctl, false, R), 'twitch');
    assert.strictEqual(applyDisplayAdPolicy(t, tctl, true, R), 'twitch');
    assert.strictEqual(t.declineReason, 'turbo');
    assert.strictEqual(t.declines.length, 0);

    // Twitch already declined with this very reason before we found it: Twitch's, reported and kept as such.
    const tp = fakeAdManagerClass(R);
    const tpctl = newCtl();
    assert.strictEqual(applyDisplayAdPolicy(tp, tpctl, false, R), 'twitch');
    assert.strictEqual(applyDisplayAdPolicy(tp, tpctl, true, R), 'twitch');
    assert.strictEqual(tp.declineReason, R);
    assert.strictEqual(tp.declines.length, 0);

    // Twitch replaced our reason with its own: no longer ours, never cleared.
    const s = fakeAdManagerClass();
    const sctl = newCtl();
    applyDisplayAdPolicy(s, sctl, false, R);
    s.declineReason = 'turbo';
    assert.strictEqual(applyDisplayAdPolicy(s, sctl, true, R), 'twitch');
    assert.strictEqual(s.declineReason, 'turbo');
    assert.strictEqual(sctl.ours, false);

    // Twitch declines with the very same reason after us: watched, so it is Twitch's from then on.
    const w = fakeAdManagerClass();
    const wctl = newCtl();
    watchTwitchDeclines(w, wctl);
    watchTwitchDeclines(w, wctl);
    assert.strictEqual(applyDisplayAdPolicy(w, wctl, false, R), 'declined');
    assert.strictEqual(wctl.ours, true, 'our own call through the watch keeps it ours');
    w.decline(R);
    assert.strictEqual(wctl.ours, false);
    assert.strictEqual(applyDisplayAdPolicy(w, wctl, true, R), 'twitch');
    assert.strictEqual(w.declineReason, R, 'Twitch\'s decline kept on an allowlisted channel');
    assert.strictEqual(w.declines.length, 2, 'the watch calls Twitch\'s decline (wrapped once)');

    // decline() that does not take: reported once, not retried every tick.
    const f = fakeAdManagerClass();
    f.decline = function(reason, options) { f.declines.push([reason, options]); };
    const fctl = newCtl();
    assert.strictEqual(applyDisplayAdPolicy(f, fctl, false, R), 'failed');
    assert.strictEqual(applyDisplayAdPolicy(f, fctl, false, R), 'failed');
    assert.strictEqual(f.declines.length, 1);
    assert.strictEqual(applyDisplayAdPolicy(f, fctl, true, R), 'allowed', 'nothing to undo on an allowlisted channel');
    const thrower = fakeAdManagerClass();
    thrower.decline = () => { throw new Error('changed signature'); };
    assert.strictEqual(applyDisplayAdPolicy(thrower, newCtl(), false, R), 'failed', 'a throwing decline() does not break the page');

    // Read-only declineReason (cannot be restored): reported as stuck, still treated as ours.
    let reason;
    const ro = { startProcessingRequests() {}, decline(r) { reason = r; } };
    Object.defineProperty(ro, 'declineReason', { get: () => reason, configurable: true });
    const roctl = newCtl();
    assert.strictEqual(applyDisplayAdPolicy(ro, roctl, false, R), 'declined');
    assert.strictEqual(applyDisplayAdPolicy(ro, roctl, true, R), 'stuck');
    assert.strictEqual(roctl.ours, true);
    assert.strictEqual(applyDisplayAdPolicy(ro, roctl, false, R), 'declined');
});

function displayAdPage({ href, allowlist, modules, maxAttempts = 3, slowEvery = 2, before = {}, after = {}, storage = new Map(), top = true }) {
    const loc = new URL(href);
    const log = { warn: [], log: [], debug: [] };
    const pack = fakeWebpack(modules);
    const win = { ...before, webpackChunktwilight: pack.queue, ...after, listeners: {} };
    win.top = top ? win : {};
    win.addEventListener = (type, fn) => { win.listeners[type] = fn; };
    const localStorage = { getItem: (key) => (storage.has(key) ? storage.get(key) : null) };
    const history = { calls: [], pushState(...a) { this.calls.push(a); }, replaceState(...a) { this.calls.push(a); } };
    const api = new Function('window', 'location', 'console', 'localStorage', 'history', 'initial', `'use strict';
        let AllowlistedChannels = initial;
        ${['normalizeAllowlist', 'isChannelAllowlisted', 'parseChannelPage', 'allowlistChannelOfPage', 'DISPLAY_AD_DECLINE_REASON', 'displayAds',
        ...DISPLAY_FNS, 'isDisplayAdDeclineOn', 'syncDisplayAds', 'getDisplayAdStatus', 'hookHistoryForDisplayAds'].map((name) => extract(name)).join('\n')}
        const DISPLAY_AD_MAX_ATTEMPTS = ${maxAttempts};
        const DISPLAY_AD_SLOW_EVERY = ${slowEvery};
        return { syncDisplayAds, getDisplayAdStatus, hookHistoryForDisplayAds, setAllowlist: (l) => { AllowlistedChannels = l; } };
    `)(win, loc, { warn: (m) => log.warn.push(m), log: (m) => log.log.push(m), debug: (m) => log.debug.push(m) }, localStorage, history, allowlist);
    return { ...api, loc, log, storage, pack, win, history };
}

test('display ads: syncDisplayAds follows the channel on screen, mod view included, and SPA navigation at once', () => {
    const manager = fakeAdManagerClass();
    const page = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: ['other'], modules: adManagerModules(manager) });
    page.syncDisplayAds();
    assert.deepStrictEqual(page.getDisplayAdStatus(), { state: 'declined', moduleId: '300.AdManager', declineReason: 'player_size' });
    page.syncDisplayAds();
    page.syncDisplayAds();
    assert.strictEqual(page.log.log.length, 1, 'one log line for the decline, not one per tick');
    // SPA navigation to an allowlisted channel, then back.
    page.loc.pathname = '/other';
    page.syncDisplayAds();
    assert.deepStrictEqual(page.getDisplayAdStatus(), { state: 'allowed', moduleId: '300.AdManager', declineReason: null });
    page.loc.pathname = '/somestreamer';
    page.syncDisplayAds();
    assert.strictEqual(page.getDisplayAdStatus().state, 'declined');
    // Mod view and popout of an allowlisted channel count as that channel (same rule as the panel).
    for (const path of ['/moderator/other', '/popout/other/player']) {
        page.loc.pathname = path;
        page.syncDisplayAds();
        assert.strictEqual(page.getDisplayAdStatus().state, 'allowed', path);
        page.loc.pathname = '/directory';
        page.syncDisplayAds();
        assert.strictEqual(page.getDisplayAdStatus().state, 'declined', 'directory: declined');
    }
    // history.pushState / replaceState / popstate re-apply the policy without waiting for the timer.
    page.hookHistoryForDisplayAds();
    page.loc.pathname = '/other';
    page.history.pushState(null, '', '/other');
    assert.strictEqual(page.history.calls.length, 1, 'Twitch\'s navigation still happens');
    assert.strictEqual(page.getDisplayAdStatus().state, 'allowed', 'applied by pushState');
    page.loc.pathname = '/somestreamer';
    page.history.replaceState(null, '', '/somestreamer');
    assert.strictEqual(page.getDisplayAdStatus().state, 'declined', 'applied by replaceState');
    page.loc.pathname = '/other';
    page.win.listeners.popstate();
    assert.strictEqual(page.getDisplayAdStatus().state, 'allowed', 'applied on popstate');
    // Twitch itself declines with our very reason while we hold it: Twitch's from then on.
    page.loc.pathname = '/somestreamer';
    page.syncDisplayAds();
    assert.strictEqual(page.getDisplayAdStatus().state, 'declined');
    manager.decline('player_size');
    page.loc.pathname = '/other';
    page.syncDisplayAds();
    assert.deepStrictEqual(page.getDisplayAdStatus(), { state: 'twitch', moduleId: '300.AdManager', declineReason: 'player_size' }, 'Twitch\'s decline kept on an allowlisted channel');
    manager.declineReason = 7;
    assert.strictEqual(page.getDisplayAdStatus().declineReason, '7', 'status reason always a string');
    manager.declineReason = undefined;// Twitch lifts it
    page.syncDisplayAds();
    assert.strictEqual(page.getDisplayAdStatus().state, 'allowed');
    // Allowlisting the channel on screen gives its display ads back.
    page.loc.pathname = '/somestreamer';
    page.syncDisplayAds();
    page.setAllowlist(['other', 'somestreamer']);
    page.syncDisplayAds();
    assert.strictEqual(page.getDisplayAdStatus().state, 'allowed');
    assert.strictEqual(manager.declineReason, undefined);

    // Navigation before the manager is found does not burn lookup attempts.
    const early = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: [], modules: { 100: adManagerModules(null)[100] } });
    early.hookHistoryForDisplayAds();
    for (let i = 0; i < 5; i++) early.history.pushState(null, '', '/x');
    assert.strictEqual(early.getDisplayAdStatus().state, 'searching');

    // A browser extension's own webpack registry listed first (and one webpack does not own yet).
    const other = fakeWebpack({ 100: adManagerModules(null)[100] });
    const withExtension = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: [], modules: adManagerModules(fakeAdManagerClass()), before: { webpackChunkextension: other.queue, webpackChunkpending: [] } });
    withExtension.syncDisplayAds();
    assert.strictEqual(withExtension.getDisplayAdStatus().state, 'declined', 'Twitch\'s registry found past an extension\'s one');
    const other2 = fakeWebpack({ 100: adManagerModules(null)[100] });
    const extensionAfter = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: [], modules: adManagerModules(fakeAdManagerClass()), after: { webpackChunkextension: other2.queue } });
    extensionAfter.syncDisplayAds();
    assert.strictEqual(extensionAfter.getDisplayAdStatus().state, 'declined', 'an extension\'s registry listed after Twitch\'s does not hide it');

    // Registry still a plain array on the first tick (webpack not running yet), owned on the next.
    const lateOwned = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: [], modules: adManagerModules(fakeAdManagerClass()) });
    const owned = lateOwned.win.webpackChunktwilight;
    lateOwned.win.webpackChunktwilight = [];
    lateOwned.syncDisplayAds();
    assert.strictEqual(lateOwned.getDisplayAdStatus().state, 'searching');
    assert.strictEqual(lateOwned.win.webpackChunktwilight.length, 0, 'our entry taken back out of the plain array');
    lateOwned.win.webpackChunktwilight = owned;
    lateOwned.syncDisplayAds();
    assert.strictEqual(lateOwned.getDisplayAdStatus().state, 'declined');

    const startManager = fakeAdManagerClass();
    const start = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: ['somestreamer'], modules: adManagerModules(startManager) });
    start.syncDisplayAds();
    assert.strictEqual(start.getDisplayAdStatus().state, 'allowed', 'page opened on an allowlisted channel');
    assert.strictEqual(startManager.declines.length, 0, 'never declined there, not even briefly');
});

test('display ads: documented timing (500 ms ticks for 2 min, then every 10 s)', () => {
    const constants = new Function(`${extract('DISPLAY_AD_MAX_ATTEMPTS')} ${extract('DISPLAY_AD_SLOW_EVERY')} return { DISPLAY_AD_MAX_ATTEMPTS, DISPLAY_AD_SLOW_EVERY };`)();
    assert.match(coreSrc, /\n\s*setInterval\(syncDisplayAds, 500\);/);
    assert.strictEqual(constants.DISPLAY_AD_MAX_ATTEMPTS * 500, 120000);
    assert.strictEqual(constants.DISPLAY_AD_SLOW_EVERY * 500, 10000);
    assert.match(coreSrc, /\n\s*hookHistoryForDisplayAds\(\);/, 'SPA navigation hook installed');
});

test('display ads: off switch, slow lookup after 2 min, one warning on www only', () => {
    // Off switch: no webpack lookup at all; switching off later undoes our decline.
    const offManager = fakeAdManagerClass();
    const off = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: [], modules: adManagerModules(offManager), storage: new Map([['vaftDeclineDisplayAds', 'off']]) });
    let pushes = 0;
    const realPush = off.pack.queue.push;
    off.pack.queue.push = function(entry) { pushes++; return realPush.call(this, entry); };
    off.syncDisplayAds();
    assert.strictEqual(off.getDisplayAdStatus().state, 'off');
    assert.strictEqual(pushes, 0, 'switched off: webpack registry not touched');
    assert.strictEqual(offManager.declines.length, 0);
    off.storage.delete('vaftDeclineDisplayAds');
    off.syncDisplayAds();
    assert.strictEqual(off.getDisplayAdStatus().state, 'declined', 'switched back on');
    off.storage.set('vaftDeclineDisplayAds', 'off');
    off.syncDisplayAds();
    assert.deepStrictEqual(off.getDisplayAdStatus(), { state: 'off', moduleId: '300.AdManager', declineReason: null }, 'switched off: our decline undone');

    // Not found within the fast budget: one warning, then a slower lookup that still finds a late manager.
    const manager = fakeAdManagerClass();
    const all = adManagerModules(manager);
    const missing = displayAdPage({ href: 'https://www.twitch.tv/somestreamer', allowlist: [], modules: { 100: all[100] }, maxAttempts: 3, slowEvery: 2 });
    let registryPushes = 0;
    const webpackPush = missing.pack.queue.push;
    missing.pack.queue.push = function(entry) { registryPushes++; return webpackPush.call(this, entry); };
    let factoryReads = 0;
    const unrelated = all[100];
    Object.defineProperty(missing.pack.req.m, '100', { get() { factoryReads++; return unrelated; }, enumerable: true, configurable: true });
    const factories = missing.pack.req.m;
    for (let i = 0; i < 6; i++) missing.syncDisplayAds();
    assert.strictEqual(missing.getDisplayAdStatus().state, 'not-found');
    assert.strictEqual(registryPushes, 1, 'registry acquired once, not on every tick');
    assert.strictEqual(factoryReads, 1, 'each factory read once, not on every tick');
    assert.strictEqual(missing.log.warn.length, 1, 'one console warning');
    assert.match(missing.log.warn[0], /display ads/);
    Object.assign(factories, { 300: all[300], 400: all[400] });
    missing.syncDisplayAds();// attempt 7: skipped (slow lookup, every 2nd tick)
    assert.strictEqual(missing.getDisplayAdStatus().state, 'not-found');
    missing.syncDisplayAds();// attempt 8: looks again
    assert.strictEqual(missing.getDisplayAdStatus().state, 'declined', 'late manager still found');
    assert.strictEqual(missing.log.warn.length, 1);

    for (const [href, top] of [['https://player.twitch.tv/?channel=somestreamer', true], ['https://www.twitch.tv/somestreamer', false]]) {
        const quiet = displayAdPage({ href, allowlist: [], modules: { 100: all[100] }, maxAttempts: 2, top });
        for (let i = 0; i < 3; i++) quiet.syncDisplayAds();
        assert.strictEqual(quiet.log.warn.length, 0, `${href} top=${top}: no warning`);
        assert.strictEqual(quiet.log.debug.length, 1, 'debug line instead');
    }
});

// hideStandaloneTwitchVideoAds against fake <video> elements.
function fakeVideo(src) {
    const video = { currentSrc: src, dataset: {}, muted: false, paused: false, display: null };
    video.getAttribute = () => src;
    video.pause = () => { video.paused = true; };
    video.style = { setProperty: (name, value) => { video.display = value; }, removeProperty: () => { video.display = null; } };
    return video;
}
function adVideoPage(allowlist, href = 'https://www.twitch.tv/somestreamer') {
    const u = new URL(href);
    const videos = [fakeVideo('blob:https://www.twitch.tv/player'), fakeVideo('https://m.media-amazon.com/images/ad.mp4')];
    const document = { location: { href }, getElementsByTagName: () => videos };
    const hide = new Function('document', 'location', 'allowlist', `'use strict';
        const AllowlistedChannels = allowlist;
        const playerForMonitoringBuffering = null;
        ${['isChannelAllowlisted', 'parseChannelPage', 'allowlistChannelOfPage', 'isStandaloneTwitchAdVideo', 'hideStandaloneTwitchVideoAds'].map((name) => extract(name)).join('\n')}
        return hideStandaloneTwitchVideoAds;
    `)(document, { hostname: u.hostname, pathname: u.pathname, search: u.search }, allowlist);
    return { hide, player: videos[0], ad: videos[1] };
}

test('standalone media-amazon ad videos: hidden + muted, but left to play on allowlisted channels', () => {
    const blocked = adVideoPage([]);
    blocked.hide();
    assert.deepStrictEqual([blocked.ad.display, blocked.ad.muted, blocked.ad.paused, blocked.ad.dataset.vaftAdHidden], ['none', true, true, '1']);
    assert.deepStrictEqual([blocked.player.display, blocked.player.muted, blocked.player.paused], [null, false, false], 'player video untouched');

    const allowed = adVideoPage(['somestreamer']);
    allowed.hide();
    assert.deepStrictEqual([allowed.ad.display, allowed.ad.muted, allowed.ad.paused, allowed.ad.dataset.vaftAdHidden], [null, false, false, undefined]);
    const elsewhere = adVideoPage(['somestreamer'], 'https://www.twitch.tv/directory');
    elsewhere.hide();
    assert.strictEqual(elsewhere.ad.display, 'none', 'allowlist applies on that channel\'s pages only');

    // Allowlisted after the ad video was hidden: the hide is undone (unmuted as before).
    const later = adVideoPage([]);
    later.hide();
    const page = adVideoPage(['somestreamer']);
    page.ad.dataset = later.ad.dataset;
    page.ad.display = later.ad.display;
    page.ad.muted = true;
    page.hide();
    assert.deepStrictEqual([page.ad.display, page.ad.muted, page.ad.dataset.vaftAdHidden], [null, false, undefined]);
});

test('self-check verdict and native hidden check', () => {
    assert.strictEqual(pure.vaftHealthProblem(29999, false, true), null, 'under 30 s of live playback');
    assert.strictEqual(pure.vaftHealthProblem(30000, false, false), 'worker-not-hooked');
    assert.strictEqual(pure.vaftHealthProblem(30000, true, false), null, 'hooked, live not confirmed by the player');
    assert.strictEqual(pure.vaftHealthProblem(30000, true, true), 'no-worker-messages');
    // document.hidden is spoofed to false for the player: vaft reads the captured native getter.
    const doc = { realHidden: true };
    const getter = function () { return this.realHidden; };
    assert.strictEqual(core(doc, getter, null).isDocumentActuallyHidden(), true);
    assert.strictEqual(core(doc, null, getter).isDocumentActuallyHidden(), true, 'webkitHidden fallback');
    assert.strictEqual(core({ realHidden: false }, getter, null).isDocumentActuallyHidden(), false);
    assert.strictEqual(core(doc, () => { throw new Error('x'); }, null).isDocumentActuallyHidden(), false, 'throwing getter');
    assert.strictEqual(pure.isDocumentActuallyHidden(), false, 'no getter');
});

// ---------------------------------------------------------------------------------------------
// UI IIFE helpers

const UI_NAMES = ['QUALITY_LADDER', 'PREF', 'qualityHeight', 'is60', 'LOGIN_RE', 'RESERVED_ROUTES',
    'qualityPrefForTarget', 'normalizeQualityPref', 'isAtPreferredQuality', 'shouldSwitchQuality', 'pickQualityOption', 'getChannelFromLocation', 'formatDuration',
    'EARNINGS', 'estimateAds', 'subEarnings', 'formatEuros'];
const uiLocation = { hostname: 'www.twitch.tv', pathname: '/', search: '' };
const ui = new Function('location', `${UI_NAMES.map((name) => extract(name, uiSrc)).join('\n')} return { ${UI_NAMES.join(', ')} };`)(uiLocation);
const uiChannel = (pathname, hostname = 'www.twitch.tv', search = '') => {
    Object.assign(uiLocation, { pathname, hostname, search });
    return ui.getChannelFromLocation();
};

test('UI quality target -> preferred order (default unchanged since 37.2)', () => {
    assert.deepStrictEqual(ui.PREF, ['1440p60', '1080p60', '1440p', '1080p']);
    assert.deepStrictEqual(ui.qualityPrefForTarget('1440p60'), ui.PREF);
    assert.deepStrictEqual(ui.qualityPrefForTarget('1440p'), ['1440p', '1080p60', '1080p']);
    assert.deepStrictEqual(ui.qualityPrefForTarget('1080p60'), ['1080p60', '1080p']);
    assert.deepStrictEqual(ui.qualityPrefForTarget('1080p'), ['1080p']);
    assert.deepStrictEqual(ui.qualityPrefForTarget('720p60'), ['720p60', '720p']);
    assert.deepStrictEqual(ui.qualityPrefForTarget('bogus'), ui.PREF);
    assert.strictEqual(new Set(ui.QUALITY_LADDER.map((t) => ui.qualityPrefForTarget(t).join())).size, ui.QUALITY_LADDER.length, 'each target maps back to itself in the select');
    assert.deepStrictEqual(ui.normalizeQualityPref(null), ui.PREF);
    assert.deepStrictEqual(ui.normalizeQualityPref('1080p60'), ui.PREF);
    assert.deepStrictEqual(ui.normalizeQualityPref([]), ui.PREF);
    assert.deepStrictEqual(ui.normalizeQualityPref([1, '<img onerror=x>', '1080p60', '1080p60', '936p60']), ['1080p60', '936p60']);
    assert.strictEqual(ui.normalizeQualityPref(Array(20).fill(0).map((_, i) => `${1000 + i}p`)).length, 12);
});

test('UI auto quality: "already fine" rule and menu option picking', () => {
    for (const height of [1080, 1440, 2160]) assert.strictEqual(ui.isAtPreferredQuality(height, ui.PREF), true, `default ${height}`);
    for (const height of [0, 720, 936]) assert.strictEqual(ui.isAtPreferredQuality(height, ui.PREF), false, `default ${height}`);
    assert.strictEqual(ui.isAtPreferredQuality(1440, ['1080p60', '1080p']), false, 'lower target caps the height');
    assert.strictEqual(ui.isAtPreferredQuality(720, ['720p60', '720p']), true);
    assert.strictEqual(ui.isAtPreferredQuality(1080, ['720p60', '720p']), false);
    assert.strictEqual(ui.isAtPreferredQuality(1080, []), true, 'empty order: old >= 1080p rule');

    const menu = (...texts) => texts.map((text) => ({ text }));
    // Labels as Twitch's quality menu shows them for the fixture's ladder.
    const twitchMenu = menu('Auto', '1080p60 (Source)', '720p60', '720p', '480p', '360p', '160p', 'Audio Only');
    assert.strictEqual(ui.pickQualityOption(twitchMenu, ui.PREF).text, '1080p60 (Source)');
    assert.strictEqual(ui.pickQualityOption(twitchMenu, ['720p']).text, '720p', 'exact label before prefix (720p is 30 fps)');
    assert.strictEqual(ui.pickQualityOption(twitchMenu, ['720p60', '720p']).text, '720p60');
    assert.strictEqual(ui.pickQualityOption(menu('Auto', '1080p50 (Source)', '720p50'), ui.PREF).text, '1080p50 (Source)', 'prefix match keeps 50 fps sources');
    assert.strictEqual(ui.pickQualityOption(menu('Auto', '1440p60 (Source)', '1080p60'), ['1080p60', '1080p']).text, '1080p60');
    assert.strictEqual(ui.pickQualityOption(menu('Auto', '720p60 (Source)', '480p'), ui.PREF), null, 'nothing preferred: Twitch choice kept');
});

test('UI auto quality: go/no-go (Off, once per page, explicit target change forces one switch)', () => {
    const go = (autoOn, done, readyState, height, pref, force) => ui.shouldSwitchQuality(autoOn, done, readyState, height, pref, force);
    assert.strictEqual(go(true, false, 4, 720, ui.PREF, false), true, 'below the order: switch');
    assert.strictEqual(go(true, false, 4, 1080, ui.PREF, false), false, 'default order, already 1080p: hands off');
    assert.strictEqual(go(false, false, 4, 720, ui.PREF, false), false, 'Quality Off');
    assert.strictEqual(go(false, false, 4, 720, ui.PREF, true), false, 'Quality Off wins over a forced attempt');
    assert.strictEqual(go(true, true, 4, 720, ui.PREF, true), false, 'already tried on this page');
    assert.strictEqual(go(true, false, 1, 720, ui.PREF, true), false, 'no frame yet');
    // 1440p60 stream at 1080p60 (old Target 1080p60), user raises Target to 1440p60.
    assert.strictEqual(go(true, false, 4, 1080, ui.qualityPrefForTarget('1440p60'), false), false);
    assert.strictEqual(go(true, false, 4, 1080, ui.qualityPrefForTarget('1440p60'), true), true, 'explicit change: switch up');
    // The loop really goes through it, with the live Auto setting.
    const loop = uiSrc.slice(uiSrc.indexOf('let busy = false;'));
    assert.match(loop, /const autoOn = isAutoQualityOn\(\);\s*if \(!autoOn\) return;/);
    assert.match(loop, /if \(!shouldSwitchQuality\(autoOn, done, v\.readyState, v\.videoHeight, pref, forceAttempt\)\) return;/);
    assert.match(uiSrc, /if \(isAutoQualityOn\(\) && [^\n]*localStorage\.setItem\('video-quality'/, 'Source preset on load only with Auto on');
});

// getQualityPref / setQualityTarget with a fake localStorage.
function qualityPrefStore(storage) {
    const names = ['QUALITY_LADDER', 'PREF', 'QUALITY_PREF_KEY', 'done', 'armId', 'forceAttempt', 'memQualityPref', 'rearmAutoQuality',
        'qualityHeight', 'is60', 'qualityPrefForTarget', 'normalizeQualityPref', 'getQualityPref', 'setQualityTarget'];
    return new Function('localStorage', `'use strict';
        ${names.map((name) => extract(name, uiSrc)).join('\n')}
        return { getQualityPref, setQualityTarget, state: () => ({ done, armId, forceAttempt, memQualityPref }) };
    `)(storage);
}

test('UI quality target: saved, kept in memory when saving fails, forces one attempt', () => {
    const data = new Map();
    const ok = qualityPrefStore({ getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) });
    assert.deepStrictEqual(ok.getQualityPref(), ui.PREF);
    ok.setQualityTarget('720p60');
    assert.strictEqual(data.get('vaftQualityPref'), '["720p60","720p"]');
    assert.deepStrictEqual(ok.getQualityPref(), ['720p60', '720p']);
    assert.deepStrictEqual(ok.state(), { done: false, armId: 1, forceAttempt: true, memQualityPref: null });
    data.set('vaftQualityPref', '["1080p"]');// Another tab
    assert.deepStrictEqual(ok.getQualityPref(), ['1080p'], 'storage wins when the save worked');

    // Storage full: getItem works but setItem throws -> the new choice must not snap back.
    const full = new Map([['vaftQualityPref', JSON.stringify(ui.PREF)]]);
    const quota = qualityPrefStore({ getItem: (k) => full.get(k) ?? null, setItem: () => { throw new Error('QuotaExceededError'); } });
    quota.setQualityTarget('720p');
    assert.deepStrictEqual(quota.getQualityPref(), ['720p']);
    // Storage blocked entirely.
    const blocked = qualityPrefStore({ getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } });
    assert.deepStrictEqual(blocked.getQualityPref(), ui.PREF);
    blocked.setQualityTarget('1080p60');
    assert.deepStrictEqual(blocked.getQualityPref(), ['1080p60', '1080p']);
    assert(/if \(e\.key === null \|\| e\.key === QUALITY_PREF_KEY\) memQualityPref = null;/.test(uiSrc), 'another tab\'s saved choice replaces the in-memory fallback');
});

test('UI CSS: Twitch ad label/countdown and display ad banner hidden, except on allowlisted channels', () => {
    const css = new Function(`${extract('NO_ALLOW', uiSrc)} ${extract('CSS', uiSrc)} return CSS;`)();
    const rules = css.split('}').filter(Boolean).map((r) => ({ selectors: r.slice(0, r.indexOf('{')).split(/,(?![^(]*\))/), body: r.slice(r.indexOf('{') + 1) }));
    const hiding = rules.filter((r) => r.body === 'display:none!important' && r.selectors.some((x) => x.includes('data-vaft-allow')));
    const selectors = hiding.flatMap((r) => r.selectors);
    assert(selectors.includes('.player-adblock-notice'), 'vaft\'s own notice always hidden');
    const twitchAdUi = selectors.filter((x) => x !== '.player-adblock-notice');
    assert.strictEqual(twitchAdUi.length, 6);
    for (const selector of twitchAdUi) assert(selector.startsWith('html:not([data-vaft-allow]) '), selector);
    // A browser without :has() drops a whole rule that lists it: :has() stays alone in its rule.
    for (const rule of rules) assert(!rule.selectors.some((x) => x.includes(':has(')) || rule.selectors.length === 1, rule.selectors.join(','));
    assert(twitchAdUi.includes('html:not([data-vaft-allow]) div:has(> [data-a-target="video-ad-label"])'));
    // Lower-third display ads shrink the player: its full height is put back (not on allowlisted channels).
    assert(rules.some((r) => r.selectors.length === 1 && r.selectors[0] === 'html:not([data-vaft-allow]) .video-player--stream-display-ad_lower-third' && r.body === 'height:100%!important'));
    // The display ad wrapper only: never the player container it sits in.
    assert(twitchAdUi.includes('html:not([data-vaft-allow]) [data-test-selector="sda-wrapper"]'));
    assert(twitchAdUi.includes('html:not([data-vaft-allow]) .stream-display-ad__wrapper'));
    assert(!twitchAdUi.some((x) => /video-player|video-ref|(^|[\s>])video(?![-\w])/.test(x)), 'nothing that matches the player');
    assert.match(uiSrc, /toggleAttribute\('data-vaft-allow', on\)/);
});

test('UI channel from URL agrees with the core parser', () => {
    assert.strictEqual(uiChannel('/SomeStreamer'), 'somestreamer');
    assert.strictEqual(uiChannel('/somestreamer/videos'), 'somestreamer');
    assert.strictEqual(uiChannel('/popout/SomeStreamer/chat'), 'somestreamer', 'popout chat maps to its channel');
    assert.strictEqual(uiChannel('/moderator/somestreamer'), 'somestreamer');
    assert.strictEqual(uiChannel('/', 'player.twitch.tv', '?channel=SomeStreamer&parent=example.com'), 'somestreamer');
    assert.strictEqual(uiChannel('/', 'player.twitch.tv', '?video=v1&parent=example.com'), null);
    for (const p of ['/', '/directory', '/directory/following', '/videos/2291928374', '/settings/profile', '/search', '/popout/', '/bad-name!', '/subs/somestreamer']) {
        assert.strictEqual(uiChannel(p), null, p);
    }
    for (const p of ['/somestreamer', '/somestreamer/clip/Slug-1', '/directory', '/videos/1', '/settings', '/search', '/drops/inventory', '/u/somestreamer', '/p/en/legal/terms-of-service']) {
        assert.strictEqual(uiChannel(p), pure.parseChannelPage('www.twitch.tv', p, '').channel, p);
    }
    // Same reserved routes on both sides (vaftGetCurrentChannel, toggleVaftAllowlist(), self-check).
    const coreGaps = [...ui.RESERVED_ROUTES].filter((route) => pure.parseChannelPage('www.twitch.tv', `/${route}`, '').channel !== null);
    assert.deepStrictEqual(coreGaps, [], 'routes the UI excludes but core parseChannelPage treats as a channel');
    const coreRoutes = new Function(`return ${/const nonChannelPaths = (\[[^\]]*\]);/.exec(coreSrc)[1]};`)();
    assert.deepStrictEqual(coreRoutes.filter((route) => !ui.RESERVED_ROUTES.has(route)), [], 'routes the core excludes but the UI treats as a channel');
});

test('UI duration format', () => {
    assert.strictEqual(ui.formatDuration(0), '0 s');
    assert.strictEqual(ui.formatDuration(59.4), '59 s');
    assert.strictEqual(ui.formatDuration(90), '2 min');
    assert.strictEqual(ui.formatDuration(3600 + 25 * 60), '1 h 25 min');
    for (const value of [-5, 'x', undefined, null, NaN]) assert.strictEqual(ui.formatDuration(value), '0 s');
});

test('UI strings: French and English define the same keys, same kinds', () => {
    const strings = (fr) => new Function('fr', `${extract('T', uiSrc)} return T;`)(fr);
    const [frT, enT] = [strings(true), strings(false)];
    assert.deepStrictEqual(Object.keys(frT).sort(), Object.keys(enT).sort());
    for (const key of Object.keys(frT)) assert.strictEqual(typeof frT[key], typeof enT[key], key);
    assert.match(frT.refs('0,25 centime', '4,99 €', '2,08 €', '830'), /^Pour le streamer : 1 pub ≈\u00a00,25 centime, 1 sub à 4,99 € ≈\u00a02,08 € \(≈\u00a0830 pubs\)\.$/);
});

test('UI streamer earnings: estimates from the ad stats, in cents under 1 €', () => {
    const spaces = (text) => text.replace(/\s/g, ' ');// fr-FR groups and € use narrow no-break spaces
    assert.deepStrictEqual(ui.EARNINGS.adEuros, [0.001, 0.0025, 0.005], '0.1 to 0.5 cent per ad, 0.25 shown');
    assert.strictEqual(ui.subEarnings(), 2.08, '4.99 € before 20 % VAT, 50 % to the streamer');
    assert.strictEqual(ui.subEarnings(0.7), 2.91, 'Plus Program 70 %');
    assert.strictEqual(ui.estimateAds({ breaks: 3, seconds: 270 }), 9, 'one ad per 30 s of ad');
    assert.strictEqual(ui.estimateAds({ breaks: 3, seconds: 20 }), 3, 'at least one ad per break');
    for (const value of [null, undefined, {}, { breaks: 'x', seconds: -50 }]) assert.strictEqual(ui.estimateAds(value), 0);
    assert.deepStrictEqual([0, 0.0025, 0.015, 0.02, 0.4249, 2.079, 1234.5].map((v) => spaces(ui.formatEuros(v, true))),
        ['0 centime', '0,25 centime', '1,5 centime', '2 centimes', '42 centimes', '2,08 €', '1 234,50 €']);
    assert.deepStrictEqual([0.0025, 0.01, 0.42, 0.996, 2.079].map((v) => ui.formatEuros(v, false)),
        ['0.25 cents', '1 cent', '42 cents', '€1.00', '€2.08']);
    for (const value of [-1, 'x', undefined, NaN]) assert.strictEqual(ui.formatEuros(value, true), '0 centime');
});

// ---------------------------------------------------------------------------------------------
// Page fetch hook (GQL PlaybackAccessToken)

function pageFetchHook(allowlist = []) {
    const sent = [];
    const posted = [];
    const original = (...args) => {
        sent.push(args);
        return Promise.resolve('response');
    };
    const window = { fetch: original };
    const state = new Function('window', 'postTwitchWorkerMessage', 'console', 'allowlist', 'forcedType', `'use strict';
        let GQLDeviceID = null, ClientVersion = null, ClientSession = null, ClientIntegrityHeader = null, AuthorizationHeader = undefined;
        const ForceAccessTokenPlayerType = forcedType;
        const AllowlistedChannels = allowlist;
        ${extract('isChannelAllowlisted')}
        ${extract('isAllowlistedAccessTokenRequest')}
        ${extract('hookFetch')}
        hookFetch();
        return () => ({ GQLDeviceID, ClientVersion, ClientSession, ClientIntegrityHeader, AuthorizationHeader });
    `)(window, (key, value) => posted.push([key, value]), { log() {}, debug() {} }, allowlist, defaults.ForceAccessTokenPlayerType);
    return { fetch: window.fetch, original, realFetch: window.realFetch, sent, posted, state };
}
// Twitch web player token request (persisted query), as sent by the page.
const tokenOperation = (login, playerType, extra = {}) => ({
    operationName: 'PlaybackAccessToken',
    extensions: { persistedQuery: { version: 1, sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9' } },
    variables: { isLive: true, login, isVod: false, vodID: '', playerType, platform: 'web', ...extra },
});
const GQL = 'https://gql.twitch.tv/gql';

test('page fetch hook: live token forced to the popout player type, caller init untouched', async () => {
    const hook = pageFetchHook();
    const body = JSON.stringify(tokenOperation('somestreamer', 'site'));
    const init = { method: 'POST', body, headers: { 'Client-ID': defaults.ClientID, 'X-Device-Id': 'dev1', 'Client-Version': 'v1', 'Client-Session-Id': 's1', 'Client-Integrity': 'v4.public.abc', Authorization: 'OAuth tok' } };
    assert.strictEqual(await hook.fetch(GQL, init), 'response');
    assert.strictEqual(init.body, body, 'caller init not mutated');
    const sentInit = hook.sent[0][1];
    assert.notStrictEqual(sentInit, init);
    assert.strictEqual(JSON.parse(sentInit.body).variables.playerType, 'popout');
    assert.deepStrictEqual({ ...JSON.parse(sentInit.body).variables, playerType: 'site' }, JSON.parse(body).variables, 'only playerType changes');
    assert.strictEqual(sentInit.headers, init.headers);
    assert.deepStrictEqual(hook.posted.map(([key]) => key).sort(), ['UpdateAuthorizationHeader', 'UpdateClientIntegrityHeader', 'UpdateClientSession', 'UpdateClientVersion', 'UpdateDeviceId']);
    assert.deepStrictEqual(hook.state(), { GQLDeviceID: 'dev1', ClientVersion: 'v1', ClientSession: 's1', ClientIntegrityHeader: 'v4.public.abc', AuthorizationHeader: 'OAuth tok' });
    await hook.fetch(GQL, { ...init, headers: new Headers(init.headers) });
    assert.strictEqual(hook.posted.length, 5, 'unchanged headers (Headers object too) are not re-posted to the worker');
    assert.strictEqual(hook.realFetch, hook.original, 'window.realFetch (worker GQL relay) bypasses the hook');
});

test('page fetch hook: batches, picture-by-picture, popout already, other requests', async () => {
    const hook = pageFetchHook();
    const batch = [{ operationName: 'ChannelShell', variables: { login: 'somestreamer' } }, tokenOperation('somestreamer', 'site')];
    await hook.fetch(GQL, { method: 'POST', body: JSON.stringify(batch) });
    assert.deepStrictEqual(JSON.parse(hook.sent[0][1].body), [batch[0], tokenOperation('somestreamer', 'popout')]);
    await hook.fetch(GQL, { method: 'POST', body: JSON.stringify(tokenOperation('somestreamer', 'picture-by-picture')) });
    assert.strictEqual(hook.sent[1][1].body, '', 'picture-by-picture token request blanked');
    const popout = { method: 'POST', body: JSON.stringify(tokenOperation('somestreamer', 'popout')) };
    await hook.fetch(GQL, popout);
    assert.strictEqual(hook.sent[2][1], popout, 'nothing to replace: same init');
    const malformed = { method: 'POST', body: '{"operationName":"PlaybackAccessToken",' };
    await hook.fetch(GQL, malformed);
    assert.strictEqual(hook.sent[3][1], malformed, 'malformed body passed through');
    const other = { method: 'POST', body: JSON.stringify(tokenOperation('somestreamer', 'site')) };
    await hook.fetch('https://example.com/api', other);
    assert.strictEqual(hook.sent[4][1], other, 'non-GQL URL untouched');
    await hook.fetch(new Request(GQL, { method: 'POST', headers: { 'Client-Version': 'v9' }, body: '{}' }));
    assert.strictEqual(hook.state().ClientVersion, 'v9', 'headers read from a Request input');
    await hook.fetch(new URL(GQL), { headers: [['X-Device-Id', 'dev2']] });
    assert.strictEqual(hook.state().GQLDeviceID, 'dev2', 'URL input, HeadersInit array');
});

test('page fetch hook: allowlisted channel keeps Twitch\'s own token request', async () => {
    const hook = pageFetchHook(['somestreamer']);
    const own = { method: 'POST', body: JSON.stringify(tokenOperation('SomeStreamer', 'site')) };
    await hook.fetch(GQL, own);
    assert.strictEqual(hook.sent[0][1], own);
    const pbyp = { method: 'POST', body: JSON.stringify(tokenOperation('somestreamer', 'picture-by-picture')) };
    await hook.fetch(GQL, pbyp);
    assert.strictEqual(hook.sent[1][1], pbyp);
    await hook.fetch(GQL, { method: 'POST', body: JSON.stringify([tokenOperation('somestreamer', 'site'), tokenOperation('otherchannel', 'site')]) });
    assert.deepStrictEqual(JSON.parse(hook.sent[2][1].body).map((op) => op.variables.playerType), ['popout', 'popout'], 'mixed batch: still forced');
});

// ---------------------------------------------------------------------------------------------
// Worker simulation: the real hookWindowWorker() blob in a node:vm "worker" against a fake Twitch.

const CHANNEL = 'somestreamer';
const USHER = `https://usher.ttvnw.net/api/channel/hls/${CHANNEL}.m3u8?acmb=e30%3D&allow_source=true&browser_family=chrome&cdm=wv&fast_bread=true`
    + '&p=4815162&parent_domains=example.com&platform=web&play_session_id=0f1e2d3c4b5a69788796a5b4c3d2e1f0&player_backend=mediaplayer'
    + '&playlist_include_framerate=true&reassignments_supported=true&sig=5f4dcc3b5aa765d61d8327deb882cf99&supported_codecs=av1,h265,h264'
    + `&token=${encodeURIComponent(JSON.stringify({ channel: CHANNEL }))}&transcode_mode=cbr_v1`;
const BLOB_URL = "blob:https://www.twitch.tv/6f1c'0d2e-1b3a-4c5d-9e8f-7a6b5c4d3e2f";

const templateStart = coreSrc.indexOf('const newBlobStr = `');
assert(templateStart !== -1, 'worker blob template (const newBlobStr = `...`) not found in hookWindowWorker()');
const WORKER_TEMPLATE = (() => {
    const open = coreSrc.indexOf('`', templateStart);
    for (let i = coreSrc.indexOf('`', open + 1); i !== -1; i = coreSrc.indexOf('`', i + 1)) {
        if (parses(`(${coreSrc.slice(open, i + 1)})`)) return coreSrc.slice(open, i + 1);
    }
    throw new Error('unterminated worker blob template');
})();
const INJECTED = [...WORKER_TEMPLATE.matchAll(/\$\{(\w+)\.toString\(\)\}/g)].map((m) => m[1]);

// The blob exactly as hookWindowWorker() builds it, from the page-side values in `page`.
function buildWorkerBlob(page) {
    const names = [...INJECTED, ...['normalizeAllowlist'].filter((name) => !INJECTED.includes(name))];
    try {
        return new Function('page', `'use strict';
            ${names.map((name) => extract(name)).join('\n')}
            const { twitchBlobUrl, BackupPlayerTypes, AllowlistedChannels, GQLDeviceID, AuthorizationHeader, ClientIntegrityHeader, ClientVersion, ClientSession } = page;
            return ${WORKER_TEMPLATE};
        `)(page);
    } catch (error) {
        throw new Error(`worker blob template uses a page value check.js does not provide (update buildWorkerBlob): ${error.message}`, { cause: error });
    }
}

// Fake Twitch: usher masters, weaver media playlists, segments and the GQL token endpoint.
const BACKUP_TYPES = ['mobile_feed', 'embed', 'popout', 'autoplay'];
const tagSegments = (playlist, type) => playlist.replaceAll('/v1/segment/', `/v1/segment/${type}-`);
function backupMaster(master, type) {
    const tagged = master.replaceAll('/v1/playlist/', `/v1/playlist/${type}-`);
    // The autoplay (android) token only gets the low renditions: the "360p" fallback.
    return type === 'autoplay' ? keepVariants(tagged, /RESOLUTION=(640x360|284x160)|VIDEO="audio_only"/) : tagged;
}
class FakeTwitch {
    constructor(master = MASTER_AVC) {
        this.master = master;
        this.primary = LIVE;// What the player's own media playlists return now
        this.backupHasAd = { mobile_feed: false, embed: false, popout: false, autoplay: false };
        this.expired = new Set();// Media playlist URLs that now 404
        this.requests = [];// Every URL the worker fetched for real
        this.tokens = [];// PlaybackAccessToken variables relayed through the page
        this.gqlHangs = false;
    }
    async workerFetch(url) {
        url = String(url);
        if (url.startsWith('data:')) return fetch(url);// The blank ad segment
        this.requests.push(url);
        const u = new URL(url);
        const text = (body) => new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
        if (u.hostname === 'usher.ttvnw.net' && u.pathname.startsWith('/vod/')) return text(this.master);
        if (u.hostname === 'usher.ttvnw.net') {
            const type = JSON.parse(u.searchParams.get('token') || '{}').player_type;
            return text(type ? backupMaster(this.master, type) : this.master);
        }
        if (u.hostname.endsWith('.cloudfront.net')) return text(AD);// VOD media playlist (with ad markers)
        if (u.pathname.startsWith('/v1/playlist/')) {
            if (this.expired.has(url)) return new Response('', { status: 404 });
            const type = /^\/v1\/playlist\/(mobile_feed|embed|popout|autoplay)-/.exec(u.pathname)?.[1];
            return text(type ? tagSegments(this.backupHasAd[type] ? AD : LIVE, type) : this.primary);
        }
        if (u.pathname.startsWith('/v1/segment/')) return new Response(new Uint8Array(188), { status: 200, headers: { 'content-type': 'video/mp2t' } });
        return new Response('unexpected', { status: 404 });
    }
    async gqlFetch(url, options) {
        if (this.gqlHangs) return new Promise(() => {});
        const { variables } = JSON.parse(options.body);
        this.tokens.push(variables);
        const token = { value: JSON.stringify({ channel: variables.login, player_type: variables.playerType }), signature: `sig-${variables.playerType}` };
        return new Response(JSON.stringify({ data: { streamPlaybackAccessToken: token } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
}

// The page relay of worker GQL requests (real handleWorkerFetchRequest, window.realFetch = fake GQL).
const pageRelay = (twitch) => new Function('window', `'use strict'; ${extract('handleWorkerFetchRequest')} return handleWorkerFetchRequest;`)({ realFetch: (url, options) => twitch.gqlFetch(url, options) });

function startWorker(twitch, page = {}) {
    const blob = buildWorkerBlob({
        twitchBlobUrl: BLOB_URL, BackupPlayerTypes: defaults.BackupPlayerTypes.slice(), AllowlistedChannels: [],
        GQLDeviceID: 'dev1', AuthorizationHeader: undefined, ClientIntegrityHeader: null, ClientVersion: 'v1', ClientSession: null, ...page,
    });
    const relay = pageRelay(twitch);
    const worker = { posted: [], logs: [], xhr: [], listeners: [] };
    const log = (...args) => worker.logs.push(args.join(' '));
    const sandbox = {
        console: { log, info: log, warn: log, error: log, debug() {} },
        URL, URLSearchParams, Response, Headers,
        setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
        clearTimeout,
        XMLHttpRequest: class {
            open(method, url) { worker.xhr.push(url); }
            overrideMimeType() {}
            send() { this.responseText = 'self.twitchWorkerCodeRan = true;'; }// Stands in for Twitch's own worker code
        },
        addEventListener: (type, fn) => { if (type === 'message') worker.listeners.push(fn); },
        postMessage: (data) => {
            worker.posted.push(data);
            if (data.key === 'FetchRequest') relay(data.value).then((value) => worker.send('FetchResponse', value));
        },
        fetch: (url, options) => twitch.workerFetch(url, options),
    };
    worker.send = (key, value) => worker.listeners.forEach((fn) => fn({ data: { key, value } }));
    vm.createContext(sandbox);
    vm.runInContext('globalThis.self = globalThis;', sandbox);
    vm.runInContext(blob, sandbox, { filename: 'vaft-worker-blob.js' });
    worker.global = sandbox;
    worker.get = async (url) => {
        const response = await sandbox.fetch(url);
        return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
    };
    worker.messages = (key) => worker.posted.filter((m) => m.key === key);
    worker.banner = () => worker.messages('UpdateAdBlockBanner').at(-1);
    worker.streamInfo = () => sandbox.StreamInfos[CHANNEL];
    return worker;
}

test('worker blob: built from the real template, Twitch worker code still runs', () => {
    for (const name of ['parseAttributes', 'videoCodecFamily', 'getFirstM3u8Url', 'getStreamUrlForResolution', 'stripAdSegments', 'processM3U8', 'hookWorkerFetch', 'isChannelAllowlisted']) {
        assert(INJECTED.includes(name), `${name} not injected into the worker blob`);
    }
    const w = startWorker(new FakeTwitch(), { AllowlistedChannels: ['SomeStreamer', "x'];alert(1)//"] });
    assert.strictEqual(w.global.twitchWorkerCodeRan, true);
    assert.deepStrictEqual(w.xhr, [BLOB_URL.replaceAll("'", '%27')]);
    assert.deepStrictEqual(plain(w.global.AllowlistedChannels), ['somestreamer'], 'allowlist normalised before injection');
    assert.deepStrictEqual(plain(w.global.BackupPlayerTypes), defaults.BackupPlayerTypes);
    assert.strictEqual(w.global.GQLDeviceID, 'dev1');
    assert.strictEqual(w.global.ClientVersion, 'v1');
    assert(w.logs.includes('hookWorkerFetch (vaft)'));
});

test('worker: master parsed, midroll replaced by the clean mobile_feed backup (asked as android), then playback resumed', async () => {
    const twitch = new FakeTwitch();
    const w = startWorker(twitch);
    const master = await w.get(USHER);
    assert.strictEqual(master.text, MASTER_AVC);
    const usher = new URL(twitch.requests[0]);
    assert(!usher.searchParams.has('parent_domains'), 'parent_domains dropped (forced popout token)');
    assert.strictEqual(usher.searchParams.get('allow_source'), 'true');
    const info = w.streamInfo();
    assert.deepStrictEqual(plain(info.ResolutionList.map((r) => [r.Resolution, r.FrameRate])),
        [['1920x1080', 60], ['1280x720', 60], ['1280x720', 30], ['852x480', 30], ['640x360', 30], ['284x160', 30]]);
    assert.strictEqual(info.ModifiedM3U8, null, 'AVC-only master: no HEVC swap');

    const player = urlAfter(MASTER_AVC, 'VIDEO="chunked"');
    assert.strictEqual((await w.get(player)).text, LIVE);
    assert.strictEqual(w.banner().hasAds, false);
    assert.strictEqual(w.banner().runtimeStatus.channel, CHANNEL);

    info.LastPlayerReload = 0;// Out of the post-reload "minimal requests" window
    twitch.primary = AD;
    let playlist = await w.get(player);
    assert.strictEqual(playlist.text, tagSegments(LIVE, 'mobile_feed'), 'ad playlist replaced by the mobile_feed backup');
    assert.deepStrictEqual(plain(twitch.tokens), [{ isLive: true, login: CHANNEL, isVod: false, vodID: '', playerType: 'mobile_feed', platform: 'android' }]);
    const backupUsher = new URL(twitch.requests.find((url) => url.includes('sig=sig-mobile_feed')));
    assert.strictEqual(backupUsher.pathname, `/api/channel/hls/${CHANNEL}.m3u8`);
    assert.strictEqual(JSON.parse(backupUsher.searchParams.get('token')).player_type, 'mobile_feed');
    assert(!backupUsher.searchParams.has('parent_domains') && backupUsher.searchParams.get('allow_source') === 'true', 'usher params reused');
    assert(twitch.requests.includes(urlAfter(backupMaster(MASTER_AVC, 'mobile_feed'), 'VIDEO="chunked"')), 'same rendition from the backup');
    assert.deepStrictEqual(plain(w.banner()), {
        key: 'UpdateAdBlockBanner', isMidroll: true, hasAds: true, isStrippingAdSegments: false, numStrippedAdSegments: 0,
        runtimeStatus: { channel: CHANNEL, showingAd: true, strippingSegments: false, backupPlayerType: 'mobile_feed', lastPlayerReload: info.LastPlayerReload, numStrippedAdSegments: 0, isMidroll: true, allowlisted: false },
        watchingAd: false,
    });
    assert(!AD_SEGMENTS.some((url) => twitch.requests.includes(url)), 'midroll: ad segments not requested');
    assert(!w.logs.some((line) => line.includes('Ads will leak')));

    playlist = await w.get(player);
    assert.strictEqual(playlist.text, tagSegments(LIVE, 'mobile_feed'));
    assert.strictEqual(twitch.tokens.length, 1, 'backup master cached during the break');

    twitch.primary = LIVE;
    assert.strictEqual((await w.get(player)).text, LIVE);
    assert.strictEqual(w.messages('PauseResumePlayer').length, 1);
    assert.strictEqual(w.messages('ReloadPlayer').length, 0);
    assert.strictEqual(w.banner().hasAds, false);
    assert.strictEqual(w.banner().runtimeStatus.backupPlayerType, null);
});

test('worker: mobile_feed with the ad -> next backup (embed, asked as web), no strip', async () => {
    const twitch = new FakeTwitch();
    twitch.backupHasAd.mobile_feed = true;
    const w = startWorker(twitch);
    await w.get(USHER);
    w.streamInfo().LastPlayerReload = 0;
    twitch.primary = AD;
    const playlist = await w.get(urlAfter(MASTER_AVC, 'VIDEO="chunked"'));
    assert.strictEqual(playlist.text, tagSegments(LIVE, 'embed'));
    assert.deepStrictEqual(plain(twitch.tokens.map((t) => [t.playerType, t.platform])), [['mobile_feed', 'android'], ['embed', 'web']]);
    assert.strictEqual(w.banner().runtimeStatus.backupPlayerType, 'embed');
    assert.strictEqual(w.banner().isStrippingAdSegments, false);
});

test('worker: master with RESOLUTION listed first still gets ads replaced', async () => {
    const twitch = new FakeTwitch(resolutionFirst(MASTER_AVC));
    const w = startWorker(twitch);
    await w.get(USHER);
    assert.strictEqual(w.streamInfo().ResolutionList.length, 6);
    w.streamInfo().LastPlayerReload = 0;
    twitch.primary = AD;
    assert.strictEqual((await w.get(urlAfter(twitch.master, 'VIDEO="720p60"'))).text, tagSegments(LIVE, 'mobile_feed'));
    assert(twitch.requests.includes(urlAfter(backupMaster(twitch.master, 'mobile_feed'), 'VIDEO="720p60"')));
    assert(!w.logs.some((line) => line.includes('Ads will leak')));
});

test('worker: preroll requests one ad segment, RequestedAds stays bounded', async () => {
    const twitch = new FakeTwitch();
    const w = startWorker(twitch);
    await w.get(USHER);
    const info = w.streamInfo();
    info.LastPlayerReload = 0;
    for (let i = 0; i < 100; i++) info.RequestedAds.add(`https://old.example/${i}.ts`);
    twitch.primary = PREROLL;
    await w.get(urlAfter(MASTER_AVC, 'VIDEO="chunked"'));
    assert.deepStrictEqual(AD_SEGMENTS.filter((url) => twitch.requests.includes(url)), [AD_SEGMENTS[0]]);
    assert.strictEqual(info.RequestedAds.size, 100);
    assert(info.RequestedAds.has(AD_SEGMENTS[0]) && !info.RequestedAds.has('https://old.example/0.ts'), 'oldest entry evicted');
    assert.strictEqual(w.banner().isMidroll, false);
});

test('worker: every Source backup with the ad -> 360p autoplay (default), stripped embed fallback (Source mode)', async () => {
    const twitch = new FakeTwitch();
    twitch.backupHasAd.mobile_feed = twitch.backupHasAd.embed = twitch.backupHasAd.popout = true;
    const w = startWorker(twitch);
    await w.get(USHER);
    w.streamInfo().LastPlayerReload = 0;
    twitch.primary = AD;
    const player = urlAfter(MASTER_AVC, 'VIDEO="chunked"');
    assert.strictEqual((await w.get(player)).text, tagSegments(LIVE, 'autoplay'));
    assert.deepStrictEqual(plain(twitch.tokens.map((t) => [t.playerType, t.platform])), [['mobile_feed', 'android'], ['embed', 'web'], ['popout', 'web'], ['autoplay', 'android']]);
    assert(twitch.requests.includes(urlAfter(backupMaster(MASTER_AVC, 'autoplay'), 'VIDEO="360p30"')), '1080p60 -> closest autoplay rendition (360p)');
    assert.strictEqual(w.banner().runtimeStatus.backupPlayerType, 'autoplay');

    // What setAdBackupMode('source') sends to the workers.
    w.send('UpdateBackupPlayerTypes', pure.backupPlayerTypesForMode('source', defaults.BackupPlayerTypes));
    const playlist = await w.get(player);
    assert.deepStrictEqual(plain(twitch.tokens.slice(4).map((t) => t.playerType)), ['mobile_feed', 'embed', 'popout'], 'no 360p request in Source mode');
    const embedAd = tagSegments(AD, 'embed');
    const embedAdSegments = tagSegments(AD_SEGMENTS.join('\n'), 'embed').split('\n');
    assert.deepStrictEqual(segmentsOf(playlist.text), segmentsOf(embedAd), 'fallback embed playlist kept, ad stripped');
    assert.deepStrictEqual(prefetchOf(playlist.text), []);
    assert(playlist.text.includes('X-TV-TWITCH-AD-URL="https://twitch.tv"'));
    assert.strictEqual(w.banner().runtimeStatus.backupPlayerType, 'embed');
    assert.strictEqual(w.banner().isStrippingAdSegments, true);
    assert.strictEqual(w.banner().numStrippedAdSegments, AD_SEGMENTS.length);
    assert.strictEqual(w.banner().watchingAd, false, 'blocked (stripped) ad: not counted as watched');
    const blank = await w.get(embedAdSegments[0]);
    assert.strictEqual(blank.type, 'video/mp4', 'stripped ad segment served as a blank mp4');
    assert(!twitch.requests.includes(embedAdSegments[0]));
    assert.strictEqual((await w.get(tagSegments(LIVE_SEGMENTS_IN_AD[0], 'embed'))).type, 'video/mp2t', 'live segments fetched normally');

    twitch.primary = LIVE;
    assert.strictEqual((await w.get(player)).text, LIVE);
    assert.strictEqual(w.messages('ReloadPlayer').length, 1, 'stripping was on: reload instead of pause/play');
});

test('worker: right after a player (re)load the first backup is used even with the ad (minimal requests)', async () => {
    const twitch = new FakeTwitch();
    twitch.backupHasAd.mobile_feed = true;
    const w = startWorker(twitch);
    await w.get(USHER);
    twitch.primary = PREROLL;
    const playlist = await w.get(urlAfter(MASTER_AVC, 'VIDEO="chunked"'));
    assert.deepStrictEqual(plain(twitch.tokens.map((t) => t.playerType)), ['mobile_feed']);
    assert.deepStrictEqual(segmentsOf(playlist.text), segmentsOf(tagSegments(AD, 'mobile_feed')));
    assert.strictEqual(w.banner().isStrippingAdSegments, true);
});

test('worker: allowlisted channel keeps usher params and ads; allowlist changes apply live', async () => {
    const twitch = new FakeTwitch();
    const w = startWorker(twitch, { AllowlistedChannels: ['somestreamer'] });
    await w.get(USHER);
    assert.strictEqual(new URL(twitch.requests[0]).searchParams.get('parent_domains'), 'example.com');
    w.streamInfo().LastPlayerReload = 0;
    twitch.primary = AD;
    const player = urlAfter(MASTER_AVC, 'VIDEO="chunked"');
    assert.strictEqual((await w.get(player)).text, AD, 'ad left untouched');
    assert.strictEqual(w.messages('FetchRequest').length, 0);
    assert.strictEqual(w.banner().hasAds, false);
    assert.strictEqual(w.banner().runtimeStatus.allowlisted, true);
    assert.strictEqual(w.banner().watchingAd, true, 'ad watched: reported for the support stats');
    twitch.primary = LIVE;
    await w.get(player);
    assert.strictEqual(w.banner().watchingAd, false, 'ad over');
    twitch.primary = AD;

    w.send('UpdateAllowlist', []);
    assert.strictEqual((await w.get(player)).text, tagSegments(LIVE, 'mobile_feed'), 'removed from the allowlist: blocked again');
    w.send('UpdateAllowlist', ['somestreamer']);
    assert.strictEqual((await w.get(player)).text, AD, 'allowlisted mid-ad: the rest of the ad plays');
    assert.strictEqual(w.messages('PauseResumePlayer').length, 1, 'ends like a normal ad end');
    assert.strictEqual(w.banner().hasAds, false);
});

test('worker: allowlist change drops the cached master of that channel (new token on the next usher fetch)', async () => {
    const twitch = new FakeTwitch();
    const w = startWorker(twitch);
    const popoutMaster = MASTER_AVC;
    await w.get(USHER);// Forced popout token
    const other = USHER.replace(`/hls/${CHANNEL}.m3u8`, '/hls/otherchannel.m3u8');
    twitch.master = MASTER_AVC.replaceAll('/v1/playlist/', '/v1/playlist/other-');
    await w.get(other);
    const cached = w.streamInfo();
    w.send('UpdateAllowlist', [CHANNEL]);
    assert.strictEqual(cached.EncodingsM3U8, null, 'allowlisted: cached popout master dropped');
    assert.strictEqual(w.global.StreamInfos.otherchannel.EncodingsM3U8, twitch.master, 'other channels untouched');
    // Player reload with Twitch's own token: its master is served (not the cached popout one), parent_domains kept.
    const siteMaster = MASTER_AVC.replaceAll('/v1/playlist/', '/v1/playlist/site-');
    twitch.master = siteMaster;
    assert.strictEqual((await w.get(USHER)).text, siteMaster);
    assert.strictEqual(new URL(twitch.requests.at(-1)).searchParams.get('parent_domains'), 'example.com');
    assert.notStrictEqual(w.streamInfo(), cached);
    w.send('UpdateAllowlist', [CHANNEL, 'someoneelse']);
    assert.strictEqual(w.streamInfo().EncodingsM3U8, siteMaster, 'unchanged for this channel: kept');
    // Removed again: back to a popout master without parent_domains.
    w.send('UpdateAllowlist', []);
    assert.strictEqual(w.streamInfo().EncodingsM3U8, null);
    twitch.master = popoutMaster;
    assert.strictEqual((await w.get(USHER)).text, popoutMaster);
    assert(!new URL(twitch.requests.at(-1)).searchParams.has('parent_domains'));
    assert(!w.streamInfo().UsherParams.includes('parent_domains'), 'backup usher requests will not carry it either');
});

test('worker: VOD playlists pass through untouched', async () => {
    const twitch = new FakeTwitch();
    const w = startWorker(twitch);
    const vodMaster = 'https://usher.ttvnw.net/vod/2291928374.m3u8?allow_source=true&sig=abc&token=%7B%7D';
    assert.strictEqual((await w.get(vodMaster)).text, MASTER_AVC);
    const vod = 'https://d2nvs31859zcd8.cloudfront.net/0f3c9e1d2b_somestreamer_318273645091_1792749537/chunked/index-dvr.m3u8';
    assert.strictEqual((await w.get(vod)).text, AD, 'ad markers in a VOD playlist are not acted on');
    assert.strictEqual(Object.keys(w.global.StreamInfos).length, 0);
    assert.deepStrictEqual(w.posted, []);
});

test('worker: player reload reuses the master while its playlists live, rebuilds it after', async () => {
    const twitch = new FakeTwitch();
    const w = startWorker(twitch);
    await w.get(USHER);
    const first = w.streamInfo();
    twitch.master = MASTER_AVC.replace('SERVER-TIME="1792758380.42"', 'SERVER-TIME="1792758399.99"').replaceAll('/v1/playlist/', '/v1/playlist/r2');
    const reloaded = await w.get(USHER);
    assert.strictEqual(reloaded.text, MASTER_AVC.replace('SERVER-TIME="1792758380.42"', 'SERVER-TIME="1792758399.99"'), 'old playlists, new server time');
    assert.strictEqual(w.streamInfo(), first);
    twitch.expired.add(variantsOf(MASTER_AVC)[0].url);
    assert.strictEqual((await w.get(USHER)).text, twitch.master);
    assert.notStrictEqual(w.streamInfo(), first);
    assert.strictEqual(w.global.StreamInfosByUrl[urlAfter(twitch.master, 'VIDEO="chunked"')], w.streamInfo());
});

test('worker: odd masters do not break playback (HEVC variant without RESOLUTION, usher path without .m3u8)', async () => {
    // HEVC line without RESOLUTION: used to throw on oldResolution.split and fail the master fetch.
    const noRes = MASTER_ENHANCED.replace(/RESOLUTION=\d+x\d+,(CODECS="hev1)/, '$1');
    assert.notStrictEqual(noRes, MASTER_ENHANCED, 'fixture edit applied');
    let w = startWorker(new FakeTwitch(noRes));
    let master = await w.get(USHER);
    assert.strictEqual(master.status, 200);
    assert.strictEqual(master.text, noRes);
    // Usher path without the .m3u8 extension: used to throw on match(...)[0].
    w = startWorker(new FakeTwitch());
    master = await w.get(USHER.replace(`${CHANNEL}.m3u8`, CHANNEL));
    assert.strictEqual(master.status, 200);
    assert.strictEqual(master.text, MASTER_AVC);
    assert.strictEqual(w.global.StreamInfos[CHANNEL].ChannelName, CHANNEL);
});

test('worker: HEVC source -> AVC-only master during the ad, original master after', async () => {
    const twitch = new FakeTwitch(MASTER_ENHANCED);
    const w = startWorker(twitch);
    await w.get(USHER);
    const info = w.streamInfo();
    const avc1080 = urlAfter(MASTER_ENHANCED, 'VIDEO="1080p60_h264"');
    const modified = variantsOf(info.ModifiedM3U8);
    assert(modified.every((v) => /CODECS="avc1|CODECS="mp4a/.test(v.inf)), 'no HEVC/AV1 left in the modified master');
    assert.deepStrictEqual(modified.slice(0, 2).map((v) => v.url.trimEnd()), [avc1080, avc1080], 'HEVC 1440p and AV1 1080p -> AVC 1080p60');
    assert.notStrictEqual(modified[0].url, modified[1].url, 'swapped URLs kept unique (trailing spaces)');

    info.LastPlayerReload = 0;
    twitch.primary = AD;
    const playlist = await w.get(urlAfter(MASTER_ENHANCED, 'VIDEO="chunked"'));
    assert.strictEqual(w.messages('ReloadPlayer').length, 1, 'player reloaded onto the AVC master');
    assert(twitch.requests.includes(urlAfter(backupMaster(MASTER_ENHANCED, 'mobile_feed'), 'VIDEO="chunked"')), 'same codec family from the backup');
    assert.deepStrictEqual(segmentsOf(playlist.text), segmentsOf(tagSegments(LIVE, 'mobile_feed')));
    assert.strictEqual(w.banner().numStrippedAdSegments, segmentsOf(LIVE).length, 'every segment blanked until the reload');

    const duringAd = await w.get(USHER);
    assert.strictEqual(duringAd.text, info.ModifiedM3U8);
    const swapped = await w.get(modified[0].url);// The player requests the line as listed
    assert.strictEqual(swapped.text, tagSegments(LIVE, 'mobile_feed'));
    assert(twitch.requests.includes(urlAfter(backupMaster(MASTER_ENHANCED, 'mobile_feed'), 'VIDEO="1080p60_h264"')));

    twitch.primary = LIVE;
    assert.strictEqual((await w.get(modified[0].url)).text, LIVE);
    assert.strictEqual(w.messages('ReloadPlayer').length, 2, 'reload back to the original master');
    assert.strictEqual((await w.get(USHER)).text, MASTER_ENHANCED);
});

test('worker: GQL relay timeout cannot hang the playlist (WorkerFetchTimeoutMs)', async () => {
    const twitch = new FakeTwitch();
    twitch.gqlHangs = true;
    const w = startWorker(twitch);
    w.global.WorkerFetchTimeoutMs = 20;
    await w.get(USHER);
    w.streamInfo().LastPlayerReload = 0;
    twitch.primary = AD;
    const started = Date.now();
    const playlist = await w.get(urlAfter(MASTER_AVC, 'VIDEO="chunked"'));
    assert(Date.now() - started < 2000, 'resolved after the timeouts');
    assert.strictEqual(w.messages('FetchRequest').length, BACKUP_TYPES.length);
    assert.deepStrictEqual(segmentsOf(playlist.text), segmentsOf(AD), 'no backup: own playlist, ad stripped');
    assert.deepStrictEqual(prefetchOf(playlist.text), []);
    assert.strictEqual(w.banner().isStrippingAdSegments, true);
});

// ---------------------------------------------------------------------------------------------
// Structural checks (what node cannot run: page/worker scope boundaries, DOM APIs)

// Drops // comments (line or trailing); keeps https:// and base64 "//" inside strings.
const stripComments = (code) => code.replace(/(^|[\s;,{}()])\/\/.*$/gm, '$1');

test('worker-injected functions only call injected code and worker globals', () => {
    const coreFunctions = [...coreSrc.matchAll(/^ {4}(?:async )?function (\w+)\(/gm)].map((m) => m[1]);
    const pageState = [...coreSrc.matchAll(/^ {4}(?:const|let) (\w+)/gm)].map((m) => m[1]);
    const templateNames = [...WORKER_TEMPLATE.matchAll(/\b(?:const|let|var|function)\s+(\w+)/g)].map((m) => m[1]);
    for (const name of INJECTED) {
        const body = stripComments(extract(name));
        for (const other of [...coreFunctions, ...pageState]) {
            if (other !== name && !INJECTED.includes(other) && !templateNames.includes(other)) {
                assert(!new RegExp(`(?<![\\w.$])${other}\\b`).test(body), `${name} (worker) uses page-only ${other}`);
            }
        }
        for (const pageGlobal of ['window', 'document', 'localStorage', 'sessionStorage']) {
            assert(!new RegExp(`(?<![\\w.$])${pageGlobal}\\b`).test(body), `${name} (worker) uses ${pageGlobal}`);
        }
    }
});

test('UI builds its DOM without HTML strings; the core\'s only innerHTML is a static literal', () => {
    assert(!/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(stripComments(uiSrc)), 'UI must use createElement/textContent');
    const assignments = [...stripComments(coreSrc).matchAll(/\.innerHTML\s*=\s*(.*)$/gm)];
    assert(assignments.length <= 1, 'new innerHTML assignment in the core');
    for (const m of assignments) {
        // One quoted literal and nothing else: no concatenation, no template interpolation.
        assert.match(m[1].trim(), /^(['"])(?:(?!\1)[^\\])*\1;$/, `innerHTML must be a constant string: ${m[1].slice(0, 60)}`);
    }
});

test('background-tab guards use the native hidden check (document.hidden is spoofed)', () => {
    assert(!/\bdocument\.(hidden|webkitHidden|mozHidden|visibilityState)\b/.test(stripComments(src)), 'document.hidden read directly');
    assert(uiSrc.includes('window.vaftIsDocumentHidden'), 'UI loops must skip work through window.vaftIsDocumentHidden()');
});

test('auto quality makes one attempt per page (no settings-menu retry loop)', () => {
    assert(!/done\s*=\s*await\s+setQuality\(/.test(uiSrc));
});

test('persisted localStorage keys are still read and written (renaming one resets every user\'s setting)', () => {
    for (const key of ['adBackupMode', 'vaftAutoQuality', 'vaftAllowlist', 'vaftAdStats', 'vaftQualityPref']) {
        const aliases = [...src.matchAll(new RegExp(`const (\\w+) = '${key}';`, 'g'))].map((m) => m[1]);
        const ref = `(?:${[`'${key}'`, ...aliases].join('|')})`;
        assert.match(src, new RegExp(`localStorage\\.getItem\\(${ref}\\)`), `localStorage key ${key} no longer read`);
        assert.match(src, new RegExp(`localStorage\\.setItem\\(${ref},`), `localStorage key ${key} no longer written`);
    }
});

// ---------------------------------------------------------------------------------------------

let finished = false;
process.on('unhandledRejection', (error) => {
    console.error('FAIL unhandled rejection\n', error);
    process.exitCode = 1;
});
// The fake worker's timers are unref()'d: without this a stuck await would end the process silently.
process.on('exit', () => {
    if (!finished) {
        console.error('FAIL checks did not run to the end');
        process.exitCode = 1;
    }
});
const watchdog = setTimeout(() => {
    console.error('FAIL checks still running after 30 s');
    process.exit(1);
}, 30000);
(async () => {
    const failures = [];
    for (const { name, fn } of tests) {
        let timer;
        try {
            await Promise.race([fn(), new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('timed out after 5 s')), 5000);
            })]);
        } catch (error) {
            failures.push(name);
            console.error(`FAIL ${name}\n  ${String(error && error.stack || error).replaceAll('\n', '\n  ')}`);
        } finally {
            clearTimeout(timer);
        }
    }
    finished = true;
    clearTimeout(watchdog);
    if (failures.length) {
        console.error(`\n${failures.length} of ${tests.length} checks failed`);
        process.exitCode = 1;
        return;
    }
    console.log('OK');
})();
