import type { JointName, SimulatedJointConfig } from "./calibrationTypes";

type JointSliderProps = {
  jointName: JointName;
  config: SimulatedJointConfig;
  value: number;
  disabled?: boolean;
  status?: string;
  onChange: (jointName: JointName, value: number) => void;
};

export default function JointSlider({
  jointName,
  config,
  value,
  disabled = false,
  status,
  onChange,
}: JointSliderProps) {
  const unitLabel = config.unit === "degrees" ? "deg" : "%";

  return (
    <label className={`joint-slider ${disabled ? "locked" : ""}`}>
      <span className="joint-slider-header">
        <strong>{config.label}</strong>
        <span>{Math.round(value)}{unitLabel}</span>
      </span>

      <input
        type="range"
        min={config.min}
        max={config.max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(jointName, Number(event.currentTarget.value))
        }
      />

      <span className="joint-slider-footer">
        <span>{Math.round(config.min)}{unitLabel}</span>
        {status && <span>{status}</span>}
        <span>{Math.round(config.max)}{unitLabel}</span>
      </span>
    </label>
  );
}
