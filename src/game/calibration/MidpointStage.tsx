import { useEffect, useState } from "react";
import {
  areAllJointsNearMidpoint,
  formatJointValue,
  getMidpointError,
  getMidpointHint,
  jointConfigs,
  jointOrder,
} from "./calibrationLogic";
import type { JointName, JointValues } from "./calibrationTypes";

type MidpointStageProps = {
  jointValues: JointValues;
  selectedJoint: JointName | null;
  onConfirm: () => void;
  onReset: () => void;
};

const holdTimeMs = 2000;

export default function MidpointStage({
  jointValues,
  selectedJoint,
  onConfirm,
  onReset,
}: MidpointStageProps) {
  const [holdStartedAt, setHoldStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const allCentered = areAllJointsNearMidpoint(jointValues, jointConfigs);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHoldStartedAt((current) => {
        if (!allCentered) {
          return null;
        }

        return current ?? Date.now();
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [allCentered]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);

    return () => window.clearInterval(timer);
  }, []);

  const holdProgress =
    holdStartedAt === null
      ? 0
      : Math.min(1, (now - holdStartedAt) / holdTimeMs);
  const canConfirm = allCentered && holdProgress >= 1;
  const selectedConfig = selectedJoint ? jointConfigs[selectedJoint] : null;
  const selectedValue = selectedJoint ? jointValues[selectedJoint] : null;

  return (
    <>
      <div className="stage-callout">
        <strong>Simulation Calibration</strong>
        <span>
          Click a joint on the 3D robot, then drag left or right to rotate
          only that joint toward its midpoint. Hold the complete midpoint
          pose for two seconds before confirming.
        </span>
      </div>

      <div className="direct-control-panel">
        <strong>
          {selectedConfig ? selectedConfig.label : "Select a joint on the robot"}
        </strong>
        {selectedConfig && selectedValue !== null ? (
          <span>
            Current {formatJointValue(selectedValue, selectedConfig)} · Target{" "}
            {formatJointValue(selectedConfig.midpoint, selectedConfig)} ·{" "}
            {getMidpointHint(selectedValue, selectedConfig)}
          </span>
        ) : (
          <span>
            Use the 3D arm as the control surface. The side panel reports
            what happened; it no longer drives the midpoint task.
          </span>
        )}
      </div>

      <div className="hold-meter">
        <span>Midpoint hold</span>
        <div>
          <span style={{ width: `${holdProgress * 100}%` }} />
        </div>
      </div>

      <div className="joint-status-list">
        {jointOrder.map((jointName) => {
          const config = jointConfigs[jointName];
          const value = jointValues[jointName];
          const error = getMidpointError(value, config);
          const hint = getMidpointHint(value, config);

          return (
            <div
              className={`joint-status-row ${
                hint === "Correct" ? "complete" : ""
              } ${selectedJoint === jointName ? "selected" : ""}`}
              key={jointName}
            >
              <strong>{config.label}</strong>
              <span>{hint === "Correct" ? "At midpoint" : hint}</span>
              <small>
                Current {formatJointValue(value, config)} · Target{" "}
                {formatJointValue(config.midpoint, config)} · Error{" "}
                {formatJointValue(error, config)}
              </small>
            </div>
          );
        })}
      </div>

      <div className="button-row">
        <button className="secondary-button" onClick={onReset}>
          Retry Random Pose
        </button>

        <button
          className="primary-button"
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          Confirm Midpoint
        </button>
      </div>
    </>
  );
}
