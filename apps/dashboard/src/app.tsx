import { NavLink, Route, Routes, useLocation } from "react-router-dom";

const navigation = [
  "Overview",
  "Tasks",
  "Agents",
  "Documents",
  "Messages",
  "Activity",
  "Integrations",
  "Settings"
];
const toPath = (name: string) =>
  name === "Overview" ? "/" : `/${name.toLowerCase()}`;

function Placeholder() {
  const location = useLocation();
  const label =
    navigation.find((item) => toPath(item) === location.pathname) ?? "Overview";
  return (
    <main className="content">
      <p className="eyebrow">PROJECT / UNCONFIGURED</p>
      <h1>{label}</h1>
      <section className="placeholder">
        <p>No {label.toLowerCase()} data yet.</p>
        <span>
          This foundation route is ready for its dedicated product phase.
        </span>
      </section>
    </main>
  );
}

export function App() {
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ORCHESTRAT<span>DEV</span>
        </div>
        <nav>
          {navigation.map((item) => (
            <NavLink key={item} to={toPath(item)} end={item === "Overview"}>
              {item}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">SYSTEM / LOCAL</div>
      </aside>
      <div className="workspace">
        <header>
          <div>
            <p>PROJECT</p>
            <strong>Untitled project</strong>
          </div>
          <span>● Dashboard shell</span>
        </header>
        <Routes>
          {navigation.map((item) => (
            <Route key={item} path={toPath(item)} element={<Placeholder />} />
          ))}
        </Routes>
      </div>
    </div>
  );
}
