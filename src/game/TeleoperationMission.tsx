import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  canFinishTraining: boolean;
  missingTrainingStages: readonly number[];
  initialShowTutorial?: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onFinishTraining: () => void;
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
const teleoperationInstructionVideo = "/videos/Teleoperation%20instruction.webm";

const normalizeCommand = (value: string) =>
  value.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();

const teleopTutorialSteps = [
  "Teleoperation Mechanism",
  "Move Leader to Control Follower",
  "Activate Teleoperation",
];
const compactJointLabels: Record<JointName, string> = {
  shoulder_pan: "SP",
  shoulder_lift: "SL",
  elbow_flex: "EF",
  wrist_flex: "WF",
  wrist_roll: "WR",
  gripper: "GR",
};

export default function TeleoperationMission({
  active,
  demonstratedJoints,
  leaderJointValues,
  followerJointValues,
  selectedJoint,
  canFinishTraining,
  missingTrainingStages,
  initialShowTutorial = true,
  onStart,
  onStop,
  onReset,
  onFinishTraining,
  onPreviewJointChange,
}: TeleoperationMissionProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [commandWasPasted, setCommandWasPasted] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [tutorialIndex, setTutorialIndex] = useState(0);
  const [showTutorial, setShowTutorial] = useState(initialShowTutorial);
  const complete = demonstratedJoints.length === jointOrder.length;
  const canSubmitCommand =
    commandWasPasted && normalizeCommand(terminalInput) === normalizedCommand;

  useEffect(() => {
    terminalRef.current?.scrollTo({
      top: terminalRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [terminalLines]);

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
    setShowTutorial(false);
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
        <div className="teleop-intro-copy">
          <p>
            Congratulations! You have reached the final stage, and you are
            ready for teleoperation.
          </p>
          <p>
            In this stage, you will move the black Leader arm and watch the
            white Follower arm mirror its motion. This is the same control idea
            used when operating the real SO-101 system.
          </p>
        </div>
      );
    }

    if (tutorialIndex === 1) {
      return (
        <div className="teleop-video-card">
          <video
            controls
            playsInline
            preload="metadata"
            src={teleoperationInstructionVideo}
          >
            Your browser does not support the teleoperation instruction video.
          </video>
          <p>
            Drag the Leader arm to control the Follower arm.
          </p>
        </div>
      );
    }

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
  };

  return (
    <section className="game-card teleoperation-game">
      <p className="mission-label">MISSION 4</p>
      <h2>Teleoperate the Follower Arm</h2>

      <div className={`teleop-status-banner ${active ? "active" : ""}`}>
        <div className="teleop-status-copy">
          <div className="teleop-status-heading">
            <span>
              {active ? "TELEOPERATION ACTIVE" : "TELEOPERATION DISABLED"}
            </span>
            <div
              className="teleop-compact-progress"
              aria-label="Teleoperation joint progress"
            >
              {jointOrder.map((jointName) => {
                const demonstrated = demonstratedJoints.includes(jointName);
                const selected = selectedJoint === jointName;

                return (
                  <span
                    className={`calibration-joint-token ${
                      demonstrated ? "complete" : ""
                    } ${selected ? "active" : ""}`}
                    key={jointName}
                    title={`${jointConfigs[jointName].label}: ${
                      demonstrated ? "demonstrated" : "waiting"
                    }`}
                  >
                    <span>{compactJointLabels[jointName]}</span>
                    <i className={demonstrated ? "done" : ""} />
                    <i className={demonstrated ? "done" : ""} />
                  </span>
                );
              })}
            </div>
          </div>
          <strong>
            Teleoperation Test: {demonstratedJoints.length} / {jointOrder.length}
          </strong>
          <em>
            {complete
              ? "All Leader joints have controlled the Follower arm."
              : active
                ? "Move each Leader joint until its indicator turns green."
                : "Run the teleoperation command to begin controlling the Follower arm."}
          </em>
        </div>
      </div>

      <div className="terminal-command-card">
        <div>
          <span className="terminal-command-label">Copy this command</span>
          <code>{teleoperationCommand}</code>
        </div>
        <button
          type="button"
          className="terminal-copy-btn"
          onClick={copyCommand}
        >
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
        <div className="terminal-output" ref={terminalRef}>
          {terminalLines.map((line, index) => (
            <pre key={`${line}-${index}`}>{line}</pre>
          ))}
        </div>
        {!active && !complete && (
          <form
            className="terminal-input-line terminal-input-line-textarea"
            onSubmit={(event) => {
              event.preventDefault();
              submitCommand();
            }}
          >
            <span className="terminal-prompt">student@so101-lab:~$</span>
            <textarea
              id="teleop-terminal-input"
              className="terminal-input terminal-textarea"
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
            <button
              className="terminal-enter-button"
              disabled={!canSubmitCommand}
              type="submit"
            >
              Enter
            </button>
          </form>
        )}
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
            {canFinishTraining
              ? "The Follower arm responded correctly to all Leader-arm controls."
              : `Complete Stage ${missingTrainingStages.join(", Stage ")} before finishing training.`}
          </span>
          <button
            className="primary-button"
            disabled={!canFinishTraining}
            onClick={canFinishTraining ? onFinishTraining : undefined}
            type="button"
          >
            Finish Training
          </button>
        </div>
      )}

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
          nextLabel={tutorialIndex === 2 ? "Open Terminal" : "Next"}
          showBack={tutorialIndex > 0}
          stepLabel={`Step ${tutorialIndex + 1} / ${teleopTutorialSteps.length}`}
          title={teleopTutorialSteps[tutorialIndex]}
        >
          {renderTutorialVisual()}
        </InstructionPopup>
      )}
    </section>
  );
}
