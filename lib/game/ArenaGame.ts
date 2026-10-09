import * as THREE from 'three';
import { SoundManager, type SoundCue } from './sound';

export type GameMode = 'menu' | 'playing' | 'paused' | 'dead';
export type EnemyState =
  | 'IDLE'
  | 'DETECTING'
  | 'CHASING'
  | 'ATTACKING'
  | 'TAKING_DAMAGE'
  | 'DEAD'
  | 'RESPAWNING';

export interface GameSnapshot {
  mode: GameMode;
  health: number;
  maxHealth: number;
  ammo: number;
  reserve: number;
  kills: number;
  aiming: boolean;
  reloading: boolean;
  sprinting: boolean;
  radarContacts: Array<{ x: number; y: number }>;
}

export type GameEventType = 'hit' | 'kill' | 'damage' | 'empty' | 'respawn';
export interface GameEvent {
  type: GameEventType;
  amount?: number;
}

interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface EnemyBot {
  id: number;
  root: THREE.Group;
  hitMeshes: THREE.Mesh[];
  armorMaterial: THREE.MeshStandardMaterial;
  hp: number;
  maxHp: number;
  state: EnemyState;
  resumeState: EnemyState;
  stateTimer: number;
  attackTimer: number;
  hurtTimer: number;
  walkPhase: number;
  spawnIndex: number;
  hpFill: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
}

const ARENA_HALF = 18;
const PLAYER_RADIUS = 0.34;
const PLAYER_MAX_HEALTH = 100;
const MAGAZINE_SIZE = 30;
const RELOAD_DURATION = 1.48;
const JOYSTICK_DEAD_ZONE = 0.08;
const SPRINT_THRESHOLD = 0.85;
const WALK_SPEED = 4.55;
const SPRINT_SPEED = 8.05;
const AIM_SPEED = 3.15;
const SLIDE_DURATION = 0.64;
const SLIDE_COOLDOWN = 0.42;
const CENTER_NDC = new THREE.Vector2(0, 0);
const ENEMY_SPAWNS: ReadonlyArray<THREE.Vector2> = [
  new THREE.Vector2(-8.2, -2.2),
  new THREE.Vector2(8.1, -4.2),
  new THREE.Vector2(0.1, -8.6),
];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const damp = (current: number, target: number, smoothing: number, delta: number): number =>
  THREE.MathUtils.lerp(current, target, 1 - Math.exp(-smoothing * delta));

/** Lightweight, local-only Three.js FPS prototype. Physics is intentionally AABB-based. */
export class ArenaGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly onSnapshot: (snapshot: GameSnapshot) => void;
  private readonly onEvent: (event: GameEvent) => void;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(76, 1, 0.08, 90);
  private readonly world = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly colliders: Collider[] = [];
  private readonly enemies: EnemyBot[] = [];
  private readonly enemyMeshes: THREE.Mesh[] = [];
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly unitCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  private readonly enemyCapsule = new THREE.CapsuleGeometry(0.1, 0.42, 2, 6);
  private readonly handCapsule = new THREE.CapsuleGeometry(0.075, 0.3, 2, 5);
  private readonly headGeometry = new THREE.DodecahedronGeometry(0.22, 0);
  private readonly shadowGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly soundManager = new SoundManager();

  private renderer!: THREE.WebGLRenderer;
  private mode: GameMode = 'menu';
  private rafId = 0;
  private lastFrameAt = 0;
  private lastRenderAt = 0;
  private snapshotTimer = 0;
  private disposed = false;
  private webglContextLost = false;

  private playerX = 0;
  private playerZ = 10.8;
  private feetY = 0;
  private verticalVelocity = 0;
  private grounded = true;
  private velocityX = 0;
  private velocityZ = 0;
  private yaw = 0;
  private pitch = 0;
  private eyeHeight = 1.64;
  private targetEyeHeight = 1.64;
  private walkPhase = 0;
  private elapsedTime = 0;
  private aiming = false;
  private sprinting = false;
  private fireHeld = false;
  private mouseLooking = false;
  private mouseLastX = 0;
  private mouseLastY = 0;
  private keyState = new Set<string>();
  private moveStickX = 0;
  private moveStickY = 0;
  private slideTimer = 0;
  private slideCooldown = 0;
  private slideSpeed = 6.8;
  private slideDirection = new THREE.Vector3();
  private shotCooldown = 0;
  private reloadTimer = 0;
  private muzzleTimer = 0;
  private recoil = 0;
  private tracerTimer = 0;
  private health = PLAYER_MAX_HEALTH;
  private ammo = MAGAZINE_SIZE;
  private reserveAmmo = 90;
  private kills = 0;
  private damageFlashTimer = 0;
  private lastSnapshotKey = '';

  private readonly moveInput = new THREE.Vector2();
  private readonly wishDirection = new THREE.Vector3();
  private readonly forwardVector = new THREE.Vector3();
  private readonly rightVector = new THREE.Vector3();
  private readonly tmpVector = new THREE.Vector3();
  private readonly tracerPositions = new Float32Array(6);

  private weaponGroup!: THREE.Group;
  private magazineGroup!: THREE.Group;
  private muzzleFlash!: THREE.Group;
  private tracerLine!: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private hitSpark!: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>;
  private hitSparkTimer = 0;
  private muzzleTimerMax = 0.07;

  private readonly material = {
    ground: new THREE.MeshStandardMaterial({ color: 0x69747e, roughness: 1, flatShading: true }),
    wall: new THREE.MeshStandardMaterial({ color: 0x74818d, roughness: 0.96, flatShading: true }),
    wallDark: new THREE.MeshStandardMaterial({ color: 0x263648, roughness: 0.94, metalness: 0.12, flatShading: true }),
    cover: new THREE.MeshStandardMaterial({ color: 0x8c969e, roughness: 0.92, flatShading: true }),
    coverDark: new THREE.MeshStandardMaterial({ color: 0x4a5968, roughness: 0.92, flatShading: true }),
    crate: new THREE.MeshStandardMaterial({ color: 0x755d48, roughness: 1, flatShading: true }),
    crateDark: new THREE.MeshStandardMaterial({ color: 0x483d34, roughness: 1, flatShading: true }),
    accent: new THREE.MeshStandardMaterial({ color: 0x30b8f4, roughness: 0.56, metalness: 0.24, flatShading: true }),
    steel: new THREE.MeshStandardMaterial({ color: 0x3c6481, roughness: 0.66, metalness: 0.42, flatShading: true }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0x294459, roughness: 0.7, metalness: 0.36, flatShading: true }),
    glass: new THREE.MeshStandardMaterial({ color: 0x263f55, roughness: 0.3, metalness: 0.3, emissive: 0x11263a, emissiveIntensity: 0.45, flatShading: true }),
    concreteLight: new THREE.MeshStandardMaterial({ color: 0xa9b1b8, roughness: 0.92, flatShading: true }),
    gun: new THREE.MeshStandardMaterial({ color: 0x344755, roughness: 0.48, metalness: 0.56, flatShading: true }),
    gunDark: new THREE.MeshStandardMaterial({ color: 0x182634, roughness: 0.66, metalness: 0.36, flatShading: true }),
    gunAccent: new THREE.MeshStandardMaterial({ color: 0x879cab, roughness: 0.4, metalness: 0.52, flatShading: true }),
    glove: new THREE.MeshStandardMaterial({ color: 0x273646, roughness: 0.9, metalness: 0.02, flatShading: true }),
    gloveEdge: new THREE.MeshStandardMaterial({ color: 0x596e80, roughness: 0.78, metalness: 0.04, flatShading: true }),
    shadow: new THREE.MeshBasicMaterial({ color: 0x111b29, transparent: true, opacity: 0.18, depthWrite: false }),
  };

  private readonly onResize = (): void => this.resize();
  private readonly onVisibilityChange = (): void => {
    this.lastFrameAt = performance.now();
    if (document.hidden && this.mode === 'playing') {
      this.mode = 'paused';
      this.releaseInputs();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.publishSnapshot(true);
    }
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKeyDown(event);
  private readonly onKeyUp = (event: KeyboardEvent): void => this.handleKeyUp(event);
  private readonly onMouseDown = (event: MouseEvent): void => this.handleMouseDown(event);
  private readonly onMouseUp = (event: MouseEvent): void => this.handleMouseUp(event);
  private readonly onMouseMove = (event: MouseEvent): void => this.handleMouseMove(event);
  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.mode === 'playing') event.preventDefault();
  };
  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas) this.mouseLooking = false;
  };
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.webglContextLost = true;
    this.pause();
  };
  private readonly onContextRestored = (): void => {
    this.webglContextLost = false;
  };

  constructor(
    canvas: HTMLCanvasElement,
    onSnapshot: (snapshot: GameSnapshot) => void,
    onEvent: (event: GameEvent) => void,
  ) {
    this.canvas = canvas;
    this.onSnapshot = onSnapshot;
    this.onEvent = onEvent;
    this.configureRenderer();
    this.scene.add(this.camera);
    this.buildScene();
    this.createEnemies();
    this.createWeapon();
    this.createTracer();
    this.createImpactEffect();
    this.camera.position.set(this.playerX, this.eyeHeight, this.playerZ);
    this.camera.rotation.order = 'YXZ';
    this.resize();

    window.addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.lastFrameAt = performance.now();
    this.rafId = window.requestAnimationFrame(this.frame);
    this.publishSnapshot(true);
  }

  private configureRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
      stencil: false,
      depth: true,
      precision: 'mediump',
    });
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    this.renderer.shadowMap.enabled = !coarsePointer;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.setClearColor(0x719cc5, 1);
  }

  private addSkyDome(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return;

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#4b78a5');
    gradient.addColorStop(0.42, '#78a6ce');
    gradient.addColorStop(0.76, '#a7c3d8');
    gradient.addColorStop(1, '#769dbd');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    // A few diffuse cloud strokes add a hint of daylight texture without external assets.
    context.save();
    context.filter = 'blur(19px)';
    context.fillStyle = 'rgba(250, 253, 255, 0.22)';
    for (let cloud = 0; cloud < 15; cloud += 1) {
      const cx = (cloud * 83 + 37) % canvas.width;
      const cy = 38 + ((cloud * 47 + 19) % 117);
      const rx = 18 + ((cloud * 17) % 30);
      const ry = 5 + ((cloud * 7) % 9);
      context.beginPath();
      context.ellipse(cx, cy, rx, ry, -0.08, 0, Math.PI * 2);
      context.fill();
      if (cloud % 3 === 0) {
        context.beginPath();
        context.ellipse(cx + rx * 0.58, cy + 2, rx * 0.56, ry * 0.72, 0.05, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.scene.background = texture;
  }

  private buildScene(): void {
    this.scene.background = new THREE.Color(0x719cc5);
    this.scene.fog = new THREE.Fog(0x719cc5, 29, 78);
    this.addSkyDome();
    this.scene.add(this.world);

    const hemisphere = new THREE.HemisphereLight(0xe1efff, 0x283542, 1.88);
    this.scene.add(hemisphere);
    const keyLight = new THREE.DirectionalLight(0xffecd4, 2.38);
    keyLight.position.set(-10, 18, 9);
    keyLight.castShadow = this.renderer.shadowMap.enabled;
    keyLight.shadow.mapSize.set(512, 512);
    keyLight.shadow.camera.left = -25;
    keyLight.shadow.camera.right = 25;
    keyLight.shadow.camera.top = 25;
    keyLight.shadow.camera.bottom = -25;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 46;
    keyLight.shadow.bias = -0.00035;
    keyLight.shadow.normalBias = 0.035;
    keyLight.shadow.camera.updateProjectionMatrix();
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x83b7e7, 0.88);
    fillLight.position.set(12, 8, -13);
    this.scene.add(fillLight);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), this.material.ground);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.035;
    floor.receiveShadow = this.renderer.shadowMap.enabled;
    this.world.add(floor);

    const grid = new THREE.GridHelper(36, 18, 0x7a9ab3, 0x6c8192);
    grid.position.y = 0.004;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const gridMaterial of gridMaterials) {
      const lineMaterial = gridMaterial as THREE.LineBasicMaterial;
      lineMaterial.transparent = true;
      lineMaterial.opacity = 0.12;
      lineMaterial.depthWrite = false;
    }
    this.world.add(grid);

    // Concrete perimeter, steel kick plates and restrained blue lane lighting.
    this.addBox(-ARENA_HALF, 2.35, 0, 0.7, 4.7, 36, this.material.wall);
    this.addBox(ARENA_HALF, 2.35, 0, 0.7, 4.7, 36, this.material.wall);
    this.addBox(0, 2.35, -ARENA_HALF, 36, 4.7, 0.7, this.material.wall);
    this.addBox(0, 2.35, ARENA_HALF, 36, 4.7, 0.7, this.material.wall);
    this.addBox(0, 0.34, -17.57, 35, 0.68, 0.035, this.material.wallDark);
    this.addBox(0, 0.34, 17.57, 35, 0.68, 0.035, this.material.wallDark);
    this.addBox(-17.57, 0.34, 0, 0.035, 0.68, 35, this.material.wallDark);
    this.addBox(17.57, 0.34, 0, 0.035, 0.68, 35, this.material.wallDark);
    this.addBox(0, 0.78, -17.53, 34.7, 0.035, 0.055, this.material.accent);
    this.addBox(0, 0.78, 17.53, 34.7, 0.035, 0.055, this.material.accent);
    this.addBox(-17.53, 0.78, 0, 0.055, 0.035, 34.7, this.material.accent);
    this.addBox(17.53, 0.78, 0, 0.055, 0.035, 34.7, this.material.accent);
    for (const seam of [-15, -10, -5, 5, 10, 15]) {
      this.addBox(seam, 2.25, -17.59, 0.075, 3.35, 0.08, this.material.coverDark);
      this.addBox(seam, 4.0, -17.56, 0.28, 0.1, 0.1, this.material.steel);
      this.addBox(-17.59, 2.25, seam, 0.08, 3.35, 0.075, this.material.coverDark);
      this.addBox(17.59, 2.25, seam, 0.08, 3.35, 0.075, this.material.coverDark);
    }

    // Two shallow barracks facades give the arena a readable industrial skyline.
    this.addTrainingBuilding(-12.2, -14.35, 8.6, 6.0, 5.4);
    this.addTrainingBuilding(12.2, -14.35, 8.6, 6.0, 5.4);
    this.addCommandTower();
    this.addWatchtower(-14.0, -8.0);
    this.addWatchtower(14.0, -8.0);

    // Ribbed cargo containers and concrete cover frame a clear central firing lane.
    this.addShippingContainer(-11.1, 0.25, 5.2, 2.6);
    this.addShippingContainer(11.2, -1.4, 5.2, 2.6);
    this.addCover(-5.8, 0.75, -3.9, 2.15, 1.5, 2.15, this.material.crate);
    this.addCover(6.0, 0.75, 3.0, 2.15, 1.5, 2.15, this.material.crate);
    this.addJerseyBarrier(-2.4, 1.0, 2.8, 0.72);
    this.addJerseyBarrier(3.6, -5.6, 2.8, 0.72);
    this.addCover(-2.1, 0.54, 6.1, 2.6, 1.08, 0.95, this.material.coverDark);
    this.addCover(8.5, 0.48, 7.1, 2.2, 0.96, 1.0, this.material.coverDark);
    this.addCover(-9.2, 0.58, -10.3, 2.6, 1.16, 1.3, this.material.coverDark);
    this.addCover(10.5, 0.58, -10.2, 2.6, 1.16, 1.3, this.material.coverDark);

    // A low guard post and angled training ramp occupy the perimeter, not the sightline.
    this.addCover(-14.2, 1.22, 8.6, 3.1, 2.44, 2.8, this.material.wallDark);
    this.addBox(-14.2, 2.55, 8.6, 3.45, 0.22, 3.15, this.material.cover);
    this.addRamp(-10.9, 8.0, 3.6, 2.7, 0.58);
    this.addCrateStack(-7.9, 4.0);
    this.addCrateStack(8.0, -0.1);
    this.addLaneMarkings();
  }

  private addCommandTower(): void {
    const x = 0;
    const z = -16.25;
    const width = 5.6;
    const height = 7.9;
    const depth = 2.8;
    const front = z + depth / 2;
    this.addCover(x, height / 2, z, width, height, depth, this.material.steelDark);
    this.addBox(x, height + 0.13, z, width + 0.4, 0.26, depth + 0.28, this.material.wallDark);
    this.addBox(x - 2.55, 3.75, front + 0.07, 0.16, 7.35, 0.18, this.material.steel);
    this.addBox(x + 2.55, 3.75, front + 0.07, 0.16, 7.35, 0.18, this.material.steel);
    this.addBox(x, 1.55, front + 0.075, 3.42, 2.3, 0.16, this.material.wallDark);
    this.addBox(x, 1.62, front + 0.17, 2.76, 1.72, 0.045, this.material.steel);
    this.addBox(x, 2.52, front + 0.2, 2.88, 0.08, 0.05, this.material.accent);
    for (const side of [-1, 1]) {
      const windowX = x + side * 1.48;
      this.addBox(windowX, 4.45, front + 0.06, 1.12, 0.95, 0.12, this.material.wallDark);
      this.addBox(windowX, 4.45, front + 0.14, 0.86, 0.62, 0.045, this.material.glass);
      this.addBox(windowX, 6.15, front + 0.06, 1.5, 0.78, 0.12, this.material.wallDark);
      this.addBox(windowX, 6.15, front + 0.14, 1.18, 0.5, 0.045, this.material.glass);
    }
    this.addBox(x, 7.35, front + 0.12, 4.9, 0.14, 0.18, this.material.steel);
    this.addBox(x - 1.72, 8.57, z - 0.08, 1.24, 1.08, 1.36, this.material.coverDark);
    this.addBox(x - 1.72, 8.62, z + 0.62, 0.86, 0.48, 0.08, this.material.glass);
    this.addBox(x - 1.72, 9.14, z - 0.08, 1.48, 0.12, 1.58, this.material.wallDark);
    this.addBox(x + 0.2, 8.8, z, 0.08, 1.35, 0.08, this.material.steel);
    this.addBox(x + 0.2, 9.48, z, 0.56, 0.08, 0.08, this.material.accent);
    for (let rung = 0; rung < 7; rung += 1) {
      this.addBox(x + 2.95, 0.5 + rung * 0.49, front + 0.19, 0.55, 0.05, 0.1, this.material.concreteLight);
    }
  }

  private addTrainingBuilding(x: number, z: number, width: number, height: number, depth: number): void {
    const front = z + depth / 2;
    const lowerWindowY = height * 0.39;
    const upperWindowY = height * 0.75;
    this.addCover(x, height / 2, z, width, height, depth, this.material.coverDark);
    this.addBox(x, height + 0.11, z, width + 0.32, 0.22, depth + 0.26, this.material.wallDark);
    this.addBox(x, 0.45, front + 0.025, width - 0.18, 0.24, 0.08, this.material.wallDark);
    this.addBox(x, 1.35, front + 0.04, 1.18, 1.32, 0.08, this.material.steelDark);
    this.addBox(x, 1.29, front + 0.09, 0.74, 1.04, 0.035, this.material.glass);
    this.addBox(x, 1.95, front + 0.11, 0.8, 0.055, 0.04, this.material.accent);

    for (const side of [-1, 1]) {
      const wingX = x + side * width * 0.29;
      this.addBox(wingX, lowerWindowY, front + 0.035, 1.36, 1.0, 0.08, this.material.steelDark);
      this.addBox(wingX, lowerWindowY, front + 0.085, 1.06, 0.69, 0.035, this.material.glass);
      this.addBox(wingX, upperWindowY, front + 0.035, 1.62, 0.84, 0.08, this.material.wallDark);
      this.addBox(wingX, upperWindowY, front + 0.085, 1.28, 0.55, 0.035, this.material.glass);
      this.addBox(wingX - side * 0.83, height / 2, front + 0.04, 0.12, height - 0.42, 0.12, this.material.concreteLight);
      this.addBox(wingX, lowerWindowY - 0.55, front + 0.1, 1.45, 0.055, 0.08, this.material.steel);
    }

    this.addBox(x, height - 0.28, front + 0.12, width - 0.6, 0.12, 0.18, this.material.steel);
    this.addBox(x - width * 0.28, height + 0.43, z, 0.16, 0.42, depth - 0.2, this.material.steelDark);
    this.addBox(x + width * 0.28, height + 0.43, z, 0.16, 0.42, depth - 0.2, this.material.steelDark);
    this.addBox(x, height + 0.48, z, width * 0.42, 0.08, 0.08, this.material.accent);
  }

  private addShippingContainer(x: number, z: number, width: number, height: number): void {
    const depth = 2.6;
    const front = z + depth / 2;
    this.addBox(x, height / 2, z, width, height, depth, this.material.steel);
    this.colliders.push({
      minX: x - width / 2,
      maxX: x + width / 2,
      minZ: z - depth / 2,
      maxZ: z + depth / 2,
    });
    this.addGroundShadow(x, z, width + 0.75, depth + 0.6);
    this.addBox(x, height - 0.08, front + 0.045, width - 0.16, 0.12, 0.09, this.material.steelDark);
    this.addBox(x, 0.09, front + 0.045, width - 0.16, 0.14, 0.09, this.material.steelDark);
    for (let rib = -2; rib <= 2; rib += 1) {
      const ribX = x + rib * (width / 5.3);
      this.addBox(ribX, height / 2, front + 0.06, 0.075, height - 0.24, 0.09, this.material.steelDark);
    }
    for (const side of [-1, 1]) {
      this.addBox(x + side * (width / 2 - 0.1), height / 2, front + 0.09, 0.16, height - 0.08, 0.16, this.material.gunAccent);
    }
    this.addBox(x, height / 2, z - depth / 2 - 0.04, width - 0.18, height - 0.16, 0.07, this.material.steelDark);
    for (let door = -1; door <= 1; door += 2) {
      this.addBox(x + door * 0.58, height / 2, z - depth / 2 - 0.09, 0.045, height - 0.34, 0.035, this.material.gunAccent);
      this.addBox(x + door * 0.58, height / 2, z - depth / 2 - 0.12, 0.08, 0.11, 0.05, this.material.accent);
    }
  }

  private addWatchtower(x: number, z: number): void {
    const span = 3.25;
    const deckHeight = 3.75;
    for (const offsetX of [-1, 1]) {
      for (const offsetZ of [-1, 1]) {
        const px = x + offsetX * 1.35;
        const pz = z + offsetZ * 1.25;
        this.addBox(px, deckHeight / 2, pz, 0.22, deckHeight, 0.22, this.material.steelDark);
        this.colliders.push({ minX: px - 0.19, maxX: px + 0.19, minZ: pz - 0.19, maxZ: pz + 0.19 });
      }
    }
    this.addBox(x, deckHeight, z, span, 0.26, 2.9, this.material.steel);
    this.addBox(x, deckHeight + 1.0, z - 0.14, 1.82, 1.65, 1.58, this.material.coverDark);
    this.addBox(x, deckHeight + 1.04, z + 0.68, 1.38, 0.72, 0.08, this.material.glass);
    this.addBox(x, deckHeight + 1.45, z + 0.74, 1.55, 0.11, 0.1, this.material.accent);
    this.addBox(x, deckHeight + 1.92, z - 0.14, 2.05, 0.18, 1.82, this.material.wallDark);
    for (const side of [-1, 1]) {
      this.addBox(x + side * 1.35, deckHeight + 0.52, z + 0.08, 0.1, 0.8, 2.72, this.material.steelDark);
      this.addBox(x, deckHeight + 0.52, z + side * 1.22, 2.8, 0.8, 0.1, this.material.steelDark);
    }
    for (let rung = 0; rung < 5; rung += 1) {
      this.addBox(x - 0.72, 0.42 + rung * 0.47, z + 1.53, 0.72, 0.055, 0.12, this.material.concreteLight);
    }
  }

  private addJerseyBarrier(x: number, z: number, width: number, depth: number): void {
    this.addBox(x, 0.19, z, width, 0.38, depth, this.material.concreteLight);
    this.addBox(x, 0.52, z, width * 0.76, 0.34, depth * 0.72, this.material.cover);
    this.addBox(x, 0.72, z, width * 0.58, 0.06, depth * 0.56, this.material.accent);
    this.colliders.push({ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2 });
    this.addGroundShadow(x, z, width + 0.45, depth + 0.35);
  }

  private addRamp(x: number, z: number, width: number, depth: number, height: number): void {
    const geometry = new THREE.BufferGeometry();
    const w = width / 2;
    const d = depth / 2;
    const positions = new Float32Array([
      -w, 0, -d, w, 0, -d, w, height, d,
      -w, 0, -d, w, height, d, -w, height, d,
      -w, 0, -d, -w, height, d, -w, 0, d,
      w, 0, -d, w, 0, d, w, height, d,
      -w, 0, d, -w, height, d, w, height, d,
      -w, 0, -d, -w, 0, d, w, 0, d,
      -w, 0, -d, w, 0, d, w, 0, -d,
    ]);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const ramp = new THREE.Mesh(geometry, this.material.coverDark);
    ramp.position.set(x, 0, z);
    ramp.castShadow = this.renderer.shadowMap.enabled;
    ramp.receiveShadow = this.renderer.shadowMap.enabled;
    this.world.add(ramp);
    this.colliders.push({ minX: x - w, maxX: x + w, minZ: z - d, maxZ: z + d });
    this.addGroundShadow(x, z, width + 0.55, depth + 0.6);
    this.addBox(x, height * 0.5 + 0.05, z + depth * 0.2, width * 0.88, 0.055, 0.12, this.material.accent);
  }

  private addGroundShadow(x: number, z: number, width: number, depth: number): void {
    const shadow = new THREE.Mesh(this.shadowGeometry, this.material.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(x, 0.012, z);
    shadow.scale.set(width, depth, 1);
    shadow.renderOrder = 1;
    this.world.add(shadow);
  }

  private addBox(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.boxGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(width, height, depth);
    mesh.castShadow = this.renderer.shadowMap.enabled;
    mesh.receiveShadow = this.renderer.shadowMap.enabled;
    this.world.add(mesh);
    return mesh;
  }

  private addCover(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
  ): void {
    this.addBox(x, y, z, width, height, depth, material);
    this.colliders.push({
      minX: x - width / 2,
      maxX: x + width / 2,
      minZ: z - depth / 2,
      maxZ: z + depth / 2,
    });
    this.addGroundShadow(x, z, width + 0.38, depth + 0.38);
  }

  private addCrateStack(x: number, z: number): void {
    const first = this.addBox(x, 0.49, z, 1.05, 0.98, 1.0, this.material.crate);
    first.rotation.y = 0.12;
    this.colliders.push({ minX: x - 0.57, maxX: x + 0.57, minZ: z - 0.55, maxZ: z + 0.55 });
    const second = this.addBox(x + 0.18, 1.38, z - 0.08, 0.86, 0.78, 0.82, this.material.crateDark);
    second.rotation.y = -0.08;
    this.colliders.push({ minX: x - 0.31, maxX: x + 0.67, minZ: z - 0.56, maxZ: z + 0.4 });
    this.addGroundShadow(x, z, 1.55, 1.45);
    // A few raised slats keep the prop legible without high-polygon trim.
    for (const offsetX of [-0.32, 0.3]) {
      this.addBox(x + offsetX, 0.5, z - 0.515, 0.055, 0.94, 0.045, this.material.crateDark);
    }
    this.addBox(x + 0.18, 1.39, z - 0.505, 0.052, 0.72, 0.045, this.material.accent);
    this.addBox(x, 0.5, z - 0.52, 1.04, 0.055, 0.048, this.material.coverDark);
  }

  private addLaneMarkings(): void {
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0x4d9fc3, transparent: true, opacity: 0.28, depthWrite: false });
    for (const x of [-1.3, 1.3]) {
      const line = new THREE.Mesh(this.boxGeometry, lineMaterial);
      line.position.set(x, 0.012, -1.4);
      line.scale.set(0.035, 0.006, 25);
      this.world.add(line);
    }
    const centerCircle = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 3.48, 36),
      new THREE.MeshBasicMaterial({ color: 0xaec7d8, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }),
    );
    centerCircle.rotation.x = -Math.PI / 2;
    centerCircle.position.y = 0.014;
    this.world.add(centerCircle);
    const spawnMark = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.17, 24),
      new THREE.MeshBasicMaterial({ color: 0x38bdf4, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    spawnMark.rotation.x = -Math.PI / 2;
    spawnMark.position.set(0, 0.016, 10.8);
    this.world.add(spawnMark);
  }

  private createEnemies(): void {
    for (let id = 0; id < ENEMY_SPAWNS.length; id += 1) {
      const spawn = ENEMY_SPAWNS[id];
      const enemy = this.createEnemy(id, spawn.x, spawn.y);
      this.enemies.push(enemy);
      this.enemyMeshes.push(...enemy.hitMeshes);
    }
  }

  private createEnemy(id: number, x: number, z: number): EnemyBot {
    const palette = [0x46525e, 0x3d4b58, 0x525b64][id % 3];
    const armor = new THREE.MeshStandardMaterial({
      color: palette,
      roughness: 0.7,
      metalness: 0.22,
      flatShading: true,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    const darkArmor = new THREE.MeshStandardMaterial({ color: 0x1d2937, roughness: 0.84, metalness: 0.2, flatShading: true });
    const joints = new THREE.MeshStandardMaterial({ color: 0x687581, roughness: 0.68, metalness: 0.27, flatShading: true });
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: 0x341d29,
      roughness: 0.36,
      metalness: 0.2,
      emissive: 0xff394f,
      emissiveIntensity: 1.35,
    });
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    this.world.add(root);
    const hitMeshes: THREE.Mesh[] = [];

    const addHitPart = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: THREE.Vector3,
      scale: THREE.Vector3,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.scale.copy(scale);
      mesh.castShadow = this.renderer.shadowMap.enabled;
      mesh.receiveShadow = false;
      mesh.userData.enemyId = id;
      root.add(mesh);
      hitMeshes.push(mesh);
      return mesh;
    };

    addHitPart(this.boxGeometry, darkArmor, new THREE.Vector3(0, 0.83, 0), new THREE.Vector3(0.47, 0.34, 0.31));
    addHitPart(this.boxGeometry, armor, new THREE.Vector3(0, 1.29, 0), new THREE.Vector3(0.61, 0.68, 0.36));
    addHitPart(this.boxGeometry, joints, new THREE.Vector3(0, 1.34, -0.198), new THREE.Vector3(0.39, 0.35, 0.055));
    addHitPart(this.boxGeometry, darkArmor, new THREE.Vector3(-0.38, 1.54, 0), new THREE.Vector3(0.27, 0.24, 0.34));
    addHitPart(this.boxGeometry, darkArmor, new THREE.Vector3(0.38, 1.54, 0), new THREE.Vector3(0.27, 0.24, 0.34));
    addHitPart(this.headGeometry, armor, new THREE.Vector3(0, 1.83, -0.015), new THREE.Vector3(1, 1, 0.98));
    addHitPart(this.boxGeometry, darkArmor, new THREE.Vector3(0, 2.035, -0.015), new THREE.Vector3(0.42, 0.11, 0.37));
    addHitPart(this.boxGeometry, visorMaterial, new THREE.Vector3(0, 1.84, -0.204), new THREE.Vector3(0.3, 0.075, 0.04));
    addHitPart(this.boxGeometry, darkArmor, new THREE.Vector3(0, 1.62, -0.04), new THREE.Vector3(0.48, 0.12, 0.33));

    const makeLimb = (px: number, py: number, material: THREE.Material): THREE.Group => {
      const pivot = new THREE.Group();
      pivot.position.set(px, py, 0);
      const limb = new THREE.Mesh(this.enemyCapsule, material);
      limb.position.y = -0.235;
      limb.castShadow = this.renderer.shadowMap.enabled;
      limb.userData.enemyId = id;
      pivot.add(limb);
      root.add(pivot);
      hitMeshes.push(limb);
      return pivot;
    };

    const leftArm = makeLimb(-0.38, 1.49, armor);
    const rightArm = makeLimb(0.38, 1.49, armor);
    const leftLeg = makeLimb(-0.17, 0.73, darkArmor);
    const rightLeg = makeLimb(0.17, 0.73, darkArmor);
    // Slightly widen the leg capsules and keep arm silhouettes slim.
    leftArm.children[0].scale.set(0.82, 0.92, 0.82);
    rightArm.children[0].scale.set(0.82, 0.92, 0.82);
    leftLeg.children[0].scale.set(1.12, 1.1, 1.05);
    rightLeg.children[0].scale.set(1.12, 1.1, 1.05);

    // Compact, waist-mounted utility pack.
    const pack = new THREE.Mesh(this.boxGeometry, joints);
    pack.position.set(0, 1.08, 0.22);
    pack.scale.set(0.37, 0.42, 0.18);
    root.add(pack);

    const barRoot = new THREE.Group();
    barRoot.position.set(0, 2.36, 0);
    const barBack = new THREE.Mesh(
      new THREE.PlaneGeometry(0.88, 0.085),
      new THREE.MeshBasicMaterial({ color: 0x17201e, side: THREE.DoubleSide, depthWrite: false }),
    );
    barRoot.add(barBack);
    const barFill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.82, 0.043),
      new THREE.MeshBasicMaterial({ color: 0xb6c779, side: THREE.DoubleSide, depthWrite: false }),
    );
    barFill.position.z = 0.004;
    barRoot.add(barFill);
    root.add(barRoot);

    return {
      id,
      root,
      hitMeshes,
      armorMaterial: armor,
      hp: 100,
      maxHp: 100,
      state: 'IDLE',
      resumeState: 'CHASING',
      stateTimer: 0,
      attackTimer: 0.72 + id * 0.28,
      hurtTimer: 0,
      walkPhase: id * 1.8,
      spawnIndex: id,
      hpFill: barFill,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
    };
  }

  private createWeapon(): void {
    const weapon = new THREE.Group();
    this.weaponGroup = weapon;
    this.camera.add(weapon);

    const addGunBox = (
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
      depth: number,
      material: THREE.Material,
      parent: THREE.Group = weapon,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.boxGeometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(width, height, depth);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      parent.add(mesh);
      return mesh;
    };

    const addGunCylinder = (
      z: number,
      radius: number,
      length: number,
      material: THREE.Material,
      y = 0.015,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.unitCylinder, material);
      mesh.position.set(0, y, z);
      mesh.scale.set(radius * 2, length, radius * 2);
      mesh.rotation.x = Math.PI / 2;
      mesh.castShadow = false;
      weapon.add(mesh);
      return mesh;
    };

    // Distinct stock, receiver, grip, magazine, barrel and iron sights.
    addGunBox(0, 0, 0.07, 0.18, 0.16, 0.32, this.material.gun);
    addGunBox(0, 0.105, 0.025, 0.12, 0.045, 0.3, this.material.gunDark);
    addGunBox(0, 0.126, -0.075, 0.09, 0.035, 0.31, this.material.gunAccent);
    addGunBox(0, 0.01, 0.255, 0.14, 0.12, 0.25, this.material.gunDark);
    addGunBox(0, 0.008, 0.393, 0.16, 0.15, 0.045, this.material.gunAccent);
    addGunBox(0, -0.139, 0.13, 0.105, 0.225, 0.12, this.material.gun);
    const grip = addGunBox(0.015, -0.17, 0.035, 0.095, 0.21, 0.105, this.material.gunDark);
    grip.rotation.x = -0.18;
    addGunBox(0, -0.075, -0.14, 0.12, 0.11, 0.11, this.material.gunAccent);
    addGunBox(0, -0.055, -0.265, 0.105, 0.085, 0.13, this.material.gun);

    const barrel = addGunCylinder(-0.342, 0.023, 0.34, this.material.gunAccent, 0.025);
    barrel.rotation.x = Math.PI / 2;
    const muzzle = addGunCylinder(-0.545, 0.052, 0.17, this.material.gunDark, 0.025);
    muzzle.rotation.x = Math.PI / 2;
    addGunBox(0, 0.103, -0.36, 0.045, 0.085, 0.035, this.material.gunDark);
    addGunBox(0, 0.145, -0.105, 0.038, 0.055, 0.04, this.material.gunAccent);
    // Side rails, optic and fasteners give the first-person carbine a clean silhouette.
    addGunBox(-0.092, 0.015, -0.09, 0.025, 0.045, 0.31, this.material.gunDark);
    addGunBox(0.092, 0.015, -0.09, 0.025, 0.045, 0.31, this.material.gunDark);
    addGunBox(0, 0.17, -0.08, 0.055, 0.055, 0.16, this.material.gunDark);
    addGunBox(0, 0.205, -0.08, 0.13, 0.025, 0.19, this.material.gunAccent);
    const optic = addGunCylinder(-0.08, 0.044, 0.15, this.material.gunDark, 0.245);
    optic.rotation.x = Math.PI / 2;
    addGunBox(0, 0.246, -0.08, 0.06, 0.025, 0.11, this.material.accent);
    addGunBox(0.069, 0.06, 0.025, 0.025, 0.03, 0.15, this.material.accent);

    this.magazineGroup = new THREE.Group();
    this.magazineGroup.position.set(0, -0.13, -0.02);
    weapon.add(this.magazineGroup);
    const magazine = new THREE.Mesh(this.boxGeometry, this.material.gunDark);
    magazine.position.set(0, -0.075, 0);
    magazine.scale.set(0.115, 0.25, 0.13);
    magazine.rotation.x = -0.13;
    this.magazineGroup.add(magazine);
    const magRidge = new THREE.Mesh(this.boxGeometry, this.material.gunAccent);
    magRidge.position.set(0, -0.08, -0.069);
    magRidge.scale.set(0.062, 0.18, 0.008);
    this.magazineGroup.add(magRidge);

    this.muzzleFlash = new THREE.Group();
    const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffd67a, toneMapped: false });
    const flashCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.064, 0), flashMaterial);
    flashCore.scale.set(0.75, 0.75, 2.0);
    this.muzzleFlash.add(flashCore);
    const flashOuter = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 5, 4),
      new THREE.MeshBasicMaterial({ color: 0xff743d, transparent: true, opacity: 0.72, toneMapped: false }),
    );
    flashOuter.scale.set(0.76, 0.76, 1.8);
    this.muzzleFlash.add(flashOuter);
    this.muzzleFlash.position.set(0, 0.025, -0.64);
    this.muzzleFlash.visible = false;
    weapon.add(this.muzzleFlash);

    const supportArm = new THREE.Mesh(this.handCapsule, this.material.glove);
    supportArm.position.set(-0.17, -0.245, -0.285);
    supportArm.rotation.z = -0.62;
    supportArm.rotation.x = 0.12;
    weapon.add(supportArm);
    const gripArm = new THREE.Mesh(this.handCapsule, this.material.glove);
    gripArm.position.set(0.145, -0.255, 0.12);
    gripArm.rotation.z = 0.46;
    gripArm.rotation.x = -0.08;
    weapon.add(gripArm);
    const supportGlove = new THREE.Mesh(new THREE.DodecahedronGeometry(0.105, 0), this.material.gloveEdge);
    supportGlove.position.set(-0.105, -0.105, -0.19);
    supportGlove.scale.set(1.15, 0.72, 0.82);
    weapon.add(supportGlove);
    const gripGlove = new THREE.Mesh(new THREE.DodecahedronGeometry(0.095, 0), this.material.gloveEdge);
    gripGlove.position.set(0.095, -0.13, 0.08);
    gripGlove.scale.set(0.9, 0.8, 0.75);
    weapon.add(gripGlove);

    weapon.scale.setScalar(0.76);
    weapon.position.set(0.35, -0.32, -0.64);
    weapon.rotation.set(0.01, -0.015, -0.018);
    weapon.renderOrder = 8;
  }

  private createTracer(): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.tracerPositions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xa5e4ff,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      toneMapped: false,
    });
    this.tracerLine = new THREE.Line(geometry, material);
    this.tracerLine.frustumCulled = false;
    this.tracerLine.visible = false;
    this.tracerLine.renderOrder = 7;
    this.scene.add(this.tracerLine);
  }

  private createImpactEffect(): void {
    this.hitSpark = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.15, 0),
      new THREE.MeshBasicMaterial({ color: 0xffd27d, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
    );
    this.hitSpark.visible = false;
    this.hitSpark.renderOrder = 9;
    this.scene.add(this.hitSpark);
  }

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.setSize(width, height, false);
  }

  private getRadarContacts(): Array<{ x: number; y: number }> {
    const radarRange = 17;
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const contacts: Array<{ x: number; y: number }> = [];
    for (const enemy of this.enemies) {
      if (!enemy.root.visible || enemy.state === 'DEAD' || enemy.state === 'RESPAWNING') continue;
      const dx = enemy.root.position.x - this.playerX;
      const dz = enemy.root.position.z - this.playerZ;
      const right = dx * rightX + dz * rightZ;
      const forward = dx * forwardX + dz * forwardZ;
      if (Math.hypot(right, forward) > radarRange) continue;
      contacts.push({ x: clamp(right / radarRange, -0.92, 0.92), y: clamp(-forward / radarRange, -0.92, 0.92) });
    }
    return contacts;
  }

  getSnapshot(): GameSnapshot {
    return {
      mode: this.mode,
      health: this.health,
      maxHealth: PLAYER_MAX_HEALTH,
      ammo: this.ammo,
      reserve: this.reserveAmmo,
      kills: this.kills,
      aiming: this.aiming,
      reloading: this.reloadTimer > 0,
      sprinting: this.sprinting,
      radarContacts: this.getRadarContacts(),
    };
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundManager.setEnabled(enabled);
    if (enabled) void this.soundManager.unlock();
  }

  start(soundEnabled = true): void {
    if (this.mode === 'dead') return;
    this.mode = 'playing';
    this.soundManager.setEnabled(soundEnabled);
    if (soundEnabled) void this.soundManager.unlock();
    this.releaseInputs();
    this.publishSnapshot(true);
    // Keep pointer lock in the initiating click's activation window.
    this.requestMouseLockIfAvailable();
  }

  pause(): void {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.releaseInputs();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.playSound('ui');
    this.publishSnapshot(true);
  }

  resume(): void {
    if (this.mode !== 'paused') return;
    this.mode = 'playing';
    void this.soundManager.unlock();
    this.publishSnapshot(true);
    this.requestMouseLockIfAvailable();
  }

  togglePause(): void {
    if (this.mode === 'playing') this.pause();
    else if (this.mode === 'paused') this.resume();
  }

  respawn(): void {
    if (this.mode !== 'dead') return;
    this.health = PLAYER_MAX_HEALTH;
    this.playerX = 0;
    this.playerZ = 10.8;
    this.feetY = 0;
    this.verticalVelocity = 0;
    this.grounded = true;
    this.velocityX = 0;
    this.velocityZ = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.ammo = MAGAZINE_SIZE;
    this.reserveAmmo = 90;
    this.reloadTimer = 0;
    this.aiming = false;
    this.mode = 'playing';
    this.releaseInputs();
    this.playSound('ui');
    this.onEvent({ type: 'respawn' });
    this.publishSnapshot(true);
    this.requestMouseLockIfAvailable();
  }

  setMovementStick(x: number, y: number): void {
    if (this.mode !== 'playing') {
      this.moveStickX = 0;
      this.moveStickY = 0;
      return;
    }
    this.moveStickX = clamp(x, -1, 1);
    this.moveStickY = clamp(y, -1, 1);
  }

  lookBy(deltaX: number, deltaY: number): void {
    if (this.mode !== 'playing') return;
    const sensitivity = 0.0035;
    this.yaw -= deltaX * sensitivity;
    this.pitch = clamp(this.pitch - deltaY * sensitivity, -1.08, 1.08);
  }

  pressJump(): void {
    if (this.mode !== 'playing' || !this.grounded || this.slideTimer > 0) return;
    // Horizontal velocity is left untouched so jumps keep the player's momentum.
    this.verticalVelocity = 7.1;
    this.grounded = false;
  }

  beginSlide(): void {
    if (this.mode !== 'playing' || !this.grounded || this.slideTimer > 0 || this.slideCooldown > 0) return;
    const input = this.readMovementInput();
    const forwardIntent = Math.max(0, -input.y);
    const forwardSpeed = this.velocityX * -Math.sin(this.yaw) + this.velocityZ * -Math.cos(this.yaw);
    if (forwardIntent < 0.28 || (forwardSpeed < 1.05 && forwardIntent < 0.85)) return;

    this.forwardVector.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.rightVector.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.slideDirection.copy(this.rightVector).multiplyScalar(input.x);
    this.slideDirection.addScaledVector(this.forwardVector, -input.y).normalize();
    this.slideSpeed = clamp(Math.max(forwardSpeed, 5.4), 5.4, SPRINT_SPEED);
    this.slideTimer = SLIDE_DURATION;
    this.slideCooldown = SLIDE_COOLDOWN;
    this.aiming = false;
    this.publishSnapshot(true);
  }

  setFiring(active: boolean): void {
    if (!active) {
      this.fireHeld = false;
      return;
    }
    if (this.mode !== 'playing' || this.reloadTimer > 0) return;
    this.fireHeld = true;
    this.tryShoot();
  }

  toggleAim(): void {
    if (this.mode !== 'playing' || this.slideTimer > 0) return;
    this.aiming = !this.aiming;
    this.publishSnapshot(true);
    this.playSound('ui');
  }

  setAiming(active: boolean): void {
    if (this.mode === 'playing' && (!active || this.slideTimer <= 0)) {
      this.aiming = active;
      this.publishSnapshot(true);
    }
  }

  startReload(): void {
    if (this.mode !== 'playing' || this.reloadTimer > 0 || this.ammo >= MAGAZINE_SIZE || this.reserveAmmo <= 0) return;
    this.fireHeld = false;
    this.reloadTimer = RELOAD_DURATION;
    this.playSound('reload');
    this.publishSnapshot(true);
  }

  private requestMouseLockIfAvailable(): void {
    const isCoarse = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    if (isCoarse || !this.canvas.requestPointerLock) return;
    try {
      const result = this.canvas.requestPointerLock();
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Pointer lock is optional: drag-to-look remains available on desktop.
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
    if (event.code === 'Escape') {
      if (this.mode === 'playing') {
        event.preventDefault();
        this.pause();
      } else if (this.mode === 'paused') {
        event.preventDefault();
        this.resume();
      }
      return;
    }
    if (this.mode !== 'playing') return;

    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
    this.keyState.add(event.code);
    if (event.code === 'Space' && !event.repeat) this.pressJump();
    if ((event.code === 'KeyC' || event.code === 'ControlLeft' || event.code === 'ControlRight') && !event.repeat) {
      this.beginSlide();
    }
    if (event.code === 'KeyR' && !event.repeat) this.startReload();
    if ((event.code === 'KeyQ' || event.code === 'KeyE') && !event.repeat) this.toggleAim();
  }

  private handleKeyUp(event: KeyboardEvent): void {
    this.keyState.delete(event.code);
  }

  private handleMouseDown(event: MouseEvent): void {
    if (this.mode !== 'playing') return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, .touch-control, .touch-look-pad')) return;
    if (target !== this.canvas && !(target instanceof Element && target.closest('.game-canvas'))) return;

    if (event.button === 0) {
      this.mouseLooking = document.pointerLockElement !== this.canvas;
      this.mouseLastX = event.clientX;
      this.mouseLastY = event.clientY;
      if (!document.pointerLockElement) this.requestMouseLockIfAvailable();
      this.setFiring(true);
    } else if (event.button === 2) {
      event.preventDefault();
      this.setAiming(true);
    }
  }

  private handleMouseUp(event: MouseEvent): void {
    if (event.button === 0) {
      this.mouseLooking = false;
      this.setFiring(false);
    } else if (event.button === 2) {
      this.setAiming(false);
    }
  }

  private handleMouseMove(event: MouseEvent): void {
    if (this.mode !== 'playing') return;
    if (document.pointerLockElement === this.canvas) {
      this.lookBy(event.movementX, event.movementY);
      return;
    }
    if (!this.mouseLooking) return;
    const dx = event.clientX - this.mouseLastX;
    const dy = event.clientY - this.mouseLastY;
    this.mouseLastX = event.clientX;
    this.mouseLastY = event.clientY;
    this.lookBy(dx, dy);
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.rafId = window.requestAnimationFrame(this.frame);
    // Keep motion steps stable while advancing timers in real time on slower devices.
    const elapsed = Math.max(0, (now - this.lastFrameAt) / 1000);
    const delta = Math.min(0.1, elapsed);
    const timerDelta = Math.min(0.25, elapsed);
    this.lastFrameAt = now;

    if (document.hidden || this.webglContextLost) return;
    if (this.mode === 'playing') {
      this.updatePlayer(delta, timerDelta);
      this.updateEnemies(delta, timerDelta);
      this.updateWeapon(delta, timerDelta);
      this.updateEffects(timerDelta);
      this.snapshotTimer += timerDelta;
      if (this.snapshotTimer >= 0.16) {
        this.snapshotTimer = 0;
        this.publishSnapshot(false);
      }
    }

    // Menus and pause screens render at 10 Hz; active play uses the display refresh rate.
    if (this.mode !== 'playing' && now - this.lastRenderAt < 100) return;
    this.lastRenderAt = now;
    this.renderer.render(this.scene, this.camera);
  };

  private updatePlayer(delta: number, timerDelta: number): void {
    this.elapsedTime += timerDelta;
    this.slideCooldown = Math.max(0, this.slideCooldown - timerDelta);
    this.slideTimer = Math.max(0, this.slideTimer - timerDelta);
    this.damageFlashTimer = Math.max(0, this.damageFlashTimer - timerDelta);

    const input = this.readMovementInput();
    const inputMagnitude = Math.hypot(input.x, input.y);
    const activeMagnitude = clamp((inputMagnitude - JOYSTICK_DEAD_ZONE) / (1 - JOYSTICK_DEAD_ZONE), 0, 1);
    const throttle = activeMagnitude > 0 ? 0.16 + 0.84 * Math.pow(activeMagnitude, 0.72) : 0;
    const forwardIntent = clamp(-input.y, 0, 1);
    const sliding = this.slideTimer > 0;
    const manualSprint = (this.keyState.has('ShiftLeft') || this.keyState.has('ShiftRight'))
      && forwardIntent > 0.2 && activeMagnitude > 0.08;
    const autoSprint = forwardIntent >= SPRINT_THRESHOLD && activeMagnitude >= 0.78;
    this.sprinting = !sliding && !this.aiming && (manualSprint || autoSprint);

    this.forwardVector.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.rightVector.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (sliding) {
      if (inputMagnitude > JOYSTICK_DEAD_ZONE) {
        this.wishDirection.copy(this.rightVector).multiplyScalar(input.x);
        this.wishDirection.addScaledVector(this.forwardVector, -input.y);
        if (this.wishDirection.lengthSq() > 0.001) {
          this.wishDirection.normalize();
          this.slideDirection.lerp(this.wishDirection, 1 - Math.exp(-1.7 * delta)).normalize();
        }
      }
      this.wishDirection.copy(this.slideDirection).multiplyScalar(this.slideSpeed);
    } else {
      this.wishDirection.copy(this.rightVector).multiplyScalar(input.x);
      this.wishDirection.addScaledVector(this.forwardVector, -input.y);
      if (this.wishDirection.lengthSq() > 0.001) this.wishDirection.normalize();
      const sprintBlend = manualSprint ? 1 : clamp((forwardIntent - 0.76) / (1 - 0.76), 0, 1);
      const topSpeed = this.aiming
        ? AIM_SPEED
        : WALK_SPEED + (SPRINT_SPEED - WALK_SPEED) * sprintBlend;
      this.wishDirection.multiplyScalar(topSpeed * throttle);
    }

    const response = sliding ? 11 : inputMagnitude > JOYSTICK_DEAD_ZONE ? 16 : 12;
    this.velocityX = damp(this.velocityX, this.wishDirection.x, response, delta);
    this.velocityZ = damp(this.velocityZ, this.wishDirection.z, response, delta);
    this.movePlayer(this.velocityX * delta, this.velocityZ * delta);

    if (!this.grounded || this.verticalVelocity > 0) {
      this.verticalVelocity -= 19.5 * delta;
      this.feetY += this.verticalVelocity * delta;
      if (this.feetY <= 0) {
        this.feetY = 0;
        this.verticalVelocity = 0;
        this.grounded = true;
      }
    }

    const moveMagnitude = Math.min(1, Math.hypot(this.velocityX, this.velocityZ) / SPRINT_SPEED);
    this.targetEyeHeight = sliding ? 1.02 : 1.64;
    this.eyeHeight = damp(this.eyeHeight, this.targetEyeHeight, 13, delta);
    this.camera.position.set(this.playerX, this.feetY + this.eyeHeight, this.playerZ);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const targetFov = this.aiming ? 50 : 76;
    const oldFov = this.camera.fov;
    this.camera.fov = damp(this.camera.fov, targetFov, 8.5, delta);
    if (Math.abs(oldFov - this.camera.fov) > 0.02) this.camera.updateProjectionMatrix();

    const cadence = this.sprinting ? 13 : 9;
    this.walkPhase += delta * cadence * moveMagnitude;
  }

  private readMovementInput(): THREE.Vector2 {
    let x = this.moveStickX;
    let y = this.moveStickY;
    if (this.keyState.has('KeyA') || this.keyState.has('ArrowLeft')) x -= 1;
    if (this.keyState.has('KeyD') || this.keyState.has('ArrowRight')) x += 1;
    if (this.keyState.has('KeyW') || this.keyState.has('ArrowUp')) y -= 1;
    if (this.keyState.has('KeyS') || this.keyState.has('ArrowDown')) y += 1;
    this.moveInput.set(clamp(x, -1, 1), clamp(y, -1, 1));
    if (this.moveInput.lengthSq() > 1) this.moveInput.normalize();
    return this.moveInput;
  }

  private isSprinting(): boolean {
    return this.sprinting;
  }

  private movePlayer(deltaX: number, deltaZ: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaZ)) / 0.2));
    const stepX = deltaX / steps;
    const stepZ = deltaZ / steps;
    for (let index = 0; index < steps; index += 1) {
      if (stepX !== 0) {
        if (this.canOccupy(this.playerX + stepX, this.playerZ, PLAYER_RADIUS, true)) {
          this.playerX += stepX;
        } else {
          this.velocityX = 0;
        }
      }
      if (stepZ !== 0) {
        if (this.canOccupy(this.playerX, this.playerZ + stepZ, PLAYER_RADIUS, true)) {
          this.playerZ += stepZ;
        } else {
          this.velocityZ = 0;
        }
      }
    }
  }

  private canOccupy(x: number, z: number, radius: number, includeActors: boolean, ignoredEnemyId = -1): boolean {
    if (x < -ARENA_HALF + radius || x > ARENA_HALF - radius || z < -ARENA_HALF + radius || z > ARENA_HALF - radius) {
      return false;
    }
    for (const collider of this.colliders) {
      const closestX = clamp(x, collider.minX, collider.maxX);
      const closestZ = clamp(z, collider.minZ, collider.maxZ);
      const dx = x - closestX;
      const dz = z - closestZ;
      if (dx * dx + dz * dz < radius * radius) return false;
    }
    if (includeActors) {
      for (const enemy of this.enemies) {
        if (enemy.id === ignoredEnemyId || !enemy.root.visible || enemy.state === 'DEAD' || enemy.state === 'RESPAWNING') continue;
        const dx = x - enemy.root.position.x;
        const dz = z - enemy.root.position.z;
        if (dx * dx + dz * dz < (radius + 0.36) * (radius + 0.36)) return false;
      }
    }
    return true;
  }

  private updateEnemies(delta: number, timerDelta: number): void {
    for (const enemy of this.enemies) {
      if (enemy.state === 'DEAD') {
        enemy.stateTimer -= timerDelta;
        if (enemy.stateTimer <= 0) {
          enemy.state = 'RESPAWNING';
          enemy.stateTimer = 1.15;
          enemy.root.visible = false;
        }
        continue;
      }
      if (enemy.state === 'RESPAWNING') {
        enemy.stateTimer -= timerDelta;
        if (enemy.stateTimer <= 0) this.respawnEnemy(enemy);
        continue;
      }

      if (enemy.hurtTimer > 0) {
        enemy.hurtTimer -= timerDelta;
        if (enemy.hurtTimer <= 0) {
          enemy.armorMaterial.emissive.setHex(0x000000);
          enemy.armorMaterial.emissiveIntensity = 0;
          enemy.state = enemy.resumeState;
        }
      }
      if (enemy.state === 'TAKING_DAMAGE') {
        this.animateEnemy(enemy, delta, false);
        continue;
      }

      const dx = this.playerX - enemy.root.position.x;
      const dz = this.playerZ - enemy.root.position.z;
      const distance = Math.hypot(dx, dz);
      enemy.root.rotation.y = Math.atan2(-dx, -dz);

      if (distance > 20.5) {
        enemy.state = 'IDLE';
        this.animateEnemy(enemy, delta, false);
        continue;
      }
      if (enemy.state === 'IDLE') {
        enemy.state = 'DETECTING';
        enemy.stateTimer = 0.34;
        this.animateEnemy(enemy, delta, false);
        continue;
      }
      if (enemy.state === 'DETECTING') {
        enemy.stateTimer -= timerDelta;
        if (enemy.stateTimer <= 0) enemy.state = 'CHASING';
        this.animateEnemy(enemy, delta, false);
        continue;
      }

      if (distance <= 2.15) {
        enemy.state = 'ATTACKING';
        enemy.attackTimer -= timerDelta;
        if (enemy.attackTimer <= 0) {
          enemy.attackTimer = 1.12;
          this.damagePlayer(10);
        }
        this.animateEnemy(enemy, delta, false);
        continue;
      }

      enemy.state = 'CHASING';
      const invDistance = 1 / Math.max(distance, 0.001);
      const moveX = dx * invDistance * 1.62 * delta;
      const moveZ = dz * invDistance * 1.62 * delta;
      const moved = this.moveEnemy(enemy, moveX, moveZ);
      this.animateEnemy(enemy, delta, moved);
    }
  }

  private moveEnemy(enemy: EnemyBot, moveX: number, moveZ: number): boolean {
    const startX = enemy.root.position.x;
    const startZ = enemy.root.position.z;
    let moved = false;
    if (this.canOccupy(startX + moveX, startZ, 0.36, true, enemy.id)) {
      enemy.root.position.x += moveX;
      moved = true;
    }
    if (this.canOccupy(enemy.root.position.x, startZ + moveZ, 0.36, true, enemy.id)) {
      enemy.root.position.z += moveZ;
      moved = true;
    }
    if (moved) return true;

    // One inexpensive side-step attempt keeps bots from pushing endlessly into cover.
    const sideX = -moveZ * 1.25;
    const sideZ = moveX * 1.25;
    if (this.canOccupy(startX + sideX, startZ + sideZ, 0.36, true, enemy.id)) {
      enemy.root.position.x = startX + sideX;
      enemy.root.position.z = startZ + sideZ;
      return true;
    }
    if (this.canOccupy(startX - sideX, startZ - sideZ, 0.36, true, enemy.id)) {
      enemy.root.position.x = startX - sideX;
      enemy.root.position.z = startZ - sideZ;
      return true;
    }
    return false;
  }

  private animateEnemy(enemy: EnemyBot, delta: number, walking: boolean): void {
    const speed = walking ? 9 : 2.6;
    enemy.walkPhase += delta * speed;
    const stride = walking ? Math.sin(enemy.walkPhase) * 0.34 : Math.sin(enemy.walkPhase) * 0.035;
    enemy.leftLeg.rotation.x = stride;
    enemy.rightLeg.rotation.x = -stride;
    enemy.leftArm.rotation.x = -stride * 0.65 - 0.08;
    enemy.rightArm.rotation.x = stride * 0.65 - 0.08;
    enemy.root.position.y = walking ? Math.abs(Math.sin(enemy.walkPhase * 2)) * 0.025 : 0;
  }

  private damageEnemy(enemyId: number, impactPoint?: THREE.Vector3): void {
    const enemy = this.enemies[enemyId];
    if (!enemy || enemy.state === 'DEAD' || enemy.state === 'RESPAWNING') return;
    const hit = this.raycaster.intersectObjects(enemy.hitMeshes, false)[0];
    if (impactPoint) this.showHitSpark(impactPoint);
    const isHeadshot = hit?.object.position.y > 1.65;
    const damage = isHeadshot ? 50 : 36;
    enemy.hp = Math.max(0, enemy.hp - damage);
    enemy.hpFill.scale.x = Math.max(0.001, enemy.hp / enemy.maxHp);
    enemy.hpFill.position.x = -0.41 + (0.82 * enemy.hp) / (2 * enemy.maxHp);
    enemy.armorMaterial.emissive.setHex(0xff553d);
    enemy.armorMaterial.emissiveIntensity = 0.8;
    enemy.hurtTimer = 0.2;
    enemy.resumeState = enemy.hp <= 0 ? 'DEAD' : 'CHASING';
    enemy.state = enemy.hp <= 0 ? 'DEAD' : 'TAKING_DAMAGE';
    enemy.stateTimer = enemy.hp <= 0 ? 1.0 : 0;
    this.onEvent({ type: 'hit', amount: damage });
    this.playSound('hit');

    if (enemy.hp <= 0) {
      enemy.state = 'DEAD';
      enemy.stateTimer = 1.05;
      enemy.root.rotation.z = (enemy.id % 2 === 0 ? 1 : -1) * 0.52;
      enemy.root.scale.set(1, 0.76, 1);
      enemy.attackTimer = 99;
      this.kills += 1;
      this.onEvent({ type: 'kill' });
      this.playSound('kill');
      this.publishSnapshot(true);
    }
  }

  private respawnEnemy(enemy: EnemyBot): void {
    enemy.spawnIndex = (enemy.spawnIndex + 1) % ENEMY_SPAWNS.length;
    const spawn = ENEMY_SPAWNS[enemy.spawnIndex];
    enemy.root.position.set(spawn.x, 0, spawn.y);
    enemy.root.rotation.set(0, 0, 0);
    enemy.root.scale.set(1, 1, 1);
    enemy.root.visible = true;
    enemy.hp = enemy.maxHp;
    enemy.hpFill.scale.x = 1;
    enemy.hpFill.position.x = 0;
    enemy.state = 'IDLE';
    enemy.resumeState = 'CHASING';
    enemy.stateTimer = 0;
    enemy.attackTimer = 1.1 + enemy.id * 0.25;
    enemy.hurtTimer = 0;
    enemy.armorMaterial.emissive.setHex(0x000000);
    enemy.armorMaterial.emissiveIntensity = 0;
  }

  private damagePlayer(amount: number): void {
    if (this.mode !== 'playing') return;
    this.health = Math.max(0, this.health - amount);
    this.damageFlashTimer = 0.34;
    this.onEvent({ type: 'damage', amount });
    this.playSound('damage');
    this.publishSnapshot(true);
    if (this.health <= 0) {
      this.mode = 'dead';
      this.releaseInputs();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.publishSnapshot(true);
    }
  }

  private tryShoot(): void {
    if (this.mode !== 'playing' || this.reloadTimer > 0 || this.shotCooldown > 0) return;
    if (this.ammo <= 0) {
      this.fireHeld = false;
      this.playSound('empty');
      this.onEvent({ type: 'empty' });
      return;
    }

    this.ammo -= 1;
    this.shotCooldown = 0.105;
    this.recoil = Math.min(1, this.recoil + 0.62);
    this.muzzleTimer = this.muzzleTimerMax;
    this.soundManager.play('shot');

    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(CENTER_NDC, this.camera);
    this.raycaster.far = 62;
    const intersections = this.raycaster.intersectObjects(this.enemyMeshes, false);
    const hit = intersections.find((intersection) => {
      const id = intersection.object.userData.enemyId as number | undefined;
      const enemy = typeof id === 'number' ? this.enemies[id] : undefined;
      return Boolean(enemy && enemy.state !== 'DEAD' && enemy.state !== 'RESPAWNING');
    });
    let endpoint: THREE.Vector3;
    if (hit) {
      const id = hit.object.userData.enemyId as number | undefined;
      if (typeof id === 'number') this.damageEnemy(id, hit.point);
      endpoint = hit.point.clone();
    } else {
      endpoint = this.raycaster.ray.origin.clone().addScaledVector(this.raycaster.ray.direction, 27);
    }
    this.showTracer(endpoint);
    this.publishSnapshot(true);
  }

  private showHitSpark(point: THREE.Vector3): void {
    this.hitSpark.position.copy(point).addScaledVector(this.raycaster.ray.direction, 0.018);
    this.hitSpark.quaternion.copy(this.camera.quaternion);
    this.hitSpark.scale.setScalar(1);
    this.hitSpark.material.opacity = 0.95;
    this.hitSpark.visible = true;
    this.hitSparkTimer = 0.13;
  }

  private showTracer(endpoint: THREE.Vector3): void {
    const origin = this.raycaster.ray.origin;
    this.tracerPositions[0] = origin.x;
    this.tracerPositions[1] = origin.y;
    this.tracerPositions[2] = origin.z;
    this.tracerPositions[3] = endpoint.x;
    this.tracerPositions[4] = endpoint.y;
    this.tracerPositions[5] = endpoint.z;
    const attribute = this.tracerLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    this.tracerLine.geometry.computeBoundingSphere();
    this.tracerLine.visible = true;
    this.tracerLine.material.opacity = 0.72;
    this.tracerTimer = 0.065;
  }

  private updateWeapon(delta: number, timerDelta: number): void {
    this.shotCooldown = Math.max(0, this.shotCooldown - timerDelta);
    this.muzzleTimer = Math.max(0, this.muzzleTimer - timerDelta);
    if (this.fireHeld && this.reloadTimer <= 0 && this.shotCooldown <= 0) this.tryShoot();

    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - timerDelta);
      if (this.reloadTimer === 0) {
        const needed = MAGAZINE_SIZE - this.ammo;
        const loaded = Math.min(needed, this.reserveAmmo);
        this.ammo += loaded;
        this.reserveAmmo -= loaded;
        this.playSound('ui');
        this.publishSnapshot(true);
      }
    }

    this.recoil = damp(this.recoil, 0, 12.5, delta);
    const moving = Math.hypot(this.velocityX, this.velocityZ) > 0.38;
    const sprinting = this.isSprinting() && moving && !this.aiming;
    const sliding = this.slideTimer > 0;
    const aim = this.aiming && !sliding;
    const reloadProgress = this.reloadTimer > 0 ? 1 - this.reloadTimer / RELOAD_DURATION : 1;

    const targetX = aim ? 0.13 : 0.33;
    let targetY = aim ? -0.2 : -0.29;
    const targetZ = aim ? -0.61 : -0.66;
    if (sprinting) targetY -= 0.1;
    if (sliding) targetY -= 0.23;
    if (this.reloadTimer > 0) targetY -= 0.055;
    const jumpFactor = clamp(this.feetY / 0.72, 0, 1);
    targetY += jumpFactor * 0.045;

    const bobScale = moving ? (aim ? 0.012 : sprinting ? 0.045 : 0.027) : 0.006;
    const bobX = Math.sin(this.walkPhase * 0.5) * bobScale;
    const idleBreath = moving ? 0 : Math.sin(this.elapsedTime * 1.7) * 0.006;
    const bobY = Math.abs(Math.cos(this.walkPhase)) * bobScale + idleBreath;
    const reloadDip = this.reloadTimer > 0 ? Math.sin(reloadProgress * Math.PI) * 0.035 : 0;
    const targetPosition = this.tmpVector.set(
      targetX + bobX,
      targetY + bobY - reloadDip + (sliding ? -0.02 : 0),
      targetZ + this.recoil * 0.085,
    );
    this.weaponGroup.position.lerp(targetPosition, 1 - Math.exp(-10 * delta));
    this.weaponGroup.rotation.x = damp(
      this.weaponGroup.rotation.x,
      (sliding ? 0.25 : 0.015 - jumpFactor * 0.07) - this.recoil * 0.12,
      12,
      delta,
    );
    this.weaponGroup.rotation.y = damp(
      this.weaponGroup.rotation.y,
      aim ? 0 : 0.01 + Math.sin(this.elapsedTime * 0.8) * 0.004,
      10,
      delta,
    );
    this.weaponGroup.rotation.z = damp(
      this.weaponGroup.rotation.z,
      sliding ? -0.22 : sprinting ? -0.06 : Math.sin(this.elapsedTime * 1.15) * 0.007,
      10,
      delta,
    );

    const reloadPhase = this.reloadTimer > 0 ? reloadProgress : 1;
    const magDrop = this.reloadTimer > 0 && reloadPhase > 0.2 && reloadPhase < 0.68
      ? Math.sin(((reloadPhase - 0.2) / 0.48) * Math.PI) * 0.18
      : 0;
    this.magazineGroup.position.y = -0.13 - magDrop;
    this.magazineGroup.rotation.x = magDrop > 0.01 ? -0.22 : 0;
    this.muzzleFlash.visible = this.muzzleTimer > 0;
    this.muzzleFlash.scale.setScalar(1);
  }

  private updateEffects(timerDelta: number): void {
    if (this.tracerTimer > 0) {
      this.tracerTimer = Math.max(0, this.tracerTimer - timerDelta);
      this.tracerLine.material.opacity = Math.min(0.72, this.tracerTimer / 0.065 * 0.72);
      if (this.tracerTimer <= 0) this.tracerLine.visible = false;
    }
    if (this.hitSparkTimer > 0) {
      this.hitSparkTimer = Math.max(0, this.hitSparkTimer - timerDelta);
      const progress = this.hitSparkTimer / 0.13;
      this.hitSpark.material.opacity = progress * 0.95;
      this.hitSpark.scale.setScalar(0.45 + (1 - progress) * 0.8);
      if (this.hitSparkTimer <= 0) this.hitSpark.visible = false;
    }
  }

  private releaseInputs(): void {
    this.keyState.clear();
    this.moveStickX = 0;
    this.moveStickY = 0;
    this.fireHeld = false;
    this.mouseLooking = false;
    this.sprinting = false;
    this.aiming = false;
    this.slideTimer = 0;
    this.velocityX *= 0.25;
    this.velocityZ *= 0.25;
  }

  private publishSnapshot(force: boolean): void {
    const snapshot = this.getSnapshot();
    const key = [
      snapshot.mode,
      snapshot.health,
      snapshot.ammo,
      snapshot.reserve,
      snapshot.kills,
      snapshot.aiming,
      snapshot.reloading,
      snapshot.sprinting,
      snapshot.radarContacts.map((contact) => `${contact.x.toFixed(2)},${contact.y.toFixed(2)}`).join(';'),
    ].join('|');
    if (!force && key === this.lastSnapshotKey) return;
    this.lastSnapshotKey = key;
    this.onSnapshot(snapshot);
  }

  private playSound(cue: SoundCue): void {
    this.soundManager.play(cue);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of objectMaterials) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const material of Object.values(this.material)) material.dispose();
    if (this.scene.background instanceof THREE.Texture) this.scene.background.dispose();
    this.renderer.dispose();
    this.soundManager.dispose();
  }
}
