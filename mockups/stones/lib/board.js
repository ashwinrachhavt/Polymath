/* Shared chrome for the boards: the nav between them and a theme switch. */
(function () {
  const pages = [["index.html", "Overview"], ["1-rendering.html", "1 Rendering"], ["2-inventory.html", "2 Inventory"], ["3-earning.html", "3 Earning"], ["4-wall.html", "4 Wall"]];
  const here = location.pathname.split("/").pop() || "index.html";
  const q = new URLSearchParams(location.search);
  let theme = q.get("theme") || (function () { try { return localStorage.getItem("stones-theme"); } catch { return null; } })() || "system";
  function apply() {
    if (theme === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", theme);
    const b = document.getElementById("theme-btn"); if (b) b.textContent = "Theme: " + theme;
    window.dispatchEvent(new Event("themechange"));
  }
  const nav = document.createElement("nav"); nav.className = "boardnav";
  nav.innerHTML = '<span class="mark">Polymath stones</span>' + pages.map(([h, t]) => `<a href="${h}"${h === here ? ' aria-current="page"' : ""}>${t}</a>`).join("") + '<button type="button" id="theme-btn" class="btn quiet"></button>';
  document.body.prepend(nav);
  document.getElementById("theme-btn").addEventListener("click", () => {
    theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    try { localStorage.setItem("stones-theme", theme); } catch {}
    apply();
  });
  apply();
})();
