import { describe, expect, it } from "vitest";
import {
  areAllJointsNearMidpoint,
  calibrationStorageKey,
  createInitialCalibration,
  createInitialJointValues,
  createRandomCalibrationPose,
  hasReachedMaximum,
  hasReachedMinimum,
  isCalibrationComplete,
  isJointCalibrated,
  isNearMidpoint,
  jointConfigs,
  jointOrder,
  restoreCalibration,
  saveCalibration,
  updateObservedRange,
} from "./calibrationLogic";
import type { CalibrationState } from "./calibrationTypes";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const completeCalibration = (): CalibrationState =>
  jointOrder.reduce((calibration, jointName) => {
    calibration[jointName] = {
      observedMin: jointConfigs[jointName].min,
      observedMax: jointConfigs[jointName].max,
      reachedMinimum: true,
      reachedMaximum: true,
    };

    return calibration;
  }, createInitialCalibration());

describe("calibration logic", () => {
  it("detects a joint at midpoint", () => {
    const config = jointConfigs.shoulder_pan;

    expect(isNearMidpoint(config.midpoint, config)).toBe(true);
  });

  it("uses midpoint tolerance", () => {
    const config = jointConfigs.shoulder_pan;

    expect(isNearMidpoint(config.midpoint + config.tolerance, config)).toBe(
      true,
    );
    expect(
      isNearMidpoint(config.midpoint + config.tolerance + 1, config),
    ).toBe(false);
  });

  it("checks all joint values against midpoint", () => {
    const values = createInitialJointValues();

    expect(areAllJointsNearMidpoint(values, jointConfigs)).toBe(true);

    values.elbow_flex = jointConfigs.elbow_flex.max;

    expect(areAllJointsNearMidpoint(values, jointConfigs)).toBe(false);
  });

  it("creates a randomized safe pose away from midpoint", () => {
    const randomValues = [0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4, 0.5, 0.2, 0.9, 0.1];
    let randomIndex = 0;
    const pose = createRandomCalibrationPose(
      () => randomValues[randomIndex++ % randomValues.length],
    );

    jointOrder.forEach((jointName) => {
      const config = jointConfigs[jointName];

      expect(pose[jointName]).toBeGreaterThanOrEqual(config.min);
      expect(pose[jointName]).toBeLessThanOrEqual(config.max);
      expect(isNearMidpoint(pose[jointName], config)).toBe(false);
    });
  });

  it("updates the observed minimum", () => {
    const config = jointConfigs.elbow_flex;
    const updated = updateObservedRange(
      {
        observedMin: config.midpoint,
        observedMax: config.midpoint,
        reachedMinimum: false,
        reachedMaximum: false,
      },
      config.min,
      config,
    );

    expect(updated.observedMin).toBe(config.min);
  });

  it("updates the observed maximum", () => {
    const config = jointConfigs.elbow_flex;
    const updated = updateObservedRange(
      {
        observedMin: config.midpoint,
        observedMax: config.midpoint,
        reachedMinimum: false,
        reachedMaximum: false,
      },
      config.max,
      config,
    );

    expect(updated.observedMax).toBe(config.max);
  });

  it("detects the minimum threshold", () => {
    const config = jointConfigs.wrist_flex;

    expect(hasReachedMinimum(config.min, config)).toBe(true);
    expect(hasReachedMinimum(config.midpoint, config)).toBe(false);
  });

  it("detects the maximum threshold", () => {
    const config = jointConfigs.wrist_flex;

    expect(hasReachedMaximum(config.max, config)).toBe(true);
    expect(hasReachedMaximum(config.midpoint, config)).toBe(false);
  });

  it("marks a joint complete after both limits", () => {
    expect(
      isJointCalibrated({
        observedMin: -10,
        observedMax: 10,
        reachedMinimum: true,
        reachedMaximum: true,
      }),
    ).toBe(true);
  });

  it("marks the full calibration complete", () => {
    expect(isCalibrationComplete(completeCalibration())).toBe(true);
    expect(isCalibrationComplete(createInitialCalibration())).toBe(false);
  });

  it("serializes and restores saved calibration", () => {
    const storage = new MemoryStorage();
    const saved = saveCalibration(
      storage,
      completeCalibration(),
      "2026-06-16T00:00:00.000Z",
    );
    const restored = restoreCalibration(storage);

    expect(storage.getItem(calibrationStorageKey)).not.toBeNull();
    expect(restored).toEqual(saved);
    expect(restored?.joints.gripper.midpoint).toBe(
      jointConfigs.gripper.midpoint,
    );
  });
});
