import { IconName } from '../components/Icon';

export const currentGlucose = {
  value: 126,
  unit: 'mg/dL',
  trend: 'stable' as const,
  statusLabel: 'Stable',
  contextLabel: 'In range · updated 2 min ago',
};

export const homeChart = {
  viewBoxWidth: 350,
  viewBoxHeight: 150,
  actual: [
    { x: 0, y: 96 },
    { x: 35, y: 92 },
    { x: 70, y: 84 },
    { x: 105, y: 78 },
    { x: 140, y: 80 },
    { x: 175, y: 74 },
    { x: 210, y: 72 },
  ],
  predicted: [
    { x: 210, y: 72 },
    { x: 245, y: 67 },
    { x: 280, y: 63 },
    { x: 315, y: 62 },
    { x: 350, y: 60 },
  ],
  band: [
    { x: 210, y: 72 },
    { x: 245, y: 60 },
    { x: 280, y: 50 },
    { x: 315, y: 44 },
    { x: 350, y: 40 },
    { x: 350, y: 84 },
    { x: 315, y: 80 },
    { x: 280, y: 76 },
    { x: 245, y: 74 },
    { x: 210, y: 72 },
  ],
  nowX: 210,
  gridLinesY: [112],
  axisLabels: ['-3h', 'Now', '+60m', '+120m'],
};

export const predictChart = {
  viewBoxWidth: 350,
  viewBoxHeight: 190,
  actual: [
    { x: 0, y: 102 },
    { x: 30, y: 98 },
    { x: 60, y: 96 },
  ],
  predicted: [
    { x: 60, y: 96 },
    { x: 140, y: 84 },
    { x: 220, y: 72 },
    { x: 300, y: 64 },
  ],
  band: [
    { x: 60, y: 96 },
    { x: 140, y: 84 },
    { x: 220, y: 72 },
    { x: 300, y: 64 },
    { x: 300, y: 116 },
    { x: 220, y: 108 },
    { x: 140, y: 100 },
    { x: 60, y: 96 },
  ],
  nowX: 60,
  highlightPoint: { x: 140, y: 84 },
  gridLinesY: [50, 100, 150],
  axisLabels: ['Now', '30m', '60m', '90m', '120m'],
  tooltip: { minutes: 60, median: 154, low: 137, high: 176 },
};

export const postMealChart = {
  viewBoxWidth: 350,
  viewBoxHeight: 190,
  actual: [{ x: 0, y: 163 }],
  predicted: [
    { x: 0, y: 163 },
    { x: 40, y: 139 },
    { x: 80, y: 109 },
    { x: 140, y: 74 },
    { x: 200, y: 90 },
    { x: 260, y: 109 },
    { x: 320, y: 127 },
    { x: 350, y: 133 },
  ],
  band: [
    { x: 0, y: 158 },
    { x: 40, y: 132 },
    { x: 80, y: 102 },
    { x: 140, y: 60 },
    { x: 200, y: 78 },
    { x: 260, y: 102 },
    { x: 320, y: 120 },
    { x: 350, y: 128 },
    { x: 350, y: 142 },
    { x: 320, y: 134 },
    { x: 260, y: 116 },
    { x: 200, y: 92 },
    { x: 140, y: 88 },
    { x: 80, y: 116 },
    { x: 40, y: 146 },
    { x: 0, y: 168 },
  ],
  highlightPoint: { x: 140, y: 74 },
  axisLabels: ['Now', '45m', '1h30m', '2h30m'],
};

export const safetyNormal = {
  headline: 'LOW RISK',
  message: 'No increased low-risk signal detected.',
  hypoRisk: 'Low',
  trend: 'Stable',
  wearableStatus: 'Connected',
  dataQuality: 'Good',
};

export const safetyAttention = {
  headline: 'ATTENTION',
  message: 'Your predicted low risk has increased.',
  factors: [
    { icon: 'trendDown' as IconName, label: 'Glucose trend', value: 'Declining faster than usual' },
    { icon: 'trendUp' as IconName, label: 'Recent activity', value: 'Higher than typical for this time' },
    { icon: 'trendDown' as IconName, label: 'HRV', value: 'Below your baseline' },
  ],
  dataQuality: 'Good',
  suggestion: {
    title: 'A snack or a short check-in may help',
    body: 'Based on the current trend, glucose may continue to drop over the next 30–45 minutes.',
  },
};

export const wearableNormal = { hr: 74, hrv: 48, movement: 'Normal', coverage: '98%' };
export const wearableAttention = { hr: 88, hrv: 31, movement: 'Elevated', coverage: '96%' };

export const latestMeal = { name: 'Chicken + rice', carbs: 54, timeAgo: '25 min ago' };

export const bolusSuggestion = {
  units: 4.5,
  breakdown: [
    { label: 'Carbs', value: '54g' },
    { label: 'Carb ratio', value: '1 U : 12g' },
    { label: 'Correction (126 mg/dL, target 110)', value: '+0.3 U' },
    { label: 'Insulin on board', value: '−0.3 U' },
  ],
};

export const insights = [
  { title: 'Pattern detected', text: 'Your glucose tends to rise faster after higher-carbohydrate breakfasts.' },
  {
    title: 'Activity pattern',
    text: 'Your recent evening activity has been followed by lower glucose more frequently.',
  },
  { title: 'Meal pattern', text: 'Your recent meal estimates have had higher uncertainty than usual.' },
  { title: 'Glucose pattern', text: 'Your morning glucose has been more variable this week.' },
];

type FactorBg = 'blue' | 'amber' | 'purple' | 'green';

export const forecastFactors: { icon: IconName; bg: FactorBg; label: string; value: string }[] = [
  { icon: 'trending', bg: 'blue', label: 'Current glucose', value: '126 mg/dL, steady' },
  { icon: 'trending', bg: 'blue', label: 'Recent trend', value: 'Gentle rise over the last 45 min' },
  { icon: 'fork', bg: 'amber', label: 'Recent meal', value: 'Chicken + rice, 54g carbs · 25 min ago' },
  { icon: 'droplet', bg: 'purple', label: 'Insulin', value: '4.5 U taken 20 min ago' },
  { icon: 'activity', bg: 'green', label: 'Activity', value: 'Low movement in the last hour' },
  { icon: 'heart', bg: 'purple', label: 'Wearable context', value: 'HR 74 bpm · HRV near baseline' },
];

export const advancedForecastDetails =
  'Forecast layer: personalized glucose model v2.3\nInputs: CGM (5-min), meal log, bolus log, wearable HR/HRV\nData quality: Good · Last calibrated: today';
