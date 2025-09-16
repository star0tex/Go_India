// src/socket/socketHandler.js
import { Server } from 'socket.io';
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

// Relaxed validation: don't require vehicleType here.
// Controllers will ensure defaults if missing.
const validateTripPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { type, customerId, pickup, drop } = payload;
  if (!type || !customerId || !pickup || !drop) return false;
  if (!pickup.coordinates || !Array.isArray(pickup.coordinates) || pickup.coordinates.length !== 2) return false;
  if (!drop.coordinates || !Array.isArray(drop.coordinates) || drop.coordinates.length !== 2) return false;
  return true;
};

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    /**
     * 🔹 Driver status update
     */
    socket.on('updateDriverStatus', async ({ driverId, isOnline, location, fcmToken, vehicleType }) => {
      try {
        if (!driverId) return;

        const user = await resolveUserByIdOrPhone(driverId);
        if (!user) {
          console.warn(`updateDriverStatus: user not found for ${driverId}`);
          return;
        }

        const updateData = {
          socketId: socket.id,
          isOnline: !!isOnline,
        };

        if (
          location?.coordinates?.length === 2 &&
          typeof location.coordinates[0] === 'number' &&
          typeof location.coordinates[1] === 'number'
        ) {
          updateData.location = {
            type: 'Point',
            coordinates: location.coordinates, // [lng, lat]
          };
        }

        // Optionally update fcmToken and vehicleType if provided
        if (fcmToken) updateData.fcmToken = fcmToken;
        if (vehicleType) updateData.vehicleType = vehicleType;

        await User.findByIdAndUpdate(user._id, updateData, { lean: true });
        connectedDrivers.set(socket.id, user._id.toString());
        console.log(`📶 Driver ${user._id} is now ${isOnline ? 'online' : 'offline'}. socketId saved.`);
      } catch (e) {
        emitTripError({ socket, message: 'Failed to update driver status.' });
        console.error('❌ updateDriverStatus error:', e);
      }
    });

    /**
     * 🔹 Customer register
     */
    socket.on('customer:register', async ({ customerId }) => {
      try {
        if (!customerId) return;
        const user = await resolveUserByIdOrPhone(customerId);
        if (!user) {
          console.warn(`customer:register - user not found for ${customerId}`);
          connectedCustomers.set(socket.id, customerId);
          return;
        }
        await User.findByIdAndUpdate(user._id, { socketId: socket.id });
        connectedCustomers.set(socket.id, user._id.toString());
        console.log(`👤 Customer registered: ${user._id}`);
      } catch (e) {
        emitTripError({ socket, message: 'Failed to register customer.' });
        console.error('❌ customer:register error:', e);
      }
    });

    /**
     * 🔹 Customer requests trip (HYBRID FLOW)
     * Route to tripController, do not create trip here!
     */
    socket.on('customer:request_trip', async (payload) => {
      try {
        // Strict payload validation (vehicleType optional)
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

        // Attach socket to req/res-like objects
        const req = { body: payload };
        const res = {
          status: (code) => ({
            json: (data) => {
              // Always emit back to customer
              socket.emit('trip:request_response', { ...data, status: code });
              if (data.success && data.tripId) {
                console.log(
                  `🛣️ Trip request (${type}) routed to controller. TripId: ${data.tripId}`
                );
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

    /**
     * 🔹 Driver accepts trip
     */
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        if (!tripId || !driverId) {
          emitTripError({ socket, message: 'Missing tripId or driverId.' });
          return;
        }
        const trip = await Trip.findById(tripId);
        if (!trip || trip.status !== 'requested') {
          emitTripError({ socket, tripId, message: 'Trip not available.' });
          return;
        }

        if (trip.assignedDriver) {
          socket.emit('trip:already_assigned', { tripId });
          emitTripError({ socket, tripId, message: 'Trip already assigned.' });
          console.warn(`⏭ Trip ${tripId} already assigned`);
          return;
        }

        trip.assignedDriver = driverId;
        trip.status = 'driver_assigned';
        await trip.save();

        await promoteNextStandby(tripId, driverId);

        const customer = await User.findById(trip.customerId);
        if (customer?.socketId) {
          io.to(customer.socketId).emit('trip:accepted', { tripId, driverId });
        }

        connectedDrivers.forEach((uid, sockId) => {
          if (uid.toString() !== driverId.toString()) {
            io.to(sockId).emit('trip:rejected_by_system', { tripId });
          }
        });

        console.log(`✅ Trip ${tripId} accepted by driver ${driverId}`);
      } catch (e) {
        emitTripError({ socket, tripId, message: 'Failed to accept trip.' });
        console.error('❌ driver:accept_trip error:', e);
      }
    });

    /**
     * 🔹 Trip timeout fallback
     */
    socket.on('trip:timeout', async ({ tripId }) => {
      try {
        if (!tripId) {
          emitTripError({ socket, message: 'Missing tripId for timeout.' });
          return;
        }
        const trip = await Trip.findById(tripId);
        if (!trip || trip.status !== 'requested') {
          emitTripError({ socket, tripId, message: 'Trip not available for timeout.' });
          return;
        }

        if (trip.type === 'long' && !trip.isSameDay) {
          const drivers = await User.find({
            isDriver: true,
            vehicleType: trip.vehicleType,
            location: {
              $near: {
                $geometry: { type: 'Point', coordinates: trip.pickup.coordinates },
                $maxDistance: DISTANCE_LIMITS.long_multi_day,
              },
            },
          });

          drivers.forEach((driver) => {
            if (driver.fcmToken) {
              sendToDriver(
                driver.fcmToken,
                'Advance Trip Available',
                'A long trip is available for advance booking',
                {
                  tripId: trip._id.toString(),
                  pickup: trip.pickup,
                  drop: trip.drop,
                  vehicleType: trip.vehicleType,
                }
              );
            }
          });

          console.log(`📲 FCM fallback sent to ${drivers.length} drivers`);
        } else {
          await reassignStandbyDriver(trip);
          console.log(`♻️ Standby reassignment triggered for trip ${tripId}`);
        }
      } catch (e) {
        emitTripError({ socket, tripId, message: 'Failed to handle trip timeout.' });
        console.error('❌ trip:timeout error:', e);
      }
    });

    /**
     * 🔹 Disconnect cleanup
     */
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
          await User.findByIdAndUpdate(customerId, { socketId: null });
          connectedCustomers.delete(socket.id);
          console.log(`👤 Customer disconnected: ${customerId}`);
        }
      } catch (e) {
        console.error('❌ disconnect cleanup error:', e);
      }
    });
  });

  console.log('🚀 Socket.IO initialized');
};
export { io, connectedDrivers, connectedCustomers };
