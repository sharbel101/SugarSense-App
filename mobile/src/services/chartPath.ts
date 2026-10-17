/**
 * Smooth SVG path through chart points (monotone cubic, Fritsch-Carlson): passes through every
 * point and never overshoots between them, so a smoothed glucose line cannot dip below or rise
 * above its own readings. Pure. x must be increasing; with fewer than 3 points, or if it is not,
 * a straight polyline path is returned instead.
 */
export type PathPoint = { x: number; y: number };

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function polylinePath(points: PathPoint[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)} ${f(p.y)}`).join(' ');
}

export function monotonePath(points: PathPoint[]): string {
  const n = points.length;
  if (n < 3) return polylinePath(points);
  for (let i = 1; i < n; i++) if (!(points[i].x > points[i - 1].x)) return polylinePath(points);

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    slope.push((points[i + 1].y - points[i].y) / dx[i]);
  }
  const tangent: number[] = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Fritsch-Carlson limiter: keep each segment monotone.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }

  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const c1x = points[i].x + h / 3;
    const c1y = points[i].y + (tangent[i] * h) / 3;
    const c2x = points[i + 1].x - h / 3;
    const c2y = points[i + 1].y - (tangent[i + 1] * h) / 3;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(points[i + 1].x)} ${f(points[i + 1].y)}`;
  }
  return d;
}
