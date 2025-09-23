// src/controllers/tripController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';

function normalizeCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length !== 2) {
    throw new Error('Coordinates must be [lat, lng] or [lng, lat]');
  }
  const [a, b] = coords.map(Number);
  if (Math.abs(a) <= 90 && Math.abs(b) > 90) {
    return [b, a]; // It's [lat, lng], swap to [lng, lat]
  }
  return [a, b]; // It's already [lng, lat] or invalid, do not swap
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

    if (!vehicleType || typeof vehicleType !== 'string' || vehicleType.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        message: 'Vehicle type is required and must be a non-empty string.' 
      });
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);
    
    const sanitizedVehicleType = vehicleType.trim().toLowerCase();

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType: sanitizedVehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.SHORT || 10000,
        },
      },
    })
    .select('name phone vehicleType location isOnline socketId fcmToken')
    .lean();

    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type: 'short',
      status: 'requested',
    });

    const payload = {
      tripId: trip._id.toString(),
      type: trip.type,
      vehicleType: sanitizedVehicleType,
      customerId: customer._id.toString(),
      pickup: {
        lat: pickup.coordinates[1],
        lng: pickup.coordinates[0],
        address: pickup.address || "Pickup Location",
      },
      drop: {
        lat: drop.coordinates[1],
        lng: drop.coordinates[0],
        address: drop.address || "Drop Location",
      },
      fare: req.body.fare || 0,
    };

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No '${sanitizedVehicleType}' drivers found for short trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastToDrivers(nearbyDrivers, payload);
    console.log(`Short Trip created: ${trip._id}. Found ${nearbyDrivers.length} '${sanitizedVehicleType}' drivers.`);
    res.status(200).json({ success: true, tripId: trip._id, drivers: nearbyDrivers.length });
    
  } catch (err) {
    console.error('🔥 createShortTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails, fare } = req.body;
    const sanitizedVehicleType = (vehicleType || 'bike').toString().trim().toLowerCase();

    if (!pickup?.coordinates || !drop?.coordinates) {
      return res.status(400).json({ success: false, message: 'Pickup and drop coordinates are required' });
    }

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType: sanitizedVehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.PARCEL || 10000,
        },
      },
    }).select('name phone vehicleType location isOnline socketId fcmToken').lean();

    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type: 'parcel',
      parcelDetails,
      status: 'requested',
      fare: fare || 0,
    });

    const payload = {
      tripId: trip._id.toString(),
      type: trip.type,
      vehicleType: sanitizedVehicleType,
      customerId: customer._id.toString(),
      pickup: {
        lat: pickup.coordinates[1],
        lng: pickup.coordinates[0],
        address: pickup.address || "Pickup Location",
      },
      drop: {
        lat: drop.coordinates[1],
        lng: drop.coordinates[0],
        address: drop.address || "Drop Location",
      },
      fare: trip.fare || 0,
      parcelDetails: trip.parcelDetails,
    };

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No drivers found for parcel trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastToDrivers(nearbyDrivers, payload);
    console.log(`📦 Parcel Trip created: ${trip._id}. Found ${nearbyDrivers.length} drivers.`);
    res.status(200).json({ success: true, tripId: trip._id, drivers: nearbyDrivers.length });
  } catch (err) {
    console.error('🔥 createParcelTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip } = req.body;

    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
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
      tripId: trip._id.toString(),
      type: trip.type,
      vehicleType: trip.vehicleType,
      customerId: customer._id.toString(),
      pickup: {
        lat: pickup.coordinates[1],
        lng: pickup.coordinates[0],
        address: pickup.address || "Pickup Location",
      },
      drop: {
        lat: drop.coordinates[1],
        lng: drop.coordinates[0],
        address: drop.address || "Drop Location",
      },
      fare: trip.fare || 0,
    };

    if (!drivers.length) {
      console.warn(`⚠️ No drivers found for long trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastToDrivers(drivers, payload);
    console.log(`Long Trip created: ${trip._id}. Found ${drivers.length} drivers.`);
    res.status(200).json({ success: true, tripId: trip._id, drivers: drivers.length });
  } catch (err) {
    console.error('🔥 Error in createLongTrip:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const acceptTrip = async (req, res) => {
  try {
    const { driverId, tripId } = req.body;

    const trip = await Trip.findById(tripId).lean();
    if (!trip || trip.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Trip not available' });
    }

    const driver = await User.findById(driverId).select('name photoUrl rating vehicleBrand vehicleNumber location').lean();
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    const updatedTrip = await Trip.findByIdAndUpdate(
      tripId,
      { $set: { assignedDriver: driverId, status: 'driver_assigned' } },
      { new: true }
    ).lean();

    const customer = await User.findById(trip.customerId).lean();

    if (customer?.socketId) {
      const payload = {
        tripId: updatedTrip._id.toString(),
        trip: {
          pickup: { lat: updatedTrip.pickup.coordinates[1], lng: updatedTrip.pickup.coordinates[0], address: updatedTrip.pickup.address },
          drop: { lat: updatedTrip.drop.coordinates[1], lng: updatedTrip.drop.coordinates[0], address: updatedTrip.drop.address },
        },
        driver: {
          id: driver._id.toString(),
          name: driver.name || 'N/A',
          photoUrl: driver.photoUrl || null,
          rating: driver.rating || 4.8,
          vehicleBrand: driver.vehicleBrand || 'Bike',
          vehicleNumber: driver.vehicleNumber || 'N/A',
          location: { lat: driver.location.coordinates[1], lng: driver.location.coordinates[0] }
        }
      };
      io.to(customer.socketId).emit('trip:accepted', payload);
    }
    
    res.status(200).json({ success: true, message: "Trip accepted successfully" });

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