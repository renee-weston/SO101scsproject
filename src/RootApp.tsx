import App from "./App";
import Day2App from "./day2/Day2App";

export default function RootApp() {
  return window.location.pathname.startsWith("/day2") ? <Day2App /> : <App />;
}
