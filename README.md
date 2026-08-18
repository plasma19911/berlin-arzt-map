# Berlin Arzt Map

Installierbare mobile Karte mit Ärzten, Praxen, Zahnärzten, Kliniken und medizinischen Versorgungszentren im **10-km-Umkreis um Marwitzer Str. 67, 13589 Berlin**.

## Funktionen

- interaktive OpenStreetMap-Karte mit 10-km-Radius
- Suche nach Arzt/Praxis, Fachrichtung und Adresse
- Filter nach Fachrichtung und Entfernung
- kompakte Handy-Detailansicht
- Fachrichtung, Entfernung, Öffnungszeiten, Telefon, Webseite und Barrierefreiheit
- Bewertung nur dann, wenn ein frei nutzbarer Datenwert vorhanden ist; ansonsten Link zur Bewertungssuche
- als PWA auf Android/iPhone zum Startbildschirm hinzufügbar
- automatische Aktualisierung der Arzt-Daten **einmal pro Woche** über GitHub Actions
- keine laufende PC-Software erforderlich

## Datenquellen

Praxisdaten stammen aus OpenStreetMap über die Overpass API. Die Startadresse wird beim allerersten Datenlauf einmalig über Nominatim geokodiert und danach im Datensatz zwischengespeichert. OpenStreetMap-Daten sind nicht garantiert vollständig; Öffnungszeiten und Kontaktdaten können fehlen oder veraltet sein.

## Einmalige Einrichtung

### 1. Arzt-Daten zum ersten Mal erzeugen

Im GitHub-Repository:

1. **Actions** öffnen.
2. Workflow **„Arzt-Daten wöchentlich aktualisieren“** auswählen.
3. **Run workflow** anklicken.
4. Nach dem Lauf enthält `data/doctors.json` die aktuellen Einträge.

Danach läuft der Workflow automatisch jeden Montag um 03:17 UTC.

### 2. GitHub Pages aktivieren

1. **Settings → Pages** öffnen.
2. Unter **Build and deployment** als Source **GitHub Actions** wählen.
3. Workflow **„GitHub Pages bereitstellen“** starten oder einen Commit auf `main` abwarten.

Die App ist anschließend typischerweise unter folgender Adresse erreichbar:

`https://plasma19911.github.io/berlin-arzt-map/`

### 3. Auf dem Handy installieren

- Android/Chrome: Menü → **Zum Startbildschirm hinzufügen** / **App installieren**
- iPhone/Safari: Teilen → **Zum Home-Bildschirm**

## Optional: Cloudflare Pages

Das Repository ist vollständig statisch und kann alternativ direkt mit Cloudflare Pages verbunden werden. Build-Befehl: **kein Build-Befehl**, Ausgabeverzeichnis: Repository-Wurzel (`/`). Jeder wöchentliche Daten-Commit löst dann automatisch ein neues Deployment aus.

## Datenschutz / Hinweise

- Die Karte verlangt keinen Standortzugriff des Handys.
- Die feste Startadresse ist Bestandteil dieses öffentlichen Repositorys.
- Keine Google-API-Schlüssel oder andere Secrets in Dateien eintragen.
- Für Bewertungen wird kein fremdes Bewertungsportal automatisiert ausgescrapt.
