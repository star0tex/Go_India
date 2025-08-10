// src/socket/socketHandler.js
import { Server } from 'socket.io';
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { calculateDistanceInMeters } from '../utils/distanceCalculator.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';

let io;

const connectedDrivers = new Map(); // socketId => userId (string)
const connectedCustomers = new Map(); // socketId => userId (string)

// helper: resolve user by id or phone
const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  return await User.findOne({ phone: idOrPhone });
};

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    /**
     * 🔹 Register / update driver status + location
     * This now accepts `location` so we can use $near queries later
     */
    socket.on('updateDriverStatus', async ({ driverId, isOnline, location }) => {
      try {
        const user = await resolveUserByIdOrPhone(driverId);
        if (!user) {
          console.warn(`updateDriverStatus: user not found for ${driverId}`);
          return;
        }

        const updateData = {
          socketId: socket.id,
          isOnline: !!isOnline,
        };

        if (location?.coordinates?.length === 2) {
          updateData.location = {
            type: 'Point',
            coordinates: location.coordinates, // [lng, lat]
          };
        }

        await User.findByIdAndUpdate(user._id, updateData);
        connectedDrivers.set(socket.id, user._id.toString());
        console.log(
          `📶 Driver ${user._id} is now ${isOnline ? 'online' : 'offline'} (socket ${socket.id})`
        );
      } catch (e) {
        console.error('❌ updateDriverStatus error:', e);
      }
    });

    // 🔹 Register customer
    socket.on('customer:register', async ({ customerId }) => {
      try {
        const user = await resolveUserByIdOrPhone(customerId);
        if (!user) {
          console.warn(`customer:register - user not found for ${customerId}`);
          connectedCustomers.set(socket.id, customerId);
          return;
        }
        await User.findByIdAndUpdate(user._id, { socketId: socket.id });
        connectedCustomers.set(socket.id, user._id.toString());
        console.log(`👤 Customer registered: ${user._id} (socket ${socket.id})`);
      } catch (e) {
        console.error('❌ customer:register error:', e);
      }
    });

    /**
     * 🔹 Customer requests trip (short, parcel, long)
     * Sends trip request to nearby online drivers
     */
    socket.on('customer:request_trip', async ({ tripId }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip) return;

        const drivers = await User.find({
          isDriver: true,
          vehicleType: trip.vehicleType,
          isOnline: true,
        });

        const nearbyDrivers = drivers.filter((driver) => {
          if (!driver.location || !trip.pickup) return false;
          const distance = calculateDistanceInMeters(
            driver.location.coordinates,
            trip.pickup.coordinates
          );
          if (trip.type === 'short' || trip.type === 'parcel') return distance <= 5000;
          if (trip.type === 'long' && trip.isSameDay) return distance <= 20000;
          return false;
        });

        const payload = {
          tripId: trip._id,
          pickup: trip.pickup,
          drop: trip.drop,
          vehicleType: trip.vehicleType,
          type: trip.type,
        };

        nearbyDrivers.forEach((driver) => {
          if (driver.socketId) {
            console.log(
              `📤 Emitted trip to driver ${driver._id} socket ${driver.socketId}`
            );
            io.to(driver.socketId).emit('trip:request', payload);
            io.to(driver.socketId).emit('tripRequest', payload); // legacy
          } else if (driver.fcmToken) {
            sendToDriver(
              driver.fcmToken,
              'New Ride Request',
              'A trip request is available',
              payload
            );
          }
        });

        console.log(
          `📡 Trip request sent to ${nearbyDrivers.length} drivers for trip ${tripId}`
        );
      } catch (e) {
        console.error('❌ customer:request_trip error:', e);
      }
    });

    /**
     * 🔹 Driver accepts trip
     * Assigns driver to trip and notifies customer
     */
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip || trip.status !== 'requested') return;

        trip.assignedDriver = driverId;
        trip.status = 'driver_assigned';
        await trip.save();

        const customer = await User.findById(trip.customerId);
        if (customer?.socketId) {
          io.to(customer.socketId).emit('trip:accepted', { tripId, driverId });
        }

        io.emit('trip:rejected_by_system', { tripId });
        console.log(`✅ Trip ${tripId} accepted by driver ${driverId}`);
      } catch (e) {
        console.error('❌ driver:accept_trip error:', e);
      }
    });

    // 🔹 Trip timeout fallback
    socket.on('trip:timeout', async ({ tripId }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip || trip.status !== 'requested') return;

        if (trip.type === 'long' && !trip.isSameDay) {
          const drivers = await User.find({
            isDriver: true,
            vehicleType: trip.vehicleType,
            location: {
              $near: {
                $geometry: {
                  type: 'Point',
                  coordinates: trip.pickup.coordinates,
                },
                $maxDistance: 50000,
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

          console.log(
            `📲 FCM fallback sent to ${drivers.length} drivers for advance trip`
          );
        } else {
          await reassignStandbyDriver(trip);
          console.log(`♻️ Standby reassignment triggered for trip ${tripId}`);
        }
      } catch (e) {
        console.error('❌ trip:timeout error:', e);
      }
    });

    // 🔹 Disconnect cleanup
    socket.on('disconnect', async () => {
      try {
        const driverId = connectedDrivers.get(socket.id);
        const customerId = connectedCustomers.get(socket.id);

        if (driverId) {
          await User.findByIdAndUpdate(driverId, {
            isOnline: false,
            socketId: null,
          });
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
