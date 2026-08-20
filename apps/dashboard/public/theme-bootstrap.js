const saved = localStorage.getItem("orchestrat.theme");
const dark =
  saved === "dark" ||
  (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.theme = dark ? "dark" : "light";
