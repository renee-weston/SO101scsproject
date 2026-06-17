import { useState } from "react";
import { joints } from "../data/day1Content";

type JointQuizProps = {
  onComplete: () => void;
};

export default function JointQuiz({ onComplete }: JointQuizProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [shuffledJoints] = useState(() => [
    joints[2],
    joints[0],
    joints[4],
    joints[1],
    joints[5],
    joints[3],
  ]);

  const currentJoint = shuffledJoints[questionIndex];
  const isCorrect = selectedId === currentJoint.id;

  const handleAnswer = (id: number) => {
    if (selectedId !== null) {
      return;
    }

    setSelectedId(id);

    if (id === currentJoint.id) {
      setScore((current) => current + 100);
    }
  };

  const handleNext = () => {
    if (questionIndex === shuffledJoints.length - 1) {
      onComplete();
      return;
    }

    setQuestionIndex((current) => current + 1);
    setSelectedId(null);
  };

  return (
    <section className="game-card">
      <p className="mission-label">MISSION 1</p>
      <h2>Know the Joints</h2>

      <p className="question-progress">
        Question {questionIndex + 1} of {shuffledJoints.length}
      </p>

      <div className="question-box">
        <p>Which motor ID controls:</p>
        <h3>{currentJoint.name}</h3>
        <p>{currentJoint.description}</p>
      </div>

      <div className="answer-grid">
        {joints.map((joint) => {
          let className = "answer-button";

          if (selectedId !== null) {
            if (joint.id === currentJoint.id) {
              className += " correct";
            } else if (joint.id === selectedId) {
              className += " incorrect";
            }
          }

          return (
            <button
              key={joint.id}
              className={className}
              onClick={() => handleAnswer(joint.id)}
              disabled={selectedId !== null}
            >
              Motor {joint.id}
            </button>
          );
        })}
      </div>

      {selectedId !== null && (
        <div className="feedback-box">
          <strong>{isCorrect ? "Correct!" : "Not quite."}</strong>

          <p>
            {currentJoint.name} uses Motor ID {currentJoint.id}.
          </p>

          <button className="primary-button" onClick={handleNext}>
            {questionIndex === shuffledJoints.length - 1
              ? "Complete Mission"
              : "Next Question"}
          </button>
        </div>
      )}

      <div className="score-display">Score: {score}</div>
    </section>
  );
}
