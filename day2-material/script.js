const stages = [
  {
    title: "Plan the recording session",
    description:
      "Define the task, dataset name, episode length, reset time, and camera framing before collecting any demonstrations.",
    command: `lerobot-record \\
  --robot.type=so101_follower \\
  --robot.port=/dev/ttyACM0 \\
  --teleop.type=so101_leader \\
  --teleop.port=/dev/ttyACM1 \\
  --dataset.repo_id=student/so101_pick_place_day2 \\
  --dataset.single_task="Pick cube and place it in tray" \\
  --num-episodes=1 \\
  --episode-time-s=10 \\
  --reset-time-s=5`,
    checks: [
      "Task name is specific",
      "Camera sees gripper and object",
      "Leader and follower are calibrated",
      "Reset pose is repeatable",
    ],
    initialLines: [
      "student@so101-lab:~$ # Day 2 starts with a planned recording session.",
      "Choose one short task and keep the workspace consistent.",
    ],
  },
  {
    title: "Record demonstration episodes",
    description:
      "Use teleoperation to record multiple clean examples. Each episode should start from the same reset pose and finish with a clear success state.",
    command: `lerobot-record \\
  --robot.type=so101_follower \\
  --robot.port=/dev/ttyACM0 \\
  --teleop.type=so101_leader \\
  --teleop.port=/dev/ttyACM1 \\
  --dataset.repo_id=student/so101_pick_place_day2 \\
  --dataset.single_task="Pick cube and place it in tray" \\
  --num-episodes=5 \\
  --episode-time-s=20 \\
  --reset-time-s=10`,
    checks: [
      "Start from reset pose",
      "Move smoothly",
      "Avoid blocking camera",
      "Record five successful episodes",
    ],
    initialLines: [
      "student@so101-lab:~$ # Record clean demonstrations.",
      "Paste the recording command and press Enter.",
    ],
  },
  {
    title: "Review and curate the dataset",
    description:
      "Inspect the recorded episodes before training. Remove failed episodes, verify labels, and check that image observations are useful.",
    command: `lerobot-dataset-stats \\
  --repo-id=student/so101_pick_place_day2`,
    checks: [
      "Episode count is correct",
      "No failed demonstrations remain",
      "Camera frames are clear",
      "Task labels match the action",
    ],
    initialLines: [
      "student@so101-lab:~$ # Inspect before training.",
      "A small clean dataset is better than a larger noisy one.",
    ],
  },
  {
    title: "Train and evaluate a policy",
    description:
      "Start a training run, watch the loss trend, and save a checkpoint only after the policy has seen the curated dataset.",
    command: `lerobot-train \\
  --dataset.repo_id=student/so101_pick_place_day2 \\
  --policy.type=act \\
  --output_dir=outputs/train/so101_day2_act \\
  --job_name=so101_day2_act`,
    checks: [
      "Dataset path is correct",
      "Policy type is selected",
      "Loss is trending down",
      "Checkpoint is saved",
    ],
    initialLines: [
      "student@so101-lab:~$ # Train from the curated dataset.",
      "Paste the training command and press Enter.",
    ],
  },
];

const state = {
  activeStage: 0,
  completedStages: new Set(),
  commandRun: [false, false, false, false],
  terminalLines: stages.map((stage) => [...stage.initialLines]),
  episodesRecorded: 0,
  reviewChecks: new Set(),
  trainingStep: 0,
};

const stageButtons = [...document.querySelectorAll(".mission-tab")];
const stageKicker = document.getElementById("stage-kicker");
const stageTitle = document.getElementById("stage-title");
const stageDescription = document.getElementById("stage-description");
const stageChecks = document.getElementById("stage-checks");
const stageCommand = document.getElementById("stage-command");
const copyButton = document.getElementById("copy-command");
const terminalOutput = document.getElementById("terminal-output");
const terminalForm = document.getElementById("terminal-form");
const terminalInput = document.getElementById("terminal-input");
const actionPanel = document.getElementById("stage-action-panel");
const progressCount = document.getElementById("progress-count");
const episodeCount = document.getElementById("episode-count");
const trainingState = document.getElementById("training-state");
const datasetBars = [...document.querySelectorAll(".dataset-stack i")];
const lossBars = [...document.querySelectorAll(".loss-chart i")];

const normalizeCommand = (value) =>
  value.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();

const appendLine = (...lines) => {
  const target = state.terminalLines[state.activeStage];
  target.push(...lines);
  renderTerminal();
};

const markStageComplete = (stageIndex) => {
  state.completedStages.add(stageIndex);
  renderNavigation();
  renderProgress();
};

const runStageCommand = () => {
  const stage = stages[state.activeStage];
  const typedCommand = terminalInput.value.trim();

  if (!typedCommand) {
    appendLine("No command entered. Paste the command above, then press Enter.");
    return;
  }

  appendLine(`student@so101-lab:~$ ${normalizeCommand(typedCommand)}`);

  if (normalizeCommand(typedCommand) !== normalizeCommand(stage.command)) {
    appendLine(
      "Command mismatch.",
      "Check the dataset repo id, task text, ports, and command options.",
    );
    terminalInput.value = "";
    return;
  }

  state.commandRun[state.activeStage] = true;
  terminalInput.value = "";

  if (state.activeStage === 0) {
    appendLine(
      "Recording dry run started.",
      "Camera stream found.",
      "Leader arm connected on /dev/ttyACM1.",
      "Follower arm connected on /dev/ttyACM0.",
      "Workspace plan saved.",
    );
    markStageComplete(0);
  }

  if (state.activeStage === 1) {
    appendLine(
      "Dataset writer ready: student/so101_pick_place_day2",
      "Move to reset pose.",
      "Use Record next episode to simulate each demonstration.",
    );
  }

  if (state.activeStage === 2) {
    appendLine(
      "Computing dataset statistics...",
      "episodes: 5",
      "average episode length: 20.0s",
      "camera frames: valid",
      "action streams: valid",
    );
  }

  if (state.activeStage === 3) {
    appendLine(
      "Loading dataset student/so101_pick_place_day2...",
      "Initializing ACT policy...",
      "Training job created: outputs/train/so101_day2_act",
      "Use Run checkpoint to simulate training progress.",
    );
  }

  renderStage();
};

const copyCommand = async () => {
  const command = stages[state.activeStage].command;

  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "Copied";
  } catch {
    terminalInput.value = command;
    copyButton.textContent = "Inserted";
  }

  window.setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1300);
};

const renderNavigation = () => {
  stageButtons.forEach((button, index) => {
    const active = index === state.activeStage;
    const complete = state.completedStages.has(index);
    button.classList.toggle("active", active);
    button.classList.toggle("completed", complete);
    button.querySelector(".mission-tab-number").textContent = complete
      ? "✓"
      : String(index + 1);
    button.querySelector(".mission-tab-state").textContent = complete
      ? "Done"
      : active
        ? "Playing"
        : "To do";
  });
};

const renderProgress = () => {
  progressCount.textContent = `${state.completedStages.size} / 4`;
  episodeCount.textContent = `${state.episodesRecorded} / 5 episodes`;

  datasetBars.forEach((bar, index) => {
    bar.classList.toggle("done", index < state.episodesRecorded);
  });

  trainingState.textContent =
    state.trainingStep === 0
      ? "Waiting for data"
      : state.trainingStep < 5
        ? `Checkpoint ${state.trainingStep} / 5`
        : "Checkpoint saved";

  lossBars.forEach((bar, index) => {
    bar.classList.toggle("active", index < state.trainingStep);
    bar.style.height = `${80 - index * 12}%`;
  });
};

const renderTerminal = () => {
  terminalOutput.innerHTML = "";
  state.terminalLines[state.activeStage].forEach((line, index) => {
    const pre = document.createElement("pre");
    pre.textContent = line || " ";
    pre.dataset.index = String(index);
    terminalOutput.append(pre);
  });
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
};

const renderChecks = () => {
  stageChecks.innerHTML = "";

  stages[state.activeStage].checks.forEach((check, index) => {
    const item = document.createElement("span");
    item.className = "stage-check";

    const complete =
      state.completedStages.has(state.activeStage) ||
      (state.activeStage === 1 && index < Math.min(state.episodesRecorded, 4)) ||
      (state.activeStage === 2 && state.reviewChecks.has(index)) ||
      (state.activeStage === 3 && index < Math.min(state.trainingStep, 4));

    item.classList.toggle("complete", complete);
    item.textContent = complete ? `Done: ${check}` : check;
    stageChecks.append(item);
  });
};

const createButton = (label, className, onClick, disabled = false) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
};

const renderStageActions = () => {
  actionPanel.innerHTML = "";

  if (state.activeStage === 0) {
    const note = document.createElement("div");
    note.className = "status-note";
    note.textContent = state.completedStages.has(0)
      ? "Recording plan is ready. Continue to Stage 2."
      : "Run the command to confirm the robot, camera, and dataset metadata.";
    actionPanel.append(note);

    if (state.completedStages.has(0)) {
      actionPanel.append(
        createButton("Continue to Record Episodes", "primary-button", () =>
          setStage(1),
        ),
      );
    }
  }

  if (state.activeStage === 1) {
    const grid = document.createElement("div");
    grid.className = "episode-grid";

    for (let index = 0; index < 5; index += 1) {
      const card = document.createElement("div");
      card.className = `episode-card ${
        index < state.episodesRecorded ? "done" : ""
      }`;
      card.innerHTML = `<strong>${index + 1}</strong><span>${
        index < state.episodesRecorded ? "Recorded" : "Waiting"
      }</span>`;
      grid.append(card);
    }

    actionPanel.append(grid);

    const row = document.createElement("div");
    row.className = "button-row";
    row.append(
      createButton(
        "Record next episode",
        "primary-button",
        () => {
          if (!state.commandRun[1]) {
            appendLine("Run the recording command before collecting episodes.");
            return;
          }

          state.episodesRecorded = Math.min(5, state.episodesRecorded + 1);
          appendLine(
            `Episode ${state.episodesRecorded} recorded.`,
            state.episodesRecorded < 5
              ? "Reset the scene before the next episode."
              : "All requested episodes recorded.",
          );

          if (state.episodesRecorded === 5) {
            appendLine("Dataset saved locally.");
            markStageComplete(1);
          }

          renderStage();
        },
        state.episodesRecorded >= 5,
      ),
    );

    if (state.completedStages.has(1)) {
      row.append(
        createButton("Continue to Review Dataset", "secondary-button", () =>
          setStage(2),
        ),
      );
    }

    actionPanel.append(row);
  }

  if (state.activeStage === 2) {
    const row = document.createElement("div");
    row.className = "button-row";

    stages[2].checks.forEach((check, index) => {
      row.append(
        createButton(
          state.reviewChecks.has(index) ? `Checked: ${check}` : check,
          state.reviewChecks.has(index) ? "primary-button" : "secondary-button",
          () => {
            state.reviewChecks.add(index);
            appendLine(`Review check passed: ${check}`);

            if (state.reviewChecks.size === stages[2].checks.length) {
              appendLine("Dataset review complete. Ready for training.");
              markStageComplete(2);
            }

            renderStage();
          },
          !state.commandRun[2],
        ),
      );
    });

    actionPanel.append(row);

    if (state.completedStages.has(2)) {
      actionPanel.append(
        createButton("Continue to Train Policy", "primary-button", () =>
          setStage(3),
        ),
      );
    }
  }

  if (state.activeStage === 3) {
    const metrics = document.createElement("div");
    metrics.className = "metric-grid";

    const lossValues = ["1.82", "1.12", "0.74", "0.51", "0.38"];
    lossValues.forEach((loss, index) => {
      const card = document.createElement("div");
      card.className = `metric-card ${
        index < state.trainingStep ? "good" : ""
      }`;
      card.innerHTML = `<strong>${loss}</strong><span>loss ${index + 1}</span>`;
      metrics.append(card);
    });

    actionPanel.append(metrics);

    const row = document.createElement("div");
    row.className = "button-row";
    row.append(
      createButton(
        "Run checkpoint",
        "primary-button",
        () => {
          if (!state.commandRun[3]) {
            appendLine("Run the training command before checkpoints start.");
            return;
          }

          state.trainingStep = Math.min(5, state.trainingStep + 1);
          appendLine(
            `checkpoint ${state.trainingStep}: validation loss ${lossValues[state.trainingStep - 1]}`,
          );

          if (state.trainingStep === 5) {
            appendLine(
              "Training complete.",
              "Policy checkpoint saved to outputs/train/so101_day2_act.",
            );
            markStageComplete(3);
          }

          renderStage();
        },
        state.trainingStep >= 5,
      ),
    );

    if (state.completedStages.has(3)) {
      const done = document.createElement("div");
      done.className = "status-note";
      done.textContent =
        "Day 2 complete: the dataset was recorded, reviewed, and used for policy training.";
      row.append(done);
    }

    actionPanel.append(row);
  }
};

const renderStage = () => {
  const stage = stages[state.activeStage];
  stageKicker.textContent = `Stage ${state.activeStage + 1}`;
  stageTitle.textContent = stage.title;
  stageDescription.textContent = stage.description;
  stageCommand.textContent = stage.command;
  terminalInput.placeholder = state.commandRun[state.activeStage]
    ? "Command already accepted"
    : "Paste the command and press Enter";

  renderNavigation();
  renderProgress();
  renderChecks();
  renderTerminal();
  renderStageActions();
};

const setStage = (stageIndex) => {
  state.activeStage = stageIndex;
  copyButton.textContent = "Copy";
  renderStage();
};

stageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setStage(Number(button.dataset.stage));
  });
});

copyButton.addEventListener("click", copyCommand);

terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runStageCommand();
});

terminalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    runStageCommand();
  }
});

renderStage();
