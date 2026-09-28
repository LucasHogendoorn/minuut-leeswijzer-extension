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
   RL_SALT=een-willekeurige-tekst-van-16-of-meer-tekens
   ```

   Een lege `ALLOWED_ORIGINS` laat elke uitgepakte extensie toe. Zonder `RL_SALT` van
   minstens 16 tekens antwoordt de Worker `503`: hij gebruikt nooit een hash zonder geheime
   sleutel.
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

   Lokaal en op het custom domain bedient de Worker alle endpoints; alleen de oude
   `*.workers.dev`-host is beperkt (zie hieronder).

   Alleen een uitgepakte installatie leest dit bestand; de store-versie gebruikt altijd de
   productieserver. Herlaad daarna de extensie.

Wie de Worker zelf deployt, zet de secrets met `wrangler secret put AI_GATEWAY_API_KEY` en
`wrangler secret put RL_SALT`, de eigen extensie-ID in `ALLOWED_ORIGINS` en het eigen
domein in `routes` in `worker/wrangler.toml`. Voor de cache: `wrangler d1 create leeswijzer-cache`, het `database_id`
in `worker/wrangler.toml` en `wrangler d1 migrations apply leeswijzer-cache --remote`.

Hoe vol de cache is: `./scripts/cache.sh` (grootte en sjablonen), `./scripts/cache.sh rows`
(rijen per sjabloon; leest de hele tabel) en `./scripts/cache.sh prune <tpl>` (rijen van een
oud sjabloon weghalen; elke verwijderde rij telt als geschreven rij).

De dagtellers zijn te lezen via `GET /v1/stats?days=30` met een geheim token. Zet dat met
`wrangler secret put STATS_TOKEN` (minstens 32 tekens, bijvoorbeeld de uitvoer van
`openssl rand -hex 32`); zonder dat secret, of met een korter token, geeft het endpoint
`404`. "Actief" telt netwerken (een IPv4-adres of een IPv6-/48) met een actieve installatie,
hoogstens één per netwerk per dag: een kantoor achter één adres telt als één. `STATS_TOKEN=... ./scripts/stats.sh 30` print de
laatste dertig dagen als tabel (met `STATS_URL=http://127.0.0.1:8787` voor een lokale
Worker, en dan `STATS_TOKEN` ook in `worker/.dev.vars`).

Tests voor de Worker (Node 22, zonder dependencies), vanuit `worker/`:

```sh
node --import ./test/register.mjs --test test/*.test.mjs
```

## Domein, limieten en de oude workers.dev-host

De API draait op `https://leeswijzer-api.minuut.eu` (custom domain van de Worker, zone
`minuut.eu`). Extensie 1.1 en later praten alleen daarmee. Op die hostnaam staat een
WAF-rate-limitingregel van de zone (Cloudflare Free: één regel): hij telt per IP-adres
alle verzoeken naar `leeswijzer-api.minuut.eu`, ook de CORS-preflights (`OPTIONS`), staat
er 500 per 10 seconden toe en blokkeert daarna 10 seconden. Eén lezer die een Europees
arrest van 101 punten koud opent, kwam in de meting op hoogstens ~150 verzoeken per 10
seconden (preflights worden door de browser gecachet, `Access-Control-Max-Age`), dus drie
zware lezers achter één kantooradres passen eronder. De limieten in de Worker zelf (per
client 500 beoordelingen per 10 s en 900 per minuut, apart 600/1800 cache-opzoekingen;
wereldwijd 3000 Jev-aanroepen per minuut en 80.000 per dag) en hoe ze gemeten zijn, staan
bij "Rate limiting" in `worker/src/index.js`. Een client is één IPv4-adres of één IPv6-/64:
een heel kantoor achter één NAT-adres is één client, daarom zijn de limieten ruim genoeg
voor enkele zware lezers tegelijk.

Extensie 1.0.x heeft `https://minuut-leeswijzer.lucas-hogendoorn.workers.dev` ingebouwd en
de zone-WAF beschermt die hostnaam niet. Daarom staat `workers_dev = true` nog aan, maar
bedient die host alleen `/v1/judge`, alleen Rechtspraak.nl, met strengere limieten (200 per
10 s, 600 per minuut); `/v1/lookup`, `/v1/ping` en `/v1/stats` geven daar `404`.
**Uitzetten:** de kolom `1.0.x` van `./scripts/stats.sh` telt de beoordelingen via de oude
host. Zet `workers_dev = false` in `worker/wrangler.toml` en deploy opnieuw zodra die kolom
een week lang (bijna) 0 is, en uiterlijk twee weken nadat 1.1 in de Chrome Web Store staat
(de store werkt extensies binnen een paar dagen automatisch bij). Daarna kunnen ook
`LEGACY_CALLS` en de `legacy`-tak in `worker/src/index.js` weg.

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
- **Fouten:** `{ "message", "error_type" }`. De extensie herhaalt alleen een `429` met
  `error_type: "busy"` (Jev heeft het even druk; tot vier pogingen, na `Retry-After`) en een
  netwerkfout (één keer). `400`, `429` met `rate_limited` (te veel verzoeken van dit adres) en
  `503` met `unavailable` (server even niet beschikbaar of boven de dag- of totaallimiet)
  worden niet herhaald: het paneel toont de melding met "Opnieuw". Een `POST` zonder
  `Content-Length` krijgt `411`, een te grote body `413`.
- **Zinnen** (`kind: "sentences"`): `state` is alleen een kopregel (hoogstens 1000 tekens),
  de zinnen samen hoogstens 24.000 tekens; een verzoek draagt nooit meer dan 31.000 tekens
  naar het model.

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
| `worker/src/limits.js` | Clients per IPv4-adres of IPv6-netwerk, limieten in het geheugen, body-limiet |
| `worker/src/stats.js` | Anonieme dagtellers en `GET /v1/stats` |
| `worker/test/` | Tests voor de Worker (`node:test`) |

## Uitgangspunten

- De extensie schrijft geen tekst. Ze verandert alleen kleur, volgorde en zichtbaarheid;
  wat er staat, is altijd de tekst van de rechter.
- De rechtsvraag blijft in de browsersessie en komt nooit in opslag; de server bewaart alleen
  oordelen over openbare tekst en anonieme dagtellers zonder vraag, tekst, IP-adres of ID.
- De opmaak van Rechtspraak.nl, Curia en EUR-Lex zelf blijft zoveel mogelijk ongemoeid.

## Pakket bouwen

`./scripts/build.sh` maakt `dist/minuut-leeswijzer-<versie>.zip` en breekt af als er iets
in zit dat op een sleutel of een ontwikkelinstelling lijkt.
