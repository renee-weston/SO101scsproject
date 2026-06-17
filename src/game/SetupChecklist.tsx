import { useState } from "react";
import { setupChecklist } from "../data/day1Content";

type SetupChecklistProps = {
  onComplete: () => void;
};

export default function SetupChecklist({
  onComplete,
}: SetupChecklistProps) {
  const [checkedItems, setCheckedItems] = useState<string[]>([]);

  const toggleItem = (item: string) => {
    setCheckedItems((current) => {
      if (current.includes(item)) {
        return current.filter((value) => value !== item);
      }

      return [...current, item];
    });
  };

  const allComplete = checkedItems.length === setupChecklist.length;

  return (
    <section className="game-card">
      <p className="mission-label">MISSION 3</p>
      <h2>Activate the Robot</h2>

      <p>
        Complete every setup step before the SO-101 can be activated.
      </p>

      <div className="checklist">
        {setupChecklist.map((item) => {
          const checked = checkedItems.includes(item);

          return (
            <label
              className={`checklist-item ${checked ? "checked" : ""}`}
              key={item}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleItem(item)}
              />

              <span>{item}</span>
            </label>
          );
        })}
      </div>

      <button
        className="primary-button"
        disabled={!allComplete}
        onClick={onComplete}
      >
        Activate SO-101
      </button>
    </section>
  );
}
