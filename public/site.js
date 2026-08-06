/* Marketing-site behaviour. Three small things and nothing else: the scroll
   entry animations, the mobile menu, and mounting the explainer.

   Three.js is imported dynamically and only on a page that actually has a
   canvas, so /features, /pricing and /security never download 365KB to render
   text. The import failing — old browser, blocked module, missing vendor file
   — leaves the page fully readable, which is why the storyboard exists as
   markup as well as animation. */

const root = document.documentElement;

/* The class the reveal styles hang off. Setting it from script is what keeps a
   scripting-off visitor from getting a page of invisible sections. */
root.classList.add("js");

/* --- Scroll entry -------------------------------------------------------- */

const revealed = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      revealed.unobserve(entry.target); // arriving is a one-way trip
    }
  },
  { rootMargin: "0px 0px -12% 0px", threshold: 0.06 },
);

for (const element of document.querySelectorAll(".reveal")) revealed.observe(element);

/* --- Mobile menu --------------------------------------------------------- */

const burger = document.querySelector(".burger");
const menu = document.getElementById("menu");

if (burger && menu) {
  const setOpen = (open) => {
    burger.setAttribute("aria-expanded", String(open));
    menu.dataset.open = String(open);
    document.body.style.overflow = open ? "hidden" : "";
  };

  burger.addEventListener("click", () => {
    setOpen(burger.getAttribute("aria-expanded") !== "true");
  });

  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
}

/* --- The explainer ------------------------------------------------------- */

const canvas = document.querySelector("canvas[data-explainer]");

if (canvas) {
  const isExport = canvas.dataset.explainer === "export";
  /* ?t=14 freezes the sequence on the frame at that second. It exists so a
     single scene can be looked at, screenshotted or compared without waiting
     twenty-seven seconds for it to come round again. */
  const frozen = Number(new URLSearchParams(location.search).get("t"));

  import("/explainer.js")
    .then(({ mountExplainer }) => {
      const handle = mountExplainer(canvas, {
        at: Number.isFinite(frozen) && location.search.includes("t=") ? frozen : null,
        // The export frame is locked to the delivery format: 1080x1920 at 30fps,
        // so a screen recording of it needs no resampling.
        fixed: isExport ? { width: 1080, height: 1920 } : null,
        fps: isExport ? 30 : 0,
      });
      if (!handle) throw new Error("no webgl");
    })
    .catch(() => {
      /* No WebGL, or the module did not load. Drop the frame rather than leave
         a black rectangle: the written storyboard below it says the same thing. */
      const frame = canvas.closest(".shell");
      if (frame) frame.hidden = true;
    });
}
