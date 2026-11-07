# Changelog

## 0.1.0 (2026-11-07)

- Initial local DTU reader with short-lived TCP connections, serialized requests and a two-second minimum pause.
- Normalized grid/inverter/PV values and complete decoded operating data.
- Historical power curves with pagination, timestamps and energy counters.
- Connection quality, response age, measurement changes and per-request diagnostics.
- Automatic recovery after failed requests without device reboot or configuration writes.
- Total and PV daily energy reset at midnight Europe/Berlin, with persistent offline/restart handling and previous-day protection; original DTU counters remain separately available.
- Admin configuration, protocol tests, ioBroker package/startup tests and manual publication workflow.
