import { IconName } from '../components/Icon';

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
