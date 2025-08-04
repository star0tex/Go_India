/* eslint-disable no-console */
/* ------------------ 1. Load env & deps ------------------ */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Rate from '../models/Rate.js';

/* ------------------ 2. Connect to Mongo ------------------ */
await connectDB();

/* ------------------ 3. Define tariff cards --------------- */
/**
 * One object = one document in the Rate collection.
 * Hyderabad for short and parcel. Long‑trip rates apply to entire Telangana.
 */
const rates = [
  /* ────────────── Hyderabad, Telangana ────────────── */

  // Short‑trip: Bike, Auto, Prime, Car, XL
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'bike',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 25,
    perKm: 6,
    perMin: 1,
    minFare: 25,
    platformFeePercent: 3,
    gstPercent: 5,
  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'auto',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 30,
    perKm: 8,
    perMin: 1,
    minFare: 35,
    platformFeePercent: 3,
    gstPercent: 5,
  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'car',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 45,
    perKm: 12,
    perMin: 2,
    minFare: 50,
    platformFeePercent: 5,
    gstPercent: 5,
  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'premium',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 50,
    perKm: 14,
    perMin: 2,
    minFare: 60,
    platformFeePercent: 5,
    gstPercent: 5,
  },
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'xl',
    category: 'short',
    baseFareDistanceKm: 2,
    baseFare: 60,
    perKm: 16,
    perMin: 3,
    minFare: 70,
    platformFeePercent: 5,
    gstPercent: 5,
  },

  // Long‑trip: Intercity (same state) — applies to full state (city not needed)
  {
    state: 'telangana',
    vehicleType: 'car',
    category: 'long',
    fuelPerKm: 15,
    day1DriverFee: 1500,
    subsequentDayDriverFee: 900,
    halfDayReturnFee: 750,
  },
  {
    state: 'telangana',
    vehicleType: 'premium',
    category: 'long',
    fuelPerKm: 18,
    day1DriverFee: 1800,
    subsequentDayDriverFee: 1000,
    halfDayReturnFee: 850,
  },
  {
    state: 'telangana',
    vehicleType: 'xl',
    category: 'long',
    fuelPerKm: 20,
    day1DriverFee: 2000,
    subsequentDayDriverFee: 1100,
    halfDayReturnFee: 900,
  },

  // Parcel Delivery  (🚲 Bike only)
  {
    state: 'telangana',
    city: 'hyderabad',
    vehicleType: 'bike',
    category: 'parcel',

    /* ––––– Fare inputs for calcFare(parcel) ––––– */
    baseFare    : 25,   // fixed pickup / wait cost
    perKm       : 7,    // distance component
    platformFee : 15,   // flat margin / handling
    maxWeightKg : 10,   // bike limit

    /* Optional per‑kg surcharges */
    weightRates: {
      baseKg     : 5,   // first 5 kg covered in base
      baseCharge : 40,  // charge applied if weight > baseKg
      perExtraKg : 5    // ₹/kg beyond baseKg
    }
  },
];

/* ------------------ 4. Seed the collection --------------- */
console.log('⏳  Clearing existing rates for Telangana…');
await Rate.deleteMany({ state: 'telangana' }); // remove old Telangana rates

console.log(`⏳  Inserting ${rates.length} tariff cards…`);
await Rate.insertMany(rates);

console.log('✅  Seed complete!');

await mongoose.disconnect();
process.exit(0);
