// src/socket/socketHandler.js
import { Server } from 'socket.io';
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { sendToDriver } from '../utils/fcmSender.js'; // ✅ fixed
import { calculateDistanceInMeters } from '../utils/distanceCalculator.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js'; // ✅ added

let io;

const connectedDrivers = new Map(); // socketId => driverId
const connectedCustomers = new Map(); // socketId => customerId

export const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // Register driver
    socket.on('updateDriverStatus', async ({ driverId, isOnline }) => {
await User.findOneAndUpdate({ phone: driverId }, { socketId: socket.id, isOnline: true });
  console.log(`📶 Driver ${driverId} is now ${isOnline ? 'online' : 'offline'}`);
});

    // Register customer
    socket.on('customer:register', async ({ customerId }) => {
      connectedCustomers.set(socket.id, customerId);
await User.findOneAndUpdate({ phone: customerId }, { socketId: socket.id });
      console.log(`👤 Customer registered: ${customerId}`);
    });

    // Handle trip request
    socket.on('customer:request_trip', async ({ tripId }) => {
      const trip = await Trip.findById(tripId);
      if (!trip) return;

      const drivers = await User.find({
        isDriver: true,
        isOnline: true,
        vehicleType: trip.vehicleType,
      });

      const nearbyDrivers = drivers.filter((driver) => {
        if (!driver.location || !trip.pickup) return false;
        const distance = calculateDistanceInMeters(driver.location.coordinates, trip.pickup.coordinates);
        if (trip.type === 'short' || trip.type === 'parcel') return distance <= 5000;
        if (trip.type === 'long' && trip.isSameDay) return distance <= 20000;
        return false;
      });

      // Emit trip request to nearby drivers
      nearbyDrivers.forEach((driver) => {
        if (driver.socketId) {
          console.log(`📤 Emitted trip to driver ${driver._id} socket ${driver.socketId}`);

          io.to(driver.socketId).emit('trip:request', {
            tripId: trip._id,
            pickup: trip.pickup,
            drop: trip.drop,
            vehicleType: trip.vehicleType,
            type: trip.type,
          });
        }
      });

      console.log(`📡 Trip request sent to ${nearbyDrivers.length} drivers for trip ${tripId}`);
    });

    // Driver accepts trip
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      const trip = await Trip.findById(tripId);
      if (!trip || trip.status !== 'requested') return;

     trip.assignedDriver = driverId;
trip.status = 'driver_assigned'; // match enum
      await trip.save();

const customer = await User.findById(trip.customerId);
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:accepted', { tripId, driverId });
      }

      // Notify all other drivers
      io.emit('trip:rejected_by_system', { tripId });

      console.log(`✅ Trip ${tripId} accepted by driver ${driverId}`);
    });

    // Trip timeout
    socket.on('trip:timeout', async ({ tripId }) => {
      const trip = await Trip.findById(tripId);
      if (!trip || trip.status !== 'requested') return;

      if (trip.type === 'long' && !trip.isSameDay) {
        const drivers = await User.find({
          isDriver: true,
          vehicleType: trip.vehicleType,
          location: {
            $near: {
              $geometry: { type: 'Point', coordinates: trip.pickup.coordinates },
              $maxDistance: 50000,
            },
          },
        });

        drivers.forEach((driver) => {
          if (driver.fcmToken) {
            sendToDriver(driver.fcmToken, 'Advance Trip Available', 'A long trip is available for advance booking', {
              tripId: trip._id.toString(),
              pickup: trip.pickup,
              drop: trip.drop,
              vehicleType: trip.vehicleType,
            });
          }
        });

        console.log(`📲 FCM fallback sent to ${drivers.length} drivers for advance trip`);
      } else {
        await reassignStandbyDriver(trip);
        console.log(`♻️ Standby reassignment triggered for trip ${tripId}`);
      }
    });

    // Disconnect cleanup
    socket.on('disconnect', async () => {
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
    });
  });

  console.log('🚀 Socket.IO initialized');
};

export { io };
