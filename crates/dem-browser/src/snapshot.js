// Reads the page for AI: its text, and what it can click or type into, numbered. Password values
// are never read.
(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  document.querySelectorAll("[data-jady-ref]").forEach((e) => e.removeAttribute("data-jady-ref"));
  const elements = [];
  const usable =
    "a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [contenteditable=true]";
  for (const e of document.querySelectorAll(usable)) {
    if (elements.length >= 200) break;
    if (e.type === "hidden" || !visible(e)) continue;
    const n = elements.length + 1;
    e.setAttribute("data-jady-ref", String(n));
    const tag = e.tagName.toLowerCase();
    const role =
      e.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? e.type || "text" : tag);
    const value = e.type === "password" ? "" : e.value || "";
    const name = (
      e.getAttribute("aria-label") ||
      e.innerText ||
      value ||
      e.placeholder ||
      e.title ||
      e.name ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
    elements.push(`[${n}] ${role} "${name}"`);
  }
  const frames = [...document.querySelectorAll("iframe")].map((f) => f.src || "");
  const captcha =
    frames.some((s) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|geetest|captcha/i.test(s)) ||
    !!document.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile, [id*=captcha i], [class*=captcha i]");
  const login = !!document.querySelector("input[type=password]");
  const text = (document.body ? document.body.innerText : "").slice(0, 15000);
  return JSON.stringify({ url: location.href, title: document.title, text, elements, captcha, login });
})()
