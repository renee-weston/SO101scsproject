import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import URDFLoader from "urdf-loader";
import { createInitialJointValues, jointConfigs } from "./calibrationConfig";
import type { JointName } from "./calibrationTypes";

type SetupConnectionSceneProps = {
  usbConnected: boolean;
  powerPlugConnected: boolean;
  socketPowerOn: boolean;
  onUsbConnected: () => void;
  onPowerPlugConnected: () => void;
  onPowerSwitch: () => void;
};
type MeshLoadDone = (mesh: THREE.Object3D | null, err?: Error) => void;

const setupModelBaseUrl = "/models/setup-objects";
const followerModelUrl = "/models/so101/so101.urdf";
const setupObjectUrls = {
  laptop: `${setupModelBaseUrl}/Laptop.fbx`,
  board: `${setupModelBaseUrl}/PCB%20Board.fbx`,
  cable: `${setupModelBaseUrl}/USB%20type%20C%20cable.fbx`,
  usbPorts: `${setupModelBaseUrl}/usb-ports/source/Usb.fbx`,
};

const disposeObject = (object: THREE.Object3D) => {
  const disposedMaterials = new Set<THREE.Material>();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;

    if (!mesh.isMesh) {
      return;
    }

    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    materials.forEach((material) => {
      if (material && !disposedMaterials.has(material)) {
        material.dispose();
        disposedMaterials.add(material);
      }
    });
  });
};

const normalizeModel = (
  object: THREE.Object3D,
  targetSize: number,
  material?: THREE.Material,
) => {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const center = box.getCenter(new THREE.Vector3());
  const wrapper = new THREE.Group();

  object.position.sub(center);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;

    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      if (material) {
        mesh.material = material;
      }
    }
  });
  wrapper.add(object);
  wrapper.scale.setScalar(targetSize / maxDimension);

  return wrapper;
};

const createBox = (
  width: number,
  height: number,
  depth: number,
  material: THREE.Material,
) => new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);

const createTopChamferedBox = (
  width: number,
  height: number,
  depth: number,
  chamfer: number,
  material: THREE.Material,
) => {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const cut = Math.min(chamfer, halfWidth, halfHeight);
  const shape = new THREE.Shape();

  shape.moveTo(-halfWidth, -halfHeight);
  shape.lineTo(halfWidth, -halfHeight);
  shape.lineTo(halfWidth, halfHeight - cut);
  shape.lineTo(halfWidth - cut, halfHeight);
  shape.lineTo(-halfWidth + cut, halfHeight);
  shape.lineTo(-halfWidth, halfHeight - cut);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
  });
  geometry.translate(0, 0, -depth / 2);

  return new THREE.Mesh(geometry, material);
};

const materialNames = (material: THREE.Material | THREE.Material[]) =>
  (Array.isArray(material) ? material : [material])
    .map((entry) => entry?.name ?? "")
    .join(" ");

const extractNamedModelPart = (
  object: THREE.Object3D,
  nameFragment: string,
) => {
  const fragment = nameFragment.toLowerCase();
  const materialFragment =
    nameFragment === "Usb_1"
      ? "aistandardsurface1"
      : nameFragment === "Usb_4"
        ? "aistandardsurface4"
        : fragment;
  const selected = new THREE.Group();

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;

    if (!mesh.isMesh) {
      return;
    }

    const searchable = `${mesh.name} ${materialNames(mesh.material)}`.toLowerCase();

    if (
      searchable.includes(fragment.toLowerCase()) ||
      searchable.includes(materialFragment)
    ) {
      const clone = mesh.clone();
      clone.geometry = mesh.geometry.clone();
      clone.applyMatrix4(mesh.matrixWorld);
      selected.add(clone);
    }
  });

  return selected.children.length > 0 ? selected : object;
};

export default function SetupConnectionScene({
  usbConnected,
  powerPlugConnected,
  socketPowerOn,
  onUsbConnected,
  onPowerPlugConnected,
  onPowerSwitch,
}: SetupConnectionSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const usbConnectedRef = useRef(usbConnected);
  const powerPlugConnectedRef = useRef(powerPlugConnected);
  const socketPowerOnRef = useRef(socketPowerOn);
  const onUsbConnectedRef = useRef(onUsbConnected);
  const onPowerPlugConnectedRef = useRef(onPowerPlugConnected);
  const onPowerSwitchRef = useRef(onPowerSwitch);

  useEffect(() => {
    usbConnectedRef.current = usbConnected;
  }, [usbConnected]);

  useEffect(() => {
    powerPlugConnectedRef.current = powerPlugConnected;
  }, [powerPlugConnected]);

  useEffect(() => {
    socketPowerOnRef.current = socketPowerOn;
  }, [socketPowerOn]);

  useEffect(() => {
    onUsbConnectedRef.current = onUsbConnected;
  }, [onUsbConnected]);

  useEffect(() => {
    onPowerPlugConnectedRef.current = onPowerPlugConnected;
  }, [onPowerPlugConnected]);

  useEffect(() => {
    onPowerSwitchRef.current = onPowerSwitch;
  }, [onPowerSwitch]);

  useEffect(() => {
    const mount = mountRef.current;

    if (!mount) {
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let draggingUsb = false;
    let draggingPowerPlug = false;
    let lastUsbConnected = usbConnectedRef.current;
    let lastPowerPlugConnected = powerPlugConnectedRef.current;
    let lastSocketPowerOn = socketPowerOnRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071728);

    const camera = new THREE.PerspectiveCamera(
      35,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100,
    );
    camera.position.set(0, 2.35, 5.2);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 3.2;
    controls.maxDistance = 13;
    controls.zoomToCursor = true;
    controls.target.set(0, -0.23, 0.36);
    controls.update();

    const frameSetupScene = () => {
      const aspect = Math.max(0.65, mount.clientWidth / mount.clientHeight);
      const distance =
        aspect < 0.9
          ? 11.4
          : aspect < 1.05
            ? 9.4
          : aspect < 1.35
            ? 7.2
            : aspect < 1.75
              ? 6.1
              : 5.2;

      camera.fov = aspect < 0.9 ? 52 : aspect < 1.15 ? 46 : 38;
      camera.position.set(0, aspect < 0.9 ? 2.65 : 2.35, distance);
      controls.target.set(0, -0.23, 0.36);
      camera.updateProjectionMatrix();
      controls.update();
    };

    frameSetupScene();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.48);
    const dragIntersection = new THREE.Vector3();
    const setupArmYOffset = -0.52;
    const robotLocalYOffset = -0.15;
    const usbCableAnchorOffset = new THREE.Vector3(0.03, 0, 0);
    const laptopPort = new THREE.Vector3(-1.6,-0.83,-0.2); // left side of laptop
    const laptopCableExit = new THREE.Vector3(-1.45, -0.83, -0.22);  // slightly outside for cable start
    const boardPort = new THREE.Vector3(
      -0.1,
      setupArmYOffset + robotLocalYOffset,
      0.65,
    );
    const usbPlugPoint = new THREE.Vector3(
      -0.23,
      setupArmYOffset + robotLocalYOffset -0.01 ,
      0.65,
    );
    const boardPowerPort = new THREE.Vector3(
      0.1,
       setupArmYOffset + robotLocalYOffset,
      0.65,
    );
    const powerScale = 0.5;
    const typeGSocketCenter = new THREE.Vector3(1.72, -0.12, 0.49);
    const typeGEarthOffset = new THREE.Vector2(0, 0.14 * powerScale);
    const typeGLiveOffset = new THREE.Vector2(-0.13 * powerScale, -0.14 * powerScale);
    const typeGNeutralOffset = new THREE.Vector2(0.13 * powerScale, -0.14 * powerScale);
    const typeGEarthSize: [number, number] = [
      0.055 * powerScale,
      0.208 * powerScale,
    ];
    const typeGBladeSize: [number, number] = [
      0.15 * powerScale,
      0.055 * powerScale,
    ];
    const socketSlotDepth = 0.01;
    const socketPlugHome = new THREE.Vector3(1.12, -0.63, 0.72);
    const socketPlugPoint = new THREE.Vector3(
      typeGSocketCenter.x,
      typeGSocketCenter.y,
      0.545,
    );
    const cableHome = new THREE.Vector3(-0.8, -0.67, 0.65);

    const neutralMaterial = new THREE.MeshStandardMaterial({
      color: 0xf4f7fb,
      roughness: 0.72,
    });
    const robotShellMaterial = new THREE.MeshStandardMaterial({
      color: 0xf4f4f4,
      roughness: 0.72,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.8,
    });
    const boardMaterial = new THREE.MeshStandardMaterial({
      color: 0x175c40,
      roughness: 0.7,
    });
    const metalMaterial = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      metalness: 0.45,
      roughness: 0.28,
    });
    const redMaterial = new THREE.MeshStandardMaterial({
      color: 0xb91c1c,
      roughness: 0.44,
    });
    const redOnMaterial = new THREE.MeshStandardMaterial({
      color: 0xff3333,
      emissive: 0x6f0000,
      emissiveIntensity: 0.55,
      roughness: 0.38,
    });
    const cableMaterial = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      roughness: 0.58,
    });
    const hitTargetMaterial = new THREE.MeshBasicMaterial({
      color: 0x5ce19d,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });

    scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x0b1725, 2.7));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2, 4, 4);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const fillLight = new THREE.PointLight(0xffcf92, 1.2, 7);
    fillLight.position.set(-2, 1.8, 2.4);
    scene.add(fillLight);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 3.3),
      new THREE.MeshStandardMaterial({
        color: 0x0f2436,
        roughness: 0.92,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.92;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(6.4, 16, 0x33506a, 0x1e354d);
    grid.position.y = -0.91;
    scene.add(grid);

    const followerGroup = new THREE.Group();
    followerGroup.position.set(0, -0.18 + setupArmYOffset, 0.02);
    scene.add(followerGroup);

    const fallbackArmGroup = new THREE.Group();
    followerGroup.add(fallbackArmGroup);

    const base = createBox(0.9, 0.18, 0.48, neutralMaterial);
    base.position.set(-0.04, -0.67, 0.02);
    base.castShadow = true;
    fallbackArmGroup.add(base);

    const rearPlate = createBox(0.76, 1.08, 0.22, neutralMaterial);
    rearPlate.position.set(-0.1, -0.13, 0.08);
    rearPlate.castShadow = true;
    fallbackArmGroup.add(rearPlate);

    const motor = createBox(0.38, 0.42, 0.3, darkMaterial);
    motor.position.set(0.2, 0.02, 0.26);
    motor.castShadow = true;
    fallbackArmGroup.add(motor);

    const upperLink = createBox(0.22, 0.9, 0.22, neutralMaterial);
    upperLink.position.set(0.17, 0.62, 0.16);
    upperLink.rotation.z = -0.55;
    upperLink.castShadow = true;
    fallbackArmGroup.add(upperLink);

    fallbackArmGroup.add(
      new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.55, 0.28, 0.34),
            new THREE.Vector3(-0.08, 0.36, 0.48),
            new THREE.Vector3(0.4, 0.26, 0.38),
          ]),
          24,
          0.0055,
          6,
        ),
        new THREE.MeshStandardMaterial({ color: 0xd43b3b, roughness: 0.5 }),
      ),
    );
    fallbackArmGroup.add(
      new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.55, 0.16, 0.31),
            new THREE.Vector3(-0.02, 0.23, 0.44),
            new THREE.Vector3(0.45, 0.12, 0.34),
          ]),
          24,
          0.0055,
          6,
        ),
        cableMaterial,
      ),
    );

    const fbxLoader = new FBXLoader();
    const urdfLoader = new URDFLoader();
    urdfLoader.parseVisual = true;
    urdfLoader.parseCollision = false;
    urdfLoader.loadMeshCb = ((
      path: string,
      manager: THREE.LoadingManager,
      materialOrDone: THREE.Material | MeshLoadDone,
      maybeDone?: MeshLoadDone,
    ) => {
      const done =
        typeof materialOrDone === "function" ? materialOrDone : maybeDone;
      const material = robotShellMaterial;

      if (!done) {
        return;
      }

      if (!path.toLowerCase().endsWith(".stl")) {
        done(null, new Error(`Unsupported setup mesh type: ${path}`));
        return;
      }

      new STLLoader(manager).load(
        path,
        (geometry) => {
          geometry.computeVertexNormals();
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          done(mesh);
        },
        undefined,
        (error) => {
          done(
            null,
            error instanceof Error
              ? error
              : new Error(`Failed to load setup mesh ${path}`),
          );
        },
      );
    }) as unknown as URDFLoader["loadMeshCb"];

    urdfLoader.load(
      followerModelUrl,
      (robot) => {
        if (disposed) {
          disposeObject(robot);
          return;
        }

        const initialValues = createInitialJointValues();
        Object.entries(initialValues).forEach(([jointName, value]) => {
          const config = jointConfigs[jointName as JointName];
          const joint = robot.joints[config.urdfJointName];

          if (joint) {
            robot.setJointValue(config.urdfJointName, THREE.MathUtils.degToRad(value));
          }
        });

        robot.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            object.material = new THREE.MeshStandardMaterial({
              color: 0xf4f4f4,
              roughness: 0.72,
              metalness: 0.05,
              side: THREE.DoubleSide,
            });
          }
        });

        robot.rotation.set(-Math.PI / 2, Math.PI / 2, Math.PI); // X, Y, Z in radians
        const robotWrapper = normalizeModel(robot as unknown as THREE.Object3D, 2.8);
        robotWrapper.scale.setScalar(3.5); // Uniformly scale 1.5x
        robotWrapper.position.set(0, robotLocalYOffset, 0.48);
        robotWrapper.rotation.set(0, -Math.PI / 2, Math.PI / 2);
        fallbackArmGroup.visible = false;
        followerGroup.add(robotWrapper);
      },
      undefined,
      () => {
        fallbackArmGroup.visible = true;
      },
    );
    const fallbackBoard = createBox(0.76, 0.48, 0.08, boardMaterial);
    fallbackBoard.position.set(0, 0.17 + robotLocalYOffset, 0.62);
    fallbackBoard.castShadow = true;
    followerGroup.add(fallbackBoard);

    fbxLoader.load(
      setupObjectUrls.board,
      (object) => {
        if (disposed) {
          disposeObject(object);
          return;
        }

        const board = normalizeModel(object, 0.18, boardMaterial);
        board.position.copy(fallbackBoard.position);
        board.rotation.set(Math.PI / 2, Math.PI / 2, 0);
        fallbackBoard.visible = false;
        followerGroup.add(board);
      },
      undefined,
      () => {
        fallbackBoard.visible = true;
      },
    );

    const boardPortMesh = createBox(0.06, 0.05, 0.02, metalMaterial);
    boardPortMesh.name = "Usb_4";
    boardPortMesh.position.copy(boardPort);
    scene.add(boardPortMesh);

    fbxLoader.load(
      setupObjectUrls.laptop,
      (object) => {
        if (disposed) {
          disposeObject(object);
          return;
        }

        const laptop = normalizeModel(object, 1.05);
        laptop.position.set(-2.03, -0.48, 0.05);
        laptop.rotation.set(-0.08, 0.32, 0);
        scene.add(laptop);
      },
      undefined,
      () => {
        const laptop = new THREE.Group();
        const keyboard = createBox(0.88, 0.07, 0.58, darkMaterial);
        const screen = createBox(0.82, 0.58, 0.06, darkMaterial);
        keyboard.position.y = -0.58;
        screen.position.set(0, -0.22, -0.28);
        screen.rotation.x = -1.1;
        laptop.add(keyboard, screen);
        laptop.position.set(-2.03, 0, 0.24);
        scene.add(laptop);
      },
    );

    const loadUsbModelPart = (
      partName: "Usb_1" | "Usb_4",
      position: THREE.Vector3,
      rotation: THREE.Euler,
      targetSize: number,
      fallback: THREE.Object3D,
      parent: THREE.Object3D,
    ) => {
      fbxLoader.load(
        setupObjectUrls.usbPorts,
        (object) => {
          if (disposed) {
            disposeObject(object);
            return;
          }

          const portModel = normalizeModel(
            extractNamedModelPart(object, partName),
            targetSize,
          );
          portModel.name = partName;
          portModel.position.copy(position);
          portModel.rotation.copy(rotation);
          fallback.visible = false;
          parent.add(portModel);
        },
        undefined,
        () => {
          fallback.visible = true;
        },
      );
    };

    const laptopUsbPlugGroup = new THREE.Group();
    laptopUsbPlugGroup.position.copy(laptopPort);
    scene.add(laptopUsbPlugGroup);

    const fallbackLaptopUsbPlug = new THREE.Group();
    const laptopUsbBody = createBox(0.192, 0.104, 0.096, neutralMaterial);
    const laptopUsbMetal = createBox(0.096, 0.072, 0.064, metalMaterial);
    laptopUsbBody.position.x = 0.096;
    laptopUsbMetal.position.x = -0.064;
    fallbackLaptopUsbPlug.add(laptopUsbBody, laptopUsbMetal);
    laptopUsbPlugGroup.add(fallbackLaptopUsbPlug);

    loadUsbModelPart(
      "Usb_1",
      new THREE.Vector3(0.08, 0, 0),
      new THREE.Euler(0, -Math.PI/2+0.3, 0),
      0.16,
      fallbackLaptopUsbPlug,
      laptopUsbPlugGroup,
    );

    const socketPanel = createBox(
      0.72 * powerScale,
      0.82 * powerScale,
      0.09 * powerScale,
      neutralMaterial,
    );
    socketPanel.position.set(1.76, -0.1, 0.46);
    socketPanel.castShadow = true;
    scene.add(socketPanel);

    const earthSlot = createBox(
      typeGEarthSize[0],
      typeGEarthSize[1],
      socketSlotDepth,
      darkMaterial,
    );
    earthSlot.position.set(
      typeGSocketCenter.x + typeGEarthOffset.x,
      typeGSocketCenter.y + typeGEarthOffset.y,
      typeGSocketCenter.z,
    );
    scene.add(earthSlot);

    const liveSlot = createBox(
      typeGBladeSize[0],
      typeGBladeSize[1],
      socketSlotDepth,
      darkMaterial,
    );
    liveSlot.position.set(
      typeGSocketCenter.x + typeGLiveOffset.x,
      typeGSocketCenter.y + typeGLiveOffset.y,
      typeGSocketCenter.z,
    );
    scene.add(liveSlot);

    const neutralSlot = createBox(
      typeGBladeSize[0],
      typeGBladeSize[1],
      socketSlotDepth,
      darkMaterial,
    );
    neutralSlot.position.set(
      typeGSocketCenter.x + typeGNeutralOffset.x,
      typeGSocketCenter.y + typeGNeutralOffset.y,
      typeGSocketCenter.z,
    );
    scene.add(neutralSlot);

    const switchMesh = createBox(
      0.14 * powerScale,
      0.22 * powerScale,
      0.09 * powerScale,
      redMaterial,
    );
    switchMesh.position.set(
      socketPanel.position.x + 0.16 * powerScale,
      socketPanel.position.y + 0.18 * powerScale,
      socketPanel.position.z + 0.09 * powerScale,
    );
    switchMesh.userData.connectionAction = "powerSwitch";
    scene.add(switchMesh);

    const switchHitTarget = createBox(
      0.58 * powerScale,
      0.48 * powerScale,
      0.22 * powerScale,
      hitTargetMaterial,
    );
    switchHitTarget.position.copy(switchMesh.position);
    switchHitTarget.userData.connectionAction = "powerSwitch";
    scene.add(switchHitTarget);

    const usbPlugGroup = new THREE.Group();
    usbPlugGroup.position.copy(cableHome);
    usbPlugGroup.userData.connectionAction = "usb";
    scene.add(usbPlugGroup);

    const fallbackUsbPlug = new THREE.Group();
    const plugBody = createBox(0.28, 0.16, 0.16, neutralMaterial);
    const plugTip = createBox(0.16, 0.1, 0.09, metalMaterial);
    plugTip.position.x = 0.2;
    fallbackUsbPlug.add(plugBody, plugTip);
    usbPlugGroup.add(fallbackUsbPlug);

    loadUsbModelPart(
      "Usb_4",
      new THREE.Vector3(0.08, 0, 0),
      new THREE.Euler(0, Math.PI / 2, Math.PI / 2),
      0.11,
      fallbackUsbPlug,
      usbPlugGroup,
    );

    const usbHitTarget = new THREE.Mesh(
      new THREE.SphereGeometry(0.27, 16, 16),
      hitTargetMaterial,
    );
    usbHitTarget.userData.connectionAction = "usb";
    usbPlugGroup.add(usbHitTarget);

    const usbCableMesh = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([laptopCableExit, cableHome]),
        32,
        0.0125,
        8,
      ),
      cableMaterial,
    );
    scene.add(usbCableMesh);

    const powerBoardPlug = createBox(0.05, 0.06, 0.02, neutralMaterial);
    powerBoardPlug.position.copy(boardPowerPort);
    scene.add(powerBoardPlug);

    const powerPlugGroup = new THREE.Group();
    powerPlugGroup.position.copy(socketPlugHome);
    powerPlugGroup.userData.connectionAction = "powerPlug";
    scene.add(powerPlugGroup);

    const powerPlugBody = createTopChamferedBox(
      0.44 * powerScale,
      0.52 * powerScale,
      0.24 * powerScale,
      0.1 * powerScale,
      neutralMaterial,
    );
    powerPlugBody.castShadow = true;
    powerPlugGroup.add(powerPlugBody);

    const powerProngEarth = createBox(
      typeGEarthSize[0],
      typeGEarthSize[1],
      0.24 * powerScale,
      metalMaterial,
    );
    powerProngEarth.position.set(
      typeGEarthOffset.x,
      typeGEarthOffset.y,
      -0.24 * powerScale,
    );
    powerPlugGroup.add(powerProngEarth);

    const powerProngLive = createBox(
      typeGBladeSize[0],
      typeGBladeSize[1],
      0.24 * powerScale,
      metalMaterial,
    );
    powerProngLive.position.set(
      typeGLiveOffset.x,
      typeGLiveOffset.y,
      -0.24 * powerScale,
    );
    powerPlugGroup.add(powerProngLive);

    const powerProngNeutral = createBox(
      typeGBladeSize[0],
      typeGBladeSize[1],
      0.24 * powerScale,
      metalMaterial,
    );
    powerProngNeutral.position.set(
      typeGNeutralOffset.x,
      typeGNeutralOffset.y,
      -0.24 * powerScale,
    );
    powerPlugGroup.add(powerProngNeutral);

    const powerProngs = [
      powerProngEarth,
      powerProngLive,
      powerProngNeutral,
    ];
    const setPowerProngsVisible = (visible: boolean) => {
      powerProngs.forEach((prong) => {
        prong.visible = visible;
      });
    };
    setPowerProngsVisible(!powerPlugConnectedRef.current);

    const powerHitTarget = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 16, 16),
      hitTargetMaterial,
    );
    powerHitTarget.userData.connectionAction = "powerPlug";
    powerPlugGroup.add(powerHitTarget);

    const powerCableMesh = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          boardPowerPort,
          new THREE.Vector3(0.92, -0.82, 0.5),
          powerPlugGroup.position.clone(),
        ]),
        42,
        0.015,
        8,
      ),
      cableMaterial,
    );
    scene.add(powerCableMesh);

    const updatePointer = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();

      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    const updateUsbCable = () => {
      const usbCableEnd = usbPlugGroup.localToWorld(usbCableAnchorOffset.clone());

      usbCableMesh.geometry.dispose();
      usbCableMesh.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          laptopCableExit,
          new THREE.Vector3(-1, -0.8, 0.12),
          usbCableEnd,
        ]),
        42,
        0.0125,
        8,
      );
    };

    const updatePowerCable = () => {
      powerCableMesh.geometry.dispose();
      powerCableMesh.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          boardPowerPort,
          new THREE.Vector3(0.92, -0.82, 0.5),
          powerPlugGroup.position.clone(),
        ]),
        42,
        0.015,
        8,
      );
    };

    const snapUsbConnected = () => {
      usbPlugGroup.position.copy(usbPlugPoint);
      usbPlugGroup.rotation.set(0, 0, 0);
      updateUsbCable();
      onUsbConnectedRef.current();
    };

    const snapPowerPlugConnected = () => {
      powerPlugGroup.position.copy(socketPlugPoint);
      powerPlugGroup.rotation.set(0, 0, 0);
      setPowerProngsVisible(false);
      updatePowerCable();
      onPowerPlugConnectedRef.current();
    };

    const syncVisualState = () => {
      if (usbConnectedRef.current && !lastUsbConnected) {
        usbPlugGroup.position.copy(usbPlugPoint);
        usbPlugGroup.rotation.z = 0.08;
        updateUsbCable();
      }

      if (powerPlugConnectedRef.current && !lastPowerPlugConnected) {
        powerPlugGroup.position.copy(socketPlugPoint);
        powerPlugGroup.rotation.set(0, 0, 0);
        setPowerProngsVisible(false);
        updatePowerCable();
      }

      if (socketPowerOnRef.current !== lastSocketPowerOn) {
        switchMesh.material = socketPowerOnRef.current ? redOnMaterial : redMaterial;
      }

      lastUsbConnected = usbConnectedRef.current;
      lastPowerPlugConnected = powerPlugConnectedRef.current;
      lastSocketPowerOn = socketPowerOnRef.current;
    };

    const findConnectionAction = (object: THREE.Object3D | null) => {
      let current: THREE.Object3D | null = object;

      while (current) {
        if (typeof current.userData.connectionAction === "string") {
          return current.userData.connectionAction as
            | "usb"
            | "powerPlug"
            | "powerSwitch";
        }

        current = current.parent;
      }

      return null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      updatePointer(event);

      const switchHits = raycaster.intersectObjects(
        [switchMesh, switchHitTarget],
        true,
      );
      const hits = raycaster.intersectObjects(
        [usbPlugGroup, powerPlugGroup],
        true,
      );
      const action =
        switchHits.map((hit) => findConnectionAction(hit.object)).find(Boolean) ??
        hits.map((hit) => findConnectionAction(hit.object)).find(Boolean) ??
        null;

      if (action === "usb" && !usbConnectedRef.current) {
        draggingUsb = true;
        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = "grabbing";
        event.preventDefault();
      }

      if (action === "powerPlug" && !powerPlugConnectedRef.current) {
        draggingPowerPlug = true;
        setPowerProngsVisible(true);
        controls.enabled = false;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = "grabbing";
        event.preventDefault();
      }

      if (action === "powerSwitch") {
        onPowerSwitchRef.current();
        event.preventDefault();
      }

    };

    const handlePointerMove = (event: PointerEvent) => {
      updatePointer(event);

      if (!draggingUsb && !draggingPowerPlug) {
        const hoverHits = raycaster.intersectObjects(
          [switchMesh, switchHitTarget, usbPlugGroup, powerPlugGroup],
          true,
        );
        renderer.domElement.style.cursor = hoverHits.length ? "pointer" : "grab";
        return;
      }

      if (draggingUsb && raycaster.ray.intersectPlane(dragPlane, dragIntersection)) {
        usbPlugGroup.position.set(
          THREE.MathUtils.clamp(dragIntersection.x, -1.8, 0.45),
          THREE.MathUtils.clamp(dragIntersection.y, -0.92, 0.28),
          usbPlugPoint.z,
        );
        updateUsbCable();
      }

      if (
        draggingPowerPlug &&
        raycaster.ray.intersectPlane(dragPlane, dragIntersection)
      ) {
        powerPlugGroup.position.set(
          THREE.MathUtils.clamp(dragIntersection.x, 0.86, 1.72),
          THREE.MathUtils.clamp(dragIntersection.y, -0.78, 0.02),
          socketPlugHome.z,
        );
        updatePowerCable();
      }

    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!draggingUsb && !draggingPowerPlug) {
        return;
      }

      renderer.domElement.releasePointerCapture(event.pointerId);
      renderer.domElement.style.cursor = "grab";

      if (draggingUsb) {
        draggingUsb = false;
        controls.enabled = true;

        if (usbPlugGroup.position.distanceTo(usbPlugPoint) < 0.16) {
          snapUsbConnected();
          return;
        }

        usbPlugGroup.position.copy(cableHome);
        usbPlugGroup.rotation.set(0, 0, 0);
        updateUsbCable();
        return;
      }

      draggingPowerPlug = false;
      controls.enabled = true;

      if (powerPlugGroup.position.distanceTo(socketPlugPoint) < 0.36) {
        snapPowerPlugConnected();
        return;
      }

      powerPlugGroup.position.copy(socketPlugHome);
      powerPlugGroup.rotation.set(0, 0, 0);
      setPowerProngsVisible(true);
      updatePowerCable();
    };

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;

      camera.aspect = width / height;
      renderer.setSize(width, height);
      frameSetupScene();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointercancel", handlePointerUp);

    const animate = () => {
      syncVisualState();
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };

    updateUsbCable();
    updatePowerCable();
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointercancel", handlePointerUp);
      controls.dispose();

      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }

      renderer.dispose();
      disposeObject(scene);
    };
  }, []);

  return (
    <div className="connection-model-viewport">
      <div ref={mountRef} className="connection-model-canvas" />
    </div>
  );
}
