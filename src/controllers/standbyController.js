// src/controllers/standbyController.js

import Standby from '../models/standby.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js'; // ✅ Socket.io instance
import { sendToDriver } from '../utils/fcmSender.js'; // ✅ FCM push utility

/**
 * ➕ Add standby drivers for a trip
 */
export const addToStandby = async (tripId, driverIds) => {
  try {
    await Standby.findOneAndUpdate(
      { tripId },
      { $set: { driverQueue: driverIds, currentIndex: 0 } },
      { upsert: true }
    );
    console.log(`📥 Standby queue created for trip ${tripId}`);
  } catch (err) {
    console.error(`❌ Error in addToStandby:`, err.message);
  }
};

/**
 * 🔁 Promote next standby driver (called via cron or timeout)
 */
export const promoteNextStandby = async (tripId) => {
  try {
    const standby = await Standby.findOne({ tripId });
    const trip = await Trip.findById(tripId);

    if (!standby || !trip || trip.status !== 'requested') {
      console.log(`⛔ No standby promotion: Missing data or trip not requested`);
      return;
    }

    const nextDriverId = standby.driverQueue[standby.currentIndex];
    if (!nextDriverId) {
      console.log(`⚠️ No more drivers in standby queue for trip ${tripId}`);
      return;
    }

    const driver = await User.findById(nextDriverId);
    if (!driver) {
      console.log(`❌ Driver not found: ${nextDriverId}`);
      return;
    }

    const payload = {
      tripId: trip._id.toString(),
      pickup: trip.pickup,
      drop: trip.drop,
      vehicleType: trip.vehicleType,
      type: trip.type,
    };

    // ✅ Send ride request to driver via socket or FCM
    if (driver.socketId) {
      io.to(driver.socketId).emit('trip:request', payload);
      console.log(`📡 Sent ride request to standby driver ${driver._id} via socket`);
    } else if (driver.fcmToken) {
      await sendToDriver(
        driver.fcmToken,
        'New Ride Request',
        'You have been promoted from standby queue.',
        payload
      );
      console.log(`📲 Sent ride request to standby driver ${driver._id} via FCM`);
    }

    standby.currentIndex += 1;
    await standby.save();
    console.log(`✅ Updated standby index to ${standby.currentIndex} for trip ${tripId}`);
  } catch (err) {
    console.error(`❌ Error in promoteNextStandby:`, err.message);
  }
};

/**
 * ♻️ Reassign trip to next standby driver if previous expired
 */
export const reassignStandbyDriver = async (trip) => {
  try {
    const standby = await Standby.findOne({ tripId: trip._id });
    if (!standby) {
      console.log(`ℹ️ No standby found for trip ${trip._id}`);
      return;
    }

    await promoteNextStandby(trip._id);
  } catch (err) {
    console.error(`❌ Error in reassignStandbyDriver:`, err.message);
  }
};
