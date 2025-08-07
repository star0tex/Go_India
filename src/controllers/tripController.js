// src/controllers/tripController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { sendToDriver, sendToCustomer } from '../utils/fcmSender.js';
import { io } from '../socket/socketHandler.js';
import { reassignStandbyDriver } from './standbyController.js';

const RADIUS = {
  SHORT: 3000,
  PARCEL: 3000,
  LONG_SAME_DAY: 20000,
  LONG_ADVANCE: 50000,
};

const createShortTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType } = req.body;

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
customerId: customer._id, // ✅ correct and matches schema
      pickup,
      drop,
      vehicleType,
      type: 'short',
      status: 'requested',
    });

    nearbyDrivers.forEach((driver) => {
      io.to(driver.socketId).emit('tripRequest', {
        tripId: trip._id,
        pickup,
        drop,
        vehicleType,
      });
    });

    res.status(200).json({ success: true, tripId: trip._id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails } = req.body;

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
customerId: customer._id, // ✅ correct and matches schema
      pickup,
      drop,
      vehicleType,
      type: 'parcel',
      parcelDetails,
      status: 'requested',
    });

    nearbyDrivers.forEach((driver) => {
      io.to(driver.socketId).emit('parcelTripRequest', {
        tripId: trip._id,
        pickup,
        drop,
        parcelDetails,
        vehicleType,
customerId: customer._id, // ✅ correct and matches schema

       

      });
    });

    res.status(200).json({ success: true, tripId: trip._id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLongTrip = async (req, res) => {
  try {
    console.log("📦 Long trip request received:", req.body);

    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip } = req.body;

    // ✅ 1. Find the customer in DB using phone number
await User.findOneAndUpdate({ phone: driverId }, { socketId: socket.id, isOnline: true });

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const radius = isSameDay ? RADIUS.LONG_SAME_DAY : RADIUS.LONG_ADVANCE;

    // ✅ 2. Find nearby drivers
    const drivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: isSameDay,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: radius,
        },
      },
    });

    // ✅ 3. Create trip using customer._id (Mongo ObjectId)
    const trip = await Trip.create({
  customerId: customer._id, // ✅
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
    if (isSameDay) {
      drivers.forEach((driver) => {
       io.to(driver.socketId).emit('trip:request', {
  tripId: trip._id,
  pickup,
  drop,
  vehicleType,
  isSameDay,
  tripDays,
  returnTrip,
  customerId: customer._id,
  type: 'long',  // <- very important!
});


      });
    } else {
      drivers.forEach((driver) => {
        sendToDriver(driver.fcmToken, 'New Advance Booking', 'You have a new long trip request.', {
          tripId: trip._id.toString(),
          pickup,
          drop,
          vehicleType,
          tripDays,
          returnTrip,
        });
      });
    }

    res.status(200).json({ success: true, tripId: trip._id });

  } catch (err) {
    console.error("🔥 Error in createLongTrip:", err);  // ✅ Add error log
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

await User.findOneAndUpdate({ phone: driverId }, { socketId: socket.id, isOnline: true });
    sendToCustomer(customer.fcmToken, 'Driver Accepted', 'A driver has accepted your ride request.', {
      tripId,
    });

    io.emit('tripRejectedBySystem', { tripId });

    res.status(200).json({ success: true });
  } catch (err) {
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

    reassignStandbyDriver(trip);

    res.status(200).json({ success: true, message: 'Rejection recorded' });
  } catch (err) {
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

// Optional: Add getTripById if you're using it in routes
const getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).populate('assignedDriver customerId')

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
