# NC Combiner

Browser-basierte Oberfläche zum Zusammenführen von Beamicon-/DIN-NC-Dateien. Die Verarbeitung erfolgt vollständig im Browser; hochgeladene NC-Programme und Werkzeugtabellen verlassen den Rechner nicht.

## Start mit Docker

```bash
docker compose up --build
```

Danach ist die Anwendung unter <http://localhost:8023> erreichbar.

## Bedienung

1. NC-Dateien (`.din`, `.nc`, `.tap`, `.txt`) hochladen und per Drag & Drop sortieren.
2. Optional eine Werkzeugtabelle als CSV, JSON oder Textdatei laden. CSV-Spalten wie `tool`, `toolNumber`, `nummer` sowie `name`, `bezeichnung` werden erkannt.
3. Für jeden Abschnitt Vorschub, Drehzahl, Werkstücknullpunkt und Werkzeugwechsel bearbeiten.
4. Ein Postprozessorprofil auswählen oder Kopf und Ende anpassen.
5. Vorschau prüfen und die kombinierte `.din`-Datei herunterladen.

Das Standardprofil entspricht dem Kopf/Ende der bereitgestellten Beamicon-Programme. Beim Kombinieren wird der Kopf nur einmal vorangestellt und `M9 / G53 / G0 Z0 / G28 / M30 / %` nur einmal ans Ende geschrieben.

## Administration und Datenbank

Die Anwendung ist unter <http://localhost:8023> erreichbar. Der Merge selbst benötigt keine Anmeldung.

Postprozessoren und NC-Aliase werden dauerhaft in PostgreSQL gespeichert und sind über **Verwaltung** in der Oberfläche administrierbar.

- Benutzer: `admin`
- Passwort: `change-me-123!`

## Benutzerbibliothek

Der Combiner kann weiterhin ohne Anmeldung verwendet werden. über **Persönliche Bibliothek** können angemeldete Nutzer kombinierte G-Code-Dateien und Werkzeuglisten privat speichern und wieder laden.

Admins können in der **Benutzerverwaltung** Konten anlegen oder löschen, Passwörter zurücksetzen und Benutzer zu Admins machen bzw. die Admin-Rolle entziehen.

## Controllerprofile

Neben Beamicon, Estlcam und LinuxCNC wird EdingCNC als Datenbank-Standardprofil angelegt. Das Profil basiert auf der [EdingCNC G-Code-Referenz](https://docs.edingcnc.com/supported-g-code) und verwendet einen kompatiblen Programmrahmen mit `G17 G21 G40 G49 G54 G80 G90 G94`, `G64` sowie `M30`.

## Frontend-Build

Docker liefert das bereits erzeugte `dist`-Frontend aus und installiert im Container nur die Backend-Abhängigkeiten. Dadurch bleibt `docker compose up --build` schnell und reproduzierbar. Nach Änderungen in `src/` vor dem Docker-Build einmal lokal ausführen:

```bash
npm ci
npm run build
docker compose up --build
```
