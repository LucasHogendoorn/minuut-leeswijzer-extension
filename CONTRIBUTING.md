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
openbare tekst die zonder rechtsvraag zijn gevraagd (Cloudflare D1, `worker/src/cache.js`;
schema in `worker/migrations/`). Daarnaast
houdt hij anonieme tellers per dag bij (`worker/src/stats.js`): actieve installaties en
nieuwe installaties per versie, beoordelingen per soort, cache-hits, fouten en
geweigerde verzoeken. Alleen namen en aantallen: geen vraag, tekst, ECLI, URL, IP-adres of
ID. Lokaal gebruikt `wrangler dev` een eigen, lege opslag en een eigen, lokale database.

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
3. Maak de lokale database aan en start de Worker:

   ```sh
   cd worker
   wrangler d1 migrations apply leeswijzer-cache --local
   wrangler dev --port 8787
   ```
4. Maak in de hoofdmap `dev-config.json` (staat ook in `.gitignore`):

   ```json
   { "endpoint": "http://127.0.0.1:8787/v1/judge" }
   ```

   Alleen een uitgepakte installatie leest dit bestand; de store-versie gebruikt altijd de
   productieserver. Herlaad daarna de extensie.

Wie de Worker zelf deployt, zet de secrets met `wrangler secret put AI_GATEWAY_API_KEY` en
`wrangler secret put RL_SALT`, en de eigen extensie-ID in `ALLOWED_ORIGINS` in
`worker/wrangler.toml`. Voor de cache: `wrangler d1 create leeswijzer-cache`, het `database_id`
in `worker/wrangler.toml` en `wrangler d1 migrations apply leeswijzer-cache --remote`.

Hoe vol de cache is: `./scripts/cache.sh` (grootte en sjablonen), `./scripts/cache.sh rows`
(rijen per sjabloon; leest de hele tabel) en `./scripts/cache.sh prune <tpl>` (rijen van een
oud sjabloon weghalen; elke verwijderde rij telt als geschreven rij).

De dagtellers zijn te lezen via `GET /v1/stats?days=30` met een geheim token. Zet dat met
`wrangler secret put STATS_TOKEN` (bijvoorbeeld de uitvoer van `openssl rand -hex 32`);
zonder dat secret geeft het endpoint `404`. `STATS_TOKEN=... ./scripts/stats.sh 30` print de
laatste dertig dagen als tabel (met `STATS_URL=http://127.0.0.1:8787` voor een lokale
Worker, en dan `STATS_TOKEN` ook in `worker/.dev.vars`).

Zonder Gateway-sleutel kan `wrangler dev` een lokale nep-gateway gebruiken:
`DEV_GATEWAY_URL=http://127.0.0.1:<poort>/v1/evaluate` in `worker/.dev.vars`. Alleen adressen op
`127.0.0.1` of `localhost` worden gebruikt.

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

**Opzoeken in de cache** (`POST /v1/lookup`, JSON): de bewaarde oordelen voor veel r.o.'s van
één uitspraak in één verzoek, alleen voor soorten zonder rechtsvraag.

```json
{ "kind": "core", "court": "de Hoge Raad", "items": [{ "state": "<tekst>" }, { "state": "<tekst>" }] }
```

- `kind`: `core` of `sentences` (dan per item ook `sentences: [...]`); `court` en `lang` zoals
  hierboven; hoogstens 100 items en 512 KB.
- **Antwoord:** `{ "answers": [ { … }, null ] }`, in dezelfde volgorde; `null` als er niets
  bewaard is. Het endpoint vraagt nooit iets aan het model en schrijft niets; de extensie
  beoordeelt daarna alleen de ontbrekende r.o.'s via `/v1/judge`.

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
| `worker/src/index.js` | De server: vaste vragen aan het AI-model, limieten, `/v1/judge` en `/v1/lookup` |
| `worker/src/cache.js`, `worker/migrations/` | Gedeelde cache voor openbare tekst (D1): sleutels, opslag, kosten |
| `worker/src/stats.js` | Anonieme dagtellers en `GET /v1/stats` |

## Uitgangspunten

- De extensie schrijft geen tekst. Ze verandert alleen kleur, volgorde en zichtbaarheid;
  wat er staat, is altijd de tekst van de rechter.
- De rechtsvraag blijft in de browsersessie en komt nooit in opslag; de server bewaart alleen
  oordelen over openbare tekst en anonieme dagtellers zonder vraag, tekst, IP-adres of ID.
- De opmaak van Rechtspraak.nl, Curia en EUR-Lex zelf blijft zoveel mogelijk ongemoeid.

## Pakket bouwen

`./scripts/build.sh` maakt `dist/minuut-leeswijzer-<versie>.zip` en breekt af als er iets
in zit dat op een sleutel of een ontwikkelinstelling lijkt.
