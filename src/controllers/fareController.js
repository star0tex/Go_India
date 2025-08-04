import asyncHandler from 'express-async-handler';
import Rate from '../models/Rate.js';
import { calcFare } from '../utils/fareCalc.js';

/**
 * POST /api/fares/calc
 * Body → { state, city, vehicleType, category, distanceKm, … }
 */
export const createFare = asyncHandler(async (req, res) => {
console.log('[FARE REQ]', req.body);
  /* --------- 1. Destructure request body --------- */
  const {
    state,
    city,
    vehicleType,
    category,
    distanceKm,
    durationMin,
    tripDays,
    returnTrip,
    surge,
    weight,
  } = req.body;

  /* --------- 2. Identify long‑trip --------- */
 const isLongTrip = category === 'long';


  /* --------- 3. Build query (case‑insensitive state/city) --------- */
  const query = {
    state       : new RegExp(`^${state}$`, 'i'),
    vehicleType : vehicleType,
    category    : category,
  };
  if (!isLongTrip) {
    query.city = new RegExp(`^${city}$`, 'i');
  }

  /* --------- 4. Fetch rate doc --------- */
  const rate = await Rate.findOne(query);
  if (!rate) {
    return res.status(404).json({
      ok: false,
      message: 'Rate not found for that city, state, or vehicle',
    });
  }

  /* ────────────────────────────────────────────────
     🚲 PARCEL‑ONLY VALIDATION
     • bike‑only for now
     • weight ≤ maxWeightKg (default 10 kg)
     • distance must be > 0
     ──────────────────────────────────────────────── */
  if (rate.category === 'parcel') {
    // (A) Enforce bike vehicle
    if (vehicleType !== 'bike') {
      return res.status(400).json({
        ok      : false,
        message : 'Parcel delivery is currently supported only by bikes',
      });
    }

    // (B) Weight guard
    const maxKg = rate.maxWeightKg ?? 10;          // new schema field
    const w     = Number(weight) || 0;
    if (w > maxKg) {
      return res.status(400).json({
        ok      : false,
        message : `Bike parcels cannot exceed ${maxKg} kg`,
      });
    }

    // (C) Positive distance guard
    if (!distanceKm || distanceKm <= 0) {
      return res.status(400).json({
        ok      : false,
        message : 'distanceKm must be a positive number for parcel fare calculation',
      });
    }
  }

  /* --------- 5. Calculate fare --------- */
  let result;
  try {
    result = calcFare({
      rate,
      distanceKm,
      durationMin,
      tripDays,
      returnTrip,
      surge,
      weight,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }

  /* --------- 6. Respond --------- */
  res.json({ ok: true, rateId: rate._id, ...result });
});
