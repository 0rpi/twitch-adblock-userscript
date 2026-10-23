# Changelog

All notable changes to `twitch-adblock.user.js`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the public `@version` (Violentmonkey/Tampermonkey auto-update). `ourTwitchAdSolutionsVersion = 24` is an internal vaft mutex, not a release number.

Release: bump `@version` (and `SCRIPT_VERSION`, same value), date this section as `## [X.Y.Z] - YYYY-MM-DD`, `npm test`, commit, `git tag vX.Y.Z`, push the tag. `.github/workflows/release.yml` checks tag = `@version`, refuses an undated section or one that still contains `TODO`, and publishes this section as the GitHub Release notes.

## [38.0.0] - 2026-10-23

Major bump for a fresh start of this fork's numbering (versions keep increasing so existing installs still auto-update). Hardening ported from [Wibias/twitch-adblock-userscript](https://github.com/Wibias/twitch-adblock-userscript), display ad declining from [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock), plus new opt-in features.

### Added

- Settings panel: the old inline buttons are now one pill in the channel header, left of Follow / Bits / Subscribe (before the Share button when the header is not shown, e.g. theater mode) (status dot, label, gear). Click opens a popover (closes on Escape, outside click or `×`): the version, the self-check warning, a "Support <channel>" switch for the channel on screen, then three tabs (keyboard: arrows, Home, End; the last tab is remembered): Ads (blocked stats, Reset; the last ad blocked with its channel, time, pre-roll or mid-roll, length and what replaced it; the share of blocked ad time spent on an ad-free copy at full quality, in 360p, or cut out with a black screen (`localStorage:vaftAdMethods`, `vaftLastAd`, also in `getVaftAdStats()`); banner ads state), Support (what the streamer gets, supported channels, one ad vs one sub, marked as estimates) and Quality (Auto On | Off, target; now playing, with the figures of Twitch's own Video stats overlay: quality and codec, bitrate, bandwidth estimate, delay behind live and latency mode, buffer, dropped frames, resolution, and the qualities the stream offers, with a note when the target is not one of them; the <video> element fills in resolution, buffer and dropped frames when Twitch's player is not found; console `vaftGetPlaybackInfo()`, whose `missing` lists the player methods not found). The panel keeps one height whatever the tab, so nothing moves under the mouse. French when the browser language is French, English otherwise. Pill states: idle ("Ad block on" / "Anti-pub actif"; the panel is titled "Twitch Adblock", not vaft), ad being blocked on this channel (tooltip names the backup stream), channel allowlisted, self-check warning.
- Quality target (`localStorage:vaftQualityPref`, preferred order): 1440p60 (default, same order as before: 1440p60 > 1080p60 > 1440p > 1080p), 1080p60, 1440p, 1080p, 720p60, 720p. Changing the target, or switching Auto back on, forces one switch right away.
- Channel allowlist, empty by default (`localStorage:vaftAllowlist`, lowercase logins, synced across tabs): on a listed channel vaft keeps Twitch's own access token and usher parameters, does not swap or strip the ad, and leaves Twitch's ad label/countdown and `media-amazon.com` ad videos alone, so ads play and the streamer is paid. Toggling the channel on screen reloads the player so the new token applies; the worker drops the master playlist it cached under the old setting. Console: `getVaftAllowlist()`, `setVaftAllowlist([...])` (array only, replaces the list), `toggleVaftAllowlist(login?)` (no argument = current channel), `vaftGetCurrentChannel()`.
- Ad stats: breaks and seconds blocked, total (`localStorage:vaftAdStats`, tabs add up) and per page, shown in the panel. One break per ad even with several workers or repeated playlist messages; time comes from message gaps (10 s cap), so it is an estimate. A break with no update for 60 s, or left for another channel, ends. Console: `getVaftAdStats()`, `resetVaftAdStats()`; window event `vaft-ad-state` (`{ showingAd, channel, backupPlayerType, stats }`).
- What the streamer gets, in the panel's Support tab (README section too, EN + FR): about 0.25 cent per ad watched (range 0.1 to 0.5 cent: Twitch publishes no ad rates; creators get 55% of ad revenue), €2.08 per Tier 1 sub (€4.99 in France, 50% of the price before 20% VAT; up to 70% in Twitch's Plus Program), so one sub ≈ 830 ads, and the estimated amount the blocked ads would have paid (one ad per 30 s of ad blocked, at least one per break). Orders of magnitude, not exact amounts; shown in cents under €1.
- Supported channels list in the panel's Support tab: the allowlist, one row per channel (link to the channel, estimated amount from the ads watched there, × to remove it, asked once before removing; fixed height, it scrolls, so the panel never resizes). Ads watched on allowlisted channels are now counted per channel (`localStorage:vaftWatchedAds`, never as blocked; the worker reports `watchingAd` when Twitch's ad is in an allowlisted channel's playlist; client-side ad videos are not counted) and add up in the "Given (ads watched)" tile. Reset clears them too (its confirmation says so). Console: `getVaftWatchedAds()`; `vaftStatus().watchedAds`.
- Self-check: after 30 s of visible live playback on a channel page with no playlist going through vaft, one bilingual `console.warn` per page load (`worker-not-hooked` or `no-worker-messages`), an orange pill with a report link, the window event `vaft-health` and `vaftStatus().health` (`workerHooked`, `lastWorkerMessageAt`, `warnings`).
- `vaftStatus()` console helper: script version, hooked worker count, ad fallback mode, auto-quality mode, allowlist, display ad state, health, ad stats, and the live ad state reported by the worker (channel, ad showing, allowlisted, backup player type, stripping, stripped segment count, midroll, last update).
- Display ads (banner under the player, "squeezeback" that shrinks the stream to make room for it, ad pod above chat) are declined at the source: vaft finds Twitch's client-side ad manager through webpack's module registry (by its `startProcessingRequests` / `declineReason` markers, no hardcoded module id; every `webpackChunk*` registry, string chunk id so FrankerFaceZ's push wrapper is fine) and calls its own `decline('player_size', { sendEvent: false })`, so the request for the creative is never made and the stream is never shrunk. A Twitch module is never run before all its dependencies are loaded (running it early would leave a broken entry in webpack's cache; numeric ids, e-notation included, as FrankerFaceZ does; no regex lookbehind, for older Safari); one Twitch already ran is taken from the cache. Allowlisted channels (also in Mod View `/moderator/<login>` and `/popout/<login>/…`) get display ads back: only vaft's own decline is undone, a decline Twitch made itself (Turbo, or the same reason later) is never touched; the policy follows SPA navigation at once (`history.pushState`/`replaceState`/`popstate`). Fallback when the decline does not take: the banner wrapper (`[data-test-selector="sda-wrapper"]`, `.stream-display-ad__wrapper`, a sibling of the video) is hidden by CSS off the allowlist and a lower-third ad's shrunk player gets its full height back (a squeezeback stream may stay shrunk); the `:has()` selector now has a rule of its own, so browsers without `:has()` keep every other hiding rule. Lookup every 500 ms for 2 min, then every 10 s; one `console.warn` on www.twitch.tv after 2 min. Off switch for troubleshooting: `localStorage.setItem('vaftDeclineDisplayAds', 'off')` then reload (no webpack lookup at all; the CSS fallback stays on). `vaftStatus().displayAds` (`state`: `searching`, `declined`, `allowed`, `twitch`, `off`, `not-found`, `failed`, `stuck`). Approach from [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock) (MIT).
- Standalone ad `<video>` elements served from `media-amazon.com` are hidden and muted (restored if they stop being ads, or on allowlisted channels, Mod View and popouts included), and are never picked as the player video.
- Tooling (no effect on the script): `package.json` (`npm test`, `npm run lint`, `npm run smoke`, `npm run test:tooling`), ESLint flat config with a `vaft/worker-scope` rule (worker-injected functions may only use worker globals and injected helpers), `check.js` rewritten around the real functions, synthetic HLS fixtures and a run of the real worker blob, offline Playwright smoke test (fake `www.twitch.tv`, fake HLS/GQL, real worker injection) in CI, weekly live smoke test on twitch.tv, issue templates, tag-driven release workflow, weekly upstream/fork watcher, this changelog.

### Changed

- README rewritten for users (install, what it does, settings, common problems; EN + FR). The technical notes (internals, storage keys, console commands, development, limits) moved to `docs/TECHNICAL.md`.
- Backup feeds: `mobile_feed`, asked as an Android client, is tried first (reported ad-free at full quality by [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock); the same type asked as web comes back with the ad), then `embed`, `popout`, and `autoplay` (360p, Android, not in Source mode). If `mobile_feed` comes back with the ad, the next type is tried as before; the stripped fallback is still `embed`. Fewer black screens during ads.
- The 360p | Source buttons are gone from the panel: with `mobile_feed` first, the 360p copy is only an automatic last resort (used when every full-quality copy carries the ad, instead of a black screen). A Source choice made with those buttons (37.x) is dropped once on the first 38.0 load (`localStorage:vaftBackupModeReset`), so nobody stays in Source mode with no visible way back; `setAdBackupMode('source')` in the console still works and is kept afterwards.
- `@match` is now `*://www.twitch.tv/*`, `*://m.twitch.tv/*` and `*://player.twitch.tv/*` (was `*://*.twitch.tv/*`): the script no longer runs on other subdomains (dashboard, clips, help...).
- Codec families: variants are classified as AVC / HEVC / AV1 / unknown (missing `CODECS` is safe). The backup feed keeps the current codec family when possible, then the exact resolution and frame rate, then the closest resolution. The HEVC handling (modified master playlist, player reload on ad) now also covers AV1.
- Page fetch hook accepts `Request` / `URL` inputs and any `HeadersInit` (read via `Headers`: a `Headers` object or a GQL call without `init` no longer breaks it), never mutates the caller's `init`, and ignores a malformed `PlaybackAccessToken` body instead of throwing.
- Worker GQL requests relayed through the page time out after 15 s (`WorkerFetchTimeoutMs`) instead of waiting forever.
- `RequestedAds` per stream is capped at 100 entries; terminated or dead workers are dropped from the worker set.
- Auto quality makes one attempt per page (and again after each ad), even when no option of the order exists: no more settings-menu loop. The quality buttons read On | Off (Oui | Non) instead of Auto | Off; the stored values are unchanged.
- Twitch's saved quality is preset to Source on load only when Auto quality is on and the target is 1080p or higher (always true by default).

### Fixed

- `parseAttributes` now strips a leading `#EXT-X-...:` tag. Whole `#EXT-X-STREAM-INF:` lines were parsed with the tag glued to the first key (`#EXT-X-STREAM-INF:RESOLUTION`), so a variant listing `RESOLUTION` first had no resolution: the backup swap found no URL and the ad leaked.
- Background-tab guards used `document.hidden`, which vaft spoofs to `false` for the player, so they never paused: the UI and auto-quality loops now use the real (native) `document.hidden`.
- `getFirstM3u8Url()` parses each line as a URL (https, path ending in `.m3u8`, query strings allowed) instead of a whole-line regex.
- Master playlist handling no longer throws (which failed the stream load) when an HEVC/AV1 variant has no `RESOLUTION`, or when the usher path loses its `.m3u8` extension (channel name taken from the last path segment).

### Evaluated, not shipped

- Audio-only ad fallback (`setAdBackupMode('audio')`): Twitch stitches the ad into every variant of a tainted token, audio-only included, so it adds nothing over a clean backup; and feeding audio-only segments into the video playlist the player picked would likely freeze the picture or raise player errors (#2000/#3000/#4000). `'audio'` behaves like the default (360p).

## [37.3.0] - 2026-10-09

### Added

- **Quality Auto | Off** toggle next to the Ad toggle (`localStorage:vaftAutoQuality`, ON by default, synced across tabs). Off leaves Twitch's quality alone, including the Source preset on page load. Console: `setAutoQuality()`, `getAutoQuality()`.
- CI (`.github/workflows/check.yml`): runs `node check.js`; a PR that changes the userscript must bump `@version`.
- Versioning note in the script header: `@version` is the public release, `ourTwitchAdSolutionsVersion` the internal anti-conflict guard.

### Changed

- The UI and auto-quality loops skip work while the tab is hidden (see 38.0.0: the check only became effective there).

### Fixed

- Cached `EncodingsM3U8` freshness check crashed with `null[0]` when no `https://...m3u8` line was present; it now goes through `getFirstM3u8Url()` and resets the stream info safely (page and worker).

## [37.2.2] - 2026-09-29

First release of this fork, based on vaft 37.0.0 from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (archived 2026-03-05).

### Added

- **Ad 360p | Source** toggle next to the Share button (« Pub » in French), applied instantly, `localStorage:adBackupMode`, synced across tabs. 360p (default): if both Source backup feeds carry the ad, use the 360p feed. Source: never downscale, the picture freezes until the ad ends.
- Auto quality: Twitch's saved quality is set to Source on load; below 1080p the player picks 1440p60 > 1080p60 > 1440p > 1080p, once per page and again after each ad.
- Hidden overlays: the script's "Blocking ads" banner and Twitch's ad countdown.
- Smoother ad exit: pause/play; a full player reload only when ad segments were stripped or on an HEVC (2K/4K) quality, which also reloads at ad start.
- Latency catch-up: 3 s after returning to a tab that fell more than 15 s behind live (5 s in low latency), pause/play to get back to live; skipped while stripping or within 8 s of a previous fix.
- `check.js` regression tests.

### Fixed (vs vaft 37.0.0)

- `getServerTimeFromM3u8` crashed when the playlist had no `SERVER-TIME`, which could keep a stream from loading.
- `stripAdSegments` computed the ad tracking URL rewrite but never wrote it back.
- A failure while processing a playlist left the player's request pending forever; it is now rejected.
- The React player lookup no longer walks the whole page tree every 600 ms on pages without a video.

[38.0.0]: https://github.com/0rpi/twitch-adblock-userscript/compare/2fc1ba4...main
[37.3.0]: https://github.com/0rpi/twitch-adblock-userscript/commit/2fc1ba4dc8faab25559dbf81ef464125a8ef6363
[37.2.2]: https://github.com/0rpi/twitch-adblock-userscript/commit/8fff65bc834f4024fabbf0b9ad31188c1d268ebc
