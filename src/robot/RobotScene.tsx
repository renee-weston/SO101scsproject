import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import { createJstConnectorModel } from "./jstConnector";
import { jointConfigs } from "../game/calibration/calibrationConfig";
import type {
  CalibrationState,
  JointName,
  JointValues,
} from "../game/calibration/calibrationTypes";

export type RobotCalibrationOverlay = {
  target: "follower" | "leader";
  jointName?: JointName | null;
  calibration?: CalibrationState | null;
  showAllMidpoints?: boolean;
  showRangeMarkers?: boolean;
};

export type ConnectorPick = {
  id: number;
  label: string;
  target: "follower" | "leader";
  objectName: string;
  linkName: string | null;
  world: [number, number, number];
  objectLocal: [number, number, number];
  linkLocal: [number, number, number] | null;
};

/** Stable id for a JST connector (e.g. "gripper", "wrist"; more may be added). */
export type ConnectorKey = string;

export type ConnectorAdjust = {
  /** Position offset in the connector's own local frame, metres. */
  px: number;
  py: number;
  pz: number;
  /** Extra rotation about the connector's own local axes, degrees. */
  rx: number;
  ry: number;
  rz: number;
};

/** Per-connector adjust, keyed by which JST it is. */
export type ConnectorAdjustMap = Partial<Record<ConnectorKey, ConnectorAdjust>>;

type RobotSceneProps = {
  jointValues?: JointValues;
  leaderJointValues?: JointValues;
  highlightedJoint?: JointName | null;
  highlightedLeaderJoint?: JointName | null;
  embedded?: boolean;
  guidedFocusJoint?: JointName | null;
  calibrationOverlay?: RobotCalibrationOverlay | null;
  directControlEnabled?: boolean;
  directControlTarget?: "follower" | "leader";
  showLeaderArm?: boolean;
  teleoperationActive?: boolean;
  connectorPickMode?: boolean;
  connectorPickClearToken?: number;
  connectorAdjust?: ConnectorAdjustMap;
  motorSetupActive?: boolean;
  motorSetupTarget?: "follower" | "leader";
  motorSetupActiveJoint?: JointName | null;
  motorSetupConfiguredJoints?: JointName[];
  /** The motor the student has currently "plugged into" the board (live wire). */
  motorSetupConnectedJoint?: JointName | null;
  /** True once the current arm's motor-ID setup is finished (final step). */
  motorSetupChained?: boolean;
  /** Stage 1 USB identification: show clickable USB ports on the boards. */
  usbSetupActive?: boolean;
  /** Which arms currently have their USB cable plugged into the board. */
  usbConnections?: { follower: boolean; leader: boolean };
  /** The arm whose USB port the wizard is asking about (pulses for attention). */
  usbActiveArm?: "follower" | "leader" | null;
  onUsbPortClick?: (arm: "follower" | "leader") => void;
  onConnectorsChange?: (ids: ConnectorKey[]) => void;
  selectableJoints?: JointName[];
  onJointSelect?: (jointName: JointName) => void;
  onJointValueChange?: (jointName: JointName, value: number) => void;
  onLeaderJointSelect?: (jointName: JointName) => void;
  onLeaderJointValueChange?: (jointName: JointName, value: number) => void;
  onConnectorPick?: (pick: ConnectorPick) => void;
  onMotorSetupMotorSelect?: (
    target: "follower" | "leader",
    jointName: JointName,
  ) => void;
};

type MeshLoadDone = (mesh: THREE.Object3D | null, err?: Error) => void;
type CableAnchor = {
  object: THREE.Object3D;
  localPosition: THREE.Vector3;
  exitLocalPosition?: THREE.Vector3;
  exitNormal?: THREE.Vector3;
  resolveWorldPosition?: () => THREE.Vector3;
};
type DynamicCable = {
  anchors: CableAnchor[];
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.Material>;
  owner: "follower" | "leader";
  radius: number;
  segments: number;
  // Last world-space anchor points the tube was built from — used to skip the
  // (expensive) geometry rebuild when nothing moved this frame.
  lastPoints?: THREE.Vector3[];
};

const modelUrl = "/models/so101/so101.urdf";
const leaderModelUrl = "/models/so101-leader/so101_leader.urdf";
const minimumRobotDimension = 0.2;
const renderSmoothingAlpha = 0.22;
const directManipulationJumpThreshold = 45;
const dualArmTeleoperationSpacing = 0.7;
const cursorDefault = 'url("/cursors/simple-orange/orange-pointer.cur"), auto';
const cursorPointer = 'url("/cursors/simple-orange/orange-link.cur"), pointer';
const cursorMove = 'url("/cursors/simple-orange/orange-move.cur"), move';
const cursorPrecision =
  'url("/cursors/simple-orange/orange-precision.cur"), crosshair';

// Maps each motor to the REAL harness JST connector that sits on its link — the
// one that "unplugs" and goes to the board during Stage-2 setup.
const MOTOR_TO_CONNECTOR: Record<JointName, ConnectorKey> = {
  gripper: "gripper",
  wrist_roll: "wrist",
  wrist_flex: "lowerArm",
  elbow_flex: "upperArm",
  shoulder_lift: "shoulder",
  shoulder_pan: "base",
};
// The Stage-2 camera is offset along the connector's mounting (Y) axis. For the
// 3rd motor onward (wrist_flex → shoulder_pan) that axis points to the opposite
// side, so the offset sign is flipped to keep the camera on the correct side.
const SETUP_VIEW_FLIP_Y: Set<JointName> = new Set<JointName>([
  "wrist_flex",
  "elbow_flex",
  "shoulder_lift",
  "shoulder_pan",
]);
// Per-motor Stage-2 camera tweaks. `ySign` overrides the flip-set sign; `upBias`
// shifts the view up (+) or below (−) the connector; `allowBelow` lets the camera
// drop beneath the part (for a diagonal-from-below look) instead of being clamped
// above it.
type SetupCamCfg = {
  ySign?: number;
  upBias?: number;
  allowBelow?: boolean;
  // Orbit the camera around the vertical axis by this many degrees (+ = to the
  // right). Lets a single motor be viewed from a perpendicular side.
  rotateDeg?: number;
  // Camera distance from the framed point (default 0.44). Larger = further away.
  dist?: number;
  // How far the board floats toward the camera from the connector mount (default
  // 0.06). Larger = board sits closer to the screen.
  boardForward?: number;
  // Roll the view around the camera's view axis by this many degrees (+ = the
  // image turns clockwise). Rotates the locked up-vector, not the orbit position.
  rollDeg?: number;
  // Shift the board DOWN in screen space (along −cameraUp) by this many metres.
  // Honours the view's roll so "down" matches what the user sees on screen.
  boardDown?: number;
};
const SETUP_CAM_CFG: Partial<Record<JointName, SetupCamCfg>> = {
  // Motor 2: view from the TOP-RIGHT — elevated (upBias up) and orbited to the
  // right, pulled further back for context. Board pulled close to the screen
  // (boardForward) while the real wire keeps trailing back to the motor.
  wrist_roll: { upBias: 0.95, rotateDeg: 110, dist: 0.62, boardForward: 0.42 },
  // Last motor (base): view from BELOW the robot, steep + symmetric so the
  // splayed base feet and servo face fill the frame (per user ref).
  shoulder_pan: { ySign: -1, upBias: -1.4, allowBelow: true, rotateDeg: 90, rollDeg: 45, boardDown: 0.08 },
};

const defaultJointValues = Object.keys(jointConfigs).reduce(
  (values, jointName) => {
    const key = jointName as JointName;
    values[key] = jointConfigs[key].midpoint;
    return values;
  },
  {} as JointValues,
);

const disposeMaterial = (material: THREE.Material | THREE.Material[]) => {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry.dispose());
    return;
  }

  material.dispose();
};

const isRobotAccessory = (object: THREE.Object3D) =>
  object.userData.robotAccessory === true;

const isConnectorPickSurface = (object: THREE.Object3D) =>
  object.userData.connectorPickSurface === true;

const shortestAngleDelta = (from: number, to: number) => {
  let delta = to - from;

  while (delta > 180) {
    delta -= 360;
  }

  while (delta < -180) {
    delta += 360;
  }

  return delta;
};

const cloneJointValues = (values: JointValues): JointValues =>
  Object.keys(jointConfigs).reduce((nextValues, jointName) => {
    const key = jointName as JointName;
    nextValues[key] = values[key];

    return nextValues;
  }, {} as JointValues);

const smoothRenderedJointValues = (
  renderedValues: JointValues,
  targetValues: JointValues,
) => {
  Object.keys(jointConfigs).forEach((jointName) => {
    const key = jointName as JointName;
    const config = jointConfigs[key];
    const delta = shortestAngleDelta(renderedValues[key], targetValues[key]);
    const nextValue =
      Math.abs(delta) < 0.05
        ? targetValues[key]
        : renderedValues[key] + delta * renderSmoothingAlpha;

    renderedValues[key] = Math.min(
      config.max,
      Math.max(config.min, nextValue),
    );
  });
};

export default function RobotScene({
  jointValues = defaultJointValues,
  leaderJointValues = defaultJointValues,
  highlightedJoint = null,
  highlightedLeaderJoint = null,
  embedded = false,
  guidedFocusJoint = null,
  calibrationOverlay = null,
  directControlEnabled = false,
  directControlTarget = "follower",
  showLeaderArm = false,
  connectorPickMode = false,
  connectorPickClearToken = 0,
  connectorAdjust,
  motorSetupActive = false,
  motorSetupTarget = "follower",
  motorSetupActiveJoint = null,
  motorSetupConfiguredJoints = [],
  motorSetupConnectedJoint = null,
  motorSetupChained = false,
  usbSetupActive = false,
  usbConnections = { follower: false, leader: false },
  usbActiveArm = null,
  onUsbPortClick,
  onConnectorsChange,
  selectableJoints = [],
  onJointSelect,
  onJointValueChange,
  onLeaderJointSelect,
  onLeaderJointValueChange,
  onConnectorPick,
  onMotorSetupMotorSelect,
}: RobotSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const robotRef = useRef<URDFRobot | null>(null);
  const leaderRobotRef = useRef<URDFRobot | null>(null);
  const jointValuesRef = useRef(jointValues);
  const leaderJointValuesRef = useRef(leaderJointValues);
  const renderedJointValuesRef = useRef(cloneJointValues(jointValues));
  const renderedLeaderJointValuesRef = useRef(
    cloneJointValues(leaderJointValues),
  );
  const highlightedJointRef = useRef<JointName | null>(highlightedJoint);
  const highlightedLeaderJointRef = useRef<JointName | null>(
    highlightedLeaderJoint,
  );
  const embeddedRef = useRef(embedded);
  const guidedFocusJointRef = useRef<JointName | null>(guidedFocusJoint);
  const calibrationOverlayRef = useRef<RobotCalibrationOverlay | null>(
    calibrationOverlay,
  );
  const directControlEnabledRef = useRef(directControlEnabled);
  const directControlTargetRef = useRef(directControlTarget);
  const showLeaderArmRef = useRef(showLeaderArm);
  const connectorPickModeRef = useRef(connectorPickMode);
  const connectorPickClearTokenRef = useRef(connectorPickClearToken);
  const connectorAdjustRef = useRef(connectorAdjust);
  const motorSetupActiveRef = useRef(motorSetupActive);
  const motorSetupTargetRef = useRef(motorSetupTarget);
  const motorSetupActiveJointRef = useRef<JointName | null>(
    motorSetupActiveJoint,
  );
  const motorSetupConfiguredJointsRef = useRef(motorSetupConfiguredJoints);
  const motorSetupConnectedJointRef = useRef<JointName | null>(
    motorSetupConnectedJoint,
  );
  const motorSetupChainedRef = useRef(motorSetupChained);
  const usbSetupActiveRef = useRef(usbSetupActive);
  const usbConnectionsRef = useRef(usbConnections);
  const usbActiveArmRef = useRef(usbActiveArm);
  const onUsbPortClickRef = useRef(onUsbPortClick);
  const onConnectorsChangeRef = useRef(onConnectorsChange);
  const selectableJointsRef = useRef(selectableJoints);
  const onJointSelectRef = useRef(onJointSelect);
  const onJointValueChangeRef = useRef(onJointValueChange);
  const onLeaderJointSelectRef = useRef(onLeaderJointSelect);
  const onLeaderJointValueChangeRef = useRef(onLeaderJointValueChange);
  const onConnectorPickRef = useRef(onConnectorPick);
  const onMotorSetupMotorSelectRef = useRef(onMotorSetupMotorSelect);
  const originalMaterialsRef = useRef(
    new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>(),
  );
  const highlightedMaterialsRef = useRef<THREE.Material[]>([]);

  useEffect(() => {
    jointValuesRef.current = jointValues;
  }, [jointValues]);

  useEffect(() => {
    leaderJointValuesRef.current = leaderJointValues;
  }, [leaderJointValues]);

  useEffect(() => {
    highlightedJointRef.current = highlightedJoint;
  }, [highlightedJoint]);

  useEffect(() => {
    highlightedLeaderJointRef.current = highlightedLeaderJoint;
  }, [highlightedLeaderJoint]);

  useEffect(() => {
    embeddedRef.current = embedded;
  }, [embedded]);

  useEffect(() => {
    guidedFocusJointRef.current = guidedFocusJoint;
  }, [guidedFocusJoint]);

  useEffect(() => {
    calibrationOverlayRef.current = calibrationOverlay;
  }, [calibrationOverlay]);

  useEffect(() => {
    directControlEnabledRef.current = directControlEnabled;
  }, [directControlEnabled]);

  useEffect(() => {
    directControlTargetRef.current = directControlTarget;
  }, [directControlTarget]);

  useEffect(() => {
    showLeaderArmRef.current = showLeaderArm;
  }, [showLeaderArm]);

  useEffect(() => {
    connectorPickModeRef.current = connectorPickMode;
  }, [connectorPickMode]);

  useEffect(() => {
    connectorPickClearTokenRef.current = connectorPickClearToken;
  }, [connectorPickClearToken]);

  useEffect(() => {
    connectorAdjustRef.current = connectorAdjust;
  }, [connectorAdjust]);

  useEffect(() => {
    motorSetupActiveRef.current = motorSetupActive;
  }, [motorSetupActive]);

  useEffect(() => {
    motorSetupTargetRef.current = motorSetupTarget;
  }, [motorSetupTarget]);

  useEffect(() => {
    motorSetupActiveJointRef.current = motorSetupActiveJoint;
  }, [motorSetupActiveJoint]);

  useEffect(() => {
    motorSetupConfiguredJointsRef.current = motorSetupConfiguredJoints;
  }, [motorSetupConfiguredJoints]);

  useEffect(() => {
    motorSetupConnectedJointRef.current = motorSetupConnectedJoint;
  }, [motorSetupConnectedJoint]);

  useEffect(() => {
    motorSetupChainedRef.current = motorSetupChained;
  }, [motorSetupChained]);

  useEffect(() => {
    usbSetupActiveRef.current = usbSetupActive;
  }, [usbSetupActive]);

  useEffect(() => {
    usbConnectionsRef.current = usbConnections;
  }, [usbConnections]);

  useEffect(() => {
    usbActiveArmRef.current = usbActiveArm;
  }, [usbActiveArm]);

  useEffect(() => {
    onUsbPortClickRef.current = onUsbPortClick;
  }, [onUsbPortClick]);

  useEffect(() => {
    onConnectorsChangeRef.current = onConnectorsChange;
  }, [onConnectorsChange]);

  useEffect(() => {
    selectableJointsRef.current = selectableJoints;
  }, [selectableJoints]);

  useEffect(() => {
    onJointSelectRef.current = onJointSelect;
  }, [onJointSelect]);

  useEffect(() => {
    onJointValueChangeRef.current = onJointValueChange;
  }, [onJointValueChange]);

  useEffect(() => {
    onLeaderJointSelectRef.current = onLeaderJointSelect;
  }, [onLeaderJointSelect]);

  useEffect(() => {
    onLeaderJointValueChangeRef.current = onLeaderJointValueChange;
  }, [onLeaderJointValueChange]);

  useEffect(() => {
    onConnectorPickRef.current = onConnectorPick;
  }, [onConnectorPick]);

  useEffect(() => {
    onMotorSetupMotorSelectRef.current = onMotorSetupMotorSelect;
  }, [onMotorSetupMotorSelect]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let isMounted = true;
    let animationFrameId = 0;
    let lastHighlightedJoint: JointName | null | undefined;
    let lastHighlightedLeaderJoint: JointName | null | undefined;
    let lastHoveredJoint: JointName | null | undefined;
    const followerHomePosition = new THREE.Vector3();
    let lastShowLeaderLayout: boolean | null = null;
    let lastConnectorPickClearToken = connectorPickClearTokenRef.current;
    let connectorPickCount = 0;
    let dragState: {
      jointName: JointName;
      target: "follower" | "leader";
      previousValue: number;
      axisWorld: THREE.Vector3;
      originWorld: THREE.Vector3;
      startVector: THREE.Vector3;
      previousVector: THREE.Vector3;
      pointerId: number;
    } | null = null;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x001f3f);

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.01,
      100,
    );
    camera.position.set(
      embeddedRef.current ? 1.05 : 1.4,
      embeddedRef.current ? 0.75 : 1.1,
      embeddedRef.current ? 1.25 : 1.7,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.35;
    controls.maxDistance = 8;
    controls.zoomToCursor = true;
    controls.enabled = !embeddedRef.current;
    controls.target.set(0, 0.25, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.6));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(2.8, 4, 3.2);
    keyLight.castShadow = false;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xffc27a, 0.9);
    rimLight.position.set(-3, 2.5, -2);
    scene.add(rimLight);

    const floorGeometry = new THREE.PlaneGeometry(4, 4);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x002b5c,
      roughness: 0.9,
      metalness: 0,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = false;
    scene.add(floor);

    const grid = new THREE.GridHelper(4, 20, 0xff9d2e, 0x1d4b7a);
    grid.position.y = 0.002;
    scene.add(grid);

    const robotDetails = new THREE.Group();
    scene.add(robotDetails);
    const accessoryRoots: THREE.Object3D[] = [];
    let dynamicCables: DynamicCable[] = [];
    const wirePinCaps: THREE.Object3D[] = [];
    const wireConnectorTips: THREE.Object3D[] = [];
    // Connector groups that the live position/rotation adjust applies to. Each
    // keeps the base (computed) local transform so the user offset is relative.
    const adjustableConnectors: {
      key: ConnectorKey;
      group: THREE.Object3D;
      basePosition: THREE.Vector3;
      baseQuaternion: THREE.Quaternion;
      owner: "follower" | "leader";
      link: THREE.Object3D;
      /** Cloned glow materials per child mesh + the originals, for the active glow. */
      glowMaterials?: THREE.MeshStandardMaterial[];
      baseMeshMaterials?: THREE.Material[];
      glowMeshes?: THREE.Mesh[];
      /** Persistent Stage-2 animation state (link-local) so the unplug→dock motion
       *  accumulates across frames instead of being reset to the mount each frame. */
      animPos?: THREE.Vector3;
      animQuat?: THREE.Quaternion;
    }[] = [];

    // Registry of mounted motor accessories so the Stage-2 visuals (active glow,
    // configured tint, dim others) can recolour them every frame.
    type MotorSetupEntry = {
      group: THREE.Group;
      jointName: JointName;
      target: "follower" | "leader";
      meshes: THREE.Mesh[];
      baseMaterials: THREE.Material[];
      setupMaterials: THREE.MeshStandardMaterial[];
      baseScale: number;
    };
    const motorSetupEntries: MotorSetupEntry[] = [];
    // Registry of the clickable USB ports + plugs on each board (Stage 1).
    type UsbPortEntry = {
      arm: "follower" | "leader";
      portMesh: THREE.Mesh;
      portMaterial: THREE.MeshStandardMaterial;
      plug: THREE.Group;
      plugInPosition: THREE.Vector3;
      plugOutPosition: THREE.Vector3;
      // Anchor at the far end of the plug's Type-C cable stub — the Stage-1 USB
      // cable to the laptop EXTENDS from here (not a separate cable).
      plugCableEnd: THREE.Object3D;
      // Anchor at the board's power jack (grey box, left edge) — the power cable
      // to the strip stems from here.
      powerSource: THREE.Object3D;
    };
    const usbPortEntries: UsbPortEntry[] = [];
    // The arm-attached controller boards (hidden during Stage-2 per-motor setup,
    // because the board is "detached" and represented by the floating board).
    const attachedBoards: THREE.Object3D[] = [];

    const detailMaterials = {
      servo: new THREE.MeshStandardMaterial({
        color: 0x171b22,
        roughness: 0.58,
        metalness: 0.18,
      }),
      metal: new THREE.MeshStandardMaterial({
        color: 0xaeb6c2,
        roughness: 0.38,
        metalness: 0.62,
      }),
      board: new THREE.MeshStandardMaterial({
        color: 0x174c39,
        roughness: 0.64,
        metalness: 0.08,
      }),
      boardComponent: new THREE.MeshStandardMaterial({
        color: 0xf1e4b8,
        roughness: 0.55,
        metalness: 0.03,
      }),
      redWire: new THREE.MeshStandardMaterial({
        color: 0xc83b3b,
        roughness: 0.44,
        metalness: 0.03,
      }),
      blackWire: new THREE.MeshStandardMaterial({
        color: 0x090b0e,
        roughness: 0.5,
        metalness: 0.04,
      }),
      whiteWire: new THREE.MeshStandardMaterial({
        color: 0xf4f7fb,
        roughness: 0.48,
        metalness: 0.02,
      }),
      connectorPlastic: new THREE.MeshStandardMaterial({
        color: 0xf1f4ef,
        roughness: 0.62,
        metalness: 0.02,
      }),
      usbCable: new THREE.MeshStandardMaterial({
        color: 0x24292f,
        roughness: 0.62,
        metalness: 0.05,
      }),
    };

    const gizmoGeometry = new THREE.TorusGeometry(0.08, 0.006, 12, 48);
    const gizmoMaterial = new THREE.MeshStandardMaterial({
      color: 0xff9d2e,
      emissive: 0xff9d2e,
      emissiveIntensity: 0.65,
    });
    const jointGizmo = new THREE.Mesh(gizmoGeometry, gizmoMaterial);
    jointGizmo.visible = false;
    scene.add(jointGizmo);

    const hoverGizmoMaterial = new THREE.MeshStandardMaterial({
      color: 0xffcf92,
      emissive: 0xff9d2e,
      emissiveIntensity: 0.24,
      transparent: true,
      opacity: 0.62,
    });
    const hoverGizmo = new THREE.Mesh(gizmoGeometry.clone(), hoverGizmoMaterial);
    hoverGizmo.visible = false;
    scene.add(hoverGizmo);

    // ---- Stage 2: the detached controller board, HELD in front of the screen.
    // Its meshes draw on top of everything (depthTest off + high renderOrder) so
    // the board + the cable-plugging motion are visible no matter what the robot
    // geometry is in the way.
    const HUD_RENDER_ORDER = 9000;
    const setupBoardGroup = new THREE.Group();
    setupBoardGroup.name = "setup_detached_board";
    setupBoardGroup.visible = false;
    const onTop = (mesh: THREE.Mesh, order: number) => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        (m as THREE.Material).depthTest = false;
        (m as THREE.Material).depthWrite = false;
        (m as THREE.Material).transparent = true;
      });
      mesh.renderOrder = order;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    };
    const setupBoardMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a523b,
      roughness: 0.55,
      metalness: 0.12,
      emissive: 0x0f5235,
      emissiveIntensity: 0.5,
    });
    const setupBoardPanel = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.05, 0.007),
      setupBoardMaterial,
    );
    setupBoardGroup.add(setupBoardPanel);
    onTop(setupBoardPanel, HUD_RENDER_ORDER);
    const setupBoardChip = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.016, 0.005),
      new THREE.MeshStandardMaterial({ color: 0xf1e4b8, roughness: 0.55 }),
    );
    setupBoardChip.position.set(0.01, 0.009, 0.006);
    setupBoardGroup.add(setupBoardChip);
    onTop(setupBoardChip, HUD_RENDER_ORDER + 1);
    const setupUsbStub = new THREE.Mesh(
      new THREE.BoxGeometry(0.011, 0.014, 0.008),
      new THREE.MeshStandardMaterial({ color: 0xaeb6c2, roughness: 0.38, metalness: 0.62 }),
    );
    setupUsbStub.position.set(0.034, -0.012, 0.005);
    setupBoardGroup.add(setupUsbStub);
    onTop(setupUsbStub, HUD_RENDER_ORDER + 1);
    // Socket on the board where a motor's loose connector plugs in (glows to
    // invite the next connection).
    const setupBoardSocketMaterial = new THREE.MeshStandardMaterial({
      color: 0x10171f,
      roughness: 0.5,
      metalness: 0.2,
      emissive: 0xff9d2e,
      emissiveIntensity: 0.3,
    });
    const setupBoardSocket = new THREE.Mesh(
      new THREE.BoxGeometry(0.017, 0.012, 0.009),
      setupBoardSocketMaterial,
    );
    setupBoardSocket.position.set(-0.027, -0.022, 0.006);
    setupBoardGroup.add(setupBoardSocket);
    onTop(setupBoardSocket, HUD_RENDER_ORDER + 2);
    const setupBoardPort = new THREE.Object3D();
    setupBoardPort.position.set(-0.027, -0.03, 0.006);
    setupBoardGroup.add(setupBoardPort);
    scene.add(setupBoardGroup);

    // ---- Stage 1 rig: a laptop (both arms plug into the SAME computer over USB)
    // and a power strip (each arm's power plug goes in). Only shown in Stage 1. ----
    const stageOneRig = new THREE.Group();
    stageOneRig.name = "stage_one_rig";
    stageOneRig.visible = false;
    scene.add(stageOneRig);

    const laptopBodyMat = new THREE.MeshStandardMaterial({
      color: 0x9aa2ac,
      roughness: 0.52,
      metalness: 0.22,
    });
    const laptopScreenCanvas = document.createElement("canvas");
    laptopScreenCanvas.width = 1024;
    laptopScreenCanvas.height = 576;
    const laptopScreenContext = laptopScreenCanvas.getContext("2d");

    if (laptopScreenContext) {
      const gradient = laptopScreenContext.createLinearGradient(
        0,
        0,
        laptopScreenCanvas.width,
        laptopScreenCanvas.height,
      );
      gradient.addColorStop(0, "#133f9b");
      gradient.addColorStop(1, "#071b4a");
      laptopScreenContext.fillStyle = gradient;
      laptopScreenContext.fillRect(
        0,
        0,
        laptopScreenCanvas.width,
        laptopScreenCanvas.height,
      );

      laptopScreenContext.strokeStyle = "rgba(112, 205, 255, 0.16)";
      laptopScreenContext.lineWidth = 2;
      for (let x = 0; x <= laptopScreenCanvas.width; x += 64) {
        laptopScreenContext.beginPath();
        laptopScreenContext.moveTo(x, 0);
        laptopScreenContext.lineTo(x, laptopScreenCanvas.height);
        laptopScreenContext.stroke();
      }
      for (let y = 0; y <= laptopScreenCanvas.height; y += 48) {
        laptopScreenContext.beginPath();
        laptopScreenContext.moveTo(0, y);
        laptopScreenContext.lineTo(laptopScreenCanvas.width, y);
        laptopScreenContext.stroke();
      }

      laptopScreenContext.textAlign = "center";
      laptopScreenContext.textBaseline = "middle";
      laptopScreenContext.shadowColor = "#7ff7ff";
      laptopScreenContext.shadowBlur = 18;
      laptopScreenContext.fillStyle = "#dffaff";
      laptopScreenContext.font =
        '700 54px "Courier New", "Lucida Console", monospace';
      laptopScreenContext.fillText(
        "Developed by",
        laptopScreenCanvas.width / 2,
        224,
      );
      laptopScreenContext.font =
        '700 74px "Courier New", "Lucida Console", monospace';
      laptopScreenContext.fillText(
        "Weston Robot!",
        laptopScreenCanvas.width / 2,
        330,
      );
    }

    const laptopScreenTexture = new THREE.CanvasTexture(laptopScreenCanvas);
    laptopScreenTexture.colorSpace = THREE.SRGBColorSpace;
    laptopScreenTexture.anisotropy = 4;
    const laptopScreenMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: laptopScreenTexture,
      emissive: 0x2f6bd8,
      emissiveMap: laptopScreenTexture,
      emissiveIntensity: 0.28,
      roughness: 0.3,
      metalness: 0.1,
    });
    const powerBodyMat = new THREE.MeshStandardMaterial({
      color: 0x14181e,
      roughness: 0.6,
      metalness: 0.1,
    });

    // Laptop — base deck + reclined screen with a glowing panel. Placed in front
    // of the arms, screen facing the viewer. (Position tuned to the scene below.)
    const laptopGroup = new THREE.Group();
    const laptopBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.014, 0.2),
      laptopBodyMat,
    );
    laptopBase.position.y = 0.007;
    laptopBase.castShadow = false;
    laptopGroup.add(laptopBase);
    const laptopHinge = new THREE.Group();
    laptopHinge.position.set(0, 0.012, -0.098);
    const laptopScreen = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.19, 0.009),
      laptopBodyMat,
    );
    laptopScreen.position.y = 0.095;
    laptopScreen.castShadow = false;
    laptopHinge.add(laptopScreen);
    const laptopScreenGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.275, 0.165),
      laptopScreenMat,
    );
    laptopScreenGlow.position.set(0, 0.095, 0.006);
    laptopHinge.add(laptopScreenGlow);
    laptopHinge.rotation.x = -0.32; // recline the lid ~18° back from vertical
    laptopGroup.add(laptopHinge);
    // A USB port on each SIDE edge of the laptop, so each arm's cable connects to
    // its own near side instead of a cord crossing over the keyboard deck.
    // A = follower (right edge, +x), B = leader (left edge, −x).
    const laptopUsbAnchorA = new THREE.Object3D();
    laptopUsbAnchorA.position.set(0.158, 0.006, 0.0);
    laptopGroup.add(laptopUsbAnchorA);
    const laptopUsbAnchorB = new THREE.Object3D();
    laptopUsbAnchorB.position.set(-0.158, 0.006, 0.0);
    laptopGroup.add(laptopUsbAnchorB);
    laptopGroup.position.set(0, 0, 0.52);
    laptopGroup.rotation.y = 0.35;
    stageOneRig.add(laptopGroup);

    // Power strip on the floor beside the laptop, with two sockets.
    const powerStrip = new THREE.Group();
    const powerStripBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.022, 0.05),
      powerBodyMat,
    );
    powerStripBody.position.y = 0.011;
    powerStripBody.castShadow = false;
    powerStrip.add(powerStripBody);
    const powerSocketAnchors: THREE.Object3D[] = [];
    [-0.038, 0.038].forEach((sx) => {
      const socket = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.006, 0.03),
        new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.7 }),
      );
      socket.position.set(sx, 0.023, 0);
      powerStrip.add(socket);
      const anchor = new THREE.Object3D();
      anchor.position.set(sx, 0.03, 0);
      powerStrip.add(anchor);
      powerSocketAnchors.push(anchor);
    });
    powerStrip.position.set(0.2, 0, 0.44);
    powerStrip.rotation.y = 0.35;
    stageOneRig.add(powerStrip);

    // Cables linking each arm to the laptop (USB) and the power strip (power),
    // plus a power plug per arm that animates into its socket. Rebuilt each frame
    // while Stage 1 is active (endpoints move with the arms).
    // Matches the plug body (detailMaterials.usbCable) so the cable and plug read
    // as one continuous Type-C cable.
    const usbLinkMat = new THREE.MeshStandardMaterial({
      color: 0x24292f,
      roughness: 0.62,
      metalness: 0.05,
    });
    const powerCableMat = new THREE.MeshStandardMaterial({
      color: 0x0b0d10,
      roughness: 0.55,
      metalness: 0.05,
    });
    const makeRigTube = (mat: THREE.Material) => {
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(),
            new THREE.Vector3(0, 0.001, 0),
          ]),
          1,
          0.004,
          8,
          false,
        ),
        mat,
      );
      mesh.castShadow = false;
      stageOneRig.add(mesh);
      return mesh;
    };
    const rigArms: Array<"follower" | "leader"> = ["follower", "leader"];
    const usbLinkCables: Record<string, THREE.Mesh> = {
      follower: makeRigTube(usbLinkMat),
      leader: makeRigTube(usbLinkMat),
    };
    const powerLinkCables: Record<string, THREE.Mesh> = {
      follower: makeRigTube(powerCableMat),
      leader: makeRigTube(powerCableMat),
    };
    const powerPlugs: Record<string, THREE.Group> = {};
    const powerPlugProgress: Record<string, number> = { follower: 0, leader: 0 };
    rigArms.forEach((arm) => {
      // Plug oriented to insert horizontally (−x) into the board's left socket:
      // metal prong toward the socket, body + cable outboard (+x).
      const plug = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.0053, 0.005, 0.0073),
        powerCableMat,
      );
      body.position.x = 0.003;
      plug.add(body);
      const prong = new THREE.Mesh(
        new THREE.BoxGeometry(0.0033, 0.0033, 0.0043),
        new THREE.MeshStandardMaterial({
          color: 0xcfd4da,
          roughness: 0.4,
          metalness: 0.6,
        }),
      );
      prong.position.x = -0.0007;
      plug.add(prong);
      stageOneRig.add(plug);
      powerPlugs[arm] = plug;
    });
    // Rebuild a rig tube from world-space points (stageOneRig has identity xform).
    const rebuildRigTube = (mesh: THREE.Mesh, points: THREE.Vector3[]) => {
      const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
      const geo = new THREE.TubeGeometry(curve, 28, 0.0035, 8, false);
      mesh.geometry.dispose();
      mesh.geometry = geo;
    };
    // Points for a naturally-hanging cable between a and b: a parabolic sag
    // (deepest in the middle) scaled to the span, clamped just above the floor.
    const sagCablePoints = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      sagFrac: number,
    ) => {
      const sag = a.distanceTo(b) * sagFrac;
      const n = 8;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = a.clone().lerp(b, t);
        p.y -= sag * 4 * t * (1 - t); // 0 at both ends, max droop mid-span
        if (p.y < 0.012) {
          p.y = 0.012; // don't sink through the floor
        }
        pts.push(p);
      }
      return pts;
    };
    const rigV1 = new THREE.Vector3();
    const rigV2 = new THREE.Vector3();
    const rigSocket = new THREE.Vector3();
    const rigOut = new THREE.Vector3();
    const rigBase = new THREE.Vector3();
    const updateStageOneRig = () => {
      // Mirror the power strip to the FAR side of the axis through both arms
      // (line runs along X at z = followerHomePosition.z), reflecting the laptop's
      // position — so the power source sits behind the arms, not on the laptop's
      // side. Reflection across an X-parallel line flips only the z-offset.
      const armZ = followerHomePosition.z;
      powerStrip.position.set(
        laptopGroup.position.x,
        0,
        2 * armZ - laptopGroup.position.z,
      );
      powerStrip.rotation.y = -laptopGroup.rotation.y;

      usbPortEntries.forEach((entry) => {
        const arm = entry.arm;
        const visible = arm === "follower" || showLeaderArmRef.current;

        // USB: EXTEND from the existing plug's Type-C cable end to a laptop port
        // (both arms → the same laptop). Not a separate cable off the socket.
        const usbCable = usbLinkCables[arm];
        if (usbCable) {
          usbCable.visible = visible;
          if (visible) {
            entry.plugCableEnd.getWorldPosition(rigV1);
            const laptopAnchor =
              arm === "follower" ? laptopUsbAnchorA : laptopUsbAnchorB;
            laptopAnchor.getWorldPosition(rigV2);
            rebuildRigTube(usbCable, sagCablePoints(rigV1, rigV2, 0.45));
          }
        }

        // Power: a plug per arm slides into the strip socket (the "plug in" demo);
        // the cable STEMS from the board's power jack (grey box, left edge).
        const powerCable = powerLinkCables[arm];
        const plug = powerPlugs[arm];
        // Assign each arm to the strip socket on ITS OWN side so the two cords
        // don't cross/tangle (follower is on the +x world side → socket[1]).
        const socketIndex = arm === "follower" ? 1 : 0;
        if (powerCable && plug) {
          powerCable.visible = visible;
          plug.visible = visible;
          if (visible) {
            // The plug seats INTO the board's left power socket (the demo).
            entry.powerSource.getWorldPosition(rigSocket);
            rigOut.copy(rigSocket);
            rigOut.x += 0.022;
            rigOut.y += 0.022; // pulled out (up + away) before plugging in
            powerPlugProgress[arm] = Math.min(
              1,
              powerPlugProgress[arm] + 0.015,
            );
            plug.position.copy(rigOut).lerp(rigSocket, powerPlugProgress[arm]);
            // Cable runs from the plug out to the floor power strip (mains).
            powerSocketAnchors[socketIndex].getWorldPosition(rigBase);
            rebuildRigTube(
              powerCable,
              sagCablePoints(plug.position, rigBase, 0.42),
            );
          }
        }
      });
    };

    const calibrationMarkerGroup = new THREE.Group();
    calibrationMarkerGroup.name = "calibration_live_overlay";
    scene.add(calibrationMarkerGroup);

    const connectorPickMarkerGroup = new THREE.Group();
    connectorPickMarkerGroup.name = "connector_pick_markers";
    scene.add(connectorPickMarkerGroup);

    const markerMaterials = {
      midpoint: new THREE.MeshStandardMaterial({
        color: 0x5ce19d,
        emissive: 0x1c7c4e,
        emissiveIntensity: 0.85,
      }),
      limit: new THREE.MeshStandardMaterial({
        color: 0xff4242,
        emissive: 0x8b1111,
        emissiveIntensity: 0.75,
      }),
      current: new THREE.MeshStandardMaterial({
        color: 0xff9d2e,
        emissive: 0xff9d2e,
        emissiveIntensity: 0.9,
      }),
      focus: new THREE.MeshStandardMaterial({
        color: 0xffd166,
        emissive: 0xffd166,
        emissiveIntensity: 0.62,
        transparent: true,
        opacity: 0.7,
      }),
    };
    const markerSphereGeometry = new THREE.SphereGeometry(0.018, 16, 16);
    const connectorPickMarkerGeometry = new THREE.SphereGeometry(
      0.008,
      12,
      12,
    );
    const connectorPickMarkerMaterial = new THREE.MeshStandardMaterial({
      color: 0x5ce19d,
      emissive: 0x1c7c4e,
      emissiveIntensity: 0.9,
    });
    const focusRingGeometry = new THREE.TorusGeometry(0.105, 0.006, 12, 48);
    const markerLabelSprites: THREE.Sprite[] = [];

    const createMarkerLabel = (
      text: string,
      color: string,
      position: THREE.Vector3,
    ) => {
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = 64;
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(7, 16, 26, 0.82)";
      context.roundRect(4, 8, 184, 48, 16);
      context.fill();
      context.font = "800 22px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = color;
      context.fillText(text, canvas.width / 2, canvas.height / 2);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(position);
      sprite.scale.set(0.13, 0.044, 1);
      calibrationMarkerGroup.add(sprite);
      markerLabelSprites.push(sprite);
    };

    const clearCalibrationMarkers = () => {
      calibrationMarkerGroup.children.forEach((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
        }

        if (child instanceof THREE.Sprite) {
          child.material.map?.dispose();
          child.material.dispose();
        }
      });
      calibrationMarkerGroup.clear();
      markerLabelSprites.length = 0;
    };

    const tooltip = document.createElement("div");
    tooltip.className = "robot-tooltip";
    tooltip.hidden = true;
    container.appendChild(tooltip);

    const loadingGeometry = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    const loadingMaterial = new THREE.MeshStandardMaterial({
      color: 0xff9d2e,
      emissive: 0x5c2b00,
    });
    const loadingMarker = new THREE.Mesh(
      loadingGeometry,
      loadingMaterial,
    );
    loadingMarker.position.set(0, 0.08, 0);
    loadingMarker.castShadow = false;
    scene.add(loadingMarker);

    const failedMarkerMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b3030,
      emissive: 0x2d0505,
    });

    const loadingManager = new THREE.LoadingManager();
    let robotFramed = false;
    let robotHadMeshError = false;
    let leaderLoadStarted = false;
    let frameRetryCount = 0;

    loadingManager.onError = (url) => {
      robotHadMeshError = true;
      console.error("Every failed STL path", url);
    };

    const urdfLoader = new URDFLoader(loadingManager);
    urdfLoader.parseVisual = true;
    urdfLoader.parseCollision = false;

    const meshLoader = (
      path: string,
      manager: THREE.LoadingManager,
      materialOrDone: THREE.Material | MeshLoadDone,
      maybeDone?: MeshLoadDone,
    ) => {
      const done =
        typeof materialOrDone === "function" ? materialOrDone : maybeDone;
      const material =
        typeof materialOrDone === "function"
          ? new THREE.MeshPhongMaterial({ color: 0xd8dde4 })
          : materialOrDone;

      if (!done) {
        return;
      }

      if (!path.toLowerCase().endsWith(".stl")) {
        const error = new Error(`Unsupported mesh type: ${path}`);
        console.error("Every failed STL path", path, error);
        done(null, error);
        return;
      }

      const loader = new STLLoader(manager);

      loader.load(
        path,
        (geometry) => {
          geometry.computeVertexNormals();

          const mesh = new THREE.Mesh(geometry, material);
          mesh.userData.sourcePath = path;
          done(mesh);
        },
        undefined,
        (error) => {
          const meshError =
            error instanceof Error
              ? error
              : new Error(`Failed to load mesh ${path}`);

          console.error("Every failed STL path", path, meshError);
          done(null, meshError);
        },
      );
    };

    urdfLoader.loadMeshCb = meshLoader as unknown as URDFLoader["loadMeshCb"];

    const prepareRobotMeshes = (robot: URDFRobot) => {
      robot.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;

          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];

          materials.forEach((material) => {
            material.side = THREE.DoubleSide;
          });
        }
      });
    };

    const applyJointValues = (robot: URDFRobot, values: JointValues) => {
      Object.entries(values).forEach(([jointName, value]) => {
          const config = jointConfigs[jointName as JointName];
          const urdfJoint = robot.joints[config.urdfJointName];

          if (!urdfJoint) {
            return;
          }

          const nextValue =
            urdfJoint.jointType === "revolute" ||
            urdfJoint.jointType === "continuous"
              ? THREE.MathUtils.degToRad(value)
              : value;

          robot.setJointValue(config.urdfJointName, nextValue);
      });
    };

    const createWhiteMaterial = () =>
      new THREE.MeshStandardMaterial({
        color: 0xf4f4f4,
        roughness: 0.72,
        metalness: 0.05,
      });

    const createServoMaterial = () =>
      new THREE.MeshStandardMaterial({
        color: 0x171b22,
        roughness: 0.58,
        metalness: 0.18,
      });

    const isServoMotorMesh = (object: THREE.Mesh) => {
      const sourcePath = String(object.userData.sourcePath ?? "")
        .toLowerCase();
      const objectName = object.name.toLowerCase();

      return (
        sourcePath.includes("sts3215") ||
        objectName.includes("sts3215")
      );
    };

    const ensureRobotMaterials = (
      robot: URDFRobot,
      color: THREE.ColorRepresentation,
      emissiveIntensity = 0,
    ) => {
      robot.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || isRobotAccessory(object)) {
          return;
        }

        if (originalMaterialsRef.current.has(object)) {
          return;
        }

        const nextMaterial = isServoMotorMesh(object)
          ? createServoMaterial()
          : Array.isArray(object.material)
          ? object.material.map(() =>
              emissiveIntensity > 0
                ? new THREE.MeshStandardMaterial({
                    color,
                    emissive: color,
                    emissiveIntensity,
                    roughness: 0.68,
                    metalness: 0.08,
                  })
                : createWhiteMaterial(),
            )
          : emissiveIntensity > 0
            ? new THREE.MeshStandardMaterial({
                color,
                emissive: color,
                emissiveIntensity,
                roughness: 0.68,
                metalness: 0.08,
              })
            : createWhiteMaterial();

        object.material = nextMaterial;
        originalMaterialsRef.current.set(object, nextMaterial);
      });
    };

    const restoreHighlightedMaterials = () => {
      const robots = [robotRef.current, leaderRobotRef.current].filter(
        (entry): entry is URDFRobot => Boolean(entry),
      );

      if (robots.length === 0) {
        return;
      }

      robots.forEach((robot) => {
        robot.traverse((object) => {
          if (!(object instanceof THREE.Mesh) || isRobotAccessory(object)) {
            return;
          }

          const original = originalMaterialsRef.current.get(object);

          if (original) {
            object.material = original;
          }
        });
      });

      highlightedMaterialsRef.current.forEach((material) =>
        material.dispose(),
      );
      highlightedMaterialsRef.current = [];
    };

    const applyJointHighlight = (
      robot: URDFRobot,
      jointName: JointName | null,
      lastHighlighted: JointName | null | undefined,
      setLastHighlighted: (jointName: JointName | null) => void,
    ) => {

      if (lastHighlighted === jointName) {
        return;
      }

      restoreHighlightedMaterials();
      setLastHighlighted(jointName);

      if (!jointName) {
        return;
      }

      const urdfJointName = jointConfigs[jointName].urdfJointName;
      const joint = robot.joints[urdfJointName];

      if (!joint) {
        return;
      }

      joint.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || isRobotAccessory(object)) {
          return;
        }

        if (!originalMaterialsRef.current.has(object)) {
          originalMaterialsRef.current.set(object, object.material);
        }

        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        const highlightedMaterials = materials.map((material) => {
          const clone = material.clone();
          const standardMaterial = clone as THREE.MeshStandardMaterial;

          if ("emissive" in standardMaterial) {
            standardMaterial.color = new THREE.Color(0xff9d2e);
            standardMaterial.emissive = new THREE.Color(0xff9d2e);
            standardMaterial.emissiveIntensity = 0.55;
          }

          clone.transparent = true;
          clone.opacity = 0.95;
          highlightedMaterialsRef.current.push(clone);

          return clone;
        });

        object.material = Array.isArray(object.material)
          ? highlightedMaterials
          : highlightedMaterials[0];
      });
    };

    const getJointWorldAxis = (robot: URDFRobot, jointName: JointName) => {
      const joint = robot.joints[jointConfigs[jointName].urdfJointName];

      if (!joint) {
        return null;
      }

      const axis = joint.axis.clone().normalize();
      const quaternion = new THREE.Quaternion();
      joint.getWorldQuaternion(quaternion);
      axis.applyQuaternion(quaternion).normalize();

      return axis;
    };

    const getOverlayRobot = () => {
      const overlay = calibrationOverlayRef.current;

      if (!overlay) {
        return null;
      }

      if (overlay.target === "leader" && showLeaderArmRef.current) {
        return leaderRobotRef.current;
      }

      return robotRef.current;
    };

    const getOverlayJointValue = (
      target: "follower" | "leader",
      jointName: JointName,
    ) =>
      target === "leader"
        ? leaderJointValuesRef.current[jointName]
        : jointValuesRef.current[jointName];

    const addCalibrationMarker = (
      joint: THREE.Object3D,
      axis: THREE.Vector3,
      angle: number,
      radius: number,
      material: THREE.Material,
      label: string,
      labelColor: string,
      scale = 1,
    ) => {
      const basis = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        axis,
      );
      const localPosition = new THREE.Vector3(
        Math.cos(THREE.MathUtils.degToRad(angle)) * radius,
        Math.sin(THREE.MathUtils.degToRad(angle)) * radius,
        0,
      );
      const worldPosition = localPosition.applyQuaternion(basis);
      const jointPosition = new THREE.Vector3();
      joint.getWorldPosition(jointPosition);
      worldPosition.add(jointPosition);

      const marker = new THREE.Mesh(markerSphereGeometry.clone(), material);
      marker.position.copy(worldPosition);
      marker.scale.setScalar(scale);
      calibrationMarkerGroup.add(marker);

      createMarkerLabel(
        label,
        labelColor,
        worldPosition.clone().add(new THREE.Vector3(0, 0.045, 0)),
      );
    };

    const updateCalibrationMarkers = () => {
      const overlay = calibrationOverlayRef.current;
      clearCalibrationMarkers();

      if (!overlay) {
        return;
      }

      const overlayRobot = getOverlayRobot();

      if (!overlayRobot) {
        return;
      }

      const joints =
        overlay.showAllMidpoints || !overlay.jointName
          ? (Object.keys(jointConfigs) as JointName[])
          : [overlay.jointName];

      joints.forEach((jointName) => {
        const config = jointConfigs[jointName];
        const joint = overlayRobot.joints[config.urdfJointName];
        const axis = getJointWorldAxis(overlayRobot, jointName);

        if (!joint || !axis) {
          return;
        }

        const jointPosition = new THREE.Vector3();
        joint.getWorldPosition(jointPosition);
        const focusRing = new THREE.Mesh(
          focusRingGeometry.clone(),
          markerMaterials.focus,
        );
        focusRing.position.copy(jointPosition);
        focusRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
        calibrationMarkerGroup.add(focusRing);

        const current = getOverlayJointValue(overlay.target, jointName);
        const radius = embeddedRef.current ? 0.12 : 0.16;

        addCalibrationMarker(
          joint,
          axis,
          config.midpoint,
          radius,
          markerMaterials.midpoint,
          "MID",
          "#5ce19d",
          1.15,
        );

        if (overlay.showRangeMarkers && overlay.calibration?.[jointName]) {
          const observed = overlay.calibration[jointName];
          addCalibrationMarker(
            joint,
            axis,
            observed.observedMin,
            radius,
            markerMaterials.limit,
            `MIN ${Math.round(observed.observedMin)}`,
            "#ff6b6b",
          );
          addCalibrationMarker(
            joint,
            axis,
            observed.observedMax,
            radius,
            markerMaterials.limit,
            `MAX ${Math.round(observed.observedMax)}`,
            "#ff6b6b",
          );
        } else if (overlay.showRangeMarkers) {
          addCalibrationMarker(
            joint,
            axis,
            config.min,
            radius,
            markerMaterials.limit,
            "MIN",
            "#ff6b6b",
          );
          addCalibrationMarker(
            joint,
            axis,
            config.max,
            radius,
            markerMaterials.limit,
            "MAX",
            "#ff6b6b",
          );
        }

        addCalibrationMarker(
          joint,
          axis,
          current,
          radius * 1.16,
          markerMaterials.current,
          `POS ${Math.round(current)}`,
          "#ffcf92",
          1.25,
        );
      });
    };

    const updateGuidedCamera = () => {
      if (!embeddedRef.current) {
        return;
      }

      const focusJoint =
        guidedFocusJointRef.current ??
        calibrationOverlayRef.current?.jointName ??
        null;
      const focusRobot = getOverlayRobot() ?? getControlRobot() ?? robotRef.current;

      if (!focusRobot) {
        return;
      }

      let target = new THREE.Vector3();

      if (focusJoint) {
        const joint = focusRobot.joints[jointConfigs[focusJoint].urdfJointName];
        if (joint) {
          joint.getWorldPosition(target);
        }
      } else {
        const box = new THREE.Box3().setFromObject(focusRobot);
        target = box.getCenter(target);
      }

      const focusDistance = focusJoint ? 0.72 : 1.45;
      const desiredPosition = target
        .clone()
        .add(new THREE.Vector3(focusDistance, focusDistance * 0.55, focusDistance));

      controls.target.lerp(target, 0.12);
      camera.position.lerp(desiredPosition, 0.12);
      camera.near = 0.01;
      camera.far = 30;
      camera.lookAt(controls.target);
      camera.updateProjectionMatrix();
    };

    const updateJointGizmo = (robot: URDFRobot) => {
      // No joint-axis gizmo during motor setup — the highlighted motor is for
      // plugging in a connector, not rotating a joint.
      if (motorSetupActiveRef.current) {
        jointGizmo.visible = false;
        return;
      }
      const jointName =
        directControlTargetRef.current === "leader"
          ? highlightedLeaderJointRef.current
          : highlightedJointRef.current;

      if (!jointName) {
        jointGizmo.visible = false;
        return;
      }

      const urdfJoint = robot.joints[jointConfigs[jointName].urdfJointName];

      if (!urdfJoint) {
        jointGizmo.visible = false;
        return;
      }

      urdfJoint.getWorldPosition(jointGizmo.position);
      const axis = getJointWorldAxis(robot, jointName);

      if (axis) {
        jointGizmo.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          axis,
        );
      }

      jointGizmo.visible = true;
    };

    const updateHoverGizmo = (robot: URDFRobot) => {
      const jointName = lastHoveredJoint;

      if (
        !directControlEnabledRef.current ||
        dragState ||
        !jointName ||
        jointName === highlightedJointRef.current
      ) {
        hoverGizmo.visible = false;
        return;
      }

      const urdfJoint = robot.joints[jointConfigs[jointName].urdfJointName];
      const axis = getJointWorldAxis(robot, jointName);

      if (!urdfJoint || !axis) {
        hoverGizmo.visible = false;
        return;
      }

      urdfJoint.getWorldPosition(hoverGizmo.position);
      hoverGizmo.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        axis,
      );
      hoverGizmo.visible = true;
    };

    const disposeObject = (object: THREE.Object3D) => {
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
        }
      });
    };

    const clearRobotDetails = () => {
      robotDetails.children.forEach(disposeObject);
      robotDetails.clear();
      dynamicCables.forEach((cable) => {
        cable.mesh.geometry.dispose();
        scene.remove(cable.mesh);
      });
      dynamicCables = [];
      wirePinCaps.forEach((cap) => {
        disposeObject(cap);
        cap.removeFromParent();
      });
      wirePinCaps.length = 0;
      wireConnectorTips.forEach((tip) => {
        disposeObject(tip);
        tip.removeFromParent();
      });
      wireConnectorTips.length = 0;
      adjustableConnectors.length = 0;
      accessoryRoots.forEach((root) => {
        disposeObject(root);
        root.removeFromParent();
      });
      accessoryRoots.length = 0;
      motorSetupEntries.forEach((entry) => {
        entry.setupMaterials.forEach((material) => material.dispose());
      });
      motorSetupEntries.length = 0;
      usbPortEntries.length = 0;
      attachedBoards.length = 0;
    };

    const addBoxDetail = (
      parent: THREE.Object3D,
      position: THREE.Vector3,
      size: [number, number, number],
      material: THREE.Material,
      rotation?: THREE.Euler,
    ) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size[0], size[1], size[2]),
        material,
      );
      mesh.position.copy(position);

      if (rotation) {
        mesh.rotation.copy(rotation);
      }

      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.robotAccessory = true;
      parent.add(mesh);

      return mesh;
    };

    const addDynamicCable = (
      anchors: CableAnchor[],
      material: THREE.Material,
      owner: "follower" | "leader",
      radius = 0.006,
      segments = 28,
    ) => {
      const isArmVisible = (role: "follower" | "leader") =>
        role === "follower" || showLeaderArmRef.current;
      const points = anchors.map((anchor) =>
        anchor.resolveWorldPosition
          ? anchor.resolveWorldPosition()
          : anchor.object.localToWorld(anchor.localPosition.clone()),
      );
      const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
      const cable = new THREE.Mesh(
        new THREE.TubeGeometry(curve, segments, radius, 12, false),
        material,
      );
      cable.castShadow = false;
      cable.visible =
        !connectorPickModeRef.current &&
        isArmVisible(owner);
      cable.userData.robotAccessory = true;
      cable.userData.armRole = owner;
      scene.add(cable);
      dynamicCables.push({ anchors, mesh: cable, owner, radius, segments });
    };

    const isAccessoryArmVisible = (object: THREE.Object3D) => {
      const role = object.userData.armRole as "follower" | "leader" | undefined;
      return role !== "leader" || showLeaderArmRef.current;
    };

    const updateDynamicCables = () => {
      dynamicCables.forEach((cable) => {
        const visible =
          !connectorPickModeRef.current && isAccessoryArmVisible(cable.mesh);
        cable.mesh.visible = visible;
        // A hidden cable doesn't need its (expensive) tube rebuilt.
        if (!visible) {
          return;
        }

        const points = cable.anchors.map((anchor) =>
          anchor.resolveWorldPosition
            ? anchor.resolveWorldPosition()
            : anchor.object.localToWorld(anchor.localPosition.clone()),
        );

        // Skip the rebuild when no anchor moved since last time — the arm is
        // static most of the time, so this avoids rebuilding every tube every
        // frame (the dominant per-frame cost).
        const prev = cable.lastPoints;
        if (prev && prev.length === points.length) {
          let moved = false;
          for (let i = 0; i < points.length; i++) {
            if (prev[i].distanceToSquared(points[i]) > 1e-10) {
              moved = true;
              break;
            }
          }
          if (!moved) {
            return;
          }
        }
        cable.lastPoints = points;

        const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
        const nextGeometry = new THREE.TubeGeometry(
          curve,
          cable.segments,
          cable.radius,
          10,
          false,
        );

        cable.mesh.geometry.dispose();
        cable.mesh.geometry = nextGeometry;
      });
    };

    const createAnchorObject = (
      parent: THREE.Object3D,
      localPosition: THREE.Vector3,
      name: string,
    ) => {
      const anchor = new THREE.Object3D();
      anchor.name = name;
      anchor.position.copy(localPosition);
      anchor.userData.robotAccessory = true;
      parent.add(anchor);

      return anchor;
    };

    const buildRobotDetails = (
      robot: URDFRobot,
      options: { includeBoard: boolean; owner: "follower" | "leader" },
    ) => {
      const linkForMotor: Record<JointName, string> = {
        shoulder_pan: "base_link",
        shoulder_lift: "shoulder_link",
        elbow_flex: "upper_arm_link",
        wrist_flex: "lower_arm_link",
        wrist_roll: "wrist_link",
        gripper: "gripper_link",
      };
      const motorLocalPose: Record<
        JointName,
        { position: THREE.Vector3; rotation: THREE.Euler }
      > = {
        shoulder_pan: {
          position: new THREE.Vector3(0.0263353, 0, 0.0437),
          rotation: new THREE.Euler(0, 0, 0),
        },
        shoulder_lift: {
          position: new THREE.Vector3(-0.0303992, 0.000422241, -0.0417),
          rotation: new THREE.Euler(Math.PI / 2, Math.PI / 2, 0),
        },
        elbow_flex: {
          position: new THREE.Vector3(-0.11257, -0.0155, 0.0187),
          rotation: new THREE.Euler(Math.PI, 0, -Math.PI / 2),
        },
        wrist_flex: {
          position: new THREE.Vector3(-0.1224, 0.0052, 0.0187),
          rotation: new THREE.Euler(Math.PI, 0, Math.PI),
        },
        wrist_roll: {
          position: new THREE.Vector3(0, -0.0424, 0.0306),
          rotation: new THREE.Euler(Math.PI / 2, Math.PI / 2, 0),
        },
        gripper: {
          position: new THREE.Vector3(0.0077, 0.0001, -0.0234),
          rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
        },
      };
      const accessoryMotorScale = 0.648;
      type WireColor = "red" | "black" | "white";
      type PickedConnectorPoint = {
        local?: [number, number, number];
        world?: [number, number, number];
      };
      type PickedConnector = {
        linkName: string;
        previousExitNormal: [number, number, number];
        nextExitNormal: [number, number, number];
        previousExitOffset: [number, number, number];
        nextExitOffset: [number, number, number];
        previous: Record<WireColor, PickedConnectorPoint>;
        next: Record<WireColor, PickedConnectorPoint>;
      };
      type WireConnector = Record<WireColor, CableAnchor>;
      type MotorWireAnchors = {
        previous: WireConnector;
        next: WireConnector;
      };
      type WireGuidePoint = {
        linkName: string;
        local: [number, number, number];
        laneAxis?: "x" | "y" | "z";
        // Arbitrary lane-spread direction in link-local (overrides laneAxis).
        // Used to spread the 3 wires tangent to the surface so they lie parallel
        // to it instead of stacking along the surface normal.
        laneVec?: [number, number, number];
        laneSpacing?: number;
      };
      const wireColors: WireColor[] = ["red", "black", "white"];
      const showArmWiring = false;
      const showFirstWireBundle = true;
      const wireMaterials: Record<WireColor, THREE.Material> = {
        red: detailMaterials.redWire,
        black: detailMaterials.blackWire,
        white: detailMaterials.whiteWire,
      };
      const wireRadius: Record<WireColor, number> = {
        red: 0.0029,
        black: 0.0029,
        white: 0.0027,
      };
      const wirePinOffsets: Record<WireColor, number> = {
        red: 0.007,
        black: 0,
        white: -0.007,
      };
      const wireLaneOffsets: Record<WireColor, number> = {
        red: 1,
        black: 0,
        white: -1,
      };
      const pickedConnectorAnchors: Record<JointName, PickedConnector> = {
        shoulder_pan: {
          linkName: "base_link",
          previousExitNormal: [0, 1, 0],
          nextExitNormal: [0, 1, 0],
          previousExitOffset: [0, 0.008, 0],
          nextExitOffset: [0, 0.008, 0],
          previous: {
            red: { local: [0.02421, 0.008409, 0.0243] },
            black: { local: [0.024366, 0.005736, 0.0243] },
            white: { local: [0.024506, 0.00333, 0.0243] },
          },
          next: {
            red: { local: [0.024778, 0.002793, 0.0243] },
            black: { local: [0.024664, 0.005157, 0.0243] },
            white: { local: [0.024834, 0.007271, 0.0243] },
          },
        },
        shoulder_lift: {
          linkName: "shoulder_link",
          previousExitNormal: [0, 1, 0],
          nextExitNormal: [0, 1, 0],
          previousExitOffset: [0, 0.008, 0],
          nextExitOffset: [0, 0.008, 0],
          previous: {
            red: { local: [-0.027763, 0.019822, -0.03985] },
            black: { local: [-0.025069, 0.019822, -0.040047] },
            white: { local: [-0.023178, 0.019822, -0.039947] },
          },
          next: {
            red: { local: [-0.037961, 0.019822, -0.040167] },
            black: { local: [-0.03569, 0.019822, -0.040391] },
            white: { local: [-0.032963, 0.019822, -0.04039] },
          },
        },
        elbow_flex: {
          linkName: "upper_arm_link",
          previousExitNormal: [0, 0, 1],
          nextExitNormal: [0, 0, 1],
          previousExitOffset: [0, 0, 0.008],
          nextExitOffset: [0, 0, 0.008],
          previous: {
            red: { local: [-0.105333, -0.014858, 0.0381] },
            black: { local: [-0.107478, -0.014743, 0.0381] },
            white: { local: [-0.109635, -0.014893, 0.0381] },
          },
          next: {
            red: { local: [-0.115447, -0.014316, 0.0381] },
            black: { local: [-0.117834, -0.014452, 0.0381] },
            white: { local: [-0.120493, -0.014836, 0.0381] },
          },
        },
        wrist_flex: {
          linkName: "lower_arm_link",
          previousExitNormal: [-1, 0, 0],
          nextExitNormal: [-1, 0, 0],
          previousExitOffset: [-0.008, 0, 0],
          nextExitOffset: [-0.008, 0, 0],
          previous: {
            red: { local: [-0.121316, 0.003085, 0.0381] },
            black: { local: [-0.121136, 0.000317, 0.0381] },
            white: { local: [-0.120958, -0.002102, 0.0381] },
          },
          next: {
            red: { local: [-0.121357, 0.013305, 0.0381] },
            black: { local: [-0.121178, 0.010534, 0.0381] },
            white: { local: [-0.120999, 0.007938, 0.0381] },
          },
        },
        wrist_roll: {
          linkName: "wrist_link",
          previousExitNormal: [0, -1, 0],
          nextExitNormal: [0, 1, 0],
          previousExitOffset: [0, -0.008, 0],
          nextExitOffset: [0, 0.008, 0],
          previous: {
            red: { local: [0.002735, -0.023, 0.031989] },
            black: { local: [0.005217, -0.023, 0.0319] },
            white: { local: [0.007833, -0.023, 0.031903] },
          },
          next: {
            red: { local: [-0.002474, -0.023, 0.032155] },
            black: { local: [-0.005467, -0.023, 0.03221] },
            white: { local: [-0.008394, -0.023, 0.032085] },
          },
        },
        gripper: {
          linkName: "gripper_link",
          previousExitNormal: [0, 1, 0],
          nextExitNormal: [0, 1, 0],
          previousExitOffset: [0, 0.008, 0],
          nextExitOffset: [0, 0.008, 0],
          previous: {
            red: { local: [0.006365, -0.0193, -0.020559] },
            black: { local: [0.006233, -0.0193, -0.018297] },
            white: { local: [0.006168, -0.0193, -0.015496] },
          },
          next: {
            red: { local: [0.006034, -0.0193, -0.020459] },
            black: { local: [0.005868, -0.0193, -0.018134] },
            white: { local: [0.00613, -0.0193, -0.015484] },
          },
        },
      };
      const addWirePinCap = (
        parent: THREE.Object3D,
        position: THREE.Vector3,
        material: THREE.Material,
      ) => {
        const stub = new THREE.Mesh(
          new THREE.SphereGeometry(0.0022, 8, 8),
          material,
        );
        stub.position.copy(position);
        stub.castShadow = false;
        stub.userData.robotAccessory = true;
        stub.userData.armRole = options.owner;
        stub.userData.connectorWireAccessory = true;
        stub.visible = !connectorPickModeRef.current;
        parent.add(stub);
        wirePinCaps.push(stub);

        return stub;
      };
      const resolvePickedPoint = (
        link: THREE.Object3D,
        point: PickedConnectorPoint,
      ) => {
        if (point.local) {
          return new THREE.Vector3(...point.local);
        }

        if (point.world) {
          robot.updateMatrixWorld(true);
          return link.worldToLocal(new THREE.Vector3(...point.world));
        }

        return new THREE.Vector3();
      };
      const createPickedWireConnector = (
        link: THREE.Object3D,
        points: Record<WireColor, PickedConnectorPoint>,
        exitNormal: [number, number, number],
        exitOffset: [number, number, number],
      ) =>
        wireColors.reduce((connector, color) => {
          const position = resolvePickedPoint(link, points[color]);
          const exitLocalPosition = position
            .clone()
            .add(new THREE.Vector3(...exitOffset));

          if (showArmWiring) {
            addWirePinCap(link, position, wireMaterials[color]);
          }

          connector[color] = {
            object: link,
            localPosition: position,
            exitLocalPosition,
            exitNormal: new THREE.Vector3(...exitNormal).normalize(),
          };

          return connector;
        }, {} as WireConnector);
      const motorAnchors = {} as Record<
        JointName,
        MotorWireAnchors
      >;

      const baseLink = robot.links.base_link;

      if (!baseLink) {
        return;
      }

      let boardWireAnchors: WireConnector | null = null;

      if (options.includeBoard) {
        const boardScale = 0.5;
        const boardTopLeftBoxPosition = new THREE.Vector3(
          0.03 * boardScale,
          0.03*boardScale,
          -0.009 * boardScale,
        );
        const boardTopLeftBoxSize: [number, number, number] = [
          0.026 * boardScale,
          0.012 * boardScale,
          0.012 * boardScale,
        ];
        const boardGroup = new THREE.Group();
        boardGroup.name = "so101_controller_board";
        boardGroup.userData.robotAccessory = true;
        boardGroup.userData.armRole = options.owner;
        boardGroup.position.set(-0.032, 0, 0.05);
        boardGroup.rotation.set(0, Math.PI/2, Math.PI/2);
        baseLink.add(boardGroup);
        accessoryRoots.push(boardGroup);
        attachedBoards.push(boardGroup);

        addBoxDetail(
          boardGroup,
          new THREE.Vector3(),
          [0.105 * boardScale, 0.07 * boardScale, 0.006 * boardScale],
          detailMaterials.board,
        );
        const boardTopLeftBox = addBoxDetail(
          boardGroup,
          boardTopLeftBoxPosition,
          boardTopLeftBoxSize,
          detailMaterials.boardComponent,
        );
        boardTopLeftBox.name = "board_top_left_component";
        boardTopLeftBox.userData.connectorPickSurface = true;
        addBoxDetail(
          boardGroup,
          new THREE.Vector3(-0.052 * boardScale, 0.025 * boardScale, 0.007 * boardScale),
          [0.016 * boardScale, 0.02 * boardScale, 0.009 * boardScale],
          detailMaterials.metal,
        );
        addBoxDetail(
          boardGroup,
          new THREE.Vector3(0.052 * boardScale, 0.024 * boardScale, 0.007 * boardScale),
          [0.018 * boardScale, 0.024 * boardScale, 0.009 * boardScale],
          detailMaterials.metal,
        );

        boardWireAnchors = wireColors.reduce((anchors, color) => {
          anchors[color] = {
            object: createAnchorObject(
              boardGroup,
              new THREE.Vector3(
                (0.038 + wirePinOffsets[color]) * boardScale,
                0.034 * boardScale,
                0.011 * boardScale,
              ),
              `controller_${color}_pin`,
            ),
            localPosition: new THREE.Vector3(),
            exitLocalPosition: new THREE.Vector3(0, 0.018, 0),
            exitNormal: new THREE.Vector3(0, 1, 0),
          };

          return anchors;
        }, {} as WireConnector);

        // ---- Stage 1: clickable USB port + plug on the controller board ----
        // A silver USB socket on the board edge, plus a black USB plug that
        // slides into it. Students click to plug/unplug in the 3D scene.
        const usbPortMaterial = new THREE.MeshStandardMaterial({
          color: 0xc9d2dd,
          roughness: 0.35,
          metalness: 0.7,
          emissive: 0x000000,
          emissiveIntensity: 0,
        });
        const usbPort = new THREE.Mesh(
          new THREE.BoxGeometry(0.009, 0.011, 0.007),
          usbPortMaterial,
        );
        usbPort.position.set(
          -0.052 * boardScale,
          -0.026 * boardScale,
          0.011 * boardScale,
        );
        usbPort.userData.robotAccessory = true;
        usbPort.userData.usbPortArm = options.owner;
        usbPort.castShadow = false;
        boardGroup.add(usbPort);

        const plugGroup = new THREE.Group();
        plugGroup.userData.robotAccessory = true;
        plugGroup.visible = false;
        const plugBody = new THREE.Mesh(
          new THREE.BoxGeometry(0.013, 0.009, 0.006),
          detailMaterials.usbCable,
        );
        plugBody.castShadow = false;
        plugGroup.add(plugBody);
        // Metal connector shell (soft gray, not blown-out white).
        const plugTip = new THREE.Mesh(
          new THREE.BoxGeometry(0.006, 0.007, 0.004),
          new THREE.MeshStandardMaterial({
            color: 0x6a717a,
            roughness: 0.5,
            metalness: 0.35,
          }),
        );
        plugTip.position.set(0.0095, 0, 0);
        plugGroup.add(plugTip);
        // No rigid stub cylinder — the smooth laptop cable flows straight out of
        // the back of the plug body (anchor just behind it) so it reads as one
        // continuous, naturally-curving Type-C cable in the same colour.
        const plugCableEnd = new THREE.Object3D();
        plugCableEnd.position.set(-0.008, 0, 0);
        plugGroup.add(plugCableEnd);
        boardGroup.add(plugGroup);

        // Power input SOCKET on the board's LEFT edge (+x = viewer's left) — the
        // external power plug plugs in here (the "plug in the power" demo). Small
        // connector (~⅓ of the earlier chunky box) sitting on the board edge.
        const powerSocketBody = new THREE.Mesh(
          new THREE.BoxGeometry(0.004, 0.005, 0.0075),
          new THREE.MeshStandardMaterial({
            color: 0x14181e,
            roughness: 0.6,
            metalness: 0.1,
          }),
        );
        powerSocketBody.position.set(
          0.056 * boardScale,
          0.006 * boardScale,
          0.012 * boardScale,
        );
        powerSocketBody.userData.robotAccessory = true;
        powerSocketBody.castShadow = false;
        boardGroup.add(powerSocketBody);
        const powerSocketHole = new THREE.Mesh(
          new THREE.BoxGeometry(0.0014, 0.003, 0.0045),
          new THREE.MeshStandardMaterial({ color: 0x04060a, roughness: 0.85 }),
        );
        powerSocketHole.position.set(
          0.06 * boardScale,
          0.006 * boardScale,
          0.012 * boardScale,
        );
        powerSocketHole.userData.robotAccessory = true;
        boardGroup.add(powerSocketHole);
        // Anchor just outside the socket's +x face where the plug seats.
        const powerSource = new THREE.Object3D();
        powerSource.position.set(
          0.064 * boardScale,
          0.006 * boardScale,
          0.012 * boardScale,
        );
        boardGroup.add(powerSource);

        const plugInPosition = usbPort.position
          .clone()
          .add(new THREE.Vector3(-0.0115, 0, 0));
        const plugOutPosition = plugInPosition
          .clone()
          .add(new THREE.Vector3(-0.03, 0.006, 0));
        plugGroup.position.copy(plugOutPosition);

        usbPortEntries.push({
          arm: options.owner,
          portMesh: usbPort,
          portMaterial: usbPortMaterial,
          plug: plugGroup,
          plugInPosition,
          plugOutPosition,
          plugCableEnd,
          powerSource,
        });
      }

      Object.entries(linkForMotor).forEach(([jointName, linkName], index) => {
        const key = jointName as JointName;
        const link = robot.links[linkName];
        const pose = motorLocalPose[key];

        if (!link) {
          return;
        }

        const motorGroup = new THREE.Group();
        motorGroup.name = `${key}_mounted_motor_accessory`;
        motorGroup.userData.robotAccessory = true;
        motorGroup.userData.armRole = options.owner;
        motorGroup.userData.motorSetupJoint = key;
        motorGroup.userData.motorSetupTarget = options.owner;
        motorGroup.position.copy(pose.position);
        motorGroup.rotation.copy(pose.rotation);
        motorGroup.scale.setScalar(accessoryMotorScale);
        link.add(motorGroup);
        accessoryRoots.push(motorGroup);

        const lateralOffset = index % 2 === 0 ? 0.006 : -0.006;

        // Invisible, generous click target so beginners can easily select the
        // small motor in the 3D scene. It still resolves to this motor's joint.
        const clickProxy = new THREE.Mesh(
          new THREE.BoxGeometry(0.062, 0.05, 0.056),
          new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        clickProxy.position.set(lateralOffset, 0.008, 0);
        clickProxy.userData.robotAccessory = true;
        clickProxy.renderOrder = -1;
        motorGroup.add(clickProxy);

        // Register this motor so the Stage-2 setup visuals can recolour it.
        const setupMeshes: THREE.Mesh[] = [];
        motorSetupEntries.push({
          group: motorGroup,
          jointName: key,
          target: options.owner,
          meshes: setupMeshes,
          baseMaterials: setupMeshes.map((mesh) => mesh.material as THREE.Material),
          setupMaterials: setupMeshes.map(
            () =>
              new THREE.MeshStandardMaterial({
                color: 0xf4f4f4,
                roughness: 0.5,
                metalness: 0.1,
                transparent: true,
                opacity: 1,
              }),
          ),
          baseScale: accessoryMotorScale,
        });

        const pickedConnector = pickedConnectorAnchors[key];
        const connectorLink =
          robot.links[pickedConnector.linkName] ?? link;

        motorAnchors[key] = {
          previous: createPickedWireConnector(
            connectorLink,
            pickedConnector.previous,
            pickedConnector.previousExitNormal,
            pickedConnector.previousExitOffset,
          ),
          next: createPickedWireConnector(
            connectorLink,
            pickedConnector.next,
            pickedConnector.nextExitNormal,
            pickedConnector.nextExitOffset,
          ),
        };
      });

      const cablePath: JointName[] = [
        "shoulder_pan",
        "shoulder_lift",
        "elbow_flex",
        "wrist_flex",
        "wrist_roll",
        "gripper",
      ];
      const wireGuideRoutes: Record<string, WireGuidePoint[]> = {
        "shoulder_pan->shoulder_lift": [
          { linkName: "base_link", local: [0.012375, 0.020721, 0.047755] },
          { linkName: "base_link", local: [0.012939, 0.020647, 0.042403] },
          { linkName: "base_link", local: [0.012744, 0.020673, 0.045719] },
          { linkName: "base_link", local: [0.012727, 0.020675, 0.049399] },
          {
            linkName: "shoulder_link",
            local: [-0.016057, 0.019102, -0.027608],
          },
          {
            linkName: "shoulder_link",
            local: [-0.01785, 0.020895, -0.029291],
          },
          {
            linkName: "shoulder_link",
            local: [-0.019402, 0.022447, -0.0304],
          },
        ],
        "shoulder_lift->elbow_flex": [
          {
            linkName: "shoulder_link",
            local: [-0.016057, 0.019102, -0.027608],
          },
          {
            linkName: "shoulder_link",
            local: [-0.01785, 0.020895, -0.029291],
          },
          {
            linkName: "shoulder_link",
            local: [-0.019402, 0.022447, -0.0304],
          },
          { linkName: "upper_arm_link", local: [-0.024806, 0.000543, 0.0499] },
          { linkName: "upper_arm_link", local: [-0.022244, 0.000225, 0.0499] },
          { linkName: "upper_arm_link", local: [-0.019415, -0.000123, 0.0499] },
          { linkName: "upper_arm_link", local: [-0.017156, 0.000004, 0.0499] },
        ],
        "elbow_flex->wrist_flex": [
          { linkName: "upper_arm_link", local: [-0.024806, 0.000543, 0.0499] },
          { linkName: "upper_arm_link", local: [-0.022244, 0.000225, 0.0499] },
          { linkName: "upper_arm_link", local: [-0.019415, -0.000123, 0.0499] },
          { linkName: "upper_arm_link", local: [-0.017156, 0.000004, 0.0499] },
          { linkName: "lower_arm_link", local: [-0.01263, -0.000038, 0.0484] },
          { linkName: "lower_arm_link", local: [-0.015239, 0.000047, 0.0484] },
          { linkName: "lower_arm_link", local: [-0.018169, -0.000081, 0.0484] },
          { linkName: "lower_arm_link", local: [-0.020639, 0.000291, 0.0484] },
          { linkName: "lower_arm_link", local: [-0.109257, -0.002441, 0.0442] },
          { linkName: "lower_arm_link", local: [-0.110886, -0.00271, 0.0442] },
          { linkName: "lower_arm_link", local: [-0.113083, -0.002262, 0.0442] },
        ],
        "wrist_flex->wrist_roll": [
          { linkName: "lower_arm_link", local: [-0.109257, -0.002441, 0.0442] },
          { linkName: "lower_arm_link", local: [-0.110886, -0.00271, 0.0442] },
          { linkName: "lower_arm_link", local: [-0.113083, -0.002262, 0.0442] },
          { linkName: "wrist_link", local: [-0.015476, -0.046969, 0.014919] },
          { linkName: "wrist_link", local: [-0.01543, -0.044538, 0.015372] },
          { linkName: "wrist_link", local: [-0.015365, -0.04256, 0.014981] },
          { linkName: "wrist_link", local: [-0.0153, -0.03965, 0.015016] },
        ],
        "wrist_roll->gripper": [
          { linkName: "wrist_link", local: [-0.015476, -0.046969, 0.014919] },
          { linkName: "wrist_link", local: [-0.01543, -0.044538, 0.015372] },
          { linkName: "wrist_link", local: [-0.015365, -0.04256, 0.014981] },
          { linkName: "wrist_link", local: [-0.0153, -0.03965, 0.015016] },
        ],
      };
      const boardGuideRoute: WireGuidePoint[] = [
        { linkName: "base_link", local: [0.012939, 0.020647, 0.042403] },
        { linkName: "base_link", local: [0.012744, 0.020673, 0.045719] },
        { linkName: "base_link", local: [0.012727, 0.020675, 0.049399] },
      ];

      const addWireBundle = (
        from: WireConnector,
        to: WireConnector,
        routeOptions: {
          sourceExitDistance?: number;
          targetExitDistance?: number;
          outsideLift?: number;
          sideLiftMultiplier?: number;
          maxSideLift?: number;
          minSideLift?: number;
          hugSurface?: boolean;
          surfaceGuide?: boolean;
          externalRoute?: boolean;
          externalClearance?: number;
          externalLift?: number;
          usePinEndpoints?: boolean;
          guidePoints?: WireGuidePoint[];
          sourceGuideDistance?: number;
          targetGuideDistance?: number;
          sourceExitNormalOverride?: THREE.Vector3;
          targetExitNormalOverride?: THREE.Vector3;
          guideNormalOverride?: THREE.Vector3;
        } = {},
      ) => {
        wireColors.forEach((color) => {
          const source = from[color];
          const target = to[color];
          const sourceWorld = source.object.localToWorld(
            source.localPosition.clone(),
          );
          const targetWorld = target.object.localToWorld(
            target.localPosition.clone(),
          );
          const direction = targetWorld.clone().sub(sourceWorld).normalize();
          const sourceExitDistance = routeOptions.sourceExitDistance ?? 0.015;
          const targetExitDistance = routeOptions.targetExitDistance ?? 0.015;
          const sourceExitLocal =
            routeOptions.usePinEndpoints
              ? source.localPosition.clone()
              : source.exitLocalPosition ??
            source.localPosition
              .clone()
              .add(
                (routeOptions.sourceExitNormalOverride ??
                  source.exitNormal ??
                  direction)
                  .clone()
                  .normalize()
                  .multiplyScalar(sourceExitDistance),
              );
          const targetExitLocal =
            routeOptions.usePinEndpoints
              ? target.localPosition.clone()
              : target.exitLocalPosition ??
            target.localPosition
              .clone()
              .add(
                (routeOptions.targetExitNormalOverride ??
                  target.exitNormal ??
                  direction.clone().multiplyScalar(-1))
                  .clone()
                  .normalize()
                  .multiplyScalar(targetExitDistance),
              );
          const sourceExitAnchor = {
            object: source.object,
            localPosition: sourceExitLocal,
          };
          const targetExitAnchor = {
            object: target.object,
            localPosition: targetExitLocal,
          };
          const sourceGuideNormal = (
            routeOptions.sourceExitNormalOverride ??
            source.exitNormal ??
            direction
          )
            .clone()
            .normalize();
          const targetGuideNormal = (
            routeOptions.targetExitNormalOverride ??
            target.exitNormal ??
            direction.clone().multiplyScalar(-1)
          )
            .clone()
            .normalize();
          const sourceGuideAnchor = {
            object: source.object,
            localPosition: sourceExitLocal
              .clone()
              .add(
                sourceGuideNormal.multiplyScalar(
                  routeOptions.sourceGuideDistance ?? 0.022,
                ),
              ),
          };
          const targetGuideAnchor = {
            object: target.object,
            localPosition: targetExitLocal
              .clone()
              .add(
                targetGuideNormal.multiplyScalar(
                  routeOptions.targetGuideDistance ?? 0.022,
                ),
              ),
          };
          const guideAnchors = routeOptions.guidePoints?.reduce(
            (anchors, guidePoint) => {
              const link = robot.links[guidePoint.linkName];

              if (!link) {
                return anchors;
              }

              const localPosition = new THREE.Vector3(...guidePoint.local);
              const laneOffset =
                wireLaneOffsets[color] * (guidePoint.laneSpacing ?? 0.0014);

              if (guidePoint.laneAxis === "x") {
                localPosition.x += laneOffset;
              } else if (guidePoint.laneAxis === "z") {
                localPosition.z += laneOffset;
              } else {
                localPosition.y += laneOffset;
              }

              anchors.push({
                object: link,
                localPosition,
              });

              return anchors;
            },
            [] as CableAnchor[],
          );
          const resolveEndpoint = (anchor: CableAnchor) =>
            anchor.object.localToWorld(anchor.localPosition.clone());
          const resolveSourceExit = () => resolveEndpoint(sourceExitAnchor);
          const resolveTargetExit = () => resolveEndpoint(targetExitAnchor);
          const createExternalRouteAnchor = (amount: number): CableAnchor => ({
            object: scene,
            localPosition: new THREE.Vector3(),
            resolveWorldPosition: () => {
              const sourceExitWorld = resolveSourceExit();
              const targetExitWorld = resolveTargetExit();
              const point = sourceExitWorld.clone().lerp(targetExitWorld, amount);
              const baseWorld = baseLink.localToWorld(new THREE.Vector3());
              const up = new THREE.Vector3(0, 1, 0);
              const segment = targetExitWorld.clone().sub(sourceExitWorld);
              let radial = point.clone().sub(baseWorld);
              radial.y = 0;

              if (radial.lengthSq() < 0.0001) {
                radial = new THREE.Vector3(0, 0, 1);
              }

              radial.normalize();

              let side = new THREE.Vector3().crossVectors(
                segment.clone().normalize(),
                up,
              );

              if (side.lengthSq() < 0.0001) {
                side = radial.clone();
              } else {
                side.normalize();
              }

              if (side.dot(radial) < 0) {
                side.multiplyScalar(-1);
              }

              const outward = side
                .multiplyScalar(0.65)
                .add(radial.clone().multiplyScalar(0.35))
                .normalize();

              return point
                .add(
                  outward.multiplyScalar(routeOptions.externalClearance ?? 0.04),
                )
                .add(up.multiplyScalar(routeOptions.externalLift ?? 0.001));
            },
          });
          const createOuterRouteAnchor = (amount: number): CableAnchor => ({
            object: scene,
            localPosition: new THREE.Vector3(),
            resolveWorldPosition: () => {
              const sourceExitWorld = resolveSourceExit();
              const targetExitWorld = resolveTargetExit();
              const currentSourceWorld = source.object.localToWorld(
                source.localPosition.clone(),
              );
              const currentTargetWorld = target.object.localToWorld(
                target.localPosition.clone(),
              );
              const currentDirection = currentTargetWorld
                .clone()
                .sub(currentSourceWorld)
                .normalize();
              const midpoint = sourceExitWorld
                .clone()
                .lerp(targetExitWorld, amount);
              const segment = targetExitWorld.clone().sub(sourceExitWorld);
              const sourceNormalWorld = source.object.localToWorld(
                source.localPosition
                  .clone()
                  .add(
                    (routeOptions.sourceExitNormalOverride ??
                      source.exitNormal ??
                      currentDirection)
                      .clone()
                      .normalize(),
                  ),
              ).sub(currentSourceWorld).normalize();
              const targetNormalWorld = target.object.localToWorld(
                target.localPosition
                  .clone()
                  .add(
                    (routeOptions.targetExitNormalOverride ??
                      target.exitNormal ??
                      currentDirection.clone().multiplyScalar(-1))
                      .clone()
                      .normalize(),
                  ),
              ).sub(currentTargetWorld).normalize();
              const outward = routeOptions.guideNormalOverride
                ? routeOptions.guideNormalOverride.clone().normalize()
                : sourceNormalWorld
                .clone()
                .add(targetNormalWorld)
                .normalize();

              if (outward.lengthSq() < 0.001) {
                outward.copy(new THREE.Vector3(0, 1, 0));
              }

              const verticalLift = new THREE.Vector3(
                0,
                routeOptions.outsideLift ?? 0.003,
                0,
              );
              const sideLiftAmount = Math.min(
                routeOptions.maxSideLift ?? 0.014,
                Math.max(
                  routeOptions.minSideLift ?? 0.003,
                  segment.length() * (routeOptions.sideLiftMultiplier ?? 0.035),
                ),
              );
              const sideLift = outward.multiplyScalar(
                sideLiftAmount,
              );

              return midpoint.add(sideLift).add(verticalLift);
            },
          });

          const cableAnchors = routeOptions.hugSurface
            ? [sourceExitAnchor, targetExitAnchor]
            : guideAnchors && guideAnchors.length > 0
            ? [sourceExitAnchor, ...guideAnchors, targetExitAnchor]
            : routeOptions.surfaceGuide
            ? [
                sourceExitAnchor,
                sourceGuideAnchor,
                targetGuideAnchor,
                targetExitAnchor,
              ]
            : routeOptions.externalRoute
            ? [
                sourceExitAnchor,
                createExternalRouteAnchor(0.25),
                createExternalRouteAnchor(0.75),
                targetExitAnchor,
              ]
            : [
                sourceExitAnchor,
                createOuterRouteAnchor(0.35),
                createOuterRouteAnchor(0.65),
                targetExitAnchor,
              ];

          addDynamicCable(
            cableAnchors,
            wireMaterials[color],
            options.owner,
            wireRadius[color],
          );
        });
      };

      if (showArmWiring && boardWireAnchors) {
        addWireBundle(
          boardWireAnchors,
          motorAnchors.shoulder_pan.previous,
          {
            usePinEndpoints: true,
            guidePoints: boardGuideRoute,
          },
        );
      }

      if (showArmWiring) {
        cablePath.slice(0, -1).forEach((jointName, index) => {
          const nextJointName = cablePath[index + 1];
          const routeKey = `${jointName}->${nextJointName}`;
          const guidePoints = wireGuideRoutes[routeKey];

          addWireBundle(
            motorAnchors[jointName].next,
            motorAnchors[nextJointName].previous,
            guidePoints
              ? {
                  usePinEndpoints: true,
                  guidePoints,
                }
              : jointName === "shoulder_pan" && nextJointName === "shoulder_lift"
              ? {
                  externalRoute: true,
                  usePinEndpoints: true,
                  externalClearance: 0.055,
                  externalLift: 0.002,
                }
              : jointName === "shoulder_lift" && nextJointName === "elbow_flex"
              ? {
                  externalRoute: true,
                  usePinEndpoints: true,
                  externalClearance: 0.045,
                  externalLift: 0.0015,
                }
              : jointName === "elbow_flex" && nextJointName === "wrist_flex"
              ? {
                  externalRoute: true,
                  usePinEndpoints: true,
                  externalClearance: 0.04,
                  externalLift: 0.001,
                }
              : jointName === "wrist_flex" && nextJointName === "wrist_roll"
              ? {
                  externalRoute: true,
                  usePinEndpoints: true,
                  externalClearance: 0.035,
                  externalLift: 0.001,
                }
              : jointName === "wrist_roll" && nextJointName === "gripper"
              ? {
                  externalRoute: true,
                  usePinEndpoints: true,
                  externalClearance: 0.03,
                  externalLift: 0.001,
                }
              : {
                  externalRoute: true,
                  usePinEndpoints: true,
                  externalClearance: 0.04,
                  externalLift: 0.001,
                },
          );
        });
      }

      if (showFirstWireBundle) {
        // First wire bundle rebuilt from user-picked points (12 picks).
        // Picks 1-3  = start endpoints on gripper_link (black, white, red).
        // Picks 4-9  = middle guide points (the white bumps) the bundle threads
        //              between: 4-5 on gripper_link, 6-9 on wrist_link.
        // Picks 10-12 = end endpoints on wrist_link (black, white, red).
        // Three wires share the middle route with a small lane offset so they
        // stay attached but do not merge. Endpoints use exact picked coords.
        const firstWireRadius = 0.004;
        // Lane direction per color. At both endpoints the colors separate in the
        // same order (red one side, black the other, white centered), so this keeps
        // each color on its own side through the route with no crossings.
        const firstWireLaneOffsets: Record<WireColor, number> = {
          red: -1,
          white: 0,
          black: 1,
        };
        // Gripper connector endpoints (picks 4-6 = black, white, red).
        // Gripper connector endpoints (picks 1-3 = black, white, red).
        const firstWireStarts: Record<WireColor, WireGuidePoint> = {
          black: {
            linkName: "gripper_link",
            local: [0.006025, -0.0193, -0.015783],
          },
          white: {
            linkName: "gripper_link",
            local: [0.0062, -0.0193, -0.018052],
          },
          red: {
            linkName: "gripper_link",
            local: [0.005974, -0.0193, -0.020465],
          },
        };
        // Collision-free route THROUGH the user-picked cleavages, computed by
        // analysing the actual STL meshes (wrist + gripper) in the wrist_link frame.
        // The user picked points inside the two surface grooves; each is snapped to
        // its channel medial axis (max-clearance voxel) and the bundle is densified
        // along that axis so it threads the cleavage between the bumps. The gap that
        // wraps ~144 deg around the wrist-roll joint (behind it, where no pick is
        // possible) is bridged by a voxel A* that stays clear of the body. The
        // cleavages are narrow (~3mm), so the thin bundle hugs them snugly.
        // Gripper-side points anchor to gripper_link, the rest to wrist_link.
        const firstWireGuidePoints: WireGuidePoint[] = [
          { linkName: "gripper_link", local: [0.008402, -0.023469, -0.01715], laneVec: [-0.9729, 0, -0.2311], laneSpacing: 0.0016 },
          { linkName: "gripper_link", local: [0.006977, -0.02504, -0.01115], laneVec: [-0.7407, 0.6719, 0], laneSpacing: 0.0016 },
          { linkName: "gripper_link", local: [0.006977, -0.02504, -0.00965], laneVec: [-1, 0, 0], laneSpacing: 0.0016 },
          { linkName: "gripper_link", local: [0.006977, -0.02504, -0.00815], laneVec: [-1, 0, 0], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01925, -0.05875, 0.00925], laneVec: [-0.2184, 0.5722, -0.7905], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.02075, -0.05725, 0.01075], laneVec: [-0.0185, 0.498, -0.867], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01775, -0.04825, 0.01525], laneVec: [-0.4995, 0.4621, -0.7328], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01625, -0.04525, 0.01525], laneVec: [0.031, -0.0929, -0.9952], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01325, -0.04675, 0.01525], laneVec: [0.0198, 0, -0.9998], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01625, -0.04225, 0.01525], laneVec: [0.0356, 0.0142, -0.9993], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01625, -0.03925, 0.01525], laneVec: [0.0451, 0.3646, -0.9301], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01925, -0.02275, 0.02275], laneVec: [0.3183, 0.4494, -0.8347], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01625, -0.01975, 0.02575], laneVec: [0.491, 0.2812, -0.8246], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.01175, -0.01825, 0.02875], laneVec: [0.5185, 0.1337, -0.8446], laneSpacing: 0.0016 },
        ];
        // Wrist connector endpoints (picks 4-6 = black, white, red).
        const firstWireEnds: Record<WireColor, WireGuidePoint> = {
          black: {
            linkName: "wrist_link",
            local: [-0.002891, -0.023, 0.032106],
          },
          white: {
            linkName: "wrist_link",
            local: [-0.005094, -0.023, 0.03216],
          },
          red: {
            linkName: "wrist_link",
            local: [-0.0075, -0.023, 0.032281],
          },
        };

        const createFirstWireAnchor = (
          routePoint: WireGuidePoint,
          color: WireColor,
          shouldSpread = false,
        ): CableAnchor | null => {
          const link = robot.links[routePoint.linkName];

          if (!link) {
            return null;
          }

          const localPosition = new THREE.Vector3(...routePoint.local);

          if (shouldSpread) {
            const laneOffset =
              firstWireLaneOffsets[color] * (routePoint.laneSpacing ?? 0.002);

            if (routePoint.laneVec) {
              const dir = new THREE.Vector3(...routePoint.laneVec);
              if (dir.lengthSq() > 1e-9) {
                localPosition.addScaledVector(dir.normalize(), laneOffset);
              }
            } else if (routePoint.laneAxis === "x") {
              localPosition.x += laneOffset;
            } else if (routePoint.laneAxis === "z") {
              localPosition.z += laneOffset;
            } else {
              localPosition.y += laneOffset;
            }
          }

          return {
            object: link,
            localPosition,
          };
        };

        const addFirstWireConnectorTip = (
          id: ConnectorKey,
          name: string,
          endpoint: Record<WireColor, WireGuidePoint>,
          exitNormal: [number, number, number],
        ) => {
          const endpointAnchors = wireColors
            .map((color) => createFirstWireAnchor(endpoint[color], color))
            .filter((anchor): anchor is CableAnchor => Boolean(anchor));

          if (endpointAnchors.length !== wireColors.length) {
            return;
          }

          const link = endpointAnchors[0].object;

          if (!endpointAnchors.every((anchor) => anchor.object === link)) {
            return;
          }

          const pinPositions = endpointAnchors.map((anchor) =>
            anchor.localPosition.clone(),
          );
          const center = new THREE.Vector3();

          pinPositions.forEach((position) => {
            center.add(position);
          });
          center.divideScalar(pinPositions.length);

          const normal = new THREE.Vector3(...exitNormal).normalize();
          let rowAxis = pinPositions[pinPositions.length - 1]
            .clone()
            .sub(pinPositions[0]);
          rowAxis.sub(normal.clone().multiplyScalar(rowAxis.dot(normal)));

          if (rowAxis.lengthSq() < 0.000001) {
            rowAxis =
              Math.abs(normal.y) < 0.9
                ? new THREE.Vector3(0, 1, 0)
                : new THREE.Vector3(1, 0, 0);
            rowAxis.sub(normal.clone().multiplyScalar(rowAxis.dot(normal)));
          }

          const xAxis = rowAxis.normalize();
          const yAxis = normal.clone();
          const zAxis = new THREE.Vector3()
            .crossVectors(xAxis, yAxis)
            .normalize();
          const rotationMatrix = new THREE.Matrix4().makeBasis(
            xAxis,
            yAxis,
            zAxis,
          );
          // One shared JST model (see jstConnector.ts), oriented so its +Y mounts
          // along the exit normal and its socket row (+X) follows the pin spread.
          const model = createJstConnectorModel({
            plastic: detailMaterials.connectorPlastic,
            socket: detailMaterials.blackWire,
          });
          const connector = model.group;
          connector.name = name;
          connector.position
            .copy(center)
            .add(normal.clone().multiplyScalar(model.depth * 0.5));
          connector.quaternion.setFromRotationMatrix(rotationMatrix);
          connector.traverse((object) => {
            object.userData.robotAccessory = true;
            object.userData.connectorWireAccessory = true;
          });
          link.add(connector);
          wireConnectorTips.push(connector);
          // Tag the connector so the Stage-2 setup can find which motor owns it.
          connector.userData.armRole = options.owner;
          connector.userData.setupConnectorId = id;
          connector.traverse((object) => {
            object.userData.setupConnectorId = id;
            object.userData.armRole = options.owner;
          });
          // Register for the live position/rotation adjust (keeps the base transform).
          adjustableConnectors.push({
            key: id,
            group: connector,
            basePosition: connector.position.clone(),
            baseQuaternion: connector.quaternion.clone(),
            owner: options.owner,
            link,
          });

          // Map sockets to wire colours by the order of the picked pins along the row.
          const colorsByRow = [...wireColors].sort(
            (a, b) =>
              pinPositions[wireColors.indexOf(a)].dot(xAxis) -
              pinPositions[wireColors.indexOf(b)].dot(xAxis),
          );
          const socketByColor = {} as Record<WireColor, THREE.Object3D>;
          const emergeByColor = {} as Record<WireColor, THREE.Object3D>;
          colorsByRow.forEach((color, index) => {
            socketByColor[color] = model.socketAnchors[index];
            emergeByColor[color] = model.emergeAnchors[index];
          });

          return { socketByColor, emergeByColor };
        };

        // Wire tips resolve from the connector's socket/emerge anchors each frame,
        // so the wires follow the connector when it is repositioned/rotated.
        const tipAnchor = (object: THREE.Object3D): CableAnchor => ({
          object,
          localPosition: new THREE.Vector3(),
          resolveWorldPosition: () => object.getWorldPosition(new THREE.Vector3()),
        });
        type WireBundleConfig = {
          startId: ConnectorKey;
          startName: string;
          starts: Record<WireColor, WireGuidePoint>;
          startNormal: [number, number, number];
          endId: ConnectorKey;
          endName: string;
          ends: Record<WireColor, WireGuidePoint>;
          endNormal: [number, number, number];
          guides: WireGuidePoint[];
          radius: number;
        };
        // One connector-wire-connector set: a JST at each end plus three wires
        // routed through the given (collision-free) guide points.
        const buildWireBundle = (cfg: WireBundleConfig) => {
          const startTip = addFirstWireConnectorTip(
            cfg.startId,
            cfg.startName,
            cfg.starts,
            cfg.startNormal,
          );
          const endTip = addFirstWireConnectorTip(
            cfg.endId,
            cfg.endName,
            cfg.ends,
            cfg.endNormal,
          );
          wireColors.forEach((color) => {
            const anchors: CableAnchor[] = [];
            if (startTip) {
              anchors.push(tipAnchor(startTip.socketByColor[color]));
              anchors.push(tipAnchor(startTip.emergeByColor[color]));
            }
            cfg.guides.forEach((routePoint) => {
              const anchor = createFirstWireAnchor(routePoint, color, true);
              if (anchor) {
                anchors.push(anchor);
              }
            });
            if (endTip) {
              anchors.push(tipAnchor(endTip.emergeByColor[color]));
              anchors.push(tipAnchor(endTip.socketByColor[color]));
            }
            if (anchors.length > 1) {
              addDynamicCable(
                anchors,
                wireMaterials[color],
                options.owner,
                cfg.radius,
                180,
              );
            }
          });
        };

        // Bundle 1: gripper connector <-> wrist connector (cleavage route).
        buildWireBundle({
          startId: "gripper",
          startName: "first_wire_gripper_tip",
          starts: firstWireStarts,
          startNormal: [0, 1, 0],
          endId: "wrist",
          endName: "first_wire_wrist_tip",
          ends: firstWireEnds,
          endNormal: [0, 1, 0],
          guides: firstWireGuidePoints,
          radius: firstWireRadius,
        });

        // Bundle 2: lower-arm connector <-> a second wrist connector. Route across
        // the wrist_flex joint was computed by the voxel planner to clear the body
        // (verified ~4mm clearance). Points anchor to whichever link they rest on.
        const secondWireStarts: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "lower_arm_link", local: [-0.120544, 0.012342, 0.0381] },
          white: { linkName: "lower_arm_link", local: [-0.120509, 0.010299, 0.0381] },
          red: { linkName: "lower_arm_link", local: [-0.120746, 0.007486, 0.0381] },
        };
        const secondWireEnds: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "wrist_link", local: [0.00759, -0.023, 0.032316] },
          white: { linkName: "wrist_link", local: [0.005432, -0.023, 0.03234] },
          red: { linkName: "wrist_link", local: [0.002798, -0.023, 0.032293] },
        };
        const secondWireGuidePoints: WireGuidePoint[] = [
          { linkName: "lower_arm_link", local: [-0.12615, 0.021177, 0.038566], laneVec: [-0.5655, 0.2273, 0.7928], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.12765, 0.022677, 0.037066], laneVec: [-0.776, -0.1681, 0.6079], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.017477, -0.01075, 0.034066], laneVec: [0, -0.7071, 0.7071], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.014477, -0.01375, 0.031066], laneVec: [0, -0.5547, 0.832], laneSpacing: 0.0016 },
          { linkName: "wrist_link", local: [-0.012977, -0.01525, 0.031066], laneVec: [-0.7071, -0.7071, 0], laneSpacing: 0.0016 },
        ];
        buildWireBundle({
          startId: "lowerArm",
          startName: "second_wire_lower_arm_tip",
          starts: secondWireStarts,
          startNormal: [0, 0, 1],
          endId: "wrist2",
          endName: "second_wire_wrist_tip",
          ends: secondWireEnds,
          endNormal: [0, 1, 0],
          guides: secondWireGuidePoints,
          radius: firstWireRadius,
        });

        // Bundle 3: lower-arm connector <-> upper-arm connector. Threads the
        // user-picked cleavage points along lower_arm; the long runs and the
        // cross-elbow gap were routed clear of the body by the voxel planner.
        const thirdWireStarts: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "lower_arm_link", local: [-0.120751, 0.002277, 0.0381] },
          white: { linkName: "lower_arm_link", local: [-0.120928, 0.000143, 0.0381] },
          red: { linkName: "lower_arm_link", local: [-0.121221, -0.003328, 0.037875] },
        };
        const thirdWireEnds: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "upper_arm_link", local: [-0.115701, -0.013961, 0.0381] },
          white: { linkName: "upper_arm_link", local: [-0.11827, -0.013926, 0.0381] },
          red: { linkName: "upper_arm_link", local: [-0.120279, -0.01406, 0.0381] },
        };
        const thirdWireGuidePoints: WireGuidePoint[] = [
          { linkName: "lower_arm_link", local: [-0.109902, -0.002325, 0.0442], laneVec: [-0.0766, 0.9961, -0.0432], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.106951, -0.002098, 0.0442], laneVec: [-0.0467, 0.9989, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.091967, -0.001486, 0.051025], laneVec: [-0.0245, 0.9997, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.081967, -0.001486, 0.051025], laneVec: [0, 1, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.071967, -0.001486, 0.051025], laneVec: [0, 1, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.061967, -0.001486, 0.051025], laneVec: [0, 1, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.051967, -0.001486, 0.051025], laneVec: [-0.0913, 0.995, -0.0406], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.041967, 0.000513, 0.055025], laneVec: [-0.0965, 0.9952, -0.0149], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.031967, 0.000513, 0.055025], laneVec: [0.0303, 0.9995, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.019633, -0.000163, 0.0484], laneVec: [0.0216, 0.9998, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.015817, 0.000164, 0.0484], laneVec: [0.0195, 0.9998, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [-0.012234, -0.000307, 0.0484], laneVec: [-0.1952, 0.9808, 0], laneSpacing: 0.0016 },
          { linkName: "lower_arm_link", local: [0.006033, 0.004513, 0.051025], laneVec: [-0.2696, 0.9551, 0.1226], laneSpacing: 0.0016 },
        ];
        buildWireBundle({
          startId: "lowerArm2",
          startName: "third_wire_lower_arm_tip",
          starts: thirdWireStarts,
          startNormal: [0, 0, 1],
          endId: "upperArm",
          endName: "third_wire_upper_arm_tip",
          ends: thirdWireEnds,
          endNormal: [0, 0, 1],
          guides: thirdWireGuidePoints,
          radius: firstWireRadius,
        });

        // Bundle 4: upper-arm connector <-> shoulder connector. Threads the picked
        // cleavages on upper_arm; long runs + the cross-shoulder_lift gap routed
        // clear of the body by the voxel planner (~2.4mm clearance).
        const fourthWireStarts: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "upper_arm_link", local: [-0.109621, -0.013853, 0.0381] },
          white: { linkName: "upper_arm_link", local: [-0.106897, -0.013897, 0.0381] },
          red: { linkName: "upper_arm_link", local: [-0.104492, -0.014035, 0.0381] },
        };
        const fourthWireEnds: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "shoulder_link", local: [-0.037962, 0.019822, -0.039667] },
          white: { linkName: "shoulder_link", local: [-0.035623, 0.019822, -0.039802] },
          red: { linkName: "shoulder_link", local: [-0.032987, 0.019822, -0.039929] },
        };
        const fourthWireGuidePoints: WireGuidePoint[] = [
          { linkName: "upper_arm_link", local: [-0.102003, -0.014928, 0.0491], laneVec: [0, 0.9879, 0.1549], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.096003, -0.014928, 0.0491], laneVec: [0, 0.9555, 0.2951], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.090003, -0.014928, 0.0491], laneVec: [0, 0.7933, 0.6088], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.084003, -0.014928, 0.0491], laneVec: [-0.1341, 0.8044, 0.5787], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.078003, -0.012928, 0.0491], laneVec: [-0.3471, 0.7839, 0.5149], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.072003, -0.010928, 0.0511], laneVec: [-0.3739, 0.9008, 0.2207], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.066003, -0.008928, 0.0531], laneVec: [-0.3559, 0.9233, 0.1442], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.060003, -0.006928, 0.0551], laneVec: [-0.457, 0.8852, 0.0866], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.054003, -0.002928, 0.0551], laneVec: [-0.4472, 0.8944, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.048003, -0.000928, 0.0551], laneVec: [-0.1644, 0.9864, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.042003, -0.000928, 0.0551], laneVec: [0, 1, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.036003, -0.000928, 0.0551], laneVec: [-0.0963, 0.9954, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.026163, 0.000604, 0.0499], laneVec: [0.0797, 0.9144, 0.3969], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.021573, 0.000071, 0.0499], laneVec: [0.071, 0.9975, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.017099, -0.000041, 0.0499], laneVec: [0.0568, 0.9984, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [-0.004003, -0.000928, 0.0551], laneVec: [0.0464, 0.9989, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [0.001997, -0.000928, 0.0551], laneVec: [0, 1, 0], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [0.007997, -0.000928, 0.0551], laneVec: [0, 0.9999, 0.0172], laneSpacing: 0.0016 },
          { linkName: "upper_arm_link", local: [0.013997, -0.000928, 0.0551], laneVec: [0, 0.9996, 0.0278], laneSpacing: 0.0016 },
        ];
        buildWireBundle({
          startId: "upperArm2",
          startName: "fourth_wire_upper_arm_tip",
          starts: fourthWireStarts,
          startNormal: [0, 0, 1],
          endId: "shoulder",
          endName: "fourth_wire_shoulder_tip",
          ends: fourthWireEnds,
          endNormal: [0, 0, 1],
          guides: fourthWireGuidePoints,
          radius: firstWireRadius,
        });

        // Bundle 5: shoulder connector <-> base connector. Threads cleavages on
        // both links; cross-shoulder_pan gap routed clear of the body by the
        // planner. laneVec values are tangent to each link's surface.
        const fifthWireStarts: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "shoulder_link", local: [-0.027859, 0.019822, -0.040039] },
          white: { linkName: "shoulder_link", local: [-0.025335, 0.019822, -0.040317] },
          red: { linkName: "shoulder_link", local: [-0.022871, 0.019822, -0.040258] },
        };
        const fifthWireEnds: Record<WireColor, WireGuidePoint> = {
          black: { linkName: "base_link", local: [0.024869, -0.002622, 0.0243] },
          white: { linkName: "base_link", local: [0.024737, -0.005211, 0.0243] },
          red: { linkName: "base_link", local: [0.024805, -0.007535, 0.0243] },
        };
        // Pure voxel-A* route around the body (no zigzag, no arm penetration).
        // Planned base_link<->shoulder_link across shoulder_pan; worst mesh
        // clearance ~3.2mm. laneVecs are sign-consistent so the 3 wires don't
        // twist. See [[wire-mesh-routing]].
        const fifthWireGuidePoints: WireGuidePoint[] = [
          { linkName: "shoulder_link", local: [-0.010218, 0.029627, -0.03715], laneVec: [0.3529, -0.7072, -0.6126], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [-0.007218, 0.023627, -0.03415], laneVec: [-0.2547, -0.294, -0.9212], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [-0.007218, 0.017627, -0.03415], laneVec: [-0.508, -0.3263, -0.7972], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [-0.004218, 0.011627, -0.03115], laneVec: [0, -0.6, -0.8], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [0.001782, 0.005627, -0.02515], laneVec: [-0.7071, -0.7071, 0], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [0.007782, -0.000373, -0.01915], laneVec: [-0.8944, -0.4472, 0], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [0.007782, -0.006373, -0.01915], laneVec: [-0.9602, -0.2633, -0.0928], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [0.010782, -0.012373, -0.01615], laneVec: [-0.8335, -0.5388, -0.1221], laneSpacing: 0.0016 },
          { linkName: "shoulder_link", local: [0.012282, -0.015373, -0.01015], laneVec: [-0.7689, -0.5809, -0.267], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.019873, 0.06655], laneVec: [1, 0, 0], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.025873, 0.06055], laneVec: [0.9943, 0.0953, -0.0476], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.025873, 0.05455], laneVec: [0.9916, 0.1293, 0], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.025873, 0.04855], laneVec: [0.9916, 0.1293, 0], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.025873, 0.04255], laneVec: [0.9916, 0.1293, 0], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.025873, 0.03655], laneVec: [0.9916, 0.1293, 0], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.025873, 0.03055], laneVec: [0.9948, 0.0911, 0.0455], laneSpacing: 0.0016 },
          { linkName: "base_link", local: [0.026554, -0.019873, 0.02455], laneVec: [0.9884, 0.0392, -0.1465], laneSpacing: 0.0016 },
        ];
        buildWireBundle({
          startId: "shoulder2",
          startName: "fifth_wire_shoulder_tip",
          starts: fifthWireStarts,
          startNormal: [0, 0, 1],
          endId: "base",
          endName: "fifth_wire_base_tip",
          ends: fifthWireEnds,
          endNormal: [1, 0, 0],
          guides: fifthWireGuidePoints,
          radius: firstWireRadius,
        });

        // Bundle 6: controller-board connector <-> base connector. Endpoints are
        // the user's 6 picks (picks 1-3 on the controller board top face, +z
        // normal; picks 4-6 on the base_link +x face, same face as Bundle 5's base
        // end, +x normal). Colors are assigned by row order (ascending link-local
        // y) at each end so the three wires run parallel without crossing.
        const sixthWireStarts: Record<WireColor, WireGuidePoint> = {
          red: { linkName: "base_link", local: [-0.03594, 0.011701, 0.068] }, // pick_02
          white: { linkName: "base_link", local: [-0.036249, 0.015416, 0.068] }, // pick_01
          black: { linkName: "base_link", local: [-0.035988, 0.019421, 0.068] }, // pick_03
        };
        const sixthWireEnds: Record<WireColor, WireGuidePoint> = {
          red: { linkName: "base_link", local: [0.025024, 0.002637, 0.0243] }, // pick_04
          white: { linkName: "base_link", local: [0.025033, 0.004871, 0.0243] }, // pick_05
          black: { linkName: "base_link", local: [0.02518, 0.007414, 0.0243] }, // pick_06
        };
        // Route from the user's 5 hand-picked points (front-face descent then
        // across to the +x base face). Verified by mesh analysis that each straight
        // leg stays within ~7.7mm of the surface and NONE chord across the open
        // front window (a distance-to-surface test, since the window is free space
        // a plain collision check would miss it). Picks are used directly — no leg
        // needed A* bridging. laneVecs are sign-consistent surface tangents
        // (nearest-tri normal x travel). See [[wire-no-guessing]], [[wire-mesh-routing]].
        const sixthWireGuidePoints: WireGuidePoint[] = [
          { linkName: "base_link", local: [-0.038993, 0.012261, 0.062], laneVec: [0, -0.8803, 0.4745], laneSpacing: 0.0016 }, // pick_01
          { linkName: "base_link", local: [-0.030983, -0.005186, 0.0296], laneVec: [0, -0.8988, 0.4383], laneSpacing: 0.0016 }, // pick_02
          { linkName: "base_link", local: [-0.019048, -0.00539, 0.0258], laneVec: [0.0214, -0.9998, 0], laneSpacing: 0.0016 }, // pick_03
          { linkName: "base_link", local: [-0.013386, -0.004809, 0.0258], laneVec: [0.3412, -0.94, 0], laneSpacing: 0.0016 }, // pick_04
          { linkName: "base_link", local: [0.005009, 0.003341, 0.0258], laneVec: [0.2465, -0.9691, 0], laneSpacing: 0.0016 }, // pick_05
        ];
        buildWireBundle({
          startId: "board",
          startName: "sixth_wire_board_tip",
          starts: sixthWireStarts,
          startNormal: [0, 0, 1],
          endId: "base2",
          endName: "sixth_wire_base_tip",
          ends: sixthWireEnds,
          endNormal: [1, 0, 0],
          guides: sixthWireGuidePoints,
          radius: firstWireRadius,
        });
      }

      // Report the distinct JST ids present so the UI can build a picker.
      const connectorIds = Array.from(
        new Set(adjustableConnectors.map((entry) => entry.key)),
      );
      onConnectorsChangeRef.current?.(connectorIds);

      updateDynamicCables();
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const getControlRobot = () => {
      if (
        directControlTargetRef.current === "leader" &&
        showLeaderArmRef.current
      ) {
        return leaderRobotRef.current;
      }

      return robotRef.current;
    };

    const findRobotAncestor = (object: THREE.Object3D) => {
      let current: THREE.Object3D | null = object;

      while (current) {
        if (current === robotRef.current || current === leaderRobotRef.current) {
          return current as URDFRobot;
        }

        current = current.parent;
      }

      return null;
    };

    const findLinkAncestor = (object: THREE.Object3D, robot: URDFRobot) => {
      let current: THREE.Object3D | null = object;

      while (current) {
        if (Object.prototype.hasOwnProperty.call(robot.links, current.name)) {
          return current;
        }

        if (current === robot) {
          return null;
        }

        current = current.parent;
      }

      return null;
    };

    const findMotorSetupAncestor = (object: THREE.Object3D) => {
      let current: THREE.Object3D | null = object;

      while (current) {
        if (current.userData.motorSetupJoint) {
          return current;
        }

        current = current.parent;
      }

      return null;
    };

    const getObjectPath = (object: THREE.Object3D, root: THREE.Object3D) => {
      const names: string[] = [];
      let current: THREE.Object3D | null = object;

      while (current && current !== root) {
        names.unshift(current.name || current.type);
        current = current.parent;
      }

      names.unshift(root.name || root.type);

      return names.join(" > ");
    };

    const pickUsbPort = (event: PointerEvent) => {
      if (
        !usbSetupActiveRef.current ||
        connectorPickModeRef.current ||
        event.button !== 0 ||
        usbPortEntries.length === 0
      ) {
        return false;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      // Allow clicking either the socket or its plug to toggle the connection.
      const targets: THREE.Object3D[] = [];
      usbPortEntries.forEach((entry) => {
        targets.push(entry.portMesh);
        if (entry.plug.visible) {
          targets.push(entry.plug);
        }
      });

      const hit = raycaster.intersectObjects(targets, true)[0];
      if (!hit) {
        return false;
      }

      let current: THREE.Object3D | null = hit.object;
      let arm: "follower" | "leader" | null = null;
      while (current) {
        if (current.userData.usbPortArm) {
          arm = current.userData.usbPortArm as "follower" | "leader";
          break;
        }
        const match = usbPortEntries.find((entry) => entry.plug === current);
        if (match) {
          arm = match.arm;
          break;
        }
        current = current.parent;
      }

      if (!arm) {
        return false;
      }

      event.preventDefault();
      onUsbPortClickRef.current?.(arm);
      return true;
    };

    const pickMotorSetupMotor = (event: PointerEvent) => {
      if (
        !motorSetupActiveRef.current ||
        connectorPickModeRef.current ||
        event.button !== 0
      ) {
        return false;
      }

      const expectedTarget = motorSetupTargetRef.current;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const meshes: THREE.Object3D[] = [];
      [robotRef.current, leaderRobotRef.current].forEach((robot) => {
        if (!robot || (!showLeaderArmRef.current && robot === leaderRobotRef.current)) {
          return;
        }

        robot.traverse((object) => {
          if (
            object instanceof THREE.Mesh &&
            findMotorSetupAncestor(object)
          ) {
            meshes.push(object);
          }
        });
      });
      // The REAL harness JST connectors are the primary click target (the JST the
      // student plugs into the board). Include the follower's motor connectors.
      wireConnectorTips.forEach((tip) => {
        if (tip.visible && tip.userData.setupConnectorId) {
          meshes.push(tip);
        }
      });

      const hit = raycaster.intersectObjects(meshes, true)[0];

      if (!hit) {
        return false;
      }

      // Resolve the hit: a real connector mesh carries setupConnectorId (map it
      // back to the motor); otherwise walk up to the motor accessory body.
      let target: "follower" | "leader" | undefined;
      let jointName: JointName | undefined;
      let node: THREE.Object3D | null = hit.object;
      let connectorId: ConnectorKey | undefined;
      while (node) {
        if (node.userData.setupConnectorId) {
          connectorId = node.userData.setupConnectorId as ConnectorKey;
          target = node.userData.armRole as "follower" | "leader" | undefined;
          break;
        }
        node = node.parent;
      }
      if (connectorId) {
        jointName = (Object.keys(MOTOR_TO_CONNECTOR) as JointName[]).find(
          (joint) => MOTOR_TO_CONNECTOR[joint] === connectorId,
        );
      } else {
        const motorRoot = findMotorSetupAncestor(hit.object);
        target = motorRoot?.userData.motorSetupTarget as
          | "follower"
          | "leader"
          | undefined;
        jointName = motorRoot?.userData.motorSetupJoint as
          | JointName
          | undefined;
      }

      if (!target || !jointName || target !== expectedTarget) {
        return false;
      }

      event.preventDefault();
      onMotorSetupMotorSelectRef.current?.(target, jointName);
      return true;
    };

    const formatVectorTuple = (
      vector: THREE.Vector3,
    ): [number, number, number] => [
      Number(vector.x.toFixed(6)),
      Number(vector.y.toFixed(6)),
      Number(vector.z.toFixed(6)),
    ];

    const pickConnectorPoint = (event: PointerEvent) => {
      if (!connectorPickModeRef.current || event.button !== 0) {
        return false;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const meshes: THREE.Mesh[] = [];
      [robotRef.current, leaderRobotRef.current].forEach((robot) => {
        if (!robot || (!showLeaderArmRef.current && robot === leaderRobotRef.current)) {
          return;
        }

        robot.traverse((object) => {
          if (
            object instanceof THREE.Mesh &&
            (!isRobotAccessory(object) || isConnectorPickSurface(object))
          ) {
            meshes.push(object);
          }
        });
      });

      const hit = raycaster.intersectObjects(meshes, false)[0];

      if (!hit) {
        return true;
      }

      event.preventDefault();
      const robot = findRobotAncestor(hit.object);
      const link = robot ? findLinkAncestor(hit.object, robot) : null;
      const worldPoint = hit.point.clone();
      const marker = new THREE.Mesh(
        connectorPickMarkerGeometry,
        connectorPickMarkerMaterial,
      );
      marker.position.copy(worldPoint);
      marker.userData.robotAccessory = true;
      connectorPickMarkerGroup.add(marker);
      connectorPickCount += 1;

      const objectLocalPoint = hit.object.worldToLocal(worldPoint.clone());
      const linkLocalPoint = link ? link.worldToLocal(worldPoint.clone()) : null;
      const target =
        robot && robot === leaderRobotRef.current ? "leader" : "follower";
      const label = `pick_${String(connectorPickCount).padStart(2, "0")}`;

      onConnectorPickRef.current?.({
        id: connectorPickCount,
        label,
        target,
        objectName: getObjectPath(hit.object, robot ?? hit.object),
        linkName: link?.name ?? null,
        world: formatVectorTuple(worldPoint),
        objectLocal: formatVectorTuple(objectLocalPoint),
        linkLocal: linkLocalPoint ? formatVectorTuple(linkLocalPoint) : null,
      });

      return true;
    };

    const getPointerJoint = (event: PointerEvent) => {
      const robot = getControlRobot();

      if (!robot) {
        return null;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const meshes: THREE.Mesh[] = [];
      robot.traverse((object) => {
        if (object instanceof THREE.Mesh && !isRobotAccessory(object)) {
          meshes.push(object);
        }
      });

      const hit = raycaster.intersectObjects(meshes, false)[0];

      if (!hit) {
        return null;
      }

      let current: THREE.Object3D | null = hit.object;
      let matchedJoint: JointName | null = null;

      while (current && current !== robot) {
        const maybeJoint = current as THREE.Object3D & {
          isURDFJoint?: boolean;
          urdfName?: string;
        };

        if (maybeJoint.isURDFJoint && maybeJoint.urdfName) {
          const jointName = Object.entries(jointConfigs).find(
            ([, config]) => config.urdfJointName === maybeJoint.urdfName,
          )?.[0] as JointName | undefined;

          if (jointName) {
            matchedJoint = jointName;
            break;
          }
        }

        current = current.parent;
      }

      if (matchedJoint) {
        return matchedJoint;
      }

      let nearestJoint: JointName | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;

      Object.entries(jointConfigs).forEach(([jointName, config]) => {
        const joint = robot.joints[config.urdfJointName];

        if (!joint) {
          return;
        }

        const jointPosition = new THREE.Vector3();
        joint.getWorldPosition(jointPosition);

        const distance = jointPosition.distanceTo(hit.point);

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestJoint = jointName as JointName;
        }
      });

      return nearestDistance < 0.25 ? nearestJoint : null;
    };

    const canManipulateJoint = (jointName: JointName) =>
      selectableJointsRef.current.length === 0 ||
      selectableJointsRef.current.includes(jointName);

    const getPointerPlaneVector = (
      event: PointerEvent,
      originWorld: THREE.Vector3,
      axisWorld: THREE.Vector3,
    ) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        axisWorld,
        originWorld,
      );
      const point = new THREE.Vector3();

      if (!raycaster.ray.intersectPlane(plane, point)) {
        return null;
      }

      const vector = point.sub(originWorld);

      if (vector.lengthSq() < 0.000001) {
        return null;
      }

      return vector.normalize();
    };

    const updateHoverState = (event: PointerEvent) => {
      if (
        connectorPickModeRef.current ||
        !directControlEnabledRef.current ||
        dragState
      ) {
        tooltip.hidden = true;
        return;
      }

      const jointName = getPointerJoint(event);
      const canSelect = jointName ? canManipulateJoint(jointName) : false;

      lastHoveredJoint = canSelect ? jointName : null;
      tooltip.hidden = !lastHoveredJoint;

      if (lastHoveredJoint) {
        const rect = container.getBoundingClientRect();
        tooltip.textContent = jointConfigs[lastHoveredJoint].label;
        tooltip.style.left = `${event.clientX - rect.left + 12}px`;
        tooltip.style.top = `${event.clientY - rect.top + 12}px`;
      }
    };

    const startDirectManipulation = (event: PointerEvent) => {
      if (pickConnectorPoint(event)) {
        return;
      }

      if (pickUsbPort(event)) {
        return;
      }

      if (pickMotorSetupMotor(event)) {
        return;
      }

      if (
        connectorPickModeRef.current ||
        !directControlEnabledRef.current ||
        event.button !== 0 ||
        !onJointValueChangeRef.current
      ) {
        return;
      }

      const jointName = getPointerJoint(event);
      const controlRobot = getControlRobot();

      if (!jointName || !controlRobot || !canManipulateJoint(jointName)) {
        return;
      }

      const joint = controlRobot.joints[jointConfigs[jointName].urdfJointName];
      const axisWorld = getJointWorldAxis(controlRobot, jointName);

      if (!joint || !axisWorld) {
        return;
      }

      const originWorld = new THREE.Vector3();
      joint.getWorldPosition(originWorld);

      const startVector = getPointerPlaneVector(
        event,
        originWorld,
        axisWorld,
      );

      if (!startVector) {
        return;
      }

      event.preventDefault();
      renderer.domElement.setPointerCapture(event.pointerId);
      renderer.domElement.style.cursor = cursorMove;
      tooltip.hidden = true;
      controls.enabled = false;
      if (directControlTargetRef.current === "leader") {
        onLeaderJointSelectRef.current?.(jointName);
      } else {
        onJointSelectRef.current?.(jointName);
      }

      dragState = {
        jointName,
        target: directControlTargetRef.current,
        previousValue:
          directControlTargetRef.current === "leader"
            ? leaderJointValuesRef.current[jointName]
            : jointValuesRef.current[jointName],
        axisWorld,
        originWorld,
        startVector,
        previousVector: startVector.clone(),
        pointerId: event.pointerId,
      };
    };

    const updateDirectManipulation = (event: PointerEvent) => {
      if (!dragState) {
        return;
      }

      event.preventDefault();

      const config = jointConfigs[dragState.jointName];
      const currentVector = getPointerPlaneVector(
        event,
        dragState.originWorld,
        dragState.axisWorld,
      );

      if (!currentVector) {
        return;
      }

      const cross = new THREE.Vector3().crossVectors(
        dragState.previousVector,
        currentVector,
      );
      const angle = Math.atan2(
        dragState.axisWorld.dot(cross),
        dragState.previousVector.dot(currentVector),
      );
      const delta = THREE.MathUtils.radToDeg(angle);

      if (Math.abs(delta) > directManipulationJumpThreshold) {
        console.debug("[teleop-control]", {
          source: `${dragState.target}-mouse-drag`,
          jointName: dragState.jointName,
          rawInputValue: delta,
          mappedTargetAngle: dragState.previousValue,
          finalAppliedAngle:
            dragState.target === "leader"
              ? leaderJointValuesRef.current[dragState.jointName]
              : jointValuesRef.current[dragState.jointName],
          deltaChange: delta,
          rejected: true,
          reason: "direct manipulation anti-flip threshold",
        });
        dragState.previousVector = currentVector.clone();
        return;
      }

      const nextValue = Math.min(
        config.max,
        Math.max(config.min, dragState.previousValue + delta),
      );

      console.debug("[teleop-control]", {
        source: `${dragState.target}-mouse-drag`,
        jointName: dragState.jointName,
        rawInputValue: delta,
        mappedTargetAngle: nextValue,
        finalAppliedAngle:
          dragState.target === "leader"
            ? leaderJointValuesRef.current[dragState.jointName]
            : jointValuesRef.current[dragState.jointName],
        deltaChange: nextValue - dragState.previousValue,
        rejected: false,
      });

      dragState.previousValue = nextValue;
      dragState.previousVector = currentVector.clone();

      if (dragState.target === "leader") {
        onLeaderJointValueChangeRef.current?.(dragState.jointName, nextValue);
        return;
      }

      onJointValueChangeRef.current?.(dragState.jointName, nextValue);
    };

    const stopDirectManipulation = () => {
      if (!dragState) {
        return;
      }

      renderer.domElement.releasePointerCapture(dragState.pointerId);
      renderer.domElement.style.cursor = directControlEnabledRef.current
        ? cursorMove
        : cursorDefault;
      controls.enabled = !embeddedRef.current;
      dragState = null;
    };

    const updateCursor = () => {
      if (dragState) {
        return;
      }

      if (connectorPickModeRef.current) {
        renderer.domElement.style.cursor = cursorPrecision;
        return;
      }

      if (lastHoveredJoint) {
        renderer.domElement.style.cursor = cursorPointer;
        return;
      }

      renderer.domElement.style.cursor = directControlEnabledRef.current
        ? cursorMove
        : cursorDefault;
    };

    const syncDualArmLayout = () => {
      const follower = robotRef.current;
      const leader = leaderRobotRef.current;

      if (!follower) {
        return;
      }

      const showLeader = showLeaderArmRef.current;
      const spacing = dualArmTeleoperationSpacing;

      follower.position.copy(followerHomePosition);
      follower.position.x += showLeader ? spacing : 0;

      accessoryRoots.forEach((root) => {
        const role = root.userData.armRole as "follower" | "leader" | undefined;
        root.visible = role !== "leader" || showLeader;
      });

      if (leader) {
        leader.visible = showLeader;
        leader.position.copy(followerHomePosition);
        leader.position.x -= spacing;
      }

      if (lastShowLeaderLayout === showLeader) {
        return;
      }

      lastShowLeaderLayout = showLeader;
      follower.updateMatrixWorld(true);
      leader?.updateMatrixWorld(true);

      const viewBox = new THREE.Box3().setFromObject(follower);

      if (showLeader && leader) {
        viewBox.union(new THREE.Box3().setFromObject(leader));
      }

      const center = viewBox.getCenter(new THREE.Vector3());
      const size = viewBox.getSize(new THREE.Vector3());
      const distance = Math.max(2.5, size.length() * (showLeader ? 1.85 : 1.1));
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();

      if (direction.lengthSq() < 0.000001) {
        direction.set(1, 0.7, 1).normalize();
      }

      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(0.01, distance / 100);
      camera.far = distance * 20;
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      controls.update();
    };

    renderer.domElement.addEventListener(
      "pointerdown",
      startDirectManipulation,
    );
    renderer.domElement.addEventListener(
      "pointermove",
      updateDirectManipulation,
    );
    renderer.domElement.addEventListener("pointermove", updateHoverState);
    renderer.domElement.addEventListener("pointerup", stopDirectManipulation);
    renderer.domElement.addEventListener(
      "pointercancel",
      stopDirectManipulation,
    );

    const frameRobot = (robot: URDFRobot) => {
      robot.updateMatrixWorld(true);

      const rawBox = new THREE.Box3().setFromObject(robot);
      const rawSize = rawBox.getSize(new THREE.Vector3());
      const rawCenter = rawBox.getCenter(new THREE.Vector3());

      const rawMaxDimension = Math.max(rawSize.x, rawSize.y, rawSize.z);

      if (
        !Number.isFinite(rawMaxDimension) ||
        rawMaxDimension < minimumRobotDimension
      ) {
        return false;
      }

      console.log("Robot bounding-box size", rawSize.toArray());
      console.log("Robot bounding-box centre", rawCenter.toArray());

      robot.position.sub(rawCenter);
      robot.updateMatrixWorld(true);

      const centeredBox = new THREE.Box3().setFromObject(robot);
      const centeredSize = centeredBox.getSize(new THREE.Vector3());
      const maxDimension = Math.max(
        centeredSize.x,
        centeredSize.y,
        centeredSize.z,
      );
      const scale = maxDimension > 0 ? 1.05 / maxDimension : 1;
      robot.scale.setScalar(scale);
      robot.updateMatrixWorld(true);

      const scaledBox = new THREE.Box3().setFromObject(robot);
      robot.position.y -= scaledBox.min.y;
      robot.updateMatrixWorld(true);

      const finalBox = new THREE.Box3().setFromObject(robot);
      const finalSize = finalBox.getSize(new THREE.Vector3());
      const finalCenter = finalBox.getCenter(new THREE.Vector3());
      const distance = Math.max(1.4, finalSize.length() * 1.25);

      controls.target.copy(finalCenter);
      camera.position.set(
        finalCenter.x + distance,
        finalCenter.y + distance * 0.7,
        finalCenter.z + distance,
      );
      camera.near = Math.max(0.01, distance / 100);
      camera.far = distance * 20;
      camera.lookAt(finalCenter);
      camera.updateProjectionMatrix();
      controls.update();

      console.log("Robot final position", robot.position.toArray());
      console.log("Robot scale", robot.scale.toArray());

      return true;
    };

    const loadLeaderRobot = (follower: URDFRobot) => {
      if (leaderLoadStarted || leaderRobotRef.current) {
        return;
      }

      leaderLoadStarted = true;

      const leaderLoadingManager = new THREE.LoadingManager();
      const leaderUrdfLoader = new URDFLoader(leaderLoadingManager);
      leaderUrdfLoader.parseVisual = true;
      leaderUrdfLoader.parseCollision = false;
      leaderUrdfLoader.loadMeshCb =
        meshLoader as unknown as URDFLoader["loadMeshCb"];

      leaderLoadingManager.onError = (url) => {
        console.error("Leader STL path failed", url);
      };

      console.log("Starting Leader URDF load", leaderModelUrl);

      leaderUrdfLoader.load(
        leaderModelUrl,
        (leaderRobot) => {
          if (!isMounted) {
            return;
          }

          console.log("Leader URDF loaded");
          leaderRobot.name = "so101_leader_arm";
          leaderRobot.visible = showLeaderArmRef.current;
          leaderRobot.rotation.copy(follower.rotation);
          leaderRobot.scale.copy(follower.scale);
          leaderRobot.position.copy(followerHomePosition);
          prepareRobotMeshes(leaderRobot);
          applyJointValues(leaderRobot, leaderJointValuesRef.current);
          ensureRobotMaterials(leaderRobot, 0x343d4a, 0.12);

          leaderRobotRef.current = leaderRobot;
          scene.add(leaderRobot);
          buildRobotDetails(leaderRobot, {
            includeBoard: true,
            owner: "leader",
          });
          syncDualArmLayout();
        },
        undefined,
        (error) => {
          console.error("Leader URDF parsing error", error);
        },
      );
    };

    const tryFrameRobot = () => {
      if (!isMounted) {
        return;
      }

      const robot = robotRef.current;

      if (!robot || robotFramed) {
        return;
      }

      if (frameRobot(robot)) {
        robotFramed = true;
        followerHomePosition.copy(robot.position);
        clearRobotDetails();

        ensureRobotMaterials(robot, 0xf4f4f4);
        syncDualArmLayout();
        buildRobotDetails(robot, { includeBoard: true, owner: "follower" });
        loadLeaderRobot(robot);

        if (!robotHadMeshError) {
          scene.remove(loadingMarker);
        }

        return;
      }

      if (frameRetryCount < 120) {
        frameRetryCount += 1;
        window.requestAnimationFrame(tryFrameRobot);
        return;
      }

      console.error(
        "Any URDF parsing error",
        new Error("Robot loaded without a measurable mesh bounding box."),
      );
      scene.remove(loadingMarker);
      loadingMarker.material = failedMarkerMaterial;
      scene.add(loadingMarker);
    };

    loadingManager.onLoad = () => {
      tryFrameRobot();
    };

    console.log("Starting URDF load", modelUrl);

    urdfLoader.load(
      modelUrl,
      (robot) => {
        if (!isMounted) {
          return;
        }

        console.log("URDF loaded");
        robotRef.current = robot;

        robot.rotation.x = -Math.PI / 2;
        prepareRobotMeshes(robot);

        console.log("Actual URDF joint names", Object.keys(robot.joints));

        scene.add(robot);
        console.log("Robot added to scene");

        applyJointValues(robot, jointValuesRef.current);
        ensureRobotMaterials(robot, 0xf4f4f4);
      },
      undefined,
      (error) => {
        console.error("Any URDF parsing error", error);
        scene.remove(loadingMarker);
        loadingMarker.material = failedMarkerMaterial;
        scene.add(loadingMarker);
      },
    );

    // ---- Stage 2: recolour the mounted motors to show setup progress ----
    let lastMotorSetupActive = false;
    const restoreMotorSetupVisuals = () => {
      motorSetupEntries.forEach((entry) => {
        entry.meshes.forEach((mesh, index) => {
          mesh.material = entry.baseMaterials[index];
        });
        entry.group.scale.setScalar(entry.baseScale);
      });
    };
    const updateMotorSetupVisuals = () => {
      // Stage 2 no longer recolours the arm motors (the orange/green/dim tint was
      // distracting). The arm stays its natural white — only the active JST
      // connector glows (handled by setConnectorGlow). Just make sure the motors
      // are restored to their base materials if a prior frame had tinted them.
      if (lastMotorSetupActive) {
        restoreMotorSetupVisuals();
        lastMotorSetupActive = false;
      }
    };

    // ---- Stage 2 with the REAL harness JST connectors ----
    const setupActiveNow = () =>
      motorSetupActiveRef.current && !motorSetupChainedRef.current;

    // For the active motor we move its ACTUAL harness connector (already wired
    // into the arm) off its mount and onto the board; its real wires follow
    // because they are anchored to the connector. No synthetic geometry.
    const camWorldUp = new THREE.Vector3(0, 1, 0);
    // DEV-only live overrides for the active motor's view, used to dial in the
    // per-motor config without rebuilding. null = use config.
    let setupCamRotOverride: number | null = null;
    let setupCamUpBiasOverride: number | null = null;
    let setupCamDistOverride: number | null = null;
    let setupCamBoardFwdOverride: number | null = null;
    let setupCamRollOverride: number | null = null;
    let setupCamBoardDownOverride: number | null = null;
    let sCamDist = 0.44; // per-active-motor camera distance, set in computeActiveSetup
    let sCamRoll = 0; // per-active-motor view roll (deg), set in computeActiveSetup
    const sCamUp = new THREE.Vector3(0, 1, 0); // camera up (incl. roll), set in computeActiveSetup
    const sMount = new THREE.Vector3();
    const sBoardPos = new THREE.Vector3();
    const sCamDir = new THREE.Vector3(); // head-on dir from the connector's facing
    const sOutward = new THREE.Vector3();
    const setupConnectorForMotor = (joint: JointName | null) =>
      joint
        ? adjustableConnectors.find(
            (c) => c.owner === "follower" && c.key === MOTOR_TO_CONNECTOR[joint],
          )
        : undefined;

    // The connector's CURRENT (adjusted) local transform — base transform plus
    // whatever offset the DEV adjust-connector mode set for it. Fills alPos/alQuat.
    const alPos = new THREE.Vector3();
    const alQuat = new THREE.Quaternion();
    const alAdjQuat = new THREE.Quaternion();
    const alAdjOffset = new THREE.Vector3();
    type RealConnEntry = (typeof adjustableConnectors)[number];
    const adjustedLocal = (entry: RealConnEntry) => {
      const adjust = connectorAdjustRef.current?.[entry.key];
      alQuat.copy(entry.baseQuaternion);
      alPos.copy(entry.basePosition);
      if (adjust) {
        alAdjQuat.setFromEuler(
          new THREE.Euler(
            THREE.MathUtils.degToRad(adjust.rx),
            THREE.MathUtils.degToRad(adjust.ry),
            THREE.MathUtils.degToRad(adjust.rz),
          ),
        );
        alQuat.multiply(alAdjQuat);
        alAdjOffset
          .set(adjust.px, adjust.py, adjust.pz)
          .applyQuaternion(entry.baseQuaternion);
        alPos.add(alAdjOffset);
      }
    };

    // Active connector entry + its mounted world position, the head-on camera
    // direction (derived from the connector's adjusted facing), and where the
    // board sits (open air in front of the connector, a little below).
    const sLinkQuat = new THREE.Quaternion();
    const computeActiveSetup = () => {
      if (!setupActiveNow()) {
        return null;
      }
      const entry = setupConnectorForMotor(motorSetupActiveJointRef.current);
      if (!entry) {
        return null;
      }
      adjustedLocal(entry);
      // Mounted (adjusted) world position = where the connector plugs out from.
      sMount.copy(alPos);
      entry.link.localToWorld(sMount);
      // The connector's mounting axis (its local +Y) in world, using the adjusted
      // orientation — the "Y direction" the camera is offset along so we view the
      // connector head-on. For the 3rd motor onward this axis points to the
      // opposite side, so flip the sign to keep the camera on the correct side.
      entry.link.getWorldQuaternion(sLinkQuat);
      sOutward.set(0, 1, 0).applyQuaternion(alQuat).applyQuaternion(sLinkQuat).normalize();
      const activeJoint = motorSetupActiveJointRef.current as JointName;
      const camCfg = SETUP_CAM_CFG[activeJoint] ?? {};
      const ySign =
        camCfg.ySign ?? (SETUP_VIEW_FLIP_Y.has(activeJoint) ? -1 : 1);
      const upBias = setupCamUpBiasOverride ?? camCfg.upBias ?? 0.18;
      const allowBelow = camCfg.allowBelow || setupCamUpBiasOverride != null;
      sCamDist = setupCamDistOverride ?? camCfg.dist ?? 0.44;
      sCamRoll = setupCamRollOverride ?? camCfg.rollDeg ?? 0;
      sCamDir.copy(sOutward).multiplyScalar(ySign).addScaledVector(camWorldUp, upBias);
      if (!allowBelow && sCamDir.y < 0.08) {
        sCamDir.y = 0.08;
      }
      sCamDir.normalize();
      // Orbit the view around the vertical axis (+deg = to the right). Negative
      // angle about world-up = clockwise seen from above = camera swings right.
      const rotateDeg = setupCamRotOverride ?? camCfg.rotateDeg ?? 0;
      if (rotateDeg !== 0) {
        sCamDir.applyAxisAngle(camWorldUp, (-rotateDeg * Math.PI) / 180).normalize();
      }
      // Camera up (shared with updateMotorSetupCamera): world-up projected
      // perpendicular to the fixed view dir, plus the optional roll. Computed here
      // so the board's screen-space "down" offset uses the same (rolled) frame.
      sCamUp
        .set(0, 1, 0)
        .addScaledVector(sCamDir, -sCamDir.y)
        .normalize();
      if (sCamUp.lengthSq() < 1e-6) {
        sCamUp.set(0, 0, -1);
      }
      if (sCamRoll !== 0) {
        sCamUp.applyAxisAngle(sCamDir, (sCamRoll * Math.PI) / 180).normalize();
      }
      // Board floats in front of the connector (toward camera) and a bit below,
      // so the connector descends into it when plugged. boardForward pulls it
      // closer to the screen; boardDown shifts it toward the bottom of the screen
      // (along −cameraUp). The connector docks on it and its real wire trails back.
      const boardFwd = setupCamBoardFwdOverride ?? camCfg.boardForward ?? 0.06;
      const boardDown = setupCamBoardDownOverride ?? camCfg.boardDown ?? 0;
      sBoardPos
        .copy(sMount)
        .addScaledVector(sCamDir, boardFwd)
        .addScaledVector(camWorldUp, -0.09)
        .addScaledVector(sCamUp, -boardDown);
      return entry;
    };

    // Camera: lock user control and frame the connector + board from one fixed
    // 3/4 angle (consistent, never looks through the arm body).
    let cameraWasLocked = false;
    const camTmpTarget = new THREE.Vector3();
    const camTmpDesired = new THREE.Vector3();
    const updateMotorSetupCamera = () => {
      if (!setupActiveNow()) {
        if (cameraWasLocked) {
          controls.enabled = !embeddedRef.current;
          controls.enableDamping = true;
          controls.minDistance = 0.35;
          camera.up.set(0, 1, 0); // restore default up for normal orbit controls
          cameraWasLocked = false;
        }
        return;
      }
      controls.enabled = false;
      controls.enableDamping = false;
      controls.minDistance = 0.05;
      cameraWasLocked = true;

      const active = computeActiveSetup();
      if (active) {
        // Head-on to the connector (sCamDir from its adjusted facing): aim at the
        // plug-out point, with the connector + motor + board all in frame. Pulled
        // back enough for context (0.24 was too tight to read).
        camTmpTarget.copy(sMount).lerp(sBoardPos, 0.4);
        camTmpDesired.copy(camTmpTarget).addScaledVector(sCamDir, sCamDist);
        controls.target.lerp(camTmpTarget, 0.12);
        camera.position.lerp(camTmpDesired, 0.12);
        // Stable, drift-free roll: sCamUp (computed in computeActiveSetup) is
        // world-up projected perpendicular to the fixed view dir + the roll, so
        // the steeply-up/down from-below view can't swing to a diagonal as the
        // camera/connector settles.
        camera.up.copy(sCamUp);
        camera.lookAt(controls.target);
        return;
      }

      // No active motor yet (command not run) — frame the whole follower wider.
      const entry =
        motorSetupEntries.find(
          (candidate) =>
            candidate.target === motorSetupTargetRef.current &&
            candidate.jointName === "gripper",
        ) ?? motorSetupEntries.find((c) => c.target === motorSetupTargetRef.current);
      if (!entry) {
        return;
      }
      camTmpTarget.copy(entry.group.getWorldPosition(new THREE.Vector3()));
      camTmpTarget.y += 0.012;
      camTmpDesired.copy(camTmpTarget).add(new THREE.Vector3(0.45, 0.3, 0.45));
      controls.target.lerp(camTmpTarget, 0.14);
      camera.position.lerp(camTmpDesired, 0.14);
      // Reset to default up — the per-motor roll (e.g. shoulder_pan's rollDeg)
      // must NOT carry into this whole-arm overview (it left the camera rolled).
      camera.up.set(0, 1, 0);
      camera.lookAt(controls.target);
    };

    // The board sits in open air next to the active connector, billboarded to
    // face the camera with its socket toward the incoming JST.
    const updateSetupBoard = (time: number) => {
      const active = computeActiveSetup();
      if (!active) {
        setupBoardGroup.visible = false;
        return;
      }
      setupBoardGroup.visible = true;
      setupBoardGroup.scale.setScalar(1);
      setupBoardGroup.position.lerp(sBoardPos, 0.25);
      setupBoardGroup.quaternion.copy(camera.quaternion);
      setupBoardGroup.rotateZ(Math.PI);
      setupBoardGroup.rotateX(0.5);
      const socketPulse = 0.5 + 0.5 * Math.sin(time * 0.006);
      setupBoardSocketMaterial.emissiveIntensity = 0.25 + 0.45 * socketPulse;
    };

    // Move/recolour the REAL harness connectors for Stage 2. The active motor's
    // connector lifts off its mount and (once plugged) docks into the board; its
    // wires follow because they resolve from the connector's anchors each frame.
    const dockOffsetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(Math.PI / 2, 0, 0),
    );
    const rcGoalPos = new THREE.Vector3();
    const rcGoalQuat = new THREE.Quaternion();
    const rcLiftDirLocal = new THREE.Vector3();
    const rcLinkQuatInv = new THREE.Quaternion();
    const rcCurY = new THREE.Vector3();
    const rcAlign = new THREE.Quaternion();
    type RealConn = (typeof adjustableConnectors)[number];
    const ensureConnectorGlow = (entry: RealConn) => {
      if (entry.glowMeshes) {
        return;
      }
      const meshes: THREE.Mesh[] = [];
      const baseMats: THREE.Material[] = [];
      const glowMats: THREE.MeshStandardMaterial[] = [];
      entry.group.traverse((object) => {
        if (
          object instanceof THREE.Mesh &&
          object.material === detailMaterials.connectorPlastic
        ) {
          meshes.push(object);
          baseMats.push(object.material);
          glowMats.push((object.material as THREE.MeshStandardMaterial).clone());
        }
      });
      entry.glowMeshes = meshes;
      entry.baseMeshMaterials = baseMats;
      entry.glowMaterials = glowMats;
    };
    const setConnectorGlow = (
      entry: RealConn,
      on: boolean,
      color = 0xff9d2e,
      intensity = 0.5,
    ) => {
      ensureConnectorGlow(entry);
      entry.glowMeshes!.forEach((mesh, i) => {
        if (on) {
          const g = entry.glowMaterials![i];
          // Tint the body toward the highlight colour AND glow it, so the active
          // JST is unmistakably the only highlighted thing.
          g.color.setHex(color);
          g.emissive.setHex(color);
          g.emissiveIntensity = intensity;
          mesh.material = g;
        } else {
          mesh.material = entry.baseMeshMaterials![i];
        }
      });
    };
    const updateRealConnectorSetup = (time: number) => {
      const active = setupActiveNow();
      const activeJoint = motorSetupActiveJointRef.current;
      const connectedJoint = motorSetupConnectedJointRef.current;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);

      (Object.keys(MOTOR_TO_CONNECTOR) as JointName[]).forEach((joint) => {
        const entry = setupConnectorForMotor(joint);
        if (!entry) {
          return;
        }
        const isConnected = active && joint === connectedJoint;
        const isActive = active && joint === activeJoint && !isConnected;

        if (!isConnected && !isActive) {
          // Mounted (base loop already set its transform). Clear the glow + the
          // animation state so it re-seats cleanly and re-activates from the mount.
          setConnectorGlow(entry, false);
          entry.animPos = undefined;
          entry.animQuat = undefined;
          return;
        }

        // Compute the goal transform in the connector's LINK-LOCAL frame.
        if (isConnected) {
          // Dock: onto the board socket, oriented so its socket face mates.
          setupBoardPort.getWorldPosition(rcGoalPos);
          entry.link.worldToLocal(rcGoalPos);
          rcGoalQuat.copy(setupBoardGroup.quaternion).multiply(dockOffsetQuat);
          entry.link.getWorldQuaternion(rcLinkQuatInv).invert();
          rcGoalQuat.premultiply(rcLinkQuatInv);
          setConnectorGlow(entry, true, 0x2bd47a, 0.9);
        } else {
          // Unplugged: lift the connector OUT toward the camera (so it clears the
          // body and is visible) AND rotate it to FACE the camera — its socket/
          // wire side (−Y) then points AWAY from the viewer, so the wires emerge
          // behind it and run straight instead of flipping in front of the JST.
          adjustedLocal(entry);
          entry.link.getWorldQuaternion(rcLinkQuatInv).invert();
          rcLiftDirLocal.copy(sCamDir).applyQuaternion(rcLinkQuatInv).normalize();
          rcGoalPos.copy(alPos).addScaledVector(rcLiftDirLocal, 0.055 + 0.01 * pulse);
          // Rotate the adjusted orientation so its +Y points toward the camera.
          rcCurY.set(0, 1, 0).applyQuaternion(alQuat).normalize();
          rcAlign.setFromUnitVectors(rcCurY, rcLiftDirLocal);
          rcGoalQuat.copy(rcAlign).multiply(alQuat);
          setConnectorGlow(entry, true, 0xff9d2e, 0.7 + 0.5 * pulse);
        }

        // Persistent animation: accumulate toward the goal across frames (the base
        // loop resets group.position to the mount each frame, so we must keep our
        // own state and write it ABSOLUTELY here — otherwise it never reaches the
        // board). Seed from the current mounted transform on first activation.
        if (!entry.animPos || !entry.animQuat) {
          entry.animPos = entry.group.position.clone();
          entry.animQuat = entry.group.quaternion.clone();
        }
        entry.animPos.lerp(rcGoalPos, 0.2);
        entry.animQuat.slerp(rcGoalQuat, 0.2);
        entry.group.position.copy(entry.animPos);
        entry.group.quaternion.copy(entry.animQuat);
      });
    };

    // ---- Stage 1: animate the USB plugs in/out and glow the active port ----
    let lastUsbSetupActive = false;
    const updateUsbVisuals = (time: number) => {
      stageOneRig.visible = usbSetupActiveRef.current;
      if (!usbSetupActiveRef.current) {
        if (lastUsbSetupActive) {
          usbPortEntries.forEach((entry) => {
            entry.plug.visible = false;
            entry.plug.position.copy(entry.plugOutPosition);
            entry.portMaterial.emissive.setHex(0x000000);
            entry.portMaterial.emissiveIntensity = 0;
          });
          // Reset the power plug-in demo so it replays next time Stage 1 opens.
          powerPlugProgress.follower = 0;
          powerPlugProgress.leader = 0;
          lastUsbSetupActive = false;
        }
        return;
      }
      lastUsbSetupActive = true;

      const connections = usbConnectionsRef.current;
      const activeArm = usbActiveArmRef.current;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.006);

      usbPortEntries.forEach((entry) => {
        entry.plug.visible = true;
        const connected = Boolean(connections?.[entry.arm]);
        const targetPosition = connected
          ? entry.plugInPosition
          : entry.plugOutPosition;
        entry.plug.position.lerp(targetPosition, 0.22);

        if (connected) {
          entry.portMaterial.emissive.setHex(0x1c7c4e);
          entry.portMaterial.emissiveIntensity = 0.75;
        } else if (activeArm === entry.arm) {
          entry.portMaterial.emissive.setHex(0xff9d2e);
          entry.portMaterial.emissiveIntensity = 0.35 + 0.65 * pulse;
        } else {
          entry.portMaterial.emissive.setHex(0x000000);
          entry.portMaterial.emissiveIntensity = 0;
        }
      });

      updateStageOneRig();
    };

    // Reused scratch objects for the per-frame connector-adjust loop (avoids
    // allocating a Quaternion/Euler/Vector3 per connector per frame → less GC).
    const acRotQuat = new THREE.Quaternion();
    const acEuler = new THREE.Euler();
    const acOffset = new THREE.Vector3();
    const animate = () => {
      const animationTime =
        typeof performance !== "undefined" ? performance.now() : 0;
      if (scene.children.includes(loadingMarker)) {
        loadingMarker.rotation.x += 0.01;
        loadingMarker.rotation.y += 0.015;
      }

      if (lastConnectorPickClearToken !== connectorPickClearTokenRef.current) {
        lastConnectorPickClearToken = connectorPickClearTokenRef.current;
        connectorPickCount = 0;
        connectorPickMarkerGroup.clear();
      }

      const robot = robotRef.current;
      const leaderRobot = leaderRobotRef.current;

      if (robot) {
        syncDualArmLayout();
        smoothRenderedJointValues(
          renderedJointValuesRef.current,
          jointValuesRef.current,
        );
        applyJointValues(robot, renderedJointValuesRef.current);
        if (leaderRobot) {
          smoothRenderedJointValues(
            renderedLeaderJointValuesRef.current,
            leaderJointValuesRef.current,
          );
          applyJointValues(leaderRobot, renderedLeaderJointValuesRef.current);
        }
        robot.updateMatrixWorld(true);
        leaderRobot?.updateMatrixWorld(true);
        // Apply the live connector position/rotation adjust (relative to each
        // connector's computed base transform, in its own local frame).
        const adjustMap = connectorAdjustRef.current;
        adjustableConnectors.forEach(({ key, group, basePosition, baseQuaternion }) => {
          const adjust = adjustMap?.[key];
          if (!adjust) {
            group.position.copy(basePosition);
            group.quaternion.copy(baseQuaternion);
            return;
          }
          acEuler.set(
            THREE.MathUtils.degToRad(adjust.rx),
            THREE.MathUtils.degToRad(adjust.ry),
            THREE.MathUtils.degToRad(adjust.rz),
          );
          acRotQuat.setFromEuler(acEuler);
          group.quaternion.copy(baseQuaternion).multiply(acRotQuat);
          group.position
            .copy(basePosition)
            .add(
              acOffset
                .set(adjust.px, adjust.py, adjust.pz)
                .applyQuaternion(baseQuaternion),
            );
        });
        // Stage 2 drives the camera, the open-air board, and the active REAL
        // connector BEFORE the cables update, so the real wires follow the moved
        // connector this same frame.
        updateMotorSetupCamera();
        updateSetupBoard(animationTime);
        updateRealConnectorSetup(animationTime);
        updateDynamicCables();
        // Stage 2 detaches the controller board from the arm (shown as the
        // open-air board), so hide only the arm-attached board. The real harness
        // wires + JST connectors stay VISIBLE — the active connector itself lifts
        // out and plugs into the board.
        const detachBoard =
          motorSetupActiveRef.current && !motorSetupChainedRef.current;
        attachedBoards.forEach((board) => {
          board.visible = !detachBoard && isAccessoryArmVisible(board);
        });
        dynamicCables.forEach((cable) => {
          cable.mesh.visible = isAccessoryArmVisible(cable.mesh);
        });
        wirePinCaps.forEach((cap) => {
          cap.visible = !connectorPickModeRef.current && isAccessoryArmVisible(cap);
        });
        wireConnectorTips.forEach((tip) => {
          tip.visible = !connectorPickModeRef.current && isAccessoryArmVisible(tip);
        });
        ensureRobotMaterials(robot, 0xf4f4f4);
        if (leaderRobot) {
          ensureRobotMaterials(leaderRobot, 0x343d4a, 0.12);
        }
        if (
          showLeaderArmRef.current &&
          directControlTargetRef.current === "leader" &&
          leaderRobot
        ) {
          applyJointHighlight(
            leaderRobot,
            highlightedLeaderJointRef.current,
            lastHighlightedLeaderJoint,
            (jointName) => {
              lastHighlightedLeaderJoint = jointName;
            },
          );
        } else {
          // In Stage 2 the arm link must NOT be highlighted orange — only the JST
          // connector glows. Pass null so no link mesh is tinted.
          applyJointHighlight(
            robot,
            motorSetupActiveRef.current ? null : highlightedJointRef.current,
            lastHighlightedJoint,
            (jointName) => {
              lastHighlightedJoint = jointName;
            },
          );
        }
        updateJointGizmo(getControlRobot() ?? robot);
        updateHoverGizmo(getControlRobot() ?? robot);
        updateCalibrationMarkers();
        updateGuidedCamera();
        updateMotorSetupVisuals();
        updateUsbVisuals(animationTime);
      }

      updateCursor();

      // While Stage-2 drives the camera manually (locked, no damping/user input),
      // skip controls.update() — it re-derives the camera from spherical state
      // each frame and was overriding the close CAS zoom.
      if (!setupActiveNow()) {
        controls.update();
      }
      renderer.render(scene, camera);
      animationFrameId = window.requestAnimationFrame(animate);
    };

    // DEV-only test hook: project the REAL motor JST connectors to normalized
    // screen coords so automated checks can click each one deterministically.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__so101setup = () =>
        (Object.keys(MOTOR_TO_CONNECTOR) as JointName[])
          .map((joint) => {
            const entry = adjustableConnectors.find(
              (c) => c.owner === "follower" && c.key === MOTOR_TO_CONNECTOR[joint],
            );
            if (!entry || !entry.group.visible) {
              return null;
            }
            const p = entry.group
              .getWorldPosition(new THREE.Vector3())
              .project(camera);
            return {
              joint,
              x: p.x * 0.5 + 0.5,
              y: 1 - (p.y * 0.5 + 0.5),
            };
          })
          .filter(Boolean);
      (window as unknown as Record<string, unknown>).__so101cam = () => ({
        dist: camera.position.distanceTo(controls.target),
        activeJoint: motorSetupActiveJointRef.current,
        connected: motorSetupConnectedJointRef.current,
        minDistance: controls.minDistance,
      });
      (window as unknown as Record<string, unknown>).__so101setSetupRot = (
        deg: number | null,
      ) => {
        setupCamRotOverride = deg;
      };
      (window as unknown as Record<string, unknown>).__so101setSetupBias = (
        bias: number | null,
      ) => {
        setupCamUpBiasOverride = bias;
      };
      (window as unknown as Record<string, unknown>).__so101setSetupDist = (
        dist: number | null,
      ) => {
        setupCamDistOverride = dist;
      };
      (window as unknown as Record<string, unknown>).__so101setSetupBoardFwd = (
        fwd: number | null,
      ) => {
        setupCamBoardFwdOverride = fwd;
      };
      (window as unknown as Record<string, unknown>).__so101setSetupRoll = (
        roll: number | null,
      ) => {
        setupCamRollOverride = roll;
      };
      (window as unknown as Record<string, unknown>).__so101setSetupBoardDown = (
        down: number | null,
      ) => {
        setupCamBoardDownOverride = down;
      };
    }

    animate();

    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;

      if (width === 0 || height === 0) {
        return;
      }

      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    };

    window.addEventListener("resize", handleResize);
    // The canvas must also follow its CONTAINER (the panel column changes width
    // when switching missions, with no window resize) — otherwise it keeps a
    // stale, too-wide size and overflows the panel.
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => handleResize())
        : null;
    resizeObserver?.observe(container);

    return () => {
      isMounted = false;

      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      renderer.domElement.removeEventListener(
        "pointerdown",
        startDirectManipulation,
      );
      renderer.domElement.removeEventListener(
        "pointermove",
        updateDirectManipulation,
      );
      renderer.domElement.removeEventListener("pointermove", updateHoverState);
      renderer.domElement.removeEventListener(
        "pointerup",
        stopDirectManipulation,
      );
      renderer.domElement.removeEventListener(
        "pointercancel",
        stopDirectManipulation,
      );
      controls.dispose();
      restoreHighlightedMaterials();
      clearRobotDetails();
      clearCalibrationMarkers();

      const robot = robotRef.current;

      if (robot) {
        robot.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry?.dispose();
            disposeMaterial(object.material);
          }
        });
        scene.remove(robot);
        robotRef.current = null;
      }

      const leaderRobot = leaderRobotRef.current;

      if (leaderRobot) {
        leaderRobot.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry?.dispose();
            disposeMaterial(object.material);
          }
        });
        scene.remove(leaderRobot);
        leaderRobotRef.current = null;
      }

      floorGeometry.dispose();
      floorMaterial.dispose();
      loadingGeometry.dispose();
      loadingMaterial.dispose();
      failedMarkerMaterial.dispose();
      gizmoGeometry.dispose();
      gizmoMaterial.dispose();
      markerSphereGeometry.dispose();
      focusRingGeometry.dispose();
      connectorPickMarkerGeometry.dispose();
      connectorPickMarkerMaterial.dispose();
      Object.values(markerMaterials).forEach((material) => material.dispose());
      hoverGizmo.geometry.dispose();
      hoverGizmoMaterial.dispose();
      laptopScreenTexture.dispose();
      laptopBodyMat.dispose();
      laptopScreenMat.dispose();
      powerBodyMat.dispose();
      Object.values(detailMaterials).forEach((material) => material.dispose());
      tooltip.remove();
      renderer.dispose();

      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }

      scene.clear();
    };
  }, []);

  return <div ref={containerRef} className="robot-scene" />;
}
