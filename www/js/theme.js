/* Applies the saved light or dark choice before the first paint. */
try { var th = localStorage.getItem("bnzn-theme"); if (th === "light" || th === "dark") document.documentElement.dataset.theme = th; } catch (e) { /* storage blocked */ }
