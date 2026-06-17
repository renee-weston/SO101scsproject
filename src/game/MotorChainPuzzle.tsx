import { useState } from "react";
import { correctMotorChain } from "../data/day1Content";

type MotorChainPuzzleProps = {
  onComplete: () => void;
};

export default function MotorChainPuzzle({
  onComplete,
}: MotorChainPuzzleProps) {
  const initialItems = [
    correctMotorChain[3],
    correctMotorChain[0],
    correctMotorChain[5],
    correctMotorChain[2],
    correctMotorChain[6],
    correctMotorChain[1],
    correctMotorChain[4],
  ];
  const [items, setItems] = useState(initialItems);
  const [message, setMessage] = useState("");

  const moveItem = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;

    if (newIndex < 0 || newIndex >= items.length) {
      return;
    }

    const updated = [...items];
    [updated[index], updated[newIndex]] = [
      updated[newIndex],
      updated[index],
    ];

    setItems(updated);
    setMessage("");
  };

  const checkAnswer = () => {
    const correct = items.every(
      (item, index) => item === correctMotorChain[index],
    );

    if (correct) {
      setMessage("Motor chain complete!");
      onComplete();
    } else {
      setMessage("Some parts are still in the wrong order.");
    }
  };

  const resetPuzzle = () => {
    setItems(initialItems);
    setMessage("");
  };

  return (
    <section className="game-card">
      <p className="mission-label">MISSION 2</p>
      <h2>Build the Motor Chain</h2>

      <p>
        Arrange the components in the correct order, starting from the
        controller board.
      </p>

      <div className="chain-list">
        {items.map((item, index) => (
          <div className="chain-item" key={item}>
            <span className="chain-position">{index + 1}</span>
            <strong>{item}</strong>

            <div className="chain-controls">
              <button
                onClick={() => moveItem(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${item} up`}
              >
                ↑
              </button>

              <button
                onClick={() => moveItem(index, 1)}
                disabled={index === items.length - 1}
                aria-label={`Move ${item} down`}
              >
                ↓
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="button-row">
        <button className="secondary-button" onClick={resetPuzzle}>
          Shuffle
        </button>

        <button className="primary-button" onClick={checkAnswer}>
          Check Chain
        </button>
      </div>

      {message && <div className="feedback-box">{message}</div>}
    </section>
  );
}
