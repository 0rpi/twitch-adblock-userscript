// ==UserScript==
// @name         Twitch Adblock Userscript
// @namespace    https://github.com/0rpi/twitch-adblock-userscript
// @version      38.0.0
// @description  Blocks Twitch video and banner ads (fork of vaft from pixeltris/TwitchAdSolutions), with a per-channel allowlist to support streamers and auto 1440p60/1080p60 quality (toggleable)
// @author       0rpi, pixeltris, cleanlock, scamorza, Wibias, MisterSheeple, FlaminSarge, InKahootz, Sokoloft, younesaassila, jacob-thompson, glitchybird65, drj101687, saucettv, mikirobles, pwltr, HatterTheMadd, kdjmonaghan, quack79, GODrums
// @license      MIT
// @homepageURL  https://github.com/0rpi/twitch-adblock-userscript
// @supportURL   https://github.com/0rpi/twitch-adblock-userscript/issues
// @updateURL    https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js
// @downloadURL  https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js
// @match        *://www.twitch.tv/*
// @match        *://m.twitch.tv/*
// @match        *://player.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==
(function() {
    'use strict';
    // Versioning note: @version above is the public release number used by
    // Violentmonkey/Tampermonkey for auto-update. Bump it on every user-visible change.
    // ourTwitchAdSolutionsVersion below is an INTERNAL anti-conflict guard (upstream vaft
    // compat): only bump it if the conflict protocol with other vaft copies changes.
    const SCRIPT_VERSION = '38.0.0';// Keep equal to @version (vaftStatus() and self-check warnings)
    const ourTwitchAdSolutionsVersion = 24;// Used to prevent conflicts with outdated versions of the scripts
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("skipping vaft as there's another script active. ourVersion:" + ourTwitchAdSolutionsVersion + " activeVersion:" + window.twitchAdSolutionsVersion);
        window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'mobile_feed',//Source, asked as android (reported ad-free and uncapped by scamorza/TwitchAdBlock)
            'embed',//Source
            'popout',//Source
            'autoplay',//360p, asked as android
            //'picture-by-picture-CACHED'//360p (-CACHED is an internal suffix and is removed)
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = false;// After the ad finishes do a player reload instead of pause/play
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 0;
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 1;// The buffering time left (in seconds) when we should ignore the players playback position in the player state check
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.WorkerFetchTimeoutMs = 15000;
        scope.AllowlistedChannels = [];// Lowercase channel logins whose ads are left untouched (see setVaftAllowlist)
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const nativeHiddenGetter = document.__lookupGetter__('hidden');
    const nativeWebkitHiddenGetter = document.__lookupGetter__('webkitHidden');
    function isDocumentActuallyHidden() {
        try {
            if (nativeHiddenGetter) {
                return nativeHiddenGetter.call(document) === true;
            }
            if (nativeWebkitHiddenGetter) {
                return nativeWebkitHiddenGetter.call(document) === true;
            }
        } catch {}
        return false;
    }
    window.vaftIsDocumentHidden = isDocumentActuallyHidden;
    const twitchWorkers = new Set();

    const vaftRuntimeStatus = {
        channel: null,
        showingAd: false,
        strippingSegments: false,
        backupPlayerType: null,
        lastPlayerReload: null,
        numStrippedAdSegments: 0,
        isMidroll: false,
        allowlisted: false,
        lastUpdate: null
    };
    function updateVaftRuntimeStatus(nextStatus) {
        if (!nextStatus || typeof nextStatus !== 'object') {
            return;
        }
        Object.assign(vaftRuntimeStatus, nextStatus);
        vaftRuntimeStatus.lastUpdate = Date.now();
    }
    // Pure helpers (no DOM/storage access): check.js extracts and tests them as-is.
    function backupPlayerTypesForMode(mode, allTypes) {
        // 'source' drops the 360p 'autoplay' backup; any other value keeps every type.
        return mode === 'source' ? allTypes.filter((x) => x !== 'autoplay') : allTypes;
    }
    function normalizeAutoQualityMode(value) {
        // Auto quality defaults to ON: only an explicit 'off' disables it.
        return value === 'off' ? 'off' : 'on';
    }
    function normalizeAllowlist(value) {
        // Unique lowercase Twitch logins, anything else dropped (also keeps the worker blob injection safe).
        const result = [];
        if (!Array.isArray(value)) {
            return result;
        }
        for (const item of value) {
            const login = typeof item === 'string' ? item.trim().toLowerCase() : '';
            if (/^[a-z0-9_]{1,25}$/.test(login) && !result.includes(login)) {
                result.push(login);
            }
        }
        return result;
    }
    function parseStoredAllowlist(raw) {
        try {
            return normalizeAllowlist(JSON.parse(raw));
        } catch {
            return [];
        }
    }
    function isChannelAllowlisted(channelName, allowlist) {
        // Also injected into the worker: keep self-contained.
        return typeof channelName === 'string' && Array.isArray(allowlist) && allowlist.length > 0 && allowlist.includes(channelName.toLowerCase());
    }
    function normalizeAdStats(value) {
        const breaks = Number(value?.breaks);
        const seconds = Number(value?.seconds);
        const since = Number(value?.since);
        return {
            breaks: Number.isFinite(breaks) && breaks > 0 ? Math.floor(breaks) : 0,
            seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : 0,
            since: Number.isFinite(since) && since > 0 ? since : null
        };
    }
    function addAdStats(stats, breaks, seconds, now) {
        const base = normalizeAdStats(stats);
        return normalizeAdStats({ breaks: base.breaks + breaks, seconds: base.seconds + seconds, since: base.since || now });
    }
    function normalizeWatchedAds(value) {
        // { login: { breaks, seconds, since } }: ads watched on allowlisted channels. Built with
        // Object.fromEntries so no login can reach the prototype.
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        return Object.fromEntries(Object.entries(value)
            .filter(([login]) => /^[a-z0-9_]{1,25}$/.test(login))
            .map(([login, stats]) => [login, normalizeAdStats(stats)])
            .filter(([, stats]) => stats.breaks > 0 || stats.seconds > 0));
    }
    function adBlockMethod(status) {
        // What the viewer saw instead of the ad: a clean copy at full quality, the 360p copy, or the
        // ad cut out of the stream (black screen). null = no backup chosen yet.
        if (status?.strippingSegments === true) {
            return 'strip';
        }
        if (status?.backupPlayerType === 'autoplay') {
            return 'low';
        }
        return typeof status?.backupPlayerType === 'string' && status.backupPlayerType ? 'full' : null;
    }
    function normalizeAdMethods(value) {
        // Seconds of blocked ad per method: { full, low, strip }.
        const result = {};
        for (const key of ['full', 'low', 'strip']) {
            const seconds = Number(value?.[key]);
            result[key] = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : 0;
        }
        return result;
    }
    function normalizeLastAd(value) {
        // Last ad break blocked: { channel, at, seconds, midroll, method }, or null.
        const at = Number(value?.at);
        const seconds = Number(value?.seconds);
        if (typeof value?.channel !== 'string' || !/^[a-z0-9_]{1,25}$/.test(value.channel) || !Number.isFinite(at) || at <= 0) {
            return null;
        }
        return {
            channel: value.channel,
            at,
            seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : 0,
            midroll: value.midroll === true,
            method: ['full', 'low', 'strip'].includes(value.method) ? value.method : null
        };
    }
    function addWatchedAds(watched, channel, breaks, seconds, now) {
        const all = normalizeWatchedAds(watched);
        const previous = Object.prototype.hasOwnProperty.call(all, channel) ? all[channel] : null;
        return normalizeWatchedAds({ ...all, [channel]: addAdStats(previous, breaks, seconds, now) });
    }
    function updateAdBreakTracker(tracker, source, channel, hasAds, backupPlayerType, now) {
        // tracker: Map channel -> { sources: Set, lastAt, backupPlayerType }. Several workers or
        // repeated messages for the same ad count as one break; time accrues from message gaps
        // (capped at 10 s) so a lost "ad finished" message cannot inflate it.
        const result = { newBreak: false, seconds: 0, changed: false };
        if (typeof channel !== 'string' || !channel) {
            return result;
        }
        let entry = tracker.get(channel);
        if (entry && now - entry.lastAt > 60000) {
            tracker.delete(channel);// No update for 60 s (worker gone without terminate()): that break is over
            entry = null;
            result.changed = true;
        }
        if (entry && (hasAds || entry.sources.has(source))) {
            result.seconds = Math.max(0, Math.min(now - entry.lastAt, 10000)) / 1000;
            entry.lastAt = now;
        }
        if (hasAds) {
            if (!entry) {
                entry = { sources: new Set(), lastAt: now, backupPlayerType: null };
                tracker.set(channel, entry);
                result.newBreak = true;
                result.changed = true;
            }
            entry.sources.add(source);
            if (backupPlayerType && entry.backupPlayerType !== backupPlayerType) {
                entry.backupPlayerType = backupPlayerType;
                result.changed = true;
            }
        } else if (entry && entry.sources.delete(source) && entry.sources.size === 0) {
            tracker.delete(channel);
            result.changed = true;
        }
        return result;
    }
    function removeAdBreakSource(tracker, source, now, keepChannel = null) {
        // A terminated worker (or one now reporting keepChannel) ends the breaks only it was reporting.
        const ended = [];
        let seconds = 0;
        tracker.forEach((entry, channel) => {
            if (channel !== keepChannel && entry.sources.delete(source) && entry.sources.size === 0) {
                seconds += Math.max(0, Math.min(now - entry.lastAt, 10000)) / 1000;
                tracker.delete(channel);
                ended.push(channel);
            }
        });
        return { seconds, ended };
    }
    function expireAdBreaks(tracker, now) {
        // Breaks with no worker update for 60 s are over (stream ended mid-ad, playlist 404s, VOD page...).
        const ended = [];
        tracker.forEach((entry, channel) => {
            if (now - entry.lastAt > 60000) {
                tracker.delete(channel);
                ended.push(channel);
            }
        });
        return ended;
    }
    function allowlistReloadNeeded(channel, previous, next, contentType) {
        // The player keeps the token it got (forced popout, or Twitch's own when allowlisted) until it reloads.
        return !!channel && contentType === 'live' && isChannelAllowlisted(channel, previous) !== isChannelAllowlisted(channel, next);
    }
    function parseChannelPage(hostname, pathname, search) {
        // { channel, isLive }: isLive = live channel player page (not VOD, clip, directory, front page...).
        const isLogin = (x) => /^[a-z0-9_]{1,25}$/.test(x);
        if (hostname === 'player.twitch.tv') {
            const params = new URLSearchParams(search || '');
            const channel = (params.get('channel') || '').toLowerCase();
            if (!isLogin(channel)) {
                return { channel: null, isLive: false };
            }
            return { channel, isLive: !params.has('video') && !params.has('clip') && !params.has('collection') };
        }
        const parts = String(pathname || '').split('/').filter(Boolean);
        const first = (parts[0] || '').toLowerCase();
        const nonChannelPaths = ['directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet', 'drops', 'search', 'downloads', 'turbo', 'prime', 'p', 'friends', 'messages', 'payments', 'store', 'jobs', 'signup', 'login', 'logout', 'moderator', 'popout', 'embed', 'u', 'team', 'broadcast', 'following', 'clips', 'event', 'bits', 'activate', 'subs', 'collections', 'redeem', 'giftcard', 'checkout'];
        if (!isLogin(first) || nonChannelPaths.includes(first)) {
            return { channel: null, isLive: false };
        }
        return { channel: first, isLive: parts.length === 1 };
    }
    function vaftHealthProblem(livePlayingMs, workerHooked, liveConfirmed) {
        // livePlayingMs = visible live playback since the last vaft worker message.
        if (livePlayingMs < 30000) {
            return null;
        }
        if (!workerHooked) {
            return 'worker-not-hooked';
        }
        // Only claim "no messages" when the player itself says the content is live.
        return liveConfirmed ? 'no-worker-messages' : null;
    }
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${stripAdSegments.toString()}
                    ${videoCodecFamily.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${getFirstM3u8Url.toString()}
                    ${isChannelAllowlisted.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    BackupPlayerTypes = ${JSON.stringify(BackupPlayerTypes)};
                    AllowlistedChannels = ${JSON.stringify(normalizeAllowlist(AllowlistedChannels))};
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeoutId } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                clearTimeout(timeoutId);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        } else if (e.data.key == 'UpdateBackupPlayerTypes') {
                            BackupPlayerTypes = e.data.value;
                        } else if (e.data.key == 'UpdateAllowlist') {
                            const nextAllowlist = Array.isArray(e.data.value) ? e.data.value : [];
                            // Masters cached with the other token type (popout vs Twitch's own): rebuild on the next usher fetch.
                            for (const channelName in StreamInfos) {
                                if (StreamInfos[channelName] && isChannelAllowlisted(channelName, AllowlistedChannels) !== isChannelAllowlisted(channelName, nextAllowlist)) {
                                    StreamInfos[channelName].EncodingsM3U8 = null;
                                }
                            }
                            AllowlistedChannels = nextAllowlist;
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                `;
                super(URL.createObjectURL(new Blob([newBlobStr])), options);
                twitchWorkers.add(this);
                vaftHealth.workerHooked = true;
                const realTerminate = this.terminate.bind(this);
                this.terminate = () => {
                    twitchWorkers.delete(this);
                    forgetAdStateSource(this);
                    realTerminate();
                };
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        noteVaftWorkerMessage();
                        updateVaftRuntimeStatus(e.data.runtimeStatus);
                        updateAdblockBanner(e.data);
                        trackAdState(this, e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function hookWorkerFetch() {
        console.log('hookWorkerFetch (vaft)');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        const send = function() {
                            return realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                                resolve(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(processAfter)['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    // Usher path is /api/channel/hls/<login>.m3u8; fall back to the last segment if the extension ever goes away.
                    const usherPath = (new URL(url)).pathname;
                    const channelName = (usherPath.match(/([^\/]+)(?=\.\w+$)/) || [])[0] || usherPath.split('/').filter(Boolean).pop() || '';
                    // Allowlisted channels keep Twitch's own token (see hookFetch), so keep its usher params too.
                    if (ForceAccessTokenPlayerType && !isChannelAllowlisted(channelName, AllowlistedChannels)) {
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
                                    const prevM3u8Url = getFirstM3u8Url(streamInfo.EncodingsM3U8);
                                    if (!prevM3u8Url || (await realFetch(prevM3u8Url)).status !== 200) {
                                        streamInfo = null;
                                    }
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: [],
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: [],
                                        ActiveBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0
                                    };
                                    const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'] || '',
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const decodableResolutionList = streamInfo.ResolutionList.filter((element) => videoCodecFamily(element.Codecs) === 'avc');
                                    const hasEnhancedVariant = streamInfo.ResolutionList.some((element) => { const family = videoCodecFamily(element.Codecs); return family === 'hevc' || family === 'av1'; });
                                    if (AlwaysReloadPlayerOnAd || (decodableResolutionList.length > 0 && hasEnhancedVariant && !SkipPlayerReloadOnHevc)) {
                                        if (decodableResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    const codecs = resSettings[codecsKey] || '';
                                                    const codecFamily = videoCodecFamily(codecs);
                                                    // No RESOLUTION (unexpected for a video variant): leave the line as is instead of throwing.
                                                    if ((codecFamily === 'hevc' || codecFamily === 'av1') && typeof resSettings['RESOLUTION'] === 'string') {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = decodableResolutionList.slice().sort((a, b) => {
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            return Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                        })[0];
                                                        console.log('ModifiedM3U8 swap ' + resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + ' newRes:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);
                                                    }
                                                }
                                            }
                                        }
                                        if (decodableResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(processAfter)['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches ? matches[1] : null;
        }
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function getFirstM3u8Url(encodingsM3u8) {
        if (typeof encodingsM3u8 !== 'string') {
            return null;
        }
        const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            try {
                const parsed = new URL(line);
                if (parsed.protocol === 'https:' && parsed.pathname.endsWith('.m3u8')) {
                    return line;
                }
            } catch {}
        }
        return null;
    }
    function videoCodecFamily(codecs) {
        if (typeof codecs !== 'string' || !codecs.trim()) {
            return 'unknown';
        }
        const entries = codecs.toLowerCase().split(',').map((entry) => entry.trim());
        for (const codec of entries) {
            if (codec.startsWith('avc1') || codec.startsWith('avc3')) return 'avc';
            if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'hevc';
            if (codec.startsWith('av01') || codec.startsWith('av0')) return 'av1';
        }
        return 'unknown';
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const newAdUrl = 'https://twitch.tv';
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            line = line
                .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
                .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
            lines[i] = line;
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            }
            if (line.includes(AdSignifier)) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.join('\n');
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo, selectionOut = null) {
        const encodingsLines = encodingsM3u8.replaceAll('\r', '').split('\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        const targetFamily = videoCodecFamily(resolutionInfo.Codecs);
        let bestSameFamily = null;
        let bestSameFamilyScore = Infinity;
        let bestAny = null;
        let bestAnyScore = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (!encodingsLines[i].startsWith('#EXT-X-STREAM-INF') || !encodingsLines[i + 1].includes('.m3u8')) continue;
            const attributes = parseAttributes(encodingsLines[i]);
            const resolution = attributes['RESOLUTION'];
            if (!resolution) continue;
            const frameRate = attributes['FRAME-RATE'];
            const codecs = attributes['CODECS'] || '';
            const family = videoCodecFamily(codecs);
            const [width, height] = resolution.split('x').map(Number);
            const difference = Math.abs((width * height) - (targetWidth * targetHeight));
            const exactResolutionPenalty = resolution === resolutionInfo.Resolution ? 0 : 1e12;
            const frameRatePenalty = frameRate == resolutionInfo.FrameRate ? 0 : 1;
            const score = exactResolutionPenalty + difference + frameRatePenalty;
            const candidate = { url: encodingsLines[i + 1], codecs, resolution, frameRate, family };
            if (score < bestAnyScore) {
                bestAny = candidate;
                bestAnyScore = score;
            }
            if (targetFamily !== 'unknown' && family === targetFamily && score < bestSameFamilyScore) {
                bestSameFamily = candidate;
                bestSameFamilyScore = score;
            }
        }
        const selected = bestSameFamily || bestAny;
        if (selectionOut && selected) {
            selectionOut.url = selected.url;
            selectionOut.codecs = selected.codecs;
            selectionOut.resolution = selected.resolution;
            selectionOut.frameRate = selected.frameRate;
            selectionOut.family = selected.family;
        }
        return selected?.url ?? null;
    }
    async function processM3U8(url, textStr, realFetch) {
        // Only media playlists listed by a live usher /channel/hls/ master playlist are registered
        // in StreamInfosByUrl (hookWorkerFetch); VOD/clip playlists have no entry and pass through untouched.
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        // Allowlisted channel: never swap/strip; an ad already being blocked ends like a normal ad end.
        const isAllowlisted = isChannelAllowlisted(streamInfo.ChannelName, AllowlistedChannels);
        const haveAdTags = !isAllowlisted && (textStr.includes(AdSignifier) || SimulatedAdsDepth > 0);
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false,
                    runtimeStatus: {
                        channel: streamInfo.ChannelName ?? null,
                        showingAd: streamInfo.IsShowingAd ?? false,
                        strippingSegments: false,
                        backupPlayerType: streamInfo.ActiveBackupPlayerType ?? null,
                        lastPlayerReload: streamInfo.LastPlayerReload ?? null,
                        numStrippedAdSegments: streamInfo.NumStrippedAdSegments ?? 0,
                        isMidroll: streamInfo.IsMidroll ?? false
                    }
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\r', '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            if (streamInfo.RequestedAds.size > 100) {
                                streamInfo.RequestedAds.delete(streamInfo.RequestedAds.values().next().value);
                            }
                            fetch(lines[i + 1]).then((response)=>{response.blob()});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('Ads will leak due to missing resolution info for ' + url);
                return textStr;
            }
            const currentCodecs = currentResolution.Codecs || '';
            const currentCodecFamily = videoCodecFamily(currentCodecs);
            const isEnhanced = currentCodecFamily === 'hevc' || currentCodecFamily === 'av1';
            if (((isEnhanced && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
                const playerType = BackupPlayerTypes[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        try {
                            const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                            if (accessTokenResponse.status === 200) {
                                const accessToken = await accessTokenResponse.json();
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', accessToken.data.streamPlaybackAccessToken.signature);
                                urlInfo.searchParams.set('token', accessToken.data.streamPlaybackAccessToken.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                }
                            }
                        } catch (err) {}
                    }
                    if (encodingsM3u8) {
                        try {
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = await streamM3u8Response.text();
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                    }
                                    if ((!m3u8Text.includes(AdSignifier) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (isFullyCachedPlayerType) {
                                        break;
                                    }
                                    if (isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            }
                        } catch (err) {}
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(`Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType})`);
                }
            }
            const stripEnhanced = isEnhanced && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripEnhanced) {
                textStr = stripAdSegments(textStr, stripEnhanced, streamInfo);
            }
        } else if (streamInfo.IsShowingAd) {
            console.log('Finished blocking ads');
            const wasStrippingAdSegments = streamInfo.IsStrippingAdSegments;
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd || wasStrippingAdSegments) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            } else {
                postMessage({
                    key: 'PauseResumePlayer'
                });
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            runtimeStatus: {
                channel: streamInfo.ChannelName ?? null,
                showingAd: streamInfo.IsShowingAd ?? false,
                strippingSegments: streamInfo.IsStrippingAdSegments ?? false,
                backupPlayerType: streamInfo.ActiveBackupPlayerType ?? null,
                lastPlayerReload: streamInfo.LastPlayerReload ?? null,
                numStrippedAdSegments: streamInfo.NumStrippedAdSegments ?? 0,
                isMidroll: streamInfo.IsMidroll ?? false,
                allowlisted: isAllowlisted
            },
            // Allowlisted channel with Twitch's ad in the playlist: the viewer is watching it (support stats).
            watchingAd: isAllowlisted && textStr.includes(AdSignifier)
        });
        return textStr;
    }
    function parseAttributes(str) {
        // Accepts a bare attribute list or a whole '#EXT-X-...:' tag line (prefix stripped).
        const tagPrefix = /^#[A-Z0-9-]+:/i.exec(str);
        const attributeList = tagPrefix ? str.substring(tagPrefix[0].length) : str;
        return Object.fromEntries(
            attributeList.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                // Same mobile_feed asked as web comes back with the ad: the exemption needs the pair.
                platform: (playerType == 'autoplay' || playerType == 'mobile_feed') ? 'android' : 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }
    function gqlRequest(body, playerType) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeoutId = setTimeout(() => {
                const pending = pendingFetchRequests.get(requestId);
                if (!pending) return;
                pendingFetchRequests.delete(requestId);
                pending.reject(new Error('VAFT worker fetch request timed out'));
            }, WorkerFetchTimeoutMs);
            pendingFetchRequests.set(requestId, {
                resolve,
                reject,
                timeoutId
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        isLive: true
    };
    function isStandaloneTwitchAdVideo(video) {
        if (!video) return false;
        const videoSrc = video.currentSrc || video.getAttribute?.('src') || '';
        if (!videoSrc || videoSrc.startsWith('blob:')) return false;
        try {
            const host = new URL(videoSrc, document.location.href).hostname.toLowerCase();
            return host === 'media-amazon.com' || host.endsWith('.media-amazon.com');
        } catch {
            return false;
        }
    }
    function getPlayerVideoElement() {
        const knownPlayerVideo = playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
        if (knownPlayerVideo && !isStandaloneTwitchAdVideo(knownPlayerVideo)) {
            return knownPlayerVideo;
        }
        const videos = document.getElementsByTagName('video');
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            if (!video.dataset.vaftAdHidden && !isStandaloneTwitchAdVideo(video)) {
                return video;
            }
        }
        return null;
    }
    window.vaftGetPlayerVideoElement = getPlayerVideoElement;
    const PLAYBACK_METHODS = ['getQuality', 'getQualities', 'getVideoFrameRate', 'getVideoBitRate', 'getBandwidthEstimate', 'getLiveLatency', 'isLiveLowLatency', 'getBufferDuration', 'getDroppedFrames'];
    function playbackInfo(player, video) {
        // What is playing now, for the settings panel. Every player call is optional (Twitch changes its
        // player); anything that is not a finite number >= 0 is dropped. The <video> element fills in
        // size, buffer and dropped frames when the player is not found. 'missing' is for bug reports.
        const call = (name) => {
            try {
                return typeof player?.[name] === 'function' ? player[name]() : undefined;
            } catch {
                return undefined;
            }
        };
        const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
        const fromVideo = (read) => {
            try {
                return num(read());
            } catch {
                return null;
            }
        };
        const quality = call('getQuality');
        const qualities = call('getQualities');
        const lowLatency = call('isLiveLowLatency');
        const height = num(video?.videoHeight) || num(quality?.height);
        return {
            quality: typeof quality?.name === 'string' ? quality.name : height ? `${height}p` : null,
            source: quality?.group === 'chunked',
            width: num(video?.videoWidth) || num(quality?.width),
            height,
            framerate: num(call('getVideoFrameRate')) || num(quality?.framerate),
            codecs: typeof quality?.codecs === 'string' ? quality.codecs : null,
            bitrate: num(call('getVideoBitRate')),
            bandwidth: num(call('getBandwidthEstimate')),
            latency: num(call('getLiveLatency')),
            lowLatency: typeof lowLatency === 'boolean' ? lowLatency : null,
            buffer: num(call('getBufferDuration')) ?? fromVideo(() => video.buffered.end(video.buffered.length - 1) - video.currentTime),
            dropped: num(call('getDroppedFrames')) ?? fromVideo(() => video.getVideoPlaybackQuality().droppedVideoFrames),
            available: Array.isArray(qualities) ? qualities.filter((q) => typeof q?.name === 'string').map((q) => q.name) : [],
            missing: player ? PLAYBACK_METHODS.filter((name) => typeof player[name] !== 'function') : ['player']
        };
    }
    window.vaftGetPlaybackInfo = () => {
        try {
            const player = playerForMonitoringBuffering?.player || getPlayerAndState()?.player;
            const video = getPlayerVideoElement();
            return player || video ? playbackInfo(player, video) : null;
        } catch {
            return null;
        }
    };
    function hideStandaloneTwitchVideoAds() {
        const primaryVideo = playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
        // Allowlisted channel page: Twitch's own ad videos play (and an earlier hide is undone).
        let allowAds = false;
        try {
            allowAds = isChannelAllowlisted(allowlistChannelOfPage(location.hostname, location.pathname, location.search), AllowlistedChannels);
        } catch {}
        const videos = document.getElementsByTagName('video');
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            const isAdVideo = isStandaloneTwitchAdVideo(video);
            if (isAdVideo && video !== primaryVideo && !allowAds) {
                if (!video.dataset.vaftAdHidden) {
                    video.dataset.vaftAdHidden = '1';
                    video.dataset.vaftAdWasMuted = video.muted ? '1' : '0';
                }
                video.style.setProperty('display', 'none', 'important');
                try {
                    video.muted = true;
                    if (!video.paused) video.pause();
                } catch {}
            } else if (video.dataset.vaftAdHidden && (!isAdVideo || allowAds)) {
                const wasMuted = video.dataset.vaftAdWasMuted === '1';
                delete video.dataset.vaftAdHidden;
                delete video.dataset.vaftAdWasMuted;
                video.style.removeProperty('display');
                try { video.muted = wasMuted; } catch {}
            }
        }
    }
    // Display ads (banner under the player, squeezeback that shrinks the stream, pod above chat)
    // never go through the playlist: Twitch's client-side ad manager requests them from the page and
    // drains its queue as `declineReason ? cmd.decline(reason) : isReady && cmd.fn()`. Declining it
    // stops the request itself (no creative, no shrunk stream). Found through webpack's module
    // registry by its static method names, so no module id or asset hash is hardcoded.
    // Approach from scamorza/TwitchAdBlock (MIT). Allowlisted channels get display ads back.
    const DISPLAY_AD_DECLINE_REASON = 'player_size';// a value from Twitch's own decline enum
    const DISPLAY_AD_MAX_ATTEMPTS = 240;// 500ms apart (2 min): the bundle can take ~20s on a cold cache
    const DISPLAY_AD_SLOW_EVERY = 20;// then one lookup every 10s: a manager loaded later is still found
    const displayAds = { state: 'searching', attempts: 0, registries: new Map(), manager: null, moduleId: null, ours: false, before: undefined, failed: false };
    function getWebpackRequire(queue) {
        if (!queue || typeof queue.push !== 'function') {
            return null;
        }
        // Webpack runs the third entry with its require once it owns the array; before that the
        // push is a plain append, so the entry is taken back out. String chunk id: wrappers of this
        // push (FrankerFaceZ) stringify the ids and throw on anything else.
        let req = null;
        const entry = [['vaft-' + Math.random().toString(36).slice(2)], {}, (r) => { req = r; }];
        try {
            queue.push(entry);
        } catch {}
        if (!req) {
            try {
                const at = queue.indexOf(entry);
                if (at !== -1) {
                    queue.splice(at, 1);
                }
            } catch {}
            return null;
        }
        return typeof req === 'function' ? req : null;
    }
    // Name of a webpack factory's require parameter: '' when it takes none, null when unreadable.
    function webpackRequireParam(source) {
        const head = /^\s*(?:async\s+)?(?:function\b)?\s*[\w$]*\s*\(([^)]*)\)\s*(?:=>|\{)/.exec(source);
        if (!head) {
            return /^\s*(?:async\s+)?[\w$]+\s*=>/.test(source) ? '' : null;
        }
        const params = head[1].split(',').map((x) => x.trim());
        if (params.length < 3 || !params[2]) {
            return '';
        }
        return /^[\w$]+$/.test(params[2]) ? params[2] : null;
    }
    // True when every module the factory requires (recursively) already ran or is registered.
    // Running a factory whose dependency chunk has not arrived would throw half-way and leave a
    // broken entry in webpack's module cache, breaking Twitch's own code that needs it later.
    function webpackDepsLoaded(req, id, seen = new Set()) {
        if (seen.has(id)) {
            return true;
        }
        seen.add(id);
        if (req.c && req.c[id]) {
            return true;
        }
        const factories = req.m || {};
        if (!Object.prototype.hasOwnProperty.call(factories, id) || typeof factories[id] !== 'function') {
            return false;
        }
        let source;
        try {
            source = Function.prototype.toString.call(factories[id]);
        } catch {
            return false;
        }
        const name = webpackRequireParam(source);
        if (name === null) {
            return false;
        }
        if (!name) {
            return true;
        }
        // Module ids are numbers; the minifier writes round ones in e-notation (n(381e3) = module 381000).
        // String arguments are never requires here (a local variable shadowing the name). No lookbehind:
        // older Safari cannot compile it.
        const calls = new RegExp(`(?:^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\(\\s*(\\d+(?:e\\d+)?)\\s*\\)`, 'g');
        for (const match of source.matchAll(calls)) {
            if (!webpackDepsLoaded(req, String(Number(match[1])), seen)) {
                return false;
            }
        }
        return true;
    }
    function findClientAdManager(req, scanned) {
        const factories = req?.m || {};
        for (const id of Object.keys(factories)) {
            if (scanned.has(id)) {
                continue;
            }
            let source;
            try {
                source = Function.prototype.toString.call(factories[id]);
            } catch {
                scanned.add(id);
                continue;
            }
            // Both markers: the component that calls startProcessingRequests does not hold the class.
            if (!source.includes('startProcessingRequests') || !source.includes('declineReason')) {
                scanned.add(id);
                continue;
            }
            let exports;
            const cached = req.c && req.c[id];
            if (cached) {
                // Already run by Twitch: nothing to execute.
                exports = cached.exports;
            } else {
                // Not run yet: only once all its dependencies are loaded (retried on the next tick).
                if (!webpackDepsLoaded(req, id)) {
                    continue;
                }
                try {
                    exports = req(id);
                } catch {
                    continue;
                }
            }
            for (const name of Object.keys(exports || {})) {
                let value;
                try {
                    value = exports[name];
                } catch {
                    continue;
                }
                if (typeof value === 'function' && typeof value.startProcessingRequests === 'function' && typeof value.decline === 'function') {
                    return { manager: value, moduleId: id + '.' + name };
                }
            }
        }
        return null;
    }
    // A decline Twitch makes itself, even with our reason, is Twitch's: never undone on allowlisted
    // channels. (Our own call goes through this too; applyDisplayAdPolicy marks it ours right after.)
    function watchTwitchDeclines(manager, ctl) {
        const original = manager.decline;
        if (typeof original !== 'function' || original.vaftWrapped) {
            return;
        }
        const wrapped = function(...args) {
            ctl.ours = false;
            return original.apply(this, args);
        };
        wrapped.vaftWrapped = true;
        try {
            manager.decline = wrapped;
        } catch {}
    }
    // Off the allowlist: decline (unless Twitch already did, e.g. Turbo). On it: undo only our own decline.
    function applyDisplayAdPolicy(manager, ctl, allow, reason) {
        if (allow) {
            if (ctl.ours) {
                if (manager.declineReason === reason) {
                    try {
                        manager.declineReason = ctl.before;
                    } catch {}
                }
                if (manager.declineReason === reason) {
                    return 'stuck';
                }
                ctl.ours = false;
            }
            return manager.declineReason ? 'twitch' : 'allowed';
        }
        if (ctl.ours && manager.declineReason === reason) {
            return 'declined';
        }
        if (manager.declineReason) {
            ctl.ours = false;
            return 'twitch';
        }
        if (ctl.failed) {
            return 'failed';
        }
        ctl.before = manager.declineReason;
        try {
            // {sendEvent:false}: Twitch's own switch for not reporting the decline.
            manager.decline(reason, { sendEvent: false });
        } catch {}
        if (manager.declineReason) {
            ctl.ours = true;
            return 'declined';
        }
        ctl.failed = true;
        return 'failed';
    }
    // Channel whose allowlist entry applies here: the channel page, or <login> in /moderator/<login>
    // and /popout/<login>/... (same rule as the panel).
    function allowlistChannelOfPage(hostname, pathname, search) {
        const channel = parseChannelPage(hostname, pathname, search).channel;
        if (channel || hostname === 'player.twitch.tv') {
            return channel;
        }
        const parts = String(pathname || '').split('/').filter(Boolean);
        const first = (parts[0] || '').toLowerCase();
        const login = (parts[1] || '').toLowerCase();
        return (first === 'moderator' || first === 'popout') && /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
    }
    // Off switch for troubleshooting: localStorage vaftDeclineDisplayAds = 'off' (then reload).
    function isDisplayAdDeclineOn() {
        try {
            return localStorage.getItem('vaftDeclineDisplayAds') !== 'off';
        } catch {
            return true;
        }
    }
    function syncDisplayAds() {
        try {
            if (!isDisplayAdDeclineOn()) {
                // No webpack lookup at all; a decline already made is undone.
                if (displayAds.manager && displayAds.ours) {
                    applyDisplayAdPolicy(displayAds.manager, displayAds, true, DISPLAY_AD_DECLINE_REASON);
                }
                displayAds.state = 'off';
                return;
            }
            if (!displayAds.manager) {
                displayAds.attempts++;
                if (displayAds.attempts > DISPLAY_AD_MAX_ATTEMPTS && displayAds.attempts % DISPLAY_AD_SLOW_EVERY !== 0) {
                    return;
                }
                // Every webpack registry on the page: extensions injected into the page can have their own.
                for (const key of Object.keys(window)) {
                    if (/^webpackChunk/i.test(key) && !displayAds.registries.has(key)) {
                        const req = getWebpackRequire(window[key]);
                        if (req) {
                            displayAds.registries.set(key, { req, scanned: new Set() });
                        }
                    }
                }
                let found = null;
                for (const registry of displayAds.registries.values()) {
                    try {
                        found = findClientAdManager(registry.req, registry.scanned);
                    } catch {}
                    if (found) {
                        break;
                    }
                }
                if (!found) {
                    if (displayAds.attempts === DISPLAY_AD_MAX_ATTEMPTS) {
                        displayAds.state = 'not-found';
                        const message = '[vaft] Twitch ad manager not found after 2 min: display ads (banner under the player, shrunk stream) are not blocked yet, still looking every 10 s';
                        if (window.top === window && location.hostname === 'www.twitch.tv') {
                            console.warn(message);
                        } else {
                            console.debug(message);
                        }
                    }
                    return;
                }
                displayAds.manager = found.manager;
                displayAds.moduleId = found.moduleId;
                displayAds.registries.clear();
                watchTwitchDeclines(found.manager, displayAds);
            }
            const allow = isChannelAllowlisted(allowlistChannelOfPage(location.hostname, location.pathname, location.search), AllowlistedChannels);
            const state = applyDisplayAdPolicy(displayAds.manager, displayAds, allow, DISPLAY_AD_DECLINE_REASON);
            if (state !== displayAds.state) {
                displayAds.state = state;
                if (state === 'declined') {
                    console.log(`[vaft] display ads declined (${displayAds.moduleId})`);
                } else if (state === 'allowed') {
                    console.log('[vaft] display ads allowed on this channel (allowlist)');
                } else if (state === 'stuck' || state === 'failed') {
                    console.warn(`[vaft] display ads: could not ${state === 'stuck' ? 'undo' : 'apply'} the decline (${displayAds.moduleId})`);
                }
            }
        } catch (err) {
            console.debug('[vaft] display ad sync failed', err);
        }
    }
    // SPA navigation: the new channel's policy applies at once instead of on the next 500ms tick.
    function hookHistoryForDisplayAds() {
        const resync = () => {
            if (displayAds.manager) {
                syncDisplayAds();
            }
        };
        for (const name of ['pushState', 'replaceState']) {
            try {
                const original = history[name];
                if (typeof original !== 'function') {
                    continue;
                }
                history[name] = function(...args) {
                    const result = original.apply(this, args);
                    resync();
                    return result;
                };
            } catch {}
        }
        window.addEventListener('popstate', resync);
    }
    function getDisplayAdStatus() {
        let declineReason = null;
        try {
            declineReason = displayAds.manager?.declineReason || null;
        } catch {}
        return { state: displayAds.state, moduleId: displayAds.moduleId, declineReason: declineReason ? String(declineReason) : null };
    }
    function monitorPlayerBuffering() {
        hideStandaloneTwitchVideoAds();
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                        const fileName = new URL(m3u8Url).pathname.split('/').pop();
                        if (fileName?.endsWith('.m3u8')) {
                            const channelName = fileName.slice(0, -5);
                            if (playerBufferState.channelName != channelName) {
                                playerBufferState.channelName = channelName;
                                playerBufferState.hasStreamStarted = false;
                                playerBufferState.numSame = 0;
                            }
                        }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position !== undefined && bufferedPosition !== undefined) {
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone) &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration);
                                const isPausePlay = !PlayerBufferingDoPlayerReload;
                                const isReload = PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        if (!playerForMonitoringBuffering && getPlayerVideoElement()) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        runVaftHealthCheck();
        sweepAdBreaks();
        setTimeout(monitorPlayerBuffering, PlayerBufferingDelay);
    }
    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
        }
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return {
            player: player,
            state: playerState
        };
    }
    function doTwitchPlayerTask(isPausePlay, isReload) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            console.log('Reloading Twitch player');
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play();
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            try {
                worker.postMessage({key: key, value: value});
            } catch (error) {
                twitchWorkers.delete(worker);
                console.debug('[vaft] removed inactive worker', error);
            }
        });
    }
    // Self-check: warn once per page load when ad-blocking looks silently broken on a live
    // channel page (Twitch worker never hooked, or hooked but no live playlist went through vaft).
    const vaftHealth = {
        workerHooked: false,
        lastWorkerMessageAt: null,
        warnings: []
    };
    const healthCheckState = { lastTickAt: 0, lastVideoTime: null, livePlayingMs: 0, url: '' };
    const healthMessages = (navigator.language || '').startsWith('fr') ? {
        'worker-not-hooked': "le worker vidéo de Twitch n'a jamais été intercepté, les pubs ne sont probablement PAS bloquées (Twitch a changé son lecteur, ou un autre script/extension l'a pris avant).",
        'no-worker-messages': "le worker vidéo de Twitch est intercepté mais aucune playlist live n'est passée par vaft, les pubs ne sont probablement PAS bloquées (Twitch a changé ses requêtes de playlist).",
        report: 'À signaler ici :'
    } : {
        'worker-not-hooked': "Twitch's video worker was never intercepted, ads are probably NOT blocked (Twitch changed its player, or another script/extension grabbed it first).",
        'no-worker-messages': "Twitch's video worker is hooked but no live playlist went through vaft, ads are probably NOT blocked (Twitch changed its playlist requests).",
        report: 'Please report it:'
    };
    function noteVaftWorkerMessage() {
        vaftHealth.lastWorkerMessageAt = Date.now();
        healthCheckState.livePlayingMs = 0;
    }
    function getVaftHealth() {
        return {
            workerHooked: vaftHealth.workerHooked,
            lastWorkerMessageAt: vaftHealth.lastWorkerMessageAt,
            warnings: vaftHealth.warnings.map((warning) => ({ ...warning }))
        };
    }
    function reportVaftHealthProblem(code) {
        if (vaftHealth.warnings.some((warning) => warning.code === code)) {
            return;
        }
        const warning = { code, message: healthMessages[code] || code, version: SCRIPT_VERSION, at: Date.now() };
        vaftHealth.warnings.push(warning);
        console.warn('[vaft ' + SCRIPT_VERSION + '] self-check failed (' + code + '): ' + warning.message + ' ' + healthMessages.report + ' https://github.com/0rpi/twitch-adblock-userscript/issues');
        try {
            window.dispatchEvent(new CustomEvent('vaft-health', { detail: { ...warning, ...getVaftHealth() } }));
        } catch {}
    }
    function runVaftHealthCheck() {
        // Called from the monitorPlayerBuffering loop, throttled to one check every 5 s.
        try {
            const now = Date.now();
            if (now - healthCheckState.lastTickAt < 5000) {
                return;
            }
            const elapsed = healthCheckState.lastTickAt ? Math.min(now - healthCheckState.lastTickAt, 10000) : 0;
            healthCheckState.lastTickAt = now;
            if (healthCheckState.url !== location.href) {
                healthCheckState.url = location.href;
                healthCheckState.livePlayingMs = 0;
                healthCheckState.lastVideoTime = null;
            }
            const video = getPlayerVideoElement();
            const videoTime = video ? video.currentTime : null;
            const hasAdvanced = videoTime !== null && healthCheckState.lastVideoTime !== null && videoTime > healthCheckState.lastVideoTime;
            healthCheckState.lastVideoTime = videoTime;
            // Only real, visible MSE (blob:) playback, with this copy of vaft in charge.
            if (!hasAdvanced || video.paused || isDocumentActuallyHidden() || !video.currentSrc.startsWith('blob:') || window.twitchAdSolutionsVersion !== ourTwitchAdSolutionsVersion) {
                return;
            }
            const contentType = playerForMonitoringBuffering?.state?.props?.content?.type;
            if ((contentType && contentType !== 'live') || !parseChannelPage(location.hostname, location.pathname, location.search).isLive) {
                return;
            }
            healthCheckState.livePlayingMs += elapsed;
            const problem = vaftHealthProblem(healthCheckState.livePlayingMs, vaftHealth.workerHooked, contentType === 'live');
            if (problem) {
                reportVaftHealthProblem(problem);
            }
        } catch {}
    }
    // Ad break statistics, fed by 'UpdateAdBlockBanner' worker messages.
    const AD_STATS_KEY = 'vaftAdStats';
    const adBreakTracker = new Map();
    const sessionAdStats = { breaks: 0, seconds: 0, since: Date.now() };
    function readAdStats() {
        try {
            return normalizeAdStats(JSON.parse(localStorage.getItem(AD_STATS_KEY)));
        } catch {
            return normalizeAdStats(null);
        }
    }
    function recordAdStats(breaks, seconds) {
        if (!breaks && !seconds) {
            return;
        }
        Object.assign(sessionAdStats, addAdStats(sessionAdStats, breaks, seconds, sessionAdStats.since));
        try {
            // Re-read before writing so several tabs add up instead of overwriting each other.
            localStorage.setItem(AD_STATS_KEY, JSON.stringify(addAdStats(readAdStats(), breaks, seconds, Date.now())));
        } catch {}
    }
    // How the blocked ads were replaced (seconds per method) and the last break blocked.
    const AD_METHODS_KEY = 'vaftAdMethods';
    const LAST_AD_KEY = 'vaftLastAd';
    function readStored(key, normalize) {
        try {
            return normalize(JSON.parse(localStorage.getItem(key)));
        } catch {
            return normalize(null);
        }
    }
    function recordAdMethod(method, seconds) {
        if (!method || !(seconds > 0)) {
            return;
        }
        try {
            const methods = readStored(AD_METHODS_KEY, normalizeAdMethods);
            methods[method] += seconds;
            localStorage.setItem(AD_METHODS_KEY, JSON.stringify(normalizeAdMethods(methods)));
        } catch {}
    }
    function recordLastAd(lastAd) {
        try {
            const clean = normalizeLastAd(lastAd);
            if (clean) {
                localStorage.setItem(LAST_AD_KEY, JSON.stringify(clean));
            }
        } catch {}
    }
    function getVaftAdStats() {
        return { ...readAdStats(), session: { ...sessionAdStats }, methods: readStored(AD_METHODS_KEY, normalizeAdMethods), lastAd: readStored(LAST_AD_KEY, normalizeLastAd) };
    }
    // Ads watched on allowlisted channels, per channel ('vaftWatchedAds'), same counting as blocked breaks.
    const WATCHED_ADS_KEY = 'vaftWatchedAds';
    const watchedAdTracker = new Map();
    function readWatchedAds() {
        try {
            return normalizeWatchedAds(JSON.parse(localStorage.getItem(WATCHED_ADS_KEY)));
        } catch {
            return {};
        }
    }
    function recordWatchedAds(channel, breaks, seconds) {
        if (!breaks && !seconds) {
            return;
        }
        try {
            // Re-read before writing so several tabs add up.
            localStorage.setItem(WATCHED_ADS_KEY, JSON.stringify(addWatchedAds(readWatchedAds(), channel, breaks, seconds, Date.now())));
        } catch {}
    }
    function dispatchAdState(channel) {
        try {
            const entry = adBreakTracker.get(channel);
            window.dispatchEvent(new CustomEvent('vaft-ad-state', {
                detail: {
                    showingAd: !!entry,
                    channel: channel ?? null,
                    backupPlayerType: entry?.backupPlayerType ?? null,
                    stats: getVaftAdStats()
                }
            }));
        } catch {}
    }
    function trackAdState(source, data) {
        try {
            const status = data.runtimeStatus || {};
            const now = Date.now();
            if (typeof status.channel === 'string' && status.channel) {
                // Same worker now on another channel (SPA navigation mid-ad): its old breaks are over.
                const left = removeAdBreakSource(adBreakTracker, source, now, status.channel);
                recordAdStats(0, left.seconds);
                left.ended.forEach((channel) => dispatchAdState(channel));
                removeAdBreakSource(watchedAdTracker, source, now, status.channel);
            }
            const before = typeof status.channel === 'string' ? adBreakTracker.get(status.channel) : undefined;
            const result = updateAdBreakTracker(adBreakTracker, source, status.channel, data.hasAds === true, status.backupPlayerType, now);
            recordAdStats(result.newBreak ? 1 : 0, result.seconds);
            if (result.changed) {
                dispatchAdState(status.channel);
            }
            // Details of the break: the time since the last message goes to the method then in use.
            const entry = adBreakTracker.get(status.channel);
            const method = adBlockMethod(status);
            recordAdMethod(before?.method || method, result.seconds);
            const current = entry || before;
            if (current && current.lastAt === now) {// Not for a stale break the tracker just dropped
                current.seconds = (current.seconds || 0) + result.seconds;
                current.method = method || current.method || null;
                current.midroll = current.midroll === true || status.isMidroll === true;
                recordLastAd({ channel: status.channel, at: now, seconds: current.seconds, midroll: current.midroll, method: current.method });
            }
            const watched = updateAdBreakTracker(watchedAdTracker, source, status.channel, data.watchingAd === true, null, now);
            recordWatchedAds(status.channel, watched.newBreak ? 1 : 0, watched.seconds);
        } catch {}
    }
    let lastAdBreakSweepAt = 0;
    function sweepAdBreaks() {
        // From the monitorPlayerBuffering loop (every 5 s): ends breaks no worker message will close.
        try {
            const now = Date.now();
            if (now - lastAdBreakSweepAt < 5000) {
                return;
            }
            lastAdBreakSweepAt = now;
            expireAdBreaks(watchedAdTracker, now);
            for (const channel of expireAdBreaks(adBreakTracker, now)) {
                if (vaftRuntimeStatus.channel === channel && vaftRuntimeStatus.showingAd) {
                    Object.assign(vaftRuntimeStatus, { showingAd: false, strippingSegments: false, backupPlayerType: null });
                    updateAdblockBanner({ hasAds: false, isStrippingAdSegments: false });
                }
                dispatchAdState(channel);
            }
        } catch {}
    }
    function forgetAdStateSource(source) {
        try {
            const result = removeAdBreakSource(adBreakTracker, source, Date.now());
            recordAdStats(0, result.seconds);
            result.ended.forEach((channel) => dispatchAdState(channel));
            removeAdBreakSource(watchedAdTracker, source, Date.now());
        } catch {}
    }
    // Channel allowlist: ads play normally on these channels (to support streamers).
    function applyAllowlist(next) {
        const previous = AllowlistedChannels;
        AllowlistedChannels = next;
        postTwitchWorkerMessage('UpdateAllowlist', AllowlistedChannels);
        syncDisplayAds();
        try {
            // The stream on screen changes only with a new token: reload when this channel flipped.
            const channel = parseChannelPage(location.hostname, location.pathname, location.search).channel;
            const contentType = (playerForMonitoringBuffering || getPlayerAndState())?.state?.props?.content?.type;
            if (allowlistReloadNeeded(channel, previous, next, contentType)) {
                doTwitchPlayerTask(false, true);
            }
        } catch {}
    }
    function setAllowlist(list) {
        if (!Array.isArray(list)) {
            // A lone string used to wipe the whole list: refuse anything but an array.
            console.warn('[vaft] setVaftAllowlist() takes an array of channel logins, e.g. setVaftAllowlist(["somestreamer"]); use toggleVaftAllowlist("somestreamer") to add or remove one channel. Allowlist unchanged.');
            return normalizeAllowlist(AllowlistedChannels);
        }
        const next = normalizeAllowlist(list);
        try {
            localStorage.setItem('vaftAllowlist', JSON.stringify(next));
        } catch {}
        applyAllowlist(next);
        return next.slice();
    }
    function getCurrentChannelLogin() {
        return parseChannelPage(location.hostname, location.pathname, location.search).channel || vaftRuntimeStatus.channel || null;
    }
    function isAllowlistedAccessTokenRequest(body) {
        // True only when every token operation in the GQL body targets an allowlisted login.
        try {
            if (!AllowlistedChannels.length) {
                return false;
            }
            const parsed = JSON.parse(body);
            const tokenOperations = (Array.isArray(parsed) ? parsed : [parsed]).filter((operation) => typeof operation?.variables?.playerType === 'string');
            return tokenOperations.length > 0 && tokenOperations.every((operation) => isChannelAllowlisted(operation.variables.login, AllowlistedChannels));
        } catch {
            return false;
        }
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        try {
            const response = await window.realFetch(fetchRequest.url, fetchRequest.options);
            const responseBody = await response.text();
            return {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.message
            };
        }
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(input, init, ...args) {
            const isRequest = typeof Request !== 'undefined' && input instanceof Request;
            const isUrlObject = typeof URL !== 'undefined' && input instanceof URL;
            const requestUrl = typeof input === 'string' ? input : isRequest ? input.url : isUrlObject ? input.href : '';
            let requestHeaders;
            try {
                requestHeaders = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
            } catch {
                requestHeaders = new Headers();
            }
            let nextInit = init;
            if (requestUrl.includes('gql')) {
                const deviceId = requestHeaders.get('X-Device-Id') ?? requestHeaders.get('Device-ID');
                if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                    GQLDeviceID = deviceId;
                    postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                }
                const clientVersion = requestHeaders.get('Client-Version');
                if (typeof clientVersion === 'string' && clientVersion !== ClientVersion) {
                    postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = clientVersion);
                }
                const clientSession = requestHeaders.get('Client-Session-Id');
                if (typeof clientSession === 'string' && clientSession !== ClientSession) {
                    postTwitchWorkerMessage('UpdateClientSession', ClientSession = clientSession);
                }
                const clientIntegrity = requestHeaders.get('Client-Integrity');
                if (typeof clientIntegrity === 'string' && clientIntegrity !== ClientIntegrityHeader) {
                    postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = clientIntegrity);
                }
                const authorization = requestHeaders.get('Authorization');
                if (typeof authorization === 'string' && authorization !== AuthorizationHeader) {
                    postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = authorization);
                }

                const body = typeof nextInit?.body === 'string' ? nextInit.body : null;
                if (body?.includes('PlaybackAccessToken') && isAllowlistedAccessTokenRequest(body)) {
                    // Allowlisted channel: leave Twitch's own token request untouched (normal ads).
                } else if (body?.includes('PlaybackAccessToken') && body.includes('picture-by-picture')) {
                    nextInit = {...(nextInit || {}), body: ''};
                } else if (ForceAccessTokenPlayerType && body?.includes('PlaybackAccessToken')) {
                    try {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(body);
                        const operations = Array.isArray(newBody) ? newBody : [newBody];
                        for (const operation of operations) {
                            if (operation?.variables?.playerType && operation.variables.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = operation.variables.playerType;
                                operation.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`Replaced '${replacedPlayerType}' player type with '${ForceAccessTokenPlayerType}' player type`);
                            nextInit = {...(nextInit || {}), body: JSON.stringify(newBody)};
                        }
                    } catch (error) {
                        console.debug('[vaft] ignored malformed PlaybackAccessToken request body', error);
                    }
                }
            }
            return realFetch.call(this, input, nextInit, ...args);
        };
    }
    function onContentLoaded() {
        try {
            Object.defineProperty(document, 'visibilityState', {
                get() {
                    return 'visible';
                }
            });
        } catch {}
        try {
            Object.defineProperty(document, 'hidden', {
                get() {
                    return false;
                }
            });
        } catch {}
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        let latencyTimer = null;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const video = getPlayerVideoElement();
            if (video) {
                if (isDocumentActuallyHidden()) {
                    wasVideoPlaying = !video.paused && !video.ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !video.ended && video.paused && video.muted) {
                        video.play();
                    }
                    clearTimeout(latencyTimer);
                    latencyTimer = setTimeout(() => {
                        try {
                            if (isDocumentActuallyHidden() || isActivelyStrippingAds || playerBufferState.lastFixTime > Date.now() - PlayerBufferingMinRepeatDelay) {
                                return;
                            }
                            const playerAndState = playerForMonitoringBuffering || getPlayerAndState();
                            const player = playerAndState?.player;
                            if (!player?.getLiveLatency || playerAndState.state?.props?.content?.type !== 'live') {
                                return;
                            }
                            if (player.getLiveLatency() > (player.isLiveLowLatency?.() ? 5 : 15)) {
                                doTwitchPlayerTask(true, false);
                            }
                        } catch {}
                    }, 3000);
                }
            }
            block(e);
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('hasFocus', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', {
                    get() {
                        return false;
                    }
                });
            } else {
                Object.defineProperty(document, 'webkitHidden', {
                    get() {
                        return false;
                    }
                });
            }
        } catch {}
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',
                'persistenceEnabled',
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err);
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    const allBackupPlayerTypes = BackupPlayerTypes;
    const applyAdBackupMode = (mode) => {
        BackupPlayerTypes = backupPlayerTypesForMode(mode, allBackupPlayerTypes);
    };
    try {
        // 38.0 removed the 360p | Source buttons (mobile_feed is tried first, 360p is only the last
        // resort). A Source choice made with them is dropped once, so nobody is left in Source mode
        // with no visible way back; setAdBackupMode('source') in the console still works afterwards.
        if (localStorage.getItem('vaftBackupModeReset') !== '38') {
            localStorage.removeItem('adBackupMode');
            localStorage.setItem('vaftBackupModeReset', '38');
        }
    } catch {}
    try {
        applyAdBackupMode(localStorage.getItem('adBackupMode'));
    } catch {}
    try {
        AllowlistedChannels = parseStoredAllowlist(localStorage.getItem('vaftAllowlist'));
    } catch {}
    hookWindowWorker();
    hookFetch();
    // Before Twitch starts its ad queue when possible, so the first display ad request never leaves.
    syncDisplayAds();
    setInterval(syncDisplayAds, 500);
    hookHistoryForDisplayAds();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth paramter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
    window.setAdBackupMode = (mode) => {
        applyAdBackupMode(mode);
        try {
            localStorage.setItem('adBackupMode', mode);
        } catch {}
        postTwitchWorkerMessage('UpdateBackupPlayerTypes', BackupPlayerTypes);
    };
    // Auto-quality preference: 'on' (default) or 'off'. Stored separately so
    // disabling it never changes the ad fallback mode above.
    function getAutoQualityMode() {
        try {
            return normalizeAutoQualityMode(localStorage.getItem('vaftAutoQuality'));
        } catch {
            return 'on';
        }
    }
    window.getAutoQuality = getAutoQualityMode;
    window.setAutoQuality = (mode) => {
        try {
            localStorage.setItem('vaftAutoQuality', normalizeAutoQualityMode(mode));
        } catch {}
    };
    // Allowlist API (localStorage 'vaftAllowlist', lowercase logins). set: whole list (array only); toggle: one channel, no argument = current channel.
    window.getVaftAllowlist = () => normalizeAllowlist(AllowlistedChannels);
    window.setVaftAllowlist = (list) => setAllowlist(list);
    window.toggleVaftAllowlist = (channel) => {
        const login = normalizeAllowlist([channel == null ? getCurrentChannelLogin() : channel])[0];
        if (!login) {
            return false;
        }
        const current = normalizeAllowlist(AllowlistedChannels);
        const next = current.includes(login) ? current.filter((x) => x !== login) : current.concat(login);
        return setAllowlist(next).includes(login);
    };
    window.vaftGetCurrentChannel = getCurrentChannelLogin;
    // Ad stats API: { breaks, seconds, since } persisted in 'vaftAdStats', plus this page's session;
    // ads watched on allowlisted channels: { login: { breaks, seconds, since } } in 'vaftWatchedAds'.
    // Reset clears both.
    window.getVaftAdStats = getVaftAdStats;
    window.getVaftWatchedAds = readWatchedAds;
    window.resetVaftAdStats = () => {
        const now = Date.now();
        Object.assign(sessionAdStats, { breaks: 0, seconds: 0, since: now });
        try {
            localStorage.setItem(AD_STATS_KEY, JSON.stringify({ breaks: 0, seconds: 0, since: now }));
        } catch {}
        try {
            localStorage.removeItem(WATCHED_ADS_KEY);
            localStorage.removeItem(AD_METHODS_KEY);
            localStorage.removeItem(LAST_AD_KEY);
        } catch {}
        dispatchAdState(vaftRuntimeStatus.channel);
        return getVaftAdStats();
    };
    window.vaftStatus = () => {
        return {
            version: SCRIPT_VERSION,
            workerCount: twitchWorkers.size,
            backupMode: BackupPlayerTypes.includes('autoplay') ? '360p' : 'source',
            autoQuality: getAutoQualityMode(),
            allowlist: normalizeAllowlist(AllowlistedChannels),
            displayAds: getDisplayAdStatus(),
            ...vaftRuntimeStatus,
            health: getVaftHealth(),
            adStats: getVaftAdStats(),
            watchedAds: readWatchedAds()
        };
    };
    window.addEventListener('storage', (e) => {
        if (e.key === 'adBackupMode') {
            applyAdBackupMode(e.newValue);
            postTwitchWorkerMessage('UpdateBackupPlayerTypes', BackupPlayerTypes);
        } else if (e.key === 'vaftAllowlist') {
            applyAllowlist(parseStoredAllowlist(e.newValue));
        }
    });
})();

(() => {
  if (window.self !== window.top || typeof window.setAdBackupMode !== 'function') return;
  const fr = (navigator.language || '').startsWith('fr');
  const ISSUES_URL = 'https://github.com/0rpi/twitch-adblock-userscript/issues';
  const EARN_URL = `https://github.com/0rpi/twitch-adblock-userscript#${fr ? 'ce-que-touche-le-streamer' : 'what-the-streamer-gets'}`;
  const APP_NAME = 'Twitch Adblock';// shown in the panel header and tooltips (the script's own name, not vaft)
  // Twitch's leftover ad label/countdown are hidden, except on allowlisted channels (html[data-vaft-allow], see syncAllowAttr).
  // The display ad wrapper (banner beside the stream, sibling of the video inside .video-player__container) is a
  // fallback for when the ad manager decline does not take; the lower-third format also shrinks the player.
  // :has() gets a rule of its own: browsers without it drop a whole rule that lists it.
  const NO_ALLOW = 'html:not([data-vaft-allow]) ';
  const CSS = '.player-adblock-notice,' + ['[data-a-target="video-ad-label"]', '[data-a-target="video-ad-countdown"]', '[data-test-selector="ad-banner-default-text"]', '[data-test-selector="sda-wrapper"]', '.stream-display-ad__wrapper'].map(x => NO_ALLOW + x).join(',') + '{display:none!important}'
    + NO_ALLOW + 'div:has(> [data-a-target="video-ad-label"]){display:none!important}'
    + NO_ALLOW + '.video-player--stream-display-ad_lower-third{height:100%!important}'
    + '#vaft-ad-mode{position:relative;display:inline-flex;align-items:center;flex:none;margin-right:8px;font-size:12px;font-weight:600;line-height:1.2}'
    + '#vaft-ad-mode [hidden]{display:none!important}'
    + '#vaft-ad-mode button{margin:0;font:inherit;cursor:pointer}'
    + '#vaft-ad-mode :focus-visible{outline:2px solid var(--color-border-input-focus,#a970ff);outline-offset:1px}'
    + '#vaft-ad-mode .vaft-ind{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px 0 10px;border:0;border-radius:4px;white-space:nowrap;background:var(--color-background-button-secondary-default,#2f2f35);color:var(--color-text-button-secondary,#efeff1)}'
    + '#vaft-ad-mode .vaft-ind:hover{background:var(--color-background-button-secondary-hover,#3a3a3d)}'
    + '#vaft-ad-mode .vaft-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--color-text-alt-2,#adadb8)}'
    + '#vaft-ad-mode .vaft-heart{display:none;color:var(--color-text-link,#bf94ff);font-size:13px;line-height:1}'
    + '#vaft-ad-mode .vaft-gear{flex:none;width:16px;height:16px;fill:currentColor;opacity:.8}'
    + '#vaft-ad-mode[data-state="ad"] .vaft-dot{background:var(--color-background-button-primary-default,#9147ff);box-shadow:0 0 0 3px rgba(145,71,255,.35)}'
    + '#vaft-ad-mode[data-state="allow"] .vaft-dot{display:none}#vaft-ad-mode[data-state="allow"] .vaft-heart{display:inline}'
    + '#vaft-ad-mode[data-state="warn"] .vaft-dot{background:#f5a524}#vaft-ad-mode[data-state="warn"] .vaft-ind{box-shadow:inset 0 0 0 1px #f5a524}'
    + '@media (prefers-reduced-motion:no-preference){#vaft-ad-mode[data-state="ad"] .vaft-dot{animation:vaft-pulse 1.6s ease-in-out infinite}}@keyframes vaft-pulse{50%{opacity:.45}}'
    + '@media (max-width:600px){#vaft-ad-mode[data-state="idle"] .vaft-label{display:none}}'
    + '#vaft-panel{position:fixed;z-index:6000;top:0;left:0;box-sizing:border-box;width:320px;max-height:calc(100vh - 16px);overflow:auto;padding:10px 12px 12px;border:1px solid var(--color-border-base,rgba(83,83,95,.48));border-radius:6px;background:var(--color-background-base,#18181b);color:var(--color-text-base,#efeff1);box-shadow:var(--shadow-elevation-2,0 4px 16px rgba(0,0,0,.5));font-size:13px;font-weight:400;line-height:1.4;text-align:left;white-space:normal;cursor:default}'
    + '#vaft-panel:focus{outline:none}#vaft-panel p{margin:0}'
    + '#vaft-panel .vaft-head{display:flex;align-items:center;justify-content:space-between;font-weight:600}'
    + '#vaft-panel .vaft-ver{margin-left:2px;font-weight:400;color:var(--color-text-alt-2,#adadb8)}'
    + '#vaft-panel .vaft-close{padding:2px 7px;border:0;border-radius:4px;background:none;color:inherit;font-size:16px;line-height:1}'
    + '#vaft-panel .vaft-close:hover{background:var(--color-background-button-text-hover,rgba(83,83,95,.38))}'
    + '#vaft-panel .vaft-allow{display:flex;align-items:center;gap:8px;width:100%;margin:10px 0 0;padding:8px 10px;border:1px solid var(--color-border-base,rgba(83,83,95,.48));border-radius:6px;background:none;color:inherit;text-align:left}'
    + '#vaft-panel .vaft-allow:hover:not(:disabled){background:var(--color-background-button-text-hover,rgba(83,83,95,.38))}'
    + '#vaft-panel .vaft-allow[aria-pressed="true"]{border-color:var(--color-background-button-primary-default,#9147ff);background:rgba(145,71,255,.15)}'
    + '#vaft-panel .vaft-allow[aria-pressed="true"]:hover:not(:disabled){background:rgba(145,71,255,.25)}'
    + '#vaft-panel .vaft-allow:disabled{opacity:.5;cursor:default}'
    + '#vaft-panel .vaft-allow-icon{flex:none;width:16px;font-size:16px;line-height:1;text-align:center}'
    + '#vaft-panel .vaft-allow[aria-pressed="true"] .vaft-allow-icon{color:var(--color-text-link,#bf94ff)}'
    + '#vaft-panel .vaft-allow-text{display:flex;flex:1;flex-direction:column;min-width:0}'
    + '#vaft-panel .vaft-allow-name{font-weight:600;overflow-wrap:anywhere}'
    + '#vaft-panel .vaft-allow-sub{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-alt-2,#adadb8)}'
    + '#vaft-panel .vaft-switch{flex:none;position:relative;width:30px;height:16px;border-radius:8px;background:var(--color-border-input,#53535f)}'
    + '#vaft-panel .vaft-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff}'
    + '#vaft-panel .vaft-allow[aria-pressed="true"] .vaft-switch{background:var(--color-background-button-primary-default,#9147ff)}'
    + '#vaft-panel .vaft-allow[aria-pressed="true"] .vaft-switch::after{transform:translateX(14px)}'
    + '@media (prefers-reduced-motion:no-preference){#vaft-panel .vaft-switch::after{transition:transform .15s}}'
    + '#vaft-panel .vaft-tabs{display:flex;margin-top:10px;border-bottom:1px solid var(--color-border-base,rgba(83,83,95,.48))}'
    + '#vaft-panel .vaft-tab{flex:1;margin-bottom:-1px;padding:6px 4px;border:0;border-bottom:2px solid transparent;background:none;color:var(--color-text-alt-2,#adadb8);font-weight:600}'
    + '#vaft-panel .vaft-tab:hover{color:var(--color-text-base,#efeff1)}'
    + '#vaft-panel .vaft-tab[aria-selected="true"]{border-bottom-color:var(--color-background-button-primary-default,#9147ff);color:var(--color-text-base,#efeff1)}'
    + '#vaft-panel .vaft-body{display:grid;padding-top:6px}'
    + '#vaft-panel .vaft-pane{grid-area:1/1;min-width:0}#vaft-panel .vaft-pane[data-off]{visibility:hidden}#vaft-panel [data-pane="ads"] .vaft-row,#vaft-panel [data-pane="quality"] .vaft-row{margin:3px 0}'
    + '#vaft-panel .vaft-h{margin:6px 0 2px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--color-text-alt-2,#adadb8)}'
    + '#vaft-panel .vaft-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}#vaft-panel .vaft-row>:first-child{min-width:0}'
    + '#vaft-panel .vaft-seg{display:inline-flex;flex:none;gap:2px}'
    + '#vaft-panel .vaft-seg button{padding:4px 10px;border:0;border-radius:4px;font-weight:600;background:var(--color-background-button-secondary-default,#2f2f35);color:var(--color-text-button-secondary,#efeff1)}'
    + '#vaft-panel .vaft-seg button:hover{background:var(--color-background-button-secondary-hover,#3a3a3d)}'
    + '#vaft-panel .vaft-seg button[aria-pressed="true"]{background:var(--color-background-button-primary-default,#9147ff);color:var(--color-text-button-primary,#fff)}'
    + '#vaft-panel select{max-width:160px;padding:3px 6px;border:1px solid var(--color-border-input,#53535f);border-radius:4px;background:var(--color-background-input,#18181b);color:var(--color-text-input,#efeff1);font:inherit}'
    + '#vaft-panel .vaft-hint{font-size:12px;color:var(--color-text-alt-2,#adadb8);overflow-wrap:anywhere}#vaft-panel .vaft-hint a{color:var(--color-text-link,#bf94ff)}'
    + '#vaft-panel .vaft-off{opacity:.6}'
    + '#vaft-panel .vaft-num{flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}'
    + '#vaft-panel .vaft-tiles{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0}'
    + '#vaft-panel .vaft-tile{min-width:0;padding:6px 8px;border-radius:4px;background:var(--color-background-alt,#1f1f23)}'
    + '#vaft-panel .vaft-tile span{display:block;overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-alt-2,#adadb8)}'
    + '#vaft-panel .vaft-tile b{display:block;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}'
    + '#vaft-panel .vaft-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:4px 0}#vaft-panel .vaft-stats .vaft-tile{padding:3px 6px}#vaft-panel .vaft-stats .vaft-tile b{overflow:hidden;font-size:13px;text-overflow:ellipsis}'
    // Two lines kept for the qualities offered: filling them in must not resize the panel.
    + '#vaft-panel .vaft-offered{min-height:2.8em}'
    + '#vaft-panel .vaft-hrow{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-right:34px;overflow:hidden}'
    // Same scrollbar gutter on the heading row and the list, so "Earned" stays over the amounts.
    + '#vaft-panel .vaft-list,#vaft-panel .vaft-hrow{scrollbar-gutter:stable}'
    + '#vaft-panel .vaft-list{height:84px;margin:0 -3px;padding:3px;overflow:auto}#vaft-panel .vaft-list .vaft-row{min-height:24px;margin:0}#vaft-panel .vaft-list .vaft-hint{margin:2px 0}'
    + '#vaft-panel .vaft-chan{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;text-decoration:none}'
    + '#vaft-panel .vaft-chan:hover{color:var(--color-text-link,#bf94ff);text-decoration:underline}'
    + '#vaft-panel .vaft-x{flex:none;min-width:26px;padding:2px 6px;border:0;border-radius:4px;min-height:24px;background:none;color:var(--color-text-alt-2,#adadb8);font-size:12px;line-height:1.3}'
    + '#vaft-panel .vaft-x:hover{background:var(--color-background-button-text-hover,rgba(83,83,95,.38));color:inherit}'
    + '#vaft-panel .vaft-x[data-armed],#vaft-panel .vaft-x[data-armed]:hover{background:#f5a524;color:#0e0e10;font-weight:600}'
    + '#vaft-panel .vaft-refs{margin-top:6px;padding-top:6px;border-top:1px solid var(--color-border-base,rgba(83,83,95,.48))}#vaft-panel .vaft-refs b{font-weight:600;color:var(--color-text-base,#efeff1)}'
    + '#vaft-panel .vaft-link{padding:0;border:0;background:none;color:var(--color-text-link,#bf94ff);text-decoration:underline}'
    + '#vaft-panel .vaft-warn{margin-top:8px;padding:8px;border-left:3px solid #f5a524;border-radius:4px;background:rgba(245,165,36,.12);font-size:12px}'
    + '#vaft-panel .vaft-warn a{color:var(--color-text-link,#bf94ff)}'
    + '#vaft-panel .vaft-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}'
    // Windows High Contrast: keep the selected tab, the On/Off state and the switch visible.
    + '@media (forced-colors:active){#vaft-panel .vaft-tab{border-bottom-color:Canvas}#vaft-panel .vaft-tab[aria-selected="true"]{border-bottom-color:Highlight}'
    + '#vaft-panel .vaft-seg button{border:1px solid ButtonText}#vaft-panel .vaft-seg button[aria-pressed="true"]{forced-color-adjust:none;background:Highlight;color:HighlightText}'
    + '#vaft-panel .vaft-switch{border:1px solid CanvasText}#vaft-panel .vaft-switch::after{forced-color-adjust:none;background:CanvasText}'
    + '#vaft-panel .vaft-allow[aria-pressed="true"] .vaft-switch{forced-color-adjust:none;background:Highlight}#vaft-panel .vaft-allow[aria-pressed="true"] .vaft-switch::after{background:HighlightText}}';
  const addStyle = () => {
    try {
      const style = document.createElement('style');
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    } catch {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addStyle);
  else addStyle();

  const T = fr ? {
    settings: 'Réglages anti-pub', close: 'Fermer', ads: 'Pubs', support: 'Soutien',
    allow: 'Soutenir cette chaîne', allowName: c => `Soutenir ${c}`,
    allowTitle: c => `Laisser passer les pubs Twitch sur ${c} pour soutenir le streamer`,
    allowOn: 'Pubs autorisées : streamer payé',
    allowOff: 'Pubs bloquées : streamer non payé', tabs: 'Rubriques',
    noChannel: 'Aucune chaîne sur cette page.',
    session: 'Bloquées (session)', total: 'Bloquées (total)',
    breaks: n => `${n} ${n > 1 ? 'coupures' : 'coupure'}`,
    since: d => `depuis le ${d}`,
    reset: 'Réinitialiser', resetConfirm: 'Effacer aussi Soutien ?', resetDone: 'Statistiques remises à zéro',
    lastAd: 'Dernière pub bloquée', noAd: "Aucune pour l'instant", preroll: 'pré-roll', midroll: 'mid-roll',
    how: { full: 'Remplacée par une copie sans pub, qualité max', low: 'Remplacée par une copie sans pub en 360p', strip: 'Coupée du stream : écran noir pendant la pub', none: 'Bloquée' },
    methods: 'Remplacement des pubs', methodsTitle: 'Part du temps de pub bloqué passée sur chaque flux',
    mFull: 'Copie sans pub, qualité max', mLow: 'Copie sans pub, 360p', mStrip: 'Coupée (écran noir)',
    banners: 'Bandeaux pub',
    bannerTitle: "Bandeau sous le lecteur et pub qui rétrécit le stream : refusés avant de se charger (masqués si le refus n'a pas pu se faire)",
    bannerState: { declined: 'Refusés', twitch: 'Refusés par Twitch', allowed: 'Autorisés (chaîne soutenue)', searching: 'Recherche…', 'not-found': 'Masqués', failed: 'Masqués', stuck: 'Refusés', off: 'Désactivé' },
    resetTitle: "Remet à zéro les pubs bloquées et les montants de l'onglet Soutien (deux clics)",
    supported: n => `Chaînes soutenues (${n})`,
    supportedHint: 'Montant estimé des pubs que tu as regardées sur chaque chaîne.',
    supportedEmpty: "Aucune pour l'instant : active « Soutenir » sur la page d'un streamer.",
    watchedTitle: n => n ? `Environ ${n} ${n > 1 ? 'pubs regardées' : 'pub regardée'}` : "Aucune pub regardée pour l'instant",
    remove: c => `Retirer ${c} des chaînes soutenues`, removeConfirm: 'Retirer ?', removeArmed: c => `Recliquer pour retirer ${c}`,
    removed: c => `${c} retiré des chaînes soutenues`, earned: 'Rapporté',
    refs: (ad, price, sub, n) => `Pour le streamer : 1 pub ≈\u00a0${ad}, 1 sub à ${price} ≈\u00a0${sub} (≈\u00a0${n} pubs).`,
    notExact: 'Montants estimés, pas exacts : Twitch ne publie pas ses tarifs pub.',
    refsTitle: (lo, hi) => `Une pub rapporte de ${lo} à ${hi} selon le pays et l'annonceur. Sub Tier 1 : 50 % du prix hors TVA (France), jusqu'à 70 % pour certains streamers.`,
    given: 'Donné (pubs vues)', givenTitle: n => `Environ ${n} ${n > 1 ? 'pubs regardées' : 'pub regardée'} sur les chaînes soutenues, y compris celles retirées depuis`,
    lost: 'Manque à gagner', lostTitle: n => `Environ ${n} ${n > 1 ? 'pubs bloquées' : 'pub bloquée'} (une par 30 s de pub)`,
    details: 'Détails',
    quality: 'Qualité', auto: 'Auto', on: 'Oui', off: 'Non',
    tOn: 'Qualité auto activée : choisit ta qualité cible une fois par page',
    tOff: 'Qualité auto désactivée : ne touche pas à ton réglage',
    target: 'Cible', order: o => `Ordre essayé : ${o}`,
    nowPlaying: 'En cours de lecture', qNow: 'Qualité',
    stats: { bitrate: 'Débit', bandwidth: 'Bande passante', latency: 'Retard', buffer: 'Tampon', dropped: 'Images perdues', size: 'Résolution' },
    statsTitle: {
      bitrate: 'Débit de téléchargement de la vidéo', bandwidth: 'Bande passante estimée par le lecteur Twitch',
      latency: 'Retard sur le direct (latence diffuseur) et mode de latence', buffer: 'Mémoire tampon : vidéo déjà téléchargée, en secondes',
      dropped: 'Images perdues depuis le début de la lecture', size: 'Résolution de la vidéo reçue'
    },
    lowLatency: 'basse', normalLatency: 'normale', mbps: 'Mb/s', sourceTag: ' (source)',
    offered: (list, missing) => `Proposées par ce stream : ${list}.${missing ? ` Pas de ${missing}.` : ''}`,
    targetTitle: "Qualité max à choisir. Si le stream ne l'a pas, la suivante dans l'ordre ci-dessous est essayée ; sinon le choix de Twitch est gardé.",
    def: ' (défaut)', custom: 'Perso', report: 'Signaler le problème',
    idleLabel: 'Anti-pub actif',
    idleTitle: 'Les pubs Twitch sont bloquées automatiquement.',
    adLabel: 'Pub bloquée',
    adTitle: t => t ? `Pub bloquée : lecture du flux de secours ${t} à la place.` : 'Pub bloquée.',
    allowLabel: 'Pubs autorisées',
    allowStateTitle: c => `Pubs autorisées sur ${c} (soutien au streamer).`,
    warnLabel: 'Pubs non bloquées ?',
    clickHint: 'Clique pour les réglages.'
  } : {
    settings: 'Ad block settings', close: 'Close', ads: 'Ads', support: 'Support',
    allow: 'Support this channel', allowName: c => `Support ${c}`,
    allowTitle: c => `Let Twitch ads play on ${c} to support the streamer`,
    allowOn: 'Ads allowed: streamer gets paid',
    allowOff: 'Ads blocked: streamer not paid', tabs: 'Sections',
    noChannel: 'No channel on this page.',
    session: 'Blocked this session', total: 'Blocked in total',
    breaks: n => `${n} ${n === 1 ? 'break' : 'breaks'}`,
    since: d => `since ${d}`,
    reset: 'Reset', resetConfirm: 'Also clear Support?', resetDone: 'Stats reset',
    lastAd: 'Last ad blocked', noAd: 'None yet', preroll: 'pre-roll', midroll: 'mid-roll',
    how: { full: 'Replaced by an ad-free copy, full quality', low: 'Replaced by an ad-free copy in 360p', strip: 'Cut out of the stream: black screen during the ad', none: 'Blocked' },
    methods: 'How ads were replaced', methodsTitle: 'Share of the blocked ad time spent on each stream',
    mFull: 'Ad-free copy, full quality', mLow: 'Ad-free copy, 360p', mStrip: 'Cut out (black screen)',
    banners: 'Banner ads',
    bannerTitle: 'Banner under the player and the ad that shrinks the stream: declined before they load (hidden if the decline could not be made)',
    bannerState: { declined: 'Declined', twitch: 'Declined by Twitch', allowed: 'Allowed (supported channel)', searching: 'Looking…', 'not-found': 'Hidden', failed: 'Hidden', stuck: 'Declined', off: 'Off' },
    resetTitle: 'Resets the blocked-ad stats and the Support tab amounts (two clicks)',
    supported: n => `Supported channels (${n})`,
    supportedHint: 'Estimated amount from the ads you watched on each channel.',
    supportedEmpty: 'None yet: turn on "Support" on a streamer\'s page.',
    watchedTitle: n => n ? `About ${n} ${n === 1 ? 'ad' : 'ads'} watched` : 'No ads watched yet',
    remove: c => `Remove ${c} from supported channels`, removeConfirm: 'Remove?', removeArmed: c => `Click again to remove ${c}`,
    removed: c => `${c} removed from supported channels`, earned: 'Earned',
    refs: (ad, price, sub, n) => `For the streamer: 1 ad ≈\u00a0${ad}, 1 sub at ${price} ≈\u00a0${sub} (≈\u00a0${n} ads).`,
    notExact: 'Estimated, not exact amounts: Twitch publishes no ad rates.',
    refsTitle: (lo, hi) => `An ad pays ${lo} to ${hi} depending on country and advertiser. Tier 1 sub: 50% of the price before VAT (France), up to 70% for some streamers.`,
    given: 'Given (ads watched)', givenTitle: n => `About ${n} ${n === 1 ? 'ad' : 'ads'} watched on supported channels, including ones removed since`,
    lost: 'Lost (ads blocked)', lostTitle: n => `About ${n} ${n === 1 ? 'ad' : 'ads'} blocked (one per 30 s of ad)`,
    details: 'Details',
    quality: 'Quality', auto: 'Auto', on: 'On', off: 'Off',
    tOn: 'Auto quality on: picks your target quality once per page',
    tOff: 'Auto quality off: leaves your setting alone',
    target: 'Target', order: o => `Tried in order: ${o}`,
    nowPlaying: 'Now playing', qNow: 'Quality',
    stats: { bitrate: 'Bitrate', bandwidth: 'Bandwidth', latency: 'Delay', buffer: 'Buffer', dropped: 'Dropped frames', size: 'Resolution' },
    statsTitle: {
      bitrate: 'Video download bitrate', bandwidth: "Bandwidth estimated by Twitch's player",
      latency: 'Delay behind live (broadcaster latency) and latency mode', buffer: 'Buffer: video already downloaded, in seconds',
      dropped: 'Frames dropped since playback started', size: 'Size of the video received'
    },
    lowLatency: 'low', normalLatency: 'normal', mbps: 'Mb/s', sourceTag: ' (source)',
    offered: (list, missing) => `Offered by this stream: ${list}.${missing ? ` No ${missing}.` : ''}`,
    targetTitle: "Highest quality to pick. If the stream doesn't have it, the next one in the order below is tried; if none match, Twitch's own choice is kept.",
    def: ' (default)', custom: 'Custom', report: 'Report the problem',
    idleLabel: 'Ad block on',
    idleTitle: 'Twitch ads are blocked automatically.',
    adLabel: 'Ad blocked',
    adTitle: t => t ? `Ad blocked: playing the ${t} backup stream instead.` : 'Ad blocked.',
    allowLabel: 'Ads allowed',
    allowStateTitle: c => `Ads allowed on ${c} (supporting the streamer).`,
    warnLabel: 'Ads not blocked?',
    clickHint: 'Click for settings.'
  };

  // Auto quality: preferred order (best first) in localStorage 'vaftQualityPref'; PREF is the default.
  const QUALITY_LADDER = ['1440p60', '1080p60', '1440p', '1080p', '720p60', '720p'];
  const PREF = ['1440p60', '1080p60', '1440p', '1080p'];
  const QUALITY_PREF_KEY = 'vaftQualityPref';
  let lastUrl = '';
  let done = false;
  let armId = 0;
  let forceAttempt = false;// Next attempt follows an explicit user change: switch even if the current height is fine
  let memQualityPref = null;// Set only when saving to localStorage failed (blocked or full)

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const q = s => document.querySelector(s);
  const isHidden = () => typeof window.vaftIsDocumentHidden === 'function' && window.vaftIsDocumentHidden();
  const isAutoQualityOn = () => {
    try {
      if (typeof window.getAutoQuality === 'function') return window.getAutoQuality() !== 'off';
      return localStorage.getItem('vaftAutoQuality') !== 'off';
    } catch {
      return true;
    }
  };
  const rearmAutoQuality = (force = false) => { done = false; armId++; if (force) forceAttempt = true; };
  const qualityHeight = label => parseInt(label, 10) || 0;
  const is60 = label => /p60$/.test(label);

  function qualityPrefForTarget(target) {
    // Target first, then the lower options of its tier, never below min(target, 1080p).
    // 1440p60 gives exactly PREF.
    if (!QUALITY_LADDER.includes(target)) return PREF.slice();
    const height = qualityHeight(target);
    const floor = Math.min(height, 1080);
    return [target, ...QUALITY_LADDER.filter(x => x !== target && qualityHeight(x) >= floor
      && (qualityHeight(x) < height || (qualityHeight(x) === height && !is60(x) && is60(target))))];
  }

  function normalizeQualityPref(value) {
    if (!Array.isArray(value)) return PREF.slice();
    const list = [...new Set(value.filter(x => typeof x === 'string' && /^\d{3,4}p(\d{2})?$/.test(x)))].slice(0, 12);
    return list.length ? list : PREF.slice();
  }

  function getQualityPref() {
    if (memQualityPref) return memQualityPref.slice();
    let raw;
    try {
      raw = localStorage.getItem(QUALITY_PREF_KEY);
    } catch {
      return PREF.slice();
    }
    try {
      return raw === null ? PREF.slice() : normalizeQualityPref(JSON.parse(raw));
    } catch {
      return PREF.slice();
    }
  }

  function setQualityTarget(target) {
    const pref = qualityPrefForTarget(target);
    memQualityPref = pref;
    try { localStorage.setItem(QUALITY_PREF_KEY, JSON.stringify(pref)); memQualityPref = null; } catch {}
    rearmAutoQuality(true);
  }

  function isAtPreferredQuality(videoHeight, pref) {
    // Default order keeps the old rule (>= 1080p is fine); a lower target also caps the height.
    const heights = pref.map(qualityHeight).filter(Boolean);
    if (!heights.length) return videoHeight >= 1080;
    const max = Math.max(...heights);
    return videoHeight >= Math.min(...heights) && (max >= 1440 || videoHeight <= max);
  }

  function shouldSwitchQuality(autoOn, done, readyState, videoHeight, pref, force) {
    // One attempt per page, never with Auto off; skipped when already at a preferred height,
    // unless the user just changed the target or turned Auto on (force).
    if (!autoOn || done || readyState < 2) return false;
    return force || !isAtPreferredQuality(videoHeight, pref);
  }

  function pickQualityOption(options, pref) {
    // Exact label first ("720p" = 30 fps), then prefix ("1080p" also matches "1080p50").
    const token = text => (/^\d{3,4}p\d*/.exec(text) || [''])[0];
    for (const p of pref) {
      const hit = options.find(o => token(o.text) === p) || options.find(o => o.text.startsWith(p));
      if (hit) return hit;
    }
    return null;
  }

  async function setQuality(pref) {
    const settings = q('[data-a-target="player-settings-button"]');
    if (!settings) return false;
    settings.click();
    await sleep(300);
    const qualityBtn = q('[data-a-target="player-settings-menu-item-quality"]');
    if (!qualityBtn) { settings.click(); return false; }
    qualityBtn.click();
    await sleep(300);
    const labels = [...document.querySelectorAll('[data-a-target="player-settings-menu"] input[type="radio"]')]
      .map(input => ({ input, text: input.closest('div')?.textContent.trim() || '' }));
    const pick = pickQualityOption(labels, pref);
    if (pick) pick.input.click();
    await sleep(200);
    if (q('[data-a-target="player-settings-menu"]')) settings.click();
    return !!pick;
  }

  // Current channel login from the URL (null on directory, VOD, settings... pages).
  const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
  const RESERVED_ROUTES = new Set(['directory', 'videos', 'settings', 'search', 'downloads', 'p', 'friends', 'subscriptions', 'subs', 'inventory', 'wallet', 'drops', 'moderator', 'u', 'popout', 'embed', 'turbo', 'prime', 'messages', 'payments', 'store', 'jobs', 'signup', 'login', 'logout', 'team', 'broadcast', 'following', 'clips', 'collections', 'event', 'bits', 'activate', 'redeem', 'giftcard', 'checkout']);
  function getChannelFromLocation() {
    try {
      if (location.hostname === 'player.twitch.tv') {
        const channel = (new URLSearchParams(location.search).get('channel') || '').toLowerCase();
        return LOGIN_RE.test(channel) ? channel : null;
      }
      const parts = location.pathname.split('/').filter(Boolean);
      let login = (parts[0] || '').toLowerCase();
      if (login === 'popout' || login === 'moderator') login = (parts[1] || '').toLowerCase();// /popout/<channel>/..., /moderator/<channel>
      return LOGIN_RE.test(login) && !RESERVED_ROUTES.has(login) ? login : null;
    } catch {
      return null;
    }
  }

  const isAllowlisted = channel => {
    try {
      return !!channel && typeof window.getVaftAllowlist === 'function' && window.getVaftAllowlist().includes(channel);
    } catch {
      return false;
    }
  };

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  const percent = new Intl.NumberFormat(fr ? 'fr-FR' : 'en-US', { style: 'percent' });
  const relative = (() => { try { return new Intl.RelativeTimeFormat(fr ? 'fr' : 'en', { numeric: 'auto', style: 'short' }); } catch { return null; } })();
  function timeAgo(at) {
    // "il y a 3 min" / "3 min ago"; empty if the browser has no Intl.RelativeTimeFormat.
    const s = Math.max(0, Math.round((Date.now() - Number(at)) / 1000));
    if (!relative || !Number.isFinite(s)) return '';
    if (s < 60) return relative.format(-s, 'second');
    if (s < 3600) return relative.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return relative.format(-Math.round(s / 3600), 'hour');
    return relative.format(-Math.round(s / 86400), 'day');
  }

  // What the streamer gets, as orders of magnitude: Twitch publishes no ad rates. 2026 figures:
  // creators get 55 % of ad revenue, reported as 1 to 5 € per 1000 ads (ads last about 30 s).
  // A Tier 1 sub costs 4.99 € in France; the streamer gets 50 % of the price before VAT (20 %),
  // up to 70 % in Twitch's Plus Program.
  const EARNINGS = { adEuros: [0.001, 0.0025, 0.005], adSeconds: 30, subPrice: 4.99, vatRate: 0.2, subShare: 0.5 };
  function estimateAds(stats) {
    // Ads in the blocked breaks: about one per 30 s of ad, at least one per break.
    const breaks = Math.floor(Number(stats?.breaks)) || 0;
    const seconds = Number(stats?.seconds) || 0;
    return Math.max(0, breaks, Math.round(seconds / EARNINGS.adSeconds));
  }
  function subEarnings(share = EARNINGS.subShare) {
    return Math.round(EARNINGS.subPrice / (1 + EARNINGS.vatRate) * share * 100) / 100;
  }
  function formatEuros(euros, french) {
    // Under 1 € in cents (0,25 centime, 42 centimes), else in euros (2,08 €).
    const lang = french ? 'fr-FR' : 'en-US';
    const cents = Math.max(0, Number(euros) || 0) * 100;
    if (cents >= 99.5) return new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' }).format(cents / 100);
    const text = new Intl.NumberFormat(lang, cents < 10 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 0 }).format(cents);
    const shown = Number(text.replace(',', '.'));
    // French: singular below 2 (0,5 centime); English: singular for exactly 1.
    if (french) return `${text} ${shown < 2 ? 'centime' : 'centimes'}`;
    return `${text} ${shown === 1 ? 'cent' : 'cents'}`;
  }

  // State from the core: version once, ad breaks and self-check warnings from its events.
  const core = (() => { try { return window.vaftStatus?.() || {}; } catch { return {}; } })();
  const version = String(core.version || '');
  const adChannels = new Map();// channel -> backup player type while an ad is blocked
  const warnings = new Map();// self-check code -> message
  if (core.showingAd && core.channel) adChannels.set(core.channel, core.backupPlayerType || null);
  (core.health?.warnings || []).forEach(w => w?.code && warnings.set(w.code, String(w.message || w.code)));

  const ui = { box: null, panel: null, toggle: null, open: false, resetArmedUntil: 0, removeArmed: null, placeQueued: false, tab: 'ads' };
  // Panel tabs; the last one used is remembered for this viewer only (a convenience, may be unavailable).
  const TABS = ['ads', 'support', 'quality'];
  const TAB_KEY = 'vaftPanelTab';
  try { const saved = localStorage.getItem(TAB_KEY); if (TABS.includes(saved)) ui.tab = saved; } catch {}

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    });
    node.append(...children);
    return node;
  }
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  const setAttr = (node, name, value) => { if (node && node.getAttribute(name) !== value) node.setAttribute(name, value); };
  const part = name => ui.box?.querySelector(`[data-vaft="${name}"]`);

  function gearIcon() {
    // 8-tooth gear drawn from points (no external asset), center hole via even-odd.
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'vaft-gear');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    let d = '';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      [[6.9, -0.26], [9.3, -0.16], [9.3, 0.16], [6.9, 0.26]].forEach(([r, da], j) => {
        d += `${i || j ? 'L' : 'M'}${(10 + r * Math.cos(a + da)).toFixed(2)} ${(10 + r * Math.sin(a + da)).toFixed(2)}`;
      });
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', `${d}ZM12.8 10a2.8 2.8 0 1 0-5.6 0a2.8 2.8 0 1 0 5.6 0Z`);
    svg.append(path);
    return svg;
  }

  function segButton(kind, mode, label, title) {
    const b = h('button', { type: 'button', title, 'aria-pressed': 'false' }, label);
    b.dataset.kind = kind;
    b.dataset.mode = mode;
    return b;
  }

  function buildUi() {
    const box = h('div', { id: 'vaft-ad-mode', 'data-state': 'idle' });
    const toggle = h('button', { type: 'button', class: 'vaft-ind', 'data-vaft': 'toggle', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'vaft-panel' },
      h('span', { class: 'vaft-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'vaft-heart', 'aria-hidden': 'true' }, '♥'),
      h('span', { class: 'vaft-label', 'data-vaft': 'label' }, T.idleLabel),
      gearIcon());
    const select = h('select', { 'data-vaft': 'quality-pref', title: T.targetTitle, 'aria-label': `${T.quality} – ${T.target}` },
      h('option', { value: 'custom', 'data-vaft': 'custom', hidden: '' }, T.custom),
      ...QUALITY_LADDER.map(x => h('option', { value: x }, x + (x === PREF[0] ? T.def : ''))));
    const tab = (id, label) => h('button', { type: 'button', role: 'tab', class: 'vaft-tab', id: `vaft-tab-${id}`, 'data-vaft': 'tab', 'data-tab': id,
      'aria-controls': `vaft-pane-${id}`, 'aria-selected': 'false', tabindex: '-1' }, label);
    const pane = (id, ...children) => h('div', { class: 'vaft-pane', role: 'tabpanel', id: `vaft-pane-${id}`, 'aria-labelledby': `vaft-tab-${id}`, 'data-pane': id, tabindex: '0' }, ...children);
    const row = (label, value) => h('div', { class: 'vaft-row' }, h('span', null, label), value);
    const adsPerSub = new Intl.NumberFormat(fr ? 'fr-FR' : 'en-US', { maximumSignificantDigits: 2 }).format(subEarnings() / EARNINGS.adEuros[1]);
    const panel = h('div', { id: 'vaft-panel', role: 'dialog', 'aria-label': T.settings, tabindex: '-1', hidden: '' },
      h('div', { class: 'vaft-head' },
        h('span', null, APP_NAME, ' ', h('span', { class: 'vaft-ver' }, version)),
        h('button', { type: 'button', class: 'vaft-close', 'data-vaft': 'close', title: T.close, 'aria-label': T.close }, '×')),
      h('div', { class: 'vaft-warn', 'data-vaft': 'warn', hidden: '' },
        h('p', { 'data-vaft': 'warn-text' }),
        h('a', { href: ISSUES_URL, target: '_blank', rel: 'noopener noreferrer' }, T.report)),
      // The channel on screen: always visible, above the tabs.
      // Toggle button: its name stays "Support <channel>", the state line is its description (aria-pressed has the state).
      h('button', { type: 'button', class: 'vaft-allow', 'data-vaft': 'allow', 'aria-pressed': 'false', 'aria-labelledby': 'vaft-allow-name', 'aria-describedby': 'vaft-allow-hint' },
        h('span', { class: 'vaft-allow-icon', 'data-vaft': 'allow-icon', 'aria-hidden': 'true' }, '♡'),
        h('span', { class: 'vaft-allow-text' },
          h('span', { class: 'vaft-allow-name', id: 'vaft-allow-name', 'data-vaft': 'allow-name' }, T.allow),
          h('span', { class: 'vaft-allow-sub', id: 'vaft-allow-hint', 'data-vaft': 'allow-hint' })),
        h('span', { class: 'vaft-switch', 'aria-hidden': 'true' })),
      h('div', { class: 'vaft-tabs', role: 'tablist', 'aria-label': T.tabs }, tab('ads', T.ads), tab('support', T.support), tab('quality', T.quality)),
      h('div', { class: 'vaft-body' },
        pane('ads',
          row(T.session, h('span', { class: 'vaft-num', 'data-vaft': 'stats-session' })),
          row(T.total, h('span', { class: 'vaft-num', 'data-vaft': 'stats-total' })),
          h('div', { class: 'vaft-row vaft-hint' }, h('span', { 'data-vaft': 'stats-since' }),
            h('button', { type: 'button', class: 'vaft-link', 'data-vaft': 'reset', title: T.resetTitle }, T.reset)),
          h('p', { class: 'vaft-h' }, T.lastAd),
          h('div', { class: 'vaft-row' }, h('span', { 'data-vaft': 'last-where' }), h('span', { class: 'vaft-num', 'data-vaft': 'last-len' })),
          h('p', { class: 'vaft-hint', 'data-vaft': 'last-how' }),
          h('p', { class: 'vaft-h', title: T.methodsTitle }, T.methods),
          row(T.mFull, h('span', { class: 'vaft-num', 'data-vaft': 'm-full' })),
          row(T.mLow, h('span', { class: 'vaft-num', 'data-vaft': 'm-low' })),
          row(T.mStrip, h('span', { class: 'vaft-num', 'data-vaft': 'm-strip' })),
          h('div', { class: 'vaft-row', title: T.bannerTitle }, h('span', null, T.banners), h('span', { class: 'vaft-num', 'data-vaft': 'banners' }))),
        pane('support',
          h('div', { class: 'vaft-tiles' },
            h('div', { class: 'vaft-tile' }, h('span', null, T.given), h('b', { 'data-vaft': 'earn-given' })),
            h('div', { class: 'vaft-tile' }, h('span', null, T.lost), h('b', { 'data-vaft': 'earn-lost' }))),
          h('div', { class: 'vaft-hrow' },
            h('p', { class: 'vaft-h', 'data-vaft': 'supported-title', title: T.supportedHint }, T.supported(0)),
            h('p', { class: 'vaft-h', 'data-vaft': 'earned-h', 'aria-hidden': 'true' }, T.earned)),
          // Fixed height (3.5 rows, scrolls): adding or removing a channel never resizes the panel.
          h('div', { class: 'vaft-list', 'data-vaft': 'supported' }),
          h('p', { class: 'vaft-hint vaft-refs', 'data-vaft': 'earn', title: T.refsTitle(formatEuros(EARNINGS.adEuros[0], fr), formatEuros(EARNINGS.adEuros[2], fr)) },
            h('b', null, T.notExact), ' ',
            `${T.refs(formatEuros(EARNINGS.adEuros[1], fr), formatEuros(EARNINGS.subPrice, fr), formatEuros(subEarnings(), fr), adsPerSub)} `,
            h('a', { href: EARN_URL, target: '_blank', rel: 'noopener noreferrer' }, T.details))),
        pane('quality',
          row(T.auto, h('span', { class: 'vaft-seg', role: 'group', 'aria-label': `${T.quality} ${T.auto}` },
            segButton('quality', 'on', T.on, T.tOn), segButton('quality', 'off', T.off, T.tOff))),
          h('div', { class: 'vaft-row', 'data-vaft': 'quality-rows' }, h('span', null, T.target), select),
          h('p', { class: 'vaft-hint', 'data-vaft': 'quality-order' }),
          h('p', { class: 'vaft-h' }, T.nowPlaying),
          row(T.qNow, h('span', { class: 'vaft-num', 'data-vaft': 'q-now' }, '–')),
          // Same figures as Twitch's own "Video stats" overlay, read from its player.
          h('div', { class: 'vaft-stats' }, ...['bitrate', 'bandwidth', 'latency', 'buffer', 'dropped', 'size'].map(k =>
            h('div', { class: 'vaft-tile', title: T.statsTitle[k] }, h('span', null, T.stats[k]), h('b', { 'data-vaft': `q-${k}` }, '–')))),
          h('p', { class: 'vaft-hint vaft-offered', 'data-vaft': 'q-offered' }))),
      h('p', { class: 'vaft-sr', role: 'status', 'data-vaft': 'status' }));
    box.append(toggle, panel);
    box.addEventListener('click', onBoxClick);
    box.addEventListener('keydown', onTabKeyDown);
    box.addEventListener('keydown', e => {
      // A held Enter / Space must not confirm a × or Reset (or reopen the panel it just closed).
      if (e.repeat && (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('button')) e.preventDefault();
    });
    box.addEventListener('focusout', e => {
      // Keyboard focus left the pill and panel (Tab past the end): close, like a click outside. No
      // relatedTarget = window blur or a list row rebuilt under the focus: keep it open.
      if (ui.open && e.relatedTarget instanceof Node && !box.contains(e.relatedTarget)) closePanel(false);
    });
    box.addEventListener('change', e => {
      if (e.target?.dataset?.vaft === 'quality-pref' && e.target.value !== 'custom') setQualityTarget(e.target.value);
      update();
    });
    Object.assign(ui, { box, panel, toggle });
  }

  function onBoxClick(e) {
    const btn = e.target.closest?.('button');
    if (!btn || !ui.box.contains(btn)) return;
    // A double-click is one action: it must not arm and confirm a removal or a reset at once.
    if (e.detail > 1 && (btn.dataset.vaft === 'remove' || btn.dataset.vaft === 'reset')) return;
    if (btn.dataset.kind === 'quality') {
      if (typeof window.setAutoQuality === 'function') window.setAutoQuality(btn.dataset.mode);
      else try { localStorage.setItem('vaftAutoQuality', btn.dataset.mode === 'off' ? 'off' : 'on'); } catch {}
      if (btn.dataset.mode === 'on') rearmAutoQuality(true);
    } else if (btn.dataset.vaft === 'toggle') {
      if (ui.open) closePanel(false); else openPanel();
    } else if (btn.dataset.vaft === 'close') {
      closePanel(true);
    } else if (btn.dataset.vaft === 'tab') {
      selectTab(btn.dataset.tab, false);
    } else if (btn.dataset.vaft === 'allow') {
      const channel = getChannelFromLocation();
      if (channel && typeof window.toggleVaftAllowlist === 'function') window.toggleVaftAllowlist(channel);
    } else if (btn.dataset.vaft === 'remove') {
      // Two clicks within 4 s, like Reset: putting a channel back needs a visit to its page.
      const login = btn.dataset.login;
      if (ui.removeArmed?.login === login && ui.removeArmed.until > Date.now()) {
        ui.removeArmed = null;
        try { window.setVaftAllowlist?.((window.getVaftAllowlist?.() || []).filter(x => x !== login)); } catch {}
        announce(T.removed(login));
      } else {
        ui.removeArmed = { login, until: Date.now() + ARM_MS };
        setTimeout(update, ARM_MS + 30);// The label goes back exactly when the window closes
      }
    } else if (btn.dataset.vaft === 'reset') {
      // Two clicks within 4 s so a stray click cannot wipe the totals.
      if (ui.resetArmedUntil > Date.now()) {
        ui.resetArmedUntil = 0;
        window.resetVaftAdStats?.();
        announce(T.resetDone);
      } else {
        ui.resetArmedUntil = Date.now() + ARM_MS;
        setTimeout(update, ARM_MS + 30);
      }
    }
    update();
  }

  const ARM_MS = 4000;// Window for the second click of Reset and of a channel's ×
  // Screen readers: result of Reset / remove. Cleared first so the same sentence twice is spoken twice,
  // and cleared again after 5 s so nothing stale stays in the panel.
  let statusTimer = 0;
  const announce = text => {
    const node = part('status');
    if (!node) return;
    clearTimeout(statusTimer);
    node.textContent = '';
    if (text) statusTimer = setTimeout(() => { node.textContent = text; statusTimer = setTimeout(() => { node.textContent = ''; }, 5000); }, 100);
  };

  function selectTab(id, focus) {
    if (!TABS.includes(id)) return;
    ui.tab = id;
    try { localStorage.setItem(TAB_KEY, id); } catch {}
    renderTabs();
    if (id === 'quality') renderPlayback(getQualityPref());
    if (focus) ui.box?.querySelector(`[data-vaft="tab"][data-tab="${id}"]`)?.focus();
  }
  function onTabKeyDown(e) {
    // Tabs pattern: arrows / Home / End move between tabs (roving tabindex), Tab goes into the pane.
    const current = e.target.closest?.('[data-vaft="tab"]');
    if (!current || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;// Alt+arrows = browser history
    const i = TABS.indexOf(current.dataset.tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length], true);
  }
  function renderTabs() {
    ui.box?.querySelectorAll('[data-vaft="tab"]').forEach(b => {
      const on = b.dataset.tab === ui.tab;
      setAttr(b, 'aria-selected', String(on));
      setAttr(b, 'tabindex', on ? '0' : '-1');
    });
    // Inactive panes stay in the layout (same grid cell, hidden): the panel keeps one height for every tab.
    ui.box?.querySelectorAll('.vaft-pane').forEach(p => {
      const off = p.dataset.pane !== ui.tab;
      if (p.hasAttribute('data-off') !== off) p.toggleAttribute('data-off', off);
    });
  }

  function onDocPointerDown(e) {
    if (ui.box && !e.composedPath().includes(ui.box)) closePanel(false);
  }
  function onDocKeyDown(e) {
    if (e.key !== 'Escape') return;
    // From inside the panel: ours, focus back on the pill. Meant for the page (a Twitch menu, the
    // player): still reaches it, and only closes the panel.
    const inside = !!ui.box?.contains(e.target) || e.target === document.body;
    if (inside) e.stopPropagation();
    closePanel(inside);
  }
  function queuePlace(e) {
    // Only scrolls that move the anchor (not chat auto-scroll) and resizes.
    if (e?.type === 'scroll' && e.target !== document && !(e.target instanceof Node && e.target.contains(ui.box))) return;
    if (ui.placeQueued) return;
    ui.placeQueued = true;
    requestAnimationFrame(() => { ui.placeQueued = false; placePanel(); });
  }
  function setDocListeners(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', onDocPointerDown, true);
    document[method]('keydown', onDocKeyDown, true);
    document[method]('scroll', queuePlace, true);
    window[method]('resize', queuePlace);
  }

  function openPanel() {
    if (!ui.box) return;
    ui.open = true;
    ui.panel.hidden = false;
    setAttr(ui.toggle, 'aria-expanded', 'true');
    setDocListeners(true);
    render();
    placePanel();
    try { ui.panel.focus({ preventScroll: true }); } catch {}
  }

  function closePanel(restoreFocus) {
    setDocListeners(false);
    if (!ui.open) return;
    ui.open = false;
    ui.resetArmedUntil = 0;
    ui.removeArmed = null;
    announce('');
    if (ui.panel) ui.panel.hidden = true;
    setAttr(ui.toggle, 'aria-expanded', 'false');
    if (restoreFocus && ui.toggle?.isConnected) try { ui.toggle.focus({ preventScroll: true }); } catch {}
  }

  function placePanel() {
    // position:fixed so Twitch's overflow:hidden containers cannot clip it; kept on screen.
    const { box, panel } = ui;
    if (!ui.open || !box || !panel) return;
    const r = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    if (!box.isConnected || !r.width || r.bottom < 0 || r.top > vh) { closePanel(false); return; }
    panel.style.width = `${Math.min(320, vw - 16)}px`;
    const pw = panel.offsetWidth;
    // Under the pill if it fits, else above; if neither fits, the side with more room, height capped
    // there (the panel scrolls) so it does not cover the pill (in a window under ~300 px tall it may a
    // little: the panel keeps at least 120 px). Natural height = scrollHeight + borders.
    const natural = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    const below = vh - 8 - (r.bottom + 6);
    const above = r.top - 6 - 8;
    const up = natural > below && (natural <= above || above > below);
    const room = Math.max(Math.min(120, vh - 16), up ? above : below);
    const cap = natural > room ? `${room}px` : '';
    if (panel.style.maxHeight !== cap) panel.style.maxHeight = cap;
    const ph = Math.min(natural, room);
    const left = Math.max(8, Math.min(r.right - pw, vw - pw - 8));
    const top = Math.max(8, Math.min(up ? r.top - 6 - ph : r.bottom + 6, vh - 8 - ph));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    // A transformed ancestor makes fixed positioning relative to it: correct by the measured offset.
    const pr = panel.getBoundingClientRect();
    if (Math.abs(pr.left - left) > 1 || Math.abs(pr.top - top) > 1) {
      panel.style.left = `${2 * left - pr.left}px`;
      panel.style.top = `${2 * top - pr.top}px`;
    }
  }

  function render() {
    const { box } = ui;
    if (!box) return;
    const channel = getChannelFromLocation();
    const allowlisted = isAllowlisted(channel);
    const qMode = isAutoQualityOn() ? 'on' : 'off';
    box.querySelectorAll('button[data-kind="quality"]').forEach(b => setAttr(b, 'aria-pressed', String(b.dataset.mode === qMode)));

    // Inline indicator: warning > ad being blocked > channel allowlisted > idle.
    // Only for this page's channel: entries of a channel left mid-ad must not show on VOD/directory pages.
    const adOnPage = !!channel && adChannels.has(channel);
    const backup = adOnPage ? adChannels.get(channel) : null;
    const backupLabel = backup ? (backup === 'autoplay' ? '360p (autoplay)' : `Source (${backup})`) : '';
    const state = warnings.size ? 'warn' : adOnPage ? 'ad' : allowlisted ? 'allow' : 'idle';
    const label = { warn: T.warnLabel, ad: T.adLabel, allow: T.allowLabel, idle: T.idleLabel }[state];
    const title = {
      warn: [...warnings.values()].join(' '),
      ad: T.adTitle(backupLabel),
      allow: T.allowStateTitle(channel),
      idle: (version ? `${APP_NAME} ${version} – ` : '') + T.idleTitle
    }[state];
    setAttr(box, 'data-state', state);
    setText(part('label'), label);
    setAttr(ui.toggle, 'title', `${title} ${T.clickHint}`);
    setAttr(ui.toggle, 'aria-label', `${label} – ${T.settings}`);
    if (ui.open) renderPanel(channel, allowlisted, qMode);
  }

  function renderPanel(channel, allowlisted, qMode) {
    const warn = part('warn');
    warn.hidden = !warnings.size;
    setText(part('warn-text'), [...warnings.values()].join(' '));

    const allow = part('allow');
    allow.disabled = !channel;
    setAttr(allow, 'aria-pressed', String(allowlisted));
    setAttr(allow, 'title', channel ? T.allowTitle(channel) : T.noChannel);
    setText(part('allow-icon'), allowlisted ? '♥' : '♡');
    setText(part('allow-name'), channel ? T.allowName(channel) : T.allow);
    setText(part('allow-hint'), !channel ? T.noChannel : allowlisted ? T.allowOn : T.allowOff);
    renderTabs();

    let stats = null;
    try { stats = window.getVaftAdStats?.(); } catch {}
    const line = s => `${T.breaks(Number(s?.breaks) || 0)} · ${formatDuration(s?.seconds)}`;
    setText(part('stats-session'), line(stats?.session));
    setText(part('stats-total'), line(stats));
    let since = '';
    try { if (stats?.since) since = T.since(new Date(stats.since).toLocaleDateString(navigator.language || undefined)); } catch {}
    setText(part('stats-since'), since);
    const last = stats?.lastAd;
    setText(part('last-where'), last ? `${last.channel} · ${timeAgo(last.at)}` : T.noAd);
    setText(part('last-len'), last ? `${last.midroll ? T.midroll : T.preroll} · ${formatDuration(last.seconds)}` : '');
    setText(part('last-how'), last ? T.how[last.method || 'none'] : '');
    const methods = stats?.methods || {};
    const methodTotal = ['full', 'low', 'strip'].reduce((sum, k) => sum + (Number(methods[k]) || 0), 0);
    for (const k of ['full', 'low', 'strip']) {
      const seconds = Number(methods[k]) || 0;
      setText(part(`m-${k}`), methodTotal > 0 ? percent.format(seconds / methodTotal) : '–');
      setAttr(part(`m-${k}`), 'title', formatDuration(seconds));
    }
    let display = null;
    try { display = window.vaftStatus?.().displayAds?.state; } catch {}
    setText(part('banners'), T.bannerState[display] || '–');
    const amount = ads => ads > 0 ? `≈ ${formatEuros(ads * EARNINGS.adEuros[1], fr)}` : formatEuros(0, fr);
    const blockedAds = estimateAds(stats);
    setText(part('earn-lost'), amount(blockedAds));
    setAttr(part('earn-lost'), 'title', T.lostTitle(blockedAds));

    let supported = [];
    let watched = {};
    try { supported = window.getVaftAllowlist?.() || []; } catch {}
    try { watched = window.getVaftWatchedAds?.() || {}; } catch {}
    const watchedAds = Object.fromEntries(Object.entries(watched).map(([login, s]) => [login, estimateAds(s)]));
    setText(part('supported-title'), T.supported(supported.length));
    part('earned-h').hidden = !supported.length;
    renderSupported(supported, watchedAds);
    const givenAds = Object.values(watchedAds).reduce((sum, n) => sum + n, 0);
    setText(part('earn-given'), amount(givenAds));
    setAttr(part('earn-given'), 'title', T.givenTitle(givenAds));
    const resetArmed = ui.resetArmedUntil > Date.now();
    if (!resetArmed) ui.resetArmedUntil = 0;
    setText(part('reset'), resetArmed ? T.resetConfirm : T.reset);

    const pref = getQualityPref();
    const target = QUALITY_LADDER.find(x => qualityPrefForTarget(x).join() === pref.join());
    const custom = part('custom');
    custom.hidden = !!target;
    setText(custom, `${T.custom}: ${pref.join(' › ')}`);
    const select = part('quality-pref');
    if (select.value !== (target || 'custom')) select.value = target || 'custom';
    setText(part('quality-order'), T.order(pref.join(' › ')));
    if (ui.tab === 'quality') renderPlayback(pref);
    part('quality-rows').classList.toggle('vaft-off', qMode === 'off');
    part('quality-order').classList.toggle('vaft-off', qMode === 'off');
  }

  const oneDecimal = new Intl.NumberFormat(fr ? 'fr-FR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function codecName(codecs) {
    const video = String(codecs || '').split(',')[0].trim().toLowerCase();
    if (video.startsWith('avc')) return 'H.264';
    if (video.startsWith('hev') || video.startsWith('hvc')) return 'HEVC';
    if (video.startsWith('av01')) return 'AV1';
    return '';
  }
  function renderPlayback(pref) {
    // Quality tab, read from Twitch's player only while that tab is shown.
    let info = null;
    try { info = window.vaftGetPlaybackInfo?.(); } catch {}
    const isNum = value => typeof value === 'number';
    const mbps = value => value ? `${oneDecimal.format(value / 1e6)} ${T.mbps}` : '–';
    const codec = codecName(info?.codecs);
    setText(part('q-now'), info?.quality ? `${info.quality}${info.source ? T.sourceTag : ''}${codec ? ` · ${codec}` : ''}` : '–');
    setText(part('q-size'), info?.width && info?.height ? `${info.width}×${info.height}` : '–');
    setText(part('q-bitrate'), mbps(info?.bitrate));
    setText(part('q-bandwidth'), mbps(info?.bandwidth));
    const mode = info?.lowLatency === true ? T.lowLatency : info?.lowLatency === false ? T.normalLatency : '';
    setText(part('q-latency'), isNum(info?.latency) ? `${oneDecimal.format(info.latency)} s${mode ? ` · ${mode}` : ''}` : '–');
    setText(part('q-buffer'), isNum(info?.buffer) ? `${oneDecimal.format(info.buffer)} s` : '–');
    setText(part('q-dropped'), isNum(info?.dropped) ? String(Math.round(info.dropped)) : '–');
    const offered = [...new Set((info?.available || []).filter(name => !/^auto/i.test(name)))];
    const target = pref?.[0];
    const missing = offered.length && target && !offered.some(name => name.split(' ')[0] === target) ? target : '';
    setText(part('q-offered'), offered.length ? T.offered(offered.join(' · '), missing) : '');
  }

  function renderSupported(list, watchedAds) {
    // One row per allowlisted channel: link, estimated support from the ads watched there, remove (2 clicks).
    const box = part('supported');
    if (ui.removeArmed && ui.removeArmed.until <= Date.now()) ui.removeArmed = null;
    const rows = list.map(login => {
      const ads = Object.prototype.hasOwnProperty.call(watchedAds, login) ? watchedAds[login] : 0;
      return { login, ads, armed: ui.removeArmed?.login === login };
    });
    const sig = JSON.stringify(rows);
    if (box.dataset.sig === sig) return;
    // Keyboard focus survives the rebuild: same control of the same channel, else the × now at that
    // position (that channel was removed), else the Support tab. Logins are [a-z0-9_]: safe in selectors.
    const active = document.activeElement;
    const had = box.contains(active) ? { kind: active.dataset.vaft, login: active.dataset.login, index: [...box.children].indexOf(active.closest('.vaft-row')) } : null;
    box.dataset.sig = sig;
    box.replaceChildren(...(rows.length ? rows.map(r => {
      const label = r.armed ? T.removeArmed(r.login) : T.remove(r.login);
      const remove = h('button', { type: 'button', class: 'vaft-x', 'data-vaft': 'remove', 'data-login': r.login, title: label, 'aria-label': label }, r.armed ? T.removeConfirm : '×');
      if (r.armed) remove.dataset.armed = '';
      return h('div', { class: 'vaft-row', 'data-login': r.login },
        h('a', { class: 'vaft-chan', 'data-vaft': 'chan', 'data-login': r.login, href: `https://www.twitch.tv/${r.login}`, title: r.login }, r.login),
        h('span', { class: 'vaft-num', title: T.watchedTitle(r.ads) }, r.ads ? `≈ ${formatEuros(r.ads * EARNINGS.adEuros[1], fr)}` : '–'),
        remove);
    }) : [h('p', { class: 'vaft-hint' }, T.supportedEmpty)]));
    if (had) {
      const same = had.login && box.querySelector(`[data-vaft="${had.kind}"][data-login="${had.login}"]`);
      const near = had.index >= 0 ? box.children[Math.min(had.index, box.children.length - 1)]?.querySelector('[data-vaft="remove"]') : null;
      (same || near || ui.box.querySelector('[data-vaft="tab"][data-tab="support"]'))?.focus();
    }
  }

  function syncAllowAttr() {
    try {
      const root = document.documentElement;
      const on = isAllowlisted(getChannelFromLocation());
      if (root.hasAttribute('data-vaft-allow') !== on) root.toggleAttribute('data-vaft-allow', on);
    } catch {}
  }

  function update() {
    syncAllowAttr();
    if (!ui.box || !ui.box.isConnected || isHidden()) return;
    try {
      render();
      if (ui.open) placePanel();
    } catch (error) {
      console.debug('[vaft] UI update failed', error);
    }
  }

  // Where the pill goes: first in the channel header (left of Follow / Bits / Subscribe),
  // else before the Share button under the player (theater mode, header not rendered yet...).
  function uiAnchor() {
    const header = q('[data-target="channel-header-right"]');
    if (header) return { parent: header, ref: header.firstChild, where: 'header' };
    const share = q('[data-a-target="share-button"]');
    if (share?.parentNode) return { parent: share.parentNode, ref: share, where: 'share' };
    return null;
  }

  function ensureUi() {
    if (typeof window.vaftIsDocumentHidden === 'function' && window.vaftIsDocumentHidden()) return;
    syncAllowAttr();
    try {
      const anchor = uiAnchor();
      if (ui.box?.isConnected && (!anchor || ui.box.parentNode === anchor.parent)) { update(); return; }
      if (!anchor || typeof window.setAdBackupMode !== 'function') { closePanel(false); return; }
      const existing = document.getElementById('vaft-ad-mode');
      if (existing && existing !== ui.box) return;// Another copy of this script owns the UI
      if (!ui.box) buildUi();
      if (ui.open) closePanel(false);// Moving the pill would leave the open panel misplaced
      anchor.parent.insertBefore(ui.box, anchor.ref === ui.box ? ui.box.nextSibling : anchor.ref);
      ui.box.dataset.anchor = anchor.where;
      update();
    } catch (error) {
      console.debug('[vaft] UI mount failed', error);
    }
  }

  window.addEventListener('vaft-ad-state', (e) => {
    const d = e.detail || {};
    if (d.channel) {
      if (d.showingAd) adChannels.set(d.channel, d.backupPlayerType || null);
      else adChannels.delete(d.channel);
    }
    if (d.showingAd) warnings.clear();// Playlists reach vaft again: the self-check warning no longer applies
    update();
  });
  window.addEventListener('vaft-health', (e) => {
    const d = e.detail || {};
    if (d.code) warnings.set(String(d.code), String(d.message || d.code));
    update();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === QUALITY_PREF_KEY) memQualityPref = null;
    if (e.key === null || e.key === 'vaftAutoQuality' || e.key === QUALITY_PREF_KEY) {
      if (e.key !== 'vaftAutoQuality' || e.newValue !== 'off') rearmAutoQuality();
    }
    if (e.key === null || ['vaftAutoQuality', 'adBackupMode', QUALITY_PREF_KEY, 'vaftAllowlist', 'vaftAdStats', 'vaftWatchedAds'].includes(e.key)) update();
  });

  setInterval(ensureUi, 1000);

  try {
    if (isAutoQualityOn() && Math.max(...getQualityPref().map(qualityHeight)) >= 1080) localStorage.setItem('video-quality', JSON.stringify({ default: 'chunked' }));
  } catch {}

  let busy = false;
  setInterval(async () => {
    if (typeof window.vaftIsDocumentHidden === 'function' && window.vaftIsDocumentHidden()) return;
    const autoOn = isAutoQualityOn();
    if (!autoOn) return;
    const v = window.vaftGetPlayerVideoElement?.();
    if (busy || !v) return;
    if (location.href !== lastUrl) { lastUrl = location.href; done = false; }
    if (q('.adblock-overlay')?.style.display === 'block') { done = false; return; }
    const pref = getQualityPref();
    if (!shouldSwitchQuality(autoOn, done, v.readyState, v.videoHeight, pref, forceAttempt)) return;
    busy = true;
    const attempt = armId;
    try {
      await setQuality(pref);
    } catch (error) {
      console.debug('[vaft] auto-quality attempt failed', error);
    } finally {
      if (attempt === armId) { done = true; forceAttempt = false; }// Re-armed meanwhile (pref changed): try again
      busy = false;
    }
  }, 3000);
})();
