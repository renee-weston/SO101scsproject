import RobotScene from "./robot/RobotScene";
import "./App.css";

function App() {
  return (
    <main className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">SO-101 ROBOT LAB</p>
          <h1>Robot Setup Quest</h1>
          <p>Mission 1: Activate the virtual robot workspace.</p>
        </div>

        <div className="status-badge">Simulation Mode</div>
      </header>

      <section className="workspace">
        <RobotScene />

        <aside className="mission-panel">
          <p className="mission-number">MISSION 1</p>
          <h2>Explore the Workspace</h2>

          <p>Use your mouse to inspect the 3D scene.</p>

          <ul>
            <li>Left drag: rotate</li>
            <li>Mouse wheel: zoom</li>
            <li>Right drag: move the view</li>
          </ul>

          <div className="system-status">
            <span>3D renderer</span>
            <strong>ONLINE</strong>
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
