// src/utils/requiredDocs.js

const requiredDocs = {
  auto: ["license", "rc", "pan", "aadhaar", "fitnessCertificate"],
  car: ["license", "rc", "pan", "aadhaar", "fitnessCertificate", "permit", "insurance"],
  bike: ["license", "rc", "pan", "aadhaar"], // optional default
};

// Optional: helper function
export const getRequiredDocsByVehicle = (vehicleType) => {
  return requiredDocs[vehicleType] || requiredDocs.bike;
};

export default requiredDocs;
