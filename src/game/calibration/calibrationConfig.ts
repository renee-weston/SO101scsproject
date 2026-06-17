import type {
  CalibrationState,
  JointName,
  JointValues,
  SavedCalibration,
  SimulatedJointConfig,
} from "./calibrationTypes";

export const calibrationStorageKey = "so101-simulated-calibration";

export const jointOrder: JointName[] = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
];

export const jointConfigs: Record<JointName, SimulatedJointConfig> = {
  shoulder_pan: {
    label: "Base / Shoulder Pan",
    min: -110,
    max: 110,
    midpoint: 0,
    tolerance: 5,
    unit: "degrees",
    urdfJointName: "shoulder_pan",
    directionLabels: {
      decrease: "Rotate counterclockwise",
      increase: "Rotate clockwise",
    },
  },
  shoulder_lift: {
    label: "Shoulder Lift",
    min: -100,
    max: 100,
    midpoint: 0,
    tolerance: 5,
    unit: "degrees",
    urdfJointName: "shoulder_lift",
    directionLabels: {
      decrease: "Move downward",
      increase: "Move upward",
    },
  },
  elbow_flex: {
    label: "Elbow Flex",
    min: -97,
    max: 97,
    midpoint: 0,
    tolerance: 5,
    unit: "degrees",
    urdfJointName: "elbow_flex",
    directionLabels: {
      decrease: "Move downward",
      increase: "Move upward",
    },
  },
  wrist_flex: {
    label: "Wrist Flex",
    min: -95,
    max: 95,
    midpoint: 0,
    tolerance: 5,
    unit: "degrees",
    urdfJointName: "wrist_flex",
    directionLabels: {
      decrease: "Flex downward",
      increase: "Flex upward",
    },
  },
  wrist_roll: {
    label: "Wrist Roll",
    min: -157,
    max: 163,
    midpoint: 3,
    tolerance: 8,
    unit: "degrees",
    urdfJointName: "wrist_roll",
    directionLabels: {
      decrease: "Rotate counterclockwise",
      increase: "Rotate clockwise",
    },
  },
  gripper: {
    label: "Gripper",
    min: -10,
    max: 100,
    midpoint: 45,
    tolerance: 5,
    unit: "degrees",
    urdfJointName: "gripper",
    directionLabels: {
      decrease: "Close slightly",
      increase: "Open slightly",
    },
  },
};

export const createInitialJointValues = (): JointValues =>
  jointOrder.reduce((values, jointName) => {
    values[jointName] = jointConfigs[jointName].midpoint;
    return values;
  }, {} as JointValues);

export const createRandomCalibrationPose = (
  random = Math.random,
): JointValues =>
  jointOrder.reduce((values, jointName, index) => {
    const config = jointConfigs[jointName];
    const lowerSpan = config.midpoint - config.min;
    const upperSpan = config.max - config.midpoint;
    const direction = random() > 0.5 ? 1 : -1;
    const span = direction > 0 ? upperSpan : lowerSpan;
    const minimumOffset = Math.max(config.tolerance * 2, span * 0.25);
    const maximumOffset = Math.max(minimumOffset, span * 0.55);
    const offset =
      minimumOffset + random() * (maximumOffset - minimumOffset);
    const stagger = index % 2 === 0 ? direction : -direction;
    const value = config.midpoint + stagger * offset;

    values[jointName] = Math.min(config.max, Math.max(config.min, value));

    return values;
  }, {} as JointValues);

export const createInitialCalibration = (): CalibrationState =>
  jointOrder.reduce((state, jointName) => {
    const config = jointConfigs[jointName];

    state[jointName] = {
      observedMin: config.midpoint,
      observedMax: config.midpoint,
      reachedMinimum: false,
      reachedMaximum: false,
    };

    return state;
  }, {} as CalibrationState);

export const createSavedCalibration = (
  calibration: CalibrationState,
  completedAt = new Date().toISOString(),
): SavedCalibration => ({
  version: 1,
  completedAt,
  midpointConfirmed: true,
  joints: jointOrder.reduce((joints, jointName) => {
    joints[jointName] = {
      ...calibration[jointName],
      midpoint: jointConfigs[jointName].midpoint,
    };

    return joints;
  }, {} as SavedCalibration["joints"]),
});
