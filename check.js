const assert = require('assert');
const src = require('fs').readFileSync(__dirname + '/twitch-adblock.user.js', 'utf8');

function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
}

const scope = new Function(`
    let V2API = false, AdSignifier = 'stitched', AllSegmentsAreAdSegments = false;
    const AdSegmentCache = new Map();
    ${extract('stripAdSegments')}
    ${extract('getServerTimeFromM3u8')}
    return { stripAdSegments, getServerTimeFromM3u8, AdSegmentCache, setV2: v => V2API = v };
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

console.log('OK');
