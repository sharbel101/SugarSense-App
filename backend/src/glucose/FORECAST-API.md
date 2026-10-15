# Forecast service API (`GET /glucose`)

Source of truth: `/home/ubuntu/forecast/forecast_service.py` on the VM (verified live 2026-10-15).
FastAPI/uvicorn, systemd unit `forecast.service`, port **8001**, 0.0.0.0. It is read-only over the
phone-collected CGM database (`bg.db`) and never writes it.

## How to call it

| | |
|---|---|
| Endpoints | `GET /glucose` (alias `GET /forecast/glucose`), `GET /healthz` (no auth) |
| From the Nest backend on the VM | `http://127.0.0.1:8001/glucose` |
| Auth | `Authorization: Bearer <FORECAST_API_TOKEN>` (constant-time compare) |
| Token location | `/home/ubuntu/forecast/forecast.env` on the VM. Backend reads it as `FORECAST_API_TOKEN` (+ optional `FORECAST_API_URL`, default `http://127.0.0.1:8001`). Never log it, never ship it in the app. |
| CORS | `GET`/`OPTIONS`, headers `Authorization`, `Content-Type` (allowlist from `FORECAST_ALLOWED_ORIGINS`) |
| Params | none |
| Cache | Response cached per newest reading, max 900 s; `meta.cached` tells you |
| Latency | ~1 ms inference, cached after first call |

```bash
curl -H "Authorization: Bearer $FORECAST_API_TOKEN" http://127.0.0.1:8001/glucose
```

The mobile/web app must NOT call this directly (token). It calls the Nest proxy, already written in
`backend/src/glucose/` (`forecast-upstream.client.ts` -> `map-upstream-glucose.ts` ->
`glucose-response.ts`), which returns the app contract described at the bottom.

## Status codes

| Code | Body | Meaning |
|---|---|---|
| 200 | JSON below | OK (forecast may still be unavailable, see `forecast_available`) |
| 401 | `{"detail":"unauthorized"}` | Missing/bad token |
| 422 | `{"detail":"insufficient recent glucose data"}` | No usable readings at all |
| 503 | `{"detail":"glucose data is stale"}` | Newest reading older than `FORECAST_STALE_MIN` (20 min) |
| 503 | `{"detail":"service not configured"}` | Token env missing on the service |
| 500 | `{"detail":"forecast unavailable"}` or `{"error":"internal error"}` | Build failure |

A large real data gap (>20 min gap, <50 min span, or too few readings) does NOT fail the request: only
`predictions`/`forecast` become `[]` with `forecast_available:false` and `meta.forecast_unavailable_reason`
set; glucose, history and hypo/hyper groups are still returned.

## 200 response (live sample, long arrays trimmed)

```jsonc
{
  "glucose": 230,                       // mg/dL, newest real reading
  "unit": "mg/dL",                      // always mg/dL
  "timestamp": "2026-10-14T20:54:00Z",  // time of that reading, UTC
  "history": [ {"time":"2026-10-14T19:57:00Z","value":158}, ... ],   // last ~60 min, REAL readings (~3-6 min apart)
  "predictions": [ {"time":"2026-10-14T20:59:00Z","value":233}, ... ], // 24 points, +5..+120 min, 5-min grid; [] if unavailable
  "forecast": [ {"minutes":0,"glucose":230}, {"minutes":5,"glucose":233}, ... ], // same data as predictions, minutes-relative (duplicate)
  "forecast_available": true,
  "hypoglycemia": {
    "15m_probability": 0.001, "30m_probability": 0.001, "45m_probability": 0.001,
    "calibrated": true, "already_low": false, "alert": false,
    "alert_since": null, "headline": null, "headline_horizon_min": null,
    "predicted_glucose_15m": 237, "predicted_glucose_30m": 233, "predicted_glucose_45m": 228
    // when already_low: also still_falling (bool) and note (string)
  },
  "hyperglycemia": {
    "15m_probability": 0.0008, "30m_probability": 0.0041, "45m_probability": 0.0151,
    "calibrated": true, "already_high": true, "alert": false, "alert_since": null,
    "headline": null, "headline_horizon_min": null,
    "predicted_glucose_15m": 237, "predicted_glucose_30m": 233, "predicted_glucose_45m": 228,
    "still_climbing": true, "note": "Currently 230 mg/dL and still climbing ...",
    "excursion": {                      // OPTIONAL; may be absent. mode: "shadow" (default) | "live" | "off"
      "mode": "shadow", "state": "HOLDING", "alert": false, "worsening_now": false,
      "current_glucose": 230, "upper_threshold": 180.0, "running_ceiling": 230,
      "predicted_peak": 237, "predicted_peak_minutes": 15, "predicted_peak_time": "2026-10-14T21:09:00Z",
      "excess_mgdl": 7, "meaningful_rise_mgdl": 39, "excursion_probability": 0.104,
      "expected_high_glucose": 237,
      "estimated_range": {"low":207,"high":253},
      "horizon_ranges": { "15":{"forecast":237,"low":207,"high":253}, "30":{...}, "45":{...} },
      "trend_mgdl_per_min": 0.8,
      "message": "Glucose is high but currently holding ...",
      "data_quality": {"state":"ok","flags":[]},
      "config": {"probability_threshold":0.29, ...}
    }
  },
  "hazard_low_risk": {                  // EXPERIMENTAL shadow model, not validated, do not drive UI/alerts
    "available": true, "status": "experimental_shadow_model_not_yet_prospectively_validated",
    "probability_30min": 0.0001, "predicted_low_30min": false,
    "probability_45min": 0.0004, "probability_60min": 0.0011, "any_predicted_low": false, ...
  },
  "meta": {
    "cached": true, "model": "direct_120", "model_sha256_prefix": "08c735f5f2e4",
    "history_points": 14, "model_input_points": 12, "resampled_from_real_readings": 18,
    "generated_at": "2026-10-14T20:59:21Z", "served_at": "2026-10-14T21:00:22Z",
    "forecast_unavailable_reason": null, "inference_ms": 0.69, "infer_count": 3471, ...
  }
}
```

### Semantics that matter

- **Forecast** = `direct_120` GRU, glucose-only, 60 min history -> 120 min ahead. Planning accuracy is
  not published in this service; treat as a prediction with no stated interval. Only the
  15/30/45 min ranges (`excursion.horizon_ranges`) carry low/high bounds, and in `shadow` mode they are
  not validated: label them.
- **Probabilities** are for a NEW episode starting (hypo <70, hyper >180 mg/dL, horizons 15/30/45 min
  only; no 120 min classifier exists). If `already_low`/`already_high` is true the probabilities do not
  mean "you are not low/high".
- **Nulls / absent keys** mean "not supplied", never "no" or zero. `alert: null` is not `alert: false`.
- `history` is untouched real data; `predictions` are model output. Never merge them as one series.
- `hypoglycemia.headline`/`alert` are set by the service's thresholds; it also feeds web push
  (`forecast-push.service`). This is separate from the watch `/bg` endpoint.
- Glucose is a CGM reading from the iCan follower app via the phone collector, so freshness depends on
  the phone pipeline (see `/agent/status` on port 8000).

## What the Nest proxy returns to the app (`GET /glucose` on Nest, already implemented)

Discriminated union on `status`, always HTTP 200:

- `{status:"ok", glucoseMgdl, measuredAt, ageMinutes (rounded up), history[], predictions[],
  forecastAvailable, forecastUnavailableReason, trendMgdlPerMin, low{...}, high{...},
  ranges[{minutes:15|30|45, low, high, forecast}]|null, rangesAreShadow, modelVersion, generatedAt, servedAt}`
- `{status:"stale", reason, lastMeasuredAt}` - upstream 503 stale, or reading too old
- `{status:"unavailable", reason}` - not configured, 401, timeout, network, invalid JSON, schema drift

Drops on purpose: `forecast[]` (duplicate), `hazard_low_risk` (unvalidated), `meta.normalization`,
`inference_ms`, and excursion `state`/`estimated_range`/`data_quality`.

## Known gaps

- Public exposure: the forecast service is also reachable through a Cloudflare quick tunnel
  (`forecast-tunnel.service`, random URL). Anything calling it publicly needs the token; the app should
  never hold it.
- `/glucose` on Nest has no authentication yet (also true of `/meals/analyze`). Fix before real users.
- Nginx `:8090` site must add `glucose` to its proxy regex `^/(health|meals)(/|$)` for the web app.
- Not for dosing: per CLAUDE.md section 2, no forecast output feeds the bolus calculator.
