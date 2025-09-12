import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { sendToCustomer } from '../utils/fcmSender.js';
import { io } from '../socket/socketHandler.js';
import { reassignStandbyDriver } from './standbyController.js';
import mongoose from 'mongoose';
import { broadcastTripToDrivers } from '../utils/tripBroadcaster.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';

function normalizeCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length !== 2) {
    throw new Error('Coordinates must be [lat, lng] or [lng, lat]');
  }
  const [a, b] = coords.map(Number);
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
    return [b, a];
  }
  return [a, b];
}

const findUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  return await User.findOne({ phone: idOrPhone });
};

const createShortTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType } = req.body;
    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:error', { message: 'Customer not found' });
      }
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.SHORT,
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
      type: 'short',
      pickup,
      drop,
      vehicleType,
      customerId: customer._id,
    };

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No drivers found for short trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastTripToDrivers(nearbyDrivers, payload, io);

    console.log(`Short Trip created: ${trip._id}. Found ${nearbyDrivers.length} drivers near pickup`, pickup.coordinates);
    res.status(200).json({ success: true, tripId: trip._id, drivers: nearbyDrivers.length });
  } catch (err) {
    console.error('🔥 createShortTrip error:', err);
    if (req.body?.customerId) {
      const customer = await findUserByIdOrPhone(req.body.customerId);
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:error', { message: err.message });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails } = req.body;
    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:error', { message: 'Customer not found' });
      }
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.PARCEL,
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
      type: 'parcel',
      pickup,
      drop,
      vehicleType,
      customerId: customer._id,
    };

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No drivers found for parcel trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastTripToDrivers(nearbyDrivers, payload, io);

    console.log(`Parcel Trip created: ${trip._id}. Found ${nearbyDrivers.length} drivers near pickup`, pickup.coordinates);
    res.status(200).json({ success: true, tripId: trip._id, drivers: nearbyDrivers.length });
  } catch (err) {
    console.error('🔥 createParcelTrip error:', err);
    if (req.body?.customerId) {
      const customer = await findUserByIdOrPhone(req.body.customerId);
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:error', { message: err.message });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    console.log('📦 Long trip request received:', req.body);
    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip } = req.body;

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:error', { message: 'Customer not found' });
      }
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const radius = isSameDay ? TRIP_LIMITS.LONG_SAME_DAY : TRIP_LIMITS.LONG_ADVANCE;

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

    const payload = {
      tripId: trip._id,
      type: 'long',
      pickup,
      drop,
      vehicleType,
      customerId: customer._id,
    };

    if (!drivers.length) {
      console.warn(`⚠️ No drivers found for long trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastTripToDrivers(drivers, payload, io);

    console.log(`Long Trip created: ${trip._id}. Found ${drivers.length} drivers near pickup`, pickup.coordinates);
    res.status(200).json({ success: true, tripId: trip._id, drivers: drivers.length });
  } catch (err) {
    console.error('🔥 Error in createLongTrip:', err);
    if (req.body?.customerId) {
      const customer = await findUserByIdOrPhone(req.body.customerId);
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:error', { message: err.message });
      }
    }
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

    const otherDrivers = await User.find({
      isDriver: true,
      _id: { $ne: driverId },
    });
    otherDrivers.forEach((driver) => {
      if (driver.socketId) {
        io.to(driver.socketId).emit('tripRejectedBySystem', { tripId });
      }
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('🔥 acceptTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const rejectTrip = async (req, res) => {
  try {
    const { tripId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Trip not valid' });
    }
    reassignStandbyDriver(trip);
    res.status(200).json({ success: true, message: 'Rejection recorded' });
  } catch (err) {
    console.error('🔥 rejectTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const completeTrip = async (req, res) => {
  try {
    const { tripId, userId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== userId && trip.customerId?.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    trip.status = 'completed';
    await trip.save();
    res.status(200).json({ success: true, message: 'Trip completed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.assignedDriver?.toString() !== cancelledBy && trip.customerId?.toString() !== cancelledBy) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    trip.status = 'cancelled';
    trip.cancelledBy = cancelledBy;
    await trip.save();
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