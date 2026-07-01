import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import MissionSelector from "./components/MissionSelector";
import MotorSetupMission from "./game/MotorSetupMission";
import TeleoperationMission from "./game/TeleoperationMission";
import UsbIdentificationMission from "./game/UsbIdentificationMission";
import CalibrationGame from "./game/calibration/CalibrationGame";
import {
  createInitialJointValues,
  createRandomCalibrationPose,
  jointConfigs,
  jointOrder,
} from "./game/calibration/calibrationConfig";
import type {
  JointName,
  JointValues,
} from "./game/calibration/calibrationTypes";
import RobotScene, {
  type ConnectorAdjust,
  type ConnectorKey,
} from "./robot/RobotScene";

const DEFAULT_ADJUST: ConnectorAdjust = {
  px: 0,
  py: -0.004, // −4.0 mm default (slider is mm)
  pz: 0,
  rx: -180, // default flip about the connector's local X
  ry: 0,
  rz: 0,
};
const CONNECTOR_ADJUST_KEY = "so101.connectorAdjusts";

const loadConnectorAdjusts = (): Record<string, ConnectorAdjust> => {
  try {
    const saved = localStorage.getItem(CONNECTOR_ADJUST_KEY);
    return saved ? (JSON.parse(saved) as Record<string, ConnectorAdjust>) : {};
  } catch {
    return {};
  }
};

import "./App.css";

const confettiPieces = Array.from({ length: 70 }, (_, index) => ({
  id: index,
  left: `${(index * 37) % 100}%`,
  delay: `${-((index * 0.17) % 4.2)}s`,
  duration: `${3.2 + (index % 7) * 0.28}s`,
  color: ["#ffffff", "#ffe76a", "#ff4242", "#2f80ff", "#ffb703"][
    index % 5
  ],
  shape: index % 3 === 0 ? "circle" : index % 3 === 1 ? "strip" : "square",
}));

type JointControlMapping = {
  scale: number;
  offset: number;
  invert: boolean;
  minAngle: number;
  maxAngle: number;
};

type MotorSetupTarget = "follower" | "leader";
type SelectedSetupMotor = {
  target: MotorSetupTarget;
  jointName: JointName;
} | null;
type MotorSetupProgress = Record<MotorSetupTarget, JointName[]>;

const requiredStagesBeforeGraduation = [1, 2, 3] as const;
const allTrainingStages = [1, 2, 3, 4] as const;

const jointControlMappings = jointOrder.reduce((mappings, jointName) => {
  const config = jointConfigs[jointName];

  mappings[jointName] = {
    scale: 1,
    offset: 0,
    invert: false,
    minAngle: config.min,
    maxAngle: config.max,
  };

  return mappings;
}, {} as Record<JointName, JointControlMapping>);

const controlSmoothingAlpha = 0.18;
const antiFlipThresholdDegrees = 45;

const clampAngle = (
  value: number,
  mapping: JointControlMapping,
) => Math.min(mapping.maxAngle, Math.max(mapping.minAngle, value));

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

const mapRawJointInput = (jointName: JointName, rawValue: number) => {
  const mapping = jointControlMappings[jointName];
  const signedValue = mapping.invert ? -rawValue : rawValue;

  return clampAngle(signedValue * mapping.scale + mapping.offset, mapping);
};

const resolveStableJointInput = (
  source: string,
  jointName: JointName,
  currentValue: number,
  previousTargetValue: number,
  rawValue: number,
) => {
  const mapping = jointControlMappings[jointName];
  const mappedTarget = mapRawJointInput(jointName, rawValue);
  const targetDelta = shortestAngleDelta(previousTargetValue, mappedTarget);

  if (Math.abs(targetDelta) > antiFlipThresholdDegrees) {
    console.debug("[teleop-control]", {
      source,
      jointName,
      rawInputValue: rawValue,
      mappedTargetAngle: mappedTarget,
      finalAppliedAngle: currentValue,
      deltaChange: targetDelta,
      rejected: true,
      reason: "anti-flip threshold",
    });

    return {
      targetAngle: previousTargetValue,
      finalAppliedAngle: currentValue,
    };
  }

  const appliedDelta = shortestAngleDelta(currentValue, mappedTarget);
  const finalAppliedAngle = clampAngle(
    Math.abs(appliedDelta) < 0.15
      ? mappedTarget
      : currentValue + appliedDelta * controlSmoothingAlpha,
    mapping,
  );

  console.debug("[teleop-control]", {
    source,
    jointName,
    rawInputValue: rawValue,
    mappedTargetAngle: mappedTarget,
    finalAppliedAngle,
    deltaChange: finalAppliedAngle - currentValue,
    rejected: false,
  });

  return { targetAngle: mappedTarget, finalAppliedAngle };
};

function App() {
  const [currentMission, setCurrentMission] = useState(1);
  const [completedMissions, setCompletedMissions] = useState<number[]>([]);
  const [robotActivated, setRobotActivated] = useState(false);
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [jointValues, setJointValues] = useState<JointValues>(
    createRandomCalibrationPose,
  );
  const [leaderJointValues, setLeaderJointValues] = useState<JointValues>(
    createInitialJointValues,
  );
  const jointValuesRef = useRef(jointValues);
  const leaderJointValuesRef = useRef(leaderJointValues);
  const jointTargetValuesRef = useRef(jointValues);
  const leaderTargetValuesRef = useRef(leaderJointValues);
  const [highlightedJoint, setHighlightedJoint] =
    useState<JointName | null>(null);
  const [highlightedLeaderJoint, setHighlightedLeaderJoint] =
    useState<JointName | null>(null);
  const [selectableJoints, setSelectableJoints] = useState<JointName[]>(
    [],
  );
  const [calibrationTargetArm, setCalibrationTargetArm] = useState<
    "follower" | "leader"
  >("follower");
  const [teleoperationActive, setTeleoperationActive] = useState(false);
  const [demonstratedTeleopJoints, setDemonstratedTeleopJoints] = useState<
    JointName[]
  >([]);
  const [showTeleopTutorialOnMount, setShowTeleopTutorialOnMount] =
    useState(true);
  const [calibrationSetupActive, setCalibrationSetupActive] = useState(false);
  const [connectorAdjusts, setConnectorAdjusts] = useState<
    Record<string, ConnectorAdjust>
  >(loadConnectorAdjusts);
  const [motorSetupTarget, setMotorSetupTarget] =
    useState<MotorSetupTarget>("follower");
  const [selectedSetupMotor, setSelectedSetupMotor] =
    useState<SelectedSetupMotor>(null);
  const [motorSetupConfiguredJoints, setMotorSetupConfiguredJoints] =
    useState<MotorSetupProgress>({ follower: [], leader: [] });
  const [motorSetupConnectedJoint, setMotorSetupConnectedJoint] =
    useState<JointName | null>(null);
  const [motorSetupChained, setMotorSetupChained] = useState(false);
  const [usbConnections, setUsbConnections] = useState<{
    follower: boolean;
    leader: boolean;
  }>({ follower: false, leader: false });
  const [usbActiveArm, setUsbActiveArm] = useState<
    "follower" | "leader" | null
  >(null);
  const missingGraduationStages = requiredStagesBeforeGraduation.filter(
    (mission) => !completedMissions.includes(mission),
  );
  const allStagesComplete = allTrainingStages.every((mission) =>
    completedMissions.includes(mission),
  );

  useEffect(() => {
    try {
      localStorage.setItem(
        CONNECTOR_ADJUST_KEY,
        JSON.stringify(connectorAdjusts),
      );
    } catch {
      // ignore persistence failures (e.g. storage disabled)
    }
  }, [connectorAdjusts]);

  const handleConnectorsChange = useCallback((ids: ConnectorKey[]) => {
    // Seed any connector without a saved adjust with the default so the default
    // offset (e.g. py = -4mm) is actually applied, not just shown on the slider.
    setConnectorAdjusts((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of ids) {
        if (!next[id]) {
          next[id] = { ...DEFAULT_ADJUST };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    jointValuesRef.current = jointValues;
  }, [jointValues]);

  useEffect(() => {
    leaderJointValuesRef.current = leaderJointValues;
  }, [leaderJointValues]);

  const prepareCalibrationStart = () => {
    const nextJointValues = createRandomCalibrationPose();
    jointValuesRef.current = nextJointValues;
    jointTargetValuesRef.current = nextJointValues;
    setJointValues(nextJointValues);
    setHighlightedJoint(null);
    setHighlightedLeaderJoint(null);
    setSelectableJoints([]);
    setCalibrationTargetArm("follower");
  };

  const handleCalibrationTargetChange = (target: "follower" | "leader") => {
    if (target === "leader" && calibrationTargetArm !== "leader") {
      const nextLeaderValues = createRandomCalibrationPose();

      leaderJointValuesRef.current = nextLeaderValues;
      leaderTargetValuesRef.current = nextLeaderValues;
      setLeaderJointValues(nextLeaderValues);
      setHighlightedLeaderJoint(null);
    }

    setCalibrationTargetArm(target);
  };

  const selectMission = (mission: number) => {
    setTrainingComplete(false);
    setCalibrationSetupActive(false);

    if (mission === 1) {
      setSelectedSetupMotor(null);
      setHighlightedJoint(null);
      setHighlightedLeaderJoint(null);
      setUsbConnections({ follower: false, leader: false });
      setUsbActiveArm(null);
    }

    if (mission === 2) {
      setMotorSetupTarget("follower");
      setSelectedSetupMotor(null);
      setHighlightedJoint(null);
      setHighlightedLeaderJoint(null);
      setSelectableJoints([]);
      setMotorSetupConnectedJoint(null);
      setMotorSetupChained(false);
      // Stand the follower in the midpoint standard pose for motor setup.
      const midpointPose = createInitialJointValues();
      jointValuesRef.current = midpointPose;
      jointTargetValuesRef.current = midpointPose;
      setJointValues(midpointPose);
    }

    if (mission === 3 && currentMission !== 3) {
      prepareCalibrationStart();
    }

    if (mission === 4) {
      const nextJointValues = createInitialJointValues();
      const nextLeaderValues = createInitialJointValues();
      jointValuesRef.current = nextJointValues;
      leaderJointValuesRef.current = nextLeaderValues;
      jointTargetValuesRef.current = nextJointValues;
      leaderTargetValuesRef.current = nextLeaderValues;
      setJointValues(nextJointValues);
      setLeaderJointValues(nextLeaderValues);
      setHighlightedJoint(null);
      setHighlightedLeaderJoint(null);
      setCalibrationTargetArm("follower");
      setSelectableJoints(jointOrder);
      setShowTeleopTutorialOnMount(true);
    }

    setCurrentMission(mission);
  };

  const completeMission = (mission: number) => {
    setCompletedMissions((current) => {
      if (current.includes(mission)) {
        return current;
      }

      return [...current, mission];
    });

    if (mission < 4) {
      const nextMission = mission + 1;

      if (nextMission === 2) {
        setMotorSetupTarget("follower");
        setSelectedSetupMotor(null);
        setHighlightedJoint(null);
        setHighlightedLeaderJoint(null);
        setSelectableJoints([]);
        setMotorSetupConnectedJoint(null);
        setMotorSetupChained(false);
        const midpointPose = createInitialJointValues();
        jointValuesRef.current = midpointPose;
        jointTargetValuesRef.current = midpointPose;
        setJointValues(midpointPose);
      }

      if (nextMission === 3) {
        prepareCalibrationStart();
      }

      setCurrentMission(nextMission);
    }
  };

  const resetTeleoperationMission = () => {
    const nextJointValues = createInitialJointValues();
    const nextLeaderValues = createInitialJointValues();

    setTrainingComplete(false);
    setTeleoperationActive(false);
    setRobotActivated(false);
    jointValuesRef.current = nextJointValues;
    leaderJointValuesRef.current = nextLeaderValues;
    jointTargetValuesRef.current = nextJointValues;
    leaderTargetValuesRef.current = nextLeaderValues;
    setJointValues(nextJointValues);
    setLeaderJointValues(nextLeaderValues);
    setHighlightedJoint(null);
    setHighlightedLeaderJoint(null);
    setDemonstratedTeleopJoints([]);
    setShowTeleopTutorialOnMount(true);
    setCompletedMissions((current) =>
      current.filter((mission) => mission !== 4),
    );
  };

  const restartTrainingFromStart = () => {
    window.location.reload();
  };

  const completeTeleoperationMission = useCallback(() => {
    const missingRequiredStages = requiredStagesBeforeGraduation.filter(
      (mission) => !completedMissions.includes(mission),
    );

    if (missingRequiredStages.length > 0) {
      setTrainingComplete(false);
      return;
    }

    setRobotActivated(true);
    setTrainingComplete(true);
    setTeleoperationActive(false);
    setHighlightedJoint(null);
    setHighlightedLeaderJoint(null);
    setCompletedMissions((current) => {
      if (current.includes(4)) {
        return current;
      }

      return [...current, 4];
    });
  }, [completedMissions]);

  const updateFollowerJointValue = (jointName: JointName, value: number) => {
    const nextValue = resolveStableJointInput(
      "follower-direct",
      jointName,
      jointValuesRef.current[jointName],
      jointTargetValuesRef.current[jointName],
      value,
    );
    const nextTargetValues = {
      ...jointTargetValuesRef.current,
      [jointName]: nextValue.targetAngle,
    };
    const nextJointValues = {
      ...jointValuesRef.current,
      [jointName]: nextValue.finalAppliedAngle,
    };

    jointTargetValuesRef.current = nextTargetValues;
    jointValuesRef.current = nextJointValues;
    setJointValues(nextJointValues);
  };

  const updateLeaderJointValue = (jointName: JointName, value: number) => {
    const nextLeaderValue = resolveStableJointInput(
      "leader-input",
      jointName,
      leaderJointValuesRef.current[jointName],
      leaderTargetValuesRef.current[jointName],
      value,
    );

    const nextLeaderTargetValues = {
      ...leaderTargetValuesRef.current,
      [jointName]: nextLeaderValue.targetAngle,
    };
    const nextLeaderValues = {
      ...leaderJointValuesRef.current,
      [jointName]: nextLeaderValue.finalAppliedAngle,
    };

    leaderTargetValuesRef.current = nextLeaderTargetValues;
    leaderJointValuesRef.current = nextLeaderValues;
    setLeaderJointValues(nextLeaderValues);

    if (!teleoperationActive) {
      return;
    }

    const mapping = jointControlMappings[jointName];
    const nextFollowerTargetAngle = clampAngle(
      nextLeaderValue.targetAngle,
      mapping,
    );
    const nextFollowerAppliedAngle = clampAngle(
      nextLeaderValue.finalAppliedAngle,
      mapping,
    );
    const nextTargetValues = {
      ...jointTargetValuesRef.current,
      [jointName]: nextFollowerTargetAngle,
    };
    const nextJointValues = {
      ...jointValuesRef.current,
      [jointName]: nextFollowerAppliedAngle,
    };

    console.debug("[teleop-control]", {
      source: "leader-to-follower",
      jointName,
      rawInputValue: nextLeaderValue.finalAppliedAngle,
      mappedTargetAngle: nextFollowerTargetAngle,
      finalAppliedAngle: nextFollowerAppliedAngle,
      deltaChange:
        nextFollowerAppliedAngle - jointValuesRef.current[jointName],
      rejected: false,
      reason: "mirrored leader state",
    });

    jointTargetValuesRef.current = nextTargetValues;
    jointValuesRef.current = nextJointValues;
    setJointValues(nextJointValues);

    const config = jointConfigs[jointName];
    const movementThreshold = Math.max(config.tolerance * 1.5, 8);

    if (
      Math.abs(nextLeaderValue.finalAppliedAngle - config.midpoint) >=
      movementThreshold
    ) {
      setDemonstratedTeleopJoints((current) =>
        current.includes(jointName) ? current : [...current, jointName],
      );
    }
  };

  const handleMotorSetupMotorSelect = useCallback(
    (target: MotorSetupTarget, jointName: JointName) => {
      setMotorSetupTarget(target);
      setSelectedSetupMotor({ target, jointName });

      if (target === "leader") {
        setHighlightedLeaderJoint(jointName);
        setHighlightedJoint(null);
        return;
      }

      setHighlightedJoint(jointName);
      setHighlightedLeaderJoint(null);
    },
    [],
  );

  const handleUsbPortClick = useCallback((arm: "follower" | "leader") => {
    setUsbConnections((current) => ({ ...current, [arm]: !current[arm] }));
  }, []);

  const handleMotorSetupActiveMotorChange = useCallback(
    (jointName: JointName | null) => {
      if (motorSetupTarget === "leader") {
        setHighlightedLeaderJoint(jointName);
        setHighlightedJoint(null);
        return;
      }

      setHighlightedJoint(jointName);
      setHighlightedLeaderJoint(null);
    },
    [motorSetupTarget],
  );

  if (trainingComplete && allStagesComplete) {
    return (
      <main className="training-complete-screen">
        <div className="confetti-layer" aria-hidden="true">
          {confettiPieces.map((piece) => (
            <span
              className={`confetti-piece ${piece.shape}`}
              key={piece.id}
              style={{
                "--confetti-color": piece.color,
                "--confetti-delay": piece.delay,
                "--confetti-duration": piece.duration,
                "--confetti-left": piece.left,
              } as CSSProperties}
            />
          ))}
        </div>

        <section className="training-complete-content">
          <p className="training-complete-kicker">SO-101 Training Complete</p>
          <h1>
            CONGRATULATIONS!
            <span>You have completed the SO-101 training.</span>
          </h1>
          <p>You are now ready for real robot operation.</p>
          <button
            type="button"
            onClick={restartTrainingFromStart}
          >
            Restart Training
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">SO-101 ROBOT LAB</p>
          <h1>Robot Setup Quest</h1>
          <p>Learn how to prepare and operate the SO-101.</p>
        </div>
      </header>

      <MissionSelector
        currentMission={currentMission}
        completedMissions={completedMissions}
        onSelectMission={selectMission}
      />

      <section
        className={`game-layout ${
          currentMission === 3 && calibrationSetupActive
            ? "setup-only-layout"
            : ""
        } ${
          currentMission === 1 ||
          (currentMission === 3 && !calibrationSetupActive) ||
          currentMission === 4
            ? "side-terminal-layout"
            : ""
        }`}
      >
        {!(currentMission === 3 && calibrationSetupActive) && (
        <div className="visual-panel">
          <RobotScene
            jointValues={jointValues}
            leaderJointValues={leaderJointValues}
            highlightedJoint={highlightedJoint}
            highlightedLeaderJoint={highlightedLeaderJoint}
            directControlEnabled={
              (currentMission === 3 && !robotActivated) ||
              currentMission === 4
            }
            directControlTarget={
              currentMission === 2
                ? motorSetupTarget
                : currentMission === 4
                ? "leader"
                : currentMission === 3
                  ? calibrationTargetArm
                  : "follower"
            }
            showLeaderArm={
              currentMission === 1 ||
              currentMission === 4 ||
              (currentMission === 3 && calibrationTargetArm === "leader")
            }
            teleoperationActive={teleoperationActive}
            motorSetupActive={currentMission === 2}
            motorSetupTarget={motorSetupTarget}
            motorSetupActiveJoint={
              motorSetupTarget === "leader"
                ? highlightedLeaderJoint
                : highlightedJoint
            }
            motorSetupConfiguredJoints={
              motorSetupConfiguredJoints[motorSetupTarget]
            }
            motorSetupConnectedJoint={
              currentMission === 2 ? motorSetupConnectedJoint : null
            }
            motorSetupChained={currentMission === 2 && motorSetupChained}
            usbSetupActive={currentMission === 1}
            usbConnections={usbConnections}
            usbActiveArm={currentMission === 1 ? usbActiveArm : null}
            onUsbPortClick={handleUsbPortClick}
            selectableJoints={
              currentMission === 4 ? jointOrder : selectableJoints
            }
            onJointSelect={setHighlightedJoint}
            onJointValueChange={updateFollowerJointValue}
            onLeaderJointSelect={setHighlightedLeaderJoint}
            onLeaderJointValueChange={updateLeaderJointValue}
            connectorAdjust={connectorAdjusts}
            onConnectorsChange={handleConnectorsChange}
            onMotorSetupMotorSelect={handleMotorSetupMotorSelect}
          />

	          {currentMission === 4 && (
	            <>
	              <div className="arm-role-label leader-label">
	                <strong>LEADER ARM</strong>
                <span>Move this arm</span>
              </div>
              <div className="arm-role-label follower-label">
                <strong>FOLLOWER ARM</strong>
                <span>Copies the Leader</span>
              </div>
              {teleoperationActive && <div className="teleop-link-indicator" />}
	            </>
	          )}

          <div className="camera-control-hints" aria-label="Simulator camera controls">
            <span>Drag to rotate</span>
            <span>Scroll to zoom</span>
            <span>Right drag to pan</span>
          </div>

	          <div className="visual-status">
	            <span>
	              {currentMission === 4 && teleoperationActive
                ? "Teleoperation"
                : "System progress"}
            </span>
            <strong>{completedMissions.length} / 4</strong>
          </div>
        </div>
        )}

        <div className="content-panel">
          {currentMission === 1 && (
            <UsbIdentificationMission
              usbConnections={usbConnections}
              onUsbActiveArmChange={setUsbActiveArm}
              onSetUsbConnections={setUsbConnections}
              onComplete={() => completeMission(1)}
            />
          )}

          {currentMission === 2 && (
            <MotorSetupMission
              selectedMotor={selectedSetupMotor}
              setupTarget={motorSetupTarget}
              configuredJoints={motorSetupConfiguredJoints}
              onSetupTargetChange={(target) => {
                setMotorSetupTarget(target);
                setSelectedSetupMotor(null);
                setHighlightedJoint(null);
                setHighlightedLeaderJoint(null);
              }}
              onConfiguredJointsChange={setMotorSetupConfiguredJoints}
              onActiveMotorChange={handleMotorSetupActiveMotorChange}
              onConnectedMotorChange={setMotorSetupConnectedJoint}
              onChainedChange={setMotorSetupChained}
              onComplete={() => completeMission(2)}
            />
          )}

          {currentMission === 3 && (
            <CalibrationGame
              jointValues={jointValues}
              leaderJointValues={leaderJointValues}
              selectedJoint={highlightedJoint}
              onSelectedJointChange={setHighlightedJoint}
              onSelectableJointsChange={setSelectableJoints}
              onHighlightedJointChange={setHighlightedJoint}
              onHighlightedLeaderJointChange={setHighlightedLeaderJoint}
              onConnectionSetupActiveChange={setCalibrationSetupActive}
              onCalibrationTargetChange={handleCalibrationTargetChange}
              onComplete={() => {
                setCalibrationSetupActive(false);
                setCalibrationTargetArm("follower");
                setHighlightedLeaderJoint(null);
                completeMission(3);
              }}
            />
          )}

          {currentMission === 4 && (
            <TeleoperationMission
              key={showTeleopTutorialOnMount ? "teleop-guided" : "teleop-practice"}
              active={teleoperationActive}
              demonstratedJoints={demonstratedTeleopJoints}
              followerJointValues={jointValues}
              leaderJointValues={leaderJointValues}
              initialShowTutorial={showTeleopTutorialOnMount}
              selectedJoint={highlightedLeaderJoint}
              canFinishTraining={missingGraduationStages.length === 0}
              missingTrainingStages={missingGraduationStages}
              onFinishTraining={completeTeleoperationMission}
              onReset={resetTeleoperationMission}
              onStart={() => {
                setTeleoperationActive(true);
                const nextJointValues = { ...leaderJointValuesRef.current };
                jointValuesRef.current = nextJointValues;
                jointTargetValuesRef.current = nextJointValues;
                setJointValues(nextJointValues);
              }}
              onStop={() => setTeleoperationActive(false)}
              onPreviewJointChange={(jointName) => {
                setHighlightedJoint(jointName);
                setHighlightedLeaderJoint(jointName);
              }}
            />
          )}
        </div>
      </section>

    </main>
  );
}

export default App;
