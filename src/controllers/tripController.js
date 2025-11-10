// src/controllers/tripController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import mongoose from 'mongoose';

import { io } from '../socket/socketHandler.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';
import { TRIP_LIMITS } from '../config/tripConfig.js';
import { generateOTP } from '../utils/otpGeneration.js';
import { processCashCollection } from './walletController.js';
import RideHistory from '../models/RideHistory.js';
// ✅ HELPER: Save ride to history
async function saveToRideHistory(trip, status = 'Completed') {
  try {
    console.log('');
    console.log('📝 SAVING RIDE TO HISTORY');
    console.log(`   Trip ID: ${trip._id}`);
    console.log(`   Status: ${status}`);
    
    // Populate driver and customer if not already populated
    let populatedTrip = trip;
    if (!trip.customerId?.phone || !trip.assignedDriver?.name) {
      populatedTrip = await Trip.findById(trip._id)
        .populate('customerId', 'phone name')
        .populate('assignedDriver', 'name phone vehicleNumber')
        .lean();
    }
    
    if (!populatedTrip) {
      console.log('❌ Trip not found for history save');
      return;
    }

    // Validate required data
    if (!populatedTrip.customerId || !populatedTrip.customerId.phone) {
      console.log('⚠️ Cannot save to history: customer phone missing');
      return;
    }

    const rideHistory = new RideHistory({
      phone: populatedTrip.customerId.phone,
      customerId: populatedTrip.customerId._id || populatedTrip.customerId,
      pickupLocation: populatedTrip.pickup?.address || 'Pickup Location',
      dropLocation: populatedTrip.drop?.address || 'Drop Location',
      vehicleType: populatedTrip.vehicleType || 'bike',
      fare: populatedTrip.finalFare || populatedTrip.fare || 0,
      status: status,
      driver: {
        name: populatedTrip.assignedDriver?.name || 'N/A',
        phone: populatedTrip.assignedDriver?.phone || 'N/A',
        vehicleNumber: populatedTrip.assignedDriver?.vehicleNumber || 'N/A',
      },
      dateTime: populatedTrip.createdAt || new Date(),
      tripId: populatedTrip._id,
    });

    await rideHistory.save();
    console.log(`✅ Ride history saved: ${rideHistory._id}`);
    console.log(`   Customer: ${rideHistory.phone}`);
    console.log(`   Fare: ₹${rideHistory.fare}`);
    console.log(`   Status: ${rideHistory.status}`);
    console.log('');
    
  } catch (error) {
    console.error('❌ Error saving ride history:', error);
    // Don't throw - we don't want to fail the main operation
  }
}


/**
 * Helper function to award incentives after ride completion
 * This is called internally - no HTTP request needed
 */
async function awardIncentivesToDriver(driverId, tripId) {
  try {
    console.log('');
    console.log('💰 AWARDING INCENTIVES');
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Trip ID: ${tripId}`);

    // Get incentive settings
    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    const settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings || (settings.perRideIncentive === 0 && settings.perRideCoins === 0)) {
      console.log('   ⚠️ No incentives configured - skipping');
      return { success: true, awarded: false };
    }

    console.log(`   Settings: ₹${settings.perRideIncentive} + ${settings.perRideCoins} coins`);

    // Get driver
    const driver = await User.findById(driverId)
      .select('name phone totalCoinsCollected totalIncentiveEarned totalRidesCompleted wallet');

    if (!driver) {
      console.log('   ❌ Driver not found');
      return { success: false, error: 'Driver not found' };
    }

    // Calculate new values
    const currentCoins = driver.totalCoinsCollected || 0;
    const currentIncentive = driver.totalIncentiveEarned || 0.0;
    const currentRides = driver.totalRidesCompleted || 0;
    const currentWallet = driver.wallet || 0;

    const newCoins = currentCoins + settings.perRideCoins;
    const newIncentive = currentIncentive + settings.perRideIncentive;
    const newRides = currentRides + 1;
    const newWallet = currentWallet + settings.perRideIncentive;

    // Update driver with incentives
    await User.findByIdAndUpdate(driverId, {
      $set: {
        totalCoinsCollected: newCoins,
        totalIncentiveEarned: newIncentive,
        totalRidesCompleted: newRides,
        wallet: newWallet,
        lastRideId: tripId,
        lastIncentiveAwardedAt: new Date()
      }
    });

    console.log('   ✅ Incentives awarded successfully:');
    console.log(`      Driver: ${driver.name} (${driver.phone})`);
    console.log(`      Coins: ${currentCoins} → ${newCoins} (+${settings.perRideCoins})`);
    console.log(`      Cash: ₹${currentIncentive.toFixed(2)} → ₹${newIncentive.toFixed(2)} (+₹${settings.perRideIncentive})`);
    console.log(`      Wallet: ₹${currentWallet.toFixed(2)} → ₹${newWallet.toFixed(2)}`);
    console.log(`      Total Rides: ${currentRides} → ${newRides}`);
    console.log('');

    return {
      success: true,
      awarded: true,
      coins: settings.perRideCoins,
      cash: settings.perRideIncentive,
      newTotals: {
        coins: newCoins,
        incentive: newIncentive,
        rides: newRides,
        wallet: newWallet
      }
    };

  } catch (error) {
    console.error('   ❌ Error awarding incentives:', error);
    return { success: false, error: error.message };
  }
}


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

    console.log('');
    console.log('='.repeat(70));
    console.log('📥 CREATE SHORT TRIP REQUEST RECEIVED');
    console.log('='.repeat(70));
    console.log('📋 Request Body:', JSON.stringify(req.body, null, 2));
    console.log('='.repeat(70));

    // Validate fare
    if (!fare || fare <= 0) {
      console.log('❌ REJECTED: Fare is invalid');
      return res.status(400).json({
        success: false,
        message: `A valid trip fare greater than zero is required. Received: ${fare}`
      });
    }

    // Validate vehicle type
    if (!vehicleType || typeof vehicleType !== 'string' || vehicleType.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Vehicle type is required and must be a non-empty string.'
      });
    }

    // Normalize coordinates
    pickup.coordinates = normalizeCoordinates(pickup.coordinates);
    drop.coordinates = normalizeCoordinates(drop.coordinates);

    const sanitizedVehicleType = vehicleType.trim().toLowerCase();

    // Find customer
    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    // ✅ FIXED: Simplified and explicit driver availability query
    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType: sanitizedVehicleType,
      isOnline: true,
      
      // ✅ CRITICAL: Explicitly check for available drivers only
      isBusy: { $ne: true }, // Not busy (includes false, null, undefined)
      
      // ✅ CRITICAL: No current trip assigned
      $or: [
        { currentTripId: null },
        { currentTripId: { $exists: false } }
      ],
      
      // Location near pickup
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: TRIP_LIMITS.SHORT || 2000,
        },
      },
    })
    .select('name phone vehicleType location isOnline socketId fcmToken currentTripId isBusy')
    .lean();

    console.log(`🔍 Found ${nearbyDrivers.length} available '${sanitizedVehicleType}' drivers`);

    // ✅ Enhanced logging for debugging
    nearbyDrivers.forEach(d => {
      console.log(`  ✓ ${d.name}:`);
      console.log(`    - isBusy: ${d.isBusy}`);
      console.log(`    - currentTripId: ${d.currentTripId}`);
      console.log(`    - isOnline: ${d.isOnline}`);
    });

    // Create trip
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

    // Prepare broadcast payload
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

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No '${sanitizedVehicleType}' drivers found for short trip ${trip._id}`);
      return res.status(200).json({ success: true, tripId: trip._id, drivers: 0 });
    }

    // Broadcast to available drivers
    broadcastToDrivers(nearbyDrivers, payload);
    
    console.log(`✅ Short Trip ${trip._id} created with fare ₹${trip.fare}`);
    console.log(`   Found ${nearbyDrivers.length} '${sanitizedVehicleType}' drivers`);
    console.log('='.repeat(70));
    
    res.status(200).json({ 
      success: true, 
      tripId: trip._id, 
      drivers: nearbyDrivers.length 
    });

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
  $or: [
    { 
      currentTripId: null,
      canReceiveNewRequests: { $in: [false, null, undefined] }
    },
    { 
      currentTripId: { $ne: null },
      canReceiveNewRequests: true
    },
    { currentTripId: { $exists: false } }
  ],
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
  $or: [
    { 
      currentTripId: null,
      canReceiveNewRequests: { $in: [false, null, undefined] }
    },
    { 
      currentTripId: { $ne: null },
      canReceiveNewRequests: true
    },
    { currentTripId: { $exists: false } }
  ],
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

    console.log('');
    console.log('='.repeat(70));
    console.log(`🎯 Driver ${driverId} attempting to accept trip ${tripId}`);
    console.log('='.repeat(70));

    // ✅ STEP 1: Verify driver is truly available FIRST
    const driver = await User.findById(driverId)
      .select('name phone isBusy currentTripId isOnline vehicleType location photoUrl rating vehicleBrand vehicleNumber')
      .lean();

    if (!driver) {
      console.log(`❌ Driver ${driverId} not found`);
      return res.status(404).json({ 
        success: false, 
        message: 'Driver not found' 
      });
    }

    console.log(`📊 Driver current state BEFORE update:`);
    console.log(`   - isBusy: ${driver.isBusy}`);
    console.log(`   - currentTripId: ${driver.currentTripId}`);
    console.log(`   - isOnline: ${driver.isOnline}`);

    // ✅ Check if driver is already busy
    if (driver.isBusy === true || driver.currentTripId) {
      console.log(`⚠️ Driver ${driverId} is already on a trip!`);
      return res.status(400).json({
        success: false,
        message: 'You are already on another trip',
        reason: 'driver_busy'
      });
    }

    const rideCode = generateOTP();

    // ✅ STEP 2: ATOMIC OPERATION - Update trip AND check if available
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

    console.log(`✅ Trip ${tripId} marked as driver_assigned`);

    // ✅ STEP 3: Update driver status - CRITICAL FIX
    const driverUpdate = await User.findByIdAndUpdate(
      driverId,
      {
        $set: { 
          currentTripId: tripId,
          isBusy: true,
          canReceiveNewRequests: false,
          lastTripAcceptedAt: new Date()
        }
      },
      { new: true, runValidators: false } // Skip validators for speed
    );

    if (!driverUpdate) {
      console.error(`❌ CRITICAL: Failed to update driver ${driverId}!`);
      
      // Rollback trip assignment
      await Trip.findByIdAndUpdate(tripId, { 
        $unset: { assignedDriver: 1, otp: 1 },
        $set: { status: 'requested', acceptedAt: null }
      });
      
      return res.status(500).json({
        success: false,
        message: 'Failed to update driver status. Please try again.',
        reason: 'driver_update_failed'
      });
    }

    // ✅ VERIFICATION: Check if update actually worked
    const verifyDriver = await User.findById(driverId)
      .select('isBusy currentTripId canReceiveNewRequests')
      .lean();
    
    console.log(`📊 Driver state AFTER update:`);
    console.log(`   - isBusy: ${verifyDriver.isBusy}`);
    console.log(`   - currentTripId: ${verifyDriver.currentTripId}`);
    console.log(`   - canReceiveNewRequests: ${verifyDriver.canReceiveNewRequests}`);

    // ✅ Safety check: Verify the update worked
    if (verifyDriver.isBusy !== true || verifyDriver.currentTripId?.toString() !== tripId) {
      console.error(`❌ CRITICAL: Driver update verification FAILED!`);
      console.error(`   Expected: isBusy=true, currentTripId=${tripId}`);
      console.error(`   Actual: isBusy=${verifyDriver.isBusy}, currentTripId=${verifyDriver.currentTripId}`);
      
      // Rollback
      await Trip.findByIdAndUpdate(tripId, { 
        $unset: { assignedDriver: 1, otp: 1 },
        $set: { status: 'requested', acceptedAt: null }
      });
      
      return res.status(500).json({
        success: false,
        message: 'Driver status update failed. Please try again.',
        reason: 'verification_failed'
      });
    }

    console.log(`✅ Driver ${driverId} successfully marked as BUSY`);

    // ✅ STEP 4: Notify customer
    const customer = await User.findById(trip.customerId)
      .select('socketId fcmToken name')
      .lean();

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
      
      io.to(customer.socketId).emit('trip:accepted', payload);
      console.log(`✅ Customer notified via socket`);
    }

    // ✅ STEP 5: Notify ALL other drivers that this trip is taken
    console.log(`🚫 Broadcasting trip:taken to other drivers`);
    
    const otherDrivers = await User.find({
      isDriver: true,
      isOnline: true,
      _id: { $ne: driverId },
      socketId: { $exists: true, $ne: null }
    }).select('socketId name').lean();

    console.log(`📡 Notifying ${otherDrivers.length} other drivers`);

    otherDrivers.forEach(otherDriver => {
      if (otherDriver.socketId) {
        io.to(otherDriver.socketId).emit('trip:taken', {
          tripId: tripId,
          acceptedBy: driver.name || 'Another driver',
        });
      }
    });

    console.log('='.repeat(70));
    console.log(`✅ SUCCESS: Trip accepted`);
    console.log(`   Trip: ${tripId}`);
    console.log(`   Driver: ${driver.name} (${driverId})`);
    console.log(`   OTP: ${rideCode}`);
    console.log('='.repeat(70));
    console.log('');

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
    console.error(err.stack);
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

// ✅ UPDATED: Enhanced cancelTrip with proper cleanup

const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy } = req.body;
    
    console.log('');
    console.log('='.repeat(70));
    console.log('🚫 CANCEL TRIP REQUEST');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Cancelled By: ${cancelledBy}`);
    console.log('='.repeat(70));

    if (!tripId || !cancelledBy) {
      return res.status(400).json({ 
        success: false, 
        message: 'tripId and cancelledBy are required' 
      });
    }

    // ✅ Populate to get full data for history
    const trip = await Trip.findById(tripId)
      .populate('customerId', 'phone name socketId')
      .populate('assignedDriver', 'name phone vehicleNumber socketId');
      
    if (!trip) {
      console.log('❌ Trip not found');
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.status === 'cancelled') {
      console.log('⚠️ Trip already cancelled');
      return res.status(400).json({ 
        success: false, 
        message: 'Trip is already cancelled' 
      });
    }

    if (trip.status === 'completed') {
      console.log('⚠️ Cannot cancel completed trip');
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot cancel a completed trip' 
      });
    }

    console.log(`📋 Trip status: ${trip.status}`);

    const isCustomer = trip.customerId?._id?.toString() === cancelledBy || trip.customerId?.toString() === cancelledBy;
    const isDriver = trip.assignedDriver?._id?.toString() === cancelledBy || trip.assignedDriver?.toString() === cancelledBy;
    
    if (!isCustomer && !isDriver) {
      console.log('❌ Not authorized to cancel');
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Update trip status
    trip.status = 'cancelled';
    trip.cancelledBy = cancelledBy;
    trip.cancelledAt = new Date();
    await trip.save();

    console.log('✅ Trip marked as cancelled in database');

    // ✅ SAVE TO RIDE HISTORY (cancelled trips)
    await saveToRideHistory(trip, 'Cancelled');

    // Free driver if assigned
    if (trip.assignedDriver) {
      const driverId = trip.assignedDriver._id || trip.assignedDriver;
      
      await User.findByIdAndUpdate(driverId, {
        $set: { 
          currentTripId: null,
          isBusy: false,
          canReceiveNewRequests: false,
          awaitingCashCollection: false,
          lastTripCancelledAt: new Date()
        }
      });
      
      console.log(`✅ Driver ${driverId} freed`);

      // Notify driver
      const driver = trip.assignedDriver;
      if (driver?.socketId) {
        io.to(driver.socketId).emit('trip:cancelled', {
          tripId: tripId,
          message: isCustomer ? 'Customer cancelled the trip' : 'Trip cancelled',
          cancelledBy: isCustomer ? 'customer' : 'driver',
          timestamp: new Date().toISOString(),
          shouldClearTrip: true
        });
        console.log(`📢 Notified driver via socket`);
      }
    }

    // Notify customer
    const customer = trip.customerId;
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:cancelled', {
        tripId: tripId,
        message: isDriver ? 'Driver cancelled the trip' : 'Trip cancelled',
        cancelledBy: isDriver ? 'driver' : 'customer',
        timestamp: new Date().toISOString(),
        shouldClearTrip: true
      });
      console.log(`📢 Notified customer via socket`);
    }

    console.log('='.repeat(70));
    console.log('✅ Trip cancellation complete');
    console.log('='.repeat(70));
    console.log('');

    res.status(200).json({ 
      success: true, 
      message: 'Trip cancelled successfully',
      tripId: tripId,
      cancelledBy: isCustomer ? 'customer' : 'driver',
      driverFreed: !!trip.assignedDriver
    });

  } catch (err) {
    console.error('🔥 cancelTrip error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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
/**
 * Get driver's active trip for resumption
 * GET /api/trip/driver/active/:driverId
 */
/**
 * Get driver's active trip for resumption
 * GET /api/trip/driver/active/:driverId
 */
const getDriverActiveTrip = async (req, res) => {
  try {
    const { driverId } = req.params;

    console.log('');
    console.log('='.repeat(70));
    console.log(`🔍 CHECKING ACTIVE TRIP FOR DRIVER: ${driverId}`);
    console.log('='.repeat(70));

    // ✅ CRITICAL FIX: Find active trip EXCLUDING completed trips with payment collected
    const trip = await Trip.findOne({
      assignedDriver: driverId,
      $and: [
        // Must be one of these statuses
        {
          $or: [
            // Active trip statuses
            { 
              status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] } 
            },
            // Completed but ONLY if payment NOT collected
            { 
              status: 'completed',
              $or: [
                { paymentCollected: { $ne: true } },  // Not true
                { paymentCollected: { $exists: false } }  // Field doesn't exist
              ]
            }
          ]
        }
      ]
    })
    .populate('customerId', 'name phone photoUrl rating')
    .lean();

    if (!trip) {
      console.log('✅ No active trip found - CLEARING DRIVER STATE');
      
      // ✅ CRITICAL FIX: Clear driver state completely
      const driverUpdate = await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy: false,
          currentTripId: null,
          canReceiveNewRequests: false,
          awaitingCashCollection: false,
          lastTripCheckedAt: new Date()
        }
      }, { new: true });
      
      if (driverUpdate) {
        console.log('✅ Driver state cleared:');
        console.log('   - isBusy: false');
        console.log('   - currentTripId: null');
        console.log('   - canReceiveNewRequests: false');
        console.log('   - awaitingCashCollection: false');
        console.log('   Driver is now FREE to accept new trips');
      }
      
      console.log('='.repeat(70));
      console.log('');
      
      return res.status(200).json({
        success: true,
        hasActiveTrip: false,
        message: 'No active trip',
        driverFreed: true
      });
    }

    // ✅ Double-check payment status
    if (trip.status === 'completed' && trip.paymentCollected === true) {
      console.log('');
      console.log('⚠️ FOUND COMPLETED TRIP WITH PAYMENT COLLECTED');
      console.log(`   Trip ID: ${trip._id}`);
      console.log(`   This should NOT have been returned - clearing driver state`);
      console.log('');
      
      // Clear driver state
      await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy: false,
          currentTripId: null,
          canReceiveNewRequests: false,
          awaitingCashCollection: false,
          lastTripCheckedAt: new Date()
        }
      });
      
      console.log('✅ Driver state cleared');
      console.log('='.repeat(70));
      console.log('');
      
      return res.status(200).json({
        success: true,
        hasActiveTrip: false,
        message: 'No active trip (payment already collected)',
        driverFreed: true
      });
    }

    console.log('⚠️ ACTIVE TRIP FOUND:');
    console.log(`   Trip ID: ${trip._id}`);
    console.log(`   Status: ${trip.status}`);
    console.log(`   Ride Phase: ${trip.rideStatus || 'N/A'}`);
    console.log(`   OTP: ${trip.otp || 'N/A'}`);
    console.log(`   Customer: ${trip.customerId?.name || 'Unknown'}`);
    console.log(`   Payment Collected: ${trip.paymentCollected || false}`);

    // ✅ Determine ride phase
    let ridePhase = 'going_to_pickup'; // default
    
    if (trip.rideStatus === 'ride_started') {
      ridePhase = 'going_to_drop';
    } else if (trip.rideStatus === 'arrived_at_pickup') {
      ridePhase = 'at_pickup';
    } else if (trip.rideStatus === 'completed' || trip.status === 'completed') {
      // ✅ Only set to completed if payment NOT collected
      if (trip.paymentCollected !== true) {
        ridePhase = 'completed';
      }
    } else if (trip.status === 'ride_started') {
      ridePhase = 'going_to_drop';
    } else if (trip.status === 'driver_at_pickup') {
      ridePhase = 'at_pickup';
    } else if (trip.status === 'driver_going_to_pickup') {
      ridePhase = 'going_to_pickup';
    } else if (trip.status === 'driver_assigned') {
      ridePhase = 'going_to_pickup';
    }

    console.log(`   Determined Phase: ${ridePhase}`);

    // ✅ SAFETY CHECK: If phase is 'completed' but payment is collected, something is wrong
    if (ridePhase === 'completed' && trip.paymentCollected === true) {
      console.log('');
      console.log('❌ CRITICAL ERROR: Phase is completed but payment already collected!');
      console.log('   This should never happen. Clearing driver state...');
      console.log('');
      
      await User.findByIdAndUpdate(driverId, {
        $set: {
          isBusy: false,
          currentTripId: null,
          canReceiveNewRequests: false,
          awaitingCashCollection: false
        }
      });
      
      return res.status(200).json({
        success: true,
        hasActiveTrip: false,
        message: 'Trip completed and paid - no action needed',
        driverFreed: true
      });
    }

    // Format response
    const response = {
      success: true,
      hasActiveTrip: true,
      trip: {
        tripId: trip._id.toString(),
        rideCode: trip.otp,
        status: trip.status,
        ridePhase: ridePhase,
        fare: trip.fare || trip.finalFare || 0,
        paymentCollected: trip.paymentCollected || false, // ✅ Include this
        pickup: {
          lat: trip.pickup.coordinates[1],
          lng: trip.pickup.coordinates[0],
          address: trip.pickup.address
        },
        drop: {
          lat: trip.drop.coordinates[1],
          lng: trip.drop.coordinates[0],
          address: trip.drop.address
        }
      },
      customer: trip.customerId ? {
        id: trip.customerId._id.toString(),
        name: trip.customerId.name || 'Customer',
        phone: trip.customerId.phone || 'N/A',
        photoUrl: trip.customerId.photoUrl || null,
        rating: trip.customerId.rating || 5.0
      } : null
    };

    console.log('📤 Sending trip resume data to driver');
    console.log('='.repeat(70));
    console.log('');

    res.status(200).json(response);

  } catch (err) {
    console.error('🔥 getDriverActiveTrip error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch active trip',
      error: err.message 
    });
  }
};
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

    console.log('');
    console.log('='.repeat(70));
    console.log('🏁 COMPLETE RIDE REQUEST');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log('='.repeat(70));

    const trip = await Trip.findById(tripId)
      .populate('customerId', 'phone name socketId')
      .populate('assignedDriver', 'name phone vehicleNumber');
      
    if (!trip) {
      console.log('❌ Trip not found');
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?._id.toString() !== driverId) {
      console.log('❌ Not authorized');
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.status !== 'ride_started' && trip.rideStatus !== 'ride_started') {
      console.log(`❌ Invalid trip status: ${trip.status} / ${trip.rideStatus}`);
      return res.status(400).json({
        success: false,
        message: 'Ride must be started before completion'
      });
    }

    // Calculate distance to drop location
    const dropLat = trip.drop.coordinates[1];
    const dropLng = trip.drop.coordinates[0];
    const distance = calculateDistance(driverLat, driverLng, dropLat, dropLng);

    console.log(`📍 Distance to drop: ${(distance * 1000).toFixed(0)}m`);

    if (distance > 0.5) {
      return res.status(400).json({
        success: false,
        message: `You are ${(distance * 1000).toFixed(0)}m away from drop location. Please reach destination first.`,
        distance: distance
      });
    }

    // Update trip status
    trip.status = 'completed';
    trip.rideStatus = 'completed';
    trip.endTime = new Date();
    trip.finalFare = trip.fare || 0;
    trip.completedAt = new Date();
    trip.paymentCollected = false;
    trip.paymentCollectedAt = null;
    
    await trip.save();

    console.log(`✅ Trip ${tripId} marked as completed`);
    console.log(`   Status: ${trip.status}`);
    console.log(`   Payment Collected: ${trip.paymentCollected}`);
    console.log(`   Final Fare: ₹${trip.finalFare}`);

    // 💰 AWARD INCENTIVES TO DRIVER (NEW)
    try {
      const incentiveResult = await awardIncentivesToDriver(driverId, tripId);
      if (incentiveResult.awarded) {
        console.log(`🎉 Driver earned: ₹${incentiveResult.cash} + ${incentiveResult.coins} coins`);
      }
    } catch (incentiveError) {
      // Log but don't fail the trip completion
      console.error('⚠️ Failed to award incentives:', incentiveError);
    }

    // ✅ SAVE TO RIDE HISTORY
    await saveToRideHistory(trip, 'Completed');

    // Update driver status
    await User.findByIdAndUpdate(driverId, {
      $set: { 
        currentTripId: tripId,
        isBusy: true,
        canReceiveNewRequests: false,
        awaitingCashCollection: true,
        lastTripCompletedAt: new Date()
      }
    });
    
    console.log(`✅ Driver ${driverId} status: awaiting cash collection`);

    // Emit to customer
    const customer = trip.customerId;
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:completed', {
        tripId: tripId,
        endTime: trip.endTime,
        fare: trip.finalFare,
        awaitingPayment: true
      });
      console.log(`📢 Emitted trip:completed to customer`);
    }

    console.log('='.repeat(70));
    console.log('');

    res.status(200).json({
      success: true,
      message: 'Ride completed. Please collect cash from customer.',
      fare: trip.finalFare,
      duration: Math.round((trip.endTime - trip.startTime) / 60000),
      awaitingCashCollection: true,
      paymentCollected: false
    });

  } catch (err) {
    console.error('🔥 completeRideWithVerification error:', err);
    console.error('Stack:', err.stack);
    res.status(500).json({ success: false, message: err.message });
  }
};
/**
 * Get trip by ID with payment status
 * GET /api/trip/:tripId
 */
const getTripByIdWithPayment = async (req, res) => {
  try {
    const { tripId } = req.params;

    console.log(`🔍 Fetching trip details for: ${tripId}`);

    const trip = await Trip.findById(tripId)
      .populate('assignedDriver', 'name phone photoUrl rating vehicleBrand vehicleNumber')
      .populate('customerId', 'name phone photoUrl rating')
      .lean();

    if (!trip) {
      return res.status(404).json({ 
        success: false, 
        message: 'Trip not found' 
      });
    }

    console.log(`✅ Trip found:`);
    console.log(`   Status: ${trip.status}`);
    console.log(`   Payment Collected: ${trip.paymentCollected}`);

    res.status(200).json({ 
      success: true, 
      trip: {
        _id: trip._id,
        status: trip.status,
        rideStatus: trip.rideStatus,
        paymentCollected: trip.paymentCollected || false,
        paymentCollectedAt: trip.paymentCollectedAt,
        fare: trip.fare,
        finalFare: trip.finalFare,
        otp: trip.otp,
        pickup: trip.pickup,
        drop: trip.drop,
        assignedDriver: trip.assignedDriver,
        customerId: trip.customerId,
        createdAt: trip.createdAt,
        completedAt: trip.completedAt
      }
    });

  } catch (err) {
    console.error('🔥 getTripByIdWithPayment error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch trip details',
      error: err.message 
    });
  }
};

// ✅ COMPLETE FIX for confirmCashCollection in tripController.js

// ✅ FIXED: confirmCashCollection in tripController.js
// REMOVE the trip update - let processCashCollection handle it

const confirmCashCollection = async (req, res) => {
  try {
    const { tripId, driverId, fare } = req.body;

    console.log('');
    console.log('='.repeat(70));
    console.log('💰 CONFIRM CASH COLLECTION REQUEST');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Fare: ${fare || 'from trip'}`);
    console.log('='.repeat(70));

    // Validate input
    if (!tripId || !driverId) {
      return res.status(400).json({
        success: false,
        message: 'tripId and driverId are required'
      });
    }

    // ✅ STEP 1: Fetch trip with current state
    const trip = await Trip.findById(tripId).lean();
    if (!trip) {
      console.log('❌ Trip not found');
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    console.log(`📋 Trip current state:`);
    console.log(`   Status: ${trip.status}`);
    console.log(`   Payment Collected: ${trip.paymentCollected}`);
    console.log(`   Assigned Driver: ${trip.assignedDriver}`);

    // ✅ STEP 2: Verify authorization
    if (trip.assignedDriver?.toString() !== driverId) {
      console.log('❌ Driver not authorized');
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // ✅ STEP 3: Verify trip is completed
    if (trip.status !== 'completed') {
      console.log(`❌ Trip not completed yet. Current status: ${trip.status}`);
      return res.status(400).json({
        success: false,
        message: 'Trip must be completed before collecting cash'
      });
    }

    // ✅ STEP 4: Check if already collected
    if (trip.paymentCollected === true) {
      console.log('⚠️ Cash already collected!');
      return res.status(400).json({
        success: false,
        message: 'Cash already collected for this trip',
        collectedAt: trip.paymentCollectedAt
      });
    }

    console.log('✅ All validations passed - proceeding with wallet processing');

    const fareAmount = fare || trip.finalFare || trip.fare || 0;
    
    if (fareAmount <= 0) {
      console.log('❌ Invalid fare amount');
      return res.status(400).json({
        success: false,
        message: 'Invalid fare amount'
      });
    }

    console.log(`💵 Processing fare: ₹${fareAmount}`);

    // ✅ STEP 5: Call processCashCollection - it will handle EVERYTHING
    // (trip update, wallet update, driver state, socket events)
    const mockReq = {
      body: {
        tripId,
        driverId,
        fare: fareAmount
      }
    };

    // Create a promise-based wrapper for the response
    let walletResult;
    try {
      walletResult = await new Promise((resolve, reject) => {
        const mockRes = {
          status: (code) => ({
            json: (data) => {
              if (code === 200 && data.success) {
                resolve({ success: true, data });
              } else {
                resolve({ 
                  success: false, 
                  message: data.message || 'Wallet processing failed',
                  data 
                });
              }
            }
          }),
          headersSent: false
        };

        // Call the actual processCashCollection function
        processCashCollection(mockReq, mockRes).catch(reject);
      });
    } catch (walletError) {
      console.error('❌ Wallet processing error:', walletError);
      
      return res.status(500).json({
        success: false,
        message: 'Wallet processing failed: ' + walletError.message
      });
    }

    if (!walletResult.success) {
      console.error('❌ Wallet processing failed:', walletResult.message);
      
      return res.status(500).json({
        success: false,
        message: 'Wallet processing failed: ' + walletResult.message
      });
    }

    console.log('✅ Wallet transaction successful');

    console.log('');
    console.log('✅ CASH COLLECTION COMPLETE - Driver ready for next trip');
    console.log('='.repeat(70));
    console.log('');

    // Extract wallet data from the result
    const walletData = walletResult.data?.wallet || {};
    const fareBreakdown = walletResult.data?.fareBreakdown || {};

    res.status(200).json({
      success: true,
      message: 'Cash collected successfully',
      amount: fareAmount,
      fareBreakdown: {
        tripFare: Number((fareBreakdown.tripFare || fareAmount).toFixed(2)),
        commission: Number((fareBreakdown.commission || 0).toFixed(2)),
        commissionPercentage: fareBreakdown.commissionPercentage || 15,
        driverEarning: Number((fareBreakdown.driverEarning || 0).toFixed(2))
      },
      wallet: {
        totalEarnings: Number((walletData.totalEarnings || 0).toFixed(2)),
        totalCommission: Number((walletData.totalCommission || 0).toFixed(2)),
        pendingAmount: Number((walletData.pendingAmount || 0).toFixed(2)),
        availableBalance: Number((walletData.availableBalance || 0).toFixed(2))
      }
    });

  } catch (err) {
    console.error('🔥 confirmCashCollection error:', err);
    console.error('Stack:', err.stack);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to confirm cash collection',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
};
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
// ADD THIS NEW FUNCTION (after completeRideWithVerification)

/**
 * Check if customer has an active ride
 * GET /api/trip/active/:customerId
 */
const getActiveRide = async (req, res) => {
  try {
    const { customerId } = req.params;

    console.log(`🔍 Checking active ride for customer: ${customerId}`);

    // Find active trip for this customer
    const trip = await Trip.findOne({
      customerId,
      status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] }
    })
    .populate('assignedDriver', 'name phone photoUrl rating vehicleBrand vehicleNumber location')
    .lean();

    if (!trip) {
      return res.status(200).json({
        success: true,
        hasActiveRide: false,
        message: 'No active ride found'
      });
    }

    console.log(`✅ Found active ride: ${trip._id}, status: ${trip.status}`);

    // Format response
    const response = {
      success: true,
      hasActiveRide: true,
      trip: {
        tripId: trip._id.toString(),
        rideCode: trip.otp,
        status: trip.status,
        rideStatus: trip.rideStatus,
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
        fare: trip.fare || trip.finalFare || 0,
      },
      driver: trip.assignedDriver ? {
        id: trip.assignedDriver._id.toString(),
        name: trip.assignedDriver.name || 'Driver',
        phone: trip.assignedDriver.phone || 'N/A',
        photoUrl: trip.assignedDriver.photoUrl || null,
        rating: trip.assignedDriver.rating || 4.8,
        vehicleBrand: trip.assignedDriver.vehicleBrand || 'Vehicle',
        vehicleNumber: trip.assignedDriver.vehicleNumber || 'N/A',
        location: {
          lat: trip.assignedDriver.location.coordinates[1],
          lng: trip.assignedDriver.location.coordinates[0]
        }
      } : null
    };

    res.status(200).json(response);

  } catch (err) {
    console.error('🔥 getActiveRide error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to check active ride',
      error: err.message 
    });
  }
};

// ADD TO EXPORTS at bottom
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
  getDriverActiveTrip, // ✅ ADD THIS
  getTripByIdWithPayment, // ✅ ADD THIS

  getActiveRide, // ✅ ADD THIS
};