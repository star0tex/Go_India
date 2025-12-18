import User from '../models/User.js';
import Trip from '../models/Trip.js';
import mongoose from 'mongoose';
import ChatMessageModel from '../models/ChatMessage.js';
import { startNotificationRetryJob } from '../utils/notificationRetry.js';
import { startStaleTripCleanup } from '../utils/staleTripsCleanup.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';
import { broadcastToDrivers } from '../utils/tripBroadcaster.js';

import {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
} from '../controllers/tripController.js';
import { emitTripError } from '../utils/errorEmitter.js';
const TRIP_TIMEOUT_MS = 60000; // 60 seconds
const ChatMessage = mongoose.models.ChatMessage || ChatMessageModel;

let io;

const connectedDrivers = new Map();
const connectedCustomers = new Map();

const DISTANCE_LIMITS = {
  short: 5000,
  parcel: 5000,
  long_same_day: 20000,
  long_multi_day: 50000,
};

async function awardIncentivesToDriver(driverId, tripId) {
  try {
    console.log('');
    console.log('💰 AWARDING INCENTIVES (Socket)');
    console.log(`   Driver ID: ${driverId}`);

    const db = mongoose.connection.db;
    const IncentiveSettings = db.collection('incentiveSettings');
    const settings = await IncentiveSettings.findOne({ type: 'global' });

    if (!settings || (settings.perRideIncentive === 0 && settings.perRideCoins === 0)) {
      console.log('   ⚠️ No incentives configured');
      return { success: true, awarded: false };
    }

    const driver = await User.findById(driverId)
      .select('name phone totalCoinsCollected totalIncentiveEarned totalRidesCompleted wallet');

    if (!driver) {
      console.log('   ❌ Driver not found');
      return { success: false, error: 'Driver not found' };
    }

    const currentCoins = driver.totalCoinsCollected || 0;
    const currentIncentive = driver.totalIncentiveEarned || 0.0;
    const currentRides = driver.totalRidesCompleted || 0;
    const currentWallet = driver.wallet || 0;

    const newCoins = currentCoins + settings.perRideCoins;
    const newIncentive = currentIncentive + settings.perRideIncentive;
    const newRides = currentRides + 1;
    const newWallet = currentWallet + settings.perRideIncentive;

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

    console.log('   ✅ Incentives awarded');
    console.log('');

    return {
      success: true,
      awarded: true,
      coins: settings.perRideCoins,
      cash: settings.perRideIncentive,
      newTotals: { coins: newCoins, incentive: newIncentive, rides: newRides, wallet: newWallet }
    };

  } catch (error) {
    console.error('   ❌ Error awarding incentives:', error);
    return { success: false, error: error.message };
  }
}

const normalizePhone = (phone) => {
  if (!phone) return null;
  return String(phone).replace(/[^0-9]/g, "");
};

const validateTripPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { type, customerId, pickup, drop } = payload;
  if (!type || !customerId || !pickup || !drop) return false;
  if (!pickup.coordinates || !Array.isArray(pickup.coordinates) || pickup.coordinates.length !== 2) return false;
  if (!drop.coordinates || !Array.isArray(drop.coordinates) || drop.coordinates.length !== 2) return false;
  return true;
};

const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;

  try {
    if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
      const byId = await User.findById(idOrPhone);
      if (byId) return byId;
    }

    const byFirebaseUid = await User.findOne({ firebaseUid: idOrPhone });
    if (byFirebaseUid) return byFirebaseUid;

    const normalizedPhone = normalizePhone(idOrPhone);
    const byPhone = await User.findOne({ phone: normalizedPhone });
    if (byPhone) return byPhone;

    return null;
  } catch (err) {
    console.error('❌ resolveUserByIdOrPhone error:', err);
    return null;
  }
};

function toRad(value) {
  return value * Math.PI / 180;
}

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

export const initSocket = (ioInstance) => {
  io = ioInstance;

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // DRIVER STATUS UPDATE
socket.on('updateDriverStatus', async (payload = {}) => {
  try {
    const {
      driverId,
      isOnline,
      location,
      lat,
      lng,
      fcmToken,
      profileData,
      vehicleType,
    } = payload;

    if (!driverId) return;

    const user = await resolveUserByIdOrPhone(driverId);
    if (!user) {
      console.warn(`updateDriverStatus: user not found for ${driverId}`);
      return;
    }

    const set = {
      socketId: socket.id,
      isOnline: !!isOnline,
      locationSequence: 0,  // ✅ ADD THIS LINE - Reset sequence on reconnect
    };

    if (location?.coordinates?.length === 2) {
      set.location = { type: 'Point', coordinates: location.coordinates };
      set.lastLocationUpdate = new Date();
    } else if (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      !Number.isNaN(lat) &&
      !Number.isNaN(lng)
    ) {
      set.location = { type: 'Point', coordinates: [lng, lat] };
      set.lastLocationUpdate = new Date();
    }
    else if (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      !Number.isNaN(lat) &&
      !Number.isNaN(lng)
    ) {
      set.location = { type: 'Point', coordinates: [lng, lat] };
      set.lastLocationUpdate = new Date(); // ✅ ADD THIS
    }
        if (fcmToken) set.fcmToken = fcmToken;

        const allowedProfileKeys = [
          'name',
          'photoUrl',
          'rating',
          'vehicleBrand',
          'vehicleNumber',
          'vehicleType',
        ];

        if (profileData && typeof profileData === 'object') {
          for (const key of allowedProfileKeys) {
            if (profileData[key] !== undefined && profileData[key] !== null) {
              set[key] =
                key === 'vehicleType'
                  ? String(profileData[key]).toLowerCase().trim()
                  : profileData[key];
            }
          }
        }

        if (vehicleType) {
          set.vehicleType = String(vehicleType).toLowerCase().trim();
        }

        await User.findByIdAndUpdate(user._id, { $set: set }, { new: true });
        connectedDrivers.set(socket.id, user._id.toString());

        socket.emit('driver:statusUpdated', { ok: true, isOnline: !!isOnline });
        console.log(`📶 Driver ${user._id} is now ${isOnline ? 'online' : 'offline'}.`);
      } catch (e) {
        emitTripError({ socket, message: 'Failed to update driver status.' });
        console.error('❌ updateDriverStatus error:', e);
      }
    });

    // DRIVER RECONNECT WITH ACTIVE TRIP
    socket.on('driver:reconnect_with_trip', async ({ driverId, tripId }) => {
      try {
        console.log('🔄 DRIVER RECONNECTING WITH ACTIVE TRIP', driverId, tripId);

        const driver = await User.findById(driverId).lean();
        if (!driver) {
          socket.emit('reconnect:failed', { message: 'Driver not found' });
          return;
        }

        const trip = await Trip.findById(tripId).lean();
        if (!trip) {
          socket.emit('reconnect:failed', { message: 'Trip not found', shouldClearTrip: true });
          return;
        }

        const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
        if (!activeStatuses.includes(trip.status)) {
          socket.emit('reconnect:failed', { message: `Trip is ${trip.status}`, shouldClearTrip: true, tripStatus: trip.status });
          return;
        }

        await User.findByIdAndUpdate(driverId, { $set: { socketId: socket.id } });
        connectedDrivers.set(socket.id, driverId.toString());

        const customer = await User.findById(trip.customerId)
          .select('name phone photoUrl rating')
          .lean();

        socket.emit('reconnect:success', {
          tripId: trip._id.toString(),
          status: trip.status,
          rideStatus: trip.rideStatus,
          otp: trip.otp,
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
            fare: trip.fare
          },
          customer: customer ? {
            id: customer._id.toString(),
            name: customer.name,
            phone: customer.phone,
            photoUrl: customer.photoUrl,
            rating: customer.rating
          } : null
        });

      } catch (e) {
        console.error('❌ driver:reconnect_with_trip error:', e);
        socket.emit('reconnect:failed', { message: 'Reconnection failed', error: e.message });
      }
    });

    // CUSTOMER REGISTER
    socket.on('customer:register', async ({ customerId }) => {
      try {
        if (!customerId) {
          socket.emit('customer:registered', { success: false, error: 'customerId missing' });
          return;
        }

        const user = await resolveUserByIdOrPhone(customerId);
        if (!user) {
          socket.emit('customer:registered', {
            success: false,
            error: 'User not found in database',
            providedId: customerId
          });
          return;
        }

        for (const [existingSocketId, existingCustomerId] of connectedCustomers.entries()) {
          if (existingCustomerId === user._id.toString()) {
            connectedCustomers.delete(existingSocketId);
          }
        }

        try {
          await User.findByIdAndUpdate(user._id, { $set: { socketId: socket.id } }, { new: true });
        } catch (dbError) {
          console.error('❌ Database update error:', dbError);
        }

        connectedCustomers.set(socket.id, user._id.toString());

        socket.emit('customer:registered', {
          success: true,
          customerId: user._id.toString(),
          mongoId: user._id.toString(),
          socketId: socket.id,
          phone: user.phone,
          name: user.name,
          firebaseUid: user.firebaseUid
        });

      } catch (e) {
        console.error('❌ customer:register error:', e);
        socket.emit('customer:registered', { success: false, error: e.message });
      }
    });

    // CUSTOMER REQUEST TRIP
    socket.on('customer:request_trip', async (payload) => {
      try {
        if (!validateTripPayload(payload)) {
          emitTripError({ socket, message: 'Invalid trip request payload.' });
          return;
        }

        const user = await resolveUserByIdOrPhone(payload.customerId);
        if (!user) {
          emitTripError({ socket, message: 'Customer not found in database.' });
          return;
        }

        payload.customerId = user._id.toString();

        const { type } = payload;
        let controllerFn;
        if (type === 'short') controllerFn = createShortTrip;
        else if (type === 'parcel') controllerFn = createParcelTrip;
        else if (type === 'long') controllerFn = createLongTrip;
        else {
          emitTripError({ socket, message: 'Unknown trip type.' });
          return;
        }

        const req = { body: payload };
        const res = {
          status: (code) => ({
            json: (data) => {
              socket.emit('trip:request_response', { ...data, status: code });
              if (data.success && data.tripId) {
                console.log(`🛣️ Trip request (${type}) created. TripId: ${data.tripId}`);
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

    // ✅ COMPLETE FIX: DRIVER ACCEPT TRIP with proper rollback
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        console.log('');
        console.log('='.repeat(70));
        console.log(`🚗 [SOCKET] Driver ${driverId} attempting to accept trip ${tripId}`);
        console.log('='.repeat(70));

        if (!driverId || !tripId) {
          socket.emit('trip:accept_failed', { 
            message: 'Missing driverId or tripId', 
            reason: 'invalid_request' 
          });
          return;
        }

        // ✅ ATOMIC STEP 1: Reserve driver (check availability + mark busy in ONE operation)
        const driver = await User.findOneAndUpdate(
          {
            _id: driverId,
            // ✅ Only update if driver is truly available
            $and: [
              {
                $or: [
                  { isBusy: { $ne: true } },
                  { isBusy: { $exists: false } }
                ]
              },
              {
                $or: [
                  { currentTripId: null },
                  { currentTripId: { $exists: false } }
                ]
              }
            ]
          },
          {
            $set: {
              isBusy: true,
              currentTripId: tripId,
              canReceiveNewRequests: false,
              lastTripAcceptedAt: new Date()
            }
          },
          {
            new: true,
            select: 'name phone photoUrl rating vehicleBrand vehicleNumber location'
          }
        ).lean();

        // ❌ Driver was already busy - ATOMIC REJECTION
        if (!driver) {
          console.log(`⚠️ Driver ${driverId} is already on another trip`);
          socket.emit('trip:accept_failed', { 
            message: 'You are already on another trip', 
            reason: 'driver_busy' 
          });
          return;
        }

        console.log(`✅ [SOCKET] Driver ${driverId} atomically reserved`);
        console.log(`   - isBusy: true`);
        console.log(`   - currentTripId: ${tripId}`);

        // ✅ ATOMIC STEP 2: Reserve trip (check status + cancellation + assign in ONE operation)
        const trip = await Trip.findOneAndUpdate(
          { 
            _id: tripId, 
            status: 'requested',
            // ✅ Ensure no cancellation in progress
            $and: [
              {
                $or: [
                  { cancelledAt: { $exists: false } },
                  { cancelledAt: null }
                ]
              },
              {
                $or: [
                  { cancelledBy: { $exists: false } },
                  { cancelledBy: null }
                ]
              }
            ]
          },
          {
            $set: {
              assignedDriver: driverId,
              status: 'driver_assigned',
              acceptedAt: new Date()
            }
          },
          { new: true }
        ).lean();

        // ❌ Trip already taken, cancelled, or not found - ROLLBACK DRIVER
        if (!trip) {
          console.log(`⚠️ Trip ${tripId} no longer available - ROLLING BACK DRIVER`);
          
          // ✅ CRITICAL: Rollback driver reservation
          await User.findByIdAndUpdate(driverId, {
            $set: { 
              isBusy: false, 
              currentTripId: null,
              canReceiveNewRequests: false
            }
          });
          
          console.log(`✅ Driver ${driverId} rolled back to available state`);
          
          socket.emit('trip:accept_failed', { 
            message: 'Trip no longer available (already accepted or cancelled)', 
            reason: 'trip_unavailable' 
          });
          return;
        }

        console.log(`✅ [SOCKET] Trip ${tripId} atomically assigned to driver ${driverId}`);
        console.log(`   - Status: driver_assigned`);

        // ✅ STEP 3: Get customer data
        const customer = await User.findById(trip.customerId)
          .select('name phone photoUrl rating socketId')
          .lean();

        if (!customer) {
          console.error(`❌ Customer not found for trip ${tripId} - ROLLING BACK`);
          
          // ✅ CRITICAL: Rollback both driver and trip
          await User.findByIdAndUpdate(driverId, {
            $set: { 
              isBusy: false, 
              currentTripId: null,
              canReceiveNewRequests: false
            }
          });
          
          await Trip.findByIdAndUpdate(tripId, {
            $unset: { assignedDriver: 1 },
            $set: { status: 'requested', acceptedAt: null }
          });
          
          console.log(`✅ Rollback complete: driver + trip reset`);
          
          socket.emit('trip:accept_failed', { 
            message: 'Customer not found', 
            reason: 'customer_missing' 
          });
          return;
        }

        // ✅ STEP 4: Generate OTP
        const { generateOTP } = await import('../utils/otpGeneration.js');
        const rideCode = generateOTP();
        
        await Trip.findByIdAndUpdate(tripId, { 
          $set: { otp: rideCode } 
        });

        console.log(`✅ OTP generated: ${rideCode}`);

        // ✅ STEP 5: Find customer's socket
        let customerSocketId = customer.socketId;
        
        if (!customerSocketId) {
          const customerIdStr = trip.customerId.toString();
          for (const [socketId, custId] of connectedCustomers.entries()) {
            if (custId === customerIdStr) {
              customerSocketId = socketId;
              break;
            }
          }
        }

        // ✅ STEP 6: Notify customer
        if (customerSocketId) {
          const payloadToCustomer = {
            tripId: tripId.toString(),
            rideCode,
            trip: {
              pickup: {
                lat: trip.pickup.coordinates[1],
                lng: trip.pickup.coordinates[0],
                address: trip.pickup.address || "Pickup Location",
              },
              drop: {
                lat: trip.drop.coordinates[1],
                lng: trip.drop.coordinates[0],
                address: trip.drop.address || "Drop Location",
              },
              fare: trip.fare || 0
            },
            driver: {
              id: driver._id.toString(),
              name: driver.name || 'Driver',
              phone: driver.phone || null,
              photoUrl: driver.photoUrl || null,
              rating: driver.rating || 4.8,
              vehicleBrand: driver.vehicleBrand || 'Vehicle',
              vehicleNumber: driver.vehicleNumber || 'N/A',
              location: driver.location ? {
                lat: driver.location.coordinates[1],
                lng: driver.location.coordinates[0],
              } : null,
            },
          };
          
          io.to(customerSocketId).emit('trip:accepted', payloadToCustomer);
          console.log(`✅ Customer notified via socket ${customerSocketId}`);
        } else {
          console.warn(`⚠️ Customer socket not found for ${customer.name}`);
        }

        // ✅ STEP 7: Confirm to driver
        const payloadToDriver = {
          tripId: tripId.toString(),
          rideCode,
          trip: {
            pickup: {
              lat: trip.pickup.coordinates[1],
              lng: trip.pickup.coordinates[0],
              address: trip.pickup.address || "Pickup Location",
            },
            drop: {
              lat: trip.drop.coordinates[1],
              lng: trip.drop.coordinates[0],
              address: trip.drop.address || "Drop Location",
            },
            fare: trip.fare || 0
          },
          customer: {
            id: customer._id.toString(),
            name: customer.name || 'Customer',
            phone: customer.phone || null,
            photoUrl: customer.photoUrl || null,
            rating: customer.rating || 5.0,
          }
        };
        
        socket.emit('trip:confirmed_for_driver', payloadToDriver);
        console.log(`✅ Driver confirmed`);

        // ✅ STEP 8: Notify other drivers
        const otherDrivers = await User.find({
          isDriver: true,
          isOnline: true,
          _id: { $ne: driverId },
          socketId: { $exists: true, $ne: null }
        }).select('socketId').lean();

        console.log(`📡 Notifying ${otherDrivers.length} other drivers`);

        otherDrivers.forEach(otherDriver => {
          if (otherDriver.socketId) {
            io.to(otherDriver.socketId).emit('trip:taken', {
              tripId,
              message: 'This trip has been accepted by another driver'
            });
          }
        });

        console.log('='.repeat(70));
        console.log(`✅ [SOCKET] SUCCESS: Trip accepted by ${driver.name}`);
        console.log('='.repeat(70));
        console.log('');

      } catch (e) {
        console.error('❌ driver:accept_trip error:', e);
        console.error(e.stack);
        
        // ✅ CRITICAL: Always rollback on error
        try {
          if (driverId) {
            console.log(`🔄 Attempting emergency rollback for driver ${driverId}`);
            
            await User.findByIdAndUpdate(driverId, {
              $set: { 
                isBusy: false, 
                currentTripId: null,
                canReceiveNewRequests: false
              }
            });
            
            console.log(`✅ Emergency rollback: driver ${driverId} freed`);
          }
          
          if (tripId) {
            console.log(`🔄 Attempting emergency rollback for trip ${tripId}`);
            
            await Trip.findByIdAndUpdate(tripId, {
              $unset: { assignedDriver: 1, otp: 1 },
              $set: { status: 'requested', acceptedAt: null }
            });
            
            console.log(`✅ Emergency rollback: trip ${tripId} reset`);
          }
        } catch (rollbackError) {
          console.error('❌ Emergency rollback failed:', rollbackError);
          console.error(rollbackError.stack);
        }
        
        socket.emit('trip:accept_failed', { 
          message: 'Failed to accept trip. Please try again.', 
          reason: 'server_error',
          error: process.env.NODE_ENV === 'development' ? e.message : undefined
        });
      }
    });

    // DRIVER START RIDE
    socket.on('driver:start_ride', async ({ tripId, driverId, otp, driverLat, driverLng }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip) {
          socket.emit('trip:start_error', { message: 'Trip not found' });
          return;
        }

        if (trip.otp !== otp) {
          socket.emit('trip:start_error', { message: 'Invalid OTP. Please check the code.' });
          return;
        }

        if (trip.status !== 'driver_assigned' && trip.status !== 'driver_at_pickup') {
          socket.emit('trip:start_error', { message: `Cannot start ride. Status is: ${trip.status}` });
          return;
        }

        await Trip.findByIdAndUpdate(tripId, { $set: { status: 'ride_started', rideStartTime: new Date() } });

        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }

        const rideStartedPayload = {
          tripId: tripId.toString(),
          message: 'Ride has started',
          timestamp: new Date().toISOString()
        };

        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:ride_started', rideStartedPayload);
        }

        socket.emit('trip:ride_started', { tripId: tripId.toString(), message: 'Ride started successfully', timestamp: new Date().toISOString() });

      } catch (e) {
        console.error('❌ driver:start_ride error:', e);
        socket.emit('trip:start_error', { message: 'Failed to start ride: ' + e.message });
      }
    });

    // DRIVER COMPLETE RIDE
   // Find and replace the driver:complete_ride handler in socketHandler.js

    // ✅ UPDATED: DRIVER COMPLETE RIDE WITH DISCOUNT INFO
    socket.on('driver:complete_ride', async ({ tripId, driverId, driverLat, driverLng }) => {
      try {
        const trip = await Trip.findById(tripId);
        if (!trip) {
          socket.emit('trip:complete_error', { message: 'Trip not found' });
          return;
        }

        if (trip.status !== 'ride_started') {
          socket.emit('trip:complete_error', { message: 'Ride has not started yet' });
          return;
        }

        const fare = trip.fare || trip.estimatedFare || 100;

        await Trip.findByIdAndUpdate(tripId, {
          $set: {
            status: 'completed',
            rideStatus: 'completed',
            rideEndTime: new Date(),
            endTime: new Date(),
            completedAt: new Date(),
            finalFare: fare,
            paymentCollected: false,
            paymentCollectedAt: null
          }
        });
        
        await User.findByIdAndUpdate(driverId, {
          $set: {
            currentTripId: tripId,
            isBusy: true,
            canReceiveNewRequests: false,
            awaitingCashCollection: true,
            lastTripCompletedAt: new Date()
          }
        });

        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }

        // ✅ UPDATED: Include discount info in completion payload
        const rideCompletedPayload = {
          tripId: tripId.toString(),
          fare,
          originalFare: trip.originalFare || null,
          discountApplied: trip.discountApplied || 0,
          coinsUsed: trip.coinsUsed || 0,
          message: 'Ride completed',
          timestamp: new Date().toISOString(),
          awaitingPayment: true
        };

        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:completed', rideCompletedPayload);
          console.log(`📢 Emitted trip:completed to customer with discount info`);
        }

        socket.emit('trip:completed', {
          ...rideCompletedPayload,
          message: 'Ride completed. Please collect ₹' + fare.toFixed(2) + ' from customer.',
          awaitingCashCollection: true
        });

        console.log(`✅ Ride ${tripId} completed via socket`);
        console.log(`   Fare: ₹${fare}`);
        console.log(`   Original Fare: ₹${trip.originalFare || 'N/A'}`);
        console.log(`   Discount: ₹${trip.discountApplied || 0}`);
        console.log(`   Coins Used: ${trip.coinsUsed || 0}`);

      } catch (e) {
        console.error('❌ driver:complete_ride error:', e);
        socket.emit('trip:complete_error', { message: 'Failed to complete ride: ' + e.message });
      }
    }); // DRIVER GOING TO PICKUP
    socket.on('driver:going_to_pickup', async ({ tripId, driverId }) => {
      try {
        await Trip.findByIdAndUpdate(tripId, { $set: { status: 'driver_going_to_pickup' } });
        const trip = await Trip.findById(tripId).lean();
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }
        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:driver_going_to_pickup', { tripId: tripId.toString(), message: 'Driver is on the way to pickup' });
        }
        socket.emit('trip:status_updated', { success: true });
      } catch (e) {
        console.error('❌ driver:going_to_pickup error:', e);
      }
    });

    // DRIVER ARRIVED AT PICKUP
    socket.on('trip:arrived_at_pickup', async ({ tripId, driverId }) => {
      try {
        await Trip.findByIdAndUpdate(tripId, { $set: { status: 'driver_at_pickup' } });
        const trip = await Trip.findById(tripId).lean();
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }
        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:driver_arrived', { tripId: tripId.toString(), message: 'Driver has arrived at pickup location' });
        }
        socket.emit('trip:status_updated', { success: true });
      } catch (e) {
        console.error('❌ trip:arrived_at_pickup error:', e);
      }
    });

    // ✅ ENHANCED: DRIVER LOCATION UPDATE WITH SEQUENCE TRACKING
socket.on('driver:location', async ({ tripId, driverId, latitude, longitude, sequence, timestamp }) => {
      try {
        if (!tripId || !driverId || !latitude || !longitude) {
          console.warn('⚠️ Missing required location data');
          return;
        }

        // ✅ Get current driver state
        const driver = await User.findById(driverId).select('locationSequence').lean();
        if (!driver) {
          console.warn(`⚠️ Driver not found: ${driverId}`);
          return;
        }

        // ✅ ATOMIC UPDATE: Only if sequence is newer
// âœ… ATOMIC UPDATE: Only if timestamp is newer
const updateQuery = {
  _id: driverId
};

if (timestamp) {
  const clientTime = new Date(timestamp);
  updateQuery.$or = [
    { lastLocationUpdate: { $lt: clientTime } },
    { lastLocationUpdate: { $exists: false } }
  ];
}
        const updateData = {
          $set: {
            location: { 
              type: 'Point', 
              coordinates: [longitude, latitude] 
            },
            updatedAt: new Date()
          }
        };

        if (typeof sequence === 'number') {
          updateData.$set.locationSequence = sequence;
        }
        if (timestamp) {
          updateData.$set.lastLocationUpdate = new Date(timestamp);
        }

        const result = await User.findOneAndUpdate(
          updateQuery,
          updateData,
          { new: true, select: 'locationSequence lastLocationUpdate' }
        );

        // ❌ Out-of-order update - ignore
     // âŒ Out-of-order update - ignore
if (!result && timestamp) {
  console.log(`âš ï¸ Ignored out-of-order location update for driver ${driverId} (timestamp ${timestamp})`);
  return;
}

        // ✅ Calculate distance to destination
        const trip = await Trip.findById(tripId).lean();
        if (!trip) return;

        const dropLat = trip.drop.coordinates[1];
        const dropLng = trip.drop.coordinates[0];
        const distance = calculateDistance(latitude, longitude, dropLat, dropLng);
        const distanceInMeters = distance * 1000;

        // ✅ Update canReceiveNewRequests based on proximity
        if (distanceInMeters <= 500 && trip.status === 'ride_started') {
          await User.findByIdAndUpdate(driverId, { $set: { canReceiveNewRequests: true } });
        } else {
          await User.findByIdAndUpdate(driverId, { $set: { canReceiveNewRequests: false } });
        }

        // ✅ Broadcast to customer
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;
        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            break;
          }
        }

        if (customerSocketId) {
          io.to(customerSocketId).emit('driver:locationUpdate', {
            tripId: tripId.toString(),
            driverId,
            latitude,
            longitude,
            distanceToDestination: Math.round(distanceInMeters),
            sequence: result?.locationSequence,
            timestamp: result?.lastLocationUpdate || new Date().toISOString()
          });
        }

      } catch (e) {
        console.error('❌ driver:location error:', e);
      }
    });

    // ✅ NEW: CUSTOMER LOCATION UPDATE WITH SEQUENCE TRACKING
    socket.on('customer:location', async ({ tripId, customerId, latitude, longitude, sequence, timestamp }) => {
      try {
        if (!tripId || !customerId || !latitude || !longitude) {
          console.warn('⚠️ Missing required location data');
          return;
        }

        console.log(`📍 Customer ${customerId} location update (seq ${sequence || 'N/A'})`);

        // ✅ ATOMIC UPDATE: Only if sequence is newer
        const updateQuery = {
          _id: customerId
        };

        if (typeof sequence === 'number') {
          updateQuery.$or = [
            { locationSequence: { $lt: sequence } },
            { locationSequence: { $exists: false } }
          ];
        }

        const updateData = {
          $set: {
            location: { 
              type: 'Point', 
              coordinates: [longitude, latitude] 
            },
            updatedAt: new Date()
          }
        };

        if (typeof sequence === 'number') {
          updateData.$set.locationSequence = sequence;
        }
        if (timestamp) {
          updateData.$set.lastLocationUpdate = new Date(timestamp);
        }

        const result = await User.findOneAndUpdate(
          updateQuery,
          updateData,
          { new: true, select: 'locationSequence lastLocationUpdate' }
        );

        // ❌ Out-of-order update - ignore
        if (!result && typeof sequence === 'number') {
          console.log(`⚠️ Ignored out-of-order location update for customer ${customerId} (seq ${sequence})`);
          return;
        }

        console.log(`✅ Customer location updated (seq ${result?.locationSequence})`);

        // ✅ Broadcast to driver
        const trip = await Trip.findById(tripId).lean();
        if (trip && trip.assignedDriver) {
          const driver = await User.findById(trip.assignedDriver).select('socketId').lean();
          if (driver?.socketId) {
            io.to(driver.socketId).emit('customer:locationUpdate', {
              tripId: tripId.toString(),
              customerId,
              latitude,
              longitude,
              sequence: result?.locationSequence,
              timestamp: result?.lastLocationUpdate || new Date().toISOString()
            });
            console.log(`📡 Customer location sent to driver ${trip.assignedDriver}`);
          }
        }

      } catch (e) {
        console.error('❌ customer:location error:', e);
      }
    });

    // DRIVER HEARTBEAT
    socket.on('driver:heartbeat', async ({ tripId, driverId, timestamp }) => {
      try {
        if (!tripId || !driverId) return;
        await Trip.findByIdAndUpdate(tripId, { $set: { lastDriverHeartbeat: new Date(timestamp) } });
      } catch (e) {
        console.error('❌ driver:heartbeat error:', e);
      }
    });

    // CHAT: JOIN
    socket.on('chat:join', (data) => {
      try {
        const { tripId, userId } = data;
        if (!tripId) return;
        const roomName = `chat_${tripId}`;
        socket.join(roomName);
        socket.to(roomName).emit('chat:user_joined', { userId, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ Error in chat:join:', error);
      }
    });

    // CHAT: LEAVE
    socket.on('chat:leave', (data) => {
      try {
        const { tripId, userId } = data;
        if (!tripId) return;
        const roomName = `chat_${tripId}`;
        socket.leave(roomName);
        socket.to(roomName).emit('chat:user_left', { userId, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ Error in chat:leave:', error);
      }
    });

    // CHAT: SEND MESSAGE
    socket.on('chat:send_message', async (data) => {
      try {
        const { tripId, fromId, toId, message, timestamp } = data;
        if (!tripId || !fromId || !toId || !message) {
          socket.emit('chat:error', { error: 'Missing required fields' });
          return;
        }

        try {
          const chatMessage = new ChatMessage({
            tripId,
            senderId: fromId,
            receiverId: toId,
            message,
            timestamp: timestamp ? new Date(timestamp) : new Date()
          });
          await chatMessage.save();
        } catch (dbError) {
          console.warn('⚠️ Failed to save chat message:', dbError);
        }

        const messageData = {
          tripId,
          fromId,
          toId,
          senderId: fromId,
          receiverId: toId,
          message,
          timestamp: timestamp || new Date().toISOString()
        };

        const roomName = `chat_${tripId}`;
        socket.to(roomName).emit('chat:receive_message', messageData);
        socket.to(roomName).emit('chat:new_message', messageData);
        socket.emit('chat:message_sent', { success: true, timestamp: messageData.timestamp });

        let recipientSocketId = null;
        for (const [socketId, userId] of connectedCustomers.entries()) {
          if (userId === toId) { recipientSocketId = socketId; break; }
        }
        if (!recipientSocketId) {
          for (const [socketId, userId] of connectedDrivers.entries()) {
            if (userId === toId) { recipientSocketId = socketId; break; }
          }
        }
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('chat:receive_message', messageData);
          io.to(recipientSocketId).emit('chat:new_message', messageData);
          io.to(recipientSocketId).emit('chat:notification', { tripId, fromId, message: message.substring(0, 50), timestamp: messageData.timestamp });
        }

      } catch (error) {
        console.error('❌ Error in chat:send_message:', error);
        socket.emit('chat:error', { error: 'Failed to send message', details: error.message });
      }
    });

    // CHAT: TYPING
    socket.on('chat:typing', (data) => {
      try {
        const { tripId, userId, isTyping } = data;
        if (!tripId) return;
        const roomName = `chat_${tripId}`;
        socket.to(roomName).emit('chat:typing_status', { userId, isTyping, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ Error in chat:typing:', error);
      }
    });

    // CHAT: MARK READ
    socket.on('chat:mark_read', async (data) => {
      try {
        const { tripId, userId } = data;
        if (!tripId || !userId) return;
        await ChatMessage.updateMany({ tripId, receiverId: userId, read: false }, { $set: { read: true } });
        const roomName = `chat_${tripId}`;
        socket.to(roomName).emit('chat:messages_read', { userId, tripId, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ Error in chat:mark_read:', error);
      }
    });

    // CHAT: GET UNREAD
    socket.on('chat:get_unread', async (data) => {
      try {
        const { userId } = data;
        if (!userId) return;
        const unreadCount = await ChatMessage.countDocuments({ receiverId: userId, read: false });
        socket.emit('chat:unread_count', { userId, count: unreadCount, timestamp: new Date().toISOString() });
      } catch (error) {
        console.error('❌ Error in chat:get_unread:', error);
      }
    });

    // DRIVER GO OFFLINE
    socket.on('driver:go_offline', async ({ driverId }) => {
      try {
        const driver = await User.findById(driverId).select('currentTripId isBusy name').lean();
        if (!driver) return;
        if (driver.currentTripId || driver.isBusy) {
          socket.emit('driver:offline_blocked', { success: false, message: 'Cannot go offline during active trip', currentTripId: driver.currentTripId });
          return;
        }
        await User.findByIdAndUpdate(driverId, { $set: { isOnline: false, socketId: null, canReceiveNewRequests: false } });
        connectedDrivers.delete(socket.id);
        socket.disconnect(true);
      } catch (e) {
        console.error('❌ driver:go_offline error:', e);
      }
    });

    // DISCONNECT HANDLER
    socket.on('disconnect', async () => {
      try {
        const driverId = connectedDrivers.get(socket.id);
        const customerId = connectedCustomers.get(socket.id);

        if (driverId) {
          const driver = await User.findById(driverId).select('currentTripId isBusy isOnline name phone awaitingCashCollection').lean();
          if (!driver) {
            connectedDrivers.delete(socket.id);
            return;
          }

          let hasRealActiveTrip = false;

          if (driver.currentTripId) {
            const trip = await Trip.findById(driver.currentTripId).select('status paymentCollected').lean();
            if (trip) {
              const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
              hasRealActiveTrip = activeStatuses.includes(trip.status) || (trip.status === 'completed' && trip.paymentCollected !== true);
              if (trip.paymentCollected === true) {
                hasRealActiveTrip = false;
              }
            } else {
              hasRealActiveTrip = false;
            }
          }

          if (hasRealActiveTrip) {
  await User.findByIdAndUpdate(driverId, { 
    $set: { 
      socketId: null, 
      lastDisconnectedAt: new Date() 
    } 
  });
} else {
  await User.findByIdAndUpdate(driverId, {
    $set: {
      isOnline: false,
      isBusy: false,
      socketId: null,
      currentTripId: null,
      canReceiveNewRequests: false,
      awaitingCashCollection: false,
      lastDisconnectedAt: new Date()
    },
    $unset: {
      lastLocationUpdate: "" // ✅ ADD THIS - Clear stale location timestamp
    }
  }, { new: true });
            const verify = await User.findById(driverId).select('isBusy currentTripId awaitingCashCollection').lean();
            if (verify && (verify.isBusy || verify.currentTripId || verify.awaitingCashCollection)) {
              await User.updateOne({ _id: driverId }, { $set: { isBusy: false, currentTripId: null, awaitingCashCollection: false, isOnline: false } });
            }
          }

          connectedDrivers.delete(socket.id);
        }

        if (customerId) {
          connectedCustomers.delete(socket.id);
          await User.findByIdAndUpdate(customerId, { $set: { socketId: null, lastDisconnectedAt: new Date() } });
        }

      } catch (e) {
        console.error('❌ disconnect cleanup error:', e);
      }
    });
    // TRIP RETRY REQUEST
socket.on('trip:rerequest', async ({ tripId, customerId, vehicleType, retryAttempt }) => {
  try {
    console.log('');
    console.log('🔄 ═══════════════════════════════════════════════');
    console.log(`🔄 RETRY REQUEST #${retryAttempt}`);
    console.log(`   Trip ID: ${tripId}`);
    console.log('🔄 ═══════════════════════════════════════════════');

    if (!tripId) return;

    const trip = await Trip.findById(tripId).lean();
    
    if (!trip) {
      socket.emit('trip:rerequest_failed', {
        message: 'Trip not found',
        shouldCancelSearch: true
      });
      return;
    }

    if (trip.status !== 'requested') {
      console.log(`ℹ️ Trip already ${trip.status} - no retry needed`);
      return;
    }

    const nearbyDrivers = await User.find({
      isDriver: true,
      vehicleType: vehicleType,
      isOnline: true,
      isBusy: { $ne: true },
      $or: [
        { currentTripId: null },
        { currentTripId: { $exists: false } }
      ],
      location: {
        $near: {
          $geometry: { 
            type: 'Point', 
            coordinates: trip.pickup.coordinates 
          },
          $maxDistance: DISTANCE_LIMITS.short || 5000,
        },
      },
    })
    .select('name phone vehicleType location isOnline socketId fcmToken')
    .lean();

    console.log(`🔍 Found ${nearbyDrivers.length} available drivers for retry`);

    if (nearbyDrivers.length === 0) return;

    const payload = {
      tripId: trip._id.toString(),
      type: trip.type,
      vehicleType: vehicleType,
      customerId: customerId,
      pickup: {
        lat: trip.pickup.coordinates[1],
        lng: trip.pickup.coordinates[0],
        address: trip.pickup.address || "Pickup Location",
      },
      drop: {
        lat: trip.drop.coordinates[1],
        lng: trip.drop.coordinates[0],
        address: trip.drop.address || "Drop Location",
      },
      fare: trip.fare || 0,
      retryAttempt: retryAttempt,
      isRetry: true
    };

    broadcastToDrivers(nearbyDrivers, payload);

    console.log(`✅ Retry #${retryAttempt} broadcasted to ${nearbyDrivers.length} drivers`);
    console.log('');

  } catch (e) {
    console.error('❌ trip:rerequest error:', e);
  }
});

    // AUTO-CLEANUP EXPIRED TRIPS
  // AUTO-CLEANUP EXPIRED TRIPS - 60 second timeout
setInterval(async () => {
  try {
    const now = new Date();
    
    // Find trips older than 60 seconds
    const expiredTrips = await Trip.find({
      status: 'requested',
      createdAt: { $lt: new Date(now.getTime() - TRIP_TIMEOUT_MS) }
    });

    if (!expiredTrips.length) return;

    console.log(`🧹 Found ${expiredTrips.length} expired trips (>60s old)`);

    for (const trip of expiredTrips) {
      const tripAge = Math.round((now - trip.createdAt) / 1000);
      console.log(`   ⏰ Trip ${trip._id}: ${tripAge}s old - timing out`);

      await Trip.findByIdAndUpdate(trip._id, { 
        $set: { 
          status: 'timeout',
          timeoutAt: new Date(),
          timeoutReason: 'No driver accepted within 60 seconds'
        } 
      });

      const customer = await User.findById(trip.customerId).select('socketId').lean();
      if (customer?.socketId) {
        io.to(customer.socketId).emit('trip:timeout', {
          tripId: trip._id.toString(),
          message: 'No drivers available right now. Please try again.',
          reason: 'timeout',
          duration: tripAge
        });
      }

      const onlineDrivers = await User.find({
        isDriver: true,
        isOnline: true,
        socketId: { $exists: true, $ne: null }
      }).select('socketId').lean();

      onlineDrivers.forEach(driver => {
        if (driver.socketId) {
          io.to(driver.socketId).emit('trip:expired', {
            tripId: trip._id.toString(),
            message: 'This request has expired'
          });
        }
      });
    }
  } catch (e) {
    console.error('❌ Cleanup job error:', e);
  }
}, 10000); // Check every 10 seconds

    console.log('⏰ Trip cleanup job started');
    startNotificationRetryJob();
    startStaleTripCleanup();
    console.log('🚀 Socket.IO initialized');
  });
};

export { io, connectedDrivers, connectedCustomers };