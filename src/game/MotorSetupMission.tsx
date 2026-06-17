import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";

type MotorName =
  | "gripper"
  | "wrist_roll"
  | "wrist_flex"
  | "elbow_flex"
  | "shoulder_lift"
  | "shoulder_pan";

type MotorConfig = {
  name: MotorName;
  label: string;
  joint: string;
  id: number;
  x: number;
  y: number;
};

type MotorSetupMissionProps = {
  onComplete: () => void;
};

type ServoCableId =
  | "id-cable"
  | "chain-1"
  | "chain-2"
  | "chain-3"
  | "chain-4"
  | "chain-5"
  | "chain-6";

type ServoEndpointId = `${ServoCableId}:a` | `${ServoCableId}:b`;
type UtilityEndpointId = "usb-cable:plug" | "power-cable:plug";
type EndpointId = ServoEndpointId | UtilityEndpointId;
type MotorPortId = `motor:${MotorName}:a` | `motor:${MotorName}:b`;
type BoardPortId = "controller:motor" | "controller:usb" | "controller:power";
type UtilityPortId = "computer:usb" | "power:supply";
type PortId = BoardPortId | MotorPortId | UtilityPortId;

const setupCommand = `lerobot-setup-motors \\
  --robot.type=so101_follower \\
  --robot.port=/dev/ttyACM0`;

const assignmentOrder: MotorConfig[] = [
  { name: "gripper", label: "Gripper", joint: "Gripper joint", id: 6, x: 76, y: 19 },
  { name: "wrist_roll", label: "Wrist Roll", joint: "Wrist rotation joint", id: 5, x: 67, y: 28 },
  { name: "wrist_flex", label: "Wrist Flex", joint: "First wrist bending joint", id: 4, x: 57, y: 37 },
  { name: "elbow_flex", label: "Elbow Flex", joint: "Elbow joint", id: 3, x: 45, y: 46 },
  { name: "shoulder_lift", label: "Shoulder Lift", joint: "Lower shoulder joint", id: 2, x: 32, y: 61 },
  { name: "shoulder_pan", label: "Shoulder Pan", joint: "Base rotation joint", id: 1, x: 21, y: 75 },
];

const chainOrder: MotorName[] = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
];

const storageKey = "so101-motor-setup";
const servoCableIds: ServoCableId[] = [
  "id-cable",
  "chain-1",
  "chain-2",
  "chain-3",
  "chain-4",
  "chain-5",
  "chain-6",
];

const assignmentCableIds = new Set<ServoCableId>(["id-cable"]);

const normalizeCommand = (value: string) =>
  value.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();

const commandPattern =
  /^lerobot-setup-motors --robot\.type=so101_follower --robot\.port=\/dev\/ttyACM[01]$/;

const createInitialIds = () =>
  assignmentOrder.reduce((ids, motor) => {
    ids[motor.name] = null;
    return ids;
  }, {} as Record<MotorName, number | null>);

const createInitialEndpointPorts = (): Record<EndpointId, PortId | null> => {
  const endpoints = {
    "usb-cable:plug": null,
    "power-cable:plug": null,
  } as Record<EndpointId, PortId | null>;

  servoCableIds.forEach((cableId) => {
    endpoints[`${cableId}:a`] = null;
    endpoints[`${cableId}:b`] = null;
  });

  return endpoints;
};

const loadSavedIds = () => {
  try {
    const rawValue = window.localStorage.getItem(storageKey);

    if (!rawValue) {
      return createInitialIds();
    }

    return {
      ...createInitialIds(),
      ...(JSON.parse(rawValue) as Record<MotorName, number | null>),
    };
  } catch {
    return createInitialIds();
  }
};

const getMotorFromPort = (portId: PortId) => {
  if (!portId.startsWith("motor:")) {
    return null;
  }

  return portId.split(":")[1] as MotorName;
};

const getCableId = (endpointId: EndpointId) =>
  endpointId.split(":")[0] as ServoCableId | "usb-cable" | "power-cable";

export default function MotorSetupMission({
  onComplete,
}: MotorSetupMissionProps) {
  const [endpointPorts, setEndpointPorts] = useState(createInitialEndpointPorts);
  const [configuredIds, setConfiguredIds] = useState(loadSavedIds);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [setupStarted, setSetupStarted] = useState(false);
  const [commandWasPasted, setCommandWasPasted] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [requestedIndex, setRequestedIndex] = useState(0);
  const [missionComplete, setMissionComplete] = useState(false);
  const [hoveredMotor, setHoveredMotor] = useState<MotorName | null>(null);
  const [draggedEndpoint, setDraggedEndpoint] = useState<EndpointId | null>(null);

  const configuredCount = assignmentOrder.filter(
    (motor) => configuredIds[motor.name] === motor.id,
  ).length;
  const requestedMotor = assignmentOrder[requestedIndex];
  const stage = configuredCount === 6 ? "chain" : "assign";
  const normalizedInput = normalizeCommand(terminalInput);
  const canSubmitCommand = commandWasPasted && commandPattern.test(normalizedInput);
  const usbConnected = endpointPorts["usb-cable:plug"] === "controller:usb";
  const powerConnected = endpointPorts["power-cable:plug"] === "controller:power";

  const configuredByName = useMemo(
    () =>
      assignmentOrder.reduce((lookup, motor) => {
        lookup[motor.name] = configuredIds[motor.name] === motor.id;
        return lookup;
      }, {} as Record<MotorName, boolean>),
    [configuredIds],
  );

  const connections = useMemo(() => {
    const edges: Array<[PortId, PortId, ServoCableId]> = [];

    servoCableIds.forEach((cableId) => {
      const first = endpointPorts[`${cableId}:a`];
      const second = endpointPorts[`${cableId}:b`];

      if (first && second) {
        edges.push([first, second, cableId]);
      }
    });

    return edges;
  }, [endpointPorts]);

  const boardComponentMotors = useMemo(() => {
    const visitedPorts = new Set<PortId>();
    const motors = new Set<MotorName>();
    const queue: PortId[] = ["controller:motor"];

    while (queue.length > 0) {
      const portId = queue.shift();

      if (!portId || visitedPorts.has(portId)) {
        continue;
      }

      visitedPorts.add(portId);

      const motor = getMotorFromPort(portId);

      if (motor) {
        motors.add(motor);
        queue.push(
          portId.endsWith(":a")
            ? (`motor:${motor}:b` as MotorPortId)
            : (`motor:${motor}:a` as MotorPortId),
        );
      }

      connections.forEach(([first, second]) => {
        if (first === portId && !visitedPorts.has(second)) {
          queue.push(second);
        }

        if (second === portId && !visitedPorts.has(first)) {
          queue.push(first);
        }
      });
    }

    return Array.from(motors);
  }, [connections]);

  const appendTerminal = (...lines: string[]) => {
    setTerminalLines((current) => [...current, ...lines]);
  };

  const saveIds = (nextIds: Record<MotorName, number | null>) => {
    setConfiguredIds(nextIds);
    window.localStorage.setItem(storageKey, JSON.stringify(nextIds));
  };

  const resetMission = () => {
    const resetIds = createInitialIds();

    setEndpointPorts(createInitialEndpointPorts());
    saveIds(resetIds);
    setTerminalInput("");
    setTerminalLines([]);
    setSetupStarted(false);
    setCommandWasPasted(false);
    setRequestedIndex(0);
    setMissionComplete(false);
    setHoveredMotor(null);
  };

  const copyCommand = async () => {
    await navigator.clipboard.writeText(setupCommand);
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 1400);
  };

  const validatePreflight = () => {
    if (!usbConnected && !powerConnected) {
      appendTerminal(
        "Connect the USB cable and power supply to the controller board before continuing.",
      );
      return false;
    }

    if (!usbConnected) {
      appendTerminal("Controller board not detected. Check the USB connection.");
      return false;
    }

    if (!powerConnected) {
      appendTerminal("Controller board not powered. Check the power supply connection.");
      return false;
    }

    return true;
  };

  const beginSetup = (command: string) => {
    if (!commandWasPasted) {
      appendTerminal("Paste the copied command into the terminal before pressing Enter.");
      return;
    }

    if (!commandPattern.test(normalizeCommand(command))) {
      appendTerminal(
        "Command not recognized. Use so101_follower and /dev/ttyACM0 or /dev/ttyACM1.",
      );
      return;
    }

    if (!validatePreflight()) {
      return;
    }

    setSetupStarted(true);
    appendTerminal(
      `student@so101-lab:~$ ${normalizeCommand(command)}`,
      "",
      `Connect the controller board to the '${requestedMotor.name}' motor only and press Enter.`,
    );
  };

  const assignRequestedMotor = () => {
    if (!validatePreflight()) {
      return;
    }

    if (boardComponentMotors.length === 0) {
      appendTerminal(
        "No motor detected. Connect the requested motor before pressing Enter.",
      );
      return;
    }

    if (boardComponentMotors.length > 1) {
      appendTerminal(
        "Multiple motors detected. Only one motor may be connected during ID assignment.",
      );
      return;
    }

    const connectedMotor = boardComponentMotors[0];

    if (connectedMotor !== requestedMotor.name) {
      appendTerminal(
        `Incorrect motor connected. The terminal is requesting '${requestedMotor.name}'.`,
      );
      return;
    }

    const nextIds = {
      ...configuredIds,
      [requestedMotor.name]: requestedMotor.id,
    };
    saveIds(nextIds);
    appendTerminal(`'${requestedMotor.name}' motor id set to ${requestedMotor.id}`, "");

    const nextIndex = requestedIndex + 1;

    if (nextIndex < assignmentOrder.length) {
      setRequestedIndex(nextIndex);
      appendTerminal(
        `Connect the controller board to the '${assignmentOrder[nextIndex].name}' motor only and press Enter.`,
      );
      return;
    }

    appendTerminal(
      "All motor IDs have been configured successfully.",
      "",
      "Now daisy-chain the motors from ID 1 to ID 6.",
      "Connect the shoulder_pan motor to the controller board.",
    );
  };

  const validateChain = () => {
    if (!validatePreflight()) {
      return;
    }

    if (configuredCount < 6) {
      appendTerminal("Configure all six motor IDs before building the motor chain.");
      return;
    }

    const missingLinkIndex = chainOrder.findIndex((motorName, index) => {
      const previousPort =
        index === 0 ? "controller:motor" : (`motor:${chainOrder[index - 1]}:` as const);
      const currentPortPrefix = `motor:${motorName}:`;

      return !connections.some(([first, second]) => {
        const firstMatchesPrevious =
          index === 0 ? first === previousPort : first.startsWith(previousPort);
        const secondMatchesPrevious =
          index === 0 ? second === previousPort : second.startsWith(previousPort);
        const firstMatchesCurrent = first.startsWith(currentPortPrefix);
        const secondMatchesCurrent = second.startsWith(currentPortPrefix);

        return (
          (firstMatchesPrevious && secondMatchesCurrent) ||
          (secondMatchesPrevious && firstMatchesCurrent)
        );
      });
    });

    const expectedMotors = new Set(chainOrder);

    if (
      missingLinkIndex !== -1 ||
      boardComponentMotors.length !== chainOrder.length ||
      boardComponentMotors.some((motorName) => !expectedMotors.has(motorName))
    ) {
      const expected = chainOrder[Math.max(0, missingLinkIndex)];
      const expectedId = configuredIds[expected];
      const previous =
        missingLinkIndex <= 0 ? "controller board" : `ID ${missingLinkIndex}`;

      appendTerminal(
        `Incorrect motor chain: ${previous} should connect to ID ${expectedId}.`,
      );
      return;
    }

    setMissionComplete(true);
    appendTerminal(
      "Motor setup complete.",
      "",
      "Detected motor chain:",
      "ID 1: shoulder_pan",
      "ID 2: shoulder_lift",
      "ID 3: elbow_flex",
      "ID 4: wrist_flex",
      "ID 5: wrist_roll",
      "ID 6: gripper",
      "",
      "All motors are ready for calibration.",
    );
    onComplete();
  };

  const submitTerminal = () => {
    if (!setupStarted) {
      beginSetup(terminalInput);
      setTerminalInput("");
      setCommandWasPasted(false);
      return;
    }

    if (stage === "assign") {
      assignRequestedMotor();
      return;
    }

    validateChain();
  };

  const handleTerminalKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (setupStarted || canSubmitCommand) {
        submitTerminal();
      }
    }
  };

  const setEndpointPort = (endpointId: EndpointId, portId: PortId | null) => {
    setEndpointPorts((current) => {
      const next = { ...current };
      const cableId = getCableId(endpointId);

      Object.entries(next).forEach(([otherEndpoint, otherPort]) => {
        if (
          otherPort === portId &&
          otherEndpoint !== endpointId &&
          getCableId(otherEndpoint as EndpointId) !== cableId
        ) {
          next[otherEndpoint as EndpointId] = null;
        }
      });

      next[endpointId] = portId;
      return next;
    });
  };

  const isValidDrop = (endpointId: EndpointId, portId: PortId) => {
    if (endpointId === "usb-cable:plug") {
      return portId === "controller:usb";
    }

    if (endpointId === "power-cable:plug") {
      return portId === "controller:power";
    }

    if (stage === "assign" && !assignmentCableIds.has(getCableId(endpointId) as ServoCableId)) {
      return false;
    }

    return portId === "controller:motor" || portId.startsWith("motor:");
  };

  const handleDrop = (
    event: DragEvent<HTMLElement>,
    portId: PortId | null,
  ) => {
    event.preventDefault();
    const endpointId = event.dataTransfer.getData("text/plain") as EndpointId;

    if (!endpointId) {
      return;
    }

    if (portId && !isValidDrop(endpointId, portId)) {
      appendTerminal("Invalid cable target. Use the matching 3-pin port.");
      setDraggedEndpoint(null);
      return;
    }

    setEndpointPort(endpointId, portId);
    setDraggedEndpoint(null);
  };

  const startEndpointDrag = (
    event: DragEvent<HTMLElement>,
    endpointId: EndpointId,
  ) => {
    event.dataTransfer.setData("text/plain", endpointId);
    setDraggedEndpoint(endpointId);
  };

  const renderDropPort = (
    portId: PortId,
    label: string,
    className = "",
  ) => {
    const occupied = Object.values(endpointPorts).includes(portId);
    const requested =
      setupStarted &&
      stage === "assign" &&
      portId.startsWith(`motor:${requestedMotor.name}:`);
    const invalid =
      stage === "assign" &&
      portId.startsWith("motor:") &&
      boardComponentMotors.length === 1 &&
      boardComponentMotors[0] !== requestedMotor.name &&
      boardComponentMotors[0] === getMotorFromPort(portId);
    const validTarget =
      draggedEndpoint !== null && isValidDrop(draggedEndpoint, portId);

    return (
      <span
        className={`plug-port ${className} ${occupied ? "occupied" : ""} ${
          requested ? "requested" : ""
        } ${invalid ? "invalid" : ""} ${validTarget ? "valid-target" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => handleDrop(event, portId)}
      >
        {label}
      </span>
    );
  };

  const renderEndpoint = (endpointId: EndpointId, label: string) => (
    <span
      className={`cable-plug ${endpointPorts[endpointId] ? "attached" : ""}`}
      draggable
      onDragEnd={() => setDraggedEndpoint(null)}
      onDragStart={(event) => startEndpointDrag(event, endpointId)}
      title={
        endpointPorts[endpointId]
          ? `Connected to ${endpointPorts[endpointId]}`
          : "Drag to a matching port"
      }
    >
      {label}
    </span>
  );

  const currentFeedback = (() => {
    if (!setupStarted || stage !== "assign") {
      return stage === "chain"
        ? "Daisy-chain ID 1 through ID 6, then press Enter."
        : "Paste the command to start motor setup.";
    }

    if (boardComponentMotors.length === 0) {
      return "No motor detected.";
    }

    if (boardComponentMotors.length > 1) {
      return "Multiple motors detected.";
    }

    if (boardComponentMotors[0] !== requestedMotor.name) {
      return `Incorrect motor connected. The terminal is requesting '${requestedMotor.name}'.`;
    }

    return "Ready - press Enter.";
  })();

  return (
    <section className="game-card motor-setup-game">
      <p className="mission-label">MISSION 2</p>
      <h2>Set Up the Motors</h2>
      <p>
        Copy the setup command, paste it into the terminal, then configure one
        mounted SO-101 motor at a time using physical cable connections.
      </p>

      <div className="motor-progress">
        <span>Motor Configuration: {configuredCount} / 6</span>
        <div>
          <span style={{ width: `${(configuredCount / 6) * 100}%` }} />
        </div>
      </div>

      <div className="setup-command-card">
        <pre>{setupCommand}</pre>
        <button type="button" onClick={copyCommand}>
          {copyState === "copied" ? "Copied" : "Copy Command"}
        </button>
      </div>

      <div className="terminal-window" onClick={() => document.getElementById("motor-terminal-input")?.focus()}>
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
          <label className="terminal-prompt">
            <span>student@so101-lab:~$</span>
            <textarea
              id="motor-terminal-input"
              value={terminalInput}
              onChange={(event) => {
                setTerminalInput(event.currentTarget.value);
                if (!event.currentTarget.value) {
                  setCommandWasPasted(false);
                }
              }}
              onKeyDown={handleTerminalKeyDown}
              onPaste={() => setCommandWasPasted(true)}
              placeholder={setupStarted ? "" : "Paste command here"}
              rows={setupStarted ? 1 : 2}
            />
            {!setupStarted ? (
              <button
                disabled={!canSubmitCommand}
                type="button"
                onClick={submitTerminal}
              >
                Enter
              </button>
            ) : (
              <button
                className="terminal-enter-small"
                disabled={missionComplete}
                type="button"
                onClick={submitTerminal}
              >
                Press Enter
              </button>
            )}
          </label>
        </div>
      </div>

      <div className="motor-lab">
        <div className="cable-tray" onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleDrop(event, null)}>
          <strong>Cables</strong>
          <div className="utility-cables">
            <span>USB</span>
            {renderEndpoint("usb-cable:plug", usbConnected ? "USB plugged" : "USB plug")}
            <span>Power</span>
            {renderEndpoint(
              "power-cable:plug",
              powerConnected ? "Power plugged" : "Power plug",
            )}
          </div>
          <div className="servo-cables">
            {servoCableIds.map((cableId, index) => (
              <div className="servo-cable-row" key={cableId}>
                <span>{cableId === "id-cable" ? "Setup cable" : `Chain cable ${index}`}</span>
                {renderEndpoint(`${cableId}:a`, "A")}
                <span className="cable-line" />
                {renderEndpoint(`${cableId}:b`, "B")}
              </div>
            ))}
          </div>
          <small>Drag a plug onto a highlighted port. Drop it back here to unplug.</small>
        </div>

        <div className="robot-workspace">
          <div className="computer-node">
            <strong>Computer</strong>
            <span>Terminal host</span>
            {renderDropPort("computer:usb", "USB source")}
          </div>

          <div className="power-node">
            <strong>Power Supply</strong>
            <span>Follower arm power</span>
            {renderDropPort("power:supply", "Power source")}
          </div>

          <div className="controller-board">
            <strong>Follower Controller Board</strong>
            <span>USB: {usbConnected ? "connected" : "missing"}</span>
            <span>Power: {powerConnected ? "connected" : "missing"}</span>
            <span>
              Motor graph:{" "}
              {boardComponentMotors.length === 0
                ? "empty"
                : boardComponentMotors.join(", ")}
            </span>
            <div className="controller-ports">
              {renderDropPort("controller:usb", "USB")}
              {renderDropPort("controller:power", "PWR")}
              {renderDropPort("controller:motor", "3-pin motor")}
            </div>
          </div>

          <div className="so101-arm-diagram" aria-label="SO-101 arm with mounted motors">
            <span className="arm-link base-link" />
            <span className="arm-link lower-link" />
            <span className="arm-link upper-link" />
            <span className="arm-link wrist-link" />
            {assignmentOrder.map((motor) => {
              const configured = configuredIds[motor.name] === motor.id;
              const requested =
                setupStarted && stage === "assign" && requestedMotor.name === motor.name;
              const connected = boardComponentMotors.includes(motor.name);
              const incorrect =
                stage === "assign" &&
                connected &&
                setupStarted &&
                requestedMotor.name !== motor.name;

              return (
                <div
                  className={`mounted-motor ${configured ? "configured" : ""} ${
                    requested ? "requested" : ""
                  } ${connected ? "connected" : ""} ${incorrect ? "incorrect" : ""} ${
                    setupStarted && stage === "assign" && !requested ? "dimmed" : ""
                  }`}
                  key={motor.name}
                  onMouseEnter={() => setHoveredMotor(motor.name)}
                  onMouseLeave={() => setHoveredMotor(null)}
                  style={{ left: `${motor.x}%`, top: `${motor.y}%` }}
                >
                  <span className="motor-housing">
                    <span className="motor-horn" />
                  </span>
                  <span className="motor-name">{motor.label}</span>
                  <span className="motor-ports">
                    {renderDropPort(`motor:${motor.name}:a`, "A", "motor-port")}
                    {renderDropPort(`motor:${motor.name}:b`, "B", "motor-port")}
                  </span>
                  {(hoveredMotor === motor.name || requested) && (
                    <span className="motor-floating-label">
                      {requested ? "Connect this motor only" : `${motor.label} Motor`}
                      <small>
                        {configured
                          ? `Current ID: ${motor.id}`
                          : "Current ID: Unassigned"}
                      </small>
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className={`connection-feedback ${currentFeedback.startsWith("Ready") ? "ready" : ""}`}>
            {currentFeedback}
          </div>
        </div>
      </div>

      <div className="motor-status-list">
        {assignmentOrder.map((motor) => {
          const configured = configuredByName[motor.name];
          const requested =
            setupStarted && stage === "assign" && requestedMotor.name === motor.name;

          return (
            <div
              className={`motor-status-row ${configured ? "complete" : ""} ${
                requested ? "requested" : ""
              }`}
              key={motor.name}
            >
              <strong>{motor.label}</strong>
              <span>
                {configured
                  ? `ID ${motor.id} - Configured`
                  : requested
                    ? "Waiting for connection"
                    : "Not configured"}
              </span>
            </div>
          );
        })}
      </div>

      <button className="secondary-button" onClick={resetMission} type="button">
        Reset Mission
      </button>
    </section>
  );
}
