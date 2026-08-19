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
const submitBtn = form.querySelector('button[type="submit"]');
const ajaxEndpoint = form.action.replace("formsubmit.co/", "formsubmit.co/ajax/");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const data = new FormData(form);
  data.set("newsletter", data.get("newsletter") ? "Yes" : "No");

  submitBtn.disabled = true;
  submitBtn.textContent = "Sending...";
  status.classList.remove("visible");

  try {
    const res = await fetch(ajaxEndpoint, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: data,
    });

    if (!res.ok) throw new Error("Request failed");

    status.textContent = "Thanks for reaching out — your note is on its way. We'll follow up soon!";
    form.reset();
  } catch (err) {
    status.textContent = "Something went wrong sending your note. Please try again in a moment.";
  } finally {
    status.classList.add("visible");
    submitBtn.disabled = false;
    submitBtn.textContent = "Send Note";
  }
});
