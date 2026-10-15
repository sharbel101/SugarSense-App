import type { GlucoseOk } from '../api/glucoseContract';

export type RiskSummary = {
  /** True when the service flagged a risk, or the reading is already low/high. Drives the "Alert" chip. */
  alerting: boolean;
  lines: string[];
};

/**
 * Maps the endpoint's low/high groups to display text. The rules (backend README section 6):
 * `alert: null` is "not supplied", never "no risk"; probabilities are about a NEW episode, so when
 * the reading is already low/high that is said instead of any reassurance. Upstream `headline`
 * text is passed through unmodified.
 */
export function summariseRisk(data: GlucoseOk): RiskSummary {
  const lines: string[] = [];

  const groups = [
    { g: data.low, name: 'low', already: 'Glucose is already low.', flagged: 'Low-glucose risk flagged by the forecast.' },
    { g: data.high, name: 'high', already: 'Glucose is already high.', flagged: 'High-glucose risk flagged by the forecast.' },
  ];

  for (const { g, already, flagged } of groups) {
    if (g.alert === true) lines.push(g.headline && g.headline.trim() ? g.headline : flagged);
    else if (g.already === true) lines.push(already);
  }
  if (lines.length > 0) return { alerting: true, lines };

  if (data.low.alert === false && data.high.alert === false) {
    return { alerting: false, lines: ['No new low or high episode flagged by the forecast.'] };
  }
  return { alerting: false, lines: ['Risk signal not supplied by the forecast service.'] };
}
