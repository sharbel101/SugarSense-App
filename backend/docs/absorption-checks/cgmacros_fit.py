"""Does letting fibre / fat / protein change the carbohydrate appearance curve explain CGMacros meal responses better than carbohydrate alone?

Model (same structure for every candidate, so only the absorption part differs):
    rise(t) = k_person * C_net * (Ra * exp(-t/tau_d))(t),   Ra = gamma(2) appearance with time constant tau
    tau   = tau0 * (1 + a_fib*fibre + a_fat*fat10 + a_pro*pro10)        (slows appearance)
    C_net = carbs - b_fib*fibre                                         (fibre that does not reach the blood)
k_person absorbs each person's sensitivity (fitted per person, closed form); tau0, tau_d and the a_/b_ terms are shared.
Evaluation: 5-fold cross-validation by PERSON. For held-out people k is the median of the training people's k (population prediction, no
information about the held-out person). Reports RMSE of the 0-180 min curve (mg/dL). usage: python cgmacros_fit.py meals.npz
"""
import sys
import numpy as np
from scipy.optimize import least_squares

d = np.load(sys.argv[1], allow_pickle=True)
pid, G, C = d["pid"], d["grid"], d["curves"]
carbs, fat, pro, fib = d["carbs"], d["fat"] / 10.0, d["protein"] / 10.0, d["fiber"]
T = np.arange(0, 181)  # minute grid for the convolution
idx5 = (G).astype(int)

def basis(tau, tau_d):
    """response to a unit of carbohydrate: (Ra * exp(-t/tau_d)) evaluated at the 5-min grid; tau is an array per meal"""
    out = np.zeros((len(tau), len(G)))
    ra = (T[None, :] / tau[:, None] ** 2) * np.exp(-T[None, :] / tau[:, None])  # per minute, integrates to 1
    h = np.exp(-T / tau_d)
    for i in range(len(tau)):
        out[i] = np.convolve(ra[i], h)[:181][idx5]
    return out

def design(theta, sel):
    tau0, tau_d, a_fib, b_fib, a_fat, a_pro = theta
    tau = np.clip(tau0 * (1 + a_fib * fib[sel] + a_fat * fat[sel] + a_pro * pro[sel]), 10, 240)
    cnet = np.maximum(carbs[sel] - b_fib * fib[sel], 1.0)
    return cnet[:, None] * basis(tau, tau_d)

def person_k(Bm, y, ids):
    ks = {}
    for u in np.unique(ids):
        m = ids == u
        ks[u] = float((Bm[m] * y[m]).sum() / max((Bm[m] ** 2).sum(), 1e-9))
    return ks

def resid(theta, sel):
    Bm, y, ids = design(theta, sel), C[sel], pid[sel]
    ks = person_k(Bm, y, ids)
    k = np.array([ks[u] for u in ids])
    return (k[:, None] * Bm - y).ravel(), ks

CAND = {  # name: (free parameter mask over [tau0, tau_d, a_fib, b_fib, a_fat, a_pro])
    "carbs only": [1, 1, 0, 0, 0, 0],
    "+ fibre slows": [1, 1, 1, 0, 0, 0],
    "+ fibre slows and removes carbs": [1, 1, 1, 1, 0, 0],
    "+ fat slows": [1, 1, 0, 0, 1, 0],
    "+ fat and protein slow": [1, 1, 0, 0, 1, 1],
    "all": [1, 1, 1, 1, 1, 1],
}
x0 = np.array([40.0, 90.0, 0.0, 0.0, 0.0, 0.0])
lo = np.array([10.0, 20.0, -0.05, -1.0, -0.5, -0.5]); hi = np.array([120.0, 400.0, 0.5, 1.5, 1.0, 1.0])
users = np.unique(pid)
folds = np.array_split(np.random.default_rng(3).permutation(users), 5)

def fit(sel, mask):
    free = np.array(mask, bool)
    def f(z):
        th = x0.copy(); th[free] = z
        return resid(th, sel)[0]
    r = least_squares(f, x0[free], bounds=(lo[free], hi[free]), x_scale=np.maximum(np.abs(x0[free]), 0.1), max_nfev=60)
    th = x0.copy(); th[free] = r.x
    return th

print(f"{len(carbs)} meals, {len(users)} people\n")
print(f"{'candidate':36s} {'CV RMSE (population k)':>24s} {'in-sample RMSE (own k)':>24s}   fitted [tau0, tau_d, a_fib, b_fib, a_fat/10g, a_pro/10g]")
base_cv = None
for name, mask in CAND.items():
    se, n = 0.0, 0
    for k_ in range(5):
        test_u = folds[k_]
        te = np.isin(pid, test_u); tr = ~te
        th = fit(tr, mask)
        _, ks = resid(th, tr)
        kmed = float(np.median(list(ks.values())))
        Bm = design(th, te)
        e = kmed * Bm - C[te]
        se += (e ** 2).sum(); n += e.size
    cv = np.sqrt(se / n)
    th_all = fit(np.ones(len(pid), bool), mask)
    r_in = resid(th_all, np.ones(len(pid), bool))[0]
    base_cv = cv if base_cv is None else base_cv
    print(f"{name:36s} {cv:12.2f} ({100 * (cv / base_cv - 1):+5.1f}%) {np.sqrt((r_in ** 2).mean()):16.2f}      {np.round(th_all, 3).tolist()}")
