export type JointName =
  | "shoulder_pan"
  | "shoulder_lift"
  | "elbow_flex"
  | "wrist_flex"
  | "wrist_roll"
  | "gripper";

export type SimulatedJointConfig = {
  label: string;
  min: number;
  max: number;
  midpoint: number;
  tolerance: number;
  unit: "degrees" | "percent";
  urdfJointName: string;
  directionLabels: {
    decrease: string;
    increase: string;
  };
};

export type JointValues = Record<JointName, number>;

export type JointCalibrationState = {
  observedMin: number;
  observedMax: number;
  reachedMinimum: boolean;
  reachedMaximum: boolean;
};

export type CalibrationState = Record<
  JointName,
  JointCalibrationState
>;

export type CalibrationPhase = "midpoint" | "range" | "results";

export type SavedCalibration = {
  version: 1;
  completedAt: string;
  midpointConfirmed: boolean;
  joints: Record<
    JointName,
    JointCalibrationState & {
      midpoint: number;
    }
  >;
};
