#!/usr/bin/env python3
"""
make_fake_metrics_from_dims.py

Generate *fake* but plausible metric CSVs using your *real* IDs and codes
from frontend/dims.json (which is derived from your dim_* masters).

Outputs (canonical headers expected by the app):
  data/metrics/metric_asking_monthly.csv
  data/metrics/metric_registered_monthly.csv
  data/metrics/metric_rent_monthly.csv

Usage:
  python scripts/make_fake_metrics_from_dims.py --month 2025-07
  python scripts/make_fake_metrics_from_dims.py --month 2025-07 --assets Residential Office --bhk 1 2 3
"""

import argparse, json, csv, random, datetime
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    today = datetime.date.today()
    ap.add_argument("--month", default=f"{today.year}-{today.month:02d}", help="YYYY-MM (e.g., 2025-07)")
    ap.add_argument("--assets", nargs="*", default=None, help="AssetType codes to include (defaults to all in dims)")
    ap.add_argument("--bhk", nargs="*", default=None, help="BHK codes to include (defaults to all in dims)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cityid", type=int, default=13, help="CityID to stamp (Mumbai=13)")
    args = ap.parse_args()
    random.seed(args.seed)

    dims_path = Path("frontend/dims.json")
    if not dims_path.exists():
        raise SystemExit("frontend/dims.json not found. Run: python scripts/make_dims.py")

    dims = json.loads(dims_path.read_text(encoding="utf-8"))

    # --- Gather real IDs and codes from dims
    locs = dims.get("localities") or []
    if not locs:
        raise SystemExit("No localities found in dims.json. Ensure dim_locality.csv was included in make_dims.py step.")

    mm_by_loc = {}
    for l in locs:
        # Expect structure like: {"id": 16137, "name":"...", "cityId":13, "microMarketId":100}
        loc_id = l.get("id")
        mm_id  = l.get("microMarketId") or 0
        if loc_id is not None:
            mm_by_loc[int(loc_id)] = int(mm_id) if mm_id is not None else 0

    # AssetType codes
    all_assets = [a.get("code") for a in (dims.get("assets") or []) if a.get("code")]
    if not all_assets:
        all_assets = ["Residential"]  # fallback
    assets = args.assets or all_assets

    # BHK codes
    all_bhk = [b.get("code") for b in (dims.get("bhk") or []) if b.get("code") is not None]
    if not all_bhk:
        all_bhk = ["1","2","3"]
    bhk_list = args.bhk or all_bhk

    # --- Output paths
    out_dir = Path("data/metrics"); out_dir.mkdir(parents=True, exist_ok=True)
    ask_path  = out_dir / "metric_asking_monthly.csv"
    reg_path  = out_dir / "metric_registered_monthly.csv"
    rent_path = out_dir / "metric_rent_monthly.csv"

    # --- Headers (canonical)
    ask_hdr  = ["Month","CityID","MicroMarketID","LocalityID","BHK","AssetType","MedianAskingPrice","MedianPricePSF","SampleSize","FreshnessDate"]
    reg_hdr  = ["Month","CityID","MicroMarketID","LocalityID","BHK","AssetType","MedianRegisteredPrice","MedianPricePSF","SampleSize","FreshnessDate"]
    rent_hdr = ["Month","CityID","MicroMarketID","LocalityID","BHK","AssetType","MedianMonthlyRent","MedianRentPSF","SampleSize","FreshnessDate"]

    today_str = today.isoformat()

    def ranges_for(asset_code):
        """
        Tune per asset if you like; these are plausible Mumbai-ish defaults.
        Returns a dict of generator lambdas for registered/asking/rent/psf/rpsf.
        """
        if str(asset_code).lower().startswith(("office","commercial","retail")):
            return {
                "reg":  lambda base: int(base * random.uniform(120, 240) * 1e5),   # 1.2–2.4 Cr
                "ask":  lambda reg:  int(reg * random.uniform(1.01, 1.10)),        # asking >= registered
                "rent": lambda base: int(base * random.uniform(60, 300) * 1e3),    # 60k–3L
                "psf":  lambda: int(random.uniform(18000, 50000)),
                "rpsf": lambda: int(random.uniform(70, 200))
            }
        else:  # Residential default
            return {
                "reg":  lambda base: int(base * random.uniform(90, 160) * 1e5),    # 90L–1.6 Cr
                "ask":  lambda reg:  int(reg * random.uniform(1.02, 1.15)),
                "rent": lambda base: int(base * random.uniform(25, 140) * 1e3),    # 25k–1.4L
                "psf":  lambda: int(random.uniform(12000, 40000)),
                "rpsf": lambda: int(random.uniform(40, 140))
            }

    with ask_path.open("w", newline="", encoding="utf-8") as fa, \
         reg_path.open("w", newline="", encoding="utf-8") as fr, \
         rent_path.open("w", newline="", encoding="utf-8") as fn:

        wa, wr, wn = csv.writer(fa), csv.writer(fr), csv.writer(fn)
        wa.writerow(ask_hdr); wr.writerow(reg_hdr); wn.writerow(rent_hdr)

        # Iterate all localities × selected assets × selected BHK codes
        for l in locs:
            try:
                loc_id = int(l["id"])
            except Exception:
                continue

            mm_id = mm_by_loc.get(loc_id, 0)
            city  = int(l.get("cityId") or args.cityid or 13)

            for asset in assets:
                gen = ranges_for(asset)
                for bhk in bhk_list:
                    base = random.uniform(0.8, 1.2)

                    reg_val  = gen["reg"](base)
                    ask_val  = gen["ask"](reg_val)
                    rent_val = gen["rent"](base)

                    psf  = gen["psf"]()
                    rpsf = gen["rpsf"]()

                    # Reasonable samples to ensure painting with default min_sample
                    n_reg = random.randint(25, 90)
                    n_ask = random.randint(30, 120)
                    n_rent= random.randint(20, 100)

                    common = [args.month, city, mm_id, loc_id, str(bhk), asset]

                    wa.writerow(common + [ask_val, psf,  n_ask,  today_str])
                    wr.writerow(common + [reg_val, psf,  n_reg,  today_str])
                    wn.writerow(common + [rent_val, rpsf, n_rent, today_str])

    print(f"Wrote:\n  {ask_path}\n  {reg_path}\n  {rent_path}\nDone.")
if __name__ == "__main__":
    main()
