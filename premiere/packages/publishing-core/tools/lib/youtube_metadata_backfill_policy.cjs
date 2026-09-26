"use strict";

const MAX_DESCRIPTION_LENGTH = 5000;

function isValidGeneratedDescription(sourceDescription, localizedDescription) {
  if (
    typeof sourceDescription !== "string"
    || typeof localizedDescription !== "string"
    || localizedDescription.length > MAX_DESCRIPTION_LENGTH
  ) {
    return false;
  }
  if (sourceDescription === "") {
    return localizedDescription === "";
  }
  return localizedDescription.trim().length > 0;
}

function sameLocalizationDescription(actualDescription, expectedDescription) {
  if (
    (actualDescription != null && typeof actualDescription !== "string")
    || typeof expectedDescription !== "string"
  ) {
    return false;
  }
  return (actualDescription ?? "") === expectedDescription;
}

module.exports = {
  MAX_DESCRIPTION_LENGTH,
  isValidGeneratedDescription,
  sameLocalizationDescription,
};
