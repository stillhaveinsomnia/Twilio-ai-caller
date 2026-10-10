import { parsePhoneNumberFromString } from "libphonenumber-js";

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

const validateNameField = (fieldName, value) => {
  const cleanValue = cleanText(value);
  const invalidChars = /[\u0000-\u001f\u007f\u2028\u2029]/u;

  if (cleanValue.length < 1 || cleanValue.length > 80 || invalidChars.test(cleanValue)) {
    return { error: `Введите ${fieldName} (до 80 символів).` };
  }

  return { value: cleanValue };
};

export function validatePhoneNumber(value) {
  const phoneNumber = parsePhoneNumberFromString(cleanText(value), "US");
  if (!phoneNumber?.isValid() || !["US", "CA"].includes(phoneNumber.country)) {
    return { error: "Введите корректный номер телефона США или Канады." };
  }

  return { value: phoneNumber.number };
}

export function validateLead(input) {
  const firstName = validateNameField("имя", input?.firstName);
  if (firstName.error) {
    return firstName;
  }

  const lastName = validateNameField("фамилию", input?.lastName);
  if (lastName.error) {
    return lastName;
  }

  const phone = validatePhoneNumber(input?.phone);
  if (phone.error) {
    return phone;
  }

  return {
    value: {
      firstName: firstName.value,
      lastName: lastName.value,
      phone: phone.value
    }
  };
}
