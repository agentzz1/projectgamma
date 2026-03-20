(function () {
  "use strict";

  const QUALITY = {
    boot: "Booting",
    local: "LGL orthophoto + local 3D",
    error: "Scene error",
  };

  const DEFAULT_POSE = { x: 0, y: -205, heading: Math.PI, pitch: -0.05 };
  const MOVEMENT_KEYS = new Set([
    "KeyW",
    "KeyA",
    "KeyB",
    "KeyD",
    "KeyS",
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
    moveBlocked: false,
    activeLandmark: null,
    currentArea: "Schlossplatz",
    textureCache: {
      building: new Map(),
      ground: new Map(),
    },
    useOrthophoto: false,
    frameHandle: 0,
    lastFrameTime: 0,
    fps: 0,
    fpsFrames: 0,
    fpsTimer: 0,
    time: 0,
    lastGroundSampleAt: 0,
    groundSamplePending: false,
    landmarkEntities: [],
    player: {
      x: DEFAULT_POSE.x,
      y: DEFAULT_POSE.y,
      heading: DEFAULT_POSE.heading,
      pitch: DEFAULT_POSE.pitch,
      groundHeight: 116.2,
      eyeHeight: 1.72,
      speedMps: 0,
    },
    mapPlayer: null,
  };

  const dom = {};
  const svgNs = "http://www.w3.org/2000/svg";

  window.addEventListener("DOMContentLoaded", main);
  window.render_game_to_text = renderGameToText;
  window.advanceTime = advanceTime;

  async function main() {
    bindDom();
    bindUi();

    if (!window.Cesium) {
      failBoot("Cesium konnte nicht geladen werden.");
      return;
    }

    try {
      setBootStatus("Lade Karlsruher Datensaetze...");
      await loadWorld();
      buildMiniMap();
      await initViewer();
      attachInput();
      resetPlayerPose();
      updateHud();
      state.ready = true;
      state.mode = "ready";
      dom.startBtn.disabled = false;
      setBootStatus(`Szene bereit: ${QUALITY[state.qualityMode]}`);
      startLoop();
    } catch (error) {
      console.error(error);
      failBoot(shortError(error));
    }
  }

  function bindDom() {
    dom.appShell = document.getElementById("app-shell");
    dom.cesiumContainer = document.getElementById("cesium-container");
    dom.startPanel = document.getElementById("start-panel");
    dom.startBtn = document.getElementById("start-btn");
    dom.bootStatus = document.getElementById("boot-status");
    dom.resetBtn = document.getElementById("reset-btn");
    dom.areaName = document.getElementById("area-name");
    dom.landmarkName = document.getElementById("landmark-name");
    dom.landmarkDistance = document.getElementById("landmark-distance");
    dom.qualityMode = document.getElementById("quality-mode");
    dom.headingText = document.getElementById("heading-text");
    dom.speedText = document.getElementById("speed-text");
    dom.walkStatus = document.getElementById("walk-status");
    dom.hintText = document.getElementById("hint-text");
    dom.mapPanel = document.getElementById("map-panel");
    dom.mapZones = document.getElementById("map-zones");
    dom.mapLandmarks = document.getElementById("map-landmarks");
    dom.mapPlayer = document.getElementById("map-player");
    dom.inspectPanel = document.getElementById("inspect-panel");
    dom.inspectTitle = document.getElementById("inspect-title");
    dom.inspectBody = document.getElementById("inspect-body");
    dom.sourceNote = document.getElementById("source-note");
  }

  function bindUi() {
    dom.startBtn.addEventListener("click", startExperience);
    dom.resetBtn.addEventListener("click", resetPlayerPose);
    dom.cesiumContainer.addEventListener("click", () => {
      if (state.started && !state.inspectOpen) {
        requestPointerLock();
      }
    });
  }

  async function loadWorld() {
    const [zones, landmarks, buildings] = await Promise.all([
      fetchJson("./data/walk-zones.json"),
      fetchJson("./data/landmarks.json"),
      fetchJson("./data/fallback-buildings.json"),
    ]);

    const origin = zones.origin;
    origin.metersPerLat = 111132;
    origin.metersPerLon = Math.cos((origin.lat * Math.PI) / 180) * 111320;

    state.world = {
      origin,
      bounds: zones.bounds,
      zones: zones.polygons,
      landmarks,
      buildings,
    };

    state.player.groundHeight = estimateGroundHeight(DEFAULT_POSE.x, DEFAULT_POSE.y);
  }

  async function initViewer() {
    const Cesium = window.Cesium;

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
      shadows: false,
      contextOptions: {
        webgl: {
          alpha: false,
          preserveDrawingBuffer: true,
        },
      },
    });

    state.viewer.imageryLayers.removeAll();
    try {
      const orthophotoLayer = new Cesium.WebMapServiceImageryProvider({
        url: "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C",
        layers: "IMAGES_DOP_20_RGB",
        parameters: {
          service: "WMS",
          version: "1.1.1",
          format: "image/jpeg",
          transparent: false,
        },
        enablePickFeatures: false,
      });
      state.viewer.imageryLayers.addImageryProvider(orthophotoLayer);
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
    const fixedTime = Cesium.JulianDate.fromIso8601("2026-06-21T10:30:00Z");
    state.viewer.clock.currentTime = fixedTime;
    state.viewer.clock.multiplier = 0;
    state.viewer.clock.shouldAnimate = false;
    state.viewer.scene.screenSpaceCameraController.enableInputs = false;
    state.viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    state.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0;
    state.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 0;
    state.viewer.camera.frustum.fov = Cesium.Math.toRadians(68);
    state.viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.25);

    await configureQuality();
    updateSourceNote();
  }

  async function configureQuality() {
    state.qualityError = "";
    setBootStatus(
      state.useOrthophoto
        ? "Nutze freie LGL-Orthophotos und lokale 3D-Geometrie..."
        : "Nutze lokales Karlsruhe-Detailmodell..."
    );
    if (!state.useOrthophoto) {
      addWalkSurfaces(0.88);
    }
    addFallbackBuildings();
    addStreetFurniture();
    addLandmarks(true);
    state.qualityMode = "local";
  }

  function configureTileset(tileset) {
    if ("maximumScreenSpaceError" in tileset) {
      tileset.maximumScreenSpaceError = 10;
    }
    if ("dynamicScreenSpaceError" in tileset) {
      tileset.dynamicScreenSpaceError = true;
    }
    if ("enableCollision" in tileset) {
      tileset.enableCollision = true;
    }
  }

  function addWalkSurfaces(alpha) {
    const Cesium = window.Cesium;
    const ground = state.world.origin.baseHeight;

    state.world.zones.forEach((zone) => {
      const material = getGroundMaterial(zone, alpha);
      state.viewer.entities.add({
        polygon: {
          hierarchy: polygonHierarchy(zone.points),
          height: ground - 0.18,
          extrudedHeight: ground + 0.05,
          material,
          outline: false,
        },
      });
    });
  }

  function addFallbackBuildings() {
    const Cesium = window.Cesium;
    const base = state.world.origin.baseHeight;

    state.world.buildings.forEach((building) => {
      const material = getBuildingMaterial(building);
      const roofColor = Cesium.Color.fromCssColorString(building.color || "#9b8c77").withAlpha(0.96);
      const roofHeight = base + building.height + 0.04;
      const wallPositions = building.footprint
        .concat([building.footprint[0]])
        .map((point) => localToCartesian(point[0], point[1], base));
      const minimumHeights = wallPositions.map(() => base);
      const maximumHeights = wallPositions.map(() => base + building.height);

      state.viewer.entities.add({
        wall: {
          positions: wallPositions,
          minimumHeights,
          maximumHeights,
          material,
        },
      });

      state.viewer.entities.add({
        polygon: {
          hierarchy: polygonHierarchy(building.footprint),
          height: roofHeight,
          material: roofColor,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString("#232826").withAlpha(0.28),
        },
      });
    });
  }

  function addLandmarks(forceVisible) {
    const Cesium = window.Cesium;

    state.landmarkEntities = state.world.landmarks.map((landmark) =>
      state.viewer.entities.add({
        position: localToCartesian(
          landmark.x,
          landmark.y,
          estimateGroundHeight(landmark.x, landmark.y) + 3.6
        ),
        point: {
          pixelSize: forceVisible ? 9 : 7,
          color: Cesium.Color.fromCssColorString("#f0cf87"),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
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
          show: true,
        },
      })
    );
  }

  function addStreetFurniture() {
    const lamps = [
      [-124, 132], [-42, 138], [42, 138], [124, 132],
      [-76, -238], [0, -246], [76, -238],
      [-122, -356], [-40, -364], [40, -364], [122, -356],
      [-125, -540], [-52, -538], [52, -538], [125, -540],
      [-346, -552], [-292, -548], [-236, -548], [-178, -552],
      [178, -552], [236, -548], [292, -548], [346, -552],
      [-252, -700], [-188, -708], [-124, -700],
      [-88, -776], [0, -780], [88, -776],
      [-72, -862], [0, -872], [72, -862],
    ];

    const trees = [
      [-136, 155], [136, 155], [-138, 72], [138, 72],
      [-248, -688], [-208, -732], [-110, -736], [-62, -682],
      [116, -688], [152, -744], [248, -748], [286, -686],
    ];

    lamps.forEach((point, index) => {
      addLampPost(point[0], point[1], index);
    });

    trees.forEach((point, index) => {
      addStreetTree(point[0], point[1], index);
    });
  }

  function addLampPost(x, y, index) {
    const Cesium = window.Cesium;
    const ground = estimateGroundHeight(x, y);
    const warm = Cesium.Color.fromCssColorString(index % 4 === 0 ? "#ffe9b2" : "#ffd27d");
    const poleColor = Cesium.Color.fromCssColorString("#4f5961").withAlpha(0.98);

    state.viewer.entities.add({
      position: localToCartesian(x, y, ground + 2.8),
      cylinder: {
        length: 5.4,
        topRadius: 0.045,
        bottomRadius: 0.085,
        material: poleColor,
        slices: 8,
      },
    });

    state.viewer.entities.add({
      position: localToCartesian(x + 0.2, y, ground + 5.45),
      ellipsoid: {
        radii: new Cesium.Cartesian3(0.16, 0.16, 0.12),
        material: warm.withAlpha(0.94),
        outline: false,
      },
    });
  }

  function addStreetTree(x, y, index) {
    const Cesium = window.Cesium;
    const ground = estimateGroundHeight(x, y);
    const palette = index % 3 === 0 ? "#4e6a42" : index % 3 === 1 ? "#5a7449" : "#3f5b3f";

    state.viewer.entities.add({
      position: localToCartesian(x, y, ground + 0.72),
      cylinder: {
        length: 1.4,
        topRadius: 0.14,
        bottomRadius: 0.22,
        material: Cesium.Color.fromCssColorString("#6a4d31").withAlpha(0.98),
      },
    });

    state.viewer.entities.add({
      position: localToCartesian(x, y, ground + 3.45),
      ellipsoid: {
        radii: new Cesium.Cartesian3(1.7, 1.7, 2.5),
        material: Cesium.Color.fromCssColorString(palette).withAlpha(0.94),
        outline: false,
      },
    });
  }

  function attachInput() {
    document.addEventListener("pointerlockchange", () => {
      state.pointerLocked = document.pointerLockElement === dom.cesiumContainer;
      updateHint();
    });

    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp, { passive: false });
    window.addEventListener("resize", renderScene);
  }

  function onMouseMove(event) {
    if (!state.pointerLocked || !state.started || state.inspectOpen) {
      return;
    }

    state.player.heading = normalizeAngle(state.player.heading + event.movementX * 0.0024);
    state.player.pitch = clamp(state.player.pitch - event.movementY * 0.0018, -1.08, 0.48);
  }

  function onKeyDown(event) {
    if (MOVEMENT_KEYS.has(event.code) || event.code === "Enter" || event.code === "KeyM") {
      event.preventDefault();
    }

    if (!state.started && (event.code === "Enter" || event.code === "Space")) {
      startExperience();
      return;
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
      toggleInspect();
      return;
    }

    if (event.code === "KeyF") {
      toggleFullscreen();
      return;
    }

    if (event.code === "Escape") {
      if (state.inspectOpen) {
        closeInspect();
      } else if (state.mapOpen) {
        toggleMap(false);
      }
      return;
    }

    state.keys.add(event.code);
  }

  function onKeyUp(event) {
    state.keys.delete(event.code);
  }

  function startExperience() {
    if (!state.ready) {
      return;
    }

    state.started = true;
    state.mode = "explore";
    dom.startPanel.classList.add("hidden");
    updateHint();
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

  function toggleMap(forceValue) {
    state.mapOpen = typeof forceValue === "boolean" ? forceValue : !state.mapOpen;
    dom.mapPanel.classList.toggle("hidden", !state.mapOpen);
    updateHint();
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
    } else {
      state.mode = "explore";
    }

    updateHint();
  }

  function closeInspect() {
    state.inspectOpen = false;
    dom.inspectPanel.classList.add("hidden");
    state.mode = state.started ? "explore" : "ready";
    updateHint();
  }

  function resetPlayerPose() {
    state.player.x = DEFAULT_POSE.x;
    state.player.y = DEFAULT_POSE.y;
    state.player.heading = DEFAULT_POSE.heading;
    state.player.pitch = DEFAULT_POSE.pitch;
    state.player.speedMps = 0;
    state.player.groundHeight = estimateGroundHeight(DEFAULT_POSE.x, DEFAULT_POSE.y);
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

  function startLoop() {
    cancelAnimationFrame(state.frameHandle);
    state.lastFrameTime = performance.now();

    const frame = (timestamp) => {
      const delta = Math.min(0.05, (timestamp - state.lastFrameTime) / 1000 || 0.016);
      state.lastFrameTime = timestamp;
      step(delta);
      renderScene();
      state.frameHandle = requestAnimationFrame(frame);
    };

    state.frameHandle = requestAnimationFrame(frame);
  }

  function step(deltaSeconds) {
    state.time += deltaSeconds;
    trackFps(deltaSeconds);

    if (!state.ready || !state.started || state.inspectOpen || state.mapOpen) {
      state.player.speedMps = 0;
      updateWorldState();
      return;
    }

    const intent = getIntent();
    state.player.heading = normalizeAngle(state.player.heading + intent.turn * 1.65 * deltaSeconds);

    const moveLength = Math.hypot(intent.move.x, intent.move.y);
    const speed = intent.sprint ? 5.3 : 2.45;
    let traveled = 0;

    if (moveLength > 0) {
      const dx = (intent.move.x / moveLength) * speed * deltaSeconds;
      const dy = (intent.move.y / moveLength) * speed * deltaSeconds;
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
      state.moveBlocked = resolved.blocked;
    } else {
      state.moveBlocked = false;
    }

    state.player.speedMps = deltaSeconds > 0 ? traveled / deltaSeconds : 0;
    updateGroundHeight();
    updateWorldState();
    updateCamera();
  }

  function getIntent() {
    const forward =
      (state.keys.has("KeyW") || state.keys.has("ArrowUp") ? 1 : 0) -
      (state.keys.has("KeyS") || state.keys.has("ArrowDown") ? 1 : 0);
    const strafe =
      (state.keys.has("KeyD") || state.keys.has("KeyB") ? 1 : 0) -
      (state.keys.has("KeyA") ? 1 : 0);
    const turn =
      (state.keys.has("ArrowRight") ? 1 : 0) -
      (state.keys.has("ArrowLeft") ? 1 : 0);
    const forwardVector = { x: Math.sin(state.player.heading), y: Math.cos(state.player.heading) };
    const rightVector = { x: Math.cos(state.player.heading), y: -Math.sin(state.player.heading) };

    return {
      turn,
      sprint: state.keys.has("ShiftLeft") || state.keys.has("ShiftRight") || state.keys.has("Space"),
      move: {
        x: forwardVector.x * forward + rightVector.x * strafe,
        y: forwardVector.y * forward + rightVector.y * strafe,
      },
    };
  }

  function resolveWalkMove(fromX, fromY, toX, toY) {
    if (insideWalkMesh(toX, toY)) {
      return { x: toX, y: toY, blocked: false };
    }
    if (insideWalkMesh(toX, fromY)) {
      return { x: toX, y: fromY, blocked: true };
    }
    if (insideWalkMesh(fromX, toY)) {
      return { x: fromX, y: toY, blocked: true };
    }
    return { x: fromX, y: fromY, blocked: true };
  }

  function updateGroundHeight() {
    state.player.groundHeight = estimateGroundHeight(state.player.x, state.player.y);
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
    const zone = state.world.zones.find((candidate) => pointInPolygon(state.player.x, state.player.y, candidate.points));
    state.currentArea = zone ? zone.label : nearest ? nearest.areaName : "Innenstadt Kern";
  }

  function updateCamera() {
    if (!state.viewer) {
      return;
    }

    state.viewer.camera.setView({
      destination: localToCartesian(
        state.player.x,
        state.player.y,
        state.player.groundHeight + state.player.eyeHeight
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

    state.viewer.resize();
    state.viewer.render();
    updateHud();
  }

  function updateHud() {
    dom.areaName.textContent = state.currentArea;
    dom.landmarkName.textContent = state.activeLandmark ? state.activeLandmark.name : "Keine Landmarke im Fokus";
    dom.landmarkDistance.textContent = state.activeLandmark
      ? `${formatMeters(state.activeLandmark.distance)} entfernt`
      : "0 m";
    dom.qualityMode.textContent = QUALITY[state.qualityMode] || state.qualityMode;
    dom.headingText.textContent = `${headingLabel(state.player.heading)} · ${Math.round(toDeg(state.player.heading))}deg`;
    dom.speedText.textContent = `${state.player.speedMps.toFixed(1)} m/s`;
    dom.headingText.textContent = `${headingLabel(state.player.heading)} | ${Math.round(toDeg(state.player.heading))}deg`;
    dom.walkStatus.textContent = state.moveBlocked
      ? "edge"
      : state.started
        ? state.player.speedMps > 0.05
          ? "walking"
          : "idle"
        : "ready";

    if (state.inspectOpen && state.activeLandmark) {
      dom.inspectTitle.textContent = state.activeLandmark.name;
      dom.inspectBody.textContent = state.activeLandmark.description;
    }

    updateHint();
    updateMiniMap();
  }

  function updateHint() {
    const hints = [];

    if (!state.started) {
      hints.push("Klick auf Start oder druecke Enter.");
    } else if (state.inspectOpen) {
      hints.push("E oder Escape schliesst die Landmarke. Enter setzt den Startpunkt neu.");
    } else {
      hints.push(state.pointerLocked ? "Mausblick aktiv." : "Klicke in die Szene fuer Mausblick.");
      hints.push("Pfeiltasten drehen oder laufen, W A S D fuer freie Schritte, Space sprintet.");
      if (state.activeLandmark && state.activeLandmark.distance <= state.activeLandmark.radius + 36) {
        hints.push(`E oeffnet ${state.activeLandmark.name}.`);
      }
      if (state.moveBlocked) {
        hints.push("Walk-Mesh-Rand erreicht.");
      }
    }

    dom.hintText.textContent = hints.join(" ");
  }

  function buildMiniMap() {
    dom.mapZones.textContent = "";
    dom.mapLandmarks.textContent = "";
    dom.mapPlayer.textContent = "";

    state.world.zones.forEach((zone) => {
      const path = document.createElementNS(svgNs, "path");
      path.setAttribute("d", svgPath(zone.points));
      dom.mapZones.appendChild(path);
    });

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
        return `${index === 0 ? "M" : "L"} ${projected.x.toFixed(2)} ${projected.y.toFixed(2)}`;
      })
      .concat("Z")
      .join(" ");
  }

  function mapPoint(x, y) {
    const pad = 16;
    const width = 280 - pad * 2;
    const height = 280 - pad * 2;
    const nx = (x - state.world.bounds.minX) / (state.world.bounds.maxX - state.world.bounds.minX || 1);
    const ny = 1 - (y - state.world.bounds.minY) / (state.world.bounds.maxY - state.world.bounds.minY || 1);

    return { x: pad + nx * width, y: pad + ny * height };
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

  function insideWalkMesh(x, y) {
    return state.world.zones.some((zone) => pointInPolygon(x, y, zone.points));
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

  function estimateGroundHeight(x, y) {
    const south = Math.max(0, -y);
    const side = Math.abs(x);
    return state.world.origin.baseHeight - south * 0.00145 - side * 0.00018;
  }

  function zoneColor(id) {
    if (id.includes("schloss")) return "#6d7f6a";
    if (id.includes("kaiser")) return "#5f6975";
    if (id.includes("marktplatz")) return "#6f665f";
    if (id.includes("ettlinger")) return "#5e6463";
    return "#4e6468";
  }

  function getGroundMaterial(zone, alpha) {
    const Cesium = window.Cesium;
    const cacheKey = `${zone.id}:${alpha.toFixed(2)}`;

    if (!state.textureCache.ground.has(cacheKey)) {
      const texture = createGroundTexture(zone, alpha);
      const bounds = polygonBounds(zone.points);
      const repeat = textureRepeat(bounds.width, bounds.height, 28, 28);
      state.textureCache.ground.set(
        cacheKey,
        new Cesium.ImageMaterialProperty({
          image: texture,
          repeat: new Cesium.Cartesian2(repeat.x, repeat.y),
        })
      );
    }

    return state.textureCache.ground.get(cacheKey);
  }

  function getBuildingMaterial(building) {
    const Cesium = window.Cesium;

    if (!state.textureCache.building.has(building.id)) {
      const texture = createBuildingTexture(building);
      const bounds = polygonBounds(building.footprint);
      const repeat = textureRepeat(bounds.width, bounds.height, 42, 16);
      const heightRepeat = clamp(Math.round(building.height / 9), 1, 6);

      state.textureCache.building.set(
        building.id,
        new Cesium.ImageMaterialProperty({
          image: texture,
          repeat: new Cesium.Cartesian2(repeat.x, Math.max(repeat.y, heightRepeat)),
        })
      );
    }

    return state.textureCache.building.get(building.id);
  }

  function createGroundTexture(zone, alpha) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return canvas;
    }

    const rng = mulberry32(hashString(`ground:${zone.id}`));
    const base = hexToRgb(zoneColor(zone.id));
    const style = groundStyle(zone.id);
    const light = tintColor(base, 0.22);
    const dark = tintColor(base, -0.2);

    if (state.useOrthophoto) {
      ctx.globalAlpha = clamp(alpha, 0.08, 0.18);
    } else {
      ctx.globalAlpha = clamp(alpha, 0.72, 1);
    }
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, rgbToCss(light));
    gradient.addColorStop(0.5, rgbToCss(base));
    gradient.addColorStop(1, rgbToCss(dark));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;

    if (state.useOrthophoto) {
      const tint = style === "road" ? "#1b2429" : style === "plaza" ? "#4f5e5a" : "#44554a";
      drawNoise(ctx, canvas, rng, 0.02, tint);
    } else {
      if (style === "plaza") {
        drawPaverTexture(ctx, canvas, rng, base);
      } else if (style === "road") {
        drawAsphaltTexture(ctx, canvas, rng, base);
      } else {
        drawGrassTexture(ctx, canvas, rng, base);
      }
      drawNoise(ctx, canvas, rng, style === "road" ? 0.08 : 0.06, style === "road" ? "#0e1315" : "#ffffff");
    }

    return canvas;
  }

  function createBuildingTexture(building) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return canvas;
    }

    const rng = mulberry32(hashString(`building:${building.id}`));
    const base = hexToRgb(building.color || "#9b8c77");
    const theme = buildingTheme(building.id, building.height);
    const top = tintColor(base, theme === "palace" ? 0.22 : theme === "stone" ? 0.18 : 0.14);
    const mid = tintColor(base, theme === "palace" ? 0.06 : 0.02);
    const bottom = tintColor(base, -0.18);

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, rgbToCss(top));
    gradient.addColorStop(0.52, rgbToCss(mid));
    gradient.addColorStop(1, rgbToCss(bottom));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawVerticalBands(ctx, canvas, rng, theme);
    drawFacadeBands(ctx, canvas, rng, theme);
    drawFacadeWindows(ctx, canvas, rng, theme);
    drawBuildingShadows(ctx, canvas, rng, theme);
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

  function drawAsphaltTexture(ctx, canvas, rng, base) {
    ctx.fillStyle = rgbToCss(tintColor(base, 0.03), 0.96);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < 6200; i += 1) {
      const x = Math.floor(rng() * canvas.width);
      const y = Math.floor(rng() * canvas.height);
      const alpha = rng() * 0.1;
      const tone = rng() * 16 - 8;
      ctx.fillStyle = `rgba(${110 + tone}, ${116 + tone}, ${112 + tone}, ${alpha})`;
      ctx.fillRect(x, y, 1 + Math.floor(rng() * 2), 1 + Math.floor(rng() * 2));
    }

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    for (let y = 0; y < canvas.height; y += 96) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(canvas.width, y + 0.5);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(244, 224, 166, 0.16)";
    ctx.fillRect(canvas.width * 0.48, 0, 6, canvas.height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fillRect(canvas.width * 0.07, canvas.height * 0.18, canvas.width * 0.86, 3);
    ctx.fillRect(canvas.width * 0.07, canvas.height * 0.82, canvas.width * 0.86, 3);
  }

  function drawGrassTexture(ctx, canvas, rng, base) {
    ctx.fillStyle = rgbToCss(tintColor(base, 0.05), 0.94);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < 3600; i += 1) {
      const x = Math.floor(rng() * canvas.width);
      const y = Math.floor(rng() * canvas.height);
      const tone = rng() * 18 - 9;
      ctx.fillStyle = `rgba(${88 + tone}, ${112 + tone}, ${78 + tone}, ${rng() * 0.12})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  function drawVerticalBands(ctx, canvas, rng, theme) {
    const bandWidth = theme === "palace" ? 84 : theme === "tower" ? 116 : 148;
    const bandCount = Math.max(4, Math.floor(canvas.width / bandWidth));
    for (let index = 0; index < bandCount; index += 1) {
      const x = Math.floor((index / bandCount) * canvas.width);
      const alpha = theme === "palace" ? 0.1 : theme === "tower" ? 0.035 : theme === "stone" ? 0.028 : 0.018;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillRect(x, 0, theme === "palace" ? 9 : theme === "tower" ? 5 : 3, canvas.height);
      ctx.fillStyle = `rgba(0,0,0,${alpha * 1.2})`;
      ctx.fillRect(x + (theme === "tower" ? 9 : 11), 0, theme === "tower" ? 2 : 1, canvas.height);
    }

    if (theme === "palace") {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(0, 18, canvas.width, 16);
      ctx.fillStyle = "rgba(68,52,30,0.22)";
      ctx.fillRect(0, canvas.height - 20, canvas.width, 20);
    } else if (theme === "block" || theme === "stone" || theme === "tower") {
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(0, 14, canvas.width, theme === "tower" ? 8 : 5);
      ctx.fillStyle = "rgba(27,34,36,0.04)";
      ctx.fillRect(0, canvas.height - (theme === "tower" ? 30 : 24), canvas.width, theme === "tower" ? 30 : 24);
    }
  }

  function drawFacadeBands(ctx, canvas, rng, theme) {
    const roofBand = theme === "palace" ? 18 : theme === "tower" ? 14 : 12;
    const plinthBand = theme === "palace" ? 24 : 18;
    const shopBand = theme === "block" ? 76 : 56;

    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, 0, canvas.width, roofBand);
    ctx.fillStyle = "rgba(36, 28, 20, 0.2)";
    ctx.fillRect(0, canvas.height - plinthBand, canvas.width, plinthBand);

    if (theme !== "palace") {
      ctx.fillStyle = "rgba(48, 42, 34, 0.16)";
      ctx.fillRect(0, canvas.height - shopBand, canvas.width, 12);
      ctx.fillStyle = "rgba(255, 248, 224, 0.06)";
      for (let x = 28; x < canvas.width - 20; x += 68 + Math.floor(rng() * 18)) {
        ctx.fillRect(x, canvas.height - shopBand + 14, 28, 34);
      }
    } else {
      ctx.fillStyle = "rgba(255, 240, 200, 0.16)";
      ctx.fillRect(0, 28, canvas.width, 10);
    }
  }

  function drawFacadeWindows(ctx, canvas, rng, theme) {
    const columns = theme === "palace" ? 6 : theme === "tower" ? 6 : 8;
    const rows = theme === "palace" ? 8 : theme === "tower" ? 10 : 10;
    const paddingX = theme === "palace" ? 36 : 26;
    const paddingY = theme === "palace" ? 30 : 22;
    const spacingX = (canvas.width - paddingX * 2) / columns;
    const spacingY = (canvas.height - paddingY * 2) / rows;

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const width = theme === "palace" ? 34 : 24 + Math.floor(rng() * 8);
        const height = theme === "palace" ? 56 : 30 + Math.floor(rng() * 14);
        const x = paddingX + col * spacingX + spacingX * 0.2;
        const y = paddingY + row * spacingY + spacingY * 0.16;
        const lit = rng() > (theme === "palace" ? 0.5 : 0.62);
        const frame = lit ? "rgba(247,236,204,0.86)" : "rgba(24,28,30,0.82)";
        const glass = lit ? "rgba(223, 206, 149, 0.52)" : "rgba(66, 74, 76, 0.56)";

        ctx.fillStyle = frame;
        ctx.fillRect(x, y, width, height);
        ctx.fillStyle = glass;
        ctx.fillRect(x + 3, y + 4, width - 6, height - 8);

        if (theme !== "palace" && rng() > 0.45) {
          ctx.fillStyle = "rgba(255,255,255,0.035)";
          ctx.fillRect(x + width * 0.45, y + 2, width * 0.12, height - 4);
        }
      }
    }

    if (theme === "palace") {
      ctx.fillStyle = "rgba(246, 228, 178, 0.2)";
      ctx.fillRect(30, 0, canvas.width - 60, 10);
    } else {
      ctx.fillStyle = "rgba(31, 39, 42, 0.08)";
      ctx.fillRect(0, canvas.height * 0.58, canvas.width, 12);
    }
  }

  function drawBuildingShadows(ctx, canvas, rng, theme) {
    const edge = ctx.createLinearGradient(0, 0, canvas.width, 0);
    edge.addColorStop(0, "rgba(0,0,0,0.16)");
    edge.addColorStop(0.16, "rgba(0,0,0,0.04)");
    edge.addColorStop(0.72, "rgba(0,0,0,0.04)");
    edge.addColorStop(1, "rgba(0,0,0,0.22)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const vertical = ctx.createLinearGradient(0, 0, 0, canvas.height);
    vertical.addColorStop(0, "rgba(255,255,255,0.1)");
    vertical.addColorStop(0.42, "rgba(255,255,255,0.03)");
    vertical.addColorStop(1, "rgba(0,0,0,0.16)");
    ctx.fillStyle = vertical;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const sunShadow = ctx.createLinearGradient(0, 0, canvas.width * 0.3, canvas.height);
    sunShadow.addColorStop(0, "rgba(0,0,0,0.03)");
    sunShadow.addColorStop(1, "rgba(0,0,0,0.12)");
    ctx.fillStyle = sunShadow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (theme === "tower") {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.fillRect(canvas.width * 0.15, 0, 10, canvas.height);
      ctx.fillRect(canvas.width * 0.82, 0, 10, canvas.height);
    }
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

  function groundStyle(id) {
    if (id.includes("schloss") || id.includes("marktplatz") || id.includes("friedrichsplatz")) return "plaza";
    if (id.includes("kaiser") || id.includes("ettlinger") || id.includes("zirkel") || id.includes("karl")) return "road";
    return "plaza";
  }

  function buildingTheme(id, height) {
    if (id.includes("schloss")) return "palace";
    if (id.includes("stadtkirche")) return "tower";
    if (id.includes("rathaus") || id.includes("friedrichsplatz")) return "stone";
    if (height >= 28) return "tower";
    if (height >= 18) return "stone";
    return "block";
  }

  function textureRepeat(width, height, scaleX, scaleY) {
    return {
      x: clamp(Math.round(width / scaleX), 1, 8),
      y: clamp(Math.round(height / scaleY), 1, 8),
    };
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
          inside: insideWalkMesh(state.player.x, state.player.y),
          blockedLastMove: state.moveBlocked,
        },
        toggles: {
          pointerLocked: state.pointerLocked,
          mapOpen: state.mapOpen,
          inspectOpen: state.inspectOpen,
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
    const notes = [
      `Quality: ${QUALITY[state.qualityMode] || state.qualityMode}.`,
      state.useOrthophoto
        ? "Uses free LGL orthophotos plus local 3D geometry. No API keys."
        : "Runs fully local with no external API keys or cloud tiles.",
    ];
    if (state.qualityError) {
      notes.push(state.qualityError);
    }
    dom.sourceNote.textContent = notes.join(" ");
  }

  function setBootStatus(text) {
    dom.bootStatus.textContent = text;
  }

  function failBoot(text) {
    state.mode = "error";
    state.qualityMode = "error";
    dom.startBtn.disabled = true;
    setBootStatus(text);
    dom.areaName.textContent = "Scene failed";
    dom.landmarkName.textContent = text;
    dom.qualityMode.textContent = QUALITY.error;
    dom.walkStatus.textContent = "error";
    dom.hintText.textContent = "Pruefe WebGL oder lokale Dateien und lade die Seite neu.";
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
})();
