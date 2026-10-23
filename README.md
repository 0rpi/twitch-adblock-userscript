# Twitch Adblock Userscript

Blocks Twitch ads in your browser: video ads, and the banners that shrink the stream. Ads can still play on channels you choose to support, so their streamers get paid.

[Français](#français)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Remove any other Twitch ad-blocking userscript first (vaft, TwitchAdSolutions, the uBlock Origin vaft scriptlet). Two copies get in each other's way.
3. Open **[twitch-adblock.user.js](https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js)** and confirm. Updates install automatically.

## What it does

- **Video ads**: when Twitch inserts an ad break, the player switches to an ad-free copy of the same stream, in full quality when one is available, otherwise in 360p. You keep watching the stream instead of the ad.
- **Banner ads**: the banner under the player and the format that shrinks the stream to make room for an ad are refused before they load.
- **Support a channel**: one click lets ads play normally on a channel, banners included.
- **Quality**: keeps your preferred quality (1440p60, then 1080p60, by default) and puts it back after each ad.
- **Stats**: how many ad breaks were blocked, on this page and in total.

## Settings

Click the **Ad block on** pill in the channel header, next to Follow. The panel has a switch for the channel on screen, then three tabs.

| Where | What it does |
|---|---|
| **Support** switch (top) | Lets Twitch's ads play on this channel, so the streamer gets paid. The ♥ on the pill shows it. |
| **Ads** tab | Ad breaks blocked, on this page and in total; the last ad blocked (channel, when, pre-roll or mid-roll, how long, what replaced it); how ads were replaced (ad-free copy at full quality, in 360p, or cut out with a black screen); banner ads state. Reset takes two clicks and also clears the Support tab amounts. |
| **Support** tab | What the ads you watched gave and what the blocked ones would have paid; your supported channels, each with its estimate (the name opens the channel, × twice removes it); one ad vs one sub ([details](#what-the-streamer-gets)). |
| **Quality** tab | Auto picks your target quality once per page and after each ad. Set Auto to Off to keep Twitch's own setting. Below: what is playing now, like Twitch's Video stats (quality, codec, bitrate, bandwidth, delay behind live, buffer, dropped frames, resolution), and the qualities this stream offers. |

The pill's dot is grey when idle, pulses purple while an ad is being blocked, and turns orange if the script detects it is not working.

## What the streamer gets

Not to the exact cent: Twitch publishes no ad rates, and they change with the viewer's country, the advertiser and the time of year. Only the streamer sees the real amounts, in their dashboard. Orders of magnitude (2026):

| You watch | The streamer gets about |
|---|---|
| 1 ad (about 30 s) | 0.1 to 0.5 cent (55% of what the advertiser pays Twitch) |
| 1 hour of stream with 3 min of ads | 0.6 to 3 cents |
| 1 Tier 1 sub (€4.99 in France) | €2.08: 50% of the price before VAT, up to €2.91 (70%) for some streamers |
| 1 Prime sub (included with Amazon Prime) | paid to the streamer, at no extra cost to you |

So one sub is worth about 400 to 2,000 ads, or 70 to 350 hours of watching with ads. The settings panel shows the same estimate, plus what the ads you watched on supported channels gave and what the ads you blocked would have paid.

## Problems

- **Low quality or a black screen during an ad**: Twitch put the ad in every full-quality copy of the stream, so the script falls back to a 360p copy; if even that one has the ad, the screen stays black until the ad ends. This should be rare, and nothing needs changing.
- **Ads still play, or the pill is orange**: another ad-blocking script or extension may be interfering, or Twitch changed something. [Open an issue](https://github.com/0rpi/twitch-adblock-userscript/issues) and paste the result of `vaftStatus()` from the browser console (F12).
- **Where it works**: www.twitch.tv in a desktop browser. Settings are saved per site, so embedded Twitch players elsewhere have their own.

Twitch changes its player often, so the script can break at any time. It is not affiliated with Twitch.

How it works, console commands and development: [docs/TECHNICAL.md](docs/TECHNICAL.md). What changed: [CHANGELOG](CHANGELOG.md).

## Credits

Maintained fork of vaft by [pixeltris](https://github.com/pixeltris/TwitchAdSolutions) (TwitchAdSolutions, archived in March 2026), with work from [VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits), [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock) and [Wibias](https://github.com/Wibias/twitch-adblock-userscript). License: [MIT](LICENSE).

---

## Français

Bloque les pubs Twitch dans ton navigateur : les pubs vidéo, et les bandeaux qui rétrécissent le stream. Tu peux laisser passer les pubs sur les chaînes que tu veux soutenir, pour que le streamer soit payé.

### Installation

1. Installe [Tampermonkey](https://www.tampermonkey.net/) ou [Violentmonkey](https://violentmonkey.github.io/).
2. Supprime d'abord tout autre userscript anti-pub Twitch (vaft, TwitchAdSolutions, le scriptlet vaft d'uBlock Origin). Deux copies se gênent.
3. Ouvre **[twitch-adblock.user.js](https://raw.githubusercontent.com/0rpi/twitch-adblock-userscript/main/twitch-adblock.user.js)** et confirme. Les mises à jour s'installent toutes seules.

### Ce qu'il fait

- **Pubs vidéo** : quand Twitch lance une coupure pub, le lecteur passe sur une copie sans pub du même stream, en pleine qualité si possible, sinon en 360p. Tu continues à regarder le stream au lieu de la pub.
- **Pubs en bandeau** : le bandeau sous le lecteur et le format qui rétrécit le stream pour afficher une pub sont refusés avant de se charger.
- **Soutenir une chaîne** : un clic, et les pubs passent normalement sur cette chaîne, bandeaux compris.
- **Qualité** : garde ta qualité préférée (1440p60, puis 1080p60, par défaut) et la remet après chaque pub.
- **Stats** : le nombre de coupures pub bloquées, sur la page et au total.

### Réglages

Clique sur la pastille **Anti-pub actif** dans l'en-tête de la chaîne, à côté de Suivre. Le panneau a un interrupteur pour la chaîne affichée, puis trois onglets.

| Où | Effet |
|---|---|
| Interrupteur **Soutenir** (en haut) | Laisse passer les pubs Twitch sur cette chaîne, pour que le streamer soit payé. Le ♥ sur la pastille l'indique. |
| Onglet **Pubs** | Coupures pub bloquées, sur la page et au total ; la dernière pub bloquée (chaîne, quand, pré-roll ou mid-roll, durée, ce qui l'a remplacée) ; comment les pubs ont été remplacées (copie sans pub en qualité max, en 360p, ou coupée avec écran noir) ; l'état des bandeaux pub. Réinitialiser demande deux clics et efface aussi les montants de l'onglet Soutien. |
| Onglet **Soutien** | Ce qu'ont donné les pubs regardées et ce qu'auraient rapporté les pubs bloquées ; tes chaînes soutenues, chacune avec son estimation (le nom ouvre la chaîne, × deux fois la retire) ; une pub comparée à un sub ([détails](#ce-que-touche-le-streamer)). |
| Onglet **Qualité** | Auto choisit ta qualité cible une fois par page et après chaque pub. Mets Auto sur Non pour garder le réglage de Twitch. En dessous : ce qui est en cours de lecture, comme dans les Statistiques vidéo de Twitch (qualité, codec, débit, bande passante, retard sur le direct, tampon, images perdues, résolution), et les qualités proposées par le stream. |

Le point de la pastille est gris au repos, violet qui pulse pendant qu'une pub est bloquée, et orange si le script détecte qu'il ne fonctionne pas.

### Ce que touche le streamer

Pas au centime près : Twitch ne publie pas ses tarifs pub, et ils changent selon le pays du spectateur, l'annonceur et la période de l'année. Seul le streamer voit les montants réels, dans son tableau de bord. Ordres de grandeur (2026) :

| Tu regardes | Le streamer touche environ |
|---|---|
| 1 pub (environ 30 s) | 0,1 à 0,5 centime (55 % de ce que l'annonceur paie à Twitch) |
| 1 heure de stream avec 3 min de pub | 0,6 à 3 centimes |
| 1 sub Tier 1 (4,99 € en France) | 2,08 € : 50 % du prix hors TVA, jusqu'à 2,91 € (70 %) pour certains streamers |
| 1 sub Prime (inclus avec Amazon Prime) | payé au streamer, sans frais en plus pour toi |

Un sub vaut donc environ 400 à 2 000 pubs, soit 70 à 350 heures de visionnage avec pubs. Le panneau de réglages affiche la même estimation, ce qu'ont donné les pubs regardées sur les chaînes soutenues, et ce qu'auraient rapporté les pubs que tu as bloquées.

### Problèmes

- **Qualité basse ou écran noir pendant une pub** : Twitch a mis la pub dans toutes les copies en pleine qualité, le script passe alors sur une copie en 360p ; si celle-ci a aussi la pub, l'écran reste noir jusqu'à la fin de la pub. Ça devrait être rare, et il n'y a rien à régler.
- **Les pubs passent, ou la pastille est orange** : un autre script ou une extension anti-pub interfère peut-être, ou Twitch a changé quelque chose. [Ouvre une issue](https://github.com/0rpi/twitch-adblock-userscript/issues) avec le résultat de `vaftStatus()` dans la console du navigateur (F12).
- **Où ça marche** : www.twitch.tv dans un navigateur d'ordinateur. Les réglages sont enregistrés par site : les lecteurs Twitch intégrés ailleurs ont les leurs.

Twitch modifie souvent son lecteur, le script peut donc casser à tout moment. Il n'est pas affilié à Twitch.

Fonctionnement, commandes console et développement : [docs/TECHNICAL.md](docs/TECHNICAL.md#francais). Nouveautés : [CHANGELOG](CHANGELOG.md).

### Crédits

Fork maintenu de vaft par [pixeltris](https://github.com/pixeltris/TwitchAdSolutions) (TwitchAdSolutions, archivé en mars 2026), avec des apports de [VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits), [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock) et [Wibias](https://github.com/Wibias/twitch-adblock-userscript). Licence : [MIT](LICENSE).
