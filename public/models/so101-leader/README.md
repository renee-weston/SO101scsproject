# SO-101 Leader model

This model is derived from the official TheRobotStudio/SO-ARM100 SO-101 assets.

- `so101_leader.urdf` preserves the articulated joint/link hierarchy and limits
  from `Simulation/SO101/so101_new_calib.urdf`.
- `assets/` contains the official simulation meshes plus Leader-specific
  individual STL parts from `STL/SO101/Individual`:
  `Wrist_Roll_SO101.stl`, `Handle_SO101.stl`, and `Trigger_SO101.stl`.

The Leader-specific STL files are authored in millimeters, so their URDF mesh
entries use `scale="0.001 0.001 0.001"`.
