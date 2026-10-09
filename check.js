const assert = require('assert');
const src = require('fs').readFileSync(__dirname + '/twitch-adblock.user.js', 'utf8');

function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    assert(start !== -1, `missing function ${name}`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const scope = new Function(`
    let V2API = false, AdSignifier = 'stitched', AllSegmentsAreAdSegments = false;
    const AdSegmentCache = new Map();
    ${extract('stripAdSegments')}
    ${extract('getServerTimeFromM3u8')}
    ${extract('getFirstM3u8Url')}
    return { stripAdSegments, getServerTimeFromM3u8, getFirstM3u8Url, AdSegmentCache, setV2: v => V2API = v };
`)();

const playlist = [
    '#EXT-X-DATERANGE:ID="stitched-ad",X-TV-TWITCH-AD-URL="https://ads.example/x",X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://track.example/y"',
    '#EXT-X-TWITCH-PREFETCH:https://prefetch.example/p.ts',
    '#EXTINF:2.000,Amazon',
    'https://seg.example/ad.ts',
    '#EXTINF:2.000,live',
    'https://seg.example/live.ts',
].join('\n');
const info = { NumStrippedAdSegments: 0 };
const out = scope.stripAdSegments(playlist, false, info);
assert(out.includes('X-TV-TWITCH-AD-URL="https://twitch.tv"'));
assert(out.includes('X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://twitch.tv"'));
assert(!out.includes('ads.example') && !out.includes('track.example'));
assert(!out.includes('#EXT-X-TWITCH-PREFETCH'));
assert(scope.AdSegmentCache.has('https://seg.example/ad.ts'));
assert(!scope.AdSegmentCache.has('https://seg.example/live.ts'));
assert.strictEqual(info.NumStrippedAdSegments, 1);
assert.strictEqual(info.IsStrippingAdSegments, true);

assert.strictEqual(scope.getServerTimeFromM3u8('#EXTM3U\n#EXT-X-TWITCH-INFO:SERVER-TIME="1727600000.12"'), '1727600000.12');
assert.strictEqual(scope.getServerTimeFromM3u8('#EXTM3U'), null);
scope.setV2(true);
assert.strictEqual(scope.getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="42.5"'), '42.5');
assert.strictEqual(scope.getServerTimeFromM3u8('#EXTM3U'), null);
scope.setV2(false);

// getFirstM3u8Url: never throws, null when no URL present (the old .match()[0] crash).
assert.strictEqual(scope.getFirstM3u8Url('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://example.com/a.m3u8'), 'https://example.com/a.m3u8');
assert.strictEqual(scope.getFirstM3u8Url('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nno-url-here'), null);
assert.strictEqual(scope.getFirstM3u8Url('#EXTM3U'), null);
assert.strictEqual(scope.getFirstM3u8Url(null), null);
assert.strictEqual(scope.getFirstM3u8Url(undefined), null);

// Freshness check must use the safe helper (in worker and page scope).
assert(!src.includes('EncodingsM3U8.match(/^https:.*\\.m3u8$/m)[0]'), 'unsafe .match()[0] still present');
assert(src.includes('getFirstM3u8Url(streamInfo.EncodingsM3U8)'), 'safe freshness check missing');
assert(src.includes('${getFirstM3u8Url.toString()}') || src.includes('getFirstM3u8Url.toString()'), 'helper not injected into worker blob');

// adBackupMode default: anything but 'source' keeps autoplay (360p fallback).
function applyAdBackupModeLogic(mode, all) {
    return mode === 'source' ? all.filter((x) => x !== 'autoplay') : all;
}
const allTypes = ['embed', 'popout', 'autoplay'];
assert.deepStrictEqual(applyAdBackupModeLogic(null, allTypes), allTypes);
assert.deepStrictEqual(applyAdBackupModeLogic(undefined, allTypes), allTypes);
assert.deepStrictEqual(applyAdBackupModeLogic('360p', allTypes), allTypes);
assert.deepStrictEqual(applyAdBackupModeLogic('source', allTypes), ['embed', 'popout']);
assert(src.includes("localStorage.getItem('adBackupMode')"), 'adBackupMode persistence missing');

// vaftAutoQuality default ON: only 'off' disables.
function autoQualityDefault(v) { return v === 'off' ? 'off' : 'on'; }
assert.strictEqual(autoQualityDefault(null), 'on');
assert.strictEqual(autoQualityDefault(undefined), 'on');
assert.strictEqual(autoQualityDefault('on'), 'on');
assert.strictEqual(autoQualityDefault('off'), 'off');
assert(src.includes('vaftAutoQuality'), 'vaftAutoQuality key missing');
assert(src.includes('window.setAutoQuality'), 'setAutoQuality missing');
assert(src.includes('window.getAutoQuality'), 'getAutoQuality missing');
assert(src.includes('data-kind="quality"'), 'quality toggle buttons missing');

// Interval guards: no busy loop when tab hidden or auto-quality off.
assert(src.includes('if (document.hidden) return;'), 'document.hidden guard missing');
assert(src.includes("if (!isAutoQualityOn()) return;"), 'auto-quality guard missing in quality loop');

// Version header present and bumped for this change set.
const versionMatch = src.match(/\/\/ @version\s+(\d+\.\d+\.\d+)/);
assert(versionMatch, '@version header missing');
assert(versionMatch[1] === '37.3.0', `expected @version 37.3.0, got ${versionMatch[1]}`);

console.log('OK');
