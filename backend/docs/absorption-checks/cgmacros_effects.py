"""Within-person effects of fat, protein, fibre and carbohydrate on post-meal glucose shape (CGMacros, non-type-1). usage: python cgmacros_effects.py meals.npz"""
import sys
import numpy as np

d = np.load(sys.argv[1], allow_pickle=True)
pid, G = d["pid"], d["grid"]
X = np.column_stack([d["carbs"], d["fat"], d["protein"], d["fiber"]]) / 10.0  # per 10 g
names = ["carbs/10g", "fat/10g", "protein/10g", "fiber/10g"]
C = d["curves"]
t_peak = G[15 // 5 + 0 + np.argmax(C[:, 3:], axis=1) + 0 + 0] if False else G[3 + np.argmax(C[:, 3:], axis=1)]  # search 15..180 min
peak = C[np.arange(len(C)), 3 + np.argmax(C[:, 3:], axis=1)]
at = lambda m: C[:, int(m // 5)]
late = C[:, int(120 // 5):].mean(axis=1)  # mean rise 120-180 min
early = C[:, :int(60 // 5) + 1].mean(axis=1)  # mean rise 0-60 min
auc = C.sum(axis=1) * 5 / 60.0  # mg/dL * h over 0-180
targets = {"time of peak (min)": t_peak, "peak rise (mg/dL)": peak, "rise at 60 min": at(60), "rise at 120 min": at(120), "rise at 180 min": at(180),
           "mean rise 0-60": early, "mean rise 120-180": late, "late/early ratio (clipped)": np.clip(late / np.maximum(early, 5), -2, 4)}

def demean(a, ids):
    out = np.array(a, float)
    for u in np.unique(ids):
        m = ids == u
        out[m] = out[m] - out[m].mean(axis=0)
    return out

def fit(y, X, ids):
    Xd, yd = demean(X, ids), demean(y, ids)
    b = np.linalg.lstsq(Xd, yd, rcond=None)[0]
    return b

rng = np.random.default_rng(1)
users = np.unique(pid)
print(f"{len(y := t_peak)} isolated meals, {len(users)} people; effects are WITHIN person (person means removed); 95% CI by resampling people (500x)\n")
print(f"{'outcome':30s}" + "".join(f"{n:>26s}" for n in names))
for k, y in targets.items():
    b = fit(y, X, pid)
    boots = []
    for _ in range(500):
        samp = rng.choice(users, len(users), replace=True)
        idx = np.concatenate([np.where(pid == u)[0] for u in samp])
        ids = np.concatenate([np.full((pid == u).sum(), j) for j, u in enumerate(samp)])
        boots.append(fit(y[idx], X[idx], ids))
    lo, hi = np.percentile(boots, [2.5, 97.5], axis=0)
    print(f"{k:30s}" + "".join(f"{b[j]:>9.2f} [{lo[j]:>6.2f},{hi[j]:>6.2f}]  " for j in range(4)))

print("\nmeal tertiles by fat (people-balanced is not attempted): mean curve rise (mg/dL) at minutes")
fat = d["fat"]; carbs = d["carbs"]
lo_c, hi_c = np.percentile(carbs, [33, 66])
mid = (carbs >= lo_c) & (carbs <= hi_c)  # similar-carbohydrate meals only
f_lo, f_hi = np.percentile(fat[mid], [33, 66])
for label, m in (("low fat", mid & (fat <= f_lo)), ("high fat", mid & (fat >= f_hi))):
    cm = C[m].mean(axis=0)
    print(f"{label:9s} n={m.sum():3d} carbs~{carbs[m].mean():.0f} g fat~{fat[m].mean():.0f} g |", " ".join(f"{int(g)}:{cm[i]:+.0f}" for i, g in enumerate(G) if g in (30, 60, 90, 120, 150, 180)), f"| peak at {G[3 + np.argmax(cm[3:])]} min")
