"""Builds a meal-response table from the CGMacros tables (PhysioNet, CC BY-NC-SA 4.0; data is NOT stored in this repo).

usage: python cgmacros_build.py <folder with CGMacros-0xx.csv> <out.npz>
For each isolated meal (>= 15 g carbohydrate, no other meal within 90 min before or 180 min after) it stores the glucose rise above the pre-meal
baseline every 5 minutes from 0 to 180 minutes, and the meal's macronutrients.
"""
import csv, glob, os, sys
import numpy as np

folder, out = sys.argv[1], sys.argv[2]
GRID = np.arange(0, 185, 5)
rows = []
for path in sorted(glob.glob(os.path.join(folder, "CGMacros-*.csv"))):
    pid = int(os.path.basename(path).split("-")[1].split(".")[0])
    recs = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    n = len(recs)
    def col(name):
        key = next((k for k in recs[0] if k.strip() == name), None)
        if key is None:
            return [np.nan] * len(recs)  # a few files lack a column (for example Amount Consumed): treated as unknown
        return [(float(r[key]) if r[key] not in ("", None) else np.nan) for r in recs]
    libre, dex = np.array(col("Libre GL")), np.array(col("Dexcom GL"))
    g = dex if np.mean(~np.isnan(dex)) >= 0.8 else libre
    sensor = "dexcom" if g is dex else "libre"
    carbs, prot, fat, fib, amt, cal = (np.array(col(c)) for c in ("Carbs", "Protein", "Fat", "Fiber", "Amount Consumed", "Calories"))
    mealtype = [r["Meal Type"] for r in recs]
    idx = [i for i, m in enumerate(mealtype) if m]
    for i in idx:
        scale = (amt[i] / 100.0) if not np.isnan(amt[i]) and amt[i] > 0 else 1.0
        c, p, f, fi = (np.nan_to_num(x[i]) * scale for x in (carbs, prot, fat, fib))
        if c < 15: continue
        others = [j for j in idx if j != i]
        if any(i - 90 <= j <= i + 180 for j in others): continue
        if i < 20 or i + 181 > n: continue
        base_w = g[i - 15:i + 1]
        if np.isnan(base_w).mean() > 0.3: continue
        base = np.nanmean(base_w)
        seg = g[i:i + 181]
        if np.isnan(seg).mean() > 0.1: continue
        seg = np.where(np.isnan(seg), np.interp(np.arange(len(seg)), np.where(~np.isnan(seg))[0], seg[~np.isnan(seg)]), seg)
        curve = seg[GRID] - base
        hr = np.array(col("HR"))[i - 15:i + 1]
        rows.append(dict(pid=pid, mealtype=mealtype[i], carbs=c, protein=p, fat=f, fiber=fi, calories=np.nan_to_num(cal[i]) * scale, base=base,
                         sensor=sensor, minute_of_day=int(recs[i]["Timestamp"][11:13]) * 60 + int(recs[i]["Timestamp"][14:16]), curve=curve))
print("participants with data:", len({r["pid"] for r in rows}), "isolated meals:", len(rows), "of which breakfast/lunch/dinner:",
      {m: sum(r["mealtype"].lower().startswith(m) for r in rows) for m in ("breakfast", "lunch", "dinner")})
np.savez(out, pid=[r["pid"] for r in rows], mealtype=[r["mealtype"] for r in rows], carbs=[r["carbs"] for r in rows], protein=[r["protein"] for r in rows],
         fat=[r["fat"] for r in rows], fiber=[r["fiber"] for r in rows], calories=[r["calories"] for r in rows], base=[r["base"] for r in rows],
         minute_of_day=[r["minute_of_day"] for r in rows], curves=np.array([r["curve"] for r in rows]), grid=GRID)
c = np.array([r["carbs"] for r in rows]); f = np.array([r["fat"] for r in rows]); p = np.array([r["protein"] for r in rows]); fi = np.array([r["fiber"] for r in rows])
q = lambda x: np.percentile(x, [10, 50, 90]).round(0)
print("carbs g p10/50/90", q(c), "fat", q(f), "protein", q(p), "fiber", q(fi))
