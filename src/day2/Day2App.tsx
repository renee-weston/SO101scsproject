import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import "./Day2App.css";

type StageId = "record" | "inspect" | "train" | "evaluate";
type TrainingCommandMode = "gpu" | "cpu" | "resume";
type QualityDecision = "keep" | "rerecord";

type Stage = {
  id: StageId;
  title: string;
  description: string;
  checks: string[];
  initialLines: string[];
};

type RecordConfig = {
  datasetRepo: string;
  episodeCount: number;
  task: string;
  frontCamera: string;
  sideCamera: string;
};

const genericValues = {
  followerPort: "/dev/ttyACM0",
  leaderPort: "/dev/ttyACM1",
  followerId: "so101_follower",
  leaderId: "so101_leader",
  frontCamera: "/dev/video3",
  sideCamera: "/dev/video5",
  datasetRepo: "${HF_USER}/so101-cube-dataset",
  evalDatasetRepo: "${HF_USER}/eval_so101_cube",
  policyOutputDir: "outputs/train/act_so101_cube",
  policyJobName: "act_so101_cube",
  policyRepo: "${HF_USER}/act_so101_cube",
  task: "Grab the black cube",
};

const stages: Stage[] = [
  {
    id: "record",
    title: "Record Demonstration Dataset",
    description:
      "The robot learns from human demonstrations. During recording, LeRobot saves camera images, joint positions, actions, the task description, and the episode number.",
    checks: [
      "Teleoperation command accepted",
      "Front and side cameras configured",
      "Five episodes recorded",
      "Bad demonstrations rejected",
    ],
    initialLines: [
      "student@so101-lab:~$ # Day 2 starts by recording demonstrations.",
      "Good demonstrations make good robots. Bad demonstrations teach bad behavior.",
    ],
  },
  {
    id: "inspect",
    title: "Inspect and Replay Dataset",
    description:
      "Before training, inspect every episode and replay at least one recorded action sequence on the follower arm.",
    checks: [
      "Dataset inspector opened",
      "Episode quality reviewed",
      "Replay command accepted",
      "Replay match score checked",
    ],
    initialLines: [
      "student@so101-lab:~$ # Inspect before training.",
      "If replay looks wrong, check calibration, ports, dataset quality, or camera setup.",
    ],
  },
  {
    id: "train",
    title: "Train ACT Policy",
    description:
      "ACT means Action Chunking with Transformers. It predicts short chunks of future robot actions using camera images and robot joint positions.",
    checks: [
      "Training command accepted",
      "Loss curve monitored",
      "Checkpoint saved",
      "Resume command understood",
    ],
    initialLines: [
      "student@so101-lab:~$ # Train an imitation learning policy.",
      "The policy is not thinking like a human. It learns patterns from demonstration data.",
    ],
  },
  {
    id: "evaluate",
    title: "Run Evaluation / Autonomous Policy",
    description:
      "The leader arm is no longer controlling the robot. The trained policy controls the follower arm, and evaluation episodes are saved separately.",
    checks: [
      "Evaluation command accepted",
      "Safety checklist complete",
      "Autonomous run completed",
      "Evaluation result reviewed",
    ],
    initialLines: [
      "student@so101-lab:~$ # Run the trained policy autonomously.",
      "Keep the first autonomous run slow, simple, and supervised.",
    ],
  },
];

const defaultRecordConfig: RecordConfig = {
  datasetRepo: genericValues.datasetRepo,
  episodeCount: 5,
  task: genericValues.task,
  frontCamera: genericValues.frontCamera,
  sideCamera: genericValues.sideCamera,
};

const makeCameraConfig = (frontCamera: string, sideCamera: string) =>
  `"{ front: {type: opencv, index_or_path: ${frontCamera}, width: 640, height: 480, fps: 30}, side: {type: opencv, index_or_path: ${sideCamera}, width: 640, height: 480, fps: 30}}"`;

const makeRecordCommand = (config: RecordConfig) => `lerobot-record \\
  --robot.type=so101_follower \\
  --robot.port=${genericValues.followerPort} \\
  --robot.id=${genericValues.followerId} \\
  --robot.cameras=${makeCameraConfig(config.frontCamera, config.sideCamera)} \\
  --teleop.type=so101_leader \\
  --teleop.port=${genericValues.leaderPort} \\
  --teleop.id=${genericValues.leaderId} \\
  --display_data=true \\
  --dataset.repo_id=${config.datasetRepo} \\
  --dataset.num_episodes=${config.episodeCount} \\
  --dataset.single_task="${config.task}" \\
  --dataset.streaming_encoding=true \\
  --dataset.encoder_threads=2`;

const replayCommand = `lerobot-replay \\
  --robot.type=so101_follower \\
  --robot.port=${genericValues.followerPort} \\
  --robot.id=${genericValues.followerId} \\
  --dataset.repo_id=${genericValues.datasetRepo} \\
  --dataset.episode=0`;

const gpuTrainingCommand = `lerobot-train \\
  --dataset.repo_id=${genericValues.datasetRepo} \\
  --policy.type=act \\
  --output_dir=${genericValues.policyOutputDir} \\
  --job_name=${genericValues.policyJobName} \\
  --policy.device=cuda \\
  --wandb.enable=true \\
  --policy.repo_id=${genericValues.policyRepo}`;

const cpuTrainingCommand = `lerobot-train \\
  --dataset.repo_id=${genericValues.datasetRepo} \\
  --policy.type=act \\
  --output_dir=${genericValues.policyOutputDir} \\
  --job_name=${genericValues.policyJobName} \\
  --policy.device=cpu \\
  --wandb.enable=false \\
  --policy.push_to_hub=false`;

const resumeTrainingCommand = `lerobot-train \\
  --config_path=${genericValues.policyOutputDir}/checkpoints/last/pretrained_model/train_config.json \\
  --resume=true`;

const evaluationCommand = `lerobot-record \\
  --robot.type=so101_follower \\
  --robot.port=${genericValues.followerPort} \\
  --robot.id=${genericValues.followerId} \\
  --robot.cameras=${makeCameraConfig(genericValues.frontCamera, genericValues.sideCamera)} \\
  --display_data=true \\
  --dataset.repo_id=${genericValues.evalDatasetRepo} \\
  --dataset.num_episodes=10 \\
  --dataset.single_task="${genericValues.task}" \\
  --dataset.streaming_encoding=true \\
  --dataset.encoder_threads=2 \\
  --policy.path=${genericValues.policyOutputDir}/checkpoints/last/pretrained_model`;

const qualityExamples: {
  label: string;
  expected: QualityDecision;
  reason: string;
}[] = [
  {
    label: "Smooth successful grasp",
    expected: "keep",
    reason: "The action solves the task cleanly.",
  },
  {
    label: "Dropped object",
    expected: "rerecord",
    reason: "Failed grasps teach the policy a failed behavior.",
  },
  {
    label: "Camera blocked",
    expected: "rerecord",
    reason: "The model needs clear visual observations.",
  },
  {
    label: "Robot collision",
    expected: "rerecord",
    reason: "Unsafe motions should not be copied.",
  },
  {
    label: "Task incomplete",
    expected: "rerecord",
    reason: "The episode does not show the full goal.",
  },
];

const datasetEpisodes = [
  {
    id: 0,
    result: "success",
    note: "Smooth grasp and clean lift",
    match: 96,
  },
  {
    id: 1,
    result: "success",
    note: "Slight pause before closing gripper",
    match: 91,
  },
  {
    id: 2,
    result: "review",
    note: "Object starts near edge of view",
    match: 84,
  },
  {
    id: 3,
    result: "success",
    note: "Good camera framing",
    match: 94,
  },
  {
    id: 4,
    result: "review",
    note: "Motion is usable but less smooth",
    match: 88,
  },
];

const reviewChecklist = [
  "Task label matches the action",
  "Front camera shows gripper and cube",
  "Side camera confirms object height",
  "Joint and action graphs are continuous",
];

const safetyChecklist = [
  "Robot area is clear",
  "Object is in the correct starting position",
  "Cameras are not blocked",
  "Hand is near emergency stop or power switch",
  "No person is too close to the robot",
  "First autonomous run is slow and simple",
];

const initialTerminalLines = () =>
  stages.reduce(
    (lines, stage) => ({
      ...lines,
      [stage.id]: [...stage.initialLines],
    }),
    {} as Record<StageId, string[]>,
  );

const normalizeCommand = (value: string) =>
  value.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();

export default function Day2App() {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const [activeStageIndex, setActiveStageIndex] = useState(0);
  const [completedStages, setCompletedStages] = useState<StageId[]>([]);
  const [acceptedCommands, setAcceptedCommands] = useState<StageId[]>([]);
  const [terminalLines, setTerminalLines] = useState<Record<StageId, string[]>>(
    initialTerminalLines,
  );
  const [terminalInput, setTerminalInput] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "inserted">(
    "idle",
  );
  const [recordConfig, setRecordConfig] = useState(defaultRecordConfig);
  const [episodesRecorded, setEpisodesRecorded] = useState(0);
  const [qualityDecisions, setQualityDecisions] = useState<
    Record<number, QualityDecision>
  >({});
  const [selectedEpisode, setSelectedEpisode] = useState(0);
  const [reviewChecks, setReviewChecks] = useState<number[]>([]);
  const [replayRan, setReplayRan] = useState(false);
  const [trainingMode, setTrainingMode] = useState<TrainingCommandMode>("gpu");
  const [trainingStep, setTrainingStep] = useState(0);
  const [resumeSimulated, setResumeSimulated] = useState(false);
  const [safetyChecks, setSafetyChecks] = useState<number[]>([]);
  const [evaluationRan, setEvaluationRan] = useState(false);

  const activeStage = stages[activeStageIndex];
  const activeStageId = activeStage.id;
  const terminalRows = terminalLines[activeStageId] ?? [];
  const activeCommandAccepted = acceptedCommands.includes(activeStageId);
  const activeStageComplete = completedStages.includes(activeStageId);
  const recordCommand = useMemo(() => makeRecordCommand(recordConfig), [recordConfig]);

  const trainingCommand = useMemo(() => {
    if (trainingMode === "cpu") {
      return cpuTrainingCommand;
    }

    if (trainingMode === "resume") {
      return resumeTrainingCommand;
    }

    return gpuTrainingCommand;
  }, [trainingMode]);

  const activeCommand = useMemo(() => {
    if (activeStageId === "record") {
      return recordCommand;
    }

    if (activeStageId === "inspect") {
      return replayCommand;
    }

    if (activeStageId === "train") {
      return trainingCommand;
    }

    return evaluationCommand;
  }, [activeStageId, recordCommand, trainingCommand]);

  const qualityActivityComplete =
    qualityExamples.length === Object.keys(qualityDecisions).length &&
    qualityExamples.every(
      (example, index) => qualityDecisions[index] === example.expected,
    );

  const selectedEpisodeData = datasetEpisodes[selectedEpisode];
  const replayScore = replayRan ? selectedEpisodeData.match : 0;
  const safetyComplete = safetyChecks.length === safetyChecklist.length;
  const trainingComplete = trainingStep >= 5;

  const completedCheckIndexes = useMemo(() => {
    if (activeStageComplete) {
      return activeStage.checks.map((_, index) => index);
    }

    if (activeStageId === "record") {
      return [
        activeCommandAccepted ? 0 : -1,
        recordConfig.frontCamera && recordConfig.sideCamera ? 1 : -1,
        episodesRecorded >= recordConfig.episodeCount ? 2 : -1,
        qualityActivityComplete ? 3 : -1,
      ].filter((index) => index >= 0);
    }

    if (activeStageId === "inspect") {
      return [
        selectedEpisode >= 0 ? 0 : -1,
        reviewChecks.length === reviewChecklist.length ? 1 : -1,
        activeCommandAccepted ? 2 : -1,
        replayRan ? 3 : -1,
      ].filter((index) => index >= 0);
    }

    if (activeStageId === "train") {
      return [
        activeCommandAccepted ? 0 : -1,
        trainingStep > 0 ? 1 : -1,
        trainingComplete ? 2 : -1,
        resumeSimulated ? 3 : -1,
      ].filter((index) => index >= 0);
    }

    return [
      activeCommandAccepted ? 0 : -1,
      safetyComplete ? 1 : -1,
      evaluationRan ? 2 : -1,
      evaluationRan ? 3 : -1,
    ].filter((index) => index >= 0);
  }, [
    activeCommandAccepted,
    activeStage.checks,
    activeStageComplete,
    activeStageId,
    episodesRecorded,
    evaluationRan,
    qualityActivityComplete,
    recordConfig.episodeCount,
    recordConfig.frontCamera,
    recordConfig.sideCamera,
    replayRan,
    resumeSimulated,
    reviewChecks.length,
    safetyComplete,
    selectedEpisode,
    trainingComplete,
    trainingStep,
  ]);

  useEffect(() => {
    terminalRef.current?.scrollTo({
      top: terminalRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [terminalRows]);

  const appendLines = (...lines: string[]) => {
    setTerminalLines((current) => ({
      ...current,
      [activeStageId]: [...current[activeStageId], ...lines],
    }));
  };

  const markStageComplete = (stageId: StageId) => {
    setCompletedStages((current) =>
      current.includes(stageId) ? current : [...current, stageId],
    );
  };

  const acceptCommand = (stageId: StageId) => {
    setAcceptedCommands((current) =>
      current.includes(stageId) ? current : [...current, stageId],
    );
  };

  const runStageCommand = () => {
    const typedCommand = terminalInput.trim();

    if (!typedCommand) {
      appendLines("No command entered. Paste the command above, then press Enter.");
      return;
    }

    appendLines(`student@so101-lab:~$ ${normalizeCommand(typedCommand)}`);

    if (normalizeCommand(typedCommand) !== normalizeCommand(activeCommand)) {
      appendLines(
        "Command mismatch.",
        "Check the generic ports, robot IDs, dataset repo, task text, cameras, and policy options.",
      );
      setTerminalInput("");
      return;
    }

    acceptCommand(activeStageId);
    setTerminalInput("");

    if (activeStageId === "record") {
      appendLines(
        "Recording session ready.",
        `Follower arm: ${genericValues.followerId} on ${genericValues.followerPort}`,
        `Leader arm: ${genericValues.leaderId} on ${genericValues.leaderPort}`,
        `Cameras: front ${recordConfig.frontCamera}, side ${recordConfig.sideCamera}`,
        "Saving observations: camera images, joint positions, actions, task text, and episode number.",
      );
    }

    if (activeStageId === "inspect") {
      appendLines(
        "Replay command accepted.",
        `Loading episode ${selectedEpisode} from ${genericValues.datasetRepo}.`,
        "Ready to compare recorded motion with replayed motion.",
      );
    }

    if (activeStageId === "train") {
      appendLines(
        trainingMode === "resume"
          ? "Resume command accepted."
          : `${trainingMode.toUpperCase()} training command accepted.`,
        "Camera images + joint positions -> ACT policy -> future action chunk -> robot movement.",
        `Checkpoint target: ${genericValues.policyOutputDir}/checkpoints/last/pretrained_model`,
      );
      if (trainingMode === "resume") {
        setResumeSimulated(true);
      }
    }

    if (activeStageId === "evaluate") {
      appendLines(
        "Evaluation command accepted.",
        "policy.path loaded the trained model.",
        "Leader arm is not controlling the robot during autonomous evaluation.",
      );
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(activeCommand);
      setCopyState("copied");
    } catch {
      setTerminalInput(activeCommand);
      setCopyState("inserted");
    }

    window.setTimeout(() => setCopyState("idle"), 1300);
  };

  const submitTerminal = (event: FormEvent) => {
    event.preventDefault();
    runStageCommand();
  };

  const handleTerminalKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runStageCommand();
    }
  };

  const selectStage = (stageIndex: number) => {
    setActiveStageIndex(stageIndex);
    setTerminalInput("");
    setCopyState("idle");
  };

  const updateRecordConfig = <Key extends keyof RecordConfig>(
    key: Key,
    value: RecordConfig[Key],
  ) => {
    setRecordConfig((current) => ({ ...current, [key]: value }));
  };

  const recordEpisode = () => {
    if (!activeCommandAccepted) {
      appendLines("Run the recording command before collecting episodes.");
      return;
    }

    const nextCount = Math.min(recordConfig.episodeCount, episodesRecorded + 1);
    setEpisodesRecorded(nextCount);
    appendLines(
      `Episode ${nextCount} recorded.`,
      nextCount < recordConfig.episodeCount
        ? "Right Arrow finishes an episode. Reset the scene before the next one."
        : "All requested episodes recorded.",
    );

    if (nextCount === recordConfig.episodeCount && qualityActivityComplete) {
      appendLines("Dataset recording stage complete.");
      markStageComplete("record");
    }
  };

  const chooseQualityDecision = (index: number, decision: QualityDecision) => {
    const nextDecisions = { ...qualityDecisions, [index]: decision };
    setQualityDecisions(nextDecisions);

    const complete =
      qualityExamples.length === Object.keys(nextDecisions).length &&
      qualityExamples.every(
        (example, exampleIndex) => nextDecisions[exampleIndex] === example.expected,
      );

    if (complete && episodesRecorded >= recordConfig.episodeCount) {
      appendLines("Good data vs bad data activity complete.");
      markStageComplete("record");
    }
  };

  const toggleReviewCheck = (index: number) => {
    if (reviewChecks.includes(index)) {
      return;
    }

    const nextChecks = [...reviewChecks, index];
    setReviewChecks(nextChecks);
    appendLines(`Quality check passed: ${reviewChecklist[index]}`);

    if (
      nextChecks.length === reviewChecklist.length &&
      replayRan &&
      activeCommandAccepted
    ) {
      appendLines("Dataset inspection and replay complete.");
      markStageComplete("inspect");
    }
  };

  const runReplay = () => {
    if (!activeCommandAccepted) {
      appendLines("Run the replay command before starting replay.");
      return;
    }

    setReplayRan(true);
    appendLines(
      `Replay match score: ${selectedEpisodeData.match}%`,
      selectedEpisodeData.match >= 90
        ? "Replay is close to the recorded motion."
        : "Replay mismatch is noticeable. Inspect calibration and dataset quality.",
    );

    if (reviewChecks.length === reviewChecklist.length) {
      markStageComplete("inspect");
    }
  };

  const runCheckpoint = () => {
    if (!activeCommandAccepted) {
      appendLines("Run a training command before checkpoints start.");
      return;
    }

    const lossValues = ["1.82", "1.12", "0.74", "0.51", "0.38"];
    const nextStep = Math.min(5, trainingStep + 1);
    setTrainingStep(nextStep);
    appendLines(`step ${nextStep * 1000}: validation loss ${lossValues[nextStep - 1]}`);

    if (nextStep === 5) {
      appendLines(
        "Training complete.",
        `Policy checkpoint saved to ${genericValues.policyOutputDir}/checkpoints/last/pretrained_model.`,
      );
      markStageComplete("train");
    }
  };

  const simulateResume = () => {
    setTrainingMode("resume");
    setResumeSimulated(true);
    appendLines("Resume mode selected. Copy and run the resume command to continue from the last checkpoint.");
  };

  const toggleSafetyCheck = (index: number) => {
    setSafetyChecks((current) =>
      current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current, index],
    );
  };

  const runAutonomousEvaluation = () => {
    if (!activeCommandAccepted || !safetyComplete) {
      appendLines("Complete the command and every safety check before autonomous evaluation.");
      return;
    }

    setEvaluationRan(true);
    appendLines(
      "Running 10 autonomous evaluation episodes...",
      "Success rate: 7 / 10",
      `Evaluation dataset saved to ${genericValues.evalDatasetRepo}.`,
    );
    markStageComplete("evaluate");
  };

  const renderRecordStage = () => (
    <>
      <div className="day2-builder-grid">
        <label>
          <span>Dataset repo</span>
          <input
            value={recordConfig.datasetRepo}
            onChange={(event) => updateRecordConfig("datasetRepo", event.target.value)}
          />
        </label>
        <label>
          <span>Episodes</span>
          <input
            min={1}
            max={10}
            type="number"
            value={recordConfig.episodeCount}
            onChange={(event) =>
              updateRecordConfig(
                "episodeCount",
                Math.max(1, Math.min(10, Number(event.target.value) || 1)),
              )
            }
          />
        </label>
        <label>
          <span>Task</span>
          <input
            value={recordConfig.task}
            onChange={(event) => updateRecordConfig("task", event.target.value)}
          />
        </label>
        <label>
          <span>Front camera</span>
          <input
            value={recordConfig.frontCamera}
            onChange={(event) => updateRecordConfig("frontCamera", event.target.value)}
          />
        </label>
        <label>
          <span>Side camera</span>
          <input
            value={recordConfig.sideCamera}
            onChange={(event) => updateRecordConfig("sideCamera", event.target.value)}
          />
        </label>
      </div>

      <div className="day2-recording-screen">
        <div className="day2-camera-feed front">
          <strong>front camera</strong>
          <span>{recordConfig.frontCamera}</span>
        </div>
        <div className="day2-camera-feed side">
          <strong>side camera</strong>
          <span>{recordConfig.sideCamera}</span>
        </div>
        <div className="day2-recorder-status">
          <strong>
            Episode {Math.min(episodesRecorded + 1, recordConfig.episodeCount)} /{" "}
            {recordConfig.episodeCount}
          </strong>
          <span>00:{String(episodesRecorded * 4 + 8).padStart(2, "0")}</span>
          <small>Right Arrow: finish · Left Arrow: re-record · ESC: stop</small>
        </div>
      </div>

      <div className="day2-button-row">
        <button
          className="primary-button"
          disabled={episodesRecorded >= recordConfig.episodeCount}
          type="button"
          onClick={recordEpisode}
        >
          Record next episode
        </button>
      </div>

      <div className="day2-quality-grid">
        {qualityExamples.map((example, index) => {
          const decision = qualityDecisions[index];
          const correct = decision === example.expected;

          return (
            <div
              className={`day2-quality-card ${correct ? "correct" : ""} ${
                decision && !correct ? "incorrect" : ""
              }`}
              key={example.label}
            >
              <strong>{example.label}</strong>
              <span>{decision ? example.reason : "Choose what to do with this episode."}</span>
              <div className="day2-button-row">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => chooseQualityDecision(index, "keep")}
                >
                  Keep
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => chooseQualityDecision(index, "rerecord")}
                >
                  Re-record
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  const renderInspectStage = () => (
    <>
      <div className="day2-episode-grid">
        {datasetEpisodes.map((episode) => (
          <button
            className={`day2-episode-card ${
              selectedEpisode === episode.id ? "selected" : ""
            }`}
            key={episode.id}
            type="button"
            onClick={() => {
              setSelectedEpisode(episode.id);
              setReplayRan(false);
            }}
          >
            <span className="day2-thumbnail">front</span>
            <span className="day2-thumbnail side">side</span>
            <strong>Episode {episode.id}</strong>
            <em>{genericValues.task}</em>
            <small className={episode.result}>{episode.result}</small>
          </button>
        ))}
      </div>

      <div className="day2-inspector-panel">
        <div>
          <strong>Episode {selectedEpisode}</strong>
          <span>{selectedEpisodeData.note}</span>
          <div className="day2-frame-timeline" aria-label="Frame timeline">
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} />
            ))}
          </div>
        </div>
        <div className="day2-graph-panel">
          <strong>Joint position graph</strong>
          <div className="day2-mini-graph joint" />
          <strong>Action graph</strong>
          <div className="day2-mini-graph action" />
        </div>
      </div>

      <div className="day2-button-row">
        {reviewChecklist.map((check, index) => (
          <button
            className={reviewChecks.includes(index) ? "primary-button" : "secondary-button"}
            disabled={reviewChecks.includes(index)}
            key={check}
            type="button"
            onClick={() => toggleReviewCheck(index)}
          >
            {reviewChecks.includes(index) ? `Checked: ${check}` : check}
          </button>
        ))}
      </div>

      <div className="day2-replay-panel">
        <div className="day2-replay-track">
          <span className={replayRan ? "moving recorded" : "recorded"} />
          <span className={replayRan ? "moving replayed" : "replayed"} />
        </div>
        <strong>Replay Match Score: {replayScore}%</strong>
        <button className="primary-button" type="button" onClick={runReplay}>
          Run Replay
        </button>
      </div>
    </>
  );

  const renderTrainStage = () => (
    <>
      <div className="day2-act-pipeline">
        <span>Camera images</span>
        <span>Joint positions</span>
        <strong>ACT policy</strong>
        <span>Future action chunk</span>
        <span>Robot movement</span>
      </div>

      <div className="day2-command-tabs">
        {(["gpu", "cpu", "resume"] as const).map((mode) => (
          <button
            className={trainingMode === mode ? "active" : ""}
            key={mode}
            type="button"
            onClick={() => setTrainingMode(mode)}
          >
            {mode === "gpu"
              ? "GPU training"
              : mode === "cpu"
                ? "CPU-friendly"
                : "Resume"}
          </button>
        ))}
      </div>

      <div className="day2-training-dashboard">
        <div>
          <strong>Training step</strong>
          <span>{trainingStep * 1000} / 5000</span>
        </div>
        <div>
          <strong>Checkpoint</strong>
          <span>
            {trainingComplete
              ? `${genericValues.policyOutputDir}/checkpoints/last/pretrained_model`
              : "not saved yet"}
          </span>
        </div>
        <div className="day2-loss-chart">
          {["1.82", "1.12", "0.74", "0.51", "0.38"].map((loss, index) => (
            <i
              className={index < trainingStep ? "active" : ""}
              key={loss}
              style={{ height: `${80 - index * 12}%` }}
              title={`loss ${loss}`}
            />
          ))}
        </div>
      </div>

      <div className="day2-button-row">
        <button
          className="primary-button"
          disabled={trainingStep >= 5}
          type="button"
          onClick={runCheckpoint}
        >
          Run checkpoint
        </button>
        <button className="secondary-button" type="button" onClick={simulateResume}>
          Resume from checkpoint
        </button>
      </div>
    </>
  );

  const renderEvaluateStage = () => (
    <>
      <div className="day2-safety-grid">
        {safetyChecklist.map((check, index) => (
          <label
            className={`day2-safety-item ${
              safetyChecks.includes(index) ? "checked" : ""
            }`}
            key={check}
          >
            <input
              checked={safetyChecks.includes(index)}
              type="checkbox"
              onChange={() => toggleSafetyCheck(index)}
            />
            <span>{check}</span>
          </label>
        ))}
      </div>

      <div className="day2-autonomy-panel">
        <div className={`day2-policy-robot ${evaluationRan ? "running" : ""}`}>
          <span />
          <span />
          <span />
        </div>
        <button
          className="primary-button"
          disabled={!activeCommandAccepted || !safetyComplete || evaluationRan}
          type="button"
          onClick={runAutonomousEvaluation}
        >
          Run Policy
        </button>
      </div>

      {evaluationRan && (
        <div className="day2-result-panel">
          <strong>Evaluation Result</strong>
          <span>Success rate: 7 / 10</span>
          <span>Attempts: 10</span>
          <span>Saved as: {genericValues.evalDatasetRepo}</span>
        </div>
      )}
    </>
  );

  const renderStageActions = () => {
    if (activeStageId === "record") {
      return renderRecordStage();
    }

    if (activeStageId === "inspect") {
      return renderInspectStage();
    }

    if (activeStageId === "train") {
      return renderTrainStage();
    }

    return renderEvaluateStage();
  };

  return (
    <main className="app day2-app">
      <header className="app-header day2-header">
        <div>
          <p className="eyebrow">SO-101 ROBOT LAB</p>
          <h1>SO-101 Day 2: Dataset Recording & Robot Learning</h1>
          <p>
            Teleoperate → Record Dataset → Inspect & Replay → Train Policy → Run
            Autonomously.
          </p>
        </div>
        <a className="day2-back-link" href="/">
          Day 1 Setup
        </a>
      </header>

      <nav className="mission-selector" aria-label="Day 2 stages">
        {stages.map((stage, index) => {
          const stageComplete = completedStages.includes(stage.id);
          const active = activeStageIndex === index;

          return (
            <button
              className={`mission-tab ${active ? "active" : ""} ${
                stageComplete ? "completed" : ""
              }`}
              key={stage.id}
              onClick={() => selectStage(index)}
              type="button"
            >
              <span className="mission-tab-number">
                {stageComplete ? "✓" : index + 1}
              </span>
              <span className="mission-tab-text">
                <span className="mission-tab-eyebrow">Stage {index + 1}</span>
                <span className="mission-tab-title">{stage.title}</span>
              </span>
              <span className="mission-tab-state">
                {stageComplete ? "Done" : active ? "Playing" : "To do"}
              </span>
            </button>
          );
        })}
      </nav>

      <section className="game-layout day2-layout">
        <section className="visual-panel day2-visual-panel">
          <div className="day2-workflow-board">
            <div className="day2-robot-cell">
              <span className="day2-robot-base" />
              <span className="day2-robot-column" />
              <span className="day2-robot-arm lower" />
              <span className="day2-robot-arm upper" />
              <span className="day2-robot-wrist" />
              <span className="day2-robot-gripper" />
            </div>

            <div className="day2-camera-cell">
              <span className="day2-camera-body" />
              <span className="day2-camera-lens" />
              <span className="day2-camera-view" />
            </div>

            <div className="day2-dataset-cell">
              <strong>Dataset</strong>
              <span>{episodesRecorded} / {recordConfig.episodeCount} episodes</span>
              <div className="day2-dataset-stack">
                {Array.from({ length: Math.min(recordConfig.episodeCount, 10) }, (_, index) => (
                  <i
                    className={index < episodesRecorded ? "done" : ""}
                    key={index}
                  />
                ))}
              </div>
            </div>

            <div className="day2-training-cell">
              <strong>Policy Training</strong>
              <span>
                {trainingStep === 0
                  ? "Waiting for data"
                  : trainingStep < 5
                    ? `Checkpoint ${trainingStep} / 5`
                    : "Checkpoint saved"}
              </span>
              <div className="day2-loss-chart">
                {Array.from({ length: 5 }, (_, index) => (
                  <i
                    className={index < trainingStep ? "active" : ""}
                    key={index}
                    style={{ height: `${80 - index * 12}%` }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="visual-status">
            <span>Day 2 progress</span>
            <strong>{completedStages.length} / 4</strong>
          </div>
        </section>

        <section className="content-panel">
          <p className="mission-label">Stage {activeStageIndex + 1}</p>
          <article className="stage-callout day2-stage-card">
            <strong>{activeStage.title}</strong>
            <span>{activeStage.description}</span>
            <div className="day2-stage-checks">
              {activeStage.checks.map((check, index) => (
                <span
                  className={`day2-stage-check ${
                    completedCheckIndexes.includes(index) ? "complete" : ""
                  }`}
                  key={check}
                >
                  {completedCheckIndexes.includes(index) ? "Done: " : ""}
                  {check}
                </span>
              ))}
            </div>
          </article>

          <div className="terminal-command-card">
            <div>
              <span className="terminal-command-label">
                {activeStageId === "train"
                  ? `${trainingMode.toUpperCase()} command`
                  : "Copy this command"}
              </span>
              <code>{activeCommand}</code>
            </div>
            <button
              className="terminal-copy-btn"
              type="button"
              onClick={copyCommand}
            >
              {copyState === "copied"
                ? "Copied"
                : copyState === "inserted"
                  ? "Inserted"
                  : "Copy"}
            </button>
          </div>

          <div className="terminal-window">
            <div className="terminal-titlebar">
              <span />
              <span />
              <span />
              <strong>student@so101-lab</strong>
            </div>
            <div className="terminal-output" ref={terminalRef}>
              {terminalRows.map((line, index) => (
                <pre key={`${line}-${index}`}>{line || " "}</pre>
              ))}
            </div>
            <form
              className="terminal-input-line terminal-input-line-textarea"
              onSubmit={submitTerminal}
            >
              <span className="terminal-prompt">student@so101-lab:~$</span>
              <textarea
                className="terminal-input terminal-textarea"
                value={terminalInput}
                rows={2}
                spellCheck={false}
                placeholder={
                  activeCommandAccepted
                    ? "Command already accepted"
                    : "Paste the command and press Enter"
                }
                onChange={(event) => setTerminalInput(event.currentTarget.value)}
                onKeyDown={handleTerminalKeyDown}
              />
              <button className="terminal-enter-button" type="submit">
                Enter
              </button>
            </form>
          </div>

          <div className="day2-action-panel">{renderStageActions()}</div>
        </section>
      </section>
    </main>
  );
}
