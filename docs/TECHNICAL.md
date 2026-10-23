# Technical notes

How the userscript works, what it stores, console commands and development. For installing and using it, see the [README](../README.md).

[FR](#francais)

## Runtime

- **vaft core**: on `stitched` AD tag → backup feed at current res, first clean one of `mobile_feed` (asked as Android, Source) → `embed` → `popout` → `autoplay` (360p, not in Source mode). Strips leftover segments; 1.5s post-reload = first backup only. VOD/clip playlists untouched.
- **Display ads** (banner under the player, squeezeback = shrunk stream, pod above chat): never in the playlist, so declined at the source — Twitch's own client-side ad manager (found via webpack, no hardcoded id, never run before its dependencies) gets `decline('player_size', {sendEvent:false})`, no request, no shrink. Allowlisted channels (Mod View/popout too): undone at once on navigation (Twitch's own decline, e.g. Turbo, never touched). Lookup 2 min, then every 10 s. `vaftStatus().displayAds.state`. Fallback: banner wrapper `[data-test-selector="sda-wrapper"]` hidden by CSS and lower-third player height restored (not on allowlisted channels). Off: `localStorage.setItem('vaftDeclineDisplayAds','off')` + reload (stops the decline only; the CSS fallback stays).
- **Pill** (channel header, left of Follow; before Share when the header is not shown): dot + label (`Ad block on` when idle) + gear, click → "Twitch Adblock" settings panel (Esc / outside click / `×` closes): Support switch for the channel on screen, then tabs Ads / Support / Quality (WAI-ARIA tabs, arrows / Home / End; last tab in `localStorage:vaftPanelTab`; the panes share one grid cell so the panel keeps one height whatever the tab). Dot: grey = idle, pulsing purple = ad being blocked on this channel (tooltip = backup used), `♥` = channel allowlisted, orange = self-check warning.
- **Panel**:
  - Ad fallback: no panel control since 38.0. Default = `autoplay` 360p as the last resort; console `setAdBackupMode('source')` = never downscale, freeze on tainted (`localStorage:adBackupMode`, x-tab sync). A value stored before 38.0 is dropped once (`localStorage:vaftBackupModeReset`).
  - **Support this channel** = allowlist (`localStorage:vaftAllowlist`, lowercase logins, empty by default): Twitch's own token + playlist, ads play, display ads not declined, Twitch's ad label/countdown and `media-amazon.com` ad `<video>` left alone. Toggle = player reload on that channel.
  - Ad stats (`localStorage:vaftAdStats`, all tabs add up) + this page's session: breaks · time, `since` date, Reset = 2 clicks. One break per ad across workers; time ≈ playlist gaps (≤10s each), so it's an estimate.
  - Ads tab details: last break blocked (`localStorage:vaftLastAd`: channel, time, seconds, mid-roll, method) and seconds per replacement method (`localStorage:vaftAdMethods`: `full` = a backup at full quality, `low` = `autoplay` 360p, `strip` = ad segments cut out), from the worker's `backupPlayerType` / `strippingSegments`; the time since the previous message goes to the method then in use. Banner ads row = `vaftStatus().displayAds.state`. Reset clears them.
  - Quality tab, now playing: `vaftGetPlaybackInfo()` reads Twitch's player (`getQuality`, `getQualities`, `getVideoFrameRate`, `getVideoBitRate`, `getBandwidthEstimate`, `getLiveLatency`, `isLiveLowLatency`, `getBufferDuration`, `getDroppedFrames`, all optional; `missing` lists those not found, `['player']` when there is no player) and the `<video>` element (size, and buffer / dropped frames as a fallback), only while that tab is shown.
  - Supported channels: the allowlist, one row per login (link, estimate, × = remove after a second click within 4 s). Ads watched there come from the worker's `watchingAd` (allowlisted channel and the ad signifier in the playlist; client-side ad videos are not counted), tracked like blocked breaks but per channel in `localStorage:vaftWatchedAds` (`{ login: { breaks, seconds, since } }`, tabs add up). Reset clears it too.
  - What the streamer gets: fixed estimates in `EARNINGS` (UI): 0.25 cent per ad (0.1–0.5), Tier 1 sub €4.99 / 1.2 VAT × 50 % = €2.08; ads = max(breaks, ad seconds / 30), × 0.25 cent for "Given" (watched) and "Lost" (blocked). Not read from Twitch (no public rates).
  - Quality Auto `On|Off` (`localStorage:vaftAutoQuality`, default ON): forces saved quality to Source on load, then once per page (and after each ad) picks the first available of the order if the current height is outside it. `Off` = hands off.
  - Target `1440p60` (default) … `720p` → order in `localStorage:vaftQualityPref` (default `1440p60 > 1080p60 > 1440p > 1080p`). Changing Target or switching Auto on = one forced switch now.
  - Version + self-check warning with report link.
- **Self-check**: 30s of visible live playback with no playlist through vaft → one `console.warn` per page (EN/FR) + orange pill + `vaft-health` event. Codes: `worker-not-hooked`, `no-worker-messages`.
- **Console**: `setAdBackupMode('360p'|'source')`, `setAutoQuality('on'|'off')`, `simulateAds(n)`, `vaftStatus()`, `getVaftAdStats()` (with `methods` and `lastAd`) / `resetVaftAdStats()`, `getVaftWatchedAds()`, `vaftGetPlaybackInfo()`, `getVaftAllowlist()` / `setVaftAllowlist(['login', …])` (array only, replaces the list) / `toggleVaftAllowlist('login')` (no arg = current channel). Events on `window`: `vaft-ad-state`, `vaft-health`.
- **Misc**: ad banner/countdown `display:none` (not on allowlisted channels), pause/play on ad exit (reload only if stripped or HEVC), catch-up pause/play if latency >15s (5s LL) 3s after tab refocus.

## Delta vs vaft 37.0.0

- `getServerTimeFromM3u8`: no more crash on missing `SERVER-TIME`
- `stripAdSegments`: tracking-URL rewrite now actually written back
- playlist handler: `reject()` instead of hanging forever
- no React-tree walk every 600ms on videoless pages
- `EncodingsM3U8` freshness via `getFirstM3u8Url()` — no more `null[0]`
- 38.0: codec families (AVC/HEVC/AV1, missing `CODECS` safe), backup feed keeps codec family, robust fetch hook (`Request`/`Headers`), 15s worker fetch timeout, real `document.hidden` for guards, ad `<video>` from `media-amazon.com` hidden, `vaftStatus()` in console — ported from [Wibias/twitch-adblock-userscript](https://github.com/Wibias/twitch-adblock-userscript)
- 38.0: `parseAttributes` strips the `#EXT-X-…:` prefix — `RESOLUTION`-first variant lines no longer leak ads (backup swap got `null`)
- 38.0: display ads declined via Twitch's ad manager — approach from [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock)

## Dev

```
npm ci
npm test                      # = node check.js (plain node, no deps)
npm run lint                  # eslint + vaft/worker-scope rule
npm run smoke                 # Playwright, offline fake www.twitch.tv + HLS/gql
SMOKE_LIVE=1 npm run smoke    # real twitch.tv (CI: weekly + manual, signal not gate)
npm run test:tooling          # upstream/fork watcher
```

`@version` = public (auto-update, bump every visible change), `SCRIPT_VERSION` = same value. `ourTwitchAdSolutionsVersion=24` = internal mutex, don't touch. CI (`check.yml`): test, lint, smoke, PR must bump `@version`.

Release: bump `@version` + `SCRIPT_VERSION` → `## [X.Y.Z] - YYYY-MM-DD` in [CHANGELOG](../CHANGELOG.md) (no `TODO`) → `npm test` → commit → `git tag vX.Y.Z` → push tag. `release.yml` checks tag = `@version` + CHANGELOG section, publishes the GitHub Release.

## Limits

`@match` = `www.twitch.tv`, `m.twitch.tv`, `player.twitch.tv` (not dashboard/clips/other subdomains); support = desktop `www.twitch.tv` only. `localStorage` is per origin: settings/allowlist on `www` ≠ `player.twitch.tv` embeds. Twitch mutates player often + upstream dead → can break anytime. Not affiliated.

---

# Francais

Fonctionnement interne, stockage, commandes console et développement. Pour installer et utiliser le script, voir le [README](../README.md#français).

## Runtime

- **Coeur vaft** : tag `stitched` → flux backup à la réso courante, le premier propre parmi `mobile_feed` (demandé en Android, Source) → `embed` → `popout` → `autoplay` (360p, pas en mode Source). Strip des segments restants ; 1,5s post-reload = premier backup seul. Playlists VOD/clips intouchées.
- **Pubs display** (bandeau sous le lecteur, squeezeback = stream rétréci, pod au-dessus du chat) : jamais dans la playlist, donc refusées à la source — le gestionnaire de pubs client de Twitch (trouvé via webpack, aucun id en dur, jamais exécuté avant ses dépendances) reçoit `decline('player_size', {sendEvent:false})`, pas de requête, pas de rétrécissement. Chaînes autorisées (Mod View/popout aussi) : annulé dès la navigation (refus de Twitch lui-même, ex. Turbo, jamais touché). Recherche 2 min, puis toutes les 10 s. `vaftStatus().displayAds.state`. Filet : bandeau `[data-test-selector="sda-wrapper"]` masqué en CSS et hauteur du lecteur rétablie pour le format lower-third (pas sur les chaînes autorisées). Couper : `localStorage.setItem('vaftDeclineDisplayAds','off')` + recharger (coupe seulement le refus ; le filet CSS reste).
- **Pastille** (en-tête de chaîne, à gauche de Suivre ; avant Partager si l'en-tête n'est pas affiché) : point + libellé (`Anti-pub actif` au repos) + engrenage, clic → panneau de réglages « Twitch Adblock » (Échap / clic dehors / `×` ferme) : interrupteur Soutenir pour la chaîne affichée, puis onglets Pubs / Soutien / Qualité (onglets WAI-ARIA, flèches / Début / Fin ; dernier onglet dans `localStorage:vaftPanelTab` ; les volets partagent une même cellule de grille, donc le panneau garde une seule hauteur quel que soit l'onglet). Point : gris = repos, violet qui pulse = pub bloquée sur cette chaîne (infobulle = backup utilisé), `♥` = chaîne autorisée, orange = alerte auto-test.
- **Panneau** :
  - Flux de secours : plus de bouton dans le panneau depuis la 38.0. Défaut = `autoplay` 360p en dernier recours ; console `setAdBackupMode('source')` = jamais de downscale, freeze si pollué (`localStorage:adBackupMode`, sync onglets). Une valeur enregistrée avant la 38.0 est effacée une fois (`localStorage:vaftBackupModeReset`).
  - **Soutenir cette chaîne** = liste blanche (`localStorage:vaftAllowlist`, logins en minuscules, vide par défaut) : token + playlist Twitch d'origine, les pubs passent, pubs display non refusées, label/compte à rebours pub Twitch et `<video>` pub `media-amazon.com` laissés tranquilles. Bascule = reload du lecteur sur cette chaîne.
  - Stats pubs (`localStorage:vaftAdStats`, tous onglets cumulés) + session de la page : coupures · durée, date `depuis`, Réinitialiser = 2 clics. Une coupure par pub même avec plusieurs workers ; durée ≈ écarts entre playlists (≤10s chacun), donc estimation.
  - Détails de l'onglet Pubs : dernière coupure bloquée (`localStorage:vaftLastAd` : chaîne, heure, secondes, mid-roll, méthode) et secondes par méthode de remplacement (`localStorage:vaftAdMethods` : `full` = un flux de secours en pleine qualité, `low` = `autoplay` 360p, `strip` = segments pub coupés), d'après `backupPlayerType` / `strippingSegments` du worker ; le temps depuis le message précédent va à la méthode alors utilisée. Ligne bandeaux pub = `vaftStatus().displayAds.state`. Réinitialiser les efface.
  - Onglet Qualité, en cours de lecture : `vaftGetPlaybackInfo()` lit le lecteur Twitch (`getQuality`, `getQualities`, `getVideoFrameRate`, `getVideoBitRate`, `getBandwidthEstimate`, `getLiveLatency`, `isLiveLowLatency`, `getBufferDuration`, `getDroppedFrames`, tous optionnels ; `missing` liste ceux qui manquent, `['player']` sans lecteur) et l'élément `<video>` (taille, et tampon / images perdues en secours), seulement quand cet onglet est affiché.
  - Chaînes soutenues : la liste blanche, une ligne par login (lien, estimation, × = retrait au second clic dans les 4 s). Les pubs regardées viennent du `watchingAd` du worker (chaîne autorisée et marqueur de pub dans la playlist ; les vidéos pub côté client ne sont pas comptées), suivies comme les coupures bloquées mais par chaîne dans `localStorage:vaftWatchedAds` (`{ login: { breaks, seconds, since } }`, onglets cumulés). Réinitialiser l'efface aussi.
  - Ce que touche le streamer : estimations fixes dans `EARNINGS` (UI) : 0,25 centime par pub (0,1–0,5), sub Tier 1 4,99 € / 1,2 TVA × 50 % = 2,08 € ; pubs = max(coupures, secondes de pub / 30), × 0,25 centime pour « Donné » (regardées) et « Manque à gagner » (bloquées). Rien n'est lu chez Twitch (pas de tarifs publics).
  - Qualité Auto `Oui|Non` (`localStorage:vaftAutoQuality`, défaut ON) : force Source au load, puis une fois par page (et après chaque pub) prend la première dispo de l'ordre si la hauteur actuelle n'y est pas. `Non` = touche à rien.
  - Cible `1440p60` (défaut) … `720p` → ordre dans `localStorage:vaftQualityPref` (défaut `1440p60 > 1080p60 > 1440p > 1080p`). Changer la cible ou repasser Auto à `Oui` = un changement forcé tout de suite.
  - Version + alerte auto-test avec lien de signalement.
- **Auto-test** : 30s de live visible sans aucune playlist passée par vaft → un `console.warn` par page (FR/EN) + pastille orange + event `vaft-health`. Codes : `worker-not-hooked`, `no-worker-messages`.
- **Console** : `setAdBackupMode('360p'|'source')`, `setAutoQuality('on'|'off')`, `simulateAds(n)`, `vaftStatus()`, `getVaftAdStats()` (with `methods` and `lastAd`) / `resetVaftAdStats()`, `getVaftWatchedAds()`, `vaftGetPlaybackInfo()`, `getVaftAllowlist()` / `setVaftAllowlist(['login', …])` (tableau seulement, remplace la liste) / `toggleVaftAllowlist('login')` (sans arg = chaîne courante). Events sur `window` : `vaft-ad-state`, `vaft-health`.
- **Divers** : banner/countdown masqués (sauf chaînes autorisées), pause/play en sortie de pub (reload seulement si strip ou HEVC), rattrapage si latence >15s (5s LL) 3s après retour onglet.

## Delta vs vaft 37.0.0

- `getServerTimeFromM3u8` : plus de crash sans `SERVER-TIME`
- `stripAdSegments` : rewrite tracking-URL enfin appliquée
- handler playlist : `reject()` au lieu de pendre
- plus de walk React toutes les 600ms sans vidéo
- fraîcheur `EncodingsM3U8` via `getFirstM3u8Url()` — fini le `null[0]`
- 38.0 : familles de codecs (AVC/HEVC/AV1, `CODECS` absent géré), backup du même codec, hook fetch robuste (`Request`/`Headers`), timeout 15s des fetch worker, vrai `document.hidden` pour les gardes, `<video>` pub `media-amazon.com` masquée, `vaftStatus()` en console — repris de [Wibias/twitch-adblock-userscript](https://github.com/Wibias/twitch-adblock-userscript)
- 38.0 : `parseAttributes` retire le préfixe `#EXT-X-…:` — les variantes avec `RESOLUTION` en premier ne laissent plus passer la pub (swap backup à `null`)
- 38.0 : pubs display refusées via le gestionnaire de pubs de Twitch — approche reprise de [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock)

## Dev

```
npm ci
npm test                      # = node check.js (node seul, sans deps)
npm run lint                  # eslint + règle vaft/worker-scope
npm run smoke                 # Playwright, faux www.twitch.tv + HLS/gql hors ligne
SMOKE_LIVE=1 npm run smoke    # vrai twitch.tv (CI : hebdo + manuel, signal pas bloquant)
npm run test:tooling          # veille upstream/forks
```

`@version` = public (auto-update), `SCRIPT_VERSION` = même valeur. `ourTwitchAdSolutionsVersion=24` = mutex interne. CI (`check.yml`) : test, lint, smoke, une PR doit bumper `@version`.

Release : bump `@version` + `SCRIPT_VERSION` → `## [X.Y.Z] - AAAA-MM-JJ` dans le [CHANGELOG](../CHANGELOG.md) (sans `TODO`) → `npm test` → commit → `git tag vX.Y.Z` → push du tag. `release.yml` vérifie tag = `@version` + section CHANGELOG, publie la Release GitHub.

## Limites

`@match` = `www.twitch.tv`, `m.twitch.tv`, `player.twitch.tv` (pas dashboard/clips/autres sous-domaines) ; support = `www.twitch.tv` desktop. `localStorage` par origine : réglages/liste blanche sur `www` ≠ lecteurs intégrés `player.twitch.tv`. Twitch bouge + upstream mort → peut casser. Non affilié.
