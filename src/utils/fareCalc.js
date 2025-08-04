/**
 * @param {Object}  p
 * @param {Object}  p.rate          – Mongoose doc fetched by the controller
 * @param {number}  p.distanceKm
 * @param {number}  [p.durationMin]
 * @param {number}  [p.tripDays=1]  – long trips only
 * @param {boolean} [p.returnTrip=true]
 * @param {number}  [p.surge=1]
 * @param {number}  [p.weight=0]    – for parcel only
 */
export function calcFare({
  rate,
  distanceKm = 0,
  durationMin = 0,
  tripDays = 1,
  returnTrip = true,
  surge = 1,
  weight = 0,
}) {
  if (!rate) throw new Error('Rate doc missing');

  const category = rate.category;

  /* ════════ PARCEL‑DELIVERY ════════ */
  if (category === 'parcel') {
    const baseFare     = rate.baseFare     ?? 25;
    const perKm        = rate.perKm        ?? 7;
    const platformFee  = rate.platformFee  ?? 15;
    const maxWeightKg  = rate.maxWeightKg  ?? 10;

    if (weight > maxWeightKg) {
      throw new Error(`Parcel weight exceeds ${maxWeightKg} kg bike limit`);
    }

    const weightCharges = (() => {
      const { baseKg = 0, baseCharge = 0, perExtraKg = 0 } = rate.weightRates ?? {};
      const extraKg = Math.max(0, weight - baseKg);
      return baseCharge + (extraKg * perExtraKg);
    })();

    const deliveryCharge = perKm * distanceKm;

    let total = baseFare + deliveryCharge + weightCharges + platformFee;
    total = Math.ceil(total / 5) * 5;

    return {
      type: 'parcel',
      breakdown: {
        baseFare,
        deliveryCharge,
        weightCharges,
        platformFee,
      },
      total,
    };
  }

  /* ═════════════════════════════════════════════════════
     SHORT‑TRIP  (bike / auto / prime / car / xl)
     ════════════════════════════════════════════════════ */
  else if (category === 'short') {
    const chargeableDistance = Math.max(0, distanceKm - (rate.baseFareDistanceKm ?? 0));
    const farePieces = {
      baseFare: rate.baseFare,
      distanceFare: rate.perKm * chargeableDistance,
      timeFare: rate.perMin * durationMin,
      platformFee: ((rate.platformFeePercent ?? 0) / 100),
    };

    let subtotal = farePieces.baseFare + farePieces.distanceFare + farePieces.timeFare;
    subtotal += subtotal * farePieces.platformFee;

    const surgeAmt = (surge > 1) ? subtotal * (surge - 1) : 0;
    let total = subtotal + surgeAmt;

    if (rate.gstPercent) total += total * (rate.gstPercent / 100);
    if (rate.minFare) total = Math.max(total, rate.minFare);

    return {
      type: 'short',
      breakdown: { ...farePieces, surgeAmt },
      total: Math.round(total),
    };
  }

  /* ════════════════════════════════════════════════════
     LONG‑TRIP  (car / premium / xl)
     ════════════════════════════════════════════════════ */
  else if (category === 'long') {
    const vehicleType = rate.vehicleType;
    const driverFees = {
      car:     { firstDay: 1500, extraDay: 900 },
      premium: { firstDay: 1800, extraDay: 1000 },
      xl:      { firstDay: 2000, extraDay: 1100 }
    };

    const feeSet = driverFees[vehicleType];
    if (!feeSet) throw new Error(`Missing driver fee config for vehicle type: ${vehicleType}`);

    const fuelOneWay = distanceKm * rate.fuelPerKm;
    const fuel = returnTrip ? fuelOneWay * 2 : fuelOneWay;

    let driverFee = 0;
    if (returnTrip) {
      driverFee = feeSet.firstDay + (tripDays - 1) * feeSet.extraDay;
    } else {
      driverFee = (feeSet.firstDay / 2) + fuelOneWay; // driver returns solo
    }

    const total = Math.round(driverFee + fuel);

    return {
      type: 'long',
      breakdown: { fuel, driverFee },
      total
    };
  }

  // ❌ Invalid category
  else {
    throw new Error(`Unknown category: ${category}`);
  }
}
