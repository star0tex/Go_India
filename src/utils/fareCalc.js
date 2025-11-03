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

  /* ════════ PARCEL-DELIVERY ════════ */
  if (category === 'parcel') {
    const baseFare     = rate.baseFare     ?? 25;
    const perKm        = rate.perKm        ?? 7;
    const platformFee  = (() => {
      if (distanceKm <= 3) return 5;
      if (distanceKm <= 5) return 7;
      if (distanceKm <= 10) return 10;
      return 15;
    })();
    const maxWeightKg  = rate.maxWeightKg  ?? 10;

    if (weight > maxWeightKg) {
      throw new Error(`Parcel weight exceeds ${maxWeightKg} kg bike limit`);
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
     SHORT-TRIP  (bike / auto / car / premium / xl)
     ════════════════════════════════════════════════════ */
  else if (category === 'short') {
    const vehicle = rate.vehicleType?.toLowerCase?.() || 'bike';

    // ---- Base & distance tiers ----
    const tiers = {
      bike: {
        baseFare: 20,
        baseDistance: 1,
        timeRate: 0.7,
        perKm: (d) => (d <= 5 ? 6 : d <= 10 ? 7 : d <= 15 ? 8 : d <= 20 ? 9 : 10),
        minFare: 45
      },
      auto: {
        baseFare: 40,
        baseDistance: 2,
        timeRate: (d) => (d <= 10 ? 1.5 : 2),
        perKm: () => 14,
        minFare: 80
      },
      car: {
        baseFare: 70,
        baseDistance: 2,
        timeRate: (d) => (d <= 10 ? 2.5 : 3),
        perKm: () => 15,
        minFare: 100
      },
      premium: {
        baseFare: 100,
        baseDistance: 2,
        timeRate: (d) => (d <= 10 ? 4 : 5),
        perKm: () => 19,
        minFare: 130
      },
      xl: {
        baseFare: 120,
        baseDistance: 2,
        timeRate: (d) => (d <= 10 ? 6 : 7),
        perKm: () => 20,
        minFare: 160
      }
    };

    const v = tiers[vehicle] ?? tiers.bike;
    const chargeableDistance = Math.max(0, distanceKm - v.baseDistance);

    // ---- Platform fee slab ----
    const platformFee = (() => {
      if (distanceKm <= 3) return 5;
      if (distanceKm <= 5) return 7;
      if (distanceKm <= 10) return 10;
      return 15;
    })();

    // ---- Effective weights for realistic fares ----
    const distWeight = distanceKm < 5 ? 1.15 : 1.0;
    const timeWeight = distanceKm < 5 ? 1.1 : 1.0;

    const distanceFare = v.perKm(distanceKm) * chargeableDistance * distWeight;
    const timeFare = (typeof v.timeRate === 'function' ? v.timeRate(distanceKm) : v.timeRate) * durationMin * timeWeight;

    let total = v.baseFare + distanceFare + timeFare + platformFee;

    // ---- Apply minimum fare safeguard ----
    total = Math.max(total, v.minFare);

    // ---- Apply surge if any ----
    total *= surge;

    // ---- Round to nearest ₹5 ----
    total = Math.round(total / 5) * 5;

    return {
      type: 'short',
      breakdown: { baseFare: v.baseFare, distanceFare, timeFare, platformFee },
      total
    };
  }

  /* ════════════════════════════════════════════════════
     LONG-TRIP  (car / premium / xl)
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

  else {
    throw new Error(`Unknown category: ${category}`);
  }
}