// src/controllers/tripController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { sendToDriver, sendToCustomer } from '../utils/fcmSender.js';
import { io } from '../socket/socketHandler.js';
import { reassignStandbyDriver } from './standbyController.js';
import mongoose from 'mongoose';

const RADIUS = {
  SHORT: 3000,
  PARCEL: 3000,
  LONG_SAME_DAY: 20000,
  LONG_ADVANCE: 50000,
};

// helper: accept either ObjectId string or phone string
const findUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  // fallback to phone lookup
  return await User.findOne({ phone: idOrPhone });
};

const createShortTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType } = req.body;

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: RADIUS.SHORT,
        },
      },
    });

    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType,
      type: 'short',
      status: 'requested',
    });

    const payload = {
      tripId: trip._id,
      pickup,
      drop,
      vehicleType,
    };

    nearbyDrivers.forEach((driver) => {
      if (driver.socketId) {
        // emit canonical event
        io.to(driver.socketId).emit('trip:request', payload);
        // keep backward-compatible legacy event
        io.to(driver.socketId).emit('tripRequest', payload);
      } else if (driver.fcmToken) {
        // fallback FCM
        sendToDriver(driver.fcmToken, 'New Ride Request', 'A ride is nearby. Open the app to accept.', payload);
      }
    });

    res.status(200).json({ success: true, tripId: trip._id });
  } catch (err) {
    console.error('🔥 createShortTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails } = req.body;

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: RADIUS.PARCEL,
        },
      },
    });

    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType,
      type: 'parcel',
      parcelDetails,
      status: 'requested',
    });

    const payload = {
      tripId: trip._id,
      pickup,
      drop,
      parcelDetails,
      vehicleType,
      customerId: customer._id,
    };

    nearbyDrivers.forEach((driver) => {
      if (driver.socketId) {
        io.to(driver.socketId).emit('trip:request', payload);
        io.to(driver.socketId).emit('parcelTripRequest', payload);
      } else if (driver.fcmToken) {
        sendToDriver(driver.fcmToken, 'New Parcel Request', 'A parcel request is nearby.', payload);
      }
    });

    res.status(200).json({ success: true, tripId: trip._id });
  } catch (err) {
    console.error('🔥 createParcelTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    console.log('📦 Long trip request received:', req.body);

    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip } = req.body;

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const radius = isSameDay ? RADIUS.LONG_SAME_DAY : RADIUS.LONG_ADVANCE;

    // Build driver query: if same-day require isOnline true, else do not require isOnline (advance booking -> FCM)
    const driverQuery = {
      isDriver: true,
      vehicleType,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: radius,
        },
      },
    };
    if (isSameDay) driverQuery.isOnline = true;

    const drivers = await User.find(driverQuery);

    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType,
      type: 'long',
      status: 'requested',
      isSameDay,
      returnTrip,
      tripDays,
    });

    console.log(`📤 Sending ${trip.type} trip request to ${drivers.length} drivers`);
    const payload = {
      tripId: trip._id,
      pickup,
      drop,
      vehicleType,
      isSameDay,
      tripDays,
      returnTrip,
      customerId: customer._id,
      type: 'long',
    };

    if (isSameDay) {
      drivers.forEach((driver) => {
        if (driver.socketId) {
          io.to(driver.socketId).emit('trip:request', payload);
          // keep legacy channel too
          io.to(driver.socketId).emit('longTripRequest', payload);
        } else if (driver.fcmToken) {
          // fallback in case driver is not connected
          sendToDriver(driver.fcmToken, 'New Long Trip', 'A same-day long trip is available nearby.', payload);
        }
      });
    } else {
      // advance bookings -> FCM only
      drivers.forEach((driver) => {
        if (driver.fcmToken) {
          sendToDriver(
            driver.fcmToken,
            'New Advance Booking',
            'You have a new long trip request.',
            {
              tripId: trip._id.toString(),
              pickup,
              drop,
              vehicleType,
              tripDays,
              returnTrip,
            }
          );
        }
      });
    }

    res.status(200).json({ success: true, tripId: trip._id });
  } catch (err) {
    console.error('🔥 Error in createLongTrip:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const acceptTrip = async (req, res) => {
  try {
    const { driverId, tripId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Trip not available' });
    }

    trip.assignedDriver = mongoose.Types.ObjectId(driverId);
    trip.status = 'driver_assigned';
    await trip.save();

    const customer = await User.findById(trip.customerId);
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:accepted', { tripId, driverId });
    }
    if (customer?.fcmToken) {
      sendToCustomer(customer.fcmToken, 'Driver Accepted', 'A driver has accepted your ride request.', { tripId });
    }

    // notify other drivers to remove this request
    io.emit('tripRejectedBySystem', { tripId });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('🔥 acceptTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const rejectTrip = async (req, res) => {
  try {
    const { driverId, tripId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Trip not valid' });
    }

    // push to standby reassign logic
    reassignStandbyDriver(trip);

    res.status(200).json({ success: true, message: 'Rejection recorded' });
  } catch (err) {
    console.error('🔥 rejectTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const completeTrip = async (req, res) => {
  try {
    const { tripId } = req.body;
    await Trip.findByIdAndUpdate(tripId, { status: 'completed' });
    res.status(200).json({ success: true, message: 'Trip completed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy } = req.body;
    await Trip.findByIdAndUpdate(tripId, { status: 'cancelled', cancelledBy });
    res.status(200).json({ success: true, message: 'Trip cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).populate('assignedDriver customerId');
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });

    res.status(200).json({ success: true, trip });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
  acceptTrip,
  rejectTrip,
  completeTrip,
  cancelTrip,
  getTripById,
};
