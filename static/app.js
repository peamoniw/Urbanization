const DEFAULT_THRESHOLDS = [20, 40, 60, 80];
const STORAGE_KEY = "urbanization-mapping-gisd30-2020-sites-v1";
const THRESHOLD_KEY = "urbanization-mapping-thresholds-v1";
const map = L.map("map", { zoomControl: false }).setView([15.87, 100.99], 6);

const street = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: 'Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS User Community',
});
const imagery = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Tiles &copy; Esri",
});
street.addTo(map);
L.control.layers({ "Street map": street, "Satellite imagery": imagery }, {}, { position: "topright" }).addTo(map);
L.control.zoom({ position: "topright" }).addTo(map);

const selectedLayer = L.featureGroup().addTo(map);
const savedLayer = L.featureGroup().addTo(map);
const resultElement = document.getElementById("result");
const analysisState = document.getElementById("analysis-state");
let selection = null;
let result = null;
let savedSites = readStored(STORAGE_KEY, []);
let thresholds = readStored(THRESHOLD_KEY, DEFAULT_THRESHOLDS);

const drawControl = new L.Control.Draw({
  position: "topright",
  draw: {
    rectangle: { shapeOptions: { color: "#c25234", weight: 2, fillColor: "#d97553", fillOpacity: 0.13 } },
    polygon: false,
    polyline: false,
    circle: false,
    circlemarker: false,
    marker: false,
  },
  edit: false,
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, async (event) => {
  selectedLayer.clearLayers();
  selection = event.layer;
  selectedLayer.addLayer(selection);
  await analyzeSelection();
});

document.getElementById("clear-selection").addEventListener("click", clearSelection);
document.getElementById("save-site").addEventListener("click", saveSite);
document.getElementById("export-csv").addEventListener("click", exportCsv);
document.getElementById("export-geojson").addEventListener("click", exportGeoJson);
document.getElementById("search-button").addEventListener("click", searchLocation);
document.getElementById("location-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchLocation();
});

document.querySelectorAll("[data-threshold]").forEach((input, index) => {
  input.value = thresholds[index] ?? DEFAULT_THRESHOLDS[index];
  input.addEventListener("change", updateThresholds);
});

function readStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function currentThresholds() {
  return [...document.querySelectorAll("[data-threshold]")].map((input) => Number(input.value));
}

function updateThresholds() {
  const values = currentThresholds();
  const valid = values.every((value) => Number.isFinite(value) && value > 0 && value < 100)
    && values.every((value, index) => index === 0 || value > values[index - 1]);
  document.querySelectorAll("[data-threshold]").forEach((input) => {
    input.setCustomValidity(valid ? "" : "Enter increasing boundaries between 0 and 100.");
  });
  if (!valid) return;
  thresholds = values;
  localStorage.setItem(THRESHOLD_KEY, JSON.stringify(thresholds));
  if (selection) analyzeSelection();
}

async function analyzeSelection() {
  result = null;
  resultElement.hidden = true;
  document.getElementById("save-site").disabled = true;
  document.getElementById("clear-selection").disabled = false;
  if (thresholds.length !== 4 || thresholds.some((value, index) => !Number.isFinite(value) || value <= 0 || value >= 100 || (index > 0 && value <= thresholds[index - 1]))) {
    setState("Classification boundaries must be increasing values between 0 and 100.", true);
    return;
  }
  setState("Analyzing GISD30 impervious-surface pixels…");
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        geometry: selection.toGeoJSON().geometry,
        thresholds,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "Analysis failed.");
    result = payload;
    showResult(payload);
    setState("Analysis complete. Impervious surface within the selected rectangle.");
  } catch (error) {
    setState(error.message || "Could not reach the analysis service.", true);
  }
}

function setState(message, isError = false) {
  analysisState.classList.toggle("error", isError);
  analysisState.innerHTML = `<span class="state-icon" aria-hidden="true">${isError ? "!" : "＋"}</span><span></span>`;
  analysisState.querySelector("span:last-child").textContent = message;
  analysisState.hidden = false;
}

function showResult(value) {
  document.getElementById("result-impervious-percent").textContent = value.impervious_percent.toFixed(2);
  document.getElementById("result-proxy-percent").textContent = value.urbanization_proxy_percent.toFixed(2);
  document.getElementById("result-level").textContent = value.urbanization_level;
  document.getElementById("result-area").textContent = `${value.area_km2.toFixed(3)} km²`;
  document.getElementById("result-impervious-area").textContent = `${value.impervious_area_km2.toFixed(3)} km²`;
  document.getElementById("result-center").textContent = `${value.latitude.toFixed(5)}, ${value.longitude.toFixed(5)}`;
  document.getElementById("meta-date").textContent = value.analysis_date;
  document.getElementById("meta-method").textContent = value.processing_method;
  resultElement.hidden = false;
  analysisState.hidden = true;
  document.getElementById("save-site").disabled = false;
}

function clearSelection() {
  selectedLayer.clearLayers();
  selection = null;
  result = null;
  resultElement.hidden = true;
  document.getElementById("save-site").disabled = true;
  document.getElementById("clear-selection").disabled = true;
  setState("Draw a rectangle on the map to begin.");
}

function saveSite() {
  if (!result) return;
  const nameInput = document.getElementById("site-name");
  const name = nameInput.value.trim() || `Site ${savedSites.length + 1}`;
  const site = { ...result, site: name, id: crypto.randomUUID() };
  savedSites.push(site);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSites));
  nameInput.value = "";
  renderSites();
}

function renderSites() {
  const tbody = document.getElementById("sites-list");
  tbody.replaceChildren();
  savedLayer.clearLayers();
  savedSites.forEach((site) => {
    const layer = L.geoJSON(site.geometry, { style: { color: "#416e52", weight: 2, fillOpacity: 0.06 } });
    layer.addTo(savedLayer);
    const tooltip = document.createElement("span");
    tooltip.textContent = `${site.site} · ${site.impervious_percent.toFixed(2)}%`;
    layer.bindTooltip(tooltip);
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = site.site;
    nameCell.title = site.site;
    nameCell.tabIndex = 0;
    nameCell.className = "site-open";
    nameCell.addEventListener("click", () => map.fitBounds(layer.getBounds(), { padding: [35, 35] }));
    row.append(nameCell);
    [site.area_km2.toFixed(2), `${site.impervious_percent.toFixed(2)}%`].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    const actionCell = document.createElement("td");
    const removeButton = document.createElement("button");
    removeButton.className = "site-delete";
    removeButton.type = "button";
    removeButton.title = `Remove ${site.site}`;
    removeButton.setAttribute("aria-label", `Remove ${site.site}`);
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      savedSites = savedSites.filter((entry) => entry.id !== site.id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSites));
      renderSites();
    });
    actionCell.append(removeButton);
    row.append(actionCell);
    tbody.append(row);
  });
  document.getElementById("site-count").textContent = savedSites.length;
  document.getElementById("empty-sites").hidden = savedSites.length > 0;
  document.getElementById("export-csv").disabled = savedSites.length === 0;
  document.getElementById("export-geojson").disabled = savedSites.length === 0;
}

const CSV_COLUMNS = [
  ["Site", "site"], ["Latitude", "latitude"], ["Longitude", "longitude"], ["Area_km2", "area_km2"],
  ["Impervious_Area_km2", "impervious_area_km2"], ["Impervious_Surface_Percent", "impervious_percent"],
  ["Urbanization_Proxy_Percent", "urbanization_proxy_percent"], ["Urbanization_Level", "urbanization_level"],
  ["Dataset", "dataset"], ["Dataset_Source", "dataset_source"], ["Dataset_Version", "dataset_version"],
  ["Dataset_Paper", "dataset_paper"], ["Spatial_Resolution_m", "spatial_resolution_m"],
  ["Year", "year"], ["Analysis_Date", "analysis_date"], ["Tiles", "tiles"], ["Thresholds_Percent", "thresholds"],
  ["Processing_Method", "processing_method"], ["Polygon_GeoJSON", "geometry"],
];

function exportCsv() {
  const lines = [CSV_COLUMNS.map(([header]) => csvValue(header)).join(",")];
  savedSites.forEach((site) => lines.push(CSV_COLUMNS.map(([, key]) => {
    let value = site[key];
    if (["thresholds", "tiles", "geometry"].includes(key)) value = JSON.stringify(value);
    if (key === "site" && /^[=+\-@\t\r]/.test(value)) value = `'${value}`;
    return csvValue(value);
  }).join(",")));
  download(new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" }), "urbanization-sites.csv");
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportGeoJson() {
  const collection = {
    type: "FeatureCollection",
    features: savedSites.map((site) => ({
      type: "Feature",
      geometry: site.geometry,
      properties: Object.fromEntries(Object.entries(site).filter(([key]) => key !== "geometry" && key !== "id")),
    })),
  };
  download(new Blob([JSON.stringify(collection, null, 2)], { type: "application/geo+json" }), "urbanization-sites.geojson");
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function searchLocation() {
  const query = document.getElementById("location-search").value.trim();
  const resultsBox = document.getElementById("search-results");
  if (!query) return;
  resultsBox.hidden = false;
  resultsBox.textContent = "Searching…";
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("Place search is unavailable.");
    const places = await response.json();
    resultsBox.replaceChildren();
    if (!places.length) {
      resultsBox.textContent = "No matching places.";
      return;
    }
    places.forEach((place) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = place.display_name;
      button.addEventListener("click", () => {
        map.setView([Number(place.lat), Number(place.lon)], Math.max(map.getZoom(), 12));
        resultsBox.hidden = true;
      });
      resultsBox.append(button);
    });
  } catch (error) {
    resultsBox.textContent = error.message;
  }
}

async function loadStatus() {
  const statusElement = document.getElementById("api-status");
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    statusElement.innerHTML = `<i></i><span></span>`;
    statusElement.querySelector("span").textContent = status.ready ? "Public GISD30 data ready" : status.message;
    statusElement.classList.toggle("ready", status.ready);
    statusElement.classList.toggle("failed", !status.ready);
  } catch {
    statusElement.querySelector("i").style.background = "#bf684e";
    statusElement.lastChild.textContent = " Analysis service unavailable";
  }
}

renderSites();
loadStatus();