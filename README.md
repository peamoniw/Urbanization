# Urbanization Mapping Tool

Draw a rectangle on the map to measure its impervious-surface share and urbanization proxy.

## Public data

The application uses [GISD30](https://doi.org/10.5281/zenodo.5220816), a global 30 m impervious-surface dataset for 1985–2020. Its regional RAR archives are publicly downloadable from Zenodo without an account. The backend streams the required 5° GeoTIFF tile members from the applicable archive; no Google Earth Engine service, cloud project, credentials, API key, login, or paid service is used.

## Run locally

On Ubuntu 24.04, install the native libarchive library first:

```bash
sudo apt install libarchive13t64
```

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000), draw a rectangle, and the result is calculated from the public impervious-surface raster. No `.env` file or login is required. The `libarchive-c` dependency uses the system libarchive shared library.

## Deploy to Vercel

Import this repository as a Vercel project and deploy with the default Python build settings. `api/index.py` exposes the FastAPI application, and `vercel.json` routes requests through it while including the `static/` assets.

The analysis endpoint also requires the native libarchive shared library used by `libarchive-c`. Confirm that the Vercel Python runtime provides it; otherwise the function must be built with that library included before `/api/analyze` can run.

## Method

- GISD30 pixels with nonzero impervious-change codes represent impervious surface by 2020; zero represents pervious surface. The backend reads only the 5° raster tiles covering the rectangle from the public regional archives.
- Pixel intersections are clipped to the selected rectangle and weighted using WGS84 ellipsoidal areas. Impervious Surface and Urbanization Proxy are both impervious area divided by the full geodesic area of the selected rectangle. No buffer, expansion, or overlap-based increase is used.
- The optional urbanization labels use user-editable 20%, 40%, 60%, and 80% boundaries. They are research-defined, not universal standards.
- Saved sites stay in the current browser. CSV and GeoJSON exports retain the geometry, measured areas, tile names, dataset version, thresholds, and analysis date.

## Limitations

GISD30 is a Landsat-derived classification, not a real-time measurement; results inherit the source product's classification uncertainty and 2020 temporal limit. See the [open-access product paper](https://doi.org/10.5194/essd-14-1831-2022). The map uses Esri basemaps and OpenStreetMap Nominatim place search; those services retain their own availability and usage policies.
