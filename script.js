import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js";

// DOM references (single lookup up front to simplify debugging null checks).
const scenes = [...document.querySelectorAll(".scene")];
const trackButtons = [...document.querySelectorAll(".track-list button")];
const moodTitle = document.getElementById("moodTitle");
const moodText = document.getElementById("moodText");
const bg3dCanvas = document.getElementById("bg3dCanvas");
const albumCard = document.getElementById("albumCard");
const waveCanvas = document.getElementById("waveCanvas");
const waveCtx = waveCanvas?.getContext("2d");
const audioElement = document.getElementById("albumAudio");
const audioToggle = document.getElementById("audioToggle");
const audioFile = document.getElementById("audioFile");
const audioStatus = document.getElementById("audioStatus");
const audioMeterFill = document.getElementById("audioMeterFill");
const root = document.documentElement;

// Global reactive state shared across render systems.
let activeIndex = 0;
let accentRGB = { r: 255, g: 133, b: 105 };
let pointerX = 0;
let pointerY = 0;
let waveBoost = 0;
let lastScrollY = window.scrollY;
let audioLevel = 0;
let audioBass = 0;
let beatPulse = 0;
let beatGateUntil = 0;
let audioObjectUrl = "";
let beatHistorySum = 0;

const beatHistory = [];

let audioContext = null;
let analyserNode = null;
let gainNode = null;
let sourceNode = null;
let frequencyData = null;

// Safe no-op defaults prevent crashes if a renderer fails to initialize.
let threeState = {
  renderFrame() {},
  resizeRenderer() {},
  setAlbumTheme() {},
};

let backgroundState = {
  renderFrame() {},
  resizeRenderer() {},
  setBackgroundTheme() {},
};

// Background scene first so it is ready before first animation frame.
try {
  backgroundState = initBackgroundScene();
} catch (error) {
  console.error("Three.js background scene failed to initialize.", error);
}

// Album scene next (independent from the background scene).
try {
  threeState = initAlbumScene();
} catch (error) {
  console.error("Three.js album scene failed to initialize.", error);
}

function hexToRgb(hex) {
  const sanitized = hex.replace("#", "");
  const chunk = sanitized.length === 3 ? sanitized.split("").map((value) => value + value).join("") : sanitized;
  const numeric = Number.parseInt(chunk, 16);

  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255,
  };
}

function fitLines(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
      return;
    }

    if (current) {
      lines.push(current);
    }
    current = word;
  });

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 2);
}

function setAudioStatus(text) {
  if (audioStatus) {
    audioStatus.textContent = text;
  }
}

function setAudioButton(label) {
  if (audioToggle) {
    audioToggle.textContent = label;
  }
}

function setAudioMeter(level) {
  if (!audioMeterFill) {
    return;
  }

  const clamped = Math.max(0.03, Math.min(1, level));
  audioMeterFill.style.transform = `scaleX(${clamped})`;
  audioMeterFill.style.opacity = `${0.3 + clamped * 0.7}`;
}

// Lazily create audio graph on first user action (browser autoplay policy).
async function ensureAudioEngine() {
  if (!audioElement) {
    return false;
  }

  if (!audioContext) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      setAudioStatus("Web Audio API is not supported in this browser.");
      return false;
    }

    audioContext = new Context();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.86;
    gainNode = audioContext.createGain();
    gainNode.gain.value = 1;

    sourceNode = audioContext.createMediaElementSource(audioElement);
    sourceNode.connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    frequencyData = new Uint8Array(analyserNode.frequencyBinCount);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return true;
}

// Main transport button behavior.
async function toggleAudioPlayback() {
  if (!audioElement) {
    return;
  }

  if (!audioElement.src) {
    if (audioFile) {
      audioFile.click();
    }
    return;
  }

  const ready = await ensureAudioEngine();
  if (!ready) {
    return;
  }

  if (audioElement.paused) {
    try {
      await audioElement.play();
      setAudioButton("Pause Audio");
      setAudioStatus("Audio reactive mode: live.");
    } catch (error) {
      console.error("Audio playback failed.", error);
      setAudioStatus("Playback blocked. Press play again.");
    }
  } else {
    audioElement.pause();
    setAudioButton("Play Audio");
    setAudioStatus("Audio paused. Visuals still reactive to scroll.");
  }
}

// File picker handler: load local file and start playback if allowed.
async function handleAudioFileSelection(event) {
  const file = event.target.files?.[0];
  if (!file || !audioElement) {
    return;
  }

  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
  }
  audioObjectUrl = URL.createObjectURL(file);
  audioElement.src = audioObjectUrl;
  audioElement.load();

  const ready = await ensureAudioEngine();
  if (!ready) {
    return;
  }

  try {
    await audioElement.play();
    setAudioButton("Pause Audio");
    setAudioStatus(`Audio reactive mode: ${file.name}`);
  } catch (error) {
    console.error("Auto-play after file selection failed.", error);
    setAudioButton("Play Audio");
    setAudioStatus(`Loaded ${file.name}. Press play.`);
  }
}

// Pull frequency data each frame and derive lightweight beat/pulse metrics.
function updateAudioReactive(timeSeconds) {
  beatPulse *= 0.9;

  if (!analyserNode || !frequencyData || !audioElement || audioElement.paused) {
    audioLevel *= 0.92;
    audioBass *= 0.9;
    setAudioMeter(audioLevel * 1.15 + beatPulse * 0.35);
    return;
  }

  analyserNode.getByteFrequencyData(frequencyData);

  const hzPerBin = (audioContext.sampleRate * 0.5) / frequencyData.length;
  const bassStart = Math.max(0, Math.floor(30 / hzPerBin));
  const bassEnd = Math.min(frequencyData.length - 1, Math.floor(180 / hzPerBin));
  const bodyEnd = Math.min(frequencyData.length - 1, Math.floor(1800 / hzPerBin));

  let bassSum = 0;
  for (let i = bassStart; i <= bassEnd; i += 1) {
    bassSum += frequencyData[i];
  }
  const bassValue = bassSum / (Math.max(1, bassEnd - bassStart + 1) * 255);

  let bodySum = 0;
  for (let i = 0; i <= bodyEnd; i += 1) {
    bodySum += frequencyData[i];
  }
  const bodyValue = bodySum / (Math.max(1, bodyEnd + 1) * 255);

  audioBass = audioBass * 0.72 + bassValue * 0.28;
  audioLevel = audioLevel * 0.84 + bodyValue * 0.16;

  beatHistory.push(audioBass);
  beatHistorySum += audioBass;
  // Rolling window keeps beat threshold adaptive to different tracks.
  if (beatHistory.length > 42) {
    beatHistorySum -= beatHistory.shift();
  }

  const averageBass = beatHistory.length > 0 ? beatHistorySum / beatHistory.length : 0;
  const threshold = Math.max(0.14, averageBass * 1.32);
  if (audioBass > threshold && timeSeconds > beatGateUntil) {
    beatPulse = 1;
    beatGateUntil = timeSeconds + 0.17;
  } else {
    beatPulse *= 0.95;
  }

  setAudioMeter(audioLevel * 1.4 + beatPulse * 0.5);
}

function initBackgroundScene() {
  if (!bg3dCanvas) {
    throw new Error("Background 3D canvas is unavailable.");
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: bg3dCanvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2("#0a1020", 0.027);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 240);
  camera.position.set(0, 0, 22);

  const rig = new THREE.Group();
  scene.add(rig);

  // Lighting rig for cinematic depth (base, fill, rim, accent).
  const ambientLight = new THREE.AmbientLight("#8da8d9", 0.38);
  scene.add(ambientLight);

  const fillLight = new THREE.DirectionalLight("#c8d8ff", 1.05);
  fillLight.position.set(-2, 4, 5);
  scene.add(fillLight);

  const rimLight = new THREE.PointLight("#5b8bff", 10.4, 145);
  rimLight.position.set(-12, 7, 8);
  scene.add(rimLight);

  const accentLight = new THREE.PointLight("#ff8569", 12, 160);
  accentLight.position.set(9, -5, 12);
  scene.add(accentLight);

  // Animated wireframe floor gives a "moving through space" feeling.
  const flowGeometry = new THREE.PlaneGeometry(90, 58, 54, 32);
  const flowMaterial = new THREE.MeshBasicMaterial({
    color: "#5f79bf",
    wireframe: true,
    transparent: true,
    opacity: 0.24,
    blending: THREE.AdditiveBlending,
  });
  const flowField = new THREE.Mesh(flowGeometry, flowMaterial);
  flowField.position.set(0, -11.5, -14);
  flowField.rotation.x = -1.17;
  rig.add(flowField);
  const flowBase = Float32Array.from(flowGeometry.attributes.position.array);

  const ringGroup = new THREE.Group();
  rig.add(ringGroup);
  const ringMeshes = [];

  // Tunnel rings recycled along z-axis for endless motion.
  for (let i = 0; i < 10; i += 1) {
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: "#4f67aa",
      wireframe: true,
      transparent: true,
      opacity: Math.max(0.08, 0.25 - i * 0.018),
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(8.2 + i * 2.45, 0.07, 10, 160), ringMaterial);
    ring.position.z = -8 - i * 9.5;
    ring.rotation.x = Math.PI * 0.54 + i * 0.12;
    ring.rotation.y = i * 0.23;
    ringGroup.add(ring);
    ringMeshes.push(ring);
  }

  const particleCount = 2200;
  const particlePositions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i += 1) {
    const idx = i * 3;
    particlePositions[idx] = (Math.random() - 0.5) * 120;
    particlePositions[idx + 1] = (Math.random() - 0.5) * 80;
    particlePositions[idx + 2] = -Math.random() * 140 + 12;
  }

  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  const particleMaterial = new THREE.PointsMaterial({
    color: "#7ea8ff",
    size: 0.22,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  rig.add(particles);

  // Soft volumetric blobs to avoid flat background areas.
  const hazeMaterial = new THREE.MeshBasicMaterial({
    color: "#293d72",
    transparent: true,
    opacity: 0.23,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const hazeA = new THREE.Mesh(new THREE.IcosahedronGeometry(6.8, 1), hazeMaterial.clone());
  hazeA.position.set(-9.5, 4.2, -26);
  hazeA.scale.set(1.5, 1.1, 1.2);
  rig.add(hazeA);

  const hazeB = new THREE.Mesh(new THREE.IcosahedronGeometry(5.4, 1), hazeMaterial.clone());
  hazeB.position.set(10.2, -1.8, -30);
  hazeB.scale.set(1.2, 1.4, 1.1);
  rig.add(hazeB);

  // Called when active track changes.
  function setBackgroundTheme(accentHex, bg1Hex, bg2Hex) {
    const accentColor = new THREE.Color(accentHex || "#ff8569");
    const bgColor1 = new THREE.Color(bg1Hex || "#0d1424");
    const bgColor2 = new THREE.Color(bg2Hex || "#3a1f47");

    ringMeshes.forEach((ring, index) => {
      ring.material.color.copy(accentColor.clone().lerp(bgColor1, Math.min(0.18 + index * 0.08, 0.84)));
    });

    flowMaterial.color.copy(accentColor.clone().lerp(bgColor2, 0.46));
    particleMaterial.color.copy(accentColor.clone().lerp(new THREE.Color("#f2f6ff"), 0.2));
    hazeA.material.color.copy(accentColor.clone().lerp(bgColor2, 0.36));
    hazeB.material.color.copy(bgColor2.clone().lerp(bgColor1, 0.2));

    accentLight.color.copy(accentColor);
    rimLight.color.copy(bgColor2.clone().lerp(accentColor, 0.44));

    const fogColor = bgColor1.clone().lerp(new THREE.Color("#02050e"), 0.5);
    scene.fog.color.copy(fogColor);
    renderer.setClearColor(fogColor, 0.5);
  }

  // Keep renderer aligned with viewport changes.
  function resizeRenderer() {
    const width = Math.max(window.innerWidth, 1);
    const height = Math.max(window.innerHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // Per-frame animation driven by pointer, scroll, and audio energy.
  function renderFrame(timeSeconds) {
    const scrollRange = Math.max(document.body.scrollHeight - window.innerHeight, 1);
    const scrollProgress = window.scrollY / scrollRange;
    const reactiveDrive = waveBoost * 0.02 + audioLevel * 1.3 + beatPulse * 1.9;
    const motionBoost = 1 + reactiveDrive;
    const pulse = 1 + Math.sin(timeSeconds * 2.1) * 0.12 + waveBoost * 0.01 + audioLevel * 0.85 + beatPulse * 1.1;

    camera.position.x += (pointerX * 3.4 + Math.sin(timeSeconds * 0.3) * 1 - camera.position.x) * 0.05;
    camera.position.y += (pointerY * -2.3 + (0.42 - scrollProgress) * 2.2 - camera.position.y) * 0.045;
    camera.lookAt(0, -1.3, -24);

    particles.rotation.y += (0.0011 + audioLevel * 0.0024) * motionBoost;
    particles.rotation.x = Math.sin(timeSeconds * 0.14) * 0.1 + pointerY * 0.07 + audioBass * 0.08;

    ringGroup.rotation.z = Math.sin(timeSeconds * 0.25) * 0.16 + pointerX * 0.18;
    ringGroup.rotation.y += 0.0008 * motionBoost;

    ringMeshes.forEach((ring, index) => {
      ring.rotation.x += 0.0018 + index * 0.0002;
      ring.rotation.y -= 0.001 + index * 0.00012;
      ring.position.z += 0.05 + waveBoost * 0.0011 + audioLevel * 0.08 + beatPulse * 0.2;
      if (ring.position.z > 20) {
        // Recycle to the back for continuous tunnel flow.
        ring.position.z = -130 - index * 5;
      }
    });

    const flowPositions = flowGeometry.attributes.position.array;
    const velocityA = 1.15 + scrollProgress * 0.65 + audioLevel * 1.6;
    const amplitude = 1.05 + waveBoost * 0.045 + audioBass * 1.8 + beatPulse * 1.25;
    for (let i = 0; i < flowPositions.length; i += 3) {
      const x = flowBase[i];
      const y = flowBase[i + 1];
      flowPositions[i + 2] =
        Math.sin(x * 0.22 + timeSeconds * velocityA) * amplitude +
        Math.cos(y * 0.3 + timeSeconds * 1.34) * 0.75 +
        Math.sin((x + y) * 0.08 + timeSeconds * 0.86) * 0.52;
    }
    flowGeometry.attributes.position.needsUpdate = true;

    hazeA.rotation.x += 0.002;
    hazeA.rotation.y += 0.0016;
    hazeB.rotation.y -= 0.0017;
    hazeB.rotation.z += 0.0013;

    hazeA.position.x = -9.5 + Math.sin(timeSeconds * 0.45) * 2 + pointerX * 2.2;
    hazeA.position.y = 3.8 + Math.cos(timeSeconds * 0.56) * 1.4 + pointerY * 1.1;
    hazeB.position.x = 10.2 + Math.cos(timeSeconds * 0.39) * 1.8 + pointerX * 1.7;
    hazeB.position.y = -1.2 + Math.sin(timeSeconds * 0.49) * 1.2 + pointerY * 0.95;

    accentLight.position.x = pointerX * 14 + Math.sin(timeSeconds * 0.55) * 5.4;
    accentLight.position.y = -4 + pointerY * -8 + Math.cos(timeSeconds * 0.66) * 2.2;
    accentLight.intensity = 11 + pulse * 2.4 + audioLevel * 6.8 + beatPulse * 6.5;
    rimLight.intensity = 9.5 + pulse * 1.7 + audioBass * 3.8;
    flowMaterial.opacity = Math.min(0.5, 0.2 + pulse * 0.09 + waveBoost * 0.0028 + audioLevel * 0.12);

    renderer.render(scene, camera);
  }

  resizeRenderer();
  setBackgroundTheme("#ff8569", "#0d1424", "#3a1f47");

  return {
    renderFrame,
    resizeRenderer,
    setBackgroundTheme,
  };
}

function initAlbumScene() {
  // Dedicated renderer for the album cover card panel.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  albumCard.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0.05, 5.1);

  const group = new THREE.Group();
  scene.add(group);

  // Canvas-generated texture lets us update title/accent without image assets.
  const coverCanvas = document.createElement("canvas");
  coverCanvas.width = 1024;
  coverCanvas.height = 1024;
  const coverCtx = coverCanvas.getContext("2d");
  if (!coverCtx) {
    throw new Error("Canvas 2D context for album art is unavailable.");
  }
  const coverTexture = new THREE.CanvasTexture(coverCanvas);
  coverTexture.colorSpace = THREE.SRGBColorSpace;
  coverTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const geometry = new THREE.BoxGeometry(2.8, 2.8, 0.2);
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: "#121a2f",
    metalness: 0.32,
    roughness: 0.48,
  });
  const frontMaterial = new THREE.MeshStandardMaterial({
    map: coverTexture,
    metalness: 0.18,
    roughness: 0.4,
  });
  const backMaterial = new THREE.MeshStandardMaterial({
    color: "#0f1528",
    metalness: 0.25,
    roughness: 0.52,
  });
  const cover = new THREE.Mesh(geometry, [
    sideMaterial,
    sideMaterial,
    sideMaterial,
    sideMaterial,
    frontMaterial,
    backMaterial,
  ]);
  cover.castShadow = false;
  cover.receiveShadow = false;
  group.add(cover);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: "#d8e3ff", transparent: true, opacity: 0.2 }),
  );
  group.add(edges);

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 4.2),
    new THREE.MeshBasicMaterial({
      color: "#ff8569",
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.position.set(0, 0, -0.8);
  group.add(glow);

  const ambientLight = new THREE.AmbientLight("#a6bddf", 0.92);
  scene.add(ambientLight);

  const keyLight = new THREE.PointLight("#f6d7c6", 8, 20);
  keyLight.position.set(2.4, 2, 3);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight("#4f7de8", 3.2, 20);
  fillLight.position.set(-2.4, -1.6, 2.5);
  scene.add(fillLight);

  const accentLight = new THREE.PointLight("#ff8569", 5.5, 22);
  accentLight.position.set(0.3, -2, 2.6);
  scene.add(accentLight);

  // Paint album front texture each time track/accent changes.
  function drawCoverArt(accentHex, trackName) {
    const safeTrackName = (trackName || "Neon Tides").toUpperCase();
    const rgb = hexToRgb(accentHex);
    const gradient = coverCtx.createLinearGradient(0, 0, 1024, 1024);
    gradient.addColorStop(0, "rgb(8, 12, 22)");
    gradient.addColorStop(0.55, "rgb(16, 22, 39)");
    gradient.addColorStop(1, "rgb(5, 8, 14)");

    coverCtx.clearRect(0, 0, 1024, 1024);
    coverCtx.fillStyle = gradient;
    coverCtx.fillRect(0, 0, 1024, 1024);

    const halo = coverCtx.createRadialGradient(220, 220, 20, 220, 220, 520);
    halo.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45)`);
    halo.addColorStop(1, "rgba(0, 0, 0, 0)");
    coverCtx.fillStyle = halo;
    coverCtx.fillRect(0, 0, 1024, 1024);

    const edgeHalo = coverCtx.createRadialGradient(860, 860, 30, 860, 860, 560);
    edgeHalo.addColorStop(0, "rgba(255, 255, 255, 0.13)");
    edgeHalo.addColorStop(1, "rgba(0, 0, 0, 0)");
    coverCtx.fillStyle = edgeHalo;
    coverCtx.fillRect(0, 0, 1024, 1024);

    coverCtx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    coverCtx.lineWidth = 1;
    for (let y = 0; y <= 1024; y += 20) {
      coverCtx.beginPath();
      coverCtx.moveTo(0, y);
      coverCtx.lineTo(1024, y);
      coverCtx.stroke();
    }

    coverCtx.fillStyle = "rgba(238, 242, 255, 0.82)";
    coverCtx.font = "500 35px Space Grotesk";
    coverCtx.fillText("LUNAR DISTRICT", 76, 108);

    coverCtx.fillStyle = "rgba(255, 255, 255, 0.95)";
    coverCtx.font = "400 152px 'DM Serif Display'";
    coverCtx.fillText("NEON", 70, 760);
    coverCtx.fillText("TIDES", 70, 890);

    coverCtx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.72)`;
    coverCtx.lineWidth = 5;
    coverCtx.strokeRect(52, 52, 920, 920);

    coverCtx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.88)`;
    coverCtx.font = "600 52px Space Grotesk";
    const titleLines = fitLines(coverCtx, safeTrackName, 860);
    titleLines.forEach((line, index) => {
      coverCtx.fillText(line, 76, 255 + index * 64);
    });

    coverCtx.fillStyle = "rgba(230, 236, 255, 0.72)";
    coverCtx.font = "500 28px Space Grotesk";
    coverCtx.fillText("DELUXE MOTION CUT", 76, 968);

    coverTexture.needsUpdate = true;
  }

  // Scene theme hook called from setActiveScene().
  function setAlbumTheme(accentHex, trackName) {
    const accentColor = new THREE.Color(accentHex);
    accentLight.color.copy(accentColor);
    glow.material.color.copy(accentColor);

    const sideColor = accentColor.clone().lerp(new THREE.Color("#11182a"), 0.72);
    sideMaterial.color.copy(sideColor);

    drawCoverArt(accentHex, trackName);
  }

  // Keep album renderer matched to its card container size.
  function resizeRenderer() {
    const width = Math.max(albumCard.clientWidth, 1);
    const height = Math.max(albumCard.clientHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // Subtle float + tilt, then audio drives extra pulse/scale.
  function renderFrame(timeSeconds) {
    const scrollRange = Math.max(document.body.scrollHeight - window.innerHeight, 1);
    const scrollProgress = window.scrollY / scrollRange;
    const bob = Math.sin(timeSeconds * 1.15) * 0.11;
    const drift = Math.sin(timeSeconds * 0.55) * 0.06;
    const audioTilt = audioLevel * 0.34 + beatPulse * 0.42;
    const targetX = 0.24 - scrollProgress * 0.48 + pointerY * 0.38 + drift + Math.sin(timeSeconds * 3.2) * audioTilt;
    const targetY = -0.56 + scrollProgress * 1.08 + pointerX * 0.56 + Math.cos(timeSeconds * 2.7) * audioTilt;

    group.rotation.x += (targetX - group.rotation.x) * 0.07;
    group.rotation.y += (targetY - group.rotation.y) * 0.07;
    group.position.y += (bob + beatPulse * 0.08 - group.position.y) * 0.06;
    const targetScale = 1 + audioLevel * 0.07 + beatPulse * 0.09;
    group.scale.x += (targetScale - group.scale.x) * 0.1;
    group.scale.y += (targetScale - group.scale.y) * 0.1;
    group.scale.z += (targetScale - group.scale.z) * 0.1;

    keyLight.position.x = 2.4 + pointerX * 1.35 + Math.sin(timeSeconds * 0.85) * 0.28;
    keyLight.position.y = 2 + pointerY * 0.65;
    accentLight.position.y = -1.9 + Math.cos(timeSeconds * 0.75) * 0.24;
    keyLight.intensity = 8 + audioLevel * 3.8 + beatPulse * 4.2;
    fillLight.intensity = 3.2 + audioBass * 2.5;
    accentLight.intensity = 5.5 + audioLevel * 4.6 + beatPulse * 5.4;
    glow.material.opacity = Math.min(0.58, 0.12 + audioLevel * 0.26 + beatPulse * 0.3);

    renderer.render(scene, camera);
  }

  resizeRenderer();

  return {
    renderFrame,
    resizeRenderer,
    setAlbumTheme,
  };
}

function setActiveScene(index) {
  const scene = scenes[index];
  if (!scene) {
    return;
  }

  activeIndex = index;
  root.style.setProperty("--bg1", scene.dataset.bg1);
  root.style.setProperty("--bg2", scene.dataset.bg2);
  root.style.setProperty("--accent", scene.dataset.accent);
  moodTitle.textContent = scene.dataset.moodTitle;
  moodText.textContent = scene.dataset.mood;
  accentRGB = hexToRgb(scene.dataset.accent);

  // Push current scene colors into both renderers.
  backgroundState.setBackgroundTheme(scene.dataset.accent, scene.dataset.bg1, scene.dataset.bg2);
  threeState.setAlbumTheme(scene.dataset.accent, scene.dataset.title);

  scenes.forEach((item, itemIndex) => item.classList.toggle("active", itemIndex === index));
  trackButtons.forEach((button, buttonIndex) => button.classList.toggle("active", buttonIndex === index));
}

// Chooses whichever scene center is closest to a screen anchor line.
function detectActiveScene() {
  const anchor = window.innerHeight * 0.42;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  scenes.forEach((scene, index) => {
    const rect = scene.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const distance = Math.abs(center - anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  if (bestIndex !== activeIndex) {
    setActiveScene(bestIndex);
  }
}

function resizeWaveCanvas() {
  if (!waveCtx) {
    return;
  }

  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  waveCanvas.width = Math.floor(window.innerWidth * ratio);
  waveCanvas.height = Math.floor(window.innerHeight * ratio);
  waveCanvas.style.width = `${window.innerWidth}px`;
  waveCanvas.style.height = `${window.innerHeight}px`;
  waveCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

// Lightweight 2D wave layer rendered above the 3D background.
function drawWaves(timeSeconds) {
  if (!waveCtx) {
    return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  waveCtx.clearRect(0, 0, width, height);
  waveBoost *= 0.93;
  const audioWaveEnergy = audioLevel * 60 + beatPulse * 40;

  for (let line = 0; line < 3; line += 1) {
    const offset = (line + 1) * 0.2;
    const yBase = height * (0.72 + line * 0.08);
    const amplitude = 10 + line * 6 + waveBoost * (0.12 + line * 0.02) + audioWaveEnergy * (0.16 + line * 0.04);
    const speed = 0.75 + line * 0.3 + audioLevel * 0.75;
    const wavelength = 0.013 + line * 0.002;
    const alpha = Math.min(0.45, 0.12 - line * 0.02 + audioLevel * 0.18 + beatPulse * 0.18);

    waveCtx.beginPath();
    waveCtx.lineWidth = 1.2 + line * 0.55 + audioLevel * 1.1 + beatPulse * 0.8;
    waveCtx.strokeStyle = `rgba(${accentRGB.r}, ${accentRGB.g}, ${accentRGB.b}, ${alpha})`;

    for (let x = 0; x <= width; x += 14) {
      const y =
        yBase +
        Math.sin(x * wavelength + timeSeconds * speed + offset * Math.PI) * amplitude +
        Math.sin(x * 0.005 + timeSeconds * 0.7) * (amplitude * 0.22);

      if (x === 0) {
        waveCtx.moveTo(x, y);
      } else {
        waveCtx.lineTo(x, y);
      }
    }
    waveCtx.stroke();
  }
}

// Single master animation loop.
function frame(time) {
  const seconds = time * 0.001;
  updateAudioReactive(seconds);
  backgroundState.renderFrame(seconds);
  threeState.renderFrame(seconds);
  drawWaves(seconds);
  requestAnimationFrame(frame);
}

// Scroll updates scene state and adds inertia to wave/background motion.
window.addEventListener(
  "scroll",
  () => {
    const now = window.scrollY;
    waveBoost = Math.min(48, waveBoost + Math.abs(now - lastScrollY) * 0.14);
    lastScrollY = now;
    detectActiveScene();
  },
  { passive: true },
);

window.addEventListener("resize", () => {
  resizeWaveCanvas();
  backgroundState.resizeRenderer();
  threeState.resizeRenderer();
  detectActiveScene();
});

// Pointer position drives subtle parallax in both 3D scenes.
window.addEventListener(
  "pointermove",
  (event) => {
    pointerX = event.clientX / window.innerWidth - 0.5;
    pointerY = event.clientY / window.innerHeight - 0.5;
  },
  { passive: true },
);

window.addEventListener("pointerleave", () => {
  pointerX = 0;
  pointerY = 0;
});

if (audioToggle) {
  audioToggle.addEventListener("click", () => {
    void toggleAudioPlayback();
  });
}

if (audioFile) {
  audioFile.addEventListener("change", (event) => {
    void handleAudioFileSelection(event);
  });
}

if (audioElement) {
  audioElement.addEventListener("play", () => {
    setAudioButton("Pause Audio");
    setAudioStatus("Audio reactive mode: live.");
  });

  audioElement.addEventListener("pause", () => {
    setAudioButton("Play Audio");
    if (!audioElement.ended) {
      setAudioStatus("Audio paused. Visuals still reactive to scroll.");
    }
  });

  audioElement.addEventListener("ended", () => {
    setAudioButton("Play Audio");
    setAudioStatus("Track ended. Press play to run it again.");
  });
}

window.addEventListener("beforeunload", () => {
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
  }
});

// Track list buttons are scroll shortcuts to their scene sections.
trackButtons.forEach((button, index) => {
  button.addEventListener("click", () => {
    scenes[index].scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  });
});

// Initial UI defaults + first render boot.
setAudioButton("Load Audio");
setAudioMeter(0.03);

resizeWaveCanvas();
setActiveScene(0);
detectActiveScene();
requestAnimationFrame(frame);
