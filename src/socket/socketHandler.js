// src/socket/socketHandler.js
import { Server } from 'socket.io';
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { calculateDistanceInMeters } from '../utils/distanceCalculator.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';

let io;

const connectedDrivers = new Map(); // socketId => userId
const connectedCustomers = new Map(); // socketId => userId

// Distance limits by trip type
const DISTANCE_LIMITS = {
  short: 5000,
  parcel: 5000,
  long_same_day: 20000,
  long_multi_day: 50000,
};

// Helper: resolve user by id or phone
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

// Broadcast trip to given drivers
const broadcastTripToDrivers = (drivers, tripPayload) => {
  drivers.forEach((driver) => {
    if (driver.socketId) {
      io.to(driver.socketId).emit('trip:request', tripPayload);
      io.to(driver.socketId).emit('tripRequest', tripPayload); // legacy support
      console.log(`📤 Sent trip to driver ${driver._id}`);
    } else if (driver.fcmToken) {
      sendToDriver(
        driver.fcmToken,
        'New Ride Request',
        'A trip request is available',
        tripPayload
      );
    }
  });
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
    socket.on('updateDriverStatus', async ({ driverId, isOnline, location }) => {
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

        await User.findByIdAndUpdate(user._id, updateData);
        connectedDrivers.set(socket.id, user._id.toString());
        console.log(`📶 Driver ${user._id} is now ${isOnline ? 'online' : 'offline'}`);
      } catch (e) {
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
        console.error('❌ customer:register error:', e);
      }
    });

    /**
     * 🔹 Customer requests trip
     */
    socket.on('customer:request_trip', async (payload) => {
      try {
        const {
          customerId,
          pickup,
          drop,
          vehicleType,
          type,
          distance,
          duration,
          tripTime,
        } = payload;

        // Basic validation
        if (
          !customerId ||
          !pickup?.lng ||
          !pickup?.lat ||
          !drop?.lng ||
          !drop?.lat ||
          !vehicleType ||
          !type
        ) {
          console.warn('⚠️ Invalid trip request payload:', payload);
          return;
        }

        const pickupGeo = {
          type: 'Point',
          coordinates: [pickup.lng, pickup.lat],
          address: pickup.address || '',
        };
        const dropGeo = {
          type: 'Point',
          coordinates: [drop.lng, drop.lat],
          address: drop.address || '',
        };

        const isSameDay =
          type === 'long' && tripTime
            ? new Date(tripTime).toDateString() === new Date().toDateString()
            : null;

        const trip = await Trip.create({
          customerId,
          vehicleType,
          type,
          pickup: pickupGeo,
          drop: dropGeo,
          pickupLocation: {
            lat: pickup.lat,
            lng: pickup.lng,
            address: pickup.address || '',
          },
          dropLocation: {
            lat: drop.lat,
            lng: drop.lng,
            address: drop.address || '',
          },
          distance: Number(distance) || 0,
          duration: Number(duration) || 0,
          tripTime:
            type === 'long' && tripTime ? new Date(tripTime).toISOString() : null,
          isSameDay,
        });

        // Fetch online drivers
        const drivers = await User.find({
          isDriver: true,
          vehicleType: trip.vehicleType,
          isOnline: true,
        });

        // Filter nearby
        const nearbyDrivers = drivers.filter((driver) => {
          if (!driver.location?.coordinates) return false;
          const dist = calculateDistanceInMeters(
            driver.location.coordinates,
            trip.pickup.coordinates
          );
          if (type === 'short' || type === 'parcel')
            return dist <= DISTANCE_LIMITS.short;
          if (type === 'long' && isSameDay)
            return dist <= DISTANCE_LIMITS.long_same_day;
          if (type === 'long' && !isSameDay)
            return dist <= DISTANCE_LIMITS.long_multi_day;
          return false;
        });

        const tripPayload = {
          tripId: trip._id,
          pickup: trip.pickup,
          drop: trip.drop,
          vehicleType: trip.vehicleType,
          type: trip.type,
        };

        broadcastTripToDrivers(nearbyDrivers, tripPayload);

        console.log(
          `📡 Trip request (${type}) sent to ${nearbyDrivers.length} drivers`
        );
      } catch (e) {
        console.error('❌ customer:request_trip error:', e);
      }
    });

    /**
     * 🔹 Driver accepts trip
     */
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        if (!tripId || !driverId) return;
        const trip = await Trip.findById(tripId);
        if (!trip || trip.status !== 'requested') return;

        if (trip.assignedDriver) {
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
        console.error('❌ driver:accept_trip error:', e);
      }
    });

    /**
     * 🔹 Trip timeout fallback
     */
    socket.on('trip:timeout', async ({ tripId }) => {
      try {
        if (!tripId) return;
        const trip = await Trip.findById(tripId);
        if (!trip || trip.status !== 'requested') return;

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

export { io };
