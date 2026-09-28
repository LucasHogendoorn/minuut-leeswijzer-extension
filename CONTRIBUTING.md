# Bijdragen

Fijn dat je wilt meedenken of meebouwen. Issues en pull requests zijn welkom: een bug,
een uitspraak waarin de r.o.'s verkeerd worden herkend, of een idee.

## Lokaal draaien

1. Ga naar `chrome://extensions`, zet **Ontwikkelaarsmodus** aan en kies
   **Uitgepakte extensie laden** → deze map.
2. Na een wijziging: klik op het herlaadpijltje bij Minuut Leeswijzer en ververs de pagina
   op Rechtspraak.nl, Curia of EUR-Lex.

Er is geen build-stap en er zijn geen dependencies: het is gewone JavaScript en CSS.

## De server

De AI-aanroepen lopen via een Cloudflare Worker (`worker/`). Die houdt de API-sleutel,
bouwt de vragen aan het AI-model uit vaste sjablonen (`QUESTIONS` in
`worker/src/index.js`), begrenst het aantal verzoeken en bewaart alleen oordelen over
openbare tekst die zonder rechtsvraag zijn gevraagd (Cloudflare KV, 90 dagen). Lokaal
gebruikt `wrangler dev` een eigen, lege opslag.

De productieserver accepteert alleen de officiële extensie. Een uitgepakte installatie uit
je eigen map krijgt een andere extensie-ID en wordt geweigerd. Draai de Worker daarom
lokaal:

1. Installeer [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
   en maak een sleutel voor de [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).
2. Maak `worker/.dev.vars` (staat in `.gitignore`; commit dit nooit):

   ```sh
   AI_GATEWAY_API_KEY=je-sleutel
   ALLOWED_ORIGINS=
   ```

   Een lege `ALLOWED_ORIGINS` laat elke uitgepakte extensie toe. Lokaal is geen `RL_SALT`
   nodig.
3. `cd worker && wrangler dev --port 8787`
4. Maak in de hoofdmap `dev-config.json` (staat ook in `.gitignore`):

   ```json
   { "endpoint": "http://127.0.0.1:8787/v1/judge" }
   ```

   Alleen een uitgepakte installatie leest dit bestand; de store-versie gebruikt altijd de
   productieserver. Herlaad daarna de extensie.

Wie de Worker zelf deployt, zet de secrets met `wrangler secret put AI_GATEWAY_API_KEY` en
`wrangler secret put RL_SALT`, en de eigen extensie-ID in `ALLOWED_ORIGINS` in
`worker/wrangler.toml`.

**Verzoek** (`POST`, JSON):

```json
{ "kind": "segment", "question": "Gaat dit over overlast?", "state": "<tekst>" }
```

- `kind`: `core` (één r.o. zonder vraag: is het een kernoverweging?), `segment` (één r.o.
  tegen de vraag), `ruling` (een uitspraak of zoekresultaat tegen de vraag) of `sentences`
  (de zinnen van één r.o. rangschikken; dan met `sentences: [...]`). Optioneel: `court`, uit
  een vaste lijst (`COURTS`); bij Europese rechtspraak ook bij `segment`.
- **Antwoord:** `{ "answers": { … } }`. Hoe de extensie die leest, staat in `src/jev.js`.
- **Fouten:** een `400` wordt niet herhaald; bij `429` en `5xx` probeert de extensie het tot
  vier keer opnieuw. Een `message`-veld in de JSON wordt de foutmelding.

## Waar zit wat

| Bestand | Wat |
|---|---|
| `src/background.js` | Verbinding met de server, sessie-cache, tabbladen openen |
| `src/content.js` | Stuurt alles aan op de pagina |
| `src/sites.js` | Per site: waar de uitspraak staat, gegevens, hoe punten heten |
| `src/segmenter.js` | Herkent de rechtsoverwegingen in een uitspraak van Rechtspraak.nl |
| `src/eu.js` | Herkent de genummerde punten in Europese rechtspraak (Curia, EUR-Lex) |
| `src/jev.js` | Welke vragen er gesteld worden en hoe de antwoorden gelezen worden |
| `src/document.js`, `src/page.css` | Kleuren, verbergen en onderstrepen in de uitspraak |
| `src/panel.js`, `src/panel.css` | Het zijpaneel |
| `src/results.js` | De zoekresultaten |
| `options/` | Welkomst- en privacypagina |
| `worker/src/index.js` | De server: vaste vragen aan het AI-model, limieten, gedeelde cache voor openbare tekst |

## Uitgangspunten

- De extensie schrijft geen tekst. Ze verandert alleen kleur, volgorde en zichtbaarheid;
  wat er staat, is altijd de tekst van de rechter.
- De rechtsvraag blijft in de browsersessie en komt nooit in opslag; de server bewaart alleen
  oordelen over openbare tekst.
- De opmaak van Rechtspraak.nl, Curia en EUR-Lex zelf blijft zoveel mogelijk ongemoeid.

## Pakket bouwen

`./scripts/build.sh` maakt `dist/minuut-leeswijzer-<versie>.zip` en breekt af als er iets
in zit dat op een sleutel of een ontwikkelinstelling lijkt.
