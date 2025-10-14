// src/controllers/tripController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';
import { generateOTP } from '../utils/otpGeneration.js';
import { processCashCollection } from './walletController.js';


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
    const { customerId, pickup, drop, vehicleType, fare } = req.body;

    // ✅ ADD COMPREHENSIVE LOGGING
    console.log('');
    console.log('='.repeat(70));
    console.log('📥 CREATE SHORT TRIP REQUEST RECEIVED');
    console.log('='.repeat(70));
    console.log('📋 Request Body:', JSON.stringify(req.body, null, 2));
    console.log('💰 Fare Details:');
    console.log(`   Raw fare value: ${fare}`);
    console.log(`   Fare type: ${typeof fare}`);
    console.log(`   Fare is number: ${typeof fare === 'number'}`);
    console.log(`   Fare > 0: ${fare > 0}`);
    console.log('='.repeat(70));
    console.log('');

    // ✅ **FIX**: Validate that a positive fare is provided
    if (!fare || fare <= 0) {
      console.log('❌ REJECTED: Fare is invalid');
      return res.status(400).json({
        success: false,
        message: `A valid trip fare greater than zero is required. Received: ${fare}`
      });
    }

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
      fare: fare
    });

    console.log('✅ Trip created in database:');
    console.log(`   Trip ID: ${trip._id}`);
    console.log(`   Stored fare: ${trip.fare}`);
    console.log('');

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
      fare: trip.fare,
    };

    console.log('📤 Broadcasting to drivers with payload:');
    console.log(`   Payload fare: ${payload.fare}`);
    console.log(`   Number of drivers: ${nearbyDrivers.length}`);
    console.log('');

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No '${sanitizedVehicleType}' drivers found for short trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    broadcastToDrivers(nearbyDrivers, payload);
    console.log(`✅ Short Trip ${trip._id} created with fare ₹${trip.fare}`);
    console.log(`   Found ${nearbyDrivers.length} '${sanitizedVehicleType}' drivers`);
    console.log('='.repeat(70));
    
    res.status(200).json({ success: true, tripId: trip._id, drivers: nearbyDrivers.length });

  } catch (err) {
    console.error('🔥 createShortTrip error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const createParcelTrip = async (req, res) => {
  try {
    const { customerId, pickup, drop, vehicleType, parcelDetails, fare } = req.body;

    // ✅ **FIX**: Validate that a positive fare is provided
    if (!fare || fare <= 0) {
      return res.status(400).json({
        success: false,
        message: 'A valid trip fare greater than zero is required.'
      });
    }
    
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
      fare: fare, // ✅ **FIX**: Use the validated fare
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
      fare: trip.fare,
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
    const { customerId, pickup, drop, vehicleType, isSameDay, tripDays, returnTrip, fare } = req.body;

    // ✅ **FIX**: Validate that a positive fare is provided
    if (!fare || fare <= 0) {
        return res.status(400).json({
          success: false,
          message: 'A valid trip fare greater than zero is required.'
        });
    }

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
      fare: fare // ✅ **FIX**: Save the validated fare
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
      fare: trip.fare,
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

    console.log(`🎯 Driver ${driverId} attempting to accept trip ${tripId}`);

    const rideCode = generateOTP();
    console.log(`🎲 Generated OTP: "${rideCode}"`);

    const trip = await Trip.findOneAndUpdate(
      { 
        _id: tripId, 
        status: 'requested'
      },
      { 
        $set: { 
          assignedDriver: driverId, 
          status: 'driver_assigned',
          acceptedAt: new Date(),
          otp: rideCode
        } 
      },
      { new: true }
    ).lean();

    if (!trip) {
      console.log(`⚠️ Trip ${tripId} already accepted by another driver`);
      return res.status(400).json({ 
        success: false, 
        message: 'This trip has already been accepted by another driver',
        reason: 'trip_taken'
      });
    }

    console.log(`✅ Driver ${driverId} successfully claimed trip ${tripId}`);

    const driver = await User.findById(driverId)
      .select('name photoUrl rating vehicleBrand vehicleNumber location phone')
      .lean();
      
    if (!driver) {
      console.error(`❌ Driver ${driverId} not found - Rolling back trip assignment`);
      
      await Trip.findByIdAndUpdate(tripId, { 
        $unset: { assignedDriver: 1, otp: 1 },
        $set: { status: 'requested' }
      });
      
      return res.status(404).json({ 
        success: false, 
        message: 'Driver not found' 
      });
    }

    const customer = await User.findById(trip.customerId)
      .select('socketId fcmToken name')
      .lean();
    
    if (!customer) {
      console.warn(`⚠️ Customer ${trip.customerId} not found`);
    }

    if (customer?.socketId) {
      const payload = {
        tripId: trip._id.toString(),
        rideCode: rideCode,
        trip: {
          pickup: { 
            lat: trip.pickup.coordinates[1], 
            lng: trip.pickup.coordinates[0], 
            address: trip.pickup.address 
          },
          drop: { 
            lat: trip.drop.coordinates[1], 
            lng: trip.drop.coordinates[0], 
            address: trip.drop.address 
          },
          fare: trip.fare || 0,
        },
        driver: {
          id: driver._id.toString(),
          name: driver.name || 'N/A',
          phone: driver.phone || 'N/A',
          photoUrl: driver.photoUrl || null,
          rating: driver.rating || 4.8,
          vehicleBrand: driver.vehicleBrand || 'Bike',
          vehicleNumber: driver.vehicleNumber || 'N/A',
          location: { 
            lat: driver.location.coordinates[1], 
            lng: driver.location.coordinates[0] 
          }
        }
      };
      
      console.log(`📢 Emitting 'trip:accepted' to customer ${customer._id}`);
      io.to(customer.socketId).emit('trip:accepted', payload);
      console.log(`✅ Customer notified via socket`);
    } else {
      console.warn(`⚠️ Customer ${customer?._id} has no socketId`);
    }

    console.log(`🚫 Broadcasting cancellation for trip: ${tripId}`);
    
    const otherDrivers = await User.find({
      isDriver: true,
      isOnline: true,
      _id: { $ne: driverId },
      socketId: { $exists: true, $ne: null }
    }).select('_id socketId name').lean();

    console.log(`📡 Found ${otherDrivers.length} other drivers to notify`);

    otherDrivers.forEach(otherDriver => {
      if (otherDriver.socketId) {
        io.to(otherDriver.socketId).emit('trip:taken', {
          tripId: tripId,
          acceptedBy: driver.name || 'Another driver',
        });
      }
    });
    
    res.status(200).json({ 
      success: true, 
      message: "Trip accepted successfully",
      data: {
        tripId: trip._id,
        otp: rideCode,
      }
    });

  } catch (err) {
    console.error('🔥 acceptTrip error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to accept trip',
      error: err.message 
    });
  }
};


const rejectTrip = async (req, res) => {
  try {
    const { tripId } = req.body;
    const trip = await Trip.findById(tripId);
    if (!trip || trip.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Trip not valid' });
    }
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

// ✅ FIXED: goingToPickup
const goingToPickup = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    trip.rideStatus = 'arrived_at_pickup';
    await trip.save();

    const customer = await User.findById(trip.customerId);
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:driver_arrived', {
        tripId: trip._id.toString(),
      });
    }

    res.status(200).json({
      success: true,
      message: 'Status updated to arrived.',
    });
  } catch (err) {
    console.error('🔥 goingToPickup error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
const startRide = async (req, res) => {
  try {
    const { tripId, driverId, otp, driverLat, driverLng } = req.body;

    console.log(`🎯 Driver ${driverId} attempting to start ride ${tripId} with OTP: ${otp}`);

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please check with customer.'
      });
    }

    const pickupLat = trip.pickup.coordinates[1];
    const pickupLng = trip.pickup.coordinates[0];
    const distance = calculateDistance(driverLat, driverLng, pickupLat, pickupLng);

    if (distance > 0.1) {
      return res.status(400).json({
        success: false,
        message: `You are ${(distance * 1000).toFixed(0)}m away from pickup location. Please reach customer location first.`,
        distance: distance
      });
    }

    // ✅ FIX: Update rideStatus, NOT status
    trip.rideStatus = 'ride_started';
    trip.startTime = new Date();
    
    // ✅ CRITICAL: Save FIRST, emit AFTER
    await trip.save();
    console.log(`✅ Ride started for trip ${tripId}`);

    // Now emit socket events AFTER successful save
    const customer = await User.findById(trip.customerId);
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:ride_started', {
        tripId: trip._id.toString(),
        startTime: trip.startTime
      });
      console.log(`📢 trip:ride_started emitted to customer ${customer._id}`);
    }

    res.status(200).json({
      success: true,
      message: 'Ride started successfully',
      startTime: trip.startTime
    });
  } catch (err) {
    console.error('🔥 startRide error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const completeRideWithVerification = async (req, res) => {
  try {
    const { tripId, driverId, driverLat, driverLng } = req.body;

    console.log(`✅ Driver ${driverId} completing trip ${tripId}`);

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Check ride was started
    if (trip.rideStatus !== 'ride_started') {
      return res.status(400).json({
        success: false,
        message: 'Ride must be started before completion'
      });
    }

    const dropLat = trip.drop.coordinates[1];
    const dropLng = trip.drop.coordinates[0];
    const distance = calculateDistance(driverLat, driverLng, dropLat, dropLng);

    if (distance > 0.1) {
      return res.status(400).json({
        success: false,
        message: `You are ${(distance * 1000).toFixed(0)}m away from drop location. Please reach drop location first.`,
        distance: distance
      });
    }

    // ✅ Update both status fields
    trip.status = 'completed';
    trip.rideStatus = 'completed';
    trip.endTime = new Date();
    trip.finalFare = trip.fare || 0;
        trip.completedAt = new Date(); // ✅ ADD THIS LINE

    // Save first
    await trip.save();
    console.log(`✅ Ride completed for trip ${tripId} with fare: ₹${trip.finalFare}`);

    // Emit after successful save
    const customer = await User.findById(trip.customerId);
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:completed', {
        tripId: trip._id.toString(),
        endTime: trip.endTime,
        fare: trip.finalFare
      });
      console.log(`📢 trip:completed emitted to customer ${customer._id} with fare: ₹${trip.finalFare}`);
    }

    res.status(200).json({
      success: true,
      message: 'Ride completed successfully',
      fare: trip.finalFare,
      duration: Math.round((trip.endTime - trip.startTime) / 60000)
    });
  } catch (err) {
    console.error('🔥 completeRideWithVerification error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const confirmCashCollection = async (req, res) => {
  try {
    const { tripId, driverId } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Trip must be completed before collecting cash'
      });
    }

    if (trip.paymentCollected) {
      return res.status(400).json({
        success: false,
        message: 'Cash already collected for this trip'
      });
    }
    
    // ✅ This function handles its own response, so don't send another
    await processCashCollection(req, res);
    
  } catch (err) {
    console.error('🔥 confirmCashCollection error:', err);
    // Only send response if one hasn't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// Helper function
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return value * Math.PI / 180;
}
export {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
  acceptTrip,
  rejectTrip,
  completeTrip,
  cancelTrip,
  getTripById,
  goingToPickup,
  startRide,
  completeRideWithVerification,
  confirmCashCollection,
};