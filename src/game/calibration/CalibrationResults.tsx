import {
  formatJointValue,
  getAccuracyScore,
  jointConfigs,
  jointOrder,
} from "./calibrationLogic";
import type { CalibrationState } from "./calibrationTypes";

type CalibrationResultsProps = {
  calibration: CalibrationState;
  onComplete: () => void;
};

export default function CalibrationResults({
  calibration,
  onComplete,
}: CalibrationResultsProps) {
  const score = getAccuracyScore(calibration, jointConfigs);

  return (
    <div className="calibration-results">
      <div className="completion-banner">
        <span>Simulation Calibration Complete</span>
        <strong>{score}% accuracy</strong>
      </div>

      <p>
        The virtual robot now understands the range of motion of each
        joint. The real SO-101 must still be calibrated separately using
        LeRobot.
      </p>

      <div className="results-table">
        <div className="results-row header">
          <span>Joint</span>
          <span>Minimum</span>
          <span>Midpoint</span>
          <span>Maximum</span>
        </div>

        {jointOrder.map((jointName) => {
          const config = jointConfigs[jointName];
          const state = calibration[jointName];

          return (
            <div className="results-row" key={jointName}>
              <strong>{config.label}</strong>
              <span>{formatJointValue(state.observedMin, config)}</span>
              <span>{formatJointValue(config.midpoint, config)}</span>
              <span>{formatJointValue(state.observedMax, config)}</span>
            </div>
          );
        })}
      </div>

      <button className="primary-button" onClick={onComplete}>
        Activate Virtual SO-101
      </button>
    </div>
  );
}
