# Fibre-strength sensitivity (run from the folder with meals.npz, next to cgmacros_fit.py): python cgmacros_fibre_sensitivity.py meals.npz
import sys, numpy as np
sys.argv = ["x", sys.argv[1] if len(sys.argv) > 1 else "meals.npz"]
src = open("cgmacros_fit.py", encoding="utf-8").read().split('print(f"{len(carbs)}')[0]
exec(src)
lo = np.array([10.0, 6.0, -0.05, -1.0, -0.5, -0.5])
def cv_fixed(afib, afat=0.0, apro=0.0, cap=None):
    # fibre effect fixed (optionally capped at `cap` g), tau0 and tau_d fitted
    fib_save = fib.copy()
    globals()["fib"] = np.minimum(fib_save, cap) if cap else fib_save
    base = x0.copy(); base[2] = afib; base[4] = afat; base[5] = apro
    se = n = 0
    for k_ in range(5):
        te = np.isin(pid, folds[k_]); tr = ~te
        free = np.array([1, 1, 0, 0, 0, 0], bool)
        def f(z):
            th = base.copy(); th[free] = z; return resid(th, tr)[0]
        r = least_squares(f, base[free], bounds=(lo[free], hi[free]), x_scale=np.maximum(np.abs(base[free]), 0.1), max_nfev=40)
        th = base.copy(); th[free] = r.x
        _, ks = resid(th, tr); kmed = float(np.median(list(ks.values())))
        e = kmed * design(th, te) - C[te]; se += (e ** 2).sum(); n += e.size
    globals()["fib"] = fib_save
    return np.sqrt(se / n), r.x
print("fibre slowing per gram fixed (tau0 and tau_d refitted); CV RMSE mg/dL, population k")
for a, cap in [(0.0, None), (0.01, 15), (0.02, 15), (0.03, 15), (0.04, 15), (0.05, 15), (0.06, 15), (0.08, 15), (0.10, 15), (0.15, 15), (0.263, None)]:
    cv, p = cv_fixed(a, cap=cap)
    print(f"a_fib={a:5.3f}/g cap={cap}: CV RMSE {cv:6.2f}  tau0={p[0]:.1f} tau_d={p[1]:.1f}")
