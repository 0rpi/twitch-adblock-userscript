# Twitch Adblock Userscript

Maintained fork of vaft ([pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), archived 2026-03-05). Intercepts HLS, swaps in an ad-free backup feed.

[FR](#francais)

## Install

1. [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/)
2. Kill any other vaft copy first (userscript or uBO `vaft-ublock-origin.js` scriptlet) — different filename = no auto-replace
3. Open **[twitch-adblock.user.js](https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js)** → Confirm. Auto-updates on `@version` bump.

> Another vaft >= v24 running first → this one no-ops.

## Runtime

- **vaft core**: on `stitched` AD tag → backup feed at current res (`embed` → `popout` → Source). Strips leftover segments; 1.5s post-reload = `embed`-only.
- **Ad `360p|Source`** (by Share btn, `localStorage:adBackupMode`, x-tab sync): `360p` = fallback to 360p if Source feeds are tainted; `Source` = never downscale, freeze on tainted.
- **Quality `Auto|Off`** (same bar, `localStorage:vaftAutoQuality`, default ON): forces saved quality to Source, then picks `1440p60 > 1080p60 > 1440p > 1080p` when `<1080p`. `Off` = hands off. Console: `setAdBackupMode()`, `setAutoQuality()`, `simulateAds(n)`.
- **Misc**: ad banner/countdown `display:none`, pause/play on ad exit (reload only if stripped or HEVC), catch-up pause/play if latency >15s (5s LL) 3s after tab refocus.

## Delta vs vaft 37.0.0

- `getServerTimeFromM3u8`: no more crash on missing `SERVER-TIME`
- `stripAdSegments`: tracking-URL rewrite now actually written back
- playlist handler: `reject()` instead of hanging forever
- no React-tree walk every 600ms on videoless pages
- `EncodingsM3U8` freshness via `getFirstM3u8Url()` — no more `null[0]`

## Dev

```
node check.js
```

`@version` = public (auto-update, bump every visible change). `ourTwitchAdSolutionsVersion=24` = internal mutex, don't touch. Release: bump → `node check.js` → commit → `git tag vX.Y.Z`.

## Limits

`*.twitch.tv` matched, desktop `www.twitch.tv` only. Twitch mutates player often + upstream dead → can break anytime. Not affiliated.

Credits: [pixeltris](https://github.com/pixeltris/TwitchAdSolutions) (MIT) + [VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits). License: [MIT](LICENSE)

---

## Francais

Fork vaft maintenu ([pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), archivé 05/03/2026). Intercepte le HLS, injecte un flux backup sans pub.

### Install

1. [Violentmonkey](https://violentmonkey.github.io/) ou [Tampermonkey](https://www.tampermonkey.net/)
2. Virer tout autre vaft avant (userscript ou scriptlet uBO) — nom différent = pas de remplacement auto
3. Ouvrir **[twitch-adblock.user.js](https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js)** → Confirmer.

> Un autre vaft >= v24 chargé avant → celui-ci s'efface.

### Runtime

- **Coeur vaft** : tag `stitched` → flux backup à la réso courante (`embed` → `popout` → Source). Strip des segments restants ; 1,5s post-reload = `embed` seul.
- **Pub `360p|Source`** (à côté de Partager, `localStorage:adBackupMode`, sync onglets) : `360p` = fallback 360p si Sources polluées ; `Source` = jamais de downscale, freeze si pollué.
- **Qualité `Auto|Off`** (même barre, `localStorage:vaftAutoQuality`, défaut ON) : force Source au load, puis `1440p60 > 1080p60 > 1440p > 1080p` si `<1080p`. `Off` = touche à rien. Console : `setAdBackupMode()`, `setAutoQuality()`.
- **Divers** : banner/countdown masqués, pause/play en sortie de pub (reload seulement si strip ou HEVC), rattrapage si latence >15s (5s LL) 3s après retour onglet.

### Delta vs vaft 37.0.0

- `getServerTimeFromM3u8` : plus de crash sans `SERVER-TIME`
- `stripAdSegments` : rewrite tracking-URL enfin appliquée
- handler playlist : `reject()` au lieu de pendre
- plus de walk React toutes les 600ms sans vidéo
- fraîcheur `EncodingsM3U8` via `getFirstM3u8Url()` — fini le `null[0]`

### Dev

```
node check.js
```

`@version` = public (auto-update). `ourTwitchAdSolutionsVersion=24` = mutex interne. Release : bump → `node check.js` → commit → `git tag vX.Y.Z`.

### Limites

Match `*.twitch.tv`, support = `www.twitch.tv` desktop. Twitch bouge + upstream mort → peut casser. Non affilié. Crédits / licence : voir EN plus haut, [MIT](LICENSE).
