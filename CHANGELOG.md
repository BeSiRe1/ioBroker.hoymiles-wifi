# Changelog

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
