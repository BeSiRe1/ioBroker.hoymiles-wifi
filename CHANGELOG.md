# Changelog

## 0.4.1 (2026-11-10)

- Fix backup folder selection by explicitly selecting folder objects instead of applying a folder filter to the default state selection.
- Render backup actions as filled buttons with a visible border and larger padding.

## 0.4.0 (2026-11-10)

- Add optional complete external backups under a selected 0_userdata.0 folder, disabled by default.
- Validate device identity and checksums, protect existing data, restore while retaining newly recorded daily values, and expose backup status and last-success time.
- Add folder selection and backup status/restore controls to Admin configuration.

## 0.3.0 (2026-11-09)

- Add independent persistent yield archives for the grid and each PV input in Europe/Berlin, with restart-safe calendar closure and absolute daily counters.
- Publish finalized daily/monthly/yearly JSON arrays, live current-month/current-year totals including today, and the average of finalized recorded days.
- Preserve imported historic rows and independent aggregate baselines; personal data transfer is performed separately from the released adapter.
- Keep missing days visible through coverage metadata rather than fabricated zero records.

## 0.2.6 (2026-11-08)

- Add a German no-reported-error label for zero PV port error codes, including existing objects. Keep undocumented nonzero PV codes numeric and separate from the inverter alarm lookup.

## 0.2.5 (2026-11-08)

- Derive the active inverter error code from confirmed paginated warning lists as well as embedded alarm records. Ignore ended historical records.
- Treat confirmed warning lists as authoritative; command-only alarm acknowledgements and failures cannot clear their result. Failed or invalid warning reads yield unknown until confirmed again.

## 0.2.4 (2026-11-08)

- Remove the repeated code number from all 227 alarm labels. Keep numeric keys and stored values unchanged.

## 0.2.3 (2026-11-07)

- Silence DTU live/background connection failures, repeated retries and recovery messages. Preserve status states, data quality and automatic reconnection.

## 0.2.2 (2026-11-07)

- Add German labels for all 227 documented alarm/event codes in the combined lookup, identifying model-dependent meanings; retain numeric and unknown codes.
- Add percent to DTU signal quality and seconds to the unmodified communication timestamp. Update units and lookup metadata on existing states.

## 0.2.1 (2026-11-07)

- Publish the newest active inverter alarm code as inverter.errorCode. A confirmed list without active alarms yields 0; missing or invalid data remains unknown.

## 0.2.0 (2026-11-07)

- Remove raw output and the duplicated inverters tree. Keep inverter and direct pv0/pv1 channels.
- Bind the device online/offline marking to info.connected.
- Keep total/PV daily counters with midnight reset and restart protection.

## 0.1.0 (2026-11-07)

- Initial local DTU reader with short-lived TCP connections, serialized requests and a two-second minimum pause.
- Normalized grid/inverter/PV values and complete decoded operating data.
- Historical power curves with pagination, timestamps and energy counters.
- Connection quality, response age, measurement changes and per-request diagnostics.
- Automatic recovery after failed requests without device reboot or configuration writes.
- Total and PV daily energy reset at midnight Europe/Berlin, with persistent offline/restart handling and previous-day protection; original DTU counters remain separately available.
- Admin configuration, protocol tests, ioBroker package/startup tests and manual publication workflow.
