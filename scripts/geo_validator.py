#!/usr/bin/env python3
# (same as previously generated) 
# Validate Mumbai GeoJSON layers.
import json, argparse, sys
from pathlib import Path

REQUIRED = {
    "mumbai_city.geojson":     {"props": ["CityID","CityName"]},
    "mumbai_micro_markets.geojson": {"props": ["MicroMarketID","CityID","MicroMarketName"]},
    "mumbai_localities.geojson":    {"props": ["LocalityID","MicroMarketID","CityID","LocalityName"]},
}

def load_fc(path: Path):
    with path.open("r", encoding="utf-8") as f:
        fc = json.load(f)
    if fc.get("type") != "FeatureCollection":
        raise ValueError(f"{path.name}: not a FeatureCollection")
    return fc["features"]

def bbox_of_geom(geom):
    t = geom.get("type")
    if t == "Polygon":
        coords = geom["coordinates"][0]
    elif t == "MultiPolygon":
        coords = [pt for ring in geom["coordinates"] for pt in ring[0]]
    elif t == "LineString":
        coords = geom["coordinates"]
    elif t == "MultiLineString":
        coords = [pt for line in geom["coordinates"] for pt in line]
    elif t == "Point":
        coords = [geom["coordinates"]]
    else:
        return None
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return min(lons), min(lats), max(lons), max(lats)

def centroid_of_geom(geom):
    b = bbox_of_geom(geom)
    if not b: return None
    w,s,e,n = b
    return (w+e)/2.0, (s+n)/2.0

def point_in_bbox(pt, bbox):
    x,y = pt; w,s,e,n = bbox
    return (w <= x <= e) and (s <= y <= n)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="Path to data/geo directory")
    args = ap.parse_args()
    root = Path(args.root)
    errors = []
    warnings = []

    layers = {}
    for fname in REQUIRED:
        p = root / fname
        if not p.exists():
            errors.append(f"Missing file: {fname}")
            continue
        feats = load_fc(p)
        layers[fname] = feats

    if errors:
        print("FATAL:", *errors, sep="\n- ")
        sys.exit(1)

    ids_seen = {}
    for fname, spec in REQUIRED.items():
        feats = layers[fname]
        need = set(spec["props"])
        key_prop = [p for p in need if p.endswith("ID")][0]
        ids = set()
        for i, ft in enumerate(feats):
            props = ft.get("properties", {})
            missing = [p for p in need if p not in props]
            if missing:
                errors.append(f"{fname} feature #{i} missing props: {missing}")
                continue
            if props[key_prop] in ids:
                errors.append(f"{fname} duplicate {key_prop}: {props[key_prop]}")
            ids.add(props[key_prop])
            bbox = bbox_of_geom(ft.get("geometry", {}))
            if bbox:
                w,s,e,n = bbox
                if not (-180 <= w <= 180 and -180 <= e <= 180 and -90 <= s <= 90 and -90 <= n <= 90):
                    warnings.append(f"{fname} feature #{i} has out-of-range coords (not WGS84?): {bbox}")
        ids_seen[fname] = ids

    city_feats = layers["mumbai_city.geojson"]
    city_bbox = bbox_of_geom(city_feats[0]["geometry"]) if city_feats else None

    mm_bboxes = {ft["properties"]["MicroMarketID"]: bbox_of_geom(ft["geometry"])
                 for ft in layers["mumbai_micro_markets.geojson"]}

    for i, ft in enumerate(layers["mumbai_localities.geojson"]):
        props = ft["properties"]
        loc_id = props["LocalityID"]
        mm_id = props["MicroMarketID"]
        if mm_id not in mm_bboxes:
            errors.append(f"Locality {loc_id} refers to unknown MicroMarketID {mm_id}")
            continue
        c = centroid_of_geom(ft["geometry"])
        if c:
            if city_bbox and not point_in_bbox(c, city_bbox):
                warnings.append(f"Locality {loc_id} centroid seems outside city bbox (check geometry)")
            if not point_in_bbox(c, mm_bboxes[mm_id]):
                warnings.append(f"Locality {loc_id} centroid seems outside its MicroMarket bbox (id={mm_id})")

    print("Validation complete.")
    if errors:
        print("\nErrors:")
        for e in errors: print("-", e)
    else:
        print("No blocking errors found.")
    if warnings:
        print("\nWarnings:")
        for w in warnings: print("-", w)

if __name__ == "__main__":
    main()
