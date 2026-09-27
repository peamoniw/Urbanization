import math
from datetime import date
from functools import lru_cache
from pathlib import Path
from urllib.request import urlopen

import numpy as np
import rasterio
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pyproj import Geod
from rasterio.features import geometry_mask, geometry_window
from rasterio.io import MemoryFile
from rasterio.windows import Window
from shapely.geometry import box, mapping, shape


ROOT = Path(__file__).parent
STATIC = ROOT / "static"
DATASET_NAME = "GISD30 global impervious surface"
DATASET_SOURCE = "https://doi.org/10.5281/zenodo.5220816"
DATASET_PAPER = "https://doi.org/10.5194/essd-14-1831-2022"
ARCHIVE_URL = "https://zenodo.org/records/5220816/files/GISD30_1985-2020_{region}.rar"
ARCHIVE_REGIONS = {
    "E0_E30": (0, 30),
    "E35_E60": (35, 60),
    "E65_E90": (65, 90),
    "E95_E120": (95, 120),
    "E125_E150": (125, 150),
    "E155_E175": (155, 175),
    "W5_W30": (5, 30),
    "W35_W60": (35, 60),
    "W65_W90": (65, 90),
    "W95_W120": (95, 120),
    "W125_W150": (125, 150),
    "W155_W180": (155, 180),
}
TILE_SIZE = 5
PROCESSING_METHOD = (
    "Counted GISD30 pixels with nonzero impervious-change codes inside the "
    "selected rectangle and weighted clipped pixel intersections by their "
    "WGS84 ellipsoidal areas. No buffer or area expansion is used."
)
GEOD = Geod(ellps="WGS84")
app = FastAPI(title="Urbanization Mapping Tool")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class AnalysisRequest(BaseModel):
    geometry: dict
    thresholds: list[float] = Field(default=[20, 40, 60, 80], min_length=4, max_length=4)


def _tile_name(north_edge, west_edge):
    north_south = "N" if north_edge >= 0 else "S"
    east_west = "E" if west_edge >= 0 else "W"
    return f"{east_west}{abs(west_edge):03.0f}{north_south}{abs(north_edge):02.0f}"


def _tiles_for_bounds(bounds):
    west, south, east, north = bounds
    first_longitude = math.floor(west / TILE_SIZE) * TILE_SIZE
    last_longitude = math.floor(math.nextafter(east, -math.inf) / TILE_SIZE) * TILE_SIZE
    first_latitude = math.floor(south / TILE_SIZE) * TILE_SIZE
    last_latitude = math.floor(math.nextafter(north, -math.inf) / TILE_SIZE) * TILE_SIZE
    for latitude in range(first_latitude, last_latitude + 1, TILE_SIZE):
        for longitude in range(first_longitude, last_longitude + 1, TILE_SIZE):
            yield latitude + TILE_SIZE, longitude, _tile_name(latitude + TILE_SIZE, longitude)


def _archive_region(west_edge):
    coordinate = abs(west_edge)
    hemisphere = "E" if west_edge >= 0 else "W"
    for region, (start, end) in ARCHIVE_REGIONS.items():
        if region.startswith(hemisphere) and start <= coordinate <= end:
            return region
    raise ValueError(f"No GISD30 archive covers tile longitude {west_edge}.")


@lru_cache(maxsize=4)
def _read_archive_tiles(region, tile_names):
    import libarchive

    archive_folder = f"GISD30_1985-2020_{region}"
    tile_prefix = "GISD30_1985-2020"
    wanted = {
        f"{archive_folder}/{tile_prefix}_{tile_name}.tif": tile_name
        for tile_name in tile_names
    }
    found = {}
    with urlopen(ARCHIVE_URL.format(region=region), timeout=180) as response:
        with libarchive.stream_reader(response) as entries:
            for entry in entries:
                tile_name = wanted.get(entry.pathname)
                if tile_name is None:
                    continue
                found[tile_name] = b"".join(entry.get_blocks())
                if len(found) == len(wanted):
                    break
    return found


def _impervious_area(dataset, window, bounds, values, inside):
    west, south, east, north = bounds
    transform = dataset.transform
    row_count, column_count = values.shape
    pixel_width, pixel_height = transform.a, transform.e
    columns = np.arange(column_count, dtype=np.float64) + window.col_off
    pixel_left = transform.c + columns * pixel_width
    pixel_right = pixel_left + pixel_width
    overlap_west = np.maximum(np.minimum(pixel_left, pixel_right), west)
    overlap_east = np.minimum(np.maximum(pixel_left, pixel_right), east)
    overlap_width = np.maximum(overlap_east - overlap_west, 0)

    total_impervious_area = 0.0
    nodata = np.ma.getmaskarray(values)
    for row in range(row_count):
        raster_row = window.row_off + row
        latitude_a = transform.f + raster_row * pixel_height
        latitude_b = latitude_a + pixel_height
        pixel_north = min(max(latitude_a, latitude_b), north)
        pixel_south = max(min(latitude_a, latitude_b), south)
        if pixel_north <= pixel_south:
            continue

        area, _ = GEOD.polygon_area_perimeter(
            [transform.c, transform.c + pixel_width, transform.c + pixel_width, transform.c],
            [pixel_south, pixel_south, pixel_north, pixel_north],
        )
        pixel_areas = abs(area) * overlap_width / abs(pixel_width)
        impervious = inside[row] & ~nodata[row] & (values.data[row] > 0) & (pixel_areas > 0)
        total_impervious_area += float(pixel_areas[impervious].sum())
    return total_impervious_area


def _analyze_tile(tile_data, tile_name, tile_north, tile_west, polygon):
    clipped = polygon.intersection(box(
        tile_west,
        tile_north - TILE_SIZE,
        tile_west + TILE_SIZE,
        tile_north,
    ))
    if clipped.is_empty:
        return 0.0

    with MemoryFile(tile_data) as memory_file:
        with memory_file.open() as dataset:
            window = geometry_window(dataset, [mapping(clipped)])
            impervious_area = 0.0
            for row_offset in range(0, int(window.height), 128):
                batch_window = Window(
                    window.col_off,
                    window.row_off + row_offset,
                    window.width,
                    min(128, int(window.height) - row_offset),
                )
                values = dataset.read(1, window=batch_window, masked=True)
                inside = geometry_mask(
                    [mapping(clipped)],
                    out_shape=values.shape,
                    transform=dataset.window_transform(batch_window),
                    all_touched=True,
                    invert=True,
                )
                impervious_area += _impervious_area(
                    dataset, batch_window, clipped.bounds, values, inside
                )
    return impervious_area


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
def status():
    return {
        "ready": True,
        "dataset": DATASET_NAME,
        "year": 2020,
        "spatial_resolution_m": 30,
        "dataset_source": DATASET_SOURCE,
        "message": "",
    }


@app.post("/api/analyze")
def analyze(request: AnalysisRequest):
    try:
        polygon = shape(request.geometry)
        if polygon.geom_type != "Polygon" or polygon.is_empty or not polygon.is_valid:
            raise ValueError("Select a valid rectangle on the map.")
        if len(polygon.exterior.coords) != 5 or polygon.interiors or not polygon.equals(polygon.envelope):
            raise ValueError("The selected area must be a non-degenerate rectangle.")
        if any(not (math.isfinite(x) and math.isfinite(y) and -180 <= x <= 180 and -90 <= y <= 90) for x, y in polygon.exterior.coords):
            raise ValueError("The selected coordinates are outside valid longitude/latitude bounds.")
        thresholds = request.thresholds
        if any(not math.isfinite(value) for value in thresholds) or any(left >= right for left, right in zip(thresholds, thresholds[1:])) or thresholds[0] <= 0 or thresholds[-1] >= 100:
            raise ValueError("Classification thresholds must be strictly increasing values between 0 and 100.")
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    west, south, east, north = polygon.bounds
    if east <= west or north <= south or east - west > 180:
        raise HTTPException(status_code=422, detail="The selected rectangle must have positive width and height and cannot cross the antimeridian.")

    area_m2 = abs(GEOD.geometry_area_perimeter(polygon)[0])
    if area_m2 <= 0:
        raise HTTPException(status_code=422, detail="The selected rectangle has no measurable area.")

    tiles_by_region = {}
    for tile_north, tile_west, tile_name in _tiles_for_bounds(polygon.bounds):
        region = _archive_region(tile_west)
        tiles_by_region.setdefault(region, []).append((tile_north, tile_west, tile_name))

    impervious_area_m2 = 0.0
    tile_names = []
    try:
        for region, tiles in tiles_by_region.items():
            tile_data = _read_archive_tiles(region, tuple(sorted(tile[2] for tile in tiles)))
            for tile_north, tile_west, tile_name in tiles:
                data = tile_data.get(tile_name)
                if data is None:
                    continue
                tile_names.append(tile_name)
                impervious_area_m2 += _analyze_tile(
                    data, tile_name, tile_north, tile_west, polygon
                )
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Could not read the public GISD30 impervious-surface raster: {error}") from error

    if not tile_names:
        raise HTTPException(status_code=422, detail="No GISD30 raster tiles cover this rectangle.")

    impervious_area_m2 = min(impervious_area_m2, area_m2)
    percent = impervious_area_m2 / area_m2 * 100
    levels = ["Natural", "Low urbanization", "Semi-urban", "Urban", "Highly urbanized"]
    level = next((name for name, upper in zip(levels, [*thresholds, 100.000001]) if percent <= upper), levels[-1])
    centroid = polygon.centroid
    return {
        "latitude": centroid.y,
        "longitude": centroid.x,
        "area_km2": area_m2 / 1_000_000,
        "impervious_area_km2": impervious_area_m2 / 1_000_000,
        "impervious_percent": percent,
        "urbanization_proxy_percent": percent,
        "urbanization_level": level,
        "dataset": DATASET_NAME,
        "dataset_source": DATASET_SOURCE,
        "dataset_paper": DATASET_PAPER,
        "spatial_resolution_m": 30,
        "year": 2020,
        "analysis_date": date.today().isoformat(),
        "thresholds": thresholds,
        "processing_method": PROCESSING_METHOD,
        "dataset_version": "GISD30 1985-2020",
        "tiles": tile_names,
        "geometry": request.geometry,
    }