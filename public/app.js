const form = document.querySelector("#lead-form");
const status = document.querySelector("#status");
const submitButton = form.querySelector('button[type="submit"]');
const consentCheckbox = form.querySelector('input[name="consent"]');

const setStatus = (message, isError = false) => {
  status.textContent = message;
  status.dataset.error = String(isError);
};

const updateSubmitState = () => {
  submitButton.disabled = !consentCheckbox.checked;
};

consentCheckbox.addEventListener("change", updateSubmitState);
updateSubmitState();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!consentCheckbox.checked) {
    setStatus("Потрібна згода на обробку персональних даних.", true);
    return;
  }

  setStatus("Надсилаємо заявку…");
  submitButton.disabled = true;

  const values = new FormData(form);
  const payload = {
    firstName: values.get("firstName"),
    lastName: values.get("lastName"),
    phone: values.get("phone")
  };

  try {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Не вдалось надіслати заявку.");
    }

    form.reset();
    consentCheckbox.checked = false;
    updateSubmitState();
    setStatus("Заявку прийнято. Оператор перевірить її і за потреби зателефонує.");
  } catch (error) {
    setStatus(error.message || "Помилка надсилання. Спробуйте ще раз.", true);
  } finally {
    updateSubmitState();
  }
});
