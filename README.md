# ioBroker.hoymiles-wifi

Lokaler ioBroker-Adapter für Hoymiles-WLAN-DTUs. / Local ioBroker adapter for Hoymiles WiFi DTUs.

**Entwicklungsversion 0.4.1.** Die Unterstützung einzelner Abfragen hängt von DTU und Firmware ab. Der Adapter verändert keine Geräteeinstellungen und sendet keine Neustart-, Leistungsbegrenzungs- oder Firmwarebefehle.

## Installation

Voraussetzungen: Node.js ab 22.19.0, ioBroker js-controller ab 6 und Admin ab 5. Die DTU muss vom ioBroker-Rechner im lokalen Netzwerk erreichbar sein; Standardport ist TCP 10081.

Nach Bereitstellung dieses Repositorys in ioBroker unter **Adapter → Benutzerdefinierte Installation → Von GitHub** die Adresse `https://github.com/BeSiRe1/ioBroker.hoymiles-wifi` verwenden. Danach eine Instanz anlegen, DTU-Adresse eintragen und speichern. Ein Hoymiles-Konto ist nicht erforderlich.

Nur eine aktive lokale Integration sollte dieselbe DTU abfragen. Eine bestehende ioBroker- oder Home-Assistant-Anbindung vor dem Umstieg deaktivieren.

## Einstellungen

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| DTU-Adresse | leer | IP-Adresse oder Hostname |
| Port | 10081 | Lokaler DTU-Port |
| Livewerte | 35 Sekunden | Abstand nach Abschluss einer Liveabfrage; mindestens 35 Sekunden |
| History | 300 Sekunden | Mindestens fünf Minuten; Hintergrundabfragen können bis zum nächsten freien Abfragefenster warten |
| Antwortwartezeit | 10 Sekunden | Maximal 3–30 Sekunden pro Anfrage |

Alle Anfragen laufen durch dieselbe Warteschlange. Pro Anfrage wird eine eigene TCP-Verbindung geöffnet und anschließend geschlossen. Nach dem Schließen liegen mindestens zwei Sekunden bis zur nächsten Anfrage. Es gibt keinen regelmäßigen zusätzlichen Heartbeat und keinen automatisch aktivierten Performance-Modus. Eine zusätzliche Abfrage erfolgt frühestens fünf Sekunden nach einer Liveabfrage; danach bleibt die nächste Liveabfrage geplant.

## Datenpunkte

Die Geräte liegen unter `hoymiles-wifi.0.<DTU-Seriennummer>`. Normalisierte Datenpunkte werden nur angelegt, wenn die DTU die zugehörigen Werte liefert. Ein echter Wert 0 bleibt 0; fehlende Daten werden nicht durch eine erfundene 0 ersetzt.

Bei tatsächlich enthaltenen Wechselrichter-/PV-Datensätzen gelten für die Standardmesswerte die im Protobuf-Protokoll definierten Nullwerte, die auf der Leitung nicht nochmals übertragen werden müssen. Dadurch werden beispielsweise Nachtleistung und leere Tageszähler korrekt 0. Werte, die in einer neuen vollständigen Antwort fehlen, werden auf null mit schlechter Qualität gesetzt und behalten keinen scheinbar gültigen alten Wert.

| Bereich | Inhalt |
| --- | --- |
| `grid` | Leistung, Spannung, Strom, Frequenz, Blindleistung, Leistungsfaktor und Tagesertrag |
| `inverter` | Übersicht bei einem Wechselrichter, Temperatur, Seriennummer, Warnungen und gemeldetes Leistungslimit |
| `pv0`, `pv1`, … | PV-Eingänge bei einem einzelnen Wechselrichter: Leistung, Spannung, Strom, Tages-/Gesamtertrag und Fehlercode |
| `dtu` | Seriennummer und gemeldete Geräte-/Firmwareinformationen |
| `history` | Vollständiger zeitlicher Leistungsverlauf der abgefragten DTU-Antwort, Zeitstempel, Zeitraster und Energiezähler |
| `info` | Erreichbarkeit, Alter, Fehler und Status der einzelnen Abfragen |

Wechselrichterdaten stehen unter `inverter`, die PV-Eingänge direkt unter `pv0`, `pv1` usw. Zusätzliche nicht normalisierte Protokollfelder werden nicht als Datenpunkte ausgegeben. Passwörter und Verschlüsselungsmaterial werden nicht veröffentlicht.

Das Geräteobjekt ist über `info.connected` mit der Online-/Offline-Markierung im ioBroker-Admin verknüpft. Sie zeigt die Erreichbarkeit der DTU an.

### History

- `powerJson`: sämtliche vollständig empfangenen Leistungspunkte in W.
- `pointsJson`: dieselben Punkte als `{ts, power}` mit Unix-Zeit in Millisekunden, sofern Beginn und Zeitraster vorliegen.
- `startTime`: Beginn des Leistungsverlaufs in Unix-Millisekunden.
- `stepTime`: Abstand der Punkte in Sekunden.
- `dailyEnergy`: gemeldeter Tagesertrag in Wh.
- `totalEnergy`: gemeldeter Gesamtertrag in kWh, ohne Rundung auf eine Nachkommastelle.

Ein in mehreren Teilen übertragener Leistungsverlauf wird erst nach erfolgreichem Empfang aller Teile veröffentlicht. Eine unvollständige Abfrage überschreibt keinen vorhandenen Leistungsverlauf. Die lokale DTU-Schnittstelle ersetzt kein unbegrenztes Cloud-Archiv: verfügbar ist, was die konkrete DTU auf diese historische Abfrage liefert. Ein Abruf sämtlicher vergangener Monate oder Jahre wird nicht zugesichert. Langfristige Aufzeichnung ist über ioBroker-History, InfluxDB oder vergleichbare Historisierung möglich.

### Tagesertrag um Mitternacht

`grid.dailyEnergy` sowie die Tageserträge der einzelnen PV-Eingänge werden um **00:00 Uhr Europe/Berlin** auf 0 gesetzt, auch bei ausgeschalteter oder nicht erreichbarer DTU. Sommer-/Winterzeit werden berücksichtigt. Ein beim Adapterstillstand verpasster Tageswechsel wird beim Start nachgeholt, sobald die DTU aus der gespeicherten Zuordnung bekannt ist.

Die ursprünglichen DTU-Tageszähler stehen parallel unter `dailyEnergyDtu`. Die historischen Zähler unter `history` bleiben dem Tag zugeordnet, für den die DTU den Leistungsverlauf geliefert hat. Dieses Datum steht unter `history.curveDay`.

Tagesstände und Vortagesgrenzen werden im lesbaren JSON-Zustand `internal.dailyEnergy` gespeichert. Beim neuen Tag werden positive Werte erst übernommen, wenn eine Zählerrücksetzung oder ein passender, neu abgerufener Leistungsverlauf desselben Tages vorliegt. Bis dahin zeigt der Tageszähler 0 und `info.dailyConfirmed` ist false. Das gilt auch für die erste Einrichtung bei einem positiven Tageszähler. Bekannte alte Vortagesstände und verspätete Antworten von vor Mitternacht werden gesperrt. Innerhalb eines Tages werden keine Rücksprünge übernommen. Adapterneustarts löschen keine bestätigten Tagesstände; unveränderte Tagesstände werden nicht laufend erneut gespeichert.

### Ertragsarchive und Tagesdurchschnitt

Unter `grid.yields` und den jeweiligen `pv0.yields`, `pv1.yields` usw. werden bestätigte Erträge dauerhaft gespeichert. `daysJson` enthält abgeschlossene Tage mit `Datum` im Format TT.MM.JJJJ und `Ertrag`; `monthsJson` abgeschlossene Monate mit `Datum` im Format MM.JJJJ und `Ertrag`; `yearsJson` abgeschlossene Jahre mit `Jahr` und `Ertrag`. Die Listen sind absteigend nach Datum sortiert. `Ertrag` ist eine Zeichenfolge in kWh mit höchstens zwei Nachkommastellen.

`month` und `year` enthalten die laufenden Summen einschließlich des bereits bestätigten heutigen Tages. `average` ist der Tagesdurchschnitt über die abgeschlossenen erfassten Tage; `daysRecorded` ist deren Anzahl. Der laufende Tag wird beim Tageswechsel abgeschlossen. `startDate` zeigt den Beginn der Erfassung. `qualityJson` beschreibt die Datenabdeckung; nicht erfasste Tage werden nicht als Nullerträge erfunden.

Maßgeblich ist der persistente Speicher `internal.yields`. Wiederholte Messwerte und Neustarts werden nicht doppelt gezählt. Monats-/Jahreswechsel und Sommer-/Winterzeit folgen Europe/Berlin. Ein nicht lesbarer Speicher bleibt erhalten; `info.yieldsError` zeigt den Fehler. Neue Installationen beginnen ohne persönliche Altdaten. Eine vorhandene Historie wird bei Bedarf einmalig außerhalb des Adapters übertragen; persönliche Quell-IDs sind kein Bestandteil des Pakets.

### Externe Ertragssicherung

In den Adaptereinstellungen kann die Ertragssicherung eingeschaltet und ein vorhandener ioBroker-Ordner unter `0_userdata.0` ausgewählt werden. Standardmäßig ist sie ausgeschaltet. Der Adapter legt dort `Hoymiles_<DTU-Seriennummer>_Ertragssicherung` an. Das JSON enthält den vollständigen Ertragsbestand und den Tageswechsel-Schutz, ohne Kennwörter oder Verbindungsdaten. Es bleibt beim Löschen dieser Adapterinstanz erhalten. Änderungen werden nach erfolgreicher interner Speicherung gesichert; unveränderte Daten werden nicht erneut geschrieben.

Nach einer Neuinstallation denselben Ordner auswählen, Einstellungen speichern und **Sicherung wiederherstellen** betätigen. Bei unbekannter DTU kann genau eine Sicherung im Ordner auch offline zugeordnet werden; bei mehreren Geräten muss zuerst die DTU-Verbindung stehen. Neu erfasste Tageswerte werden beim Wiederherstellen erhalten. Widersprüchliche Bestände, beschädigte Sicherungen und anderweitig belegte Datenpunkte werden nicht überschrieben. Eine zusätzliche Sicherung mit mehr Daten wird nicht automatisch durch einen neuen leeren Bestand ersetzt.

Die Konfiguration zeigt den Status und den letzten erfolgreichen Sicherungszeitpunkt. Dieselben Angaben stehen unter `info.yieldBackupStatus`, `info.yieldBackupError`, `info.yieldBackupLastSuccess` und `info.yieldBackupTarget`. Nach einem Speicherfehler wird die Übertragung mit dem nächsten Abgleich erneut versucht.

### Datenalter und Fehler

- `info.lastResponse`: letzte erfolgreiche Liveantwort.
- `info.responseAge`: Sekunden seit dieser Antwort, vor der ersten erfolgreichen Antwort -1.
- `info.lastValueChange` / `valueChangeAge`: Änderung des Betriebsdatenpakets; ein neuer Paketzeitstempel allein zählt nicht als Wertänderung. Dies ist kein garantierter Messzeitpunkt jedes einzelnen Sensors.
- `info.connected`: letzte Liveabfrage erfolgreich; bei einem Fehler false.
- `info.stale`: fehlgeschlagene oder deutlich überfällige Liveantwort.
- `info.consecutiveErrors`: Anzahl aufeinanderfolgender Livefehler.
- `info.capabilities`: `available`, `unavailable` oder `acknowledged` pro Zusatzabfrage. Eine reine Befehlsbestätigung ist noch keine bestätigte Alarm-/Ereignisliste. `inverter.errorCode` enthält den neuesten aktiven Wechselrichter-Alarmcode; ohne bestätigte Liste bleibt er unbekannt. `unavailable` kann auch eine vorübergehende Störung bedeuten.

Bei Fehlern bleiben die letzten Messwerte erhalten, werden aber mit schlechter Qualität (`q=0x40`) markiert. Ein erfolgreicher neuer Abruf stellt normale Qualität wieder her. Fehler einer einzelnen Zusatzabfrage markieren nur deren Daten. Nach wiederholten Livefehlern werden DTU-Informationen und Verschlüsselung erneut ermittelt. Ein Gerätestart wird dafür nicht ausgelöst.

## Entwicklung und Tests

`npm ci`, danach `npm run check` und `npm test`. Die Tests decken Protokoll-/Verschlüsselungsreferenzen, fragmentierte TCP-Antworten, History-Seiten, Fehlersituationen, Einheiten, Maskierung, Wiederanlauf sowie die offiziellen ioBroker-Paket- und Startprüfungen ab. Die GitHub-Prüfung verwendet Node.js 22 und 24.

Die Datei `.github/workflows/publish.yml` übernimmt den manuellen Veröffentlichungsablauf des Faikin-Projekts. Sie wird nur über `workflow_dispatch` gestartet und benötigt für npm ein eingerichtetes `NPM_TOKEN`. Normale GitHub-Pushes veröffentlichen kein npm-Paket.

## English

This development adapter reads a Hoymiles WiFi DTU directly over the local network. It requires Node.js 22.19+, js-controller 6+ and Admin 5+. Configure the DTU host and TCP port 10081. Live polling defaults to 35 seconds and historical polling to five minutes. All requests share a serialized queue, use a short-lived connection and wait at least two seconds after closing.

Managed total/PV daily energy counters reset at midnight in Europe/Berlin, including offline operation and daylight-saving changes. Original device counters remain available as `dailyEnergyDtu`. Persistent restart protection and a current-day confirmation guard prevent the previous day's final value from immediately repopulating a reset counter; `info.dailyConfirmed` indicates confirmation.

Normalized grid, inverter, direct PV and history states are provided where supported. Version 0.4.1 uses only the simplified inverter and direct PV structure, with device online/offline marking through info.connected and active inverter alarms through inverter.errorCode. Passwords and encryption material are never published. Historical pages are committed only as a complete result. Local history availability depends on the device and firmware and is not an unlimited cloud archive. Failed requests preserve old values with bad quality, publish diagnostic status and recover automatically. The adapter has no device-changing controls.

Only one local integration should query the same DTU. See the German tables above for state groups and configuration. Tests and CI cover protocol, networking, projections and ioBroker startup. See [CHANGELOG.md](CHANGELOG.md), [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
