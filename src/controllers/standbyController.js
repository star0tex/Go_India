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

    // 🚫 Safety checks
    if (!standby || !trip || trip.status !== 'requested') {
      console.log(`⛔ No standby promotion: Missing data or trip not requested`);
      return;
    }

    // 🚫 If already assigned, no need to promote
    if (trip.assignedDriver) {
      console.log(`🚫 Trip ${tripId} already assigned to driver ${trip.assignedDriver}`);
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

    // 🚫 Avoid duplicate pending requests
    if (trip.pendingDrivers?.includes(driver._id.toString())) {
      console.log(`⚠️ Driver ${driver._id} already has a pending request for trip ${tripId}`);
      return;
    }

    const payload = {
      tripId: trip._id.toString(),
      pickup: trip.pickup || trip.pickupLocation, // ✅ Support both formats
      drop: trip.drop || trip.dropLocation,       // ✅ Support both formats
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
    } else {
      console.log(`⚠️ Driver ${driver._id} has no socket or FCM token`);
    }

    // 📌 Mark driver as pending for this trip (optional but safe)
    if (!trip.pendingDrivers) trip.pendingDrivers = [];
    trip.pendingDrivers.push(driver._id.toString());
    await trip.save();

    // ⏳ DO NOT increment index immediately — better to handle in timeout/reject
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

/**
 * 🧹 Cleanup standby queue when trip is no longer active
 */
export const cleanupStandbyQueue = async (tripId) => {
  try {
    await Standby.deleteOne({ tripId });
    console.log(`🧹 Cleaned standby queue for trip ${tripId}`);
  } catch (err) {
    console.error(`❌ Error cleaning standby queue:`, err.message);
  }
};
