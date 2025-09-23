// src/socket/socketHandler.js
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';
import {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
    acceptTrip, // ✅ NEW: Import the acceptTrip controller

} from '../controllers/tripController.js';
import { emitTripError } from '../utils/errorEmitter.js';

let io;

const connectedDrivers = new Map(); // socketId => userId
const connectedCustomers = new Map(); // socketId => userId

const DISTANCE_LIMITS = {
  short: 5000,
  parcel: 5000,
  long_same_day: 20000,
  long_multi_day: 50000,
};

const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  try {
    if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
      const byId = await User.findById(idOrPhone);
      if (byId) return byId;
    }
    return await User.findOne({ phone: idOrPhone });
  } catch (err) {
    console.error('❌ resolveUserByIdOrPhone error:', err);
    return null;
  }
};

const validateTripPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { type, customerId, pickup, drop } = payload;
  if (!type || !customerId || !pickup || !drop) return false;
  if (!pickup.coordinates || !Array.isArray(pickup.coordinates) || pickup.coordinates.length !== 2) return false;
  if (!drop.coordinates || !Array.isArray(drop.coordinates) || drop.coordinates.length !== 2) return false;
  return true;
};

/**
 * Initialize socket.io handlers
 * @param {Server} ioInstance - The socket.io server instance created in server.js
 */
export const initSocket = (ioInstance) => {
  io = ioInstance;

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // 🔹 Driver status update
   // in socketHandler.js

socket.on('updateDriverStatus', async ({ driverId, isOnline, location, fcmToken, profileData }) => {
  try {
    if (!driverId) return;

    const user = await resolveUserByIdOrPhone(driverId);
    if (!user) {
      console.warn(`updateDriverStatus: user not found for ${driverId}`);
      return;
    }

    const updateData = { socketId: socket.id, isOnline: !!isOnline };

    if (location?.coordinates) {
      updateData.location = {
        type: 'Point',
        coordinates: location.coordinates, // [lng, lat]
      };
    }

    if (fcmToken) {
      updateData.fcmToken = fcmToken;
    }
    
    // ✅ NEW: If profileData is received from the driver's app, merge it into the update.
    if (profileData && typeof profileData === 'object') {
      // This will add fields like name, photoUrl, vehicleBrand, etc., to the update
      Object.assign(updateData, profileData);
    }

    // 🔷 MODIFIED: Use $set to safely update the document with new and existing fields.
    await User.findByIdAndUpdate(user._id, { $set: updateData });
    
    connectedDrivers.set(socket.id, user._id.toString());
    console.log(`📶 Driver ${user._id} is now ${isOnline ? 'online' : 'offline'}. Profile updated.`);
    
  } catch (e) {
    emitTripError({ socket, message: 'Failed to update driver status.' });
    console.error('❌ updateDriverStatus error:', e);
  }
});
    // 🔹 Customer register
   // In socketHandler.js - Fix customer:register handler
// Fix the customer:register handler in socketHandler.js
// Fix the customer:register handler in socketHandler.js
socket.on('customer:register', async ({ customerId }) => {
  try {
    if (!customerId) {
      console.warn('customer:register - customerId missing');
      socket.emit('customer:registered', { success: false, error: 'customerId missing' });
      return;
    }
    
    console.log(`👤 Customer register request: ${customerId} on socket: ${socket.id}`);
    
    const user = await resolveUserByIdOrPhone(customerId);
    if (!user) {
      console.warn(`customer:register - user not found for ${customerId}, adding to connectedCustomers only`);
      
      // Add to connectedCustomers map
      connectedCustomers.set(socket.id, customerId);
      
      socket.emit('customer:registered', { 
        success: true, 
        customerId, 
        socketId: socket.id, 
        note: 'user not in DB, using phone as ID' 
      });
      return;
    }
    
    // ✅ FIX: Remove old socket entries for this customer
    for (const [existingSocketId, existingCustomerId] of connectedCustomers.entries()) {
      if (existingCustomerId === user._id.toString()) {
        console.log(`🗑️ Removing old socket entry: ${existingSocketId} for customer ${existingCustomerId}`);
        connectedCustomers.delete(existingSocketId);
      }
    }
    
    // ✅ FIX: Update socketId in database
    await User.findByIdAndUpdate(user._id, { 
      $set: { socketId: socket.id } 
    });
    
    // ✅ FIX: Add to connectedCustomers map with correct ID
    connectedCustomers.set(socket.id, user._id.toString());
    
    console.log(`✅ Customer registered: ${user._id} with socketId: ${socket.id}`);
    console.log(`📊 Connected customers: ${connectedCustomers.size}`);
    
    // Send confirmation to customer
    socket.emit('customer:registered', { 
      success: true, 
      customerId: user._id.toString(),
      socketId: socket.id 
    });
    
  } catch (e) {
    console.error('❌ customer:register error:', e);
    socket.emit('customer:registered', { success: false, error: e.message });
  }
});    socket.on('customer:request_trip', async (payload) => {
      try {
        if (!validateTripPayload(payload)) {
          emitTripError({ socket, message: 'Invalid trip request payload.' });
          return;
        }
        const { type } = payload;
        let controllerFn;
        if (type === 'short') controllerFn = createShortTrip;
        else if (type === 'parcel') controllerFn = createParcelTrip;
        else if (type === 'long') controllerFn = createLongTrip;
        else {
          emitTripError({ socket, message: 'Unknown trip type.' });
          return;
        }

        const req = { body: payload };
        const res = {
          status: (code) => ({
            json: (data) => {
              socket.emit('trip:request_response', { ...data, status: code });
              if (data.success && data.tripId) {
                console.log(`🛣️ Trip request (${type}) routed. TripId: ${data.tripId}`);
                if (data.drivers === 0) {
                  emitTripError({ socket, tripId: data.tripId, message: 'No drivers available.' });
                }
              } else if (!data.success) {
                emitTripError({ socket, message: data.message });
              }
            },
          }),
        };

        await controllerFn(req, res);
      } catch (e) {
        emitTripError({ socket, message: 'Internal server error.' });
        console.error('❌ customer:request_trip error:', e);
      }
    });

    // 🔹 Driver accepts trip
   // 🔹 Driver accepts trip
// In socketHandler.js - Fix the driver:accept_trip handler
socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
  try {
    console.log(`🚗 Driver ${driverId} accepting trip ${tripId}`);
    
    const trip = await Trip.findById(tripId).lean();
    if (!trip || trip.status !== 'requested') {
      emitTripError({ socket, tripId, message: 'Trip not available' });
      return;
    }

    // GET COMPLETE DRIVER PROFILE - This was missing!
    const driver = await User.findById(driverId).select(
      'name photoUrl rating vehicleBrand vehicleNumber location phone'
    ).lean();
    
    if (!driver) {
      emitTripError({ socket, tripId, message: 'Driver not found' });
      return;
    }

    // Update trip status
    await Trip.findByIdAndUpdate(
      tripId,
      { $set: { assignedDriver: driverId, status: 'driver_assigned' } }
    );

    // Find customer socket
    const customer = await User.findById(trip.customerId).select('socketId name phone').lean();
    let customerSocketId = customer?.socketId;
    
    // Fallback: search in connectedCustomers map
    if (!customerSocketId) {
      for (const [socketId, custId] of connectedCustomers.entries()) {
        if (custId === trip.customerId.toString()) {
          customerSocketId = socketId;
          break;
        }
      }
    }

    if (customerSocketId) {
      const payload = {
        tripId: tripId.toString(),
        driver: {
          id: driver._id.toString(),
          name: driver.name || 'Driver',
          photoUrl: driver.photoUrl || null,
          rating: driver.rating || 4.8,
          vehicleBrand: driver.vehicleBrand || 'Vehicle',
          vehicleNumber: driver.vehicleNumber || 'N/A',
          phone: driver.phone || null,
          location: driver.location ? {
            lat: driver.location.coordinates[1],
            lng: driver.location.coordinates[0]
          } : null
        },
        trip: {
          pickup: { 
            lat: trip.pickup.coordinates[1], 
            lng: trip.pickup.coordinates[0], 
            address: trip.pickup.address || "Pickup Location"
          },
          drop: { 
            lat: trip.drop.coordinates[1], 
            lng: trip.drop.coordinates[0], 
            address: trip.drop.address || "Drop Location"
          }
        }
      };
      
      // Emit to customer
      io.to(customerSocketId).emit('trip:accepted', payload);
      console.log(`📢 Trip acceptance sent with driver details: ${JSON.stringify(payload.driver)}`);
    }

  } catch (e) {
    console.error('❌ driver:accept_trip error:', e);
    emitTripError({ socket, tripId, message: 'Failed to accept trip.' });
  }
});// In the disconnect handler, add cleanup
socket.on('disconnect', async () => {
  try {
    const driverId = connectedDrivers.get(socket.id);
    const customerId = connectedCustomers.get(socket.id);

    if (driverId) {
      await User.findByIdAndUpdate(driverId, { isOnline: false, socketId: null });
      connectedDrivers.delete(socket.id);
      console.log(`🔴 Driver disconnected: ${driverId}`);
    }

    if (customerId) {
      // ✅ FIX: Also remove from connectedCustomers map
      connectedCustomers.delete(socket.id);
      await User.findByIdAndUpdate(customerId, { socketId: null });
      console.log(`👤 Customer disconnected: ${customerId}`);
    }
  } catch (e) {
    console.error('❌ disconnect cleanup error:', e);
  }
});  });

  console.log('🚀 Socket.IO initialized');
};

export { io, connectedDrivers, connectedCustomers };
