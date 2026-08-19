document.getElementById("year").textContent = new Date().getFullYear();

const menuToggle = document.getElementById("menu-toggle");
menuToggle.addEventListener("click", () => {
  document.body.classList.toggle("nav-open");
});

document.querySelectorAll(".nav-links a, .nav-cta").forEach((link) => {
  link.addEventListener("click", () => document.body.classList.remove("nav-open"));
});

const form = document.getElementById("consult-form");
const status = document.getElementById("form-status");

form.addEventListener("submit", (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const data = new FormData(form);
  const firstName = data.get("firstName");
  const lastName = data.get("lastName");
  const email = data.get("email");
  const subject = data.get("subject");
  const message = data.get("message") || "";
  const newsletter = data.get("newsletter") ? "Yes" : "No";

  const body =
    `From: ${firstName} ${lastName} (${email})\n` +
    `Wants updates: ${newsletter}\n\n` +
    `${message}`;

  const mailto =
    `mailto:jake.goldwasser@gmail.com?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;

  window.location.href = mailto;

  status.textContent = "Opening your email client to send this note — thanks for reaching out!";
  status.classList.add("visible");
  form.reset();
});
