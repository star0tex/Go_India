import { sendToDriver } from '../utils/fcmSender.js';
import { io } from '../socket/socketHandler.js';

/**
 * Broadcast trip request to drivers via socket or FCM.
 * @param {Array} drivers - Array of User documents (must contain socketId, fcmToken).
 * @param {Object} tripPayload - Trip details (tripId, type, pickup, drop, vehicleType, customerId, etc).
 * @returns {Object} { success: boolean, count?: number }
 */
const broadcastToDrivers = (drivers, tripPayload) => {
  if (!drivers || !drivers.length) {
    console.warn(`⚠️ No drivers to broadcast for trip ${tripPayload.tripId}`);
    return { success: false };
  }

  let notified = 0;

  drivers.forEach((driver) => {
    if (driver.socketId) {
      io.to(driver.socketId).emit('trip:request', tripPayload);
      io.to(driver.socketId).emit('tripRequest', tripPayload); // legacy support
      console.log(`📤 Trip ${tripPayload.tripId} sent via socket to driver ${driver._id}`);
      notified++;
    } else if (driver.fcmToken) {
      sendToDriver(
        driver.fcmToken,
        'New Ride Request',
        'A trip request is available',
        tripPayload
      );
      console.log(`📲 Trip ${tripPayload.tripId} sent via FCM to driver ${driver._id}`);
      notified++;
    } else {
      console.log(`❌ Driver ${driver._id} has no socketId or fcmToken for trip ${tripPayload.tripId}`);
    }
  });

  if (notified > 0) {
    return { success: true, count: notified };
  } else {
    console.warn(`⚠️ No drivers could be notified for trip ${tripPayload.tripId}`);
    return { success: false };
  }
};

export { broadcastToDrivers };