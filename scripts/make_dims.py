#!/usr/bin/env python3
import csv, json, os, sys, io

MASTERS_DIR = "data/masters"
OUT_PATH = "frontend/dims.json"

# Try several encodings; clean NBSP (0xA0) and other stray bytes
ENCODINGS = ["utf-8", "utf-8-sig", "cp1252", "latin-1"]

def read_csv_any(path):
    last_err = None
    for enc in ENCODINGS:
        try:
            with open(path, "rb") as fb:
                raw = fb.read()
            # Replace NBSP with regular space before decoding
            raw = raw.replace(b"\xa0", b" ")
            text = raw.decode(enc, errors="strict")
            # Sniff delimiter (comma fallback)
            try:
                dialect = csv.Sniffer().sniff(text.splitlines()[0] + "\n" + text.splitlines()[1])
            except Exception:
                dialect = csv.excel
                dialect.delimiter = ','
            rows = list(csv.DictReader(io.StringIO(text), dialect=dialect))
            print(f"[read_csv_any] {os.path.basename(path)}  encoding={enc}  rows={len(rows)}")
            return rows
        except Exception as e:
            last_err = e
            continue
    # Last resort: decode forgivingly so you can see where it breaks
    try:
        text = raw.decode("latin-1", errors="replace")
        rows = list(csv.DictReader(io.StringIO(text)))
        print(f"[read_csv_any] {os.path.basename(path)}  encoding=latin-1(replace)  rows={len(rows)}  (forgiving)")
        return rows
    except Exception as e:
        print(f"[read_csv_any] FAILED {path}: {last_err or e}")
        return []

def get_first(d, keys, default=None, cast=None):
    for k in keys:
        if k in d and str(d[k]).strip() != "":
            v = d[k]
            if cast:
                try:
                    v = cast(v)
                except Exception:
                    continue
            return v
    return default

def norm_mm(row):
    return {
        "id":     get_first(row, ["MicroMarketID","MICROMARKETID","locationid","LocationID","LOC_ID"], cast=int),
        "name":   get_first(row, ["MicroMarketName","MICROMARKETNAME","locationname","LocationName","NAME"], default="(Unnamed)"),
        "cityId": get_first(row, ["CityID","CITYID","cityid"], cast=int)
    }

def norm_loc(row, mm_name_by_id=None):
    loc_id  = get_first(row, ["LocalityID","LOCALITYID","sublocationid","SubLocationID"], cast=int)
    name    = get_first(row, ["LocalityName","LOCALITYNAME","sublocationname","SubLocationName","NAME"], default=f"Locality {loc_id}")
    city_id = get_first(row, ["CityID","CITYID","cityid"], cast=int)
    mm_id   = get_first(row, ["MicroMarketID","MICROMARKETID","locationid","LocationID"], cast=int)
    d = {"id": loc_id, "name": name, "cityId": city_id, "microMarketId": mm_id}
    if mm_name_by_id and mm_id is not None:
        d["microMarketName"] = mm_name_by_id.get(mm_id)
    return d

def main():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)

    # Load masters (any that exist)
    bhk_rows  = read_csv_any(os.path.join(MASTERS_DIR, "dim_bhk.csv")) or []
    ast_rows  = read_csv_any(os.path.join(MASTERS_DIR, "dim_asset_type.csv")) or []
    city_rows = read_csv_any(os.path.join(MASTERS_DIR, "dim_city.csv")) or []
    mm_rows   = read_csv_any(os.path.join(MASTERS_DIR, "dim_micro_market.csv")) or []
    loc_rows  = read_csv_any(os.path.join(MASTERS_DIR, "dim_locality.csv")) or []

    # BHK
    bhk = []
    for r in bhk_rows:
        code  = get_first(r, ["code","CODE","BHK","bhk","bhk_code"], cast=str)
        label = get_first(r, ["label","LABEL","name","display","BHKLabel"], default=code)
        if code is not None: bhk.append({"code": code, "label": label})
    bhk.sort(key=lambda x: (x["code"] is None, str(x["code"])))

    # Assets
    assets = []
    for r in ast_rows:
        code  = get_first(r, ["code","CODE","AssetType","ASSETTYPE","asset","asset_code"], cast=str)
        label = get_first(r, ["label","LABEL","name","display","AssetTypeName"], default=code)
        if code is not None: assets.append({"code": code, "label": label})
    assets.sort(key=lambda x: (x["code"] is None, str(x["code"])))

    # City (prefer Mumbai/CityID=13)
    city = None
    for r in city_rows:
        cid  = get_first(r, ["CityID","CITYID","cityid"], cast=int)
        name = get_first(r, ["CityName","CITYNAME","cityname","name"])
        if cid is None: continue
        if (name and name.strip().lower() == "mumbai") or cid == 13:
            lon = get_first(r, ["CenterLon","center_lon","lon","LON"], cast=float) or 72.8777
            lat = get_first(r, ["CenterLat","center_lat","lat","LAT"], cast=float) or 19.0760
            zoom= get_first(r, ["Zoom","zoom"], cast=float) or 10
            city = {"CityID": cid, "CityName": name or "Mumbai", "center": [lon, lat], "zoom": zoom}
            break

    # Micromarkets
    micromarkets, mm_name_by_id = [], {}
    for r in mm_rows:
        mm = norm_mm(r)
        if mm["id"] is None: continue
        micromarkets.append(mm)
        mm_name_by_id[mm["id"]] = mm["name"]
    micromarkets.sort(key=lambda x: (x["cityId"] if x["cityId"] is not None else 0, x["name"]))

    # Localities
    localities = []
    for r in loc_rows:
        loc = norm_loc(r, mm_name_by_id)
        if loc["id"] is None: continue
        localities.append(loc)
    localities.sort(key=lambda x: (x["cityId"] if x["cityId"] is not None else 0, x["name"]))

    dims = {
        "bhk": bhk,
        "assets": assets,
        "city": city,
        "micromarkets": micromarkets,  # [{id,name,cityId}]
        "localities": localities       # [{id,name,cityId,microMarketId,(microMarketName)}]
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(dims, f, ensure_ascii=False, indent=2)
    print(f"[write] {OUT_PATH}  keys={list(dims.keys())}")

if __name__ == "__main__":
    main()
