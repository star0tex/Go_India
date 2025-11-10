/**
 * Go India Fare Calculation (Smart Competitive + DB-Aware + Time-Based + Night Surge v6)
 * Fully synced with MongoDB rate schema.
 * Automatically falls back to internal config if DB data missing.
 */

export function calcFare({
  rate,
  distanceKm = 0,
  durationMin = 0,
  tripDays = 1,
  returnTrip = true,
  surge = 1,
  weight = 0,
  competitorFare = null,
  startTime = null,
  dropTime = null,
}) {
  if (!rate) throw new Error("Rate document missing.");

  const category = rate.category;
  if (category !== "short") throw new Error(`Unsupported category: ${category}`);

  const vehicle = rate.vehicleType?.toLowerCase?.() || "bike";
  const roundOff = (num) => Math.round(num / 5) * 5;

  // ✅ Internal fallback config
  const internal = {
    bike: { baseFare: 30, baseFareDistanceKm: 1, perKm: 10, minFare: 55, platformCommission: 0.10 },
    auto: { baseFare: 45, baseFareDistanceKm: 2, perKm: 14, minFare: 70, platformCommission: 0.10 },
    car: { baseFare: 70, baseFareDistanceKm: 2, perKm: 22, minFare: 90, platformCommission: 0.12 },
    premium: { baseFare: 80, baseFareDistanceKm: 2, perKm: 24, minFare: 100, platformCommission: 0.12 },
    xl: { baseFare: 95, baseFareDistanceKm: 2, perKm: 26, minFare: 120, platformCommission: 0.12 },
  };

  // ✅ Load from DB or fallback
  const baseFare = rate.baseFare ?? internal[vehicle].baseFare;
  const baseDistance = rate.baseFareDistanceKm ?? internal[vehicle].baseFareDistanceKm;
  const perKm = rate.perKm ?? internal[vehicle].perKm;
  const perMin = rate.perMin ?? 0;
  const platformCommission = (rate.platformFeePercent ?? (internal[vehicle].platformCommission * 100)) / 100;
  const gstPercent = rate.gstPercent ?? 0;
  const minFare = rate.minFare ?? internal[vehicle].minFare;

  // --- Platform Fee ---
  // --- Platform Fee (Updated to 5 / 7 / 10 / 15) ---
const platformFee =
  distanceKm <= 3 ? 5 :       // 0–3 km  → ₹5
  distanceKm <= 5 ? 7 :       // 3–5 km  → ₹7
  distanceKm <= 10 ? 10 :     // 5–10 km → ₹10
  15;                         // >10 km  → ₹15

  // --- Base Fare Calculation ---
  const chargeableDistance = Math.max(0, distanceKm - baseDistance);
  let baseFareTotal =
    baseFare + chargeableDistance * perKm + platformFee + durationMin * perMin;

  // --- Surge Multiplier ---
  const surgeMultiplier = rate.manualSurge ?? surge ?? 1;
  baseFareTotal *= surgeMultiplier;

  // --- Time Analysis ---
  const hour = new Date(startTime || new Date()).getHours();
  const peakHour = (hour >= 7 && hour < 10) || (hour >= 17 && hour < 21);
  const nightHour = hour >= 22 || hour < 6;

  // --- Duration per KM ---
  let tripDuration = durationMin;
  if (!tripDuration && startTime && dropTime) {
    try {
      const start = new Date(startTime);
      const end = new Date(dropTime);
      tripDuration = Math.max((end - start) / 60000, 1);
    } catch {
      tripDuration = durationMin || 0;
    }
  }
  const durationPerKm = tripDuration && distanceKm > 0 ? tripDuration / distanceKm : 0;

  // --- Apply Peak Boost ---
// --- Apply DB-Controlled Peak/Night Multipliers ---
if (peakHour) {
  const peakBoost = rate.peakMultiplier || 1.10;
  baseFareTotal *= peakBoost;
  console.log(`🚀 Applied peakMultiplier from DB: ${peakBoost}`);
}

if (nightHour) {
  const nightBoost = rate.nightMultiplier || 1.33;
  baseFareTotal *= nightBoost;
  console.log(`🌙 Applied nightMultiplier from DB: ${nightBoost}`);
}


// --- Discount Logic ---
let discountApplied = 0;
let finalFare = baseFareTotal;

if (competitorFare) {
  // Make it 10–15 ₹ cheaper regardless of distance
  discountApplied = peakHour
    ? Math.floor(Math.random() * 6) + 5   // ₹5–₹10 cheaper during peak
    : Math.floor(Math.random() * 6) + 10; // ₹10–₹15 cheaper off-peak

  // If short distance (<3 km), add extra ₹5 discount to match ratio
  if (distanceKm <= 3) discountApplied += 5;

  if (durationPerKm > 5) discountApplied = Math.max(discountApplied - 3, 5);
  finalFare = competitorFare - discountApplied;
} else {
  // No competitorFare given — simulate similar 10–15 % cheaper pricing
  const fallbackDiscount = Math.floor(Math.random() * 6) + 10;
  const distanceBoost = distanceKm <= 3 ? 1.05 : 1.0; // add ~5 % more discount on short trips
  finalFare = (baseFareTotal - fallbackDiscount) * 0.85 * distanceBoost;
  discountApplied = fallbackDiscount;
}

  // --- Add Rider-Friendly Flat Adjustment ---
  finalFare += 20;

  // --- GST, Platform & Rounding ---
  const gstAmount = (finalFare * gstPercent) / 100;
  const platformCut = finalFare * platformCommission;
  const total = Math.max(roundOff(finalFare + gstAmount), minFare);
  const driverGets = total - platformCut;

  console.log(
    `🕒 Hour: ${hour} | ${peakHour ? "🚀 Peak" : nightHour ? "🌙 Night" : "☀️ Off"} | ${distanceKm} km | ${vehicle} | ₹${total}`
  );

  return {
    success: true,
    type: "short",
    vehicleType: vehicle,
    total,
    remarks: `Calculated (${peakHour ? "Peak" : nightHour ? "Night" : "Off-Peak"}) — includes dynamic multipliers.`,
    breakdown: {
      baseFare,
      perKm,
      perMin,
      platformFee,
      surgeMultiplier,
      tripDuration: `${Math.round(tripDuration)} mins`,
      peakHour,
      nightHour,
      discountApplied,
      platformCommissionPercent: platformCommission * 100,
      gstAmount: roundOff(gstAmount),
      platformEarning: roundOff(platformCut),
      driverEarning: roundOff(driverGets),
    },
  };
}
