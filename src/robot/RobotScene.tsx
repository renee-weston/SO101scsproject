import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
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
  selectableJoints?: JointName[];
  onJointSelect?: (jointName: JointName) => void;
  onJointValueChange?: (jointName: JointName, value: number) => void;
  onLeaderJointSelect?: (jointName: JointName) => void;
  onLeaderJointValueChange?: (jointName: JointName, value: number) => void;
};

type MeshLoadDone = (mesh: THREE.Object3D | null, err?: Error) => void;
type CableAnchor = {
  object: THREE.Object3D;
  localPosition: THREE.Vector3;
};
type DynamicCable = {
  anchors: CableAnchor[];
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.Material>;
  owner: "follower" | "leader";
  radius: number;
};

const modelUrl = "/models/so101/so101.urdf";
const leaderModelUrl = "/models/so101-leader/so101_leader.urdf";
const minimumRobotDimension = 0.2;
const renderSmoothingAlpha = 0.22;
const directManipulationJumpThreshold = 45;
const dualArmTeleoperationSpacing = 0.7;

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
  selectableJoints = [],
  onJointSelect,
  onJointValueChange,
  onLeaderJointSelect,
  onLeaderJointValueChange,
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
  const selectableJointsRef = useRef(selectableJoints);
  const onJointSelectRef = useRef(onJointSelect);
  const onJointValueChangeRef = useRef(onJointValueChange);
  const onLeaderJointSelectRef = useRef(onLeaderJointSelect);
  const onLeaderJointValueChangeRef = useRef(onLeaderJointValueChange);
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
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
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
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
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
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(4, 20, 0xff9d2e, 0x1d4b7a);
    grid.position.y = 0.002;
    scene.add(grid);

    const robotDetails = new THREE.Group();
    scene.add(robotDetails);
    const accessoryRoots: THREE.Object3D[] = [];
    let dynamicCables: DynamicCable[] = [];

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
      usbCable: new THREE.MeshStandardMaterial({
        color: 0x1f2937,
        roughness: 0.4,
        metalness: 0.12,
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

    const calibrationMarkerGroup = new THREE.Group();
    calibrationMarkerGroup.name = "calibration_live_overlay";
    scene.add(calibrationMarkerGroup);

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
    loadingMarker.castShadow = true;
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
          object.castShadow = true;
          object.receiveShadow = true;

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

        const nextMaterial = Array.isArray(object.material)
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
      accessoryRoots.forEach((root) => {
        disposeObject(root);
        root.removeFromParent();
      });
      accessoryRoots.length = 0;
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

      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.robotAccessory = true;
      parent.add(mesh);

      return mesh;
    };

    const addScrewDetail = (
      parent: THREE.Object3D,
      position: THREE.Vector3,
    ) => {
      const screw = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.01, 0.006, 16),
        detailMaterials.metal,
      );
      screw.position.copy(position);
      screw.rotation.x = Math.PI / 2;
      screw.castShadow = true;
      screw.userData.robotAccessory = true;
      parent.add(screw);
    };

    const addDynamicCable = (
      anchors: CableAnchor[],
      material: THREE.Material,
      owner: "follower" | "leader",
      radius = 0.006,
    ) => {
      const points = anchors.map((anchor) =>
        anchor.object.localToWorld(anchor.localPosition.clone()),
      );
      const curve = new THREE.CatmullRomCurve3(points);
      const cable = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 28, radius, 8, false),
        material,
      );
      cable.castShadow = true;
      cable.visible = owner === "follower" || showLeaderArmRef.current;
      cable.userData.robotAccessory = true;
      cable.userData.armRole = owner;
      scene.add(cable);
      dynamicCables.push({ anchors, mesh: cable, owner, radius });
    };

    const updateDynamicCables = () => {
      dynamicCables.forEach((cable) => {
        cable.mesh.visible =
          cable.owner === "follower" || showLeaderArmRef.current;

        const points = cable.anchors.map((anchor) =>
          anchor.object.localToWorld(anchor.localPosition.clone()),
        );
        const curve = new THREE.CatmullRomCurve3(points);
        const nextGeometry = new THREE.TubeGeometry(
          curve,
          28,
          cable.radius,
          8,
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
      const accessoryMotorScale = 0.9;
      const motorAnchors = {} as Record<
        JointName,
        {
          group: THREE.Object3D;
          red: CableAnchor;
          black: CableAnchor;
        }
      >;

      const baseLink = robot.links.base_link;

      if (!baseLink) {
        return;
      }

      let boardRedAnchor: THREE.Object3D | null = null;
      let boardBlackAnchor: THREE.Object3D | null = null;

      if (options.includeBoard) {
        const boardScale = 0.5;
        const boardGroup = new THREE.Group();
        boardGroup.name = "so101_controller_board";
        boardGroup.userData.robotAccessory = true;
        boardGroup.userData.armRole = options.owner;
        boardGroup.position.set(-0.032, 0, 0.05);
        boardGroup.rotation.set(0, Math.PI/2, Math.PI/2);
        baseLink.add(boardGroup);
        accessoryRoots.push(boardGroup);

        addBoxDetail(
          boardGroup,
          new THREE.Vector3(),
          [0.105 * boardScale, 0.07 * boardScale, 0.006 * boardScale],
          detailMaterials.board,
        );
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

        boardRedAnchor = createAnchorObject(
          boardGroup,
          new THREE.Vector3(0.045 * boardScale, 0.034 * boardScale, 0.011 * boardScale),
          "controller_red_port",
        );
        boardBlackAnchor = createAnchorObject(
          boardGroup,
          new THREE.Vector3(0.03 * boardScale, 0.034 * boardScale, 0.011 * boardScale),
          "controller_black_port",
        );
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
        motorGroup.position.copy(pose.position);
        motorGroup.rotation.copy(pose.rotation);
        motorGroup.scale.setScalar(accessoryMotorScale);
        link.add(motorGroup);
        accessoryRoots.push(motorGroup);

        const lateralOffset = index % 2 === 0 ? 0.006 : -0.006;

        addBoxDetail(
          motorGroup,
          new THREE.Vector3(lateralOffset, 0, 0),
          [0.046, 0.03, 0.036],
          detailMaterials.servo,
        );
        addBoxDetail(
          motorGroup,
          new THREE.Vector3(lateralOffset, 0.021, 0.018),
          [0.02, 0.007, 0.014],
          detailMaterials.metal,
        );

        addScrewDetail(motorGroup, new THREE.Vector3(0.016, 0.02, 0.012));
        addScrewDetail(motorGroup, new THREE.Vector3(-0.016, 0.02, -0.012));

        motorAnchors[key] = {
          group: motorGroup,
          red: {
            object: motorGroup,
            localPosition: new THREE.Vector3(0.021, 0.026, 0.014),
          },
          black: {
            object: motorGroup,
            localPosition: new THREE.Vector3(-0.019, 0.025, -0.013),
          },
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

      if (boardRedAnchor && boardBlackAnchor) {
        addDynamicCable(
          [
            { object: boardRedAnchor, localPosition: new THREE.Vector3() },
            ...cablePath.map((jointName) => motorAnchors[jointName].red),
          ],
          detailMaterials.redWire,
          options.owner,
        );
        addDynamicCable(
          [
            { object: boardBlackAnchor, localPosition: new THREE.Vector3() },
            ...cablePath.map((jointName) => motorAnchors[jointName].black),
          ],
          detailMaterials.blackWire,
          options.owner,
        );
      } else {
        addDynamicCable(
          cablePath.map((jointName) => motorAnchors[jointName].red),
          detailMaterials.redWire,
          options.owner,
        );
        addDynamicCable(
          cablePath.map((jointName) => motorAnchors[jointName].black),
          detailMaterials.blackWire,
          options.owner,
        );
      }

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
      if (!directControlEnabledRef.current || dragState) {
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
      if (
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
      renderer.domElement.style.cursor = "grabbing";
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
        ? "grab"
        : "";
      controls.enabled = !embeddedRef.current;
      dragState = null;
    };

    const updateCursor = () => {
      if (dragState) {
        return;
      }

      if (lastHoveredJoint) {
        renderer.domElement.style.cursor = "pointer";
        return;
      }

      renderer.domElement.style.cursor = directControlEnabledRef.current
        ? "grab"
        : "";
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

    const animate = () => {
      if (scene.children.includes(loadingMarker)) {
        loadingMarker.rotation.x += 0.01;
        loadingMarker.rotation.y += 0.015;
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
        updateDynamicCables();
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
          applyJointHighlight(
            robot,
            highlightedJointRef.current,
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
      }

      updateCursor();

      controls.update();
      renderer.render(scene, camera);
      animationFrameId = window.requestAnimationFrame(animate);
    };

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

    return () => {
      isMounted = false;

      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
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
      Object.values(markerMaterials).forEach((material) => material.dispose());
      hoverGizmo.geometry.dispose();
      hoverGizmoMaterial.dispose();
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
