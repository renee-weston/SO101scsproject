export type Joint = {
  id: number;
  name: string;
  description: string;
};

export const joints: Joint[] = [
  {
    id: 1,
    name: "Base / Shoulder Pan",
    description: "Rotates the arm left and right.",
  },
  {
    id: 2,
    name: "Shoulder Lift",
    description: "Raises and lowers the upper arm.",
  },
  {
    id: 3,
    name: "Elbow Flex",
    description: "Bends and straightens the elbow.",
  },
  {
    id: 4,
    name: "Wrist Flex",
    description: "Moves the wrist up and down.",
  },
  {
    id: 5,
    name: "Wrist Roll",
    description: "Rotates the wrist.",
  },
  {
    id: 6,
    name: "Gripper",
    description: "Opens and closes to hold objects.",
  },
];

export const correctMotorChain = [
  "Controller",
  "Base",
  "Shoulder",
  "Elbow",
  "Wrist Flex",
  "Wrist Roll",
  "Gripper",
];

export const setupChecklist = [
  "LeRobot installed",
  "Feetech support installed",
  "USB ports identified",
  "Motor IDs configured",
  "Motor chain connected",
  "Follower calibrated",
  "Leader calibrated",
  "Teleoperation tested",
];
