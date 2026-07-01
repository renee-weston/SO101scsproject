import { useEffect, useRef, useState } from "react";
import { jointConfigs } from "./calibration/calibrationConfig";
import type { JointName } from "./calibration/calibrationTypes";

type ArmTarget = "follower" | "leader";

type SelectedSetupMotor = {
  target: ArmTarget;
  jointName: JointName;
} | null;

type MotorSetupProgress = Record<ArmTarget, JointName[]>;

type MotorSetupMissionProps = {
  selectedMotor: SelectedSetupMotor;
  setupTarget: ArmTarget;
  configuredJoints: MotorSetupProgress;
  onSetupTargetChange: (target: ArmTarget) => void;
  onConfiguredJointsChange: (progress: MotorSetupProgress) => void;
  onActiveMotorChange: (jointName: JointName | null) => void;
  onConnectedMotorChange?: (jointName: JointName | null) => void;
  onChainedChange?: (chained: boolean) => void;
  onComplete: () => void;
};

type MotorAssignment = {
  jointName: JointName;
  motorName: string;
  label: string;
  id: number;
};

// Real lerobot order: gripper (id 6) down to shoulder pan (id 1).
const assignmentOrder: MotorAssignment[] = [
  { jointName: "gripper", motorName: "gripper", label: "Gripper", id: 6 },
  { jointName: "wrist_roll", motorName: "wrist_roll", label: "Wrist Roll", id: 5 },
  { jointName: "wrist_flex", motorName: "wrist_flex", label: "Wrist Flex", id: 4 },
  { jointName: "elbow_flex", motorName: "elbow_flex", label: "Elbow", id: 3 },
  { jointName: "shoulder_lift", motorName: "shoulder_lift", label: "Shoulder Lift", id: 2 },
  { jointName: "shoulder_pan", motorName: "shoulder_pan", label: "Shoulder Pan", id: 1 },
];

const ports: Record<ArmTarget, string> = {
  follower: "/dev/ttyACM0",
  leader: "/dev/ttyACM1",
};

const setupCommand = (target: ArmTarget) =>
  target === "follower"
    ? `lerobot.setup_motors --robot.type=so101_follower --robot.port=${ports.follower}`
    : `lerobot.setup_motors --teleop.type=so101_leader --teleop.port=${ports.leader}`;

const emptyProgress = (): MotorSetupProgress => ({ follower: [], leader: [] });
const armLabel = (target: ArmTarget) =>
  target === "follower" ? "Follower" : "Leader";

export default function MotorSetupMission({
  selectedMotor,
  setupTarget,
  configuredJoints,
  onSetupTargetChange,
  onConfiguredJointsChange,
  onActiveMotorChange,
  onConnectedMotorChange,
  onChainedChange,
  onComplete,
}: MotorSetupMissionProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([
    "student@so101-lab:~$ # Copy the command below, paste it, and press Enter.",
  ]);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [connectedMotor, setConnectedMotor] = useState<JointName | null>(null);
  const [commandRun, setCommandRun] = useState<Record<ArmTarget, boolean>>({
    follower: false,
    leader: false,
  });
  const [chainComplete, setChainComplete] = useState<Record<ArmTarget, boolean>>(
    { follower: false, leader: false },
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  const configuredForTarget = configuredJoints[setupTarget];
  const stepIndex = configuredForTarget.length;
  const requestedMotor = assignmentOrder[stepIndex] ?? null;
  const allIdsConfigured = stepIndex === assignmentOrder.length;
  const armChained = chainComplete[setupTarget];
  const isRun = commandRun[setupTarget];
  // Follower-only stage: "done" means the follower chain is built.
  const bothChainsComplete = chainComplete.follower;

  const appendTerminal = (...lines: string[]) =>
    setTerminalLines((current) => [...current, ...lines]);

  // Highlight the motor whose connector should be plugged in next.
  useEffect(() => {
    onActiveMotorChange(
      isRun && !allIdsConfigured ? requestedMotor?.jointName ?? null : null,
    );
  }, [isRun, allIdsConfigured, onActiveMotorChange, requestedMotor]);

  // Tell the 3D scene which connector is currently plugged into the board.
  useEffect(() => {
    onConnectedMotorChange?.(connectedMotor);
  }, [connectedMotor, onConnectedMotorChange]);

  useEffect(() => {
    onChainedChange?.(chainComplete[setupTarget]);
  }, [chainComplete, setupTarget, onChainedChange]);

  useEffect(() => {
    terminalRef.current?.scrollTo({
      top: terminalRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [terminalLines]);

  // React to the student clicking a JST connector in the 3D scene.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selectedMotor || selectedMotor.target !== setupTarget) return;
      if (!isRun || allIdsConfigured || !requestedMotor) return;
      const clicked = selectedMotor.jointName;

      if (connectedMotor === clicked) {
        setConnectedMotor(null); // click again to unplug
        setFeedback(null);
        return;
      }
      if (connectedMotor && connectedMotor !== clicked) {
        appendTerminal(
          `Error: two motors detected. Unplug '${connectedMotor}' before connecting another.`,
        );
        setFeedback(
          `Only one motor at a time. Unplug ${jointConfigs[connectedMotor].label} first.`,
        );
        return;
      }
      if (clicked !== requestedMotor.jointName) {
        appendTerminal(
          `Detected '${clicked}'. The script asked for '${requestedMotor.motorName}'.`,
        );
        setFeedback(
          `That's the ${jointConfigs[clicked].label} connector — plug in the glowing ${requestedMotor.label} one.`,
        );
        return;
      }
      setConnectedMotor(clicked);
      appendTerminal(`'${requestedMotor.motorName}' connector attached to the board.`);
      setFeedback(null);
    }, 0);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMotor]);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(setupCommand(setupTarget));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const runSetupCommand = () => {
    setCommandRun((current) => ({ ...current, [setupTarget]: true }));
    appendTerminal(
      `Connect the controller board to the '${assignmentOrder[stepIndex]?.motorName ?? assignmentOrder[0].motorName}' motor only and press enter.`,
    );
    setFeedback(null);
  };

  const assignCurrentId = () => {
    if (!requestedMotor) return;
    onConfiguredJointsChange({
      ...configuredJoints,
      [setupTarget]: [...configuredForTarget, requestedMotor.jointName],
    });
    appendTerminal(`'${requestedMotor.motorName}' motor id set to ${requestedMotor.id}`);
    setConnectedMotor(null);
    const next = assignmentOrder[stepIndex + 1];
    if (next) {
      appendTerminal(
        `Connect the controller board to the '${next.motorName}' motor only and press enter.`,
      );
    } else {
      appendTerminal(
        `All ${armLabel(setupTarget).toLowerCase()} motor ids set.`,
        "Press Enter to proceed.",
      );
    }
  };

  const finishSetup = () => {
    setChainComplete((current) => ({ ...current, [setupTarget]: true }));
    appendTerminal(
      `${armLabel(setupTarget)} motor ids configured:`,
      "ID 1 shoulder_pan -> 2 shoulder_lift -> 3 elbow -> 4 wrist_flex -> 5 wrist_roll -> 6 gripper",
      "",
      "Motor setup finished. You can continue to calibration.",
    );
  };

  // Bare Enter in the terminal = the lerobot "press enter" confirmation.
  const handleEnter = () => {
    if (!isRun) {
      setFeedback("Paste and run the setup command first.");
      return;
    }
    if (allIdsConfigured) {
      if (!armChained) finishSetup();
      return;
    }
    if (!requestedMotor) return;
    if (connectedMotor !== requestedMotor.jointName) {
      appendTerminal(
        `No motor on the bus. Plug in the '${requestedMotor.motorName}' connector first.`,
      );
      setFeedback(
        `Click the glowing ${requestedMotor.label} connector in the 3D view, then press Enter.`,
      );
      return;
    }
    assignCurrentId();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const command = input.trim();
    appendTerminal(`student@so101-lab:~$ ${command}`);
    setInput("");

    if (!isRun) {
      if (command.includes("setup_motors")) {
        runSetupCommand();
      } else if (command.length === 0) {
        setFeedback("Paste the setup command (use Copy), then press Enter.");
      } else {
        appendTerminal(`command not found: ${command}`);
      }
      return;
    }
    if (command.length > 0) {
      appendTerminal("(just press Enter here — no command needed)");
      return;
    }
    handleEnter();
  };

  const resetMission = () => {
    setTerminalLines([
      "student@so101-lab:~$ # Copy the command below, paste it, and press Enter.",
    ]);
    setInput("");
    setConnectedMotor(null);
    setCommandRun({ follower: false, leader: false });
    setChainComplete({ follower: false, leader: false });
    onConfiguredJointsChange(emptyProgress());
    onSetupTargetChange("follower");
    onActiveMotorChange(null);
    setFeedback(null);
  };

  // ---- plain-language wizard content for the current phase ----
  const displayStep = Math.min(stepIndex + 1, assignmentOrder.length);
  let title: string;
  let why: string;
  let hint: string | null = null;

  if (bothChainsComplete) {
    title = "Follower arm fully configured 🎉";
    why =
      "Every motor now has a unique ID and matching baudrate. You're ready to calibrate.";
  } else if (allIdsConfigured) {
    title = "Press Enter to proceed";
    why = "All six motors now have their IDs set.";
    hint = "Press Enter in the terminal.";
  } else if (!isRun) {
    title = "Run the motor setup command";
    why = `This connects the controller board to the ${armLabel(setupTarget).toLowerCase()} arm over the port you found in Stage 1 (${ports[setupTarget]}).`;
    hint = "Copy the command, paste it into the terminal, and press Enter.";
  } else if (connectedMotor === requestedMotor?.jointName) {
    title = `Press Enter to set the ${requestedMotor?.label} ID`;
    why =
      "The board sees exactly one motor, so it knows which to talk to. Pressing Enter writes the ID + baudrate into it.";
    hint = "Press Enter in the terminal.";
  } else {
    title = `Plug in the ${requestedMotor?.label} connector`;
    why =
      "Connect just this motor's loose 3-pin connector to the board — it must be the only one connected.";
    hint = `Click the glowing orange ${requestedMotor?.label} connector in the 3D view.`;
  }

  return (
    <section className="game-card setup-wizard motor-wizard">
      <header className="wizard-head">
        <div className="wizard-eyebrow">
          <span className="wizard-stage">STAGE 2</span>
          <span>Motor ID setup</span>
        </div>
        <div className="wizard-arm-toggle" role="group" aria-label="Arm">
          <button type="button" className="active" aria-pressed disabled>
            Follower arm
            <small>
              {configuredForTarget.length}/{assignmentOrder.length}
            </small>
          </button>
        </div>
      </header>

      <div className="wizard-step-card">
        {!allIdsConfigured && isRun && (
          <span className="wizard-step-counter">
            Step {displayStep} of {assignmentOrder.length}
          </span>
        )}
        <h2>{title}</h2>
        <p className="wizard-why">
          <strong>Why:</strong> {why}
        </p>
        {hint && <p className="wizard-hint">👉 {hint}</p>}
        {feedback && <p className="wizard-error">⚠ {feedback}</p>}
      </div>

      <ol className="wizard-motor-track" aria-label="Motor progress">
        {assignmentOrder.map((motor) => {
          const done = configuredForTarget.includes(motor.jointName);
          const isConnected = connectedMotor === motor.jointName;
          const isActive = isRun && requestedMotor?.jointName === motor.jointName;
          const state = done
            ? "done"
            : isConnected
              ? "connected"
              : isActive
                ? "active"
                : "pending";
          return (
            <li key={motor.jointName} className={`motor-pip ${state}`}>
              <span className="motor-pip-id">{done ? "✓" : motor.id}</span>
              <span className="motor-pip-label">{motor.label}</span>
              <span className="motor-pip-state">
                {done
                  ? `ID ${motor.id}`
                  : isConnected
                    ? "Plugged in"
                    : isActive
                      ? "Connect now"
                      : "Waiting"}
              </span>
            </li>
          );
        })}
      </ol>

      {!isRun && (
        <div className="terminal-command-card">
          <div>
            <span className="terminal-command-label">Copy this command</span>
            <code>{setupCommand(setupTarget)}</code>
          </div>
          <button type="button" className="terminal-copy-btn" onClick={copyCommand}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}

      <div className="terminal-window wizard-terminal always-on">
        <div className="terminal-titlebar">
          <span />
          <span />
          <span />
          <strong>student@so101-lab</strong>
        </div>
        <div className="terminal-output" ref={terminalRef}>
          {terminalLines.map((line, index) => (
            <pre key={`${line}-${index}`}>{line || " "}</pre>
          ))}
        </div>
        <form className="terminal-input-line" onSubmit={handleSubmit}>
          <span className="terminal-prompt">student@so101-lab:~$</span>
          <input
            className="terminal-input"
            value={input}
            spellCheck={false}
            autoComplete="off"
            disabled={bothChainsComplete}
            placeholder={
              bothChainsComplete
                ? "done"
                : !isRun
                  ? "paste the command and press Enter"
                  : "press Enter"
            }
            onChange={(event) => setInput(event.target.value)}
          />
          <button
            className="terminal-enter-button"
            disabled={bothChainsComplete}
            type="submit"
          >
            Enter
          </button>
        </form>
      </div>

      <div className="wizard-actions">
        {bothChainsComplete && (
          <button type="button" className="primary-button" onClick={onComplete}>
            Continue to Calibration
          </button>
        )}
        <button type="button" className="ghost-button" onClick={resetMission}>
          Reset
        </button>
      </div>
    </section>
  );
}
