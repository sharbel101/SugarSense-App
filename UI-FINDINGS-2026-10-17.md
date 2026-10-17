# Front-end findings from the full simulated-usage test (2026-10-17)

For the UI chat. The backend chat does not edit `mobile/`; these are what the real front end did when driven against a
dev backend (scratch database, a live dummy CGM, a downloaded food photo, dummy ratios 10 g/U and 50 mg/dL/U that exist only in
the scratch database). Contract changes are in `MASTER-PROMPT-UI-FORECAST-INTEGRATION.md` (section 1, "Contract additions").

## What worked
Photo -> editable meal -> carbs/insulin forms -> forecast with the adjusted line, band, glucose-only line, IOB/COB chips and the
"insulin not recorded" banner; offline save of a 20 g entry ("Not sent yet", then "Send now" -> "Saved. Forecast updated.") and the
server holds that entry exactly once; Predict, Safety and Insights tabs show honest empty states (no invented numbers); the code
drops the forecast on a server `stale` answer (`forecastState.ts`, `glucoseState.ts`). Not exercised visually: stale-server screen,
light mode, the trash/withdraw button (the browser pane kept stalling at page load).

## Problems to fix (most important first)
1. **"Logged today" stays "The list from the server is not available right now." after a queued entry is sent.** The list fetch failed
   during the outage and is not repeated when the queued entry goes through; only a full reload fixes it. Refresh the list after any
   successful save/send and on the next poll after a failure.
2. **Profile -> "Insulin settings" row is inert** (nothing opens). Build work package F, including `timezone` on save.
3. **Hard-coded "Connected" statuses** for devices that are not connected. Show real state or nothing (fabricated status breaks the
   "never show a fabricated number" rule in spirit).
4. **Duplicated unavailable text** when the forecast model is unavailable (the same sentence appears in the banner and in the chart area).
5. **Show the evidence label.** Use `models.eventLayerEvidence`: while `none_yet`, say the meal/insulin adjustment is "not yet validated".
6. **Chart flattened by a wide band.** A meal with no insulin recorded stretches the upper band toward 500 mg/dL and flattens the visible
   line. Clip the y-axis to the useful range (for example to the 90th percentile of the points plus margin) and mark "range continues above".
7. **Banner buttons ("Record insulin taken", "I took none")**: one click did nothing in the automated test while the pane was hidden. Check
   that the touch target and handler work when the page is not focused; may be a test artefact, worth one manual check.
8. **Blank screen for 20+ seconds on slow connections.** Nothing renders until the Manrope fonts finish loading ("Slow network is
   detected" in the console, `root` empty). Render the layout with a fallback font immediately, or show a splash/skeleton.

## Open question for the user (not for the UI chat to guess)
The person's real insulin-to-carb ratio and correction factor are unknown to the system. Nothing in the app or backend may default them.
