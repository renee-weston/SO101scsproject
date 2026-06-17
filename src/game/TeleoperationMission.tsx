import { useState, type KeyboardEvent } from "react";
import InstructionPopup from "../components/InstructionPopup";
import {
  formatJointValue,
  jointConfigs,
  jointOrder,
} from "./calibration/calibrationLogic";
import type { JointName, JointValues } from "./calibration/calibrationTypes";

type TeleoperationMissionProps = {
  active: boolean;
  demonstratedJoints: JointName[];
  leaderJointValues: JointValues;
  followerJointValues: JointValues;
  selectedJoint: JointName | null;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onPreviewJointChange?: (jointName: JointName | null) => void;
};

const teleoperationCommand = `lerobot-teleoperate \\
  --robot.type=so101_follower \\
  --robot.port=/dev/ttyACM0 \\
  --robot.id=follower_arm \\
  --teleop.type=so101_leader \\
  --teleop.port=/dev/ttyACM1 \\
  --teleop.id=leader_arm`;

const normalizedCommand =
  "lerobot-teleoperate --robot.type=so101_follower --robot.port=/dev/ttyACM0 --robot.id=follower_arm --teleop.type=so101_leader --teleop.port=/dev/ttyACM1 --teleop.id=leader_arm";

const normalizeCommand = (value: string) =>
  value.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();

const teleopTutorialSteps = [
  "Leader vs Follower",
  "Control Mapping",
  "Motion Preview",
  "Activate Teleoperation",
  "Try It Yourself",
];

function TeleopArmImage({ role }: { role: "leader" | "follower" }) {
  return (
    <div className={`teleop-arm-image ${role}`} role="img">
      <span className="teleop-arm-base" />
      <span className="teleop-arm-link link-a" />
      <span className="teleop-arm-link link-b" />
      <span className="teleop-arm-link link-c" />
      <span className="teleop-arm-joint joint-a" />
      <span className="teleop-arm-joint joint-b" />
      <span className="teleop-arm-gripper" />
      <strong>{role === "leader" ? "LEADER" : "FOLLOWER"}</strong>
    </div>
  );
}

function LeaderFollowerAnimation() {
  return (
    <div className="leader-follower-animation" role="img">
      <TeleopArmImage role="leader" />
      <span className="teleop-signal-line" />
      <TeleopArmImage role="follower" />
    </div>
  );
}

function TeleopDragAnimation() {
  return (
    <div className="teleop-drag-animation" role="img">
      <span className="drag-hand">DRAG</span>
      <LeaderFollowerAnimation />
    </div>
  );
}

export default function TeleoperationMission({
  active,
  demonstratedJoints,
  leaderJointValues,
  followerJointValues,
  selectedJoint,
  onStart,
  onStop,
  onReset,
  onPreviewJointChange,
}: TeleoperationMissionProps) {
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [commandWasPasted, setCommandWasPasted] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [tutorialIndex, setTutorialIndex] = useState(0);
  const [showTutorial, setShowTutorial] = useState(true);
  const complete = demonstratedJoints.length === jointOrder.length;
  const canSubmitCommand =
    commandWasPasted && normalizeCommand(terminalInput) === normalizedCommand;

  const copyCommand = async () => {
    await navigator.clipboard.writeText(teleoperationCommand);
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 1400);
  };

  const submitCommand = () => {
    if (normalizeCommand(terminalInput) !== normalizedCommand) {
      setTerminalLines((current) => [
        ...current,
        "Unable to start teleoperation.",
        "Check the Leader arm type, Follower arm type, ports, and IDs.",
      ]);
      return;
    }

    if (!commandWasPasted) {
      setTerminalLines((current) => [
        ...current,
        "Paste the copied teleoperation command before pressing Enter.",
      ]);
      return;
    }

    setTerminalLines((current) => [
      ...current,
      `student@so101-lab:~$ ${normalizeCommand(terminalInput)}`,
      "",
      "Connecting to SO-101 follower arm...",
      "Follower arm connected: follower_arm",
      "",
      "Connecting to SO-101 leader arm...",
      "Leader arm connected: leader_arm",
      "",
      "Teleoperation active.",
      "Move the Leader arm to control the Follower arm.",
    ]);
    setTerminalInput("");
    setCommandWasPasted(false);
    onStart();
    setTutorialIndex(4);
    setShowTutorial(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitCommand();
    }
  };

  const stopTeleoperation = () => {
    onStop();
    setTerminalLines((current) => [...current, "", "Teleoperation stopped."]);
  };

  const resetMission = () => {
    setTerminalInput("");
    setTerminalLines([]);
    setCommandWasPasted(false);
    setCopyState("idle");
    setTutorialIndex(0);
    setShowTutorial(true);
    onPreviewJointChange?.(null);
    onReset();
  };

  const moveTutorialForward = () => {
    if (tutorialIndex < teleopTutorialSteps.length - 1) {
      setTutorialIndex((current) => current + 1);
      return;
    }

    setShowTutorial(false);
    onPreviewJointChange?.(null);
  };

  const moveTutorialBack = () => {
    setTutorialIndex((current) => Math.max(0, current - 1));
    onPreviewJointChange?.(null);
  };

  const renderTutorialVisual = () => {
    if (tutorialIndex === 0) {
      return (
        <>
          <LeaderFollowerAnimation />
          <p>
            Move the black Leader arm by hand. The white Follower arm responds
            with the same joint motion.
          </p>
        </>
      );
    }

    if (tutorialIndex === 1) {
      return (
        <div className="teleop-mapping-table">
          {jointOrder.map((jointName) => (
            <button
              key={jointName}
              onBlur={() => onPreviewJointChange?.(null)}
              onFocus={() => onPreviewJointChange?.(jointName)}
              onMouseEnter={() => onPreviewJointChange?.(jointName)}
              onMouseLeave={() => onPreviewJointChange?.(null)}
              type="button"
            >
              <span>{jointName}</span>
              <strong>Leader to Follower</strong>
              <span>{jointName}</span>
            </button>
          ))}
        </div>
      );
    }

    if (tutorialIndex === 2) {
      return (
        <>
          <TeleopDragAnimation />
          <p>
            The Leader is the input. The Follower is the output. The motion
            should look synchronized while teleoperation is active.
          </p>
        </>
      );
    }

    if (tutorialIndex === 3) {
      return (
        <div className="teleop-activation-preview">
          <button type="button" onClick={copyCommand}>
            {copyState === "copied" ? "Copied" : "Copy Command"}
          </button>
          <pre>{teleoperationCommand}</pre>
          <ol>
            <li>Copy command</li>
            <li>Paste into terminal</li>
            <li>Press Enter</li>
            <li>System connects both arms</li>
          </ol>
        </div>
      );
    }

    return (
      <>
        <TeleopDragAnimation />
        <p>Click and drag highlighted Leader joints to control the robot.</p>
      </>
    );
  };

  return (
    <section className="game-card teleoperation-game">
      <p className="mission-label">MISSION 4</p>
      <h2>Teleoperate the Follower Arm</h2>

      <div className={`teleop-status-banner ${active ? "active" : ""}`}>
        <span>{active ? "TELEOPERATION ACTIVE" : "TELEOPERATION DISABLED"}</span>
        <strong>
          Teleoperation Test: {demonstratedJoints.length} / {jointOrder.length}
        </strong>
      </div>

      <div className="setup-command-card">
        <pre>{teleoperationCommand}</pre>
        <button type="button" onClick={copyCommand}>
          {copyState === "copied" ? "Copied" : "Copy Command"}
        </button>
      </div>

      <div
        className="terminal-window"
        onClick={() => document.getElementById("teleop-terminal-input")?.focus()}
      >
        <div className="terminal-titlebar">
          <span />
          <span />
          <span />
          <strong>student@so101-lab</strong>
        </div>
        <div className="terminal-output">
          {terminalLines.map((line, index) => (
            <pre key={`${line}-${index}`}>{line}</pre>
          ))}
          {!active && !complete && (
            <label className="terminal-prompt">
              <span>student@so101-lab:~$</span>
              <textarea
                id="teleop-terminal-input"
                value={terminalInput}
                onChange={(event) => {
                  setTerminalInput(event.currentTarget.value);
                  if (!event.currentTarget.value) {
                    setCommandWasPasted(false);
                  }
                }}
                onKeyDown={handleKeyDown}
                onPaste={() => setCommandWasPasted(true)}
                placeholder="Paste teleoperation command here"
                rows={2}
              />
              <button disabled={!canSubmitCommand} type="button" onClick={submitCommand}>
                Enter
              </button>
            </label>
          )}
        </div>
      </div>

      <div className="teleop-readout">
        <div>
          <strong>Selected Leader Joint</strong>
          <span>{selectedJoint ? jointConfigs[selectedJoint].label : "None"}</span>
        </div>
        <div>
          <strong>Leader Angle</strong>
          <span>
            {selectedJoint
              ? formatJointValue(leaderJointValues[selectedJoint], jointConfigs[selectedJoint])
              : "--"}
          </span>
        </div>
        <div>
          <strong>Follower Angle</strong>
          <span>
            {selectedJoint
              ? formatJointValue(followerJointValues[selectedJoint], jointConfigs[selectedJoint])
              : "--"}
          </span>
        </div>
      </div>

      {complete && (
        <div className="stage-callout">
          <strong>Teleoperation successful.</strong>
          <span>
            The Follower arm responded correctly to all Leader-arm controls.
          </span>
        </div>
      )}

      <div className="teleop-joint-progress">
        {jointOrder.map((jointName) => (
          <div
            className={`motor-status-row ${
              demonstratedJoints.includes(jointName) ? "complete" : ""
            }`}
            key={jointName}
          >
            <strong>{jointConfigs[jointName].label}</strong>
            <span>
              {demonstratedJoints.includes(jointName)
                ? "Demonstrated"
                : active
                  ? "Move Leader joint"
                  : "Waiting"}
            </span>
          </div>
        ))}
      </div>

      <div className="button-row">
        <button
          className="secondary-button"
          disabled={!active}
          onClick={stopTeleoperation}
          type="button"
        >
          Stop Teleoperation
        </button>
        <button className="secondary-button" onClick={resetMission} type="button">
          Reset Mission
        </button>
      </div>

      {showTutorial && (
        <InstructionPopup
          onBack={tutorialIndex > 0 ? moveTutorialBack : undefined}
          onNext={moveTutorialForward}
          nextLabel={
            tutorialIndex === 3
              ? "Open Terminal"
              : tutorialIndex === 4
                ? "Try It"
                : "Next"
          }
          showBack={tutorialIndex > 0 && tutorialIndex < 4}
          stepLabel={`Step ${tutorialIndex + 1} / ${teleopTutorialSteps.length}`}
          title={teleopTutorialSteps[tutorialIndex]}
        >
          {renderTutorialVisual()}
        </InstructionPopup>
      )}
    </section>
  );
}
