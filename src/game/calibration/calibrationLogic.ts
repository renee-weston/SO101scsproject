import {
  calibrationStorageKey,
  createSavedCalibration,
  jointOrder,
} from "./calibrationConfig";
import type {
  CalibrationState,
  JointCalibrationState,
  JointValues,
  SavedCalibration,
  SimulatedJointConfig,
} from "./calibrationTypes";

export {
  calibrationStorageKey,
  createInitialCalibration,
  createInitialJointValues,
  createRandomCalibrationPose,
  createSavedCalibration,
  jointConfigs,
  jointOrder,
} from "./calibrationConfig";

export const clampJointValue = (
  value: number,
  config: SimulatedJointConfig,
) => Math.min(config.max, Math.max(config.min, value));

const limitThresholdRatio = 0.12;

export const formatJointValue = (
  value: number,
  config: SimulatedJointConfig,
) => {
  const suffix = config.unit === "degrees" ? "deg" : "%";
  return `${Math.round(value)}${suffix}`;
};

export const isNearMidpoint = (
  value: number,
  config: SimulatedJointConfig,
) => Math.abs(value - config.midpoint) <= config.tolerance;

export const getMidpointError = (
  value: number,
  config: SimulatedJointConfig,
) => Math.abs(value - config.midpoint);

export const getMidpointHint = (
  value: number,
  config: SimulatedJointConfig,
) => {
  if (isNearMidpoint(value, config)) {
    return "Correct";
  }

  return value < config.midpoint
    ? config.directionLabels.increase
    : config.directionLabels.decrease;
};

export const hasReachedMinimum = (
  value: number,
  config: SimulatedJointConfig,
) => value <= config.min + (config.max - config.min) * limitThresholdRatio;

export const hasReachedMaximum = (
  value: number,
  config: SimulatedJointConfig,
) => value >= config.max - (config.max - config.min) * limitThresholdRatio;

export const updateObservedRange = (
  state: JointCalibrationState,
  value: number,
  config: SimulatedJointConfig,
): JointCalibrationState => ({
  observedMin: Math.min(state.observedMin, value),
  observedMax: Math.max(state.observedMax, value),
  reachedMinimum: state.reachedMinimum || hasReachedMinimum(value, config),
  reachedMaximum: state.reachedMaximum || hasReachedMaximum(value, config),
});

export const isJointCalibrated = (state: JointCalibrationState) =>
  state.reachedMinimum && state.reachedMaximum;

export const isCalibrationComplete = (
  calibration: CalibrationState,
) => jointOrder.every((jointName) => isJointCalibrated(calibration[jointName]));

export const areAllJointsNearMidpoint = (
  jointValues: JointValues,
  configs: Record<keyof JointValues, SimulatedJointConfig>,
) =>
  jointOrder.every((jointName) =>
    isNearMidpoint(jointValues[jointName], configs[jointName]),
  );

export const countJointsNearMidpoint = (
  jointValues: JointValues,
  configs: Record<keyof JointValues, SimulatedJointConfig>,
) =>
  jointOrder.filter((jointName) =>
    isNearMidpoint(jointValues[jointName], configs[jointName]),
  ).length;

export const getAccuracyScore = (
  calibration: CalibrationState,
  configs: Record<keyof CalibrationState, SimulatedJointConfig>,
) => {
  const total = jointOrder.reduce((score, jointName) => {
    const config = configs[jointName];
    const state = calibration[jointName];
    const minError = Math.abs(state.observedMin - config.min);
    const maxError = Math.abs(state.observedMax - config.max);

    return score + Math.max(0, 100 - (minError + maxError));
  }, 0);

  return Math.round(total / jointOrder.length);
};

export const saveCalibration = (
  storage: Pick<Storage, "setItem">,
  calibration: CalibrationState,
  completedAt?: string,
) => {
  const savedCalibration = createSavedCalibration(
    calibration,
    completedAt,
  );

  storage.setItem(
    calibrationStorageKey,
    JSON.stringify(savedCalibration),
  );

  return savedCalibration;
};

export const restoreCalibration = (
  storage: Pick<Storage, "getItem">,
): SavedCalibration | null => {
  const rawValue = storage.getItem(calibrationStorageKey);

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as SavedCalibration;

    if (parsed.version !== 1 || !parsed.joints) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};
