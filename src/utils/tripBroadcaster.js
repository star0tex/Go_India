// src/utils/tripBroadcaster.js
import { sendToDriver } from '../utils/fcmSender.js';
import { io } from '../socket/socketHandler.js';

/**
 * Broadcast trip request to drivers via socket or FCM.
 * - Socket can carry numbers (e.g. fare)
 * - FCM must carry strings only
 */
const broadcastToDrivers = (drivers, tripPayload) => {
  console.log('');
  console.log('='.repeat(70));
  console.log('📡 BROADCASTING TRIP TO DRIVERS');
  console.log('='.repeat(70));
  console.log('📦 Received Payload:');
  console.log(`   Trip ID: ${tripPayload.tripId}`);
  console.log(`   Vehicle Type: ${tripPayload.vehicleType}`);
  console.log(`   Fare (raw): ${tripPayload.fare}`);
  console.log(`   Fare type: ${typeof tripPayload.fare}`);
  console.log(`   Fare is number: ${typeof tripPayload.fare === 'number'}`);
  console.log(`   Fare > 0: ${tripPayload.fare > 0}`);
  console.log(`   Number of drivers: ${drivers?.length || 0}`);
  console.log('='.repeat(70));
  console.log('');

  if (!drivers || !drivers.length) {
    console.warn(`⚠️ No drivers to broadcast for trip ${tripPayload.tripId}`);
    return { success: false };
  }

  let notified = 0;

  // ✅ FCM-safe (all strings)
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
    // 🔹 Fare as string for FCM
    fare: String(tripPayload.fare ?? 0),
    paymentMethod: String(tripPayload.paymentMethod ?? 'Cash'),
  };

  console.log('📋 FCM Payload prepared:');
  console.log(`   Fare (string): "${fcmPayload.fare}"`);
  console.log('');

  drivers.forEach((driver, index) => {
    const socketId = driver.socketId;
    const driverVehicle = driver.vehicleType || 'car';

    // ✅ Socket-safe payload (numbers are fine)
    const payloadForSocket = {
      ...tripPayload,
      vehicleType: String(tripPayload.vehicleType || driverVehicle || 'car'),
      fare: Number(tripPayload.fare ?? 0),
    };

    console.log(`\n👤 Driver ${index + 1}/${drivers.length}:`);
    console.log(`   Driver ID: ${driver._id}`);
    console.log(`   Driver Name: ${driver.name || 'N/A'}`);
    console.log(`   Vehicle Type: ${driver.vehicleType}`);
    console.log(`   Socket ID: ${socketId || 'NONE'}`);
    console.log(`   FCM Token: ${driver.fcmToken ? 'YES' : 'NO'}`);
    console.log(`   Fare being sent: ${payloadForSocket.fare} (${typeof payloadForSocket.fare})`);

    if (socketId) {
      io.to(socketId).emit('trip:request', payloadForSocket);
      io.to(socketId).emit('tripRequest', payloadForSocket); // legacy
      console.log(`   ✅ Sent via SOCKET`);
      console.log(`      Event: trip:request`);
      console.log(`      Fare: ${payloadForSocket.fare}`);
      notified++;
    } else if (driver.fcmToken) {
      sendToDriver(driver.fcmToken, 'New Ride Request', 'A trip request is available', fcmPayload);
      console.log(`   ✅ Sent via FCM`);
      console.log(`      Fare (string): "${fcmPayload.fare}"`);
      notified++;
    } else {
      console.log(`   ❌ No socket or FCM token - SKIPPED`);
    }
  });

  console.log('');
  console.log('='.repeat(70));
  console.log('📊 BROADCAST SUMMARY:');
  console.log(`   Total drivers: ${drivers.length}`);
  console.log(`   Successfully notified: ${notified}`);
  console.log(`   Failed: ${drivers.length - notified}`);
  console.log(`   Trip ID: ${tripPayload.tripId}`);
  console.log(`   Fare broadcasted: ₹${tripPayload.fare}`);
  console.log('='.repeat(70));
  console.log('');

  return notified > 0 ? { success: true, count: notified } : { success: false };
};

export { broadcastToDrivers };