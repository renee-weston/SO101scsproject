import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import InstructionPopup from "../../components/InstructionPopup";
import {
  createSavedCalibration,
  isCalibrationComplete,
  isNearMidpoint,
  jointConfigs,
  jointOrder,
  updateObservedRange,
} from "./calibrationLogic";
import type {
  CalibrationState,
  JointName,
  JointValues,
  SavedCalibration,
} from "./calibrationTypes";

type CalibrationTarget = "follower" | "leader";

type CalibrationGameProps = {
  jointValues: JointValues;
  leaderJointValues: JointValues;
  onComplete: () => void;
  onConnectionSetupActiveChange?: (active: boolean) => void;
  onHighlightedJointChange: (jointName: JointName | null) => void;
  onHighlightedLeaderJointChange?: (jointName: JointName | null) => void;
  selectedJoint: JointName | null;
  onSelectedJointChange: (jointName: JointName | null) => void;
  onSelectableJointsChange: (jointNames: JointName[]) => void;
  onCalibrationTargetChange?: (target: CalibrationTarget) => void;
};

type TerminalMode = "enter" | "command" | "recording" | "complete";
type TerminalStep =
  | "follower_command"
  | "follower_midpoint"
  | "follower_recording"
  | "leader_command"
  | "leader_midpoint"
  | "leader_recording"
  | "final_confirm"
  | "complete";
type RangeRow = {
  name: JointName;
  min: number;
  pos: number;
  max: number;
};

const terminalPrompt = "(user@so101) $";
const midpointReferenceImage = "/midpoint-reference.png";
const calibrationRangeVideo = "/videos/calibration-range-instruction.mp4";
const followerCommand = `lerobot-calibrate --robot.type=so101_follower \\
--robot.port=/dev/ttyACM0 \\
--robot.id=my_awesome_follower_arm`;
const leaderCommand = `lerobot-calibrate --robot.type=so101_leader \\
--robot.port=/dev/ttyACM1 \\
--robot.id=my_awesome_leader_arm`;
const midpointJointOrder = jointOrder;
const compactJointLabels: Record<JointName, string> = {
  shoulder_pan: "SP",
  shoulder_lift: "SL",
  elbow_flex: "EF",
  wrist_flex: "WF",
  wrist_roll: "WR",
  gripper: "GR",
};

const normalizeCommand = (value: string) =>
  value.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();

const formatTableValue = (value: number) => String(Math.round(value)).padStart(4, " ");

const formatRangeTable = (rows: RangeRow[]) => [
  "NAME            MIN     POS     MAX",
  ...rows.map((row) => {
    const name = row.name.padEnd(15, " ");

    return `${name} ${formatTableValue(row.min)}    ${formatTableValue(row.pos)}    ${formatTableValue(row.max)}`;
  }),
];

const getLimitProgress = (
  state: CalibrationState[JointName] | undefined,
  jointName: JointName,
) => {
  if (!state) {
    return {
      minReached: false,
      maxReached: false,
    };
  }

  const config = jointConfigs[jointName];
  const range = config.max - config.min;
  const limitTolerance = Math.max(config.tolerance, range * 0.12);

  return {
    minReached:
      state.reachedMinimum || state.observedMin <= config.min + limitTolerance,
    maxReached:
      state.reachedMaximum || state.observedMax >= config.max - limitTolerance,
  };
};

const createObservedCalibration = (jointValues: JointValues): CalibrationState =>
  jointOrder.reduce((calibration, jointName) => {
    const config = jointConfigs[jointName];
    const value = jointValues[jointName];

    calibration[jointName] = updateObservedRange(
      {
        observedMin: value,
        observedMax: value,
        reachedMinimum: false,
        reachedMaximum: false,
      },
      value,
      config,
    );

    return calibration;
  }, {} as CalibrationState);

const updateObservedCalibration = (
  calibration: CalibrationState,
  jointValues: JointValues,
): CalibrationState =>
  jointOrder.reduce((nextCalibration, jointName) => {
    nextCalibration[jointName] = updateObservedRange(
      calibration[jointName],
      jointValues[jointName],
      jointConfigs[jointName],
    );

    return nextCalibration;
  }, {} as CalibrationState);

const findMidpointIssue = (jointValues: JointValues) =>
  midpointJointOrder.find(
    (jointName) =>
      !isNearMidpoint(jointValues[jointName], jointConfigs[jointName]),
  ) ?? null;

const findRangeIssue = (calibration: CalibrationState | null) => {
  if (!calibration) {
    return jointOrder[0];
  }

  return (
    jointOrder.find((jointName) => {
      const state = calibration[jointName];

      return !state.reachedMinimum || !state.reachedMaximum;
    }) ?? null
  );
};

const createRowsFromLiveState = (
  calibration: CalibrationState,
  jointValues: JointValues,
): RangeRow[] =>
  jointOrder.map((jointName) => ({
    name: jointName,
    min: calibration[jointName].observedMin,
    pos: jointValues[jointName],
    max: calibration[jointName].observedMax,
  }));

const saveProfile = (storageKey: string, calibration: CalibrationState) => {
  const saved = createSavedCalibration(calibration);

  window.localStorage.setItem(storageKey, JSON.stringify(saved));

  return saved;
};

const copyTextFallback = (text: string) => {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-9999px";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  const copied = document.execCommand("copy");
  document.body.removeChild(textArea);

  return copied;
};

export default function CalibrationGame({
  jointValues,
  leaderJointValues,
  onComplete,
  onConnectionSetupActiveChange,
  onHighlightedJointChange,
  onHighlightedLeaderJointChange,
  onSelectedJointChange,
  onSelectableJointsChange,
  onCalibrationTargetChange,
}: CalibrationGameProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const streamTimersRef = useRef<number[]>([]);
  const followerValuesRef = useRef(jointValues);
  const leaderValuesRef = useRef(leaderJointValues);
  const [step, setStep] = useState<TerminalStep>("follower_command");
  const [terminalLines, setTerminalLines] = useState<string[]>([
    "SO-101Follower connected on /dev/ttyACM0",
  ]);
  const [terminalInput, setTerminalInput] = useState("");
  const [showLiveRecordingTable, setShowLiveRecordingTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeArm, setActiveArm] = useState<CalibrationTarget>("follower");
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const [followerCalibration, setFollowerCalibration] =
    useState<CalibrationState | null>(null);
  const [leaderCalibration, setLeaderCalibration] =
    useState<CalibrationState | null>(null);
  const [savedFollower, setSavedFollower] = useState<SavedCalibration | null>(
    null,
  );
  const [savedLeader, setSavedLeader] = useState<SavedCalibration | null>(null);
  const connectionGameComplete = true;
  const [showMidpointReference, setShowMidpointReference] = useState(false);
  const [midpointReferenceViewed, setMidpointReferenceViewed] = useState<
    Record<CalibrationTarget, boolean>
  >({ follower: false, leader: false });
  const [rangeInstructionTarget, setRangeInstructionTarget] =
    useState<CalibrationTarget | null>(null);
  const [rangeInstructionViewed, setRangeInstructionViewed] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const mode: TerminalMode = useMemo(() => {
    if (step === "complete") {
      return "complete";
    }

    if (step === "follower_command" || step === "leader_command") {
      return "command";
    }

    if (step === "follower_recording" || step === "leader_recording") {
      return "recording";
    }

    return "enter";
  }, [step]);
  const activeCommand = step === "leader_command" ? leaderCommand : followerCommand;
  const expectedCommand = normalizeCommand(activeCommand);
  const activeJointValues =
    activeArm === "leader" ? leaderJointValues : jointValues;
  const activeCalibration =
    activeArm === "leader" ? leaderCalibration : followerCalibration;
  const recordingRows =
    mode === "recording" && showLiveRecordingTable && activeCalibration
      ? createRowsFromLiveState(activeCalibration, activeJointValues)
      : null;
  const midpointIssue =
    step === "follower_midpoint" || step === "leader_midpoint"
      ? findMidpointIssue(activeJointValues)
      : null;
  const rangeIssue =
    mode === "recording" ? findRangeIssue(activeCalibration) : null;
  const activeJoint = midpointIssue ?? rangeIssue;
  const progressCount = (savedFollower ? 1 : 0) + (savedLeader ? 1 : 0);
  const showJointProgress =
    connectionGameComplete &&
    (step === "follower_midpoint" ||
      step === "follower_recording" ||
      step === "leader_midpoint" ||
      step === "leader_recording");
  const isMidpointStep =
    step === "follower_midpoint" || step === "leader_midpoint";

  const appendLines = (lines: string[]) => {
    setTerminalLines((current) => [...current, ...lines]);
  };

  const clearStreamTimers = () => {
    streamTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    streamTimersRef.current = [];
  };

  const streamLines = (
    lines: string[],
    onDone?: () => void,
    delay = 430,
  ) => {
    clearStreamTimers();
    setBusy(true);

    lines.forEach((line, index) => {
      const timer = window.setTimeout(() => {
        appendLines([line]);

        if (index === lines.length - 1) {
          setBusy(false);
          onDone?.();
        }
      }, delay * (index + 1));

      streamTimersRef.current.push(timer);
    });
  };

  const showValidation = (message: string) => {
    setValidationMessage(message);
  };

  const startRecording = (target: CalibrationTarget) => {
    const values =
      target === "leader" ? leaderValuesRef.current : followerValuesRef.current;

    setValidationMessage(null);

    if (target === "leader") {
      setLeaderCalibration(createObservedCalibration(values));
    } else {
      setFollowerCalibration(createObservedCalibration(values));
    }

    appendLines(["Recording positions. Press ENTER to stop...", ""]);
    setShowLiveRecordingTable(true);
    setStep(target === "leader" ? "leader_recording" : "follower_recording");
  };

  const stopRecording = () => {
    const currentCalibration =
      activeArm === "leader" ? leaderCalibration : followerCalibration;
    const values =
      activeArm === "leader" ? leaderValuesRef.current : followerValuesRef.current;
    const calibration = currentCalibration
      ? updateObservedCalibration(currentCalibration, values)
      : createObservedCalibration(values);

    if (activeArm === "leader") {
      setLeaderCalibration(calibration);
    } else {
      setFollowerCalibration(calibration);
    }

    if (!isCalibrationComplete(calibration)) {
      showValidation(
        "Error: Calibration incomplete. Move all joints to both minimum and maximum limits.",
      );
      return;
    }

    setShowLiveRecordingTable(false);
    const finalRows = createRowsFromLiveState(calibration, values);

    appendLines(formatRangeTable(finalRows));
    setValidationMessage(null);

    if (activeArm === "follower") {
      streamLines(
        [
          "",
          "Saving follower calibration profile...",
          "Follower calibration complete.",
          "",
          "SO-101Leader connected on /dev/ttyACM1",
        ],
        () => {
          setSavedFollower(
            saveProfile("so101-simulated-follower-calibration", calibration),
          );
          setActiveArm("leader");
          setStep("leader_command");
        },
      );
      return;
    }

    setStep("final_confirm");
    streamLines(
      [
        "",
        "Saving leader calibration profile...",
        "Leader calibration complete.",
        "Both calibration profiles saved.",
        "Press ENTER to finish calibration.",
      ],
      () => {
        const saved = saveProfile(
          "so101-simulated-leader-calibration",
          calibration,
        );

        window.localStorage.setItem(
          "so101-simulated-calibration",
          JSON.stringify(saved),
        );
        setSavedLeader(saved);
      },
    );
  };

  const submitCommand = () => {
    if (busy) {
      showValidation("Error: Wait for the current calibration output to finish.");
      return;
    }

    setValidationMessage(null);

    if (mode === "command") {
      const normalizedInput = normalizeCommand(terminalInput);

      if (normalizedInput !== expectedCommand) {
        showValidation(
          "Error: Paste and run the exact calibration command before continuing.",
        );
        return;
      }

      appendLines([activeCommand]);
      setTerminalInput("");

      if (step === "follower_command") {
        streamLines(
          [
            "Running calibration of my_awesome_follower_arm SO101Follower",
            "Move all joints sequentially through their entire ranges of motion and press ENTER...",
            "Move all joints, including gripper, to the middle of their range of motion and press ENTER.",
          ],
          () => {
            setStep("follower_midpoint");
            setShowMidpointReference(true);
          },
        );
        return;
      }

      streamLines(
        [
          "Running calibration of my_awesome_leader_arm SO101Leader",
          "Move leader arm, including gripper, to midpoint of all joints and press ENTER...",
        ],
        () => {
          setMidpointReferenceViewed((current) => ({
            ...current,
            leader: true,
          }));
          setStep("leader_midpoint");
        },
      );
      return;
    }

    if (mode === "recording") {
      stopRecording();
      return;
    }

    if (mode === "complete") {
      return;
    }

    if (terminalInput.trim()) {
      showValidation("Error: This calibration step is waiting for ENTER only.");
      setTerminalInput("");
      return;
    }

    if (step === "follower_midpoint") {
      if (findMidpointIssue(jointValues)) {
        showValidation(
          "Error: Move all joints to midpoint before continuing calibration.",
        );
        return;
      }

      if (rangeInstructionViewed) {
        startRecording("follower");
      } else {
        setRangeInstructionTarget("follower");
      }
      return;
    }

    if (step === "leader_midpoint") {
      if (findMidpointIssue(leaderJointValues)) {
        showValidation(
          "Error: Move all joints to midpoint before continuing calibration.",
        );
        return;
      }

      if (rangeInstructionViewed) {
        startRecording("leader");
      } else {
        setRangeInstructionTarget("leader");
      }
      return;
    }

    if (step === "final_confirm") {
      appendLines(["Calibration saved.", "Calibration complete.", terminalPrompt]);
      setStep("complete");
    }
  };

  const copyCommand = async () => {
    let copied = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(activeCommand);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      copied = copyTextFallback(activeCommand);
    }

    if (copied) {
      const copiedValue = activeCommand;
      setCopiedCommand(copiedValue);
      window.setTimeout(() => {
        setCopiedCommand((current) => (current === copiedValue ? null : current));
      }, 1600);
    } else {
      setCopiedCommand(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitCommand();
    }
  };

  useEffect(() => {
    followerValuesRef.current = jointValues;
  }, [jointValues]);

  useEffect(() => {
    leaderValuesRef.current = leaderJointValues;
  }, [leaderJointValues]);

  useEffect(() => {
    onSelectableJointsChange([...jointOrder]);
  }, [onSelectableJointsChange]);

  useEffect(() => {
    onCalibrationTargetChange?.(activeArm);
  }, [activeArm, onCalibrationTargetChange]);

  useEffect(() => {
    onConnectionSetupActiveChange?.(!connectionGameComplete);

    return () => onConnectionSetupActiveChange?.(false);
  }, [connectionGameComplete, onConnectionSetupActiveChange]);

  useEffect(() => {
    if (activeArm === "leader") {
      onHighlightedJointChange(null);
      onHighlightedLeaderJointChange?.(activeJoint);
    } else {
      onHighlightedJointChange(activeJoint);
      onHighlightedLeaderJointChange?.(null);
    }

    onSelectedJointChange(activeJoint);
  }, [
    activeArm,
    activeJoint,
    onHighlightedJointChange,
    onHighlightedLeaderJointChange,
    onSelectedJointChange,
  ]);

  useEffect(() => {
    if (mode !== "recording") {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (activeArm === "leader") {
        setLeaderCalibration((current) =>
          current
            ? updateObservedCalibration(current, leaderValuesRef.current)
            : createObservedCalibration(leaderValuesRef.current),
        );
        return;
      }

      setFollowerCalibration((current) =>
        current
          ? updateObservedCalibration(current, followerValuesRef.current)
          : createObservedCalibration(followerValuesRef.current),
      );
    }, 33);

    return () => window.clearInterval(timer);
  }, [activeArm, mode]);

  useEffect(() => {
    terminalRef.current?.scrollTo({
      top: terminalRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [terminalLines, recordingRows]);

  useEffect(() => {
    return () => {
      clearStreamTimers();
    };
  }, []);

  return (
    <section className="game-card calibration-game calibration-terminal-game">
      <p className="mission-label">MISSION 3</p>
      <h2>Calibrate the SO-101 Arms</h2>

      <div className="calibration-progress">
        <span>Saved Profiles: {progressCount} / 2</span>
        <div>
          <span style={{ width: `${(progressCount / 2) * 100}%` }} />
        </div>
      </div>

      <div className="stage-callout">
        <div className="stage-callout-copy">
          <strong>
            {!connectionGameComplete
              ? "Follower connection"
              : step === "complete"
              ? "Calibration complete"
              : activeArm === "leader"
                ? "Leader calibration"
                : "Follower calibration"}
          </strong>
          <span>
            {!connectionGameComplete
              ? "Connect USB and turn on follower power before opening the terminal"
              : step === "complete"
              ? "Follower and Leader profiles saved"
              : activeJoint
                ? `Move ${jointConfigs[activeJoint].label} now`
                : mode === "command"
                  ? "Paste and run the calibration command"
                  : mode === "recording"
                    ? "Press ENTER in the terminal to continue"
                    : step === "final_confirm"
                      ? "Press ENTER to show the final shell prompt"
                      : "Press ENTER in the terminal to continue"}
          </span>
        </div>

        {showJointProgress && (
          <div
            className="calibration-joint-strip"
            aria-label={`${activeArm} joint calibration progress`}
          >
            {jointOrder.map((jointName) => {
              const state = activeCalibration?.[jointName];
              const { minReached, maxReached } = getLimitProgress(
                state,
                jointName,
              );
              const midpointReached = isNearMidpoint(
                activeJointValues[jointName],
                jointConfigs[jointName],
              );
              const rangeComplete = minReached && maxReached;
              const complete = isMidpointStep ? midpointReached : rangeComplete;
              const firstIndicatorDone = isMidpointStep
                ? midpointReached
                : minReached;
              const secondIndicatorDone = isMidpointStep
                ? midpointReached
                : maxReached;
              const statusText = complete
                ? isMidpointStep
                  ? "midpoint ready"
                  : "done"
                : state
                  ? `needs ${[
                      minReached ? null : "minimum",
                      maxReached ? null : "maximum",
                    ]
                      .filter(Boolean)
                      .join(" and ")}`
                  : midpointReached
                    ? "midpoint ready"
                    : "needs midpoint";

              return (
                <span
                  className={`calibration-joint-token ${
                    complete ? "complete" : ""
                  } ${activeJoint === jointName ? "active" : ""}`}
                  key={jointName}
                  title={`${jointConfigs[jointName].label}: ${statusText}`}
                >
                  <span>{compactJointLabels[jointName]}</span>
                  <i className={firstIndicatorDone ? "done" : ""} />
                  <i className={secondIndicatorDone ? "done" : ""} />
                </span>
              );
            })}
          </div>
        )}
      </div>

      {validationMessage && (
        <div className="calibration-validation-error" role="alert">
          {validationMessage}
        </div>
      )}

      {connectionGameComplete && mode === "command" && (
        <div className="terminal-command-card calibration-command-card">
          <div>
            <span className="terminal-command-label">Copy this command</span>
            <code>{activeCommand}</code>
          </div>
          <button
            type="button"
            className="terminal-copy-btn"
            onClick={copyCommand}
          >
            {copiedCommand === activeCommand ? "Copied!" : "Copy Command"}
          </button>
        </div>
      )}

      {connectionGameComplete && (
        <div
          className="terminal-window calibration-terminal"
          onClick={() =>
            document.getElementById("calibration-terminal-input")?.focus()
          }
        >
          <div className="terminal-titlebar">
            <span />
            <span />
            <span />
            <strong>user@so101</strong>
          </div>
          <div className="terminal-output" ref={terminalRef}>
            {terminalLines.map((line, index) => (
              <pre key={`${line}-${index}`}>{line}</pre>
            ))}
            {recordingRows && (
              <div className="terminal-live-table">
                {formatRangeTable(recordingRows).map((line) => (
                  <pre key={line}>{line}</pre>
                ))}
              </div>
            )}
          </div>
          {mode !== "complete" && (
            <form
              className="terminal-input-line terminal-input-line-textarea"
              onSubmit={(event) => {
                event.preventDefault();
                submitCommand();
              }}
            >
              <textarea
                id="calibration-terminal-input"
                className="terminal-input terminal-textarea"
                value={terminalInput}
                disabled={busy && mode !== "recording"}
                onChange={(event) => setTerminalInput(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  mode === "command"
                    ? "Paste calibration command"
                    : "Press Enter"
                }
                rows={mode === "command" ? 3 : 1}
              />
              <button
                className="terminal-enter-button"
                disabled={busy && mode !== "recording"}
                type="submit"
              >
                Enter
              </button>
            </form>
          )}
        </div>
      )}

      {mode === "recording" && (
        <aside
          className="operation-midpoint-reference range-side-reference"
          aria-label="Range calibration video reference"
        >
          <video
            controls
            muted
            playsInline
            preload="metadata"
            src={calibrationRangeVideo}
          >
            Your browser does not support the calibration instruction video.
          </video>
          <div>
            <strong>Range guide</strong>
            <span>Move each joint to both safe limits.</span>
          </div>
        </aside>
      )}

      {connectionGameComplete &&
        mode !== "recording" &&
        midpointReferenceViewed[activeArm] &&
        !showMidpointReference &&
        step !== "complete" && (
        <aside
          className="operation-midpoint-reference"
          aria-label="Midpoint pose reference"
        >
          <img
            alt="SO-101 arm in neutral midpoint calibration pose"
            src={midpointReferenceImage}
          />
          <div>
            <strong>Midpoint reference</strong>
            <span>
              {activeArm === "leader"
                ? "Do the same procedure again for the leader arm."
                : "Match this pose during calibration."}
            </span>
          </div>
        </aside>
      )}

      {step === "complete" && savedFollower && savedLeader && (
        <div className="completion-banner">
          <strong>Calibration complete.</strong>
          <span>Follower and Leader profiles were saved.</span>
          <button type="button" onClick={onComplete}>
            Finish Stage 3
          </button>
        </div>
      )}

      {showMidpointReference && (
        <InstructionPopup
          onNext={() => {
            setMidpointReferenceViewed((current) => ({
              ...current,
              [activeArm]: true,
            }));
            setShowMidpointReference(false);
          }}
          nextLabel="Start Calibration"
          overlayClassName="static-instruction-overlay"
          showBack={false}
          stepLabel="Instruction Mode"
          title="Midpoint Pose Reference"
        >
          <div className="midpoint-reference-card">
            <img
              alt="SO-101 arm in neutral midpoint calibration pose"
              src={midpointReferenceImage}
            />
            <div>
              <p>This is the neutral center pose of the robot.</p>
              <p>
                All joints should be positioned in the middle of their safe
                range before live calibration begins.
              </p>
            </div>
          </div>
        </InstructionPopup>
      )}

      {rangeInstructionTarget && (
        <InstructionPopup
          onNext={() => {
            const target = rangeInstructionTarget;

            setRangeInstructionViewed(true);
            setRangeInstructionTarget(null);
            startRecording(target);
          }}
          nextLabel="Start Range Recording"
          overlayClassName="range-video-overlay"
          showBack={false}
          stepLabel="Calibration Guide"
          title="Move Through Full Range"
        >
          <div className="range-video-card">
            <video
              controls
              playsInline
              preload="metadata"
              src={calibrationRangeVideo}
            >
              Your browser does not support the calibration instruction video.
            </video>
            <p>
              Move each joint to both safe limits so the simulator can record
              the minimum and maximum positions.
            </p>
          </div>
        </InstructionPopup>
      )}
    </section>
  );
}
