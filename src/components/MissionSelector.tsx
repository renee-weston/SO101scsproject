type MissionSelectorProps = {
  currentMission: number;
  completedMissions: number[];
  onSelectMission: (mission: number) => void;
};

const missions = [
  { id: 1, title: "Find USB Ports" },
  { id: 2, title: "Set Motor IDs" },
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
            className={`mission-tab ${active ? "active" : ""} ${
              completed ? "completed" : ""
            }`}
            onClick={() => onSelectMission(mission.id)}
          >
            <span className="mission-tab-number">
              {completed ? "✓" : mission.id}
            </span>

            <span className="mission-tab-text">
              <span className="mission-tab-eyebrow">Stage {mission.id}</span>
              <span className="mission-tab-title">{mission.title}</span>
            </span>

            <span className="mission-tab-state">
              {completed ? "Done ✓" : active ? "Playing" : "To do"}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
