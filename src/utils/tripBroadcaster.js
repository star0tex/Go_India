// src/utils/tripBroadcaster.js
import { sendToDriver } from '../utils/fcmSender.js';
import { io } from '../socket/socketHandler.js';

/**
 * Broadcast trip request to drivers via socket or FCM.
 * Ensures FCM payload only contains string values.
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

  // Create an FCM-safe payload (strings only)
  const fcmPayload = {
    tripId: String(tripPayload.tripId),
    type: String(tripPayload.type || ''),
    vehicleType: String(tripPayload.vehicleType || ''),
    customerId: String(tripPayload.customerId || ''),
    pickup: JSON.stringify({
      lat: String(tripPayload.pickup?.lat ?? ''),
      lng: String(tripPayload.pickup?.lng ?? ''),
      address: tripPayload.pickup?.address || '',
    }),
    drop: JSON.stringify({
      lat: String(tripPayload.drop?.lat ?? ''),
      lng: String(tripPayload.drop?.lng ?? ''),
      address: tripPayload.drop?.address || '',
    }),
    fare: String(tripPayload.fare ?? 0),
    paymentMethod: String(tripPayload.paymentMethod ?? 'Cash'),
  };

  drivers.forEach((driver) => {
    // Prefer socket (live)
    const socketId = driver.socketId; // should be saved on the User document during updateDriverStatus
    const driverVehicle = driver.vehicleType || 'car';

    // Ensure socket payload has a non-empty vehicleType
    const payloadForSocket = {
      ...tripPayload,
      vehicleType: String(tripPayload.vehicleType || driverVehicle || 'car'),
    };

    if (socketId) {
      io.to(socketId).emit('trip:request', payloadForSocket);
      io.to(socketId).emit('tripRequest', payloadForSocket); // legacy event for older clients
      console.log(`📤 Trip ${tripPayload.tripId} sent via socket to driver ${driver._id}`);
      notified++;
    } else if (driver.fcmToken) {
      // send via FCM (data-only payloads must be strings)
      sendToDriver(driver.fcmToken, 'New Ride Request', 'A trip request is available', fcmPayload);
      console.log(`📲 Trip ${tripPayload.tripId} sent via FCM to driver ${driver._id}`);
      notified++;
    } else {
      console.log(`❌ Driver ${driver._id} has no socketId or fcmToken for trip ${tripPayload.tripId}`);
    }
  });

  return notified > 0 ? { success: true, count: notified } : { success: false };
};

export { broadcastToDrivers };
