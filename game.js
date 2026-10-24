(function () {
  "use strict";

  const QUALITY = {
    boot: "Wird geladen",
    local: "Luftbild + OSM-Gebäude",
    localGround: "OSM-Gebäude + lokaler Boden",
    error: "Szene-Fehler",
  };

  const DEFAULT_POSE = { x: 0, y: -205, heading: Math.PI, pitch: -0.05 };
  const PLAYER_RADIUS = 0.45;
  const COLLISION_CELL = 24;
  const RENDER_CELL = 220;
  const WALL_PALETTE = ["#e8e1d3", "#e2d5bd", "#d9cab0", "#efe8dc", "#d5d0c6", "#e5d2c1", "#cdbfa8", "#e7dbc4", "#d3c5b7", "#c9c4ba"];
  const CHURCH_PALETTE = ["#d6ccb8", "#c9b9a0", "#bfae96"];
  const ROOF_PALETTE = ["#8e4c39", "#7b4233", "#9c5b43", "#5d6166", "#4f5358", "#6e5a4f"];
  const TREE_PALETTE = ["#4d6b3c", "#5a7745", "#3f5d39", "#66804a", "#476540"];
  // OSM colour names are coarse mapper hints ("yellow" for an ochre facade), not literal CSS colours.
  const NAMED_WALL_COLORS = {
    yellow: "#e2cf9c",
    red: "#a85a47",
    orange: "#d4a070",
    brown: "#8c6c52",
    green: "#86a083",
    blue: "#8494a8",
    white: "#ebe8e1",
    grey: "#aeaca6",
    gray: "#aeaca6",
    black: "#4a4a4a",
    silver: "#bcbfc1",
    beige: "#ddd0b4",
    cream: "#ece2c6",
    pink: "#d9b6ab",
    purple: "#8f7d94",
  };
  const NAMED_ROOF_COLORS = {
    red: "#9a4b3a",
    brown: "#6e4a3a",
    green: "#6f9884",
    grey: "#6d7074",
    gray: "#6d7074",
    black: "#3b3e41",
    silver: "#9da2a6",
    white: "#d8d8d4",
    blue: "#5d6b7d",
    orange: "#b06a45",
  };
  const SUNLIT_FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;

void main()
{
    vec3 normalEC = normalize(v_normalEC);
#ifdef FACE_FORWARD
    normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
#endif
    vec4 color = czm_gammaCorrect(v_color);
    float sun = max(dot(normalEC, czm_lightDirectionEC), 0.0);
    out_FragColor = vec4(color.rgb * (0.6 + 0.62 * sun * czm_lightColor), color.a);
}
`;
  const MOVEMENT_KEYS = new Set([
    "KeyW",
    "KeyA",
    "KeyB",
    "KeyD",
    "KeyS",
    "KeyQ",
    "KeyZ",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ShiftLeft",
    "ShiftRight",
    "Space",
  ]);

  const state = {
    config: window.__KARLSRUHE_WALK_CONFIG__ || {},
    viewer: null,
    resizePending: true,
    world: null,
    ready: false,
    started: false,
    mode: "boot",
    qualityMode: "boot",
    qualityError: "",
    keys: new Set(),
    pointerLocked: false,
    mapOpen: false,
    inspectOpen: false,
    travelMenuOpen: false,
    travelIndex: 0,
    moveBlocked: false,
    activeLandmark: null,
    announcedLandmarkId: null,
    announcedBlocked: false,
    currentArea: "Schlossplatz",
    lastAreaPoint: null,
    collision: null,
    enuRotation: null,
    useOrthophoto: false,
    orthophotoFailed: false,
    frameHandle: 0,
    lastFrameTime: 0,
    frameTimeAverage: 0,
    slowSeconds: 0,
    fps: 0,
    fpsFrames: 0,
    fpsTimer: 0,
    time: 0,
    lastGroundSampleAt: 0,
    lastHashUpdateAt: 0,
    groundSamplePending: false,
    landmarkEntities: [],
    player: {
      x: DEFAULT_POSE.x,
      y: DEFAULT_POSE.y,
      heading: DEFAULT_POSE.heading,
      pitch: DEFAULT_POSE.pitch,
      groundHeight: 0,
      eyeHeight: 1.72,
      speedMps: 0,
      moveSpeed: 0,
      lastMoveDir: { x: 0, y: 1 },
      bobPhase: 0,
    },
    mapPlayer: null,
    touchMove: { x: 0, y: 0 },
    isTouch: false,
    audio: { ctx: null, unlocked: false, muted: false, gain: null, distanceSinceStep: 0 },
    weather: { active: false, ctx: null, drops: [] },
  };

  const dom = {};
  const svgNs = "http://www.w3.org/2000/svg";

  window.addEventListener("DOMContentLoaded", main);
  window.render_game_to_text = renderGameToText;
  window.advanceTime = advanceTime;

  async function main() {
    try {
      state.audio.muted = localStorage.getItem("kw_muted") === "1";
    } catch (error) {
      state.audio.muted = false;
    }

    bindDom();
    bindUi();
    updateMuteButton();

    if (!isWebglAvailable()) {
      failBoot("Kein WebGL verfügbar.", "Dieser Browser oder dieses Gerät unterstützt kein WebGL. Aktiviere Hardwarebeschleunigung oder nutze einen aktuellen Desktop-Browser.");
      return;
    }

    if (!window.Cesium) {
      failBoot("Cesium konnte nicht geladen werden.", "Die 3D-Engine wurde nicht gefunden. Prüfe, ob der lokale Server läuft (npm start) und lade die Seite neu.");
      return;
    }

    try {
      setBootStatus("Lade Karlsruher Datensätze...");
      await loadWorld();
      buildMiniMap();
      buildTravelList();
      await initViewer();
      attachInput();
      attachTouchControls();
      resetPlayerPose();
      applySharedPositionIfPresent();
      updateHud();
      state.ready = true;
      state.mode = "ready";
      dom.startBtn.disabled = false;
      dom.startBtn.focus();
      setBootStatus(`Szene bereit: ${qualityLabel()}`);
      startLoop();
    } catch (error) {
      console.error(error);
      const message = shortError(error);
      const hint = /Failed to load/.test(message)
        ? "Lokale Datendatei fehlt oder der Server liefert sie nicht aus. Prüfe public/data/ und starte den Server neu."
        : "Prüfe WebGL oder lokale Dateien und lade die Seite neu.";
      failBoot(message, hint);
    }
  }

  function bindDom() {
    dom.appShell = document.getElementById("app-shell");
    dom.cesiumContainer = document.getElementById("cesium-container");
    dom.startPanel = document.getElementById("start-panel");
    dom.startBtn = document.getElementById("start-btn");
    dom.bootStatus = document.getElementById("boot-status");
    dom.resetBtn = document.getElementById("reset-btn");
    dom.muteBtn = document.getElementById("mute-btn");
    dom.areaName = document.getElementById("area-name");
    dom.landmarkName = document.getElementById("landmark-name");
    dom.landmarkDistance = document.getElementById("landmark-distance");
    dom.qualityMode = document.getElementById("quality-mode");
    dom.headingText = document.getElementById("heading-text");
    dom.speedText = document.getElementById("speed-text");
    dom.walkStatus = document.getElementById("walk-status");
    dom.hintText = document.getElementById("hint-text");
    dom.mapPanel = document.getElementById("map-panel");
    dom.mapBuildings = document.getElementById("map-buildings");
    dom.mapLandmarks = document.getElementById("map-landmarks");
    dom.mapPlayer = document.getElementById("map-player");
    dom.inspectPanel = document.getElementById("inspect-panel");
    dom.inspectTitle = document.getElementById("inspect-title");
    dom.inspectBody = document.getElementById("inspect-body");
    dom.travelPanel = document.getElementById("travel-panel");
    dom.travelList = document.getElementById("travel-list");
    dom.sourceNote = document.getElementById("source-note");
    dom.touchMove = document.getElementById("touch-move");
    dom.touchMoveKnob = document.getElementById("touch-move-knob");
    dom.weatherCanvas = document.getElementById("weather-canvas");
    dom.srStatus = document.getElementById("sr-status");
    dom.timeSlider = document.getElementById("time-slider");
    dom.timeLabel = document.getElementById("time-label");
    dom.photoFlash = document.getElementById("photo-flash");
    dom.touchActions = document.getElementById("touch-actions");
    dom.mapBtn = document.getElementById("map-btn");
    dom.infoBtn = document.getElementById("info-btn");
    dom.travelBtn = document.getElementById("travel-btn");
  }

  function bindUi() {
    dom.startBtn.addEventListener("click", startExperience);
    dom.resetBtn.addEventListener("click", resetPlayerPose);
    dom.muteBtn.addEventListener("click", () => {
      state.audio.muted = !state.audio.muted;
      if (state.audio.gain) {
        state.audio.gain.gain.value = state.audio.muted ? 0 : 0.35;
      }
      try {
        localStorage.setItem("kw_muted", state.audio.muted ? "1" : "0");
      } catch (error) {
        // ignore storage errors (private mode, disabled storage)
      }
      updateMuteButton();
    });
    dom.timeSlider.addEventListener("input", () => applyTimeOfDay(Number(dom.timeSlider.value)));
    dom.mapBtn.addEventListener("click", () => toggleMap());
    dom.infoBtn.addEventListener("click", () => (state.inspectOpen ? closeInspect() : toggleInspect()));
    dom.travelBtn.addEventListener("click", () => toggleTravelMenu());
    dom.cesiumContainer.addEventListener("click", () => {
      if (state.started && !state.inspectOpen) {
        requestPointerLock();
      }
    });
  }

  function applyTimeOfDay(hourFloat) {
    if (!state.viewer) {
      return;
    }

    const hour = clamp(hourFloat, 0, 23.99);
    const wholeHour = Math.floor(hour);
    const minute = Math.round((hour - wholeHour) * 60);
    state.viewer.clock.currentTime = localTimeOfDay(hour);
    dom.timeLabel.textContent = `${String(wholeHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    renderScene();
  }

  function localTimeOfDay(localHour) {
    const summerTimeOffsetHours = 2;
    const midnightUtc = Date.UTC(2026, 5, 21);
    return window.Cesium.JulianDate.fromDate(new Date(midnightUtc + (localHour - summerTimeOffsetHours) * 3600000));
  }

  async function loadWorld() {
    const [city, landmarks] = await Promise.all([
      fetchJson("./data/osm-city.json"),
      fetchJson("./data/landmarks.json"),
    ]);

    const origin = city.origin;
    origin.metersPerLat = 111132;
    origin.metersPerLon = Math.cos((origin.lat * Math.PI) / 180) * 111320;

    state.world = {
      origin,
      bounds: city.bounds,
      landmarks,
      buildings: city.buildings.map(decodeBuilding),
      streets: city.streets.map((street) => ({ name: street.n, points: toPoints(street.l) })),
      areas: city.areas.map(decodeArea).sort((a, b) => a.size - b.size),
      ground: city.ground.map((area) => ({ kind: area.k, outer: toPoints(area.a), holes: (area.h || []).map(toPoints) })),
      trees: [],
      lamps: [],
      benches: [],
    };

    state.collision = buildCollisionIndex(state.world.buildings);
    const outsideBuildings = (point) => !insideBuildingFootprint(point[0], point[1]);
    state.world.trees = toPoints(city.trees).filter(outsideBuildings);
    state.world.lamps = toPoints(city.lamps).filter(outsideBuildings);
    state.world.benches = toPoints(city.benches).filter(outsideBuildings);
    state.world.trees.forEach(([x, y]) => addCollisionCircle(x, y, 0.25));
    state.world.lamps.forEach(([x, y]) => addCollisionCircle(x, y, 0.1));

    state.player.groundHeight = estimateGroundHeight();
  }

  function decodeBuilding(record, index) {
    const outer = toPoints(record.o);
    return {
      index,
      outer,
      holes: (record.h || []).map(toPoints),
      bounds: polygonBounds(outer),
      minHeight: record.mh,
      wallHeight: record.wh,
      totalHeight: record.th,
      roofShape: record.rs || "flat",
      roofAcross: record.ro === "across",
      roofDirection: record.rd,
      color: record.c,
      roofColor: record.rc,
      hasParts: Boolean(record.hp),
      blocking: Boolean(record.b),
      isChurch: record.k === "church",
    };
  }

  function decodeArea(record) {
    const points = toPoints(record.a);
    const bounds = polygonBounds(points);
    return { name: record.n, points, bounds, size: bounds.width * bounds.height };
  }

  function toPoints(flat) {
    const points = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      points.push([flat[index], flat[index + 1]]);
    }
    return points;
  }

  async function initViewer() {
    const Cesium = window.Cesium;
    const lowPowerDevice = window.matchMedia("(pointer: coarse)").matches;

    state.viewer = new Cesium.Viewer("cesium-container", {
      useDefaultRenderLoop: false,
      animation: false,
      timeline: false,
      geocoder: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      homeButton: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      fullscreenButton: false,
      scene3DOnly: true,
      shouldAnimate: false,
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      shadows: !lowPowerDevice,
      contextOptions: {
        webgl: {
          alpha: false,
          preserveDrawingBuffer: true,
        },
      },
    });

    state.viewer.imageryLayers.removeAll();
    try {
      const orthophotoProvider = new Cesium.WebMapServiceImageryProvider({
        url: "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C",
        layers: "IMAGES_DOP_20_RGB",
        parameters: {
          service: "WMS",
          version: "1.1.1",
          format: "image/jpeg",
          transparent: false,
        },
        maximumLevel: 19,
        enablePickFeatures: false,
      });
      let tileErrorCount = 0;
      orthophotoProvider.errorEvent.addEventListener(() => {
        tileErrorCount += 1;
        if (tileErrorCount >= 6 && state.useOrthophoto && !state.orthophotoFailed) {
          state.orthophotoFailed = true;
          state.useOrthophoto = false;
          state.viewer.imageryLayers.removeAll();
          addGroundPlane();
          state.qualityError = "LGL-Luftbilder gerade nicht erreichbar";
          updateSourceNote();
          if (state.ready && !state.started) {
            setBootStatus(`Szene bereit: ${qualityLabel()}`);
          }
          console.warn("Orthophoto tiles failed repeatedly, switched to local ground texture.");
        }
      });
      state.viewer.imageryLayers.addImageryProvider(orthophotoProvider);
      state.useOrthophoto = true;
    } catch (error) {
      console.warn("Orthophoto layer failed, falling back to local surfaces:", error);
      state.useOrthophoto = false;
    }
    state.viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#9dcdf2");
    state.viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#cfd8cb");
    state.viewer.scene.globe.enableLighting = true;
    state.viewer.scene.globe.depthTestAgainstTerrain = true;
    state.viewer.scene.globe.showGroundAtmosphere = true;
    state.viewer.scene.highDynamicRange = true;
    state.viewer.scene.postProcessStages.fxaa.enabled = true;
    state.viewer.scene.fog.enabled = true;
    state.viewer.scene.fog.density = 0.00058;
    state.viewer.scene.fog.minimumBrightness = 0.48;
    state.viewer.scene.skyAtmosphere.hueShift = -0.03;
    state.viewer.scene.skyAtmosphere.saturationShift = -0.16;
    state.viewer.scene.skyAtmosphere.brightnessShift = 0.14;
    if (state.viewer.scene.sun) {
      state.viewer.scene.sun.show = true;
    }
    if (state.viewer.scene.moon) {
      state.viewer.scene.moon.show = false;
    }
    state.viewer.clock.currentTime = localTimeOfDay(Number(dom.timeSlider.value));
    state.viewer.clock.multiplier = 0;
    state.viewer.clock.shouldAnimate = false;
    state.viewer.scene.screenSpaceCameraController.enableInputs = false;
    state.viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    state.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0;
    state.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 0;
    state.viewer.camera.frustum.fov = Cesium.Math.toRadians(68);
    state.viewer.camera.frustum.near = 0.1;
    state.viewer.shadowMap.maximumDistance = 300;
    state.viewer.shadowMap.softShadows = true;
    state.viewer.shadowMap.darkness = 0.55;
    state.viewer.shadowMap.size = 2048;
    // Cesium's default primitive bias is tuned for small models and stripes large facades with shadow acne.
    // Normal shading is off because SUNLIT_FRAGMENT_SHADER already darkens faces turned away from the sun.
    const primitiveBias = state.viewer.shadowMap._primitiveBias;
    if (primitiveBias) {
      primitiveBias.normalOffsetScale = 0.6;
      primitiveBias.depthBias = 0.0004;
      primitiveBias.normalShading = false;
    }
    state.viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.25);

    await configureQuality();
    updateSourceNote();
  }

  async function configureQuality() {
    state.qualityError = "";
    setBootStatus(
      state.useOrthophoto
        ? "Lade freie LGL-Luftbilder und OSM-Gebäude..."
        : "Lade OSM-Gebäude..."
    );
    if (!state.useOrthophoto) {
      addGroundPlane();
    }
    addOsmBuildings();
    addStreetFurniture();
    addLandmarks(true);
    state.qualityMode = "local";
  }

  function addGroundPlane() {
    const Cesium = window.Cesium;
    const bounds = state.world.bounds;
    const margin = 400;
    const width = bounds.maxX - bounds.minX + margin * 2;
    const depth = bounds.maxY - bounds.minY + margin * 2;

    state.viewer.entities.add({
      polygon: {
        hierarchy: polygonHierarchy([
          [bounds.minX - margin, bounds.minY - margin],
          [bounds.maxX + margin, bounds.minY - margin],
          [bounds.maxX + margin, bounds.maxY + margin],
          [bounds.minX - margin, bounds.maxY + margin],
        ]),
        height: state.world.origin.baseHeight + 0.03,
        material: new Cesium.ImageMaterialProperty({
          image: createGroundTexture(),
          repeat: new Cesium.Cartesian2(Math.round(width / 12), Math.round(depth / 12)),
        }),
        shadows: Cesium.ShadowMode.RECEIVE_ONLY,
      },
    });

    const styles = {
      paved: { color: "#a19b90", height: 0.05 },
      green: { color: "#6b8553", height: 0.09 },
      water: { color: "#56768a", height: 0.12 },
    };
    const toPositions = (ring) => ring.map((point) => localToCartesian(point[0], point[1], 0));
    addBatchedPrimitive(
      state.world.ground.map((area) => {
        const style = styles[area.kind];
        return new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              toPositions(area.outer),
              area.holes.map((hole) => new Cesium.PolygonHierarchy(toPositions(hole)))
            ),
            height: state.world.origin.baseHeight + style.height,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(style.color)) },
        });
      }),
      { closed: false, shadows: Cesium.ShadowMode.RECEIVE_ONLY }
    );
  }

  function addOsmBuildings() {
    const Cesium = window.Cesium;
    const cells = new Map();

    state.world.buildings.forEach((building) => {
      if (building.hasParts) {
        return;
      }

      const wallColor = buildingWallColor(building);
      const roof = buildRoofMesh(building);
      const wallTop = roof ? building.wallHeight : (building.wallHeight + building.totalHeight) / 2;
      const centerX = (building.bounds.minX + building.bounds.maxX) / 2;
      const centerY = (building.bounds.minY + building.bounds.maxY) / 2;

      pushToCell(
        cells,
        centerX,
        centerY,
        "walls",
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: buildingHierarchy(building),
            height: building.minHeight,
            extrudedHeight: wallTop,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(wallColor) },
        })
      );

      if (roof) {
        pushToCell(cells, centerX, centerY, "roofs", meshInstance(roof.roof, buildingRoofColor(building)));
        if (roof.gable.positions.length) {
          pushToCell(cells, centerX, centerY, "roofs", meshInstance(roof.gable, wallColor));
        }
      }
    });

    cells.forEach((cell) => {
      addBatchedPrimitive(cell.walls || [], { shadows: Cesium.ShadowMode.ENABLED });
      addBatchedPrimitive(cell.roofs || [], { closed: false, asynchronous: false, shadows: Cesium.ShadowMode.ENABLED });
    });
  }

  // Spatial cells let Cesium frustum-cull whole blocks of the city; one malformed OSM polygon also only loses its cell.
  function pushToCell(cells, x, y, group, instance) {
    const key = `${Math.floor(x / RENDER_CELL)}:${Math.floor(y / RENDER_CELL)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {};
      cells.set(key, cell);
    }
    if (!cell[group]) {
      cell[group] = [];
    }
    cell[group].push(instance);
  }

  function buildingHierarchy(building) {
    const Cesium = window.Cesium;
    const toPositions = (ring) => ring.map((point) => localToCartesian(point[0], point[1], 0));
    return new Cesium.PolygonHierarchy(
      toPositions(building.outer),
      building.holes.map((hole) => new Cesium.PolygonHierarchy(toPositions(hole)))
    );
  }

  function buildingWallColor(building) {
    const variation = (hashString(`wall:${building.index}`) % 1000) / 1000;
    const palette = building.isChurch ? CHURCH_PALETTE : WALL_PALETTE;
    const fallback = palette[hashString(`palette:${building.index}`) % palette.length];
    return taggedColor(building.color, NAMED_WALL_COLORS, fallback, variation);
  }

  function buildingRoofColor(building) {
    const variation = (hashString(`roof:${building.index}`) % 1000) / 1000;
    const fallback = ROOF_PALETTE[hashString(`roofpalette:${building.index}`) % ROOF_PALETTE.length];
    return taggedColor(building.roofColor, NAMED_ROOF_COLORS, fallback, variation);
  }

  function taggedColor(value, namedColors, fallback, variation) {
    const Cesium = window.Cesium;
    if (value && namedColors[value]) {
      return softenColor(Cesium.Color.fromCssColorString(namedColors[value]), 0, variation);
    }
    const parsed = value && Cesium.Color.fromCssColorString(value);
    if (parsed) {
      return softenColor(parsed, 0.5, variation);
    }
    return softenColor(Cesium.Color.fromCssColorString(fallback), 0, variation);
  }

  function softenColor(color, mute, variation) {
    const luminance = color.red * 0.299 + color.green * 0.587 + color.blue * 0.114;
    const scale = 0.93 + variation * 0.08;
    const channel = (value) => Math.min(0.92, (value + (luminance - value) * mute) * scale);
    return new window.Cesium.Color(channel(color.red), channel(color.green), channel(color.blue), 1);
  }

  function buildRoofMesh(building) {
    const shape = building.roofShape;
    const base = building.wallHeight;
    const top = building.totalHeight;
    if (shape === "flat" || top - base < 0.3) {
      return null;
    }
    if (shape === "pyramidal" || shape === "dome") {
      return pyramidRoof(building.outer, base, top, shape === "dome");
    }
    const rect = roofRectangle(building.outer);
    if (!rect) {
      return null;
    }
    return shape === "skillion"
      ? skillionRoof(rect, base, top, building.roofDirection)
      : ridgeRoof(rect, base, top, shape === "hipped", building.roofAcross);
  }

  function ridgeRoof(rect, base, top, hipped, across) {
    let [a, b, c, d] = rect;
    const abIsLong = distance2d(a, b) >= distance2d(b, c);
    if (abIsLong === across) {
      [a, b, c, d] = [b, c, d, a];
    }

    const center = polygonCentroid(rect);
    let ridgeStart = midpoint(d, a);
    let ridgeEnd = midpoint(b, c);
    if (hipped) {
      const ridgeLength = distance2d(ridgeStart, ridgeEnd);
      const inset = Math.min(distance2d(a, d) / 2, ridgeLength * 0.45);
      const t = ridgeLength > 0 ? inset / ridgeLength : 0;
      const start = ridgeStart;
      ridgeStart = lerpPoint(start, ridgeEnd, t);
      ridgeEnd = lerpPoint(ridgeEnd, start, t);
    }

    const corner = (point) => [point[0], point[1], base];
    const ridge = (point) => [point[0], point[1], top];
    const roof = newMesh();
    const gable = newMesh();
    addQuad(roof, corner(a), corner(b), ridge(ridgeEnd), ridge(ridgeStart), "up", center);
    addQuad(roof, corner(c), corner(d), ridge(ridgeStart), ridge(ridgeEnd), "up", center);
    addTriangle(hipped ? roof : gable, corner(d), corner(a), ridge(ridgeStart), hipped ? "up" : "out", center);
    addTriangle(hipped ? roof : gable, corner(b), corner(c), ridge(ridgeEnd), hipped ? "up" : "out", center);
    return { roof, gable };
  }

  function pyramidRoof(outer, base, top, dome) {
    const center = polygonCentroid(outer);
    const profile = dome ? [[1, 0], [0.9, 0.42], [0.66, 0.75], [0.36, 0.94]] : [[1, 0]];
    const rings = profile.map(([radius, rise]) =>
      outer.map((point) => [
        center[0] + (point[0] - center[0]) * radius,
        center[1] + (point[1] - center[1]) * radius,
        base + (top - base) * rise,
      ])
    );
    const apex = [center[0], center[1], top];
    const roof = newMesh();

    rings.forEach((ring, level) => {
      const next = rings[level + 1];
      ring.forEach((point, index) => {
        const following = (index + 1) % ring.length;
        if (next) {
          addQuad(roof, point, ring[following], next[following], next[index], "up", center);
        } else {
          addTriangle(roof, point, ring[following], apex, "up", center);
        }
      });
    });
    return { roof, gable: newMesh() };
  }

  function skillionRoof(rect, base, top, direction) {
    let downhill;
    if (Number.isFinite(direction)) {
      const azimuth = (direction * Math.PI) / 180;
      downhill = [Math.sin(azimuth), Math.cos(azimuth)];
    } else {
      const longIsAB = distance2d(rect[0], rect[1]) >= distance2d(rect[1], rect[2]);
      const [p, q] = longIsAB ? [rect[0], rect[1]] : [rect[1], rect[2]];
      const length = distance2d(p, q) || 1;
      downhill = [-(q[1] - p[1]) / length, (q[0] - p[0]) / length];
    }

    const projections = rect.map((point) => point[0] * downhill[0] + point[1] * downhill[1]);
    const lowest = Math.min(...projections);
    const span = Math.max(...projections) - lowest || 1;
    const corners = rect.map((point, index) => [
      point[0],
      point[1],
      top - ((top - base) * (projections[index] - lowest)) / span,
    ]);
    const center = polygonCentroid(rect);
    const roof = newMesh();
    const gable = newMesh();

    addQuad(roof, corners[0], corners[1], corners[2], corners[3], "up", center);
    rect.forEach((point, index) => {
      const following = (index + 1) % rect.length;
      addQuad(
        gable,
        [point[0], point[1], base],
        [rect[following][0], rect[following][1], base],
        corners[following],
        corners[index],
        "out",
        center
      );
    });
    return { roof, gable };
  }

  function roofRectangle(outer) {
    if (outer.length === 4 && isConvex(outer)) {
      return outer;
    }
    const box = minimumAreaRectangle(outer);
    return box && Math.abs(polygonArea(outer)) / box.area > 0.82 ? box.corners : null;
  }

  function minimumAreaRectangle(points) {
    let best = null;
    points.forEach((a, index) => {
      const b = points[(index + 1) % points.length];
      const length = distance2d(a, b);
      if (length < 0.5) {
        return;
      }
      const ux = (b[0] - a[0]) / length;
      const uy = (b[1] - a[1]) / length;
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      points.forEach(([x, y]) => {
        const u = x * ux + y * uy;
        const v = -x * uy + y * ux;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      });
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        best = { area, ux, uy, minU, maxU, minV, maxV };
      }
    });
    if (!best || best.area <= 0) {
      return null;
    }
    const corner = (u, v) => [u * best.ux - v * best.uy, u * best.uy + v * best.ux];
    return {
      area: best.area,
      corners: [
        corner(best.minU, best.minV),
        corner(best.maxU, best.minV),
        corner(best.maxU, best.maxV),
        corner(best.minU, best.maxV),
      ],
    };
  }

  function newMesh() {
    return { positions: [], normals: [] };
  }

  function addQuad(mesh, a, b, c, d, facing, center) {
    addTriangle(mesh, a, b, c, facing, center);
    addTriangle(mesh, a, c, d, facing, center);
  }

  function addTriangle(mesh, a, b, c, facing, center) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-6) {
      return;
    }
    nx /= length;
    ny /= length;
    nz /= length;

    const outward = facing === "up"
      ? nz
      : nx * ((a[0] + b[0] + c[0]) / 3 - center[0]) + ny * ((a[1] + b[1] + c[1]) / 3 - center[1]);
    let second = b;
    let third = c;
    if (outward < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      second = c;
      third = b;
    }

    const normal = localNormalToFixed(nx, ny, nz);
    [a, second, third].forEach((vertex) => {
      const position = localToCartesian(vertex[0], vertex[1], vertex[2]);
      mesh.positions.push(position.x, position.y, position.z);
      mesh.normals.push(normal.x, normal.y, normal.z);
    });
  }

  function localNormalToFixed(x, y, z) {
    const Cesium = window.Cesium;
    if (!state.enuRotation) {
      const frame = Cesium.Transforms.eastNorthUpToFixedFrame(localToCartesian(0, 0, 0));
      state.enuRotation = Cesium.Matrix4.getMatrix3(frame, new Cesium.Matrix3());
    }
    return Cesium.Matrix3.multiplyByVector(state.enuRotation, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
  }

  function meshInstance(mesh, color) {
    const Cesium = window.Cesium;
    const positions = new Float64Array(mesh.positions);
    const vertexCount = positions.length / 3;
    const indices = vertexCount < 65536 ? new Uint16Array(vertexCount) : new Uint32Array(vertexCount);
    indices.forEach((_, index) => {
      indices[index] = index;
    });

    return new Cesium.GeometryInstance({
      geometry: new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: positions,
          }),
          normal: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: new Float32Array(mesh.normals),
          }),
        },
        indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
      }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  function addBatchedPrimitive(instances, options) {
    if (!instances.length) {
      return;
    }
    const Cesium = window.Cesium;
    const settings = { closed: true, asynchronous: true, shadows: Cesium.ShadowMode.DISABLED, ...options };
    state.viewer.scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: false,
          closed: settings.closed,
          fragmentShaderSource: SUNLIT_FRAGMENT_SHADER,
        }),
        asynchronous: settings.asynchronous,
        allowPicking: false,
        shadows: settings.shadows,
      })
    );
  }

  function addStreetFurniture() {
    const Cesium = window.Cesium;
    const format = Cesium.PerInstanceColorAppearance.VERTEX_FORMAT;
    const crownGeometry = new Cesium.EllipsoidGeometry({
      radii: new Cesium.Cartesian3(1, 1, 1),
      stackPartitions: 5,
      slicePartitions: 7,
      vertexFormat: format,
    });
    const cylinderGeometry = new Cesium.CylinderGeometry({ length: 1, topRadius: 0.5, bottomRadius: 0.5, slices: 6, vertexFormat: format });
    const boxGeometry = Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(1, 1, 1), vertexFormat: format });
    const ground = estimateGroundHeight();
    const treeRange = 650;
    const detailRange = 220;
    const cells = new Map();

    const trunkColor = Cesium.Color.fromCssColorString("#5f4630");
    state.world.trees.forEach(([x, y], index) => {
      const rng = mulberry32(hashString(`tree:${index}`));
      const height = 7 + rng() * 7;
      const radius = 2.2 + rng() * 2.1;
      const crownDepth = Math.min(radius * (1.05 + rng() * 0.35), height * 0.4);
      const trunkLength = Math.max(1.6, height - crownDepth * 1.4);
      const crownColor = Cesium.Color.fromCssColorString(TREE_PALETTE[Math.floor(rng() * TREE_PALETTE.length)]);
      const crownFrame = scaledFrame(x, y, ground + height - crownDepth, radius, radius, crownDepth);
      const trunkFrame = scaledFrame(x, y, ground + trunkLength / 2, 0.34, 0.34, trunkLength);
      pushToCell(cells, x, y, "crowns", colorInstance(crownGeometry, crownFrame, crownColor, treeRange));
      pushToCell(cells, x, y, "posts", colorInstance(cylinderGeometry, trunkFrame, trunkColor, treeRange));
    });

    const poleColor = Cesium.Color.fromCssColorString("#4f5961");
    const lampColor = Cesium.Color.fromCssColorString("#ffe3a6");
    state.world.lamps.forEach(([x, y], index) => {
      const height = 5 + (index % 3) * 0.5;
      pushToCell(cells, x, y, "posts", colorInstance(cylinderGeometry, scaledFrame(x, y, ground + height / 2, 0.16, 0.16, height), poleColor, detailRange));
      pushToCell(cells, x, y, "details", colorInstance(boxGeometry, scaledFrame(x, y, ground + height + 0.15, 0.45, 0.45, 0.3), lampColor, detailRange));
    });

    const woodColor = Cesium.Color.fromCssColorString("#6b4a30");
    const metalColor = Cesium.Color.fromCssColorString("#3a4044");
    state.world.benches.forEach(([x, y]) => {
      const street = nearestStreetPoint(x, y);
      const heading = street ? Math.atan2(street.b[0] - street.a[0], street.b[1] - street.a[1]) : 0;
      const away = street && street.distance > 0.01
        ? [(x - street.x) / street.distance, (y - street.y) / street.distance]
        : [Math.cos(heading), -Math.sin(heading)];
      const seat = rotatedFrame(x, y, ground + 0.45, heading, 0.45, 1.7, 0.06);
      const back = rotatedFrame(x + away[0] * 0.22, y + away[1] * 0.22, ground + 0.72, heading, 0.06, 1.7, 0.5);
      pushToCell(cells, x, y, "details", colorInstance(boxGeometry, seat, woodColor, detailRange));
      pushToCell(cells, x, y, "details", colorInstance(boxGeometry, back, metalColor, detailRange));
    });

    cells.forEach((cell) => {
      addBatchedPrimitive(cell.crowns || [], { shadows: Cesium.ShadowMode.ENABLED });
      addBatchedPrimitive(cell.posts || [], { shadows: Cesium.ShadowMode.CAST_ONLY });
      addBatchedPrimitive(cell.details || [], {});
    });
  }

  function colorInstance(geometry, modelMatrix, color, maxDistance) {
    const Cesium = window.Cesium;
    return new Cesium.GeometryInstance({
      geometry,
      modelMatrix,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
        distanceDisplayCondition: new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(0, maxDistance),
      },
    });
  }

  function scaledFrame(x, y, z, sx, sy, sz) {
    const Cesium = window.Cesium;
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(localToCartesian(x, y, z));
    return Cesium.Matrix4.multiplyByScale(frame, new Cesium.Cartesian3(sx, sy, sz), new Cesium.Matrix4());
  }

  function rotatedFrame(x, y, z, heading, sx, sy, sz) {
    const Cesium = window.Cesium;
    const frame = Cesium.Transforms.headingPitchRollToFixedFrame(
      localToCartesian(x, y, z),
      new Cesium.HeadingPitchRoll(heading, 0, 0)
    );
    return Cesium.Matrix4.multiplyByScale(frame, new Cesium.Cartesian3(sx, sy, sz), new Cesium.Matrix4());
  }

  function addLandmarks(forceVisible) {
    const Cesium = window.Cesium;
    const nearbyOnly = new Cesium.DistanceDisplayCondition(0, 320);

    state.landmarkEntities = state.world.landmarks.map((landmark) =>
      state.viewer.entities.add({
        position: localToCartesian(
          landmark.x,
          landmark.y,
          estimateGroundHeight() + 3.6
        ),
        point: {
          pixelSize: forceVisible ? 9 : 7,
          color: Cesium.Color.fromCssColorString("#f0cf87"),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: nearbyOnly,
          show: true,
        },
        label: {
          text: landmark.name,
          scale: forceVisible ? 0.58 : 0.5,
          font: "600 16px Segoe UI",
          fillColor: Cesium.Color.WHITE,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Cesium.Color.fromCssColorString("#071116"),
          outlineWidth: 4,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#0d151a").withAlpha(0.78),
          distanceDisplayCondition: nearbyOnly,
          show: true,
        },
      })
    );
  }

  function attachInput() {
    document.addEventListener("pointerlockchange", () => {
      state.pointerLocked = document.pointerLockElement === dom.cesiumContainer;
      updateHint();
    });

    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp, { passive: false });
    window.addEventListener("resize", () => {
      state.resizePending = true;
    });
  }

  function onMouseMove(event) {
    if (!state.pointerLocked || !state.started || state.inspectOpen || state.travelMenuOpen) {
      return;
    }

    state.player.heading = normalizeAngle(state.player.heading + event.movementX * 0.0024);
    state.player.pitch = clamp(state.player.pitch - event.movementY * 0.0018, -1.08, 0.48);
  }

  function attachTouchControls() {
    state.isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
    if (!state.isTouch) {
      return;
    }

    dom.touchMove.classList.remove("hidden");
    dom.touchActions.classList.remove("hidden");

    let moveTouchId = null;
    let lookTouchId = null;
    let lastLookX = 0;
    let lastLookY = 0;

    const padRadius = 40;

    function updatePad(touch) {
      const rect = dom.touchMove.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let dx = touch.clientX - centerX;
      let dy = touch.clientY - centerY;
      const dist = Math.hypot(dx, dy);
      if (dist > padRadius) {
        dx = (dx / dist) * padRadius;
        dy = (dy / dist) * padRadius;
      }
      state.touchMove.x = dx / padRadius;
      state.touchMove.y = dy / padRadius;
      dom.touchMoveKnob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    }

    dom.touchMove.addEventListener("touchstart", (event) => {
      if (moveTouchId !== null) return;
      const touch = event.changedTouches[0];
      moveTouchId = touch.identifier;
      updatePad(touch);
      event.preventDefault();
    }, { passive: false });

    dom.touchMove.addEventListener("touchmove", (event) => {
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === moveTouchId);
      if (!touch) return;
      updatePad(touch);
      event.preventDefault();
    }, { passive: false });

    const releasePad = (event) => {
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === moveTouchId);
      if (!touch) return;
      moveTouchId = null;
      state.touchMove.x = 0;
      state.touchMove.y = 0;
      dom.touchMoveKnob.style.transform = "translate(0px, 0px)";
    };
    dom.touchMove.addEventListener("touchend", releasePad);
    dom.touchMove.addEventListener("touchcancel", releasePad);

    dom.cesiumContainer.addEventListener("touchstart", (event) => {
      if (dom.touchMove.contains(event.target) || lookTouchId !== null) return;
      const touch = event.changedTouches[0];
      lookTouchId = touch.identifier;
      lastLookX = touch.clientX;
      lastLookY = touch.clientY;
    }, { passive: true });

    dom.cesiumContainer.addEventListener("touchmove", (event) => {
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === lookTouchId);
      if (!touch || !state.started || state.inspectOpen || state.travelMenuOpen) return;
      const dx = touch.clientX - lastLookX;
      const dy = touch.clientY - lastLookY;
      lastLookX = touch.clientX;
      lastLookY = touch.clientY;
      state.player.heading = normalizeAngle(state.player.heading + dx * 0.0045);
      state.player.pitch = clamp(state.player.pitch - dy * 0.0035, -1.08, 0.48);
    }, { passive: true });

    const releaseLook = (event) => {
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === lookTouchId);
      if (touch) lookTouchId = null;
    };
    dom.cesiumContainer.addEventListener("touchend", releaseLook);
    dom.cesiumContainer.addEventListener("touchcancel", releaseLook);
  }

  function onKeyDown(event) {
    const activeTag = document.activeElement && document.activeElement.tagName;
    const isFormControlFocused = activeTag === "INPUT" || activeTag === "SELECT" || activeTag === "TEXTAREA";
    if (isFormControlFocused && MOVEMENT_KEYS.has(event.code)) {
      return;
    }

    if (MOVEMENT_KEYS.has(event.code) || event.code === "Enter" || event.code === "KeyM") {
      event.preventDefault();
    }

    if (!state.started && (event.code === "Enter" || event.code === "Space")) {
      startExperience();
      return;
    }

    if (event.code === "KeyL") {
      toggleTravelMenu();
      return;
    }
    if (state.travelMenuOpen) {
      if (event.code === "ArrowDown") {
        state.travelIndex = (state.travelIndex + 1) % state.world.landmarks.length;
        highlightTravelIndex(state.travelIndex);
        event.preventDefault();
        return;
      }
      if (event.code === "ArrowUp") {
        state.travelIndex = (state.travelIndex - 1 + state.world.landmarks.length) % state.world.landmarks.length;
        highlightTravelIndex(state.travelIndex);
        event.preventDefault();
        return;
      }
      if (event.code === "Enter") {
        teleportToLandmark(state.travelIndex);
        return;
      }
    }

    if (event.code === "Enter") {
      state.inspectOpen ? closeInspect() : resetPlayerPose();
      return;
    }

    if (event.code === "KeyM") {
      toggleMap();
      return;
    }

    if (event.code === "KeyE") {
      if (!state.travelMenuOpen) {
        toggleInspect();
      }
      return;
    }

    if (event.code === "KeyF") {
      toggleFullscreen();
      return;
    }

    if (event.code === "KeyP") {
      capturePhoto();
      return;
    }

    if (event.code === "KeyR") {
      toggleRain();
      return;
    }

    if (event.code === "Escape") {
      if (state.inspectOpen) {
        closeInspect();
      } else if (state.mapOpen) {
        toggleMap(false);
      } else if (state.travelMenuOpen) {
        toggleTravelMenu(false);
      }
      return;
    }

    state.keys.add(event.code);
  }

  function onKeyUp(event) {
    state.keys.delete(event.code);
  }

  function startExperience() {
    unlockAudio();
    if (!state.ready) {
      return;
    }

    state.started = true;
    state.mode = "explore";
    dom.startPanel.classList.add("hidden");
    dom.appShell.classList.add("hud-visible");
    dom.cesiumContainer.focus();
    updateHint();
  }

  function unlockAudio() {
    if (!state.audio.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        state.audio.ctx = new AudioCtx();
        state.audio.gain = state.audio.ctx.createGain();
        state.audio.gain.gain.value = state.audio.muted ? 0 : 0.35;
        state.audio.gain.connect(state.audio.ctx.destination);
        state.audio.unlocked = true;
      }
    }
    if (state.audio.ctx && state.audio.ctx.state === "suspended") {
      state.audio.ctx.resume().catch(() => {});
    }
  }

  function playFootstep() {
    if (!state.audio.ctx || state.audio.muted) {
      return;
    }

    const ctx = state.audio.ctx;
    const bufferSize = Math.floor(ctx.sampleRate * 0.09);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900 + Math.random() * 300;

    source.connect(filter);
    filter.connect(state.audio.gain);
    source.start();
  }

  function requestPointerLock() {
    if (typeof dom.cesiumContainer.requestPointerLock === "function") {
      dom.cesiumContainer.requestPointerLock();
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      dom.appShell.requestFullscreen?.().catch(() => {});
      return;
    }

    document.exitFullscreen?.().catch(() => {});
  }

  function capturePhoto() {
    if (!state.viewer || !state.started) {
      return;
    }

    state.viewer.render();
    let dataUrl;
    try {
      dataUrl = state.viewer.canvas.toDataURL("image/png");
    } catch (error) {
      console.warn("Photo capture failed:", error);
      return;
    }

    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `karlsruhe-walk-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    dom.photoFlash.classList.add("active");
    setTimeout(() => dom.photoFlash.classList.remove("active"), 140);
  }

  function toggleMap(forceValue) {
    state.mapOpen = typeof forceValue === "boolean" ? forceValue : !state.mapOpen;
    dom.mapPanel.classList.toggle("hidden", !state.mapOpen);
    updateHint();
    announce(state.mapOpen ? "Karte geöffnet." : "Karte geschlossen.");
  }

  function toggleRain(forceValue) {
    state.weather.active = typeof forceValue === "boolean" ? forceValue : !state.weather.active;
    dom.weatherCanvas.classList.toggle("active", state.weather.active);
    if (state.weather.active && !state.weather.ctx) {
      initRain();
    }
  }

  function initRain() {
    dom.weatherCanvas.width = window.innerWidth;
    dom.weatherCanvas.height = window.innerHeight;
    state.weather.ctx = dom.weatherCanvas.getContext("2d");
    state.weather.drops = [];
    for (let i = 0; i < 220; i += 1) {
      state.weather.drops.push({
        x: Math.random() * dom.weatherCanvas.width,
        y: Math.random() * dom.weatherCanvas.height,
        length: 10 + Math.random() * 14,
        speed: 380 + Math.random() * 260,
        drift: -30 + Math.random() * 60,
      });
    }
    window.addEventListener("resize", () => {
      if (state.weather.active) {
        dom.weatherCanvas.width = window.innerWidth;
        dom.weatherCanvas.height = window.innerHeight;
      }
    });
  }

  function updateRain(deltaSeconds) {
    if (!state.weather.active || !state.weather.ctx) {
      return;
    }
    const canvas = dom.weatherCanvas;
    const ctx = state.weather.ctx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(214, 232, 255, 0.55)";
    ctx.lineWidth = 1;
    state.weather.drops.forEach((drop) => {
      drop.y += drop.speed * deltaSeconds;
      drop.x += drop.drift * deltaSeconds;
      if (drop.y > canvas.height) {
        drop.y = -drop.length;
        drop.x = Math.random() * canvas.width;
      }
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x + drop.drift * 0.03, drop.y + drop.length);
      ctx.stroke();
    });
  }

  function toggleInspect() {
    if (!state.activeLandmark || state.activeLandmark.distance > state.activeLandmark.radius + 36) {
      return;
    }

    state.inspectOpen = !state.inspectOpen;
    dom.inspectPanel.classList.toggle("hidden", !state.inspectOpen);

    if (state.inspectOpen) {
      dom.inspectTitle.textContent = state.activeLandmark.name;
      dom.inspectBody.textContent = state.activeLandmark.description;
      state.mode = "inspect";
      dom.inspectPanel.focus();
    } else {
      state.mode = "explore";
      dom.cesiumContainer.focus();
    }

    updateHint();
    announce(state.inspectOpen ? `Landmarke geöffnet: ${state.activeLandmark.name}.` : "Landmarke geschlossen.");
  }

  function closeInspect() {
    state.inspectOpen = false;
    dom.inspectPanel.classList.add("hidden");
    dom.cesiumContainer.focus();
    state.mode = state.started ? "explore" : "ready";
    updateHint();
  }

  function buildTravelList() {
    dom.travelList.textContent = "";
    state.world.landmarks.forEach((landmark, index) => {
      const item = document.createElement("li");
      item.textContent = landmark.name;
      item.addEventListener("click", () => teleportToLandmark(index));
      dom.travelList.appendChild(item);
    });
  }

  function toggleTravelMenu(forceValue) {
    state.travelMenuOpen = typeof forceValue === "boolean" ? forceValue : !state.travelMenuOpen;
    dom.travelPanel.classList.toggle("hidden", !state.travelMenuOpen);
    if (state.travelMenuOpen) {
      highlightTravelIndex(state.travelIndex);
    }
    updateHint();
  }

  function highlightTravelIndex(index) {
    dom.travelList.querySelectorAll("li").forEach((item, itemIndex) => {
      item.classList.toggle("active", itemIndex === index);
    });
  }

  function teleportToLandmark(index) {
    const landmark = state.world.landmarks[index];
    if (!landmark) {
      return;
    }
    const [targetX, targetY] = landmark.view || [landmark.x, landmark.y];
    const spot = findWalkableNear(targetX, targetY);
    if (!spot) {
      return;
    }
    state.player.x = spot.x;
    state.player.y = spot.y;
    if (Math.hypot(landmark.x - spot.x, landmark.y - spot.y) > 1) {
      state.player.heading = normalizeAngle(Math.atan2(landmark.x - spot.x, landmark.y - spot.y));
    }
    state.player.groundHeight = estimateGroundHeight();
    state.player.speedMps = 0;
    state.player.moveSpeed = 0;
    updateWorldState();
    updateCamera();
    toggleTravelMenu(false);
  }

  function resetPlayerPose() {
    const spawn = findWalkableNear(DEFAULT_POSE.x, DEFAULT_POSE.y) || DEFAULT_POSE;
    state.player.x = spawn.x;
    state.player.y = spawn.y;
    state.player.heading = DEFAULT_POSE.heading;
    state.player.pitch = DEFAULT_POSE.pitch;
    state.player.speedMps = 0;
    state.player.moveSpeed = 0;
    state.player.bobPhase = 0;
    state.player.groundHeight = estimateGroundHeight();
    state.mapOpen = false;
    state.inspectOpen = false;
    state.moveBlocked = false;
    dom.mapPanel.classList.add("hidden");
    dom.inspectPanel.classList.add("hidden");
    state.mode = state.started ? "explore" : "ready";
    updateWorldState();
    updateCamera();
    renderScene();
  }

  function applySharedPositionIfPresent() {
    const match = /^#pos=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(location.hash);
    if (!match) return;
    const x = Number(match[1]);
    const y = Number(match[2]);
    const headingDeg = Number(match[3]);
    const pitchDeg = Number(match[4]);
    if (![x, y, headingDeg, pitchDeg].every(Number.isFinite)) return;
    const spot = findWalkableNear(x, y);
    if (!spot) {
      console.warn("Shared position is outside the walkable area, ignoring URL hash.");
      return;
    }
    state.player.x = spot.x;
    state.player.y = spot.y;
    state.player.heading = normalizeAngle((headingDeg * Math.PI) / 180);
    state.player.pitch = clamp((pitchDeg * Math.PI) / 180, -1.08, 0.48);
    state.player.groundHeight = estimateGroundHeight();
    updateWorldState();
    updateCamera();
  }

  function startLoop() {
    cancelAnimationFrame(state.frameHandle);
    state.lastFrameTime = performance.now();

    const frame = (timestamp) => {
      const realDelta = (timestamp - state.lastFrameTime) / 1000 || 0.016;
      state.lastFrameTime = timestamp;
      adaptShadowQuality(realDelta);
      step(Math.min(0.05, realDelta));
      renderScene();
      state.frameHandle = requestAnimationFrame(frame);
    };

    state.frameHandle = requestAnimationFrame(frame);
  }

  function adaptShadowQuality(realDelta) {
    if (!state.started || !state.viewer.shadows) {
      return;
    }
    state.frameTimeAverage = state.frameTimeAverage ? state.frameTimeAverage * 0.95 + realDelta * 0.05 : realDelta;
    state.slowSeconds = state.frameTimeAverage > 1 / 24 ? state.slowSeconds + realDelta : 0;
    if (state.slowSeconds > 4) {
      state.viewer.shadows = false;
      console.info("Frame rate below 24 fps, shadows switched off.");
    }
  }

  function step(deltaSeconds) {
    state.time += deltaSeconds;
    trackFps(deltaSeconds);
    updateRain(deltaSeconds);

    if (!state.ready || !state.started || state.inspectOpen || state.mapOpen || state.travelMenuOpen) {
      state.player.speedMps = 0;
      updateWorldState();
      return;
    }

    const intent = getIntent();
    state.player.heading = normalizeAngle(state.player.heading + intent.turn * 1.65 * deltaSeconds);
    state.player.pitch = clamp(state.player.pitch + intent.pitch * 1.1 * deltaSeconds, -1.08, 0.48);

    const moveLength = Math.hypot(intent.move.x, intent.move.y);
    const targetSpeed = moveLength > 0 ? (intent.sprint ? 5.3 : 2.45) : 0;
    const rate = targetSpeed > state.player.moveSpeed ? 8 : 13;
    state.player.moveSpeed = approachValue(state.player.moveSpeed, targetSpeed, rate * deltaSeconds);
    let traveled = 0;

    if (moveLength > 0) {
      state.player.lastMoveDir = { x: intent.move.x / moveLength, y: intent.move.y / moveLength };
    }

    if (state.player.moveSpeed > 0.001) {
      const dx = state.player.lastMoveDir.x * state.player.moveSpeed * deltaSeconds;
      const dy = state.player.lastMoveDir.y * state.player.moveSpeed * deltaSeconds;
      const proposedX = clamp(
        state.player.x + dx,
        state.world.bounds.minX,
        state.world.bounds.maxX
      );
      const proposedY = clamp(
        state.player.y + dy,
        state.world.bounds.minY,
        state.world.bounds.maxY
      );
      const resolved = resolveWalkMove(state.player.x, state.player.y, proposedX, proposedY);
      traveled = Math.hypot(resolved.x - state.player.x, resolved.y - state.player.y);
      state.player.x = resolved.x;
      state.player.y = resolved.y;
      state.moveBlocked = resolved.blocked && traveled < 1e-3;
      if (state.moveBlocked) {
        state.player.moveSpeed = 0;
      }
    } else {
      state.moveBlocked = false;
    }

    if (state.moveBlocked && !state.announcedBlocked) {
      announce("Hier geht es nicht weiter.");
    }
    state.announcedBlocked = state.moveBlocked;

    state.player.bobPhase += traveled * 1.7;
    state.player.speedMps = deltaSeconds > 0 ? traveled / deltaSeconds : 0;
    if (traveled > 0 && !state.moveBlocked) {
      state.audio.distanceSinceStep = (state.audio.distanceSinceStep || 0) + traveled;
      if (state.audio.distanceSinceStep >= 0.72) {
        state.audio.distanceSinceStep -= 0.72;
        playFootstep();
      }
    }
    updateGroundHeight();
    updateWorldState();
    updateCamera();
    if (state.time - state.lastHashUpdateAt > 1) {
      state.lastHashUpdateAt = state.time;
      const headingDeg = Math.round(toDeg(state.player.heading));
      const pitchDeg = Math.round(toDeg(state.player.pitch));
      const hash = `#pos=${state.player.x.toFixed(1)},${state.player.y.toFixed(1)},${headingDeg},${pitchDeg}`;
      history.replaceState(null, "", hash);
    }
  }

  function getIntent() {
    const keyForward =
      (state.keys.has("KeyW") || state.keys.has("ArrowUp") ? 1 : 0) -
      (state.keys.has("KeyS") || state.keys.has("ArrowDown") ? 1 : 0);
    const keyStrafe =
      (state.keys.has("KeyD") || state.keys.has("KeyB") ? 1 : 0) -
      (state.keys.has("KeyA") ? 1 : 0);
    const forward = clamp(keyForward - state.touchMove.y, -1, 1);
    const strafe = clamp(keyStrafe + state.touchMove.x, -1, 1);
    const turn =
      (state.keys.has("ArrowRight") ? 1 : 0) -
      (state.keys.has("ArrowLeft") ? 1 : 0);
    const pitchIntent = (state.keys.has("KeyQ") ? 1 : 0) - (state.keys.has("KeyZ") ? 1 : 0);
    const forwardVector = { x: Math.sin(state.player.heading), y: Math.cos(state.player.heading) };
    const rightVector = { x: Math.cos(state.player.heading), y: -Math.sin(state.player.heading) };

    return {
      turn,
      pitch: pitchIntent,
      sprint: state.keys.has("ShiftLeft") || state.keys.has("ShiftRight") || state.keys.has("Space"),
      move: {
        x: forwardVector.x * forward + rightVector.x * strafe,
        y: forwardVector.y * forward + rightVector.y * strafe,
      },
    };
  }

  function resolveWalkMove(fromX, fromY, toX, toY) {
    if (isWalkable(toX, toY)) {
      return { x: toX, y: toY, blocked: false };
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 8; i += 1) {
      const mid = (lo + hi) / 2;
      const mx = fromX + (toX - fromX) * mid;
      const my = fromY + (toY - fromY) * mid;
      if (isWalkable(mx, my)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const clippedX = fromX + (toX - fromX) * lo;
    const clippedY = fromY + (toY - fromY) * lo;

    if (isWalkable(toX, clippedY)) {
      return { x: toX, y: clippedY, blocked: true };
    }
    if (isWalkable(clippedX, toY)) {
      return { x: clippedX, y: toY, blocked: true };
    }
    // Facades are rarely axis-aligned, so also try sliding at an angle to the wall.
    const dx = toX - fromX;
    const dy = toY - fromY;
    for (const angle of [0.6, -0.6, 1.1, -1.1]) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const slideX = fromX + (dx * cos - dy * sin) * cos;
      const slideY = fromY + (dx * sin + dy * cos) * cos;
      if (isWalkable(slideX, slideY)) {
        return { x: slideX, y: slideY, blocked: true };
      }
    }
    if (lo > 0) {
      return { x: clippedX, y: clippedY, blocked: true };
    }
    return { x: fromX, y: fromY, blocked: true };
  }

  function updateGroundHeight() {
    state.player.groundHeight = estimateGroundHeight();
  }

  function updateWorldState() {
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    state.world.landmarks.forEach((landmark) => {
      const distance = Math.hypot(landmark.x - state.player.x, landmark.y - state.player.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = { ...landmark, distance };
      }
    });

    state.activeLandmark = nearest;
    if (nearest && nearest.distance <= nearest.radius + 36) {
      if (nearest.id !== state.announcedLandmarkId) {
        announce(`In der Nähe: ${nearest.name}. Taste E öffnet Details.`);
        state.announcedLandmarkId = nearest.id;
      }
    } else {
      state.announcedLandmarkId = null;
    }
    const last = state.lastAreaPoint;
    if (!last || Math.hypot(state.player.x - last.x, state.player.y - last.y) > 2) {
      state.currentArea = areaNameAt(state.player.x, state.player.y);
      state.lastAreaPoint = { x: state.player.x, y: state.player.y };
    }
  }

  function areaNameAt(x, y) {
    const area = state.world.areas.find(
      (candidate) =>
        x >= candidate.bounds.minX &&
        x <= candidate.bounds.maxX &&
        y >= candidate.bounds.minY &&
        y <= candidate.bounds.maxY &&
        pointInPolygon(x, y, candidate.points)
    );
    if (area) {
      return area.name;
    }
    const street = nearestStreetPoint(x, y);
    return street && street.distance < 28 ? street.name : "Karlsruher Innenstadt";
  }

  function nearestStreetPoint(x, y) {
    let best = null;
    state.world.streets.forEach((street) => {
      for (let index = 1; index < street.points.length; index += 1) {
        const a = street.points[index - 1];
        const b = street.points[index];
        const closest = closestPointOnSegment(x, y, a, b);
        if (!best || closest.distance < best.distance) {
          best = { ...closest, a, b, name: street.name };
        }
      }
    });
    return best;
  }

  function updateCamera() {
    if (!state.viewer) {
      return;
    }

    const bobAmount = clamp(state.player.speedMps / 5.3, 0, 1);
    const bobVertical = Math.sin(state.player.bobPhase * 2) * 0.045 * bobAmount;
    const bobLateral = Math.sin(state.player.bobPhase) * 0.03 * bobAmount;
    const right = { x: Math.cos(state.player.heading), y: -Math.sin(state.player.heading) };

    state.viewer.camera.setView({
      destination: localToCartesian(
        state.player.x + right.x * bobLateral,
        state.player.y + right.y * bobLateral,
        state.player.groundHeight + state.player.eyeHeight + bobVertical
      ),
      orientation: {
        heading: state.player.heading,
        pitch: state.player.pitch,
        roll: 0,
      },
    });
  }

  function renderScene() {
    if (!state.viewer) {
      return;
    }

    if (state.resizePending) {
      state.viewer.resize();
      state.resizePending = false;
    }
    state.viewer.render();
    updateHud();
  }

  function updateHud() {
    dom.areaName.textContent = state.currentArea;
    dom.landmarkName.textContent = state.activeLandmark ? state.activeLandmark.name : "Keine Landmarke im Fokus";
    dom.landmarkDistance.textContent = state.activeLandmark
      ? `${formatMeters(state.activeLandmark.distance)} entfernt`
      : "0 m";
    dom.qualityMode.textContent = qualityLabel();
    dom.headingText.textContent = `${headingLabel(state.player.heading)} · ${Math.round(toDeg(state.player.heading))}deg`;
    dom.speedText.textContent = `${state.player.speedMps.toFixed(1)} m/s`;
    dom.headingText.textContent = `${headingLabel(state.player.heading)} | ${Math.round(toDeg(state.player.heading))}deg`;
    dom.walkStatus.textContent = state.moveBlocked
      ? "Hindernis"
      : state.started
        ? state.player.speedMps > 0.05
          ? "läuft"
          : "steht"
        : "bereit";

    if (state.inspectOpen && state.activeLandmark) {
      dom.inspectTitle.textContent = state.activeLandmark.name;
      dom.inspectBody.textContent = state.activeLandmark.description;
    }
    dom.infoBtn.disabled = !state.inspectOpen && !landmarkInReach();
    dom.appShell.classList.toggle("overlay-open", state.mapOpen || state.travelMenuOpen || state.inspectOpen);

    updateHint();
    updateMiniMap();
  }

  function landmarkInReach() {
    return Boolean(state.activeLandmark && state.activeLandmark.distance <= state.activeLandmark.radius + 36);
  }

  function qualityLabel() {
    if (state.qualityMode === "local" && !state.useOrthophoto) {
      return QUALITY.localGround;
    }
    return QUALITY[state.qualityMode] || state.qualityMode;
  }

  function updateHint() {
    const hints = [];

    if (!state.started) {
      hints.push(state.isTouch ? "Tippe auf „Karlsruhe betreten“." : "Klick auf Start oder drücke Enter.");
    } else if (state.inspectOpen) {
      hints.push(state.isTouch ? "Tippe auf Info zum Schließen." : "E oder Escape schließt die Landmarke. Enter setzt den Startpunkt neu.");
    } else if (state.travelMenuOpen) {
      hints.push(state.isTouch ? "Tippe auf ein Ziel." : "Pfeil hoch runter wählt, Enter springt zur Landmarke, L oder Escape schließt.");
    } else if (state.isTouch) {
      hints.push("Linker Kreis: laufen. Rechts wischen: umsehen.");
      if (landmarkInReach()) {
        hints.push(`Info zeigt ${state.activeLandmark.name}.`);
      }
      if (state.moveBlocked) {
        hints.push("Hier geht es nicht weiter.");
      }
    } else {
      hints.push(state.pointerLocked ? "Mausblick aktiv." : "Klicke in die Szene für Mausblick.");
      hints.push("Pfeiltasten drehen oder laufen, W A S D für freie Schritte, Space sprintet.");
      hints.push("L öffnet die Ziel-Liste.");
      if (landmarkInReach()) {
        hints.push(`E öffnet ${state.activeLandmark.name}.`);
      }
      if (state.moveBlocked) {
        hints.push("Hier geht es nicht weiter.");
      }
      hints.push("R schaltet Regen ein/aus.");
      hints.push("P speichert ein Foto.");
    }

    dom.hintText.textContent = hints.join(" ");
  }

  function updateMuteButton() {
    dom.muteBtn.textContent = state.audio.muted ? "Ton aus" : "Ton an";
    dom.muteBtn.setAttribute("aria-pressed", state.audio.muted ? "true" : "false");
  }

  function announce(text) {
    if (!dom.srStatus || dom.srStatus.textContent === text) return;
    dom.srStatus.textContent = text;
  }

  function buildMiniMap() {
    dom.mapBuildings.textContent = "";
    dom.mapLandmarks.textContent = "";
    dom.mapPlayer.textContent = "";

    const footprints = document.createElementNS(svgNs, "path");
    footprints.setAttribute(
      "d",
      state.world.buildings
        .filter((building) => building.blocking)
        .map((building) => svgPath(building.outer))
        .join(" ")
    );
    dom.mapBuildings.appendChild(footprints);

    state.world.landmarks.forEach((landmark) => {
      const group = document.createElementNS(svgNs, "g");
      const circle = document.createElementNS(svgNs, "circle");
      const label = document.createElementNS(svgNs, "text");
      const point = mapPoint(landmark.x, landmark.y);

      circle.setAttribute("cx", point.x.toFixed(2));
      circle.setAttribute("cy", point.y.toFixed(2));
      circle.setAttribute("r", "3.4");
      label.setAttribute("x", (point.x + 6).toFixed(2));
      label.setAttribute("y", (point.y - 4).toFixed(2));
      label.textContent = landmark.name.replace("Karlsruher ", "").replace(" mit Pyramide", "");

      group.appendChild(circle);
      group.appendChild(label);
      dom.mapLandmarks.appendChild(group);
    });

    state.mapPlayer = document.createElementNS(svgNs, "path");
    state.mapPlayer.setAttribute("d", "M 0 -11 L 7 10 L 0 5 L -7 10 Z");
    dom.mapPlayer.appendChild(state.mapPlayer);
  }

  function updateMiniMap() {
    if (!state.mapPlayer) {
      return;
    }

    const point = mapPoint(state.player.x, state.player.y);
    state.mapPlayer.setAttribute(
      "transform",
      `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) rotate(${toDeg(state.player.heading).toFixed(2)})`
    );
  }

  function svgPath(points) {
    return points
      .map((point, index) => {
        const projected = mapPoint(point[0], point[1]);
        return `${index === 0 ? "M" : "L"}${projected.x.toFixed(1)} ${projected.y.toFixed(1)}`;
      })
      .concat("Z")
      .join("");
  }

  function mapPoint(x, y) {
    const bounds = state.world.bounds;
    const pad = 12;
    const size = 280 - pad * 2;
    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;
    const scale = size / Math.max(spanX, spanY);
    const offsetX = pad + (size - spanX * scale) / 2;
    const offsetY = pad + (size - spanY * scale) / 2;

    return { x: offsetX + (x - bounds.minX) * scale, y: offsetY + (bounds.maxY - y) * scale };
  }

  function localToDegrees(x, y, height) {
    return {
      lon: state.world.origin.lon + x / state.world.origin.metersPerLon,
      lat: state.world.origin.lat + y / state.world.origin.metersPerLat,
      height,
    };
  }

  function localToCartesian(x, y, height) {
    const Cesium = window.Cesium;
    const coords = localToDegrees(x, y, height);
    return Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat, coords.height);
  }

  function polygonHierarchy(points) {
    const Cesium = window.Cesium;
    return new Cesium.PolygonHierarchy(
      points.map((point) => {
        const coords = localToDegrees(point[0], point[1], state.world.origin.baseHeight);
        return Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat, coords.height);
      })
    );
  }

  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i][0];
      const yi = points[i][1];
      const xj = points[j][0];
      const yj = points[j][1];
      const intersects =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  function buildCollisionIndex(buildings) {
    const index = { cells: new Map() };
    buildings.forEach((building) => {
      if (building.blocking) {
        registerCollisionEntry(index, building.bounds, building);
      }
    });
    return index;
  }

  function addCollisionCircle(x, y, radius) {
    registerCollisionEntry(
      state.collision,
      { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius },
      { x, y, radius }
    );
  }

  function registerCollisionEntry(index, bounds, entry) {
    const minCellX = Math.floor((bounds.minX - PLAYER_RADIUS) / COLLISION_CELL);
    const maxCellX = Math.floor((bounds.maxX + PLAYER_RADIUS) / COLLISION_CELL);
    const minCellY = Math.floor((bounds.minY - PLAYER_RADIUS) / COLLISION_CELL);
    const maxCellY = Math.floor((bounds.maxY + PLAYER_RADIUS) / COLLISION_CELL);
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        const key = collisionKey(cellX, cellY);
        const list = index.cells.get(key);
        if (list) {
          list.push(entry);
        } else {
          index.cells.set(key, [entry]);
        }
      }
    }
  }

  function collisionKey(cellX, cellY) {
    return (cellX + 4096) * 8192 + (cellY + 4096);
  }

  function collisionEntriesAt(x, y) {
    return state.collision.cells.get(collisionKey(Math.floor(x / COLLISION_CELL), Math.floor(y / COLLISION_CELL))) || [];
  }

  function isWalkable(x, y) {
    const bounds = state.world.bounds;
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      return false;
    }
    return collisionEntriesAt(x, y).every((entry) => {
      if (entry.radius !== undefined) {
        return Math.hypot(x - entry.x, y - entry.y) >= entry.radius + PLAYER_RADIUS;
      }
      const b = entry.bounds;
      if (x < b.minX - PLAYER_RADIUS || x > b.maxX + PLAYER_RADIUS || y < b.minY - PLAYER_RADIUS || y > b.maxY + PLAYER_RADIUS) {
        return true;
      }
      return (
        !insideFootprint(x, y, entry) &&
        ringDistance(x, y, entry.outer) >= PLAYER_RADIUS &&
        entry.holes.every((hole) => ringDistance(x, y, hole) >= PLAYER_RADIUS)
      );
    });
  }

  function insideBuildingFootprint(x, y) {
    return collisionEntriesAt(x, y).some((entry) => entry.outer && insideFootprint(x, y, entry));
  }

  function insideFootprint(x, y, building) {
    return pointInPolygon(x, y, building.outer) && !building.holes.some((hole) => pointInPolygon(x, y, hole));
  }

  function ringDistance(x, y, ring) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      best = Math.min(best, closestPointOnSegment(x, y, ring[j], ring[i]).distance);
    }
    return best;
  }

  function findWalkableNear(x, y) {
    if (isWalkable(x, y)) {
      return { x, y };
    }
    for (let radius = 1.5; radius <= 150; radius += 1.5) {
      const steps = Math.max(12, Math.round(radius * 2));
      for (let step = 0; step < steps; step += 1) {
        const angle = (step / steps) * Math.PI * 2;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (isWalkable(px, py)) {
          return { x: px, y: py };
        }
      }
    }
    return null;
  }

  function closestPointOnSegment(x, y, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared, 0, 1) : 0;
    const px = a[0] + dx * t;
    const py = a[1] + dy * t;
    return { x: px, y: py, distance: Math.hypot(x - px, y - py) };
  }

  function isConvex(points) {
    let sign = 0;
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const c = points[(index + 2) % points.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-9) {
        continue;
      }
      if (sign === 0) {
        sign = Math.sign(cross);
      } else if (Math.sign(cross) !== sign) {
        return false;
      }
    }
    return true;
  }

  function polygonArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
    }
    return area / 2;
  }

  function polygonCentroid(points) {
    const area = polygonArea(points);
    if (Math.abs(area) < 1e-6) {
      const sum = points.reduce((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
      return [sum[0] / points.length, sum[1] / points.length];
    }
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const factor = points[j][0] * points[i][1] - points[i][0] * points[j][1];
      cx += (points[j][0] + points[i][0]) * factor;
      cy += (points[j][1] + points[i][1]) * factor;
    }
    return [cx / (6 * area), cy / (6 * area)];
  }

  function distance2d(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  function midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function lerpPoint(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function estimateGroundHeight() {
    return state.world.origin.baseHeight;
  }

  function createGroundTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return canvas;
    }

    const rng = mulberry32(hashString("ground"));
    const base = hexToRgb("#6c6a65");
    ctx.fillStyle = rgbToCss(base);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawPaverTexture(ctx, canvas, rng, base);
    drawNoise(ctx, canvas, rng, 0.06, "#ffffff");
    return canvas;
  }

  function drawPaverTexture(ctx, canvas, rng, base) {
    const size = 30;
    for (let y = 0; y < canvas.height; y += size) {
      for (let x = 0; x < canvas.width; x += size) {
        const tone = rng() * 0.14 - 0.07;
        ctx.fillStyle = rgbToCss(tintColor(base, tone), 0.92);
        const w = size - 1 + Math.floor(rng() * 2);
        const h = size - 1 + Math.floor(rng() * 2);
        ctx.fillRect(x + Math.floor(rng() * 2), y + Math.floor(rng() * 2), w, h);
      }
    }

    ctx.fillStyle = "rgba(255, 246, 220, 0.08)";
    ctx.fillRect(0, canvas.height * 0.45, canvas.width, 5);
    ctx.fillRect(canvas.width * 0.5, 0, 5, canvas.height);
    ctx.fillStyle = "rgba(40, 43, 46, 0.06)";
    ctx.fillRect(0, canvas.height * 0.22, canvas.width, 2);
    ctx.fillRect(0, canvas.height * 0.73, canvas.width, 2);
  }

  function drawNoise(ctx, canvas, rng, strength, color) {
    const baseAlpha = Math.max(0.025, strength * 0.4);
    for (let i = 0; i < Math.floor(canvas.width * canvas.height * strength * 0.035); i += 1) {
      const x = Math.floor(rng() * canvas.width);
      const y = Math.floor(rng() * canvas.height);
      ctx.fillStyle = color === "#ffffff"
        ? `rgba(255,255,255,${baseAlpha * rng()})`
        : `rgba(0,0,0,${baseAlpha * rng()})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  function polygonBounds(points) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    points.forEach((point) => {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    });

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hexToRgb(hex) {
    const value = String(hex || "#808080").replace("#", "");
    const normalized = value.length === 3
      ? value.split("").map((part) => part + part).join("")
      : value.padEnd(6, "0").slice(0, 6);
    const int = Number.parseInt(normalized, 16);
    return {
      r: (int >> 16) & 255,
      g: (int >> 8) & 255,
      b: int & 255,
    };
  }

  function tintColor(color, amount) {
    const factor = amount < 0 ? 1 + amount : 1 + amount;
    return {
      r: clampByte(color.r * factor + (amount > 0 ? 255 * amount * 0.2 : 0)),
      g: clampByte(color.g * factor + (amount > 0 ? 255 * amount * 0.2 : 0)),
      b: clampByte(color.b * factor + (amount > 0 ? 255 * amount * 0.2 : 0)),
    };
  }

  function rgbToCss(color, alpha = 1) {
    return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${alpha})`;
  }

  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  function renderGameToText() {
    const coords = localToDegrees(state.player.x, state.player.y, 0);
    return JSON.stringify(
      {
        mode: state.mode,
        qualityMode: state.qualityMode,
        coordinates: {
          origin: "local meters relative to Karlsruhe Schloss axis start",
          axes: "x east-west positive east, y north-south positive north",
        },
        player: {
          x: round(state.player.x, 2),
          y: round(state.player.y, 2),
          lon: round(coords.lon, 6),
          lat: round(coords.lat, 6),
          headingDeg: round(toDeg(state.player.heading), 1),
          pitchDeg: round(toDeg(state.player.pitch), 1),
          groundHeight: round(state.player.groundHeight, 2),
          eyeHeight: state.player.eyeHeight,
          speedMps: round(state.player.speedMps, 2),
        },
        area: state.currentArea,
        landmark: state.activeLandmark
          ? {
              name: state.activeLandmark.name,
              distanceM: round(state.activeLandmark.distance, 1),
              readable: state.activeLandmark.distance <= state.activeLandmark.radius + 36,
            }
          : null,
        walkMesh: {
          inside: isWalkable(state.player.x, state.player.y),
          blockedLastMove: state.moveBlocked,
        },
        toggles: {
          pointerLocked: state.pointerLocked,
          mapOpen: state.mapOpen,
          inspectOpen: state.inspectOpen,
          travelMenuOpen: state.travelMenuOpen,
        },
        fps: round(state.fps, 1),
      },
      null,
      2
    );
  }

  async function advanceTime(milliseconds) {
    const frames = Math.max(1, Math.round(milliseconds / (1000 / 60)));
    for (let index = 0; index < frames; index += 1) {
      step(1 / 60);
    }
    renderScene();
  }

  function trackFps(deltaSeconds) {
    state.fpsFrames += 1;
    state.fpsTimer += deltaSeconds;
    if (state.fpsTimer >= 0.35) {
      state.fps = state.fpsFrames / state.fpsTimer;
      state.fpsFrames = 0;
      state.fpsTimer = 0;
    }
  }

  function updateSourceNote() {
    const osmLink = document.createElement("a");
    osmLink.href = "https://www.openstreetmap.org/copyright";
    osmLink.target = "_blank";
    osmLink.rel = "noopener";
    osmLink.textContent = "© OpenStreetMap-Mitwirkende";
    dom.sourceNote.replaceChildren(
      "Daten: ",
      osmLink,
      state.useOrthophoto ? " (ODbL) · Luftbilder: LGL Baden-Württemberg" : " (ODbL)"
    );
    if (state.qualityError) {
      dom.sourceNote.append(` · ${state.qualityError}`);
    }
  }

  function setBootStatus(text) {
    dom.bootStatus.textContent = text;
  }

  function isWebglAvailable() {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
    } catch (error) {
      return false;
    }
  }

  function failBoot(text, hint) {
    state.mode = "error";
    dom.appShell.classList.add("hud-visible");
    state.qualityMode = "error";
    dom.startBtn.disabled = true;
    setBootStatus(text);
    dom.areaName.textContent = "Szene fehlgeschlagen";
    dom.landmarkName.textContent = text;
    dom.qualityMode.textContent = QUALITY.error;
    dom.walkStatus.textContent = "Fehler";
    dom.hintText.textContent = hint || "Prüfe WebGL oder lokale Dateien und lade die Seite neu.";
  }

  function headingLabel(radians) {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return directions[Math.round(toDeg(normalizeAngle(radians)) / 45) % directions.length];
  }

  function shortError(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (error.message) return String(error.message).split("\n")[0];
    return String(error);
  }

  function formatMeters(value) {
    if (!Number.isFinite(value)) return "0 m";
    return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    return response.json();
  }

  function normalizeAngle(value) {
    const full = Math.PI * 2;
    let next = value % full;
    if (next < 0) next += full;
    return next;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function round(value, precision) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
  }

  function toDeg(value) {
    return (value * 180) / Math.PI;
  }

  function approachValue(current, target, maxDelta) {
    if (current < target) return Math.min(current + maxDelta, target);
    if (current > target) return Math.max(current - maxDelta, target);
    return current;
  }
})();
