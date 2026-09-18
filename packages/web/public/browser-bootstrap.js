(() => {
  if (window.location.hostname !== "cloud.first-tree.ai") return;
  window.dataLayer = window.dataLayer || [];
  // Keep the official gtag queue shape. gtag.js consumes the function's
  // Arguments object; pushing a rest-parameter Array leaves commands queued.
  window.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: the official gtag.js queue contract uses Arguments.
    window.dataLayer.push(arguments);
  };
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02";
  document.head.appendChild(tag);
  window.gtag("js", new Date());
  window.gtag("config", "G-BHG918MZ02", {
    send_page_view: false,
    linker: { domains: ["first-tree.ai", "cloud.first-tree.ai"] },
  });
})();

(() => {
  if (window.location.hostname !== "cloud.first-tree.ai") return;
  window.clarity =
    window.clarity ||
    ((...args) => {
      const queue = window.clarity.q || [];
      window.clarity.q = queue;
      queue.push(args);
    });
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = "https://www.clarity.ms/tag/xj2f9syfng";
  document.head.appendChild(tag);
})();

(() => {
  const theme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (theme === "dark" || (!theme && prefersDark)) document.documentElement.classList.add("dark");
})();
