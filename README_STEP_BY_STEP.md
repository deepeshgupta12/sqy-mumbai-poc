
# Square Yards — Mumbai Map POC (CSV/GeoJSON, no backend)

## 0) Prereqs (macOS)
- Install Mapbox account and get an access token
- brew install tippecanoe node python

## 1) Put your data
Place your folders next to this starter:
- data/geo/ (your GeoJSONs)
- data/metrics/ (three CSVs)
- data/masters/ (BHK & AssetType CSVs)

## 2) Validate geometry
python scripts/geo_validator.py --root ./data/geo

## 3) Preprocess metrics → JSON
python scripts/preprocess_metrics.py --root ./data
Outputs go into data/out/...

## 4) Build vector tiles for polygons
# Localities (ensure your property 'LocalityID' becomes the feature id!)
tippecanoe -o mumbai_localities.mbtiles -zg --drop-densest-as-needed --layer=mumbai_localities --feature-id=LocalityID data/geo/mumbai_localities.geojson
# Micro-markets (optional)
tippecanoe -o mumbai_micro_markets.mbtiles -zg --drop-densest-as-needed --layer=mumbai_micro_markets --feature-id=MicroMarketID data/geo/mumbai_micro_markets.geojson

Upload these MBTiles to Mapbox (Studio or tilesets-cli). Note the tileset IDs and the "source-layer" names, then edit frontend/config.json accordingly.

## 5) Configure frontend
Edit frontend/config.json:
{
  "mapboxToken": "PASTE_TOKEN",
  "tilesets": { "localities": "mapbox://YOUR_USERNAME.mumbai_localities" },
  "sourceLayers": { "localities": "mumbai_localities" },
  "dataRoot": "../data/out",
  "default": { "metric": "yield", "month": "2025-07", "asset": "Residential", "bhk": "2" }
}

## 6) Run locally
cd frontend
# simplest static server
python3 -m http.server 5500
# then open http://localhost:5500

## 7) Use it
- Choose Metric/Month/Asset/BHK, click Apply → choropleth repaints.
- Click a locality polygon → right panel shows summary stats from data/out/summary/...

## 8) Troubleshooting
- If polygons don't color: ensure you set --feature-id=LocalityID when building tiles and that config.json "sourceLayers" matches your tileset's source-layer name.
- Check your JSON exists: data/out/choropleth/<metric>/<YYYY-MM>/<Asset>/<BHK>.json
- Open DevTools console for fetch or paint errors.

## 9) Next
- Add roads/projects tiles similarly (layers & outlines)
- Swap static JSON for your APIs when they're ready (URLs map 1:1 to endpoints)
