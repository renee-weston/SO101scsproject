import { useEffect, useRef, useState } from "react";

type Arm = "follower" | "leader";
type UsbConnections = Record<Arm, boolean>;

type UsbIdentificationMissionProps = {
  usbConnections: UsbConnections;
  onUsbActiveArmChange: (arm: Arm | null) => void;
  onSetUsbConnections: (connections: UsbConnections) => void;
  onComplete: () => void;
};

type Step =
  | "connect_both"
  | "type_find_port"
  | "disconnect_follower"
  | "reconnect_follower"
  | "disconnect_leader"
  | "reconnect_leader"
  | "complete";

const stepOrder: Step[] = [
  "connect_both",
  "type_find_port",
  "disconnect_follower",
  "reconnect_follower",
  "disconnect_leader",
  "reconnect_leader",
  "complete",
];

const ports: Record<Arm, string> = {
  follower: "/dev/ttyACM0",
  leader: "/dev/ttyACM1",
};

const FIND_PORT_COMMAND = "lerobot-find-port";
const portStorageKey = "so101-port-identification";

export default function UsbIdentificationMission({
  usbConnections,
  onUsbActiveArmChange,
  onSetUsbConnections,
  onComplete,
}: UsbIdentificationMissionProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState<Step>("connect_both");
  const [terminalLines, setTerminalLines] = useState<string[]>([
    "student@so101-lab:~$ # Plug both arms in, then run the command below.",
  ]);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [recordedPorts, setRecordedPorts] = useState<Partial<Record<Arm, string>>>(
    {},
  );

  const appendTerminal = (...lines: string[]) =>
    setTerminalLines((current) => [...current, ...lines]);

  // The terminal expects a typed command only on this step.
  const expectsCommand = step === "type_find_port";
  // The terminal expects a bare Enter (after a physical plug/unplug) on these.
  const expectsEnter =
    step === "disconnect_follower" ||
    step === "reconnect_follower" ||
    step === "disconnect_leader" ||
    step === "reconnect_leader";

  const activeArm: Arm | null =
    step === "disconnect_follower" || step === "reconnect_follower"
      ? "follower"
      : step === "disconnect_leader" || step === "reconnect_leader"
        ? "leader"
        : step === "connect_both"
          ? usbConnections.follower
            ? "leader"
            : "follower"
          : null;

  useEffect(() => {
    onUsbActiveArmChange(activeArm);
  }, [activeArm, onUsbActiveArmChange]);

  // Advance past the connect step once both arms are plugged in (in 3D).
  useEffect(() => {
    if (step === "connect_both" && usbConnections.follower && usbConnections.leader) {
      const timer = window.setTimeout(() => {
        setTerminalLines((current) => [
          ...current,
          "Both arms connected.",
          `Copy the command below, paste it into the terminal, and press Enter.`,
        ]);
        setStep("type_find_port");
      }, 0);

      return () => window.clearTimeout(timer);
    }
  }, [step, usbConnections.follower, usbConnections.leader]);

  useEffect(() => {
    terminalRef.current?.scrollTo({
      top: terminalRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [terminalLines]);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(FIND_PORT_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked; the student can still type the command.
      setCopied(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const command = input.trim();

    // Echo whatever the student entered.
    appendTerminal(`student@so101-lab:~$ ${command}`);
    setInput("");

    if (expectsCommand) {
      if (command !== FIND_PORT_COMMAND) {
        appendTerminal(`command not found: ${command || "(empty)"}`);
        return;
      }
      appendTerminal(
        "Finding all available ports for the MotorBus.",
        `['${ports.follower}', '${ports.leader}']`,
        "Remove the USB cable from your MotorsBus and press Enter when done.",
        "[Disconnect the follower arm and press Enter]",
      );
      setStep("disconnect_follower");
      return;
    }

    if (expectsEnter) {
      if (command.length > 0) {
        appendTerminal("(just press Enter — no command needed here)");
        return;
      }
      handleEnterConfirmation();
    }
  };

  // Bare-Enter confirmations for the disconnect / reconnect prompts.
  const handleEnterConfirmation = () => {
    if (step === "disconnect_follower") {
      if (usbConnections.follower) {
        appendTerminal("The follower arm is still connected. Unplug it first.");
        return;
      }
      setRecordedPorts((current) => ({ ...current, follower: ports.follower }));
      appendTerminal(
        `The port of this MotorsBus is ${ports.follower}`,
        "Reconnect the USB cable and press Enter.",
      );
      setStep("reconnect_follower");
    } else if (step === "reconnect_follower") {
      if (!usbConnections.follower) {
        appendTerminal("Plug the follower arm back in first.");
        return;
      }
      appendTerminal(
        "Follower arm reconnected.",
        "[Disconnect the leader arm and press Enter]",
      );
      setStep("disconnect_leader");
    } else if (step === "disconnect_leader") {
      if (usbConnections.leader) {
        appendTerminal("The leader arm is still connected. Unplug it first.");
        return;
      }
      setRecordedPorts((current) => ({ ...current, leader: ports.leader }));
      appendTerminal(
        `The port of this MotorsBus is ${ports.leader}`,
        "Reconnect the USB cable and press Enter.",
      );
      setStep("reconnect_leader");
    } else if (step === "reconnect_leader") {
      if (!usbConnections.leader) {
        appendTerminal("Plug the leader arm back in first.");
        return;
      }
      window.localStorage.setItem(
        portStorageKey,
        JSON.stringify({ follower: ports.follower, leader: ports.leader }),
      );
      appendTerminal(
        "Leader arm reconnected.",
        `Follower arm -> ${ports.follower}`,
        `Leader arm   -> ${ports.leader}`,
        "USB port identification complete.",
      );
      setStep("complete");
    }
  };

  const reset = () => {
    setStep("connect_both");
    setTerminalLines([
      "student@so101-lab:~$ # Plug both arms in, then run the command below.",
    ]);
    setInput("");
    setRecordedPorts({});
    onSetUsbConnections({ follower: false, leader: false });
  };

  const stepNumber = Math.min(stepOrder.indexOf(step) + 1, stepOrder.length - 1);

  let title: string;
  let why: string;
  let hint: string | null = null;

  switch (step) {
    case "connect_both":
      title = "Plug both arms into the computer";
      why =
        "The controller board talks to your computer over USB. Each arm shows up as a 'port' once it's plugged in, so connect both before scanning.";
      hint = "Click the glowing USB sockets on both boards in the 3D view.";
      break;
    case "type_find_port":
      title = "Run lerobot-find-port";
      why =
        "This command lists every connected port. We'll then unplug one arm at a time to see which port disappears — that tells us which port belongs to which arm.";
      hint = "Copy the command, paste it into the terminal, and press Enter.";
      break;
    case "disconnect_follower":
      title = "Unplug the follower arm, then press Enter";
      why =
        "Whichever port vanishes when you unplug the follower is the follower's port.";
      hint = "Unplug the follower's USB in 3D, then press Enter in the terminal.";
      break;
    case "reconnect_follower":
      title = "Plug the follower back in, then press Enter";
      why = `Found it — the follower arm is ${ports.follower}. Reconnect it so it stays powered.`;
      hint = "Re-plug the follower's USB in 3D, then press Enter.";
      break;
    case "disconnect_leader":
      title = "Unplug the leader arm, then press Enter";
      why = "Same trick for the leader — unplug it and watch which port disappears.";
      hint = "Unplug the leader's USB in 3D, then press Enter in the terminal.";
      break;
    case "reconnect_leader":
      title = "Plug the leader back in, then press Enter";
      why = `The leader arm is ${ports.leader}. Reconnect it to finish.`;
      hint = "Re-plug the leader's USB in 3D, then press Enter.";
      break;
    default:
      title = "Both ports identified 🎉";
      why =
        "You now know which USB port belongs to each arm. The next stage uses these ports to set up the motors.";
      break;
  }

  return (
    <section className="game-card setup-wizard usb-wizard">
      <header className="wizard-head">
        <div className="wizard-eyebrow">
          <span className="wizard-stage">STAGE 1</span>
          <span>Find the USB ports</span>
        </div>
      </header>

      <div className="wizard-step-card">
        {step !== "complete" && (
          <span className="wizard-step-counter">
            Step {stepNumber} of {stepOrder.length - 1}
          </span>
        )}
        <h2>{title}</h2>
        <p className="wizard-why">
          <strong>Why:</strong> {why}
        </p>
        {hint && <p className="wizard-hint">👉 {hint}</p>}
      </div>

      <div className="usb-port-status" aria-label="USB port status">
        {(["follower", "leader"] as Arm[]).map((arm) => (
          <div
            key={arm}
            className={`usb-port-chip ${usbConnections[arm] ? "connected" : "off"} ${
              activeArm === arm ? "active" : ""
            }`}
          >
            <span className="usb-port-name">
              {arm === "follower" ? "Follower" : "Leader"} arm
            </span>
            <span className="usb-port-state">
              {usbConnections[arm] ? "USB connected" : "Unplugged"}
            </span>
            <span className="usb-port-id">{recordedPorts[arm] ?? "port unknown"}</span>
          </div>
        ))}
      </div>

      {expectsCommand && (
        <div className="terminal-command-card">
          <div>
            <span className="terminal-command-label">Copy this command</span>
            <code>{FIND_PORT_COMMAND}</code>
          </div>
          <button type="button" className="terminal-copy-btn" onClick={copyCommand}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      )}

      {/* The terminal is always visible and is how the student drives the process. */}
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
            ref={inputRef}
            className="terminal-input"
            value={input}
            spellCheck={false}
            autoComplete="off"
            disabled={step === "complete" || step === "connect_both"}
            placeholder={
              step === "complete"
                ? "done"
                : step === "connect_both"
                  ? "plug both arms in first…"
                  : expectsCommand
                    ? "paste the command and press Enter"
                    : "press Enter"
            }
            onChange={(event) => setInput(event.target.value)}
          />
          <button
            className="terminal-enter-button"
            disabled={step === "complete" || step === "connect_both"}
            type="submit"
          >
            Enter
          </button>
        </form>
      </div>

      <div className="wizard-actions">
        {step === "complete" && (
          <button type="button" className="primary-button" onClick={onComplete}>
            Continue to Motor Setup
          </button>
        )}
        <button type="button" className="ghost-button" onClick={reset}>
          Reset
        </button>
      </div>
    </section>
  );
}
