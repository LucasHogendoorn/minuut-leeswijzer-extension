# Minuut Leeswijzer

Chrome-extensie voor Rechtspraak.nl. Jev (TypeSafe AI) leest uitspraken mee en laat
zien welke rechtsoverwegingen over de rechtsvraag van de advocaat gaan. Jev schrijft
geen tekst; de extensie verandert alleen kleur, volgorde en zichtbaarheid.

Installeren: [Chrome Web Store](https://chromewebstore.google.com/detail/minuut-leeswijzer/djlkngghkpadabjgmegaeelmffhhljfe?hl=nl) · meer informatie op
[minuut.eu/leeswijzer](https://minuut.eu/leeswijzer/).

Deze repository bevat alleen de extensie. De server waarmee zij praat (een Cloudflare
Worker van Minuut die de Jev-aanroepen betaalt) is geen onderdeel van deze repository.

## Wat het doet

- **Zoekresultaten** (`/resultaat`): laadt tot 50 resultaten via de eigen knop "Laad meer
  resultaten", laat Jev per inhoudsindicatie ja/deels/nee zeggen, dimt of verbergt de rest,
  zet ze in het paneel op volgorde en opent de top 3/10/25 in tabbladen.
- **Uitspraak** (`/details`): splitst de tekst in r.o.'s (`src/segmenter.js`). Per r.o.
  geeft Jev relevantie, categorie (juridisch kader, toepassing juridisch kader, obiter
  dictum, stellingen partijen, feiten, procesverloop, beslissing) en gewicht. Pastelkleur
  per categorie; de opmaak van de site zelf blijft ongemoeid en de categorie staat alleen
  in een tooltip. Kernoverweging = raakt de vraag (> 70%) en weegt 3–4; alleen die worden
  gekopieerd en met `j`/`k` bezocht. Standaardweergave: alleen "Toepassing juridisch
  kader", niet-relevant verborgen; aan te passen in het paneel ("Maak dit standaard").
- **Zinnen**: zodra een relevante r.o. in beeld komt, gaat er één extra call uit waarin de
  zinnen van die r.o. de opties van een `choice`-vraag zijn; Jev's kans per optie
  rangschikt de zinnen. De beste wordt vet met een dunne onderstreping; elke andere zin
  met ≥ 12% krijgt een lichtere lijn.

Jev geeft op identieke invoer licht wisselende kansen; de sessie-cache houdt één uitkomst
per uitspraak en vraag vast.

## Privacy

- **Browser**: de rechtsvraag en de gecachte oordelen staan in `chrome.storage.session`
  (weg bij het sluiten van de browser). Alleen weergavekeuzes (inklappen, volgorde,
  paneel open) staan in `chrome.storage.local`.
- **Server**: de extensie stuurt de rechtsvraag en de openbare tekst van de uitspraak of
  inhoudsindicatie naar de Worker (`PRODUCTION_ENDPOINT` in `src/background.js`). De Worker
  slaat niets op en logt niets, bouwt de vragen aan Jev zelf uit vaste sjablonen en stuurt
  ze met zero data retention door. Zie de
  [privacyverklaring](https://minuut.eu/leeswijzer/privacy/).
- Bij installatie opent `options/options.html?welkom` met deze uitleg.

## Ontwikkelen

1. `chrome://extensions` → Ontwikkelaarsmodus → *Uitgepakte extensie laden* → deze map.
   Na een wijziging: het herlaadpijltje bij Minuut Leeswijzer.
2. De productie-Worker accepteert alleen de extensie-ID's van Minuut. Een uitgepakte
   installatie uit je eigen map krijgt een andere ID en wordt geweigerd. Zet daarom een
   eigen endpoint in `dev-config.json` in de hoofdmap (gitignored):

   ```json
   { "endpoint": "http://127.0.0.1:8787/v1/judge" }
   ```

   Alleen een uitgepakte installatie leest dit bestand; de store-versie gebruikt altijd de
   productie-Worker. Het endpoint moet CORS toestaan voor de `chrome-extension://`-origin
   van je installatie; de extensie vraagt geen hostpermissies.

### Het endpoint

`POST` met JSON:

```json
{ "kind": "segment", "question": "Gaat dit over overlast?", "state": "<tekst>", "sentences": ["…"], "court": "…" }
```

- `kind`: `core` (één r.o. zonder vraag: is het een kernoverweging?), `segment` (één r.o.
  tegen de vraag), `ruling` (een uitspraak of zoekresultaat tegen de vraag) of `sentences`
  (de zinnen van één r.o. rangschikken). `sentences` en `court` zijn optioneel.
- Antwoord: `{ "answers": { … } }`. Hoe de extensie die antwoorden leest, staat in
  `src/jev.js` (`MNT.readSegmentAnswers` en verwante functies).
- Fouten: `400` wordt niet herhaald; bij `429` en `5xx` probeert de extensie het tot vier
  keer opnieuw (met `Retry-After` als die er is). Een `message`-veld in de JSON wordt de
  foutmelding.

## Bouwen

`./scripts/build.sh` → `dist/minuut-leeswijzer-<versie>.zip` (alleen `manifest.json`,
`src/`, `options/`, `fonts/`, `icons/`). Het script breekt af bij iets dat op een sleutel
lijkt, bij een `dev-config.json` of bij een localhost-permissie in het manifest.

## Bestanden

`src/background.js` client voor de Worker, sessie-cache, tabbladen ·
`src/content.js` controller · `src/segmenter.js` r.o.-herkenning · `src/jev.js`
vragensets en het lezen van antwoorden · `src/document.js` + `src/page.css` weergave in
de uitspraak · `src/panel.js` + `src/panel.css` zijpaneel (shadow DOM) · `src/mascot.js`
+ `src/mascot.css` mascotte · `src/results.js` zoekresultaten · `src/tokens.css`
Minuut-tokens · `options/` welkom en privacy.

## Licentie

Code: [MIT](LICENSE). De lettertypen in `fonts/` (Geist en Source Serif 4) vallen onder de
SIL Open Font License 1.1; zie `fonts/OFL-*.txt`. De naam Minuut en het logo vallen niet
onder de MIT-licentie.
