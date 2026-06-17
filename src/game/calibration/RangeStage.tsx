import {
  formatJointValue,
  isJointCalibrated,
  jointConfigs,
  jointOrder,
} from "./calibrationLogic";
import type {
  CalibrationState,
  JointName,
  JointValues,
} from "./calibrationTypes";

type RangeStageProps = {
  activeJoint: JointName;
  calibration: CalibrationState;
  jointValues: JointValues;
  onJointSelect: (jointName: JointName) => void;
};

export default function RangeStage({
  activeJoint,
  calibration,
  jointValues,
  onJointSelect,
}: RangeStageProps) {
  const activeConfig = jointConfigs[activeJoint];
  const activeState = calibration[activeJoint];
  const activeIndex = jointOrder.indexOf(activeJoint);
  const prompt = !activeState.reachedMinimum
    ? `Move the ${activeConfig.label.toLowerCase()} slowly toward its simulated minimum limit.`
    : !activeState.reachedMaximum
      ? `Minimum detected. Now move the ${activeConfig.label.toLowerCase()} toward its simulated maximum limit.`
      : "Joint calibrated. Click another joint to continue.";

  return (
    <>
      <div className="range-header">
        <span className="current-joint-badge">
          Joint {activeIndex + 1} of {jointOrder.length}
        </span>
        <h3>{activeConfig.label}</h3>
        <p>{prompt}</p>
      </div>

      <div className="limit-indicators">
        <div className={activeState.reachedMinimum ? "complete" : ""}>
          <span>Minimum reached</span>
          <strong>{activeState.reachedMinimum ? "Yes" : "No"}</strong>
        </div>
        <div className={activeState.reachedMaximum ? "complete" : ""}>
          <span>Maximum reached</span>
          <strong>{activeState.reachedMaximum ? "Yes" : "No"}</strong>
        </div>
      </div>

      <div className="observed-range">
        <span>
          Current angle:{" "}
          <strong>
            {formatJointValue(jointValues[activeJoint], activeConfig)}
          </strong>
        </span>
        <span>
          Observed minimum:{" "}
          <strong>{formatJointValue(activeState.observedMin, activeConfig)}</strong>
        </span>
        <span>
          Observed maximum:{" "}
          <strong>{formatJointValue(activeState.observedMax, activeConfig)}</strong>
        </span>
      </div>

      <div className="stage-callout">
        <strong>Use the robot model</strong>
        <span>
          Click a joint in the 3D view or use the compact selector below.
          Drag the orange rotation ring until the simulated minimum and
          maximum limits are detected.
        </span>
      </div>

      <div className="compact-joint-selector" aria-label="Joint selector">
        {jointOrder.map((jointName) => {
          const config = jointConfigs[jointName];
          const calibrated = isJointCalibrated(calibration[jointName]);
          const status =
            jointName === activeJoint
              ? calibrated
                ? "Calibrated"
                : "Active"
              : calibrated
                ? "Calibrated"
                : "Not started";

          return (
            <button
              className={`joint-chip ${
                calibrated ? "complete" : ""
              } ${jointName === activeJoint ? "active" : ""}`}
              key={jointName}
              onClick={() => onJointSelect(jointName)}
              type="button"
            >
              <strong>{config.label}</strong>
              <span>{status}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
