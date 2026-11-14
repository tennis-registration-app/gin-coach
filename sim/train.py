# Train value-model ensembles from self-play data: python3 sim/train.py <out.json> <tag> [<tag>...]
import sys, json, glob, numpy as np, time
from sklearn.neural_network import MLPRegressor
NV, NK = 19, 10
out, tags = sys.argv[1], sys.argv[2:]
def load(kind, n):
    arrs = []
    for t in tags:
        for f in glob.glob(f'data/{kind}_{t}.bin'):
            arrs.append(np.fromfile(f, dtype=np.float32).reshape(-1, n + 4))
    return np.concatenate(arrs)
def fit(data, n, hidden, members, seed0, iters):
    X, Y = data[:, :n], data[:, n:]
    mean, std = X.mean(0), X.std(0) + 1e-6
    Xs = (X - mean) / std
    rng = np.random.default_rng(seed0)
    test = rng.random(len(X)) < 0.05
    nets, preds = [], []
    for m in range(members):
        idx = np.where(~test & (rng.random(len(X)) < 0.75))[0]
        net = MLPRegressor(hidden_layer_sizes=hidden, batch_size=2048, learning_rate_init=2e-3, max_iter=iters,
                           early_stopping=True, validation_fraction=0.05, n_iter_no_change=3, random_state=seed0 + m, tol=1e-6)
        t = time.time(); net.fit(Xs[idx], Y[idx])
        p = net.predict(Xs[test]); preds.append(p)
        ev_p, ev_y = (p[:, 2] - p[:, 3]) * 50, (Y[test][:, 2] - Y[test][:, 3]) * 50
        print(f'  member {m}: epochs {net.n_iter_} rmse {np.sqrt(((ev_p-ev_y)**2).mean()):.2f} (baseline sd {ev_y.std():.2f}) {time.time()-t:.0f}s', flush=True)
        nets.append({'mean': mean.tolist(), 'std': std.tolist(),
                     'layers': [{'w': np.round(w.T, 5).ravel().tolist(), 'b': np.round(b, 5).tolist(), 'nin': w.shape[0], 'nout': w.shape[1]} for w, b in zip(net.coefs_, net.intercepts_)]})
    P = np.stack([(p[:, 2] - p[:, 3]) * 50 for p in preds])
    ev_y = (Y[test][:, 2] - Y[test][:, 3]) * 50
    ens = P.mean(0)
    # calibration by decile of prediction
    order = np.argsort(ens); bins = np.array_split(order, 10)
    cal = [(float(ens[b].mean()), float(ev_y[b].mean())) for b in bins]
    print('  calibration (pred, actual):', ' '.join(f'({a:.1f},{b:.1f})' for a, b in cal))
    print(f'  ensemble spread (mean sd across members): {P.std(0).mean():.2f}', flush=True)
    return nets, {'rows': int(len(X)), 'calibration': cal, 'memberSpread': float(P.std(0).mean())}
v = load('v', NV); k = load('k', NK)
print('V rows', len(v), 'K rows', len(k), flush=True)
vn, vm = fit(v, NV, (48, 24), 3, 1, 25)
kn, km = fit(k, NK, (24, 12), 3, 11, 60)
json.dump({'v': vn, 'k': kn, 'meta': {'tags': tags, 'v': vm, 'k': km}}, open(out, 'w'), separators=(',', ':'))
print('wrote', out)
