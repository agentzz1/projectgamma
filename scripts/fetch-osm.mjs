import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGIN = { lon: 8.40428, lat: 49.01382 };
const DATA_AREA = { minX: -1000, maxX: 1000, minY: -1200, maxY: 450 };
const PLAY_BOUNDS = { minX: -880, maxX: 880, minY: -1080, maxY: 330 };
const TILE_DEG = { lon: 0.004, lat: 0.003 };
const LEVEL_HEIGHT = 3.2;
const API_URL = "https://api.openstreetmap.org/api/0.6/map.json";
const USER_AGENT = "karlsruhe-walk-data/1.0 (+https://github.com/agentzz1/projectgamma)";
const OUTPUT_FILE = path.join(process.cwd(), "public", "data", "osm-city.json");
const CACHE_DIR = path.join(os.tmpdir(), "karlsruhe-walk-osm-cache");

const METERS_PER_LAT = 111132;
const METERS_PER_LON = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320;

const DEFAULT_HEIGHTS = {
  carport: 2.6,
  garage: 3,
  garages: 3,
  shed: 2.8,
  kiosk: 3.2,
  hut: 3,
  roof: 4,
  house: 8,
  detached: 8,
  church: 18,
  cathedral: 25,
  chapel: 8,
  retail: 12,
  industrial: 10,
  warehouse: 9,
  school: 12,
};
const DEFAULT_HEIGHT = 13;
const NON_BLOCKING_TYPES = new Set(["roof", "bridge", "carport"]);
const ROOF_SHAPES = {
  flat: "flat",
  gabled: "gabled",
  saltbox: "gabled",
  gambrel: "gabled",
  round: "gabled",
  sawtooth: "gabled",
  hipped: "hipped",
  "half-hipped": "hipped",
  half_hipped: "hipped",
  side_hipped: "hipped",
  mansard: "hipped",
  crosspitched: "hipped",
  pyramidal: "pyramidal",
  pyramid: "pyramidal",
  cone: "pyramidal",
  dome: "dome",
  onion: "dome",
  skillion: "skillion",
  lean_to: "skillion",
};
const GROUND_CLASSES = [
  ["water", (tags) => tags.natural === "water" || tags.waterway === "riverbank" || ["reservoir", "basin"].includes(tags.landuse)],
  [
    "green",
    (tags) =>
      ["park", "garden", "playground", "golf_course", "pitch", "dog_park"].includes(tags.leisure) ||
      ["grass", "meadow", "village_green", "forest", "recreation_ground", "cemetery", "allotments", "flowerbed", "orchard"].includes(tags.landuse) ||
      ["wood", "grassland", "scrub", "heath"].includes(tags.natural),
  ],
  [
    "paved",
    (tags) =>
      (tags.highway === "pedestrian" && tags.area === "yes") ||
      tags.place === "square" ||
      (tags.amenity === "parking" && !["underground", "multi-storey"].includes(tags.parking)),
  ],
];
const NAMED_AREA_TAGS = [
  ["place", "square"],
  ["highway", "pedestrian"],
  ["amenity", "marketplace"],
  ["leisure", "park"],
  ["leisure", "garden"],
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const tiles = buildTiles();
  console.log(`Fetching ${tiles.length} OSM tiles (cache: ${CACHE_DIR})`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();
  for (let index = 0; index < tiles.length; index += 1) {
    const data = await fetchTile(tiles[index]);
    data.elements.forEach((element) => {
      if (element.type === "node") nodes.set(element.id, element);
      else if (element.type === "way") ways.set(element.id, element);
      else if (element.type === "relation") relations.set(element.id, element);
    });
    process.stdout.write(`\r  tile ${index + 1}/${tiles.length}`);
  }
  process.stdout.write("\n");

  const localNodes = new Map();
  nodes.forEach((node, id) => localNodes.set(id, toLocal(node.lon, node.lat)));

  const buildings = collectBuildings(ways, relations, localNodes);
  markOutlinesWithParts(buildings);
  const streets = collectStreets(ways, localNodes);
  const areas = collectNamedAreas(ways, relations, localNodes);
  const ground = collectGround(ways, relations, localNodes);
  const trees = collectTrees(nodes, ways, localNodes);
  const lamps = collectPoints(nodes, (tags) => tags.highway === "street_lamp" && isPoleMounted(tags));
  const benches = collectPoints(nodes, (tags) => tags.amenity === "bench");

  const output = {
    source: "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
    generatedBy: "scripts/fetch-osm.mjs",
    origin: { ...ORIGIN, baseHeight: 0 },
    bounds: PLAY_BOUNDS,
    dataArea: DATA_AREA,
    buildings: buildings.map(serializeBuilding),
    streets,
    areas,
    ground,
    trees,
    lamps,
    benches,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  const sizeKb = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
  console.log(
    `Wrote ${path.relative(process.cwd(), OUTPUT_FILE)} (${sizeKb} KB): ` +
      `${buildings.length} buildings/parts, ${streets.length} streets, ${areas.length} areas, ${ground.length} ground areas, ` +
      `${trees.length} trees, ${lamps.length} lamps, ${benches.length} benches`
  );
}

function buildTiles() {
  const min = toLonLat(DATA_AREA.minX, DATA_AREA.minY);
  const max = toLonLat(DATA_AREA.maxX, DATA_AREA.maxY);
  const tiles = [];
  for (let lat = min.lat; lat < max.lat; lat += TILE_DEG.lat) {
    for (let lon = min.lon; lon < max.lon; lon += TILE_DEG.lon) {
      tiles.push({
        minLon: lon,
        minLat: lat,
        maxLon: Math.min(lon + TILE_DEG.lon, max.lon),
        maxLat: Math.min(lat + TILE_DEG.lat, max.lat),
      });
    }
  }
  return tiles;
}

async function fetchTile(tile) {
  const bbox = [tile.minLon, tile.minLat, tile.maxLon, tile.maxLat].map((value) => value.toFixed(5)).join(",");
  const cacheFile = path.join(CACHE_DIR, `${bbox.replaceAll(",", "_")}.json`);
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  }

  const url = `${API_URL}?bbox=${bbox}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (response.ok) {
        const text = await response.text();
        fs.writeFileSync(cacheFile, text);
        await sleep(700);
        return JSON.parse(text);
      }
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`OSM API returned ${response.status} for ${url}`);
      }
      if (attempt >= 4) throw new Error(`OSM API returned ${response.status} for ${url} after ${attempt} attempts`);
    } catch (error) {
      if (attempt >= 4 || /returned 4\d\d/.test(String(error.message))) throw error;
    }
    await sleep(2000 * attempt);
  }
}

function collectBuildings(ways, relations, localNodes) {
  const buildings = [];
  const relationMemberWays = new Set();

  relations.forEach((relation) => {
    const tags = relation.tags || {};
    if (tags.type !== "multipolygon") return;
    const kind = buildingKind(tags);
    if (!kind) return;
    const outerIds = [];
    const innerIds = [];
    relation.members.forEach((member) => {
      if (member.type !== "way") return;
      relationMemberWays.add(member.ref);
      (member.role === "inner" ? innerIds : outerIds).push(member.ref);
    });
    const outers = assembleRings(outerIds, ways, localNodes);
    const inners = assembleRings(innerIds, ways, localNodes);
    outers.forEach((outer, ringIndex) => {
      const holes = inners.filter((inner) => pointInRing(inner[0][0], inner[0][1], outer));
      const building = makeBuilding(`r${relation.id}_${ringIndex}`, tags, kind, outer, holes);
      if (building) buildings.push(building);
    });
  });

  ways.forEach((way) => {
    const tags = way.tags || {};
    const kind = buildingKind(tags);
    if (!kind) return;
    if (relationMemberWays.has(way.id)) return;
    const ring = wayRing(way, localNodes);
    if (!ring) return;
    const building = makeBuilding(`w${way.id}`, tags, kind, ring, []);
    if (building) buildings.push(building);
  });

  return buildings;
}

function buildingKind(tags) {
  if (tags.location === "underground" || (parseNumber(tags.layer) || 0) < 0) return null;
  const part = tags["building:part"];
  if (part && part !== "no") return { part: true, type: part };
  const building = tags.building;
  if (building && building !== "no" && building !== "collapsed" && building !== "destroyed") {
    return { part: false, type: building };
  }
  return null;
}

function makeBuilding(id, tags, kind, outer, holes) {
  const ring = cleanRing(outer);
  if (ring.length < 3) return null;
  if (!ringTouchesArea(ring)) return null;

  const dims = orientedDimensions(ring);
  const roofShape = ROOF_SHAPES[String(tags["roof:shape"] || "flat").toLowerCase()] || "flat";
  const levels = parseNumber(tags["building:levels"]);
  const roofLevels = parseNumber(tags["roof:levels"]);
  const minLevel = parseNumber(tags["building:min_level"]);

  let roofHeight = roofShape === "flat" ? 0 : parseNumber(tags["roof:height"]);
  if (roofShape !== "flat" && roofHeight == null) {
    roofHeight = roofLevels != null && roofLevels > 0
      ? roofLevels * 2.6 + 0.8
      : clamp(dims.shortSide * 0.32, 1.5, 6);
  }

  let totalHeight = parseNumber(tags.height);
  if (totalHeight == null) {
    totalHeight = levels != null
      ? levels * LEVEL_HEIGHT + roofHeight
      : (DEFAULT_HEIGHTS[kind.type] || DEFAULT_HEIGHT) + roofHeight;
  }

  let minHeight = parseNumber(tags.min_height);
  if (minHeight == null) minHeight = minLevel != null ? minLevel * LEVEL_HEIGHT : 0;
  if (kind.type === "roof" && minHeight === 0) minHeight = Math.max(2.4, totalHeight - 1);
  if (kind.type === "bridge" && minHeight === 0) minHeight = Math.max(3.5, totalHeight - 4);

  totalHeight = Math.max(totalHeight, minHeight + 1);
  roofHeight = Math.min(roofHeight, (totalHeight - minHeight) * 0.85);
  const wallHeight = totalHeight - roofHeight;

  return {
    id,
    part: kind.part,
    type: kind.type,
    outer: ring,
    holes: holes.map(cleanRing).filter((hole) => hole.length >= 3),
    minHeight,
    wallHeight,
    totalHeight,
    roofShape,
    roofOrientation: tags["roof:orientation"] === "across" ? "across" : undefined,
    roofDirection: parseDirection(tags["roof:direction"]),
    color: normalizeColor(tags["building:colour"]),
    roofColor: normalizeColor(tags["roof:colour"]),
    blocking: minHeight < 2.2 && !NON_BLOCKING_TYPES.has(kind.type),
    hasParts: false,
  };
}

function markOutlinesWithParts(buildings) {
  const outlines = buildings.filter((building) => !building.part);
  const outlineBounds = outlines.map((building) => ringBounds(building.outer));
  buildings.forEach((building) => {
    if (!building.part) return;
    const center = ringCentroid(building.outer);
    let containedBy = null;
    outlines.forEach((outline, index) => {
      if (containedBy) return;
      const b = outlineBounds[index];
      if (center[0] < b.minX || center[0] > b.maxX || center[1] < b.minY || center[1] > b.maxY) return;
      if (pointInRing(center[0], center[1], outline.outer)) containedBy = outline;
    });
    if (containedBy) {
      containedBy.hasParts = true;
      building.blocking = false;
    }
  });
}

function serializeBuilding(building) {
  const record = {
    o: flatten(building.outer),
    mh: round1(building.minHeight),
    wh: round1(building.wallHeight),
    th: round1(building.totalHeight),
  };
  if (building.holes.length) record.h = building.holes.map(flatten);
  if (building.roofShape !== "flat") record.rs = building.roofShape;
  if (building.roofOrientation) record.ro = building.roofOrientation;
  if (building.roofDirection != null) record.rd = building.roofDirection;
  if (building.color) record.c = building.color;
  if (building.roofColor) record.rc = building.roofColor;
  if (building.part) record.p = 1;
  if (building.hasParts) record.hp = 1;
  if (building.blocking) record.b = 1;
  if (["church", "cathedral", "chapel"].includes(building.type)) record.k = "church";
  return record;
}

function collectStreets(ways, localNodes) {
  const streets = [];
  ways.forEach((way) => {
    const tags = way.tags || {};
    if (!tags.highway || !tags.name) return;
    if (["proposed", "construction", "abandoned", "platform"].includes(tags.highway)) return;
    if (tags.area === "yes") return;
    const points = (way.nodes || []).map((id) => localNodes.get(id)).filter(Boolean);
    if (points.length < 2 || !points.some(insideDataArea)) return;
    streets.push({ n: tags.name, l: flatten(simplifyLine(points, 0.6)) });
  });
  return streets;
}

function collectNamedAreas(ways, relations, localNodes) {
  const areas = [];
  const matches = (tags) =>
    tags.name && NAMED_AREA_TAGS.some(([key, value]) => tags[key] === value) &&
    (tags.highway !== "pedestrian" || tags.area === "yes" || tags.type === "multipolygon");

  ways.forEach((way) => {
    const tags = way.tags || {};
    if (!matches(tags)) return;
    const ring = wayRing(way, localNodes);
    if (ring && ringTouchesArea(ring)) areas.push({ n: tags.name, a: flatten(cleanRing(ring)) });
  });
  relations.forEach((relation) => {
    const tags = relation.tags || {};
    if (tags.type !== "multipolygon" || !matches(tags)) return;
    const outerIds = relation.members.filter((m) => m.type === "way" && m.role !== "inner").map((m) => m.ref);
    assembleRings(outerIds, ways, localNodes).forEach((ring) => {
      if (ringTouchesArea(ring)) areas.push({ n: tags.name, a: flatten(cleanRing(ring)) });
    });
  });
  return areas;
}

function collectGround(ways, relations, localNodes) {
  const ground = [];
  const groundClass = (tags) => (GROUND_CLASSES.find(([, matches]) => matches(tags)) || [])[0];
  const push = (kind, outer, holes) => {
    const ring = cleanRing(outer);
    if (ring.length < 3 || !ringTouchesArea(ring)) return;
    const record = { k: kind, a: flatten(ring) };
    const cleanHoles = holes.map(cleanRing).filter((hole) => hole.length >= 3);
    if (cleanHoles.length) record.h = cleanHoles.map(flatten);
    ground.push(record);
  };

  ways.forEach((way) => {
    const kind = groundClass(way.tags || {});
    const ring = kind && wayRing(way, localNodes);
    if (ring) push(kind, ring, []);
  });
  relations.forEach((relation) => {
    const tags = relation.tags || {};
    const kind = tags.type === "multipolygon" && groundClass(tags);
    if (!kind) return;
    const members = relation.members.filter((member) => member.type === "way");
    const outers = assembleRings(members.filter((m) => m.role !== "inner").map((m) => m.ref), ways, localNodes);
    const inners = assembleRings(members.filter((m) => m.role === "inner").map((m) => m.ref), ways, localNodes);
    outers.forEach((outer) => push(kind, outer, inners.filter((inner) => pointInRing(inner[0][0], inner[0][1], outer))));
  });
  return ground;
}

function collectTrees(nodes, ways, localNodes) {
  const trees = [];
  nodes.forEach((node) => {
    if (!node.tags || node.tags.natural !== "tree") return;
    const point = localNodes.get(node.id);
    if (insideDataArea(point)) trees.push(round1(point[0]), round1(point[1]));
  });
  ways.forEach((way) => {
    if (!way.tags || way.tags.natural !== "tree_row") return;
    const points = (way.nodes || []).map((id) => localNodes.get(id)).filter(Boolean);
    for (let i = 1; i < points.length; i += 1) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const length = Math.hypot(bx - ax, by - ay);
      const count = Math.max(1, Math.round(length / 9));
      for (let s = 0; s < count; s += 1) {
        const t = (s + 0.5) / count;
        const point = [ax + (bx - ax) * t, ay + (by - ay) * t];
        if (insideDataArea(point)) trees.push(round1(point[0]), round1(point[1]));
      }
    }
  });
  return trees;
}

function collectPoints(nodes, predicate) {
  const points = [];
  nodes.forEach((node) => {
    if (!node.tags || !predicate(node.tags)) return;
    const point = toLocal(node.lon, node.lat);
    if (insideDataArea(point)) points.push(round1(point[0]), round1(point[1]));
  });
  return points;
}

function isPoleMounted(tags) {
  const mount = String(tags.support || tags.lamp_mount || "").toLowerCase();
  return !/wall|suspen|catenary|wire|ceiling|building|bridge/.test(mount);
}

function assembleRings(wayIds, ways, localNodes) {
  const segments = wayIds
    .map((id) => ways.get(id))
    .filter((way) => way && way.nodes && way.nodes.length >= 2)
    .map((way) => way.nodes.slice());
  const rings = [];

  while (segments.length) {
    let current = segments.shift();
    let guard = 0;
    while (current[0] !== current[current.length - 1] && guard < 500) {
      guard += 1;
      const last = current[current.length - 1];
      const index = segments.findIndex((segment) => segment[0] === last || segment[segment.length - 1] === last);
      if (index === -1) break;
      const [segment] = segments.splice(index, 1);
      current = current.concat(segment[0] === last ? segment.slice(1) : segment.slice(0, -1).reverse());
    }
    if (current.length < 4 || current[0] !== current[current.length - 1]) continue;
    const points = current.map((id) => localNodes.get(id));
    if (points.every(Boolean)) rings.push(points);
  }
  return rings;
}

function wayRing(way, localNodes) {
  const ids = way.nodes || [];
  if (ids.length < 4 || ids[0] !== ids[ids.length - 1]) return null;
  const points = ids.map((id) => localNodes.get(id));
  return points.every(Boolean) ? points : null;
}

function cleanRing(points) {
  const ring = points.map((point) => [round1(point[0]), round1(point[1])]);
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
  const deduped = ring.filter((point, index) => index === 0 || !samePoint(point, ring[index - 1]));
  if (deduped.length > 1 && samePoint(deduped[0], deduped[deduped.length - 1])) deduped.pop();

  let changed = true;
  let result = deduped;
  while (changed && result.length > 3) {
    changed = false;
    for (let i = 0; i < result.length; i += 1) {
      const prev = result[(i - 1 + result.length) % result.length];
      const next = result[(i + 1) % result.length];
      if (pointLineDistance(result[i], prev, next) < 0.08) {
        result = result.filter((_, index) => index !== i);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points.map((point) => [round1(point[0]), round1(point[1])]);
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = pointLineDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= tolerance) {
    return [points[0], points[points.length - 1]].map((point) => [round1(point[0]), round1(point[1])]);
  }
  const left = simplifyLine(points.slice(0, index + 1), tolerance);
  const right = simplifyLine(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function orientedDimensions(ring) {
  let best = { area: Infinity, longSide: 0, shortSide: 0 };
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    ring.forEach(([x, y]) => {
      const u = x * cos - y * sin;
      const v = x * sin + y * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    });
    const width = maxU - minU;
    const depth = maxV - minV;
    if (width * depth < best.area) {
      best = { area: width * depth, longSide: Math.max(width, depth), shortSide: Math.min(width, depth) };
    }
  }
  return best;
}

function parseNumber(value) {
  if (value == null) return null;
  const match = String(value).trim().replace(",", ".").match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|')?/i);
  if (!match) return null;
  let number = Number.parseFloat(match[1]);
  if (match[2] && /ft|'/i.test(match[2])) number *= 0.3048;
  return Number.isFinite(number) ? number : null;
}

function parseDirection(value) {
  if (value == null) return null;
  const compass = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
  const key = String(value).trim().toUpperCase();
  if (key in compass) return compass[key];
  const number = parseNumber(value);
  return number == null ? null : ((number % 360) + 360) % 360;
}

function normalizeColor(value) {
  if (!value) return undefined;
  const color = String(value).trim().toLowerCase().replace(/[\s_-]/g, "");
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^[0-9a-f]{6}$/.test(color)) return `#${color}`;
  if (/^[a-z]{3,20}$/.test(color)) return color;
  return undefined;
}

function toLocal(lon, lat) {
  return [(lon - ORIGIN.lon) * METERS_PER_LON, (lat - ORIGIN.lat) * METERS_PER_LAT];
}

function toLonLat(x, y) {
  return { lon: ORIGIN.lon + x / METERS_PER_LON, lat: ORIGIN.lat + y / METERS_PER_LAT };
}

function insideDataArea(point) {
  return (
    point &&
    point[0] >= DATA_AREA.minX &&
    point[0] <= DATA_AREA.maxX &&
    point[1] >= DATA_AREA.minY &&
    point[1] <= DATA_AREA.maxY
  );
}

function ringTouchesArea(ring) {
  return ring.some(insideDataArea);
}

function ringBounds(ring) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  ring.forEach(([x, y]) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  });
  return bounds;
}

function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  ring.forEach((point) => {
    x += point[0];
    y += point[1];
  });
  return [x / ring.length, y / ring.length];
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointLineDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function flatten(points) {
  return points.flatMap((point) => [round1(point[0]), round1(point[1])]);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
