# Twitch Adblock Userscript

A Twitch ad-blocking userscript, forked from **vaft** ([pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), archived on 2026-03-05), with bug fixes and a few quality-of-life additions.

🇫🇷 [Version française plus bas](#français)

## Install

1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Remove any other copy of vaft first (userscript, or the uBlock Origin `vaft-ublock-origin.js` scriptlet). Installing this script does not replace a copy with a different name.
3. Open **[twitch-adblock.user.js](https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js)** and confirm the installation. Updates are then offered automatically.

If another vaft (version 24 or newer) still runs before this one, this script stays inactive.

## Features

- **Ad blocking (vaft)**: during an ad, the player is fed an ad-free backup stream at the quality it is playing (embed, then popout, both up to Source). Leftover ad segments are stripped as a last resort, and also during the first 1.5 s after the player (re)loads, when only the embed stream is tried.
- **Ad fallback toggle**: an **Ad 360p | Source** switch next to the Share button (in French: « Pub »), applied instantly and synced across tabs.
  - **360p** (default): if both Source streams carry the ad, switch to the 360p stream. If it is ad-free, the video keeps playing; otherwise the ad segments are stripped as in Source mode.
  - **Source**: never drop to 360p. If both Source streams carry the ad, the picture freezes until the ad ends.
- **Auto quality**: on every page load, Twitch's saved quality is set to Source (unless disabled). Then, when the player is below 1080p, it selects 1440p60, then 1080p60 (then 1440p / 1080p), once per page and again after each ad. Toggle **Quality Auto | Off** next to the ad fallback switch (ON by default, synced across tabs, respects your setting when Off).
- **Clean overlay**: hides the script's "Blocking ads" banner and Twitch's ad countdown overlay.
- **Smoother ad exit**: a simple pause/play after an ad. A full player reload happens only when ad segments had to be stripped, or when the player is on an HEVC (2K/4K) quality, where it also reloads when the ad starts.
- **Latency catch-up**: 3 s after you come back to a Twitch tab that fell more than 15 s behind live (5 s in low-latency mode), the player is paused and resumed to get back to live. Skipped while ad segments are being stripped or within 8 s of a previous pause/play or reload.

## Fixes over upstream vaft 37.0.0

- `getServerTimeFromM3u8` crashed when the playlist had no `SERVER-TIME`, which could keep a stream from loading.
- The ad tracking URL rewrite in `stripAdSegments` was computed but never written back.
- A failure while processing a playlist left the player's request pending forever; it is now rejected, so the player gets an error instead of waiting.
- The React player lookup no longer walks the whole page tree every 600 ms on pages without a video.
- The cached `EncodingsM3U8` freshness check crashed with `null[0]` when no `https://...m3u8` URL was present; it now resets safely via `getFirstM3u8Url()`.

## Test

```
node check.js
```

It covers the first two fixes plus `getFirstM3u8Url()` and the `adBackupMode` / `vaftAutoQuality` defaults.

## Maintenance / versioning

- `@version` in the header is the public release number (Violentmonkey/Tampermonkey auto-update): bump it on every user-visible change.
- `ourTwitchAdSolutionsVersion = 24` is an internal anti-conflict guard, not a release number: only bump it if the vaft conflict protocol changes.
- Release flow: bump `@version`, run `node check.js`, commit, `git tag vX.Y.Z` matching `@version`.

## Limits

Twitch changes its player regularly and the upstream project is archived: this script can break at any time. It runs on every `*.twitch.tv` page and frame (including `m.twitch.tv` and `player.twitch.tv` embeds), but only desktop `www.twitch.tv` is supported. Not affiliated with Twitch.

## Credits

- [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT), author of vaft.
- [VideoAdBlockForTwitch contributors](https://github.com/cleanlock/VideoAdBlockForTwitch#credits), whose work vaft builds on.

## License

[MIT](LICENSE)

---

## Français

Userscript anti-pub pour Twitch, dérivé de **vaft** ([pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions), archivé le 5 mars 2026), avec des correctifs et quelques améliorations.

### Installation

1. Installe un gestionnaire de userscripts : [Violentmonkey](https://violentmonkey.github.io/) ou [Tampermonkey](https://www.tampermonkey.net/).
2. Supprime d'abord toute autre copie de vaft (userscript, ou scriptlet uBlock Origin `vaft-ublock-origin.js`). L'installation ne remplace pas une copie qui porte un autre nom.
3. Ouvre **[twitch-adblock.user.js](https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js)** et confirme l'installation. Les mises à jour seront proposées automatiquement.

Si un autre vaft (version 24 ou plus) s'exécute encore avant celui-ci, ce script reste inactif.

### Fonctionnalités

- **Blocage des pubs (vaft)** : pendant une pub, le lecteur reçoit un flux de secours sans pub dans la qualité en cours (embed, puis popout, jusqu'à la Source). En dernier recours, les morceaux de pub restants sont retirés ; c'est aussi le cas pendant les 1,5 premières secondes après un (re)chargement du lecteur, où seul le flux embed est essayé.
- **Choix du secours** : un sélecteur **Pub 360p | Source** à côté du bouton Partager, appliqué tout de suite et synchronisé entre les onglets.
  - **360p** (par défaut) : si les deux flux Source ont la pub, passage au flux 360p. S'il est sans pub, la vidéo continue ; sinon, les morceaux de pub sont retirés comme en mode Source.
  - **Source** : jamais de 360p. Si les deux flux Source ont la pub, l'image reste figée jusqu'à la fin de la pub.
- **Qualité automatique** : à chaque chargement de page, la qualité enregistrée par Twitch est mise sur Source (sauf si désactivé). Ensuite, quand le lecteur est sous 1080p, il sélectionne 1440p60, puis 1080p60 (puis 1440p / 1080p), une fois par page et à nouveau après chaque pub. Interrupteur **Qualité Auto | Off** à côté du choix Pub (activé par défaut, synchronisé entre onglets, ne touche à rien quand désactivé).
- **Affichage propre** : masque le bandeau « Blocking ads » du script et le compte à rebours de pub de Twitch.
- **Sortie de pub plus douce** : simple pause/lecture après une pub. Le lecteur n'est rechargé complètement que si des morceaux de pub ont dû être retirés, ou s'il est sur une qualité HEVC (2K/4K), auquel cas il est aussi rechargé au début de la pub.
- **Rattrapage de latence** : 3 s après ton retour sur un onglet Twitch qui a pris plus de 15 s de retard sur le direct (5 s en mode faible latence), le lecteur est mis en pause puis relancé pour revenir au direct. Rien n'est fait pendant un retrait de morceaux de pub, ni dans les 8 s qui suivent une pause/lecture ou un rechargement.

### Correctifs par rapport à vaft 37.0.0

- `getServerTimeFromM3u8` plantait quand la playlist n'avait pas de `SERVER-TIME`, ce qui pouvait empêcher un stream de se charger.
- Le remplacement des URL de suivi publicitaire dans `stripAdSegments` était calculé mais jamais appliqué.
- Une erreur pendant le traitement d'une playlist laissait la requête du lecteur en attente indéfiniment ; elle est maintenant rejetée, et le lecteur reçoit une erreur au lieu d'attendre.
- La recherche du lecteur dans l'arbre React ne parcourt plus toute la page toutes les 600 ms sur les pages sans vidéo.
- Le contrôle de fraîcheur du `EncodingsM3U8` en cache plantait (`null[0]`) quand aucune URL `https://...m3u8` n'était présente ; il est maintenant sécurisé via `getFirstM3u8Url()`.

### Test

```
node check.js
```

Il couvre les deux premiers correctifs, plus `getFirstM3u8Url()` et les défauts `adBackupMode` / `vaftAutoQuality`.

### Maintenance / versions

- `@version` dans l'en-tête = numéro de release publique (auto-update) : à bumper à chaque changement visible.
- `ourTwitchAdSolutionsVersion = 24` = garde anti-conflit interne, pas un numéro de release.
- Release : bumper `@version`, lancer `node check.js`, commit, `git tag vX.Y.Z` identique à `@version`.

### Limites

Twitch modifie régulièrement son lecteur et le projet d'origine est archivé : ce script peut cesser de fonctionner à tout moment. Il s'exécute sur toutes les pages et iframes `*.twitch.tv` (y compris `m.twitch.tv` et les lecteurs `player.twitch.tv` intégrés), mais seul `www.twitch.tv` sur ordinateur est pris en charge. Projet sans lien avec Twitch.

### Crédits

- [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (MIT), auteur de vaft.
- [Contributeurs de VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits), sur le travail desquels vaft s'appuie.

### Licence

[MIT](LICENSE)
