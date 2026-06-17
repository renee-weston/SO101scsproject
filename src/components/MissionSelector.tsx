type MissionSelectorProps = {
  currentMission: number;
  completedMissions: number[];
  onSelectMission: (mission: number) => void;
};

const missions = [
  { id: 1, title: "Know the Joints" },
  { id: 2, title: "Set Up the Motors" },
  { id: 3, title: "Calibrate the Robot" },
  { id: 4, title: "Teleoperate" },
];

export default function MissionSelector({
  currentMission,
  completedMissions,
  onSelectMission,
}: MissionSelectorProps) {
  return (
    <nav className="mission-selector">
      {missions.map((mission) => {
        const completed = completedMissions.includes(mission.id);
        const active = currentMission === mission.id;

        return (
          <button
            key={mission.id}
            className={`mission-tab ${active ? "active" : ""}`}
            onClick={() => onSelectMission(mission.id)}
          >
            <span className="mission-tab-number">
              {completed ? "✓" : mission.id}
            </span>

            <span>{mission.title}</span>
          </button>
        );
      })}
    </nav>
  );
}
