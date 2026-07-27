# NC Combiner

Browserbasierte Oberfläche zum Zusammenführen von DIN-/ISO-NC-Dateien. Die geladenen NC-Dateien und Werkzeugtabellen werden direkt im Browser verarbeitet und nicht an den Server hochgeladen.

## Schnellstart mit Docker Compose

### 1. Voraussetzungen

Auf dem Rechner oder Server muss Docker inklusive Docker Compose installiert sein. Test:

```bash
docker --version
docker compose version
```

### 2. Projektordner vorbereiten

Den kompletten Projektordner auf den Rechner bzw. Server kopieren und im Terminal in diesen Ordner wechseln:

```bash
cd /pfad/zu/NcCombiner
```

Optional, aber für einen Server dringend empfohlen: die Beispiel-Konfiguration kopieren und Passwörter ändern.

Linux/macOS:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Danach die Datei `.env` öffnen und mindestens `ADMIN_PASSWORD`, `POSTGRES_PASSWORD` und `JWT_SECRET` ersetzen.

### 3. Starten

```bash
docker compose up -d --build
```

Beim ersten Start werden das Frontend gebaut, PostgreSQL gestartet und die Datenbank angelegt. Danach im Browser öffnen:

- Lokal: <http://localhost:8023>
- Im Netzwerk/auf einem Server: `http://SERVER-IP:8023`

Für einen öffentlich erreichbaren Server ist ein Reverse Proxy mit HTTPS empfehlenswert.

### 4. Prüfen, ob alles läuft

```bash
docker compose ps
docker compose logs -f nc-combiner
```

`Ctrl+C` beendet nur die Log-Anzeige, nicht den laufenden Stack.

## Aktualisieren

Nach Änderungen im Projektordner oder nach einem Update:

```bash
docker compose up -d --build
```

Danach im Browser einmal `Strg+F5` drücken, damit keine alte JavaScript-Datei aus dem Browser-Cache verwendet wird.

## Stoppen und Daten

Stack stoppen, Datenbank behalten:

```bash
docker compose down
```

Komplett löschen, inklusive Datenbank, Benutzerkonten, Postprozessoren und Bibliotheken:

```bash
docker compose down -v
```

Achtung: Der letzte Befehl löscht die gespeicherten Daten dauerhaft.

## Bedienung

1. NC-Dateien (`.din`, `.nc`, `.tap`, `.txt`) per Klick auswählen oder per Drag & Drop auf die Seite ziehen.
2. Die Dateikacheln per Drag & Drop in die gewünschte Reihenfolge bringen.
3. Vorschübe, Drehzahlen, Nullpunkt, Werkzeug und Operationsfarbe anpassen.
4. Zwischenblöcke am Ende einer Datei hinzufügen, zum Beispiel Leerzeilen, Wartezeit, Pause oder eine weitere NC-Datei.
5. Rechts zwischen Grafik- und Textvorschau wechseln, Ergebnis prüfen und herunterladen.

## Anmeldung und Administration

Der Merge funktioniert ohne Anmeldung. Für die Verwaltung von Postprozessoren, Aliasen und Benutzern ist ein Admin-Login erforderlich.

Standard-Zugang beim ersten Start, falls nicht in `.env` geändert:

- Benutzer: `admin`
- Passwort: `change-me-123!`

Dieses Passwort auf einem Server unbedingt vor der produktiven Nutzung ändern.

## Postprozessoren

- Beamicon / Benezan: Verweilzeit standardmäßig `G4 H{seconds}`
- Estlcam, LinuxCNC und EdingCNC: eigene, im Adminbereich editierbare Vorlagen

Postprozessoren, NC-Aliase, Benutzer, gespeicherte Programme und Werkzeuglisten werden dauerhaft in PostgreSQL gespeichert.

## Wenn Dateiupload nicht funktioniert

Der Dateiimport geschieht im Browser. Die Datei wird nicht an Docker oder PostgreSQL hochgeladen. Daher helfen meist diese Schritte:

1. Seite mit `Strg+F5` komplett neu laden.
2. Sicherstellen, dass auf dem Server wirklich der aktuelle Stack mit `docker compose up -d --build` läuft.
3. Die Browser-Konsole auf eine konkrete Fehlermeldung prüfen.
4. NC-Dateien nur mit den Endungen `.din`, `.nc`, `.tap` oder `.txt` auswählen.
