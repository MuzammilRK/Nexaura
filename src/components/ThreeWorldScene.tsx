import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { DeviceProfile, HealthState, LiveDeviceMetrics } from '../shared/schema';
import type { WorldFocus } from '../state/useNexauraStore';

export interface WorldDeviceNode extends DeviceProfile {
  metrics: LiveDeviceMetrics | null;
}

interface ThreeWorldSceneProps {
  devices: WorldDeviceNode[];
  focus: WorldFocus;
  reducedEffects: boolean;
  onSelectFocus: (next: Partial<WorldFocus>) => void;
  onWebglUnavailable: () => void;
}

const HEALTH_HEX: Record<HealthState, number> = {
  Excellent: 0x10b981,
  Good: 0x3b82f6,
  Fair: 0xf59e0b,
  Poor: 0xef4444,
};

function latLonToVec3(lat: number, lon: number, radius: number, out: THREE.Vector3): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  out.set(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
  return out;
}

function createPlaceholderEarthCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#102845');
  grad.addColorStop(0.5, '#0d3b66');
  grad.addColorStop(1, '#102845');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);
  return canvas;
}

function createPlazaAsphaltTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#141923';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle architectural stone paving tiles
  ctx.strokeStyle = '#1e2636';
  ctx.lineWidth = 2;
  const step = 64;
  for (let i = 0; i <= 512; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }

  // Subtle surface variation speckles
  for (let i = 0; i < 650; i++) {
    const x = (i * 73) % 512;
    const y = (i * 139) % 512;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.14)';
    ctx.fillRect(x, y, 3, 3);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createRaisedFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1b2230';
  ctx.fillRect(0, 0, 512, 512);

  const step = 64;
  for (let x = 0; x < 512; x += step) {
    for (let y = 0; y < 512; y += step) {
      const alt = ((x / step + y / step) % 2) === 0;
      ctx.fillStyle = alt ? '#1f2838' : '#1b2332';
      ctx.fillRect(x + 2, y + 2, step - 4, step - 4);

      // Anti-static perforated vents on alternate data-center tiles
      if (alt) {
        ctx.fillStyle = '#10151f';
        for (let px = x + 14; px < x + step - 12; px += 12) {
          for (let py = y + 14; py < y + step - 12; py += 12) {
            ctx.fillRect(px, py, 4, 4);
          }
        }
      }
      // Corner panel screws
      ctx.fillStyle = '#475569';
      ctx.fillRect(x + 4, y + 4, 3, 3);
      ctx.fillRect(x + step - 7, y + 4, 3, 3);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function ThreeWorldScene({
  devices,
  focus,
  reducedEffects,
  onSelectFocus,
  onWebglUnavailable,
}: ThreeWorldSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef(focus);
  const devicesRef = useRef(devices);
  const onSelectRef = useRef(onSelectFocus);
  const reducedRef = useRef(reducedEffects);
  const rebuildSceneRef = useRef<((animateZoom?: boolean) => void) | null>(null);
  const prevFocusKeyRef = useRef<string>('');

  focusRef.current = focus;
  devicesRef.current = devices;
  onSelectRef.current = onSelectFocus;
  reducedRef.current = reducedEffects;

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      try {
        if (navigator.webdriver) return true;
        const probe = document.createElement('canvas').getContext('webgl2');
        if (!probe) return true;
        const ext = probe.getExtension('WEBGL_debug_renderer_info');
        const gpu = ext
          ? String(probe.getParameter(ext.UNMASKED_RENDERER_WEBGL))
          : String(probe.getParameter(probe.RENDERER));
        probe.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render|Mesa/i.test(gpu);
      } catch {
        return true;
      }
    })();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      onWebglUnavailable();
      return;
    }

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = !isSoftwareGl;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090b10);
    scene.fog = new THREE.FogExp2(0x090b10, 0.011);

    if (!isSoftwareGl) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 200);
    latLonToVec3(22, 42, 14.6, camera.position);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.minDistance = 4.2;
    controls.maxDistance = 32;

    // Calibrated lighting rig for both globe and architectural PBR towers
    const hemi = new THREE.HemisphereLight(0xeef6ff, 0x1e293b, 1.45);
    scene.add(hemi);
    const keyLight = new THREE.DirectionalLight(0xfffaf0, 1.75);
    keyLight.position.set(14, 18, 16);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.85);
    fillLight.position.set(-14, 6, -12);
    scene.add(fillLight);

    const dynamicRoot = new THREE.Group();
    scene.add(dynamicRoot);

    const auraRings: { mesh: THREE.Mesh; speed: number; baseScale: number }[] = [];
    const clickables: THREE.Object3D[] = [];

    let zoomAnimating = false;
    const desiredCamPos = camera.position.clone();
    const desiredTarget = controls.target.clone();
    let frameId = 0;
    let disposed = false;
    let renderBusy = false;
    let renderDirty = false;

    function updateCameraAttr() {
      if (!container) return;
      container.dataset.cameraDist = camera.position.distanceTo(controls.target).toFixed(2);
    }
    updateCameraAttr();

    function stepZoomAnimation(dt: number) {
      if (!zoomAnimating) return;
      const alpha = isSoftwareGl ? 0.42 : 1 - Math.exp(-6.5 * Math.min(dt, 0.05));
      camera.position.lerp(desiredCamPos, alpha);
      controls.target.lerp(desiredTarget, alpha);
      controls.update();
      updateCameraAttr();
      if (
        camera.position.distanceTo(desiredCamPos) < 0.08 &&
        controls.target.distanceTo(desiredTarget) < 0.05
      ) {
        camera.position.copy(desiredCamPos);
        controls.target.copy(desiredTarget);
        controls.update();
        updateCameraAttr();
        zoomAnimating = false;
      }
    }

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) {
        frameId = window.setTimeout(cb, 45);
        return;
      }
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 45);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function requestRender() {
      if (disposed) return;
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame(() => {
        if (disposed) return;
        renderDirty = false;
        if (isSoftwareGl && zoomAnimating) {
          stepZoomAnimation(0.12);
        } else {
          controls.update();
        }
        renderer.render(scene, camera);
        updateCameraAttr();
        const done = () => {
          renderBusy = false;
          if (renderDirty || (isSoftwareGl && zoomAnimating)) {
            requestRender();
          }
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    function startZoomTo(camPos: THREE.Vector3, targetPos: THREE.Vector3, immediate = false) {
      desiredCamPos.copy(camPos);
      desiredTarget.copy(targetPos);
      if (immediate) {
        zoomAnimating = false;
        camera.position.copy(camPos);
        controls.target.copy(targetPos);
        controls.update();
        updateCameraAttr();
        if (isSoftwareGl) requestRender();
      } else {
        zoomAnimating = true;
        if (isSoftwareGl) requestRender();
      }
    }

    controls.addEventListener('start', () => {
      zoomAnimating = false;
    });

    // Procedural architectural floor textures
    const plazaTex = createPlazaAsphaltTexture();
    const raisedFloorTex = createRaisedFloorTexture();
    const disposableTextures: THREE.Texture[] = [plazaTex, raisedFloorTex];

    // Load Earth diffuse map
    const placeholderCanvas = createPlaceholderEarthCanvas();
    const placeholderTexture = new THREE.CanvasTexture(placeholderCanvas);
    placeholderTexture.colorSpace = THREE.SRGBColorSpace;
    placeholderTexture.flipY = false;

    let activeEarthTexture: THREE.Texture = placeholderTexture;
    let hiResEarthTexture: THREE.CanvasTexture | null = null;
    let activeGlobeMat: THREE.MeshStandardMaterial | null = null;

    const earthImg = new Image();
    earthImg.decoding = 'async';
    earthImg.onload = () => {
      if (disposed) return;
      const maxDim = renderer.capabilities.maxTextureSize || 2048;
      const targetW = isSoftwareGl ? Math.min(2048, maxDim) : Math.min(4096, maxDim);
      const targetH = Math.round(targetW / 2);
      const hiResCanvas = document.createElement('canvas');
      hiResCanvas.width = targetW;
      hiResCanvas.height = targetH;
      const ctx = hiResCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(earthImg, 0, 0, targetW, targetH);
        hiResEarthTexture = new THREE.CanvasTexture(hiResCanvas);
        hiResEarthTexture.colorSpace = THREE.SRGBColorSpace;
        hiResEarthTexture.flipY = false;
        hiResEarthTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        hiResEarthTexture.needsUpdate = true;
        activeEarthTexture = hiResEarthTexture;
        if (activeGlobeMat) {
          activeGlobeMat.map = activeEarthTexture;
          activeGlobeMat.needsUpdate = true;
        }
        if (isSoftwareGl) requestRender();
      }
    };
    earthImg.src = '/assets/aistudio/Material.002_diffuse_f7568691.jpeg';

    // Load 5 matched PBR building facade textures (baseColor, emissive, normal, metallicRoughness, clearcoat)
    const pbrTex: {
      baseColor: THREE.CanvasTexture | null;
      emissive: THREE.CanvasTexture | null;
      normal: THREE.CanvasTexture | null;
      metallicRoughness: THREE.CanvasTexture | null;
      clearcoat: THREE.CanvasTexture | null;
    } = {
      baseColor: null,
      emissive: null,
      normal: null,
      metallicRoughness: null,
      clearcoat: null,
    };

    const buildingMaterials: (THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial)[] = [];

    const loadPbrMap = (
      url: string,
      key: keyof typeof pbrTex,
      colorSpace: THREE.ColorSpace
    ) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (disposed) return;
        const target = isSoftwareGl ? 512 : 1024;
        const c = document.createElement('canvas');
        c.width = target;
        c.height = target;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, target, target);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = colorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1, 2);
        tex.needsUpdate = true;
        pbrTex[key] = tex;
        disposableTextures.push(tex);

        // Bind loaded texture onto active building facade materials
        for (const mat of buildingMaterials) {
          if (key === 'baseColor') {
            mat.map = tex;
            mat.color.setHex(0xffffff);
          } else if (key === 'emissive') {
            mat.emissiveMap = tex;
            mat.emissive.setHex(0xffffff);
            mat.emissiveIntensity = 1.05;
          } else if (key === 'normal') {
            mat.normalMap = tex;
            mat.normalScale.set(0.75, 0.75);
          } else if (key === 'metallicRoughness') {
            mat.roughnessMap = tex;
            mat.metalnessMap = tex;
          } else if (key === 'clearcoat' && mat instanceof THREE.MeshPhysicalMaterial) {
            mat.clearcoatMap = tex;
            mat.clearcoat = 0.65;
          }
          mat.needsUpdate = true;
        }
        if (isSoftwareGl || focusRef.current.level === 'city' || focusRef.current.level === 'district') {
          requestRender();
        }
      };
      img.src = url;
    };

    loadPbrMap('/assets/aistudio/Background_Night_Buildings_baseColor_253c4c55.png', 'baseColor', THREE.SRGBColorSpace);
    loadPbrMap('/assets/aistudio/Background_Night_Buildings_emissive_2f904ebb.png', 'emissive', THREE.SRGBColorSpace);
    loadPbrMap('/assets/aistudio/Background_Night_Buildings_normal_9325e688.png', 'normal', THREE.NoColorSpace);
    loadPbrMap('/assets/aistudio/Background_Night_Buildings_metallicRoughness_b600440b.png', 'metallicRoughness', THREE.NoColorSpace);
    loadPbrMap('/assets/aistudio/Background_Night_Buildings_clearcoat_a4e28c03.png', 'clearcoat', THREE.NoColorSpace);

    function createBuildingFacadeMaterial(connected: boolean): THREE.MeshStandardMaterial {
      const sharedOpts = {
        color: pbrTex.baseColor ? 0xffffff : connected ? 0x263449 : 0x1b2230,
        map: pbrTex.baseColor ?? null,
        emissive: pbrTex.emissive ? 0xffffff : 0x0d1522,
        emissiveMap: pbrTex.emissive ?? null,
        emissiveIntensity: pbrTex.emissive ? (connected ? 1.1 : 0.72) : 0.12,
        normalMap: pbrTex.normal ?? null,
        roughnessMap: pbrTex.metallicRoughness ?? null,
        metalnessMap: pbrTex.metallicRoughness ?? null,
        roughness: 0.42,
        metalness: 0.65,
      };
      const mat = isSoftwareGl
        ? new THREE.MeshStandardMaterial(sharedOpts)
        : new THREE.MeshPhysicalMaterial({
            ...sharedOpts,
            clearcoat: 0.65,
            clearcoatRoughness: 0.22,
            clearcoatMap: pbrTex.clearcoat ?? null,
          });
      buildingMaterials.push(mat);
      return mat;
    }

    const _v1 = new THREE.Vector3();
    const _v2 = new THREE.Vector3();
    const _mid = new THREE.Vector3();

    function clearDynamicRoot() {
      auraRings.length = 0;
      clickables.length = 0;
      buildingMaterials.length = 0;
      while (dynamicRoot.children.length > 0) {
        const child = dynamicRoot.children[0];
        dynamicRoot.remove(child);
      }
    }

    function worstHealth(list: WorldDeviceNode[]): { state: HealthState; avgLatency: number } {
      let worst: HealthState = 'Excellent';
      let sumLat = 0;
      let count = 0;
      const rank: Record<HealthState, number> = { Excellent: 0, Good: 1, Fair: 2, Poor: 3 };
      for (const d of list) {
        const st = d.metrics?.healthState ?? 'Good';
        if (rank[st] > rank[worst]) worst = st;
        sumLat += d.metrics?.latencyMs ?? 25;
        count++;
      }
      return { state: worst, avgLatency: count > 0 ? sumLat / count : 25 };
    }

    function buildGlobeAndRegionalView(
      currentFocus: WorldFocus,
      allDevices: WorldDeviceNode[],
      animateZoom: boolean,
      isInitialMount: boolean
    ) {
      const globeGroup = new THREE.Group();
      const sphereGeo = new THREE.SphereGeometry(5, isSoftwareGl ? 40 : 64, isSoftwareGl ? 28 : 48);
      const sphereMat = new THREE.MeshStandardMaterial({
        map: activeEarthTexture,
        roughness: 0.72,
        metalness: 0.05,
      });
      activeGlobeMat = sphereMat;
      const globeMesh = new THREE.Mesh(sphereGeo, sphereMat);
      globeMesh.userData.onClickPoint = (hitPoint: THREE.Vector3) => {
        const dir = hitPoint.clone().normalize();
        const curDist = camera.position.length();
        const targetDist =
          currentFocus.level === 'globe'
            ? Math.max(8.8, Math.min(10.6, curDist * 0.72))
            : Math.max(7.2, curDist * 0.8);
        startZoomTo(dir.clone().multiplyScalar(targetDist), new THREE.Vector3(0, 0, 0), false);

        let bestDev: WorldDeviceNode | null = null;
        let bestDist = Infinity;
        const candidateDevices =
          currentFocus.countryCode && currentFocus.level === 'country'
            ? allDevices.filter((d) => d.countryCode === currentFocus.countryCode)
            : allDevices;
        for (const d of candidateDevices) {
          const p = latLonToVec3(d.lat, d.lon, 5.0, new THREE.Vector3());
          const dist = p.distanceTo(hitPoint);
          if (dist < bestDist) {
            bestDist = dist;
            bestDev = d;
          }
        }
        if (bestDev && bestDist < 3.8) {
          if (currentFocus.level === 'globe') {
            onSelectRef.current({ level: 'country', countryCode: bestDev.countryCode });
          } else if (currentFocus.level === 'country') {
            onSelectRef.current({
              level: 'city',
              countryCode: bestDev.countryCode,
              cityCode: bestDev.cityCode,
            });
          }
        }
      };
      globeGroup.add(globeMesh);
      clickables.push(globeMesh);

      const atmoGeo = new THREE.SphereGeometry(5.1, 36, 24);
      const atmoMat = new THREE.MeshBasicMaterial({
        color: 0x3b82f6,
        transparent: true,
        opacity: 0.08,
        side: THREE.BackSide,
      });
      globeGroup.add(new THREE.Mesh(atmoGeo, atmoMat));

      dynamicRoot.add(globeGroup);

      const filtered = allDevices.filter((d) =>
        currentFocus.countryCode ? d.countryCode === currentFocus.countryCode : true
      );

      const cityGroups = new Map<string, WorldDeviceNode[]>();
      for (const d of filtered) {
        const key = currentFocus.level === 'globe' ? d.countryCode : d.cityCode;
        const arr = cityGroups.get(key) ?? [];
        arr.push(d);
        cityGroups.set(key, arr);
      }

      const anchors: THREE.Vector3[] = [];
      const focusCentroid = new THREE.Vector3();
      let anchorCount = 0;

      for (const [key, list] of cityGroups.entries()) {
        const sample = list[0];
        const pos = latLonToVec3(sample.lat, sample.lon, 5.03, new THREE.Vector3());
        anchors.push(pos);
        focusCentroid.add(pos);
        anchorCount++;

        const { state, avgLatency } = worstHealth(list);
        const colorHex = HEALTH_HEX[state];

        const beacon = new THREE.Group();
        beacon.position.copy(pos);
        beacon.lookAt(pos.clone().multiplyScalar(2));

        const baseMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.19, 0.12, 16),
          new THREE.MeshStandardMaterial({ color: 0x181c25, roughness: 0.4, metalness: 0.7 })
        );
        baseMesh.rotation.x = Math.PI / 2;
        beacon.add(baseMesh);

        const spireMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.075, 0.48, 12),
          new THREE.MeshStandardMaterial({
            color: colorHex,
            emissive: colorHex,
            emissiveIntensity: 0.7,
            roughness: 0.25,
            metalness: 0.3,
          })
        );
        spireMesh.rotation.x = Math.PI / 2;
        spireMesh.position.z = 0.24;
        beacon.add(spireMesh);

        const auraMesh = new THREE.Mesh(
          new THREE.TorusGeometry(0.24, 0.02, 8, 28),
          new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.72 })
        );
        auraMesh.position.z = 0.07;
        beacon.add(auraMesh);
        auraRings.push({
          mesh: auraMesh,
          speed: 1.4 + Math.min(3.5, avgLatency / 50),
          baseScale: 1,
        });

        const hit = new THREE.Mesh(
          new THREE.SphereGeometry(0.42, 10, 10),
          new THREE.MeshBasicMaterial({ visible: false })
        );
        hit.userData.onClick = () => {
          const camDir = pos.clone().normalize();
          if (currentFocus.level === 'globe') {
            startZoomTo(camDir.multiplyScalar(10.0), new THREE.Vector3(0, 0, 0), false);
            onSelectRef.current({ level: 'country', countryCode: sample.countryCode });
          } else {
            startZoomTo(camDir.multiplyScalar(8.4), new THREE.Vector3(0, 0, 0), false);
            onSelectRef.current({
              level: 'city',
              countryCode: sample.countryCode,
              cityCode: sample.cityCode,
            });
          }
        };
        beacon.add(hit);
        clickables.push(hit);
        dynamicRoot.add(beacon);
        void key;
      }

      for (let i = 0; i < anchors.length - 1; i++) {
        _v1.copy(anchors[i]);
        _v2.copy(anchors[(i + 1) % anchors.length]);
        _mid.copy(_v1).add(_v2).multiplyScalar(0.5).normalize().multiplyScalar(6.15);
        const curve = new THREE.QuadraticBezierCurve3(_v1.clone(), _mid.clone(), _v2.clone());
        const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.018, 6, false);
        const tubeMat = new THREE.MeshBasicMaterial({
          color: 0x60a5fa,
          transparent: true,
          opacity: 0.42,
        });
        dynamicRoot.add(new THREE.Mesh(tubeGeo, tubeMat));
      }

      if (animateZoom) {
        if (currentFocus.level === 'country' && anchorCount > 0) {
          const dir = focusCentroid.divideScalar(anchorCount).normalize();
          startZoomTo(dir.multiplyScalar(10.0), new THREE.Vector3(0, 0, 0), false);
        } else if (currentFocus.level === 'globe') {
          const defaultOverview = latLonToVec3(22, 42, 14.6, new THREE.Vector3());
          startZoomTo(defaultOverview, new THREE.Vector3(0, 0, 0), isInitialMount);
        }
      }
    }

    function buildLocalSiteView(
      currentFocus: WorldFocus,
      allDevices: WorldDeviceNode[],
      animateZoom: boolean
    ) {
      const scoped = allDevices.filter((d) => {
        if (currentFocus.countryCode && d.countryCode !== currentFocus.countryCode) return false;
        if (currentFocus.cityCode && d.cityCode !== currentFocus.cityCode) return false;
        if (currentFocus.districtCode && d.districtCode !== currentFocus.districtCode) return false;
        if (currentFocus.buildingCode && d.buildingCode !== currentFocus.buildingCode) return false;
        if (currentFocus.floorNumber && d.floorNumber !== currentFocus.floorNumber) return false;
        return true;
      });

      // Architectural Floor / Ground Slab
      if (currentFocus.level === 'city' || currentFocus.level === 'district') {
        const plazaBase = new THREE.Mesh(
          new THREE.BoxGeometry(44, 0.24, 34),
          new THREE.MeshStandardMaterial({
            map: plazaTex,
            roughness: 0.85,
            metalness: 0.12,
          })
        );
        plazaBase.position.y = -0.12;
        dynamicRoot.add(plazaBase);

        // Avenue boulevard & central fiber spine trench
        const avenueMat = new THREE.MeshStandardMaterial({
          color: 0x0f141e,
          roughness: 0.9,
          metalness: 0.08,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        });
        const frontAve = new THREE.Mesh(new THREE.PlaneGeometry(42, 2.2), avenueMat);
        frontAve.rotation.x = -Math.PI / 2;
        frontAve.position.set(0, 0.01, 3.3);
        dynamicRoot.add(frontAve);

        const backAve = new THREE.Mesh(new THREE.PlaneGeometry(42, 2.2), avenueMat);
        backAve.rotation.x = -Math.PI / 2;
        backAve.position.set(0, 0.01, -3.5);
        dynamicRoot.add(backAve);

        // Dashed road lane markers
        const stripeMat = new THREE.MeshBasicMaterial({
          color: 0x475569,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        });
        for (let sx = -18; sx <= 18; sx += 2.4) {
          const dashF = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.08), stripeMat);
          dashF.rotation.x = -Math.PI / 2;
          dashF.position.set(sx, 0.02, 3.3);
          dynamicRoot.add(dashF);

          const dashB = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.08), stripeMat);
          dashB.rotation.x = -Math.PI / 2;
          dashB.position.set(sx, 0.02, -3.5);
          dynamicRoot.add(dashB);
        }

        // Connected Monitored Nexaura Buildings along main tech boulevard
        const bMap = new Map<string, WorldDeviceNode[]>();
        for (const d of scoped) {
          const arr = bMap.get(d.buildingCode) ?? [];
          arr.push(d);
          bMap.set(d.buildingCode, arr);
        }
        const entries = Array.from(bMap.entries());
        const spacing = 4.4;
        const startX = -((entries.length - 1) * spacing) / 2;
        const connectedTopAnchorPts: THREE.Vector3[] = [];

        entries.forEach(([bCode, list], idx) => {
          const sample = list[0];
          const { state, avgLatency } = worstHealth(list);
          const colorHex = HEALTH_HEX[state];
          const x = startX + idx * spacing;
          const bHeight = 3.5 + (idx % 3) * 0.65;

          const bGroup = new THREE.Group();
          bGroup.position.set(x, 0, 0);

          // Stepped granite/concrete architectural podium
          const plinth1 = new THREE.Mesh(
            new THREE.BoxGeometry(2.9, 0.24, 2.7),
            new THREE.MeshStandardMaterial({ color: 0x1c2432, roughness: 0.72, metalness: 0.22 })
          );
          plinth1.position.y = 0.12;
          bGroup.add(plinth1);

          const plinth2 = new THREE.Mesh(
            new THREE.BoxGeometry(2.45, 0.22, 2.25),
            new THREE.MeshStandardMaterial({ color: 0x263144, roughness: 0.58, metalness: 0.35 })
          );
          plinth2.position.y = 0.35;
          bGroup.add(plinth2);

          // Main tower body with PBR Night Building maps
          const tower = new THREE.Mesh(
            new THREE.BoxGeometry(2.05, bHeight, 1.9),
            createBuildingFacadeMaterial(true)
          );
          tower.position.y = 0.46 + bHeight / 2;
          bGroup.add(tower);

          // Architectural cornice & mechanical penthouse
          const cornice = new THREE.Mesh(
            new THREE.BoxGeometry(2.18, 0.16, 2.02),
            new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.7 })
          );
          cornice.position.y = 0.46 + bHeight + 0.08;
          bGroup.add(cornice);

          const penthouse = new THREE.Mesh(
            new THREE.BoxGeometry(1.1, 0.36, 1.0),
            new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5, metalness: 0.6 })
          );
          penthouse.position.y = 0.46 + bHeight + 0.34;
          bGroup.add(penthouse);

          // Connected Nexaura telemetry beacon mast
          const roofBeaconY = 0.46 + bHeight + 0.72;
          const roofCol = new THREE.Mesh(
            new THREE.CylinderGeometry(0.11, 0.18, 0.46, 12),
            new THREE.MeshStandardMaterial({
              color: colorHex,
              emissive: colorHex,
              emissiveIntensity: 0.8,
              roughness: 0.25,
              metalness: 0.4,
            })
          );
          roofCol.position.y = roofBeaconY;
          bGroup.add(roofCol);
          connectedTopAnchorPts.push(new THREE.Vector3(x, roofBeaconY + 0.18, 0));

          // Ground health ring
          const halo = new THREE.Mesh(
            new THREE.TorusGeometry(1.62, 0.04, 8, 36),
            new THREE.MeshBasicMaterial({
              color: colorHex,
              transparent: true,
              opacity: 0.85,
              polygonOffset: true,
              polygonOffsetFactor: -1,
            })
          );
          halo.rotation.x = Math.PI / 2;
          halo.position.y = 0.06;
          bGroup.add(halo);
          auraRings.push({ mesh: halo, speed: 1.4 + avgLatency / 45, baseScale: 1 });

          const hit = new THREE.Mesh(
            new THREE.BoxGeometry(2.9, bHeight + 1.4, 2.7),
            new THREE.MeshBasicMaterial({ visible: false })
          );
          hit.position.y = 2.2;
          hit.userData.onClick = () => {
            onSelectRef.current({
              level: 'building',
              countryCode: sample.countryCode,
              cityCode: sample.cityCode,
              districtCode: sample.districtCode,
              buildingCode: bCode,
            });
          };
          bGroup.add(hit);
          clickables.push(hit);
          dynamicRoot.add(bGroup);
        });

        // Fiber optic trunk links between connected Nexaura buildings
        for (let i = 0; i < connectedTopAnchorPts.length - 1; i++) {
          const pA = connectedTopAnchorPts[i];
          const pB = connectedTopAnchorPts[i + 1];
          const mid = pA.clone().add(pB).multiplyScalar(0.5);
          mid.y += 0.9;
          const curve = new THREE.QuadraticBezierCurve3(pA, mid, pB);
          const fiberMesh = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 18, 0.032, 6, false),
            new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.78 })
          );
          dynamicRoot.add(fiberMesh);
        }

        // Surrounding Unconnected Urban Buildings (No Nexaura beacons, halos, or fiber links)
        const surroundingSpecs: { x: number; z: number; w: number; d: number; h: number }[] = [
          // Back city blocks (behind north avenue)
          { x: -13.5, z: -7.5, w: 2.6, d: 2.4, h: 4.8 },
          { x: -9.2, z: -8.2, w: 2.3, d: 2.8, h: 6.4 },
          { x: -5.0, z: -7.2, w: 2.8, d: 2.2, h: 4.1 },
          { x: -0.6, z: -8.6, w: 2.4, d: 2.6, h: 7.2 },
          { x: 4.0, z: -7.6, w: 2.7, d: 2.3, h: 5.5 },
          { x: 8.8, z: -8.3, w: 2.3, d: 2.5, h: 6.1 },
          { x: 13.4, z: -7.4, w: 2.6, d: 2.4, h: 4.5 },
          // Outer left & right skyline flanks on central block
          { x: -12.6, z: 0.2, w: 2.4, d: 2.2, h: 5.2 },
          { x: -16.2, z: -1.4, w: 2.2, d: 2.6, h: 3.9 },
          { x: 12.6, z: -0.2, w: 2.4, d: 2.2, h: 5.4 },
          { x: 16.2, z: 0.6, w: 2.3, d: 2.4, h: 4.1 },
          // Foreground / south avenue perimeter towers
          { x: -11.5, z: 7.4, w: 2.5, d: 2.1, h: 3.2 },
          { x: -6.8, z: 7.9, w: 2.2, d: 2.2, h: 3.7 },
          { x: 7.2, z: 7.6, w: 2.4, d: 2.1, h: 3.4 },
          { x: 12.0, z: 7.3, w: 2.6, d: 2.2, h: 3.9 },
          { x: -15.5, z: 6.8, w: 2.1, d: 2.3, h: 4.4 },
          { x: 15.8, z: 6.9, w: 2.2, d: 2.2, h: 4.6 },
        ];

        for (const spec of surroundingSpecs) {
          const sGroup = new THREE.Group();
          sGroup.position.set(spec.x, 0, spec.z);

          const pad = new THREE.Mesh(
            new THREE.BoxGeometry(spec.w + 0.35, 0.18, spec.d + 0.35),
            new THREE.MeshStandardMaterial({ color: 0x161c28, roughness: 0.85, metalness: 0.15 })
          );
          pad.position.y = 0.09;
          sGroup.add(pad);

          const mass = new THREE.Mesh(
            new THREE.BoxGeometry(spec.w, spec.h, spec.d),
            createBuildingFacadeMaterial(false)
          );
          mass.position.y = 0.18 + spec.h / 2;
          sGroup.add(mass);

          const cap = new THREE.Mesh(
            new THREE.BoxGeometry(spec.w + 0.08, 0.12, spec.d + 0.08),
            new THREE.MeshStandardMaterial({ color: 0x222938, roughness: 0.6, metalness: 0.5 })
          );
          cap.position.y = 0.18 + spec.h + 0.06;
          sGroup.add(cap);

          dynamicRoot.add(sGroup);
        }

        if (animateZoom) {
          startZoomTo(new THREE.Vector3(0, 7.8, 14.5), new THREE.Vector3(0, 1.5, -0.8), false);
        }
        return;
      }

      if (currentFocus.level === 'building') {
        const bldgLight = new THREE.PointLight(0xf1f5f9, 2.3, 28, 1.2);
        bldgLight.position.set(3.5, 8.5, 5.5);
        dynamicRoot.add(bldgLight);

        const plazaFloor = new THREE.Mesh(
          new THREE.BoxGeometry(18, 0.24, 14),
          new THREE.MeshStandardMaterial({ map: plazaTex, roughness: 0.85, metalness: 0.12 })
        );
        plazaFloor.position.y = -0.12;
        dynamicRoot.add(plazaFloor);

        const floors = Array.from(new Set(scoped.map((d) => d.floorNumber))).sort((a, b) => a - b);
        const totalFloorsHeight = Math.max(1, floors.length) * 2.1 + 0.8;

        // Building structural core pedestal & corner steel columns
        const coreBase = new THREE.Mesh(
          new THREE.BoxGeometry(7.2, 0.28, 5.0),
          new THREE.MeshStandardMaterial({ color: 0x222c3e, roughness: 0.65, metalness: 0.3 })
        );
        coreBase.position.y = 0.14;
        dynamicRoot.add(coreBase);

        const colMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.35, metalness: 0.78 });
        for (const cx of [-3.1, 3.1]) {
          for (const cz of [-2.05, 2.05]) {
            const col = new THREE.Mesh(new THREE.BoxGeometry(0.18, totalFloorsHeight, 0.18), colMat);
            col.position.set(cx, totalFloorsHeight / 2 + 0.2, cz);
            dynamicRoot.add(col);
          }
        }

        // Vertical fiber riser pipe along rear core
        const riserPipe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.065, 0.065, totalFloorsHeight, 12),
          new THREE.MeshStandardMaterial({
            color: 0x3b82f6,
            emissive: 0x1d4ed8,
            emissiveIntensity: 0.6,
            roughness: 0.3,
            metalness: 0.6,
          })
        );
        riserPipe.position.set(0, totalFloorsHeight / 2 + 0.2, -1.7);
        dynamicRoot.add(riserPipe);

        floors.forEach((fNum, idx) => {
          const floorDevs = scoped.filter((d) => d.floorNumber === fNum);
          const { state, avgLatency } = worstHealth(floorDevs);
          const colorHex = HEALTH_HEX[state];
          const y = 0.65 + idx * 2.1;

          const fGroup = new THREE.Group();
          fGroup.position.set(0, y, 0);

          // Floor deck with raised data-center tile texture
          const slab = new THREE.Mesh(
            new THREE.BoxGeometry(6.4, 0.24, 4.3),
            new THREE.MeshStandardMaterial({
              map: raisedFloorTex,
              roughness: 0.45,
              metalness: 0.42,
            })
          );
          fGroup.add(slab);

          // Aluminum fascia + tinted glass safety edge along front deck
          const glassRail = new THREE.Mesh(
            new THREE.BoxGeometry(6.35, 0.42, 0.05),
            new THREE.MeshStandardMaterial({
              color: 0x38bdf8,
              transparent: true,
              opacity: 0.22,
              roughness: 0.15,
              metalness: 0.2,
            })
          );
          glassRail.position.set(0, 0.33, 2.1);
          fGroup.add(glassRail);

          // IDF Floor Switch Rack + status strip
          const idfCabinet = new THREE.Mesh(
            new THREE.BoxGeometry(0.9, 1.05, 0.65),
            new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.38, metalness: 0.78 })
          );
          idfCabinet.position.set(0, 0.64, -1.25);
          fGroup.add(idfCabinet);

          const swLedBar = new THREE.Mesh(
            new THREE.BoxGeometry(0.72, 0.12, 0.06),
            new THREE.MeshStandardMaterial({
              color: colorHex,
              emissive: colorHex,
              emissiveIntensity: 0.85,
              roughness: 0.2,
              metalness: 0.4,
            })
          );
          swLedBar.position.set(0, 0.92, -0.91);
          fGroup.add(swLedBar);

          // Floor health ring around IDF switch
          const aura = new THREE.Mesh(
            new THREE.TorusGeometry(0.85, 0.03, 8, 32),
            new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.78 })
          );
          aura.rotation.x = Math.PI / 2;
          aura.position.set(0, 0.15, -1.25);
          fGroup.add(aura);
          auraRings.push({ mesh: aura, speed: 1.4 + avgLatency / 45, baseScale: 1 });

          // Sample desk cluster indicator per floor
          const clusterCount = Math.min(3, Math.max(1, floorDevs.length));
          for (let ci = 0; ci < clusterCount; ci++) {
            const dx = (ci - (clusterCount - 1) / 2) * 1.65;
            const miniDesk = new THREE.Mesh(
              new THREE.BoxGeometry(0.95, 0.08, 0.55),
              new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5, metalness: 0.5 })
            );
            miniDesk.position.set(dx, 0.46, 0.8);
            fGroup.add(miniDesk);
            const miniScreen = new THREE.Mesh(
              new THREE.BoxGeometry(0.45, 0.3, 0.05),
              new THREE.MeshStandardMaterial({
                color: 0x60a5fa,
                emissive: 0x2563eb,
                emissiveIntensity: 0.55,
              })
            );
            miniScreen.position.set(dx, 0.72, 0.65);
            fGroup.add(miniScreen);
          }

          const hit = new THREE.Mesh(
            new THREE.BoxGeometry(6.6, 1.5, 4.5),
            new THREE.MeshBasicMaterial({ visible: false })
          );
          hit.userData.onClick = () => {
            onSelectRef.current({ level: 'floor', floorNumber: fNum });
          };
          fGroup.add(hit);
          clickables.push(hit);
          dynamicRoot.add(fGroup);
        });

        if (animateZoom) {
          startZoomTo(new THREE.Vector3(7.2, 5.4, 8.6), new THREE.Vector3(0, 2.2, 0), false);
        }
        return;
      }

      // FLOOR VIEW: Data-center raised floor, 42U Collector Server Cabinet & Multi-Part Engineering Desks
      const roomWidth = Math.max(12, scoped.length * 3.4 + 4.5);
      const ceilLight = new THREE.PointLight(0xf8fafc, 2.6, 30, 1.2);
      ceilLight.position.set(0, 5.4, 1.0);
      dynamicRoot.add(ceilLight);

      const frontFill = new THREE.PointLight(0x93c5fd, 1.2, 22, 1.3);
      frontFill.position.set(-4, 3.4, 5.8);
      dynamicRoot.add(frontFill);

      const raisedSlab = new THREE.Mesh(
        new THREE.BoxGeometry(roomWidth, 0.24, 10.5),
        new THREE.MeshStandardMaterial({
          map: raisedFloorTex,
          roughness: 0.48,
          metalness: 0.35,
        })
      );
      raisedSlab.position.y = -0.12;
      dynamicRoot.add(raisedSlab);

      // Recessed cable-tray strip connecting server rack bay to workstation row
      const cableTrench = new THREE.Mesh(
        new THREE.PlaneGeometry(roomWidth - 1.6, 0.65),
        new THREE.MeshStandardMaterial({
          color: 0x0f172a,
          roughness: 0.7,
          metalness: 0.3,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        })
      );
      cableTrench.rotation.x = -Math.PI / 2;
      cableTrench.position.set(0, 0.01, -0.35);
      dynamicRoot.add(cableTrench);

      // Back acoustic glass / brushed slate server bay wall + architectural cornice trim
      const backWall = new THREE.Mesh(
        new THREE.BoxGeometry(roomWidth, 2.8, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x1e2738, roughness: 0.58, metalness: 0.32 })
      );
      backWall.position.set(0, 1.4, -5.0);
      dynamicRoot.add(backWall);

      const wallTrim = new THREE.Mesh(
        new THREE.BoxGeometry(roomWidth, 0.1, 0.18),
        new THREE.MeshStandardMaterial({ color: 0x3b4861, roughness: 0.4, metalness: 0.7 })
      );
      wallTrim.position.set(0, 2.82, -5.0);
      dynamicRoot.add(wallTrim);

      // Multi-part 42U Nexaura Collector Server Cabinet
      const hubPos = new THREE.Vector3(0, 0, -2.9);
      const hubGroup = new THREE.Group();
      hubGroup.position.copy(hubPos);

      // Steel rack plinth + cabinet frame (grounded cleanly at y=0)
      const rackBase = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.14, 1.15),
        new THREE.MeshStandardMaterial({ color: 0x2a364b, roughness: 0.5, metalness: 0.65 })
      );
      rackBase.position.y = 0.07;
      hubGroup.add(rackBase);

      const rackBody = new THREE.Mesh(
        new THREE.BoxGeometry(1.36, 2.15, 1.02),
        new THREE.MeshStandardMaterial({ color: 0x1c2536, roughness: 0.38, metalness: 0.72 })
      );
      rackBody.position.y = 0.14 + 2.15 / 2;
      hubGroup.add(rackBody);

      // Front glass/bezel rail edges
      const sideTrimMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.32, metalness: 0.78 });
      const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.15, 0.06), sideTrimMat);
      leftRail.position.set(-0.64, 1.21, 0.51);
      const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.15, 0.06), sideTrimMat);
      rightRail.position.set(0.64, 1.21, 0.51);
      hubGroup.add(leftRail, rightRail);

      // 6 Hot-Swap Collector & Switch Blade Modules with status LED strips
      for (let b = 0; b < 6; b++) {
        const bladeY = 0.42 + b * 0.29;
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(1.12, 0.22, 0.05),
          new THREE.MeshStandardMaterial({ color: 0x1e2533, roughness: 0.35, metalness: 0.72 })
        );
        blade.position.set(0, bladeY, 0.52);
        hubGroup.add(blade);

        const isActiveBlue = b % 2 === 0;
        const ledColor = isActiveBlue ? 0x3b82f6 : 0x10b981;
        const ledStrip = new THREE.Mesh(
          new THREE.BoxGeometry(0.86, 0.04, 0.025),
          new THREE.MeshStandardMaterial({
            color: ledColor,
            emissive: ledColor,
            emissiveIntensity: 0.9,
          })
        );
        ledStrip.position.set(-0.04, bladeY, 0.548);
        hubGroup.add(ledStrip);
      }

      // Top Fiber Waterfall Duct & Status Beacon
      const topHood = new THREE.Mesh(
        new THREE.BoxGeometry(1.42, 0.16, 1.06),
        new THREE.MeshStandardMaterial({ color: 0x253042, roughness: 0.4, metalness: 0.75 })
      );
      topHood.position.y = 2.36;
      hubGroup.add(topHood);

      dynamicRoot.add(hubGroup);

      // Grounded Multi-Part Client Workstations
      const spacing = 3.2;
      const startX = -((scoped.length - 1) * spacing) / 2;

      scoped.forEach((dev, idx) => {
        const st = dev.metrics?.healthState ?? 'Good';
        const lat = dev.metrics?.latencyMs ?? 25;
        const colorHex = HEALTH_HEX[st];
        const isSelected = currentFocus.deviceUid === dev.uid;
        const x = startX + idx * spacing;
        const devPos = new THREE.Vector3(x, 0, 1.55);

        const ws = new THREE.Group();
        ws.position.copy(devPos);

        // Floor rubber mat beneath desk (y=0.01)
        const floorMat = new THREE.Mesh(
          new THREE.BoxGeometry(2.15, 0.02, 1.65),
          new THREE.MeshStandardMaterial({ color: 0x151b26, roughness: 0.9, metalness: 0.05 })
        );
        floorMat.position.y = 0.01;
        ws.add(floorMat);

        // 4 Tubular Steel Desk Legs grounded cleanly on floor mat (y=0.02 -> y=0.74)
        const legMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.35, metalness: 0.85 });
        for (const lx of [-0.92, 0.92]) {
          for (const lz of [-0.42, 0.42]) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 10), legMat);
            leg.position.set(lx, 0.38, lz);
            ws.add(leg);
          }
        }

        // Desk Surface Tabletop (dark architectural slate laminate)
        const deskTop = new THREE.Mesh(
          new THREE.BoxGeometry(2.05, 0.06, 1.02),
          new THREE.MeshStandardMaterial({ color: 0x242c3b, roughness: 0.45, metalness: 0.28 })
        );
        deskTop.position.set(0, 0.76, 0);
        ws.add(deskTop);

        // Mini-Tower Workstation PC Chassis on right side of desk
        const tower = new THREE.Mesh(
          new THREE.BoxGeometry(0.26, 0.56, 0.52),
          new THREE.MeshStandardMaterial({ color: 0x11151d, roughness: 0.35, metalness: 0.8 })
        );
        tower.position.set(0.72, 1.07, -0.08);
        ws.add(tower);

        const towerLed = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.035, 0.02),
          new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.9 })
        );
        towerLed.position.set(0.72, 1.24, 0.185);
        ws.add(towerLed);

        // Brushed Aluminum Monitor Stand + Curved Ultrawide Display
        const standFoot = new THREE.Mesh(
          new THREE.BoxGeometry(0.38, 0.025, 0.24),
          legMat
        );
        standFoot.position.set(-0.22, 0.805, -0.18);
        ws.add(standFoot);

        const standNeck = new THREE.Mesh(
          new THREE.BoxGeometry(0.07, 0.28, 0.06),
          legMat
        );
        standNeck.position.set(-0.22, 0.94, -0.22);
        ws.add(standNeck);

        const screenHousing = new THREE.Mesh(
          new THREE.BoxGeometry(1.18, 0.62, 0.055),
          new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.35, metalness: 0.75 })
        );
        screenHousing.position.set(-0.22, 1.18, -0.16);
        ws.add(screenHousing);

        const screenFace = new THREE.Mesh(
          new THREE.PlaneGeometry(1.1, 0.54),
          new THREE.MeshStandardMaterial({
            color: dev.accentHex,
            emissive: dev.accentHex,
            emissiveIntensity: isSelected ? 1.0 : 0.45,
            roughness: 0.18,
            metalness: 0.1,
          })
        );
        screenFace.position.set(-0.22, 1.18, -0.13);
        ws.add(screenFace);

        // Keyboard + Desk Pad
        const deskPad = new THREE.Mesh(
          new THREE.BoxGeometry(0.86, 0.015, 0.36),
          new THREE.MeshStandardMaterial({ color: 0x0f141c, roughness: 0.85, metalness: 0.05 })
        );
        deskPad.position.set(-0.22, 0.798, 0.22);
        ws.add(deskPad);

        const keyboard = new THREE.Mesh(
          new THREE.BoxGeometry(0.46, 0.02, 0.16),
          new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5, metalness: 0.4 })
        );
        keyboard.position.set(-0.28, 0.815, 0.22);
        ws.add(keyboard);

        // Ergonomic Task Chair positioned cleanly in front of desk
        const chairBase = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.32, 0.05, 8),
          legMat
        );
        chairBase.position.set(-0.2, 0.045, 0.72);
        ws.add(chairBase);

        const chairPiston = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8),
          legMat
        );
        chairPiston.position.set(-0.2, 0.26, 0.72);
        ws.add(chairPiston);

        const chairSeat = new THREE.Mesh(
          new THREE.BoxGeometry(0.54, 0.08, 0.5),
          new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.75, metalness: 0.15 })
        );
        chairSeat.position.set(-0.2, 0.49, 0.72);
        ws.add(chairSeat);

        const chairBack = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.62, 0.07),
          new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.75, metalness: 0.15 })
        );
        chairBack.position.set(-0.2, 0.82, 0.94);
        ws.add(chairBack);

        // Workstation status aura ring on floor
        const aura = new THREE.Mesh(
          new THREE.TorusGeometry(1.18, isSelected ? 0.048 : 0.03, 8, 36),
          new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: isSelected ? 0.94 : 0.66,
            polygonOffset: true,
            polygonOffsetFactor: -1,
          })
        );
        aura.rotation.x = Math.PI / 2;
        aura.position.y = 0.035;
        ws.add(aura);
        auraRings.push({ mesh: aura, speed: 1.4 + Math.min(4.5, lat / 40), baseScale: 1 });

        // Overhead Fiber-Optic Conduit from Server Cabinet top to Workstation
        const linkCurve = new THREE.QuadraticBezierCurve3(
          new THREE.Vector3(0, 2.25, -2.5),
          new THREE.Vector3(x * 0.55, 2.05, -0.5),
          new THREE.Vector3(x + 0.72, 1.15, 1.35)
        );
        const linkMesh = new THREE.Mesh(
          new THREE.TubeGeometry(linkCurve, 18, 0.024, 6, false),
          new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.65 })
        );
        dynamicRoot.add(linkMesh);

        const hit = new THREE.Mesh(
          new THREE.BoxGeometry(2.2, 1.8, 1.8),
          new THREE.MeshBasicMaterial({ visible: false })
        );
        hit.position.y = 0.85;
        hit.userData.onClick = () => {
          onSelectRef.current({ level: 'device', deviceUid: dev.uid });
        };
        ws.add(hit);
        clickables.push(hit);
        dynamicRoot.add(ws);
      });

      if (animateZoom) {
        startZoomTo(new THREE.Vector3(0, 4.9, 9.2), new THREE.Vector3(0, 0.75, -0.3), false);
      }
    }

    function rebuildScene(animateZoom = false) {
      clearDynamicRoot();
      const f = focusRef.current;
      const list = devicesRef.current;
      const isInitialMount = prevFocusKeyRef.current === '';
      const focusKey = `${f.level}:${f.countryCode ?? ''}:${f.cityCode ?? ''}:${f.districtCode ?? ''}:${f.buildingCode ?? ''}:${f.floorNumber ?? ''}:${f.deviceUid ?? ''}`;
      const shouldZoom = animateZoom || focusKey !== prevFocusKeyRef.current;
      prevFocusKeyRef.current = focusKey;

      if (f.level === 'globe' || f.level === 'country') {
        buildGlobeAndRegionalView(f, list, shouldZoom, isInitialMount);
      } else {
        buildLocalSiteView(f, list, shouldZoom);
      }
      if (isSoftwareGl) requestRender();
    }

    rebuildSceneRef.current = rebuildScene;
    rebuildScene(true);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;

    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(clickables, false);
      if (hits.length > 0) {
        const hit = hits[0];
        const onClick = hit.object.userData.onClick as (() => void) | undefined;
        if (onClick) {
          onClick();
          return;
        }
        const onClickPoint = hit.object.userData.onClickPoint as ((pt: THREE.Vector3) => void) | undefined;
        if (onClickPoint) {
          onClickPoint(hit.point);
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const startPerfMs = performance.now();
    let lastPerfMs = startPerfMs;

    function tick() {
      if (disposed) return;
      const nowPerf = performance.now();
      const dt = (nowPerf - lastPerfMs) / 1000;
      lastPerfMs = nowPerf;
      const elapsed = (nowPerf - startPerfMs) / 1000;

      stepZoomAnimation(dt);

      if (!reducedRef.current) {
        for (const ring of auraRings) {
          const s = ring.baseScale + Math.sin(elapsed * ring.speed) * 0.12;
          ring.mesh.scale.set(s, s, 1);
        }
      }
      controls.update();
      renderer.render(scene, camera);
      updateCameraAttr();
      frameId = requestAnimationFrame(tick);
    }

    if (isSoftwareGl) {
      requestRender();
    } else {
      tick();
    }

    controls.addEventListener('change', () => {
      if (isSoftwareGl) requestRender();
      else updateCameraAttr();
    });

    const onResize = () => {
      if (!container || disposed) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (isSoftwareGl) requestRender();
    };
    window.addEventListener('resize', onResize);

    const onContextLost = (ev: Event) => {
      ev.preventDefault();
      onWebglUnavailable();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      placeholderTexture.dispose();
      hiResEarthTexture?.dispose();
      for (const t of disposableTextures) t.dispose();
      renderer.dispose();
    };
  }, [onWebglUnavailable]);

  useEffect(() => {
    rebuildSceneRef.current?.(false);
  }, [focus, devices]);

  return (
    <div
      ref={mountRef}
      data-testid="three-world-canvas"
      className="h-full w-full cursor-grab active:cursor-grabbing"
      aria-label="Nexaura 3D Global Infrastructure Viewport"
    />
  );
}
