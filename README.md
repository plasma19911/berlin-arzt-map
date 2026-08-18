# Berlin Arzt Map

Installierbare mobile Karte mit Ärzten, Praxen, Zahnärzten, Kliniken und medizinischen Versorgungszentren im **10-km-Umkreis um Marwitzer Str. 67, 13589 Berlin**.

## Funktionen

- interaktive OpenStreetMap-Karte mit festem 10-km-Radius
- Suche nach Arzt/Praxis, Fachrichtung und Adresse
- Filter nach Fachrichtung und Entfernung
- kompakte Detailansicht für Handy und PC
- Fachrichtung, Entfernung, Öffnungszeiten, Telefon, Webseite und Barrierefreiheit, sofern in der Quelle vorhanden
- Bewertungen nur bei vorhandenem nutzbaren Bewertungswert; sonst direkter Link zur Bewertungssuche
- PWA: auf Android und iPhone zum Startbildschirm hinzufügbar
- automatische Aktualisierung der Arzt-Daten **jeden Montag** über GitHub Actions
- kein Cloudflare und kein laufender PC erforderlich

## Datenquelle

Die Praxisdaten stammen aus OpenStreetMap über die Overpass API. Die Startadresse wird über Nominatim geokodiert und im Datensatz gespeichert. Der Updater besitzt zusätzlich einen festen Fallback-Mittelpunkt und mehrere Overpass-Endpunkte, damit ein einzelner Geocoding- oder API-Ausfall die Wochenaktualisierung nicht dauerhaft blockiert.

OpenStreetMap-Daten können unvollständig sein. Besonders Öffnungszeiten, Fachrichtungen, Telefonnummern und Webseiten sind nur sichtbar, wenn sie in der Quelle hinterlegt sind.

## Automatische Aktualisierung

Der Workflow **„Arzt-Daten wöchentlich aktualisieren“** aktualisiert `data/doctors.json` jeden Montag um **03:17 UTC**. Datenaktualisierung und GitHub-Pages-Deployment sind getrennt, damit neue Arzt-Daten auch dann gespeichert werden können, wenn Pages vorübergehend nicht bereitgestellt werden kann.

## GitHub Pages

Unter **Settings → Pages → Build and deployment → Source** muss **GitHub Actions** ausgewählt sein. Danach übernimmt der vorhandene Workflow **„GitHub Pages bereitstellen“** die Veröffentlichung bei jedem Push auf `main`.

App-Adresse:

`https://plasma19911.github.io/berlin-arzt-map/`

## Auf dem Handy installieren

### Android / Chrome

App öffnen → Browser-Menü → **App installieren** oder **Zum Startbildschirm hinzufügen**.

### iPhone / Safari

App öffnen → **Teilen** → **Zum Home-Bildschirm**.

## Datenschutz / Hinweise

- Die Karte benötigt keinen Standortzugriff des Handys.
- Die feste Startadresse ist Bestandteil dieses öffentlichen Repositorys.
- Es werden keine Google-API-Schlüssel oder andere Secrets benötigt.
- Bewertungsportale werden nicht automatisiert ausgescrapt.
- Vor einem Arztbesuch Öffnungszeiten und Kontaktdaten nach Möglichkeit auf der Praxiswebseite prüfen.
