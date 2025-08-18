#!/usr/bin/env python3
# Read metric CSVs and emit choropleth + summary JSONs.
import csv, json, argparse
from collections import defaultdict
from pathlib import Path
from math import isfinite

def read_csv(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r: rows.append(row)
    return rows

def to_key(row):
    return (row["Month"], row["AssetType"], row["BHK"], row["LocalityID"])

def f2(x):
    try:
        v = float(x)
        return v if isfinite(v) else None
    except: return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="Path to data directory containing metrics/")
    ap.add_argument("--min_sample", type=int, default=20, help="Min sample size to include in paints")
    args = ap.parse_args()
    data_root = Path(args.root)
    metrics_dir = data_root / "metrics"
    out_root = data_root / "out"
    (out_root / "choropleth").mkdir(parents=True, exist_ok=True)
    (out_root / "summary").mkdir(parents=True, exist_ok=True)

    ask = read_csv(metrics_dir/"metric_asking_monthly.csv")
    reg = read_csv(metrics_dir/"metric_registered_monthly.csv")
    rent = read_csv(metrics_dir/"metric_rent_monthly.csv")

    A = { to_key(r): r for r in ask }
    R = { to_key(r): r for r in reg }
    N = { to_key(r): r for r in rent }

    keys = set(A.keys()) | set(R.keys()) | set(N.keys())
    paints = defaultdict(list)

    for (month, asset, bhk, loc_id) in keys:
        a = A.get((month, asset, bhk, loc_id))
        r = R.get((month, asset, bhk, loc_id))
        n = N.get((month, asset, bhk, loc_id))

        nA = int(a["SampleSize"]) if a and a.get("SampleSize") else 0
        nR = int(r["SampleSize"]) if r and r.get("SampleSize") else 0
        nN = int(n["SampleSize"]) if n and n.get("SampleSize") else 0

        vA = f2(a["MedianAskingPrice"]) if a else None
        vR = f2(r["MedianRegisteredPrice"]) if r else None
        vN = f2(n["MedianMonthlyRent"]) if n else None

        if vR and vR > 0 and vN and nR >= args.min_sample and nN >= args.min_sample:
            y = 12.0 * vN / vR
            paints[("yield", month, asset, bhk)].append({"id": int(loc_id), "value": y})

        if vA and nA >= args.min_sample:
            paints[("asking", month, asset, bhk)].append({"id": int(loc_id), "value": vA})
        if vR and nR >= args.min_sample:
            paints[("registered", month, asset, bhk)].append({"id": int(loc_id), "value": vR})
        if vN and nN >= args.min_sample:
            paints[("rent", month, asset, bhk)].append({"id": int(loc_id), "value": vN})

        summary = {
            "month": month, "asset": asset, "bhk": bhk, "locality_id": int(loc_id),
            "median_asking": vA, "median_registered": vR, "median_rent": vN,
            "yield": (12.0 * vN / vR) if (vR and vR > 0 and vN) else None,
            "counts": {"asking": nA, "registered": nR, "rent": nN}
        }
        out_dir = out_root / "summary" / str(loc_id) / month / asset
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / f"{bhk}.json", "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

    for (metric, month, asset, bhk), arr in paints.items():
        out_dir = out_root / "choropleth" / metric / month / asset
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / f"{bhk}.json", "w", encoding="utf-8") as f:
            json.dump(arr, f, ensure_ascii=False, indent=2)

    print("Done. Outputs under:", out_root)

if __name__ == "__main__":
    main()
