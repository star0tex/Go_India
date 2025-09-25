// src/socket/socketHandler.js
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';
import {
  createShortTrip,
  createParcelTrip,
  createLongTrip,

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

// Replace your existing 'updateDriverStatus' handler with this:

socket.on('updateDriverStatus', async (payload = {}) => {
  try {
    const {
      driverId,
      isOnline,
      location,   // optional: { coordinates: [lng, lat] }
      lat,        // optional: number
      lng,        // optional: number
      fcmToken,
      profileData,
      vehicleType,
    } = payload;

    if (!driverId) return;

    // Resolve user by _id or phone
    const isObjectId = (val) => typeof val === 'string' && /^[0-9a-fA-F]{24}$/.test(val);
    const user = isObjectId(driverId)
      ? await User.findById(driverId)
      : await User.findOne({ phone: driverId });

    if (!user) {
      console.warn(`updateDriverStatus: user not found for ${driverId}`);
      return;
    }

    const set = {
      socketId: socket.id,
      isOnline: !!isOnline,
    };

    // Location: accept either 'location.coordinates' or raw lat/lng
    if (location?.coordinates?.length === 2) {
      set.location = { type: 'Point', coordinates: location.coordinates }; // [lng, lat]
    } else if (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      !Number.isNaN(lat) &&
      !Number.isNaN(lng)
    ) {
      set.location = { type: 'Point', coordinates: [lng, lat] };
    }

    if (fcmToken) set.fcmToken = fcmToken;

    // Only allow safe profile keys (exclude phone to avoid unique index collisions)
    const allowedProfileKeys = [
      'name',
      'photoUrl',
      'rating',
      'vehicleBrand',
      'vehicleNumber',
      'vehicleType',
    ];

    if (profileData && typeof profileData === 'object') {
      for (const key of allowedProfileKeys) {
        if (profileData[key] !== undefined && profileData[key] !== null) {
          set[key] =
            key === 'vehicleType'
              ? String(profileData[key]).toLowerCase().trim()
              : profileData[key];
        }
      }
    }

    // Also allow explicit vehicleType arg
    if (vehicleType) {
      set.vehicleType = String(vehicleType).toLowerCase().trim();
    }

    await User.findByIdAndUpdate(user._id, { $set: set }, { new: true });

    // Track in memory map
    connectedDrivers.set(socket.id, user._id.toString());

    // Optional ack back to driver
    socket.emit('driver:statusUpdated', { ok: true, isOnline: !!isOnline });

    console.log(`📶 Driver ${user._id} is now ${isOnline ? 'online' : 'offline'}.`);
  } catch (e) {
    emitTripError({ socket, message: 'Failed to update driver status.' });
    console.error('❌ updateDriverStatus error:', e);
  }
});    // 🔹 Customer register
   // In socketHandler.js - Fix customer:register handler
// Fix the customer:register handler in socketHandler.js
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

    // Always resolve by DB ID or phone, but prefer DB ID for mapping
    const user = await resolveUserByIdOrPhone(customerId);

    if (!user) {
      console.warn(`❌ customer:register - user not found for ${customerId}`);

      // Only add to connectedCustomers map with the provided ID (should be DB ID from frontend)
      connectedCustomers.set(socket.id, customerId);

      socket.emit('customer:registered', {
        success: true,
        customerId: customerId,
        socketId: socket.id,
        note: 'user not in DB, using provided ID'
      });
      console.log(`📝 Added customer to map with provided ID: ${customerId}`);
      return;
    }

    // Remove any old socket entries for this customer (by DB ID or phone)
    for (const [existingSocketId, existingCustomerId] of connectedCustomers.entries()) {
      if (
        existingCustomerId === user._id.toString() ||
        existingCustomerId === user.phone
      ) {
        console.log(`🗑️ Removing old socket entry: ${existingSocketId} for customer ${existingCustomerId}`);
        connectedCustomers.delete(existingSocketId);

        // Also update the database
        await User.findByIdAndUpdate(user._id, {
          $set: { socketId: null }
        });
      }
    }

    // Update socketId in database
    try {
      await User.findByIdAndUpdate(user._id, {
        $set: { socketId: socket.id }
      });
      console.log(`💾 Updated socketId in DB for customer ${user._id}`);
    } catch (dbError) {
      console.error('❌ Database update error:', dbError);
    }

    // Always map socket.id to DB customer ID
    connectedCustomers.set(socket.id, user._id.toString());

    console.log(`✅ Customer registered: ${user._id} (phone: ${user.phone}) with socketId: ${socket.id}`);
    console.log(`📊 Connected customers: ${connectedCustomers.size}`);

    // Send confirmation to customer with DB ID
    socket.emit('customer:registered', {
      success: true,
      customerId: user._id.toString(),
      socketId: socket.id,
      dbId: user._id.toString()
    });

  } catch (e) {
    console.error('❌ customer:register error:', e);
    socket.emit('customer:registered', { success: false, error: e.message });
  }
});   socket.on('customer:request_trip', async (payload) => {
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
// In socketHandler.js - Improve the customer lookup in driver:accept_trip
// 🔹 Driver accepts trip
// Utility to normalize phone numbers (digits only)
const normalizePhone = (phone) => {
  if (!phone) return null;
  return String(phone).replace(/[^0-9]/g, ""); // remove +, spaces, dashes
};

// 🔹 Driver accepts trip
socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
  try {
    console.log(`🚗 Driver ${driverId} accepting trip ${tripId}`);

    const trip = await Trip.findById(tripId).lean();
    if (!trip || trip.status !== 'requested') {
      emitTripError({ socket, tripId, message: 'Trip not available' });
      return;
    }

    const driver = await User.findById(driverId)
      .select('name photoUrl rating vehicleBrand vehicleNumber location')
      .lean();
    if (!driver) {
      emitTripError({ socket, tripId, message: 'Driver not found' });
      return;
    }

    // Update trip with assigned driver
    await Trip.findByIdAndUpdate(tripId, {
      $set: { assignedDriver: driverId, status: 'driver_assigned' },
    });

    // ✅ Look up customer (by id and phone)
    let customerSocketId = null;
    const customerDoc = await User.findById(trip.customerId).select('phone socketId').lean();
    const dbPhone = normalizePhone(customerDoc?.phone);

    console.log("📊 connectedCustomers dump:", Array.from(connectedCustomers.entries()));
    console.log("🔎 Trip customerId:", trip.customerId.toString());
    console.log("🔎 Customer phone from DB:", customerDoc?.phone, "→", dbPhone);

    for (const [socketId, custId] of connectedCustomers.entries()) {
      const normalized = normalizePhone(custId);

      if (
        custId === trip.customerId.toString() ||   // exact _id match
        (dbPhone && normalized === dbPhone)        // normalized phone match
      ) {
        customerSocketId = socketId;
        console.log(`✅ Found customer socket: ${socketId} (custId: ${custId})`);
        break;
      }
    }

    if (customerSocketId) {
      const payload = {
        tripId: tripId.toString(),
        trip: {
          pickup: {
            lat: trip.pickup.coordinates[1],
            lng: trip.pickup.coordinates[0],
            address: trip.pickup.address || "Pickup Location",
          },
          drop: {
            lat: trip.drop.coordinates[1],
            lng: trip.drop.coordinates[0],
            address: trip.drop.address || "Drop Location",
          },
        },
        driver: {
          id: driver._id.toString(),
          name: driver.name || 'Driver',
          photoUrl: driver.photoUrl || null,
          rating: driver.rating || 4.8,
          vehicleBrand: driver.vehicleBrand || 'Vehicle',
          vehicleNumber: driver.vehicleNumber || 'N/A',
          location: {
            lat: driver.location.coordinates[1],
            lng: driver.location.coordinates[0],
          },
        },
      };

      io.to(customerSocketId).emit('trip:accepted', payload);
      console.log(`📢 trip:accepted emitted to customer ${trip.customerId}`);
    } else {
      console.log(`❌ No socketId found for customer ${trip.customerId}`);
      console.log(`💡 Customer might be offline, send push notification.`);
    }
  } catch (e) {
    console.error('❌ driver:accept_trip error:', e);
    emitTripError({ socket, tripId, message: 'Failed to accept trip.' });
  }
});

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
