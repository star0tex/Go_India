// src/socket/socketHandler.js
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { startNotificationRetryJob } from '../utils/notificationRetry.js';
import { startStaleTripCleanup } from '../utils/staleTripsCleanup.js';
import { sendToDriver } from '../utils/fcmSender.js';
import { promoteNextStandby, reassignStandbyDriver } from '../controllers/standbyController.js';
import {
  createShortTrip,
  createParcelTrip,
  createLongTrip,
} from '../controllers/tripController.js';
import { emitTripError } from '../utils/errorEmitter.js';

let io;

const connectedDrivers = new Map(); // socketId => MongoDB _id
const connectedCustomers = new Map(); // socketId => MongoDB _id

const DISTANCE_LIMITS = {
  short: 5000,
  parcel: 5000,
  long_same_day: 20000,
  long_multi_day: 50000,
};

/**
 * Resolve user by MongoDB _id, Firebase UID, or phone number
 * Always returns the user with MongoDB _id
 */
const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  
  try {
    // Try MongoDB ObjectId format
    if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
      const byId = await User.findById(idOrPhone);
      if (byId) return byId;
    }
    
    // Try Firebase UID
    const byFirebaseUid = await User.findOne({ firebaseUid: idOrPhone });
    if (byFirebaseUid) return byFirebaseUid;
    
    // Try phone number (normalize it)
    const normalizedPhone = String(idOrPhone).replace(/[^0-9]/g, "");
    const byPhone = await User.findOne({ phone: normalizedPhone });
    if (byPhone) return byPhone;
    
    return null;
  } catch (err) {
    console.error('❌ resolveUserByIdOrPhone error:', err);
    return null;
  }
};

const validateTripPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { type, customerId, pickup, drop } = payload;
  if (!type || !customerId || !pickup || !drop) return false;
  if (!pickup.coordinates || !Array.isArray(pickup.coordinates) || pickup.coordinates.length !== 2) return false;
  if (!drop.coordinates || !Array.isArray(drop.coordinates) || drop.coordinates.length !== 2) return false;
  return true;
};

const normalizePhone = (phone) => {
  if (!phone) return null;
  return String(phone).replace(/[^0-9]/g, "");
};

// ✅ Helper functions for distance calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

function toRad(value) {
  return value * Math.PI / 180;
}

/**
 * Initialize socket.io handlers
 */
export const initSocket = (ioInstance) => {
  io = ioInstance;

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // ========================================
    // 🔹 DRIVER STATUS UPDATE
    // ========================================
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
        };

        if (location?.coordinates?.length === 2) {
          set.location = { type: 'Point', coordinates: location.coordinates };
        } else if (
          typeof lat === 'number' &&
          typeof lng === 'number' &&
          !Number.isNaN(lat) &&
          !Number.isNaN(lng)
        ) {
          set.location = { type: 'Point', coordinates: [lng, lat] };
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

    // ========================================
    // 🔹 DRIVER RECONNECT WITH ACTIVE TRIP
    // ========================================
    socket.on('driver:reconnect_with_trip', async ({ driverId, tripId }) => {
      try {
        console.log('');
        console.log('='.repeat(70));
        console.log('🔄 DRIVER RECONNECTING WITH ACTIVE TRIP');
        console.log(`   Driver ID: ${driverId}`);
        console.log(`   Trip ID: ${tripId}`);
        console.log('='.repeat(70));
        
        // Verify driver
        const driver = await User.findById(driverId).lean();
        if (!driver) {
          console.log('❌ Driver not found');
          socket.emit('reconnect:failed', {
            message: 'Driver not found'
          });
          return;
        }
        
        // Verify trip is still active
        const trip = await Trip.findById(tripId).lean();
        if (!trip) {
          console.log('❌ Trip not found');
          socket.emit('reconnect:failed', {
            message: 'Trip not found',
            shouldClearTrip: true
          });
          return;
        }
        
        // Check if trip is still in progress
        const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
        if (!activeStatuses.includes(trip.status)) {
          console.log(`⚠️ Trip status is: ${trip.status} - not active`);
          socket.emit('reconnect:failed', {
            message: `Trip is ${trip.status}`,
            shouldClearTrip: true,
            tripStatus: trip.status
          });
          return;
        }
        
        // Update driver socket ID
        await User.findByIdAndUpdate(driverId, {
          $set: { socketId: socket.id }
        });
        
        // Re-map socket connection
        connectedDrivers.set(socket.id, driverId.toString());
        
        console.log('✅ Driver reconnected successfully');
        console.log(`   Trip Status: ${trip.status}`);
        console.log(`   OTP: ${trip.otp}`);
        
        // Send trip details back to driver
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
        
        console.log('📢 Sent reconnect:success to driver');
        console.log('='.repeat(70));
        console.log('');
        
      } catch (e) {
        console.error('❌ driver:reconnect_with_trip error:', e);
        socket.emit('reconnect:failed', {
          message: 'Reconnection failed',
          error: e.message
        });
      }
    });

    // ========================================
    // 🔹 CUSTOMER REGISTER
    // ========================================
    socket.on('customer:register', async ({ customerId }) => {
      try {
        if (!customerId) {
          console.warn('⚠️ customer:register - customerId missing');
          socket.emit('customer:registered', { 
            success: false, 
            error: 'customerId missing' 
          });
          return;
        }

        console.log(`👤 Customer register request: ${customerId} on socket: ${socket.id}`);

        // Resolve user by MongoDB _id, Firebase UID, or phone
        const user = await resolveUserByIdOrPhone(customerId);

        if (!user) {
          console.warn(`❌ customer:register - user not found for ${customerId}`);
          
          // Log what we tried to search with
          console.log(`🔍 Searched with: ${customerId}`);
          console.log(`🔍 Format check - MongoDB ID: ${/^[0-9a-fA-F]{24}$/.test(customerId)}`);
          console.log(`🔍 Format check - Phone-like: ${/^\d{10}$/.test(customerId)}`);
          
          socket.emit('customer:registered', {
            success: false,
            error: 'User not found in database',
            providedId: customerId,
            hint: 'Make sure you are passing MongoDB _id from login response'
          });
          return;
        }

        // Clean up any old socket entries for this customer
        let removedOldSockets = 0;
        for (const [existingSocketId, existingCustomerId] of connectedCustomers.entries()) {
          if (existingCustomerId === user._id.toString()) {
            console.log(`🗑️ Removing old socket entry: ${existingSocketId}`);
            connectedCustomers.delete(existingSocketId);
            removedOldSockets++;
          }
        }

        if (removedOldSockets > 0) {
          console.log(`🧹 Cleaned up ${removedOldSockets} old socket(s) for customer ${user._id}`);
        }

        // Update socketId in database
        try {
          await User.findByIdAndUpdate(
            user._id, 
            { $set: { socketId: socket.id } },
            { new: true }
          );
          console.log(`💾 Updated socketId in DB for customer ${user._id}`);
        } catch (dbError) {
          console.error('❌ Database update error:', dbError);
          // Continue anyway, socket mapping is more important
        }

        // Map socket to MongoDB _id (not Firebase UID!)
        connectedCustomers.set(socket.id, user._id.toString());

        console.log(`✅ Customer registered successfully:`);
        console.log(`   - MongoDB _id: ${user._id}`);
        console.log(`   - Phone: ${user.phone}`);
        console.log(`   - Firebase UID: ${user.firebaseUid || 'none'}`);
        console.log(`   - Socket ID: ${socket.id}`);
        console.log(`   - Total connected customers: ${connectedCustomers.size}`);

        // Send confirmation with complete data
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
        console.error('Stack trace:', e.stack);
        socket.emit('customer:registered', { 
          success: false, 
          error: e.message,
          stack: process.env.NODE_ENV === 'development' ? e.stack : undefined
        });
      }
    });

    // ========================================
    // 🔹 CUSTOMER REQUEST TRIP
    // ========================================
    socket.on('customer:request_trip', async (payload) => {
      try {
        if (!validateTripPayload(payload)) {
          emitTripError({ socket, message: 'Invalid trip request payload.' });
          return;
        }

        // Resolve customerId to MongoDB _id
        const user = await resolveUserByIdOrPhone(payload.customerId);
        if (!user) {
          emitTripError({ socket, message: 'Customer not found in database.' });
          return;
        }

        // Replace customerId with MongoDB _id
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

    // ========================================
    // 🔹 DRIVER ACCEPT TRIP (UPDATED WITH ATOMIC CHECK)
    // ========================================
    socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
      try {
        console.log('');
        console.log('='.repeat(70));
        console.log(`🚗 Driver ${driverId} attempting to accept trip ${tripId}`);
        console.log('='.repeat(70));

        // ✅ STEP 1: ATOMIC CHECK + LOCK
        const driver = await User.findOneAndUpdate(
          { 
            _id: driverId,
            $or: [
              { isBusy: { $ne: true } },
              { isBusy: { $exists: false } }
            ],
            $or: [
              { currentTripId: { $exists: false } },
              { currentTripId: null }
            ]
          },
          { 
            $set: { 
              isBusy: true,
              currentTripId: tripId,
              lastTripAcceptedAt: new Date()
            }
          },
          { 
            new: true,
            select: 'name phone photoUrl rating vehicleBrand vehicleNumber location isBusy currentTripId'
          }
        ).lean();
        
        if (!driver) {
          console.log('');
          console.log('⚠️ DRIVER ALREADY BUSY OR NOT FOUND');
          console.log('');
          socket.emit('trip:accept_failed', {
            message: 'You are already on another trip or cannot accept this trip',
            reason: 'driver_busy'
          });
          return;
        }

        console.log('');
        console.log('✅ DRIVER STATE LOCKED ATOMICALLY');
        console.log(`   isBusy: ${driver.isBusy}`);
        console.log(`   currentTripId: ${driver.currentTripId}`);
        console.log('');

        // ✅ STEP 2: Check trip availability
        const trip = await Trip.findOneAndUpdate(
          { _id: tripId, status: 'requested' },
          { 
            $set: { 
              assignedDriver: driverId, 
              status: 'driver_assigned',
              acceptedAt: new Date()
            }
          },
          { new: true }
        ).lean();
        
        if (!trip) {
          console.log('');
          console.log('⚠️ Trip not available - rolling back driver state');
          console.log('');
          
          // ✅ ROLLBACK driver state
          await User.findByIdAndUpdate(driverId, {
            $set: {
              isBusy: false,
              currentTripId: null
            }
          });
          
          socket.emit('trip:accept_failed', {
            message: 'Trip no longer available',
            reason: 'trip_taken'
          });
          return;
        }

        const customer = await User.findById(trip.customerId)
          .select('name phone photoUrl rating')
          .lean();
        
        if (!customer) {
          console.log('❌ Customer not found');
          
          // Rollback
          await User.findByIdAndUpdate(driverId, {
            $set: { isBusy: false, currentTripId: null }
          });
          await Trip.findByIdAndUpdate(tripId, {
            $unset: { assignedDriver: 1 },
            $set: { status: 'requested', acceptedAt: null }
          });
          
          emitTripError({ socket, tripId, message: 'Customer for this trip not found' });
          return;
        }

        // ✅ STEP 3: Generate OTP
        const { generateOTP } = await import('../utils/otpGeneration.js');
        const rideCode = generateOTP();
        console.log(`🎲 Generated OTP: ${rideCode}`);

        // ✅ STEP 4: Update trip with OTP
        await Trip.findByIdAndUpdate(tripId, {
          $set: { otp: rideCode }
        });

        console.log(`✅ Trip ${tripId} assigned to driver with OTP`);

        // ✅ STEP 5: Find customer socket
        let customerSocketId = null;
        const customerIdStr = trip.customerId.toString();

        for (const [socketId, custId] of connectedCustomers.entries()) {
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            console.log(`✅ Found customer socket: ${socketId}`);
            break;
          }
        }

        // ✅ STEP 6: Emit to customer
        if (customerSocketId) {
          const payloadToCustomer = {
            tripId: tripId.toString(),
            rideCode: rideCode,
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
            },
            driver: {
              id: driver._id.toString(),
              name: driver.name || 'Driver',
              phone: driver.phone || null,
              photoUrl: driver.photoUrl || null,
              rating: driver.rating || 4.8,
              vehicleBrand: driver.vehicleBrand || 'Vehicle',
              vehicleNumber: driver.vehicleNumber || 'N/A',
              location: {
                lat: driver.location.coordinates[1],
                lng: driver.location.coordinates[0],
              },
            },
          };

          io.to(customerSocketId).emit('trip:accepted', payloadToCustomer);
          console.log(`📢 trip:accepted emitted to customer with OTP: ${rideCode}`);
        } else {
          console.log(`⚠️ No socket found for customer ${customerIdStr}`);
        }

        // ✅ STEP 7: Emit to driver
        const payloadToDriver = {
          tripId: tripId.toString(),
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
        console.log(`📢 trip:confirmed_for_driver emitted to driver`);

        // ✅ STEP 8: Notify other drivers this trip is taken
        const otherDrivers = await User.find({
          isDriver: true,
          isOnline: true,
          _id: { $ne: driverId },
          socketId: { $exists: true, $ne: null }
        }).select('socketId').lean();

        console.log(`🚫 Notifying ${otherDrivers.length} other drivers`);

        otherDrivers.forEach(otherDriver => {
          if (otherDriver.socketId) {
            io.to(otherDriver.socketId).emit('trip:taken', {
              tripId: tripId,
              message: 'This trip has been accepted by another driver'
            });
          }
        });

        console.log('='.repeat(70));
        console.log(`✅ SUCCESS: Trip accepted by ${driver.name}`);
        console.log('='.repeat(70));
        console.log('');

      } catch (e) {
        console.error('❌ driver:accept_trip error:', e);
        console.error('Stack:', e.stack);
        
        // ✅ ROLLBACK on error
        try {
          await User.findByIdAndUpdate(driverId, {
            $set: {
              isBusy: false,
              currentTripId: null
            }
          });
          console.log('✅ Rolled back driver state due to error');
        } catch (rollbackError) {
          console.error('❌ Rollback failed:', rollbackError);
        }
        
        emitTripError({ socket, tripId, message: 'Failed to accept trip.' });
      }
    });

    // ========================================
    // 🔹 DRIVER START RIDE (OTP VERIFICATION)
    // ========================================
    socket.on('driver:start_ride', async ({ tripId, driverId, otp, driverLat, driverLng }) => {
      console.log('');
      console.log('='.repeat(70));
      console.log('🚗 DRIVER START RIDE EVENT RECEIVED');
      console.log(`   Trip ID: ${tripId}`);
      console.log(`   Driver ID: ${driverId}`);
      console.log(`   OTP: ${otp}`);
      console.log(`   Driver Location: ${driverLat}, ${driverLng}`);
      console.log('='.repeat(70));
      console.log('');

      try {
        const trip = await Trip.findById(tripId);
        if (!trip) {
          console.log('❌ Trip not found');
          socket.emit('trip:start_error', { message: 'Trip not found' });
          return;
        }

        console.log(`📋 Trip found with status: ${trip.status}`);
        console.log(`🔐 Stored OTP: ${trip.otp}, Provided OTP: ${otp}`);

        // Verify OTP
        if (trip.otp !== otp) {
          console.log(`❌ Invalid OTP. Expected: ${trip.otp}, Got: ${otp}`);
          socket.emit('trip:start_error', { message: 'Invalid OTP. Please check the code.' });
          return;
        }

        // Verify trip status
        if (trip.status !== 'driver_assigned' && trip.status !== 'driver_at_pickup') {
          console.log(`❌ Invalid trip status: ${trip.status}`);
          socket.emit('trip:start_error', { message: `Cannot start ride. Status is: ${trip.status}` });
          return;
        }

        // Update trip status to ride_started
        await Trip.findByIdAndUpdate(tripId, {
          $set: { 
            status: 'ride_started',
            rideStartTime: new Date()
          }
        });

        console.log(`✅ Trip ${tripId} status updated to ride_started`);

        // Find customer socket
        const customerIdStr = trip.customerId.toString();
        let customerSocketId = null;

        console.log(`🔍 Looking for customer socket: ${customerIdStr}`);
        console.log(`📊 Total connected customers: ${connectedCustomers.size}`);

        for (const [socketId, custId] of connectedCustomers.entries()) {
          console.log(`   Checking: ${custId} === ${customerIdStr}? ${custId === customerIdStr}`);
          if (custId === customerIdStr) {
            customerSocketId = socketId;
            console.log(`✅ Found customer socket: ${socketId}`);
            break;
          }
        }

        // Prepare the payload
        const rideStartedPayload = {
          tripId: tripId.toString(),
          message: 'Ride has started',
          timestamp: new Date().toISOString()
        };

        // Emit to customer
        if (customerSocketId) {
          io.to(customerSocketId).emit('trip:ride_started', rideStartedPayload);
          console.log('');
          console.log('📢 ✅ EMITTED trip:ride_started TO CUSTOMER');
          console.log(`   Socket ID: ${customerSocketId}`);
          console.log(`   Payload:`, rideStartedPayload);
          console.log('');
        } else {
          console.log('');
          console.log('⚠️ WARNING: No socket found for customer');
          console.log(`   Customer ID: ${customerIdStr}`);
          console.log(`   Connected customers:`, Array.from(connectedCustomers.entries()));
          console.log('');
        }

        // Confirm to driver
        socket.emit('trip:ride_started', {
          tripId: tripId.toString(),
          message: 'Ride started successfully',
          timestamp: new Date().toISOString()
        });
        console.log(`📢 ✅ Confirmed trip:ride_started to driver ${driverId}`);

        console.log('='.repeat(70));
        console.log('');

      } catch (e) {
        console.error('❌ driver:start_ride error:', e);
        console.error('Stack:', e.stack);
        socket.emit('trip:start_error', { message: 'Failed to start ride: ' + e.message });
      }
    });

    // ========================================
    // 🔹 DRIVER COMPLETE RIDE (UPDATED - CLEARS DRIVER STATE)
    // ========================================
    // ✅ REPLACE socket.on('driver:complete_ride') in socketHandler.js

socket.on('driver:complete_ride', async ({ tripId, driverId, driverLat, driverLng }) => {
  console.log('');
  console.log('='.repeat(70));
  console.log('🏁 DRIVER COMPLETE RIDE EVENT RECEIVED');
  console.log(`   Trip ID: ${tripId}`);
  console.log(`   Driver ID: ${driverId}`);
  console.log(`   Driver Location: ${driverLat}, ${driverLng}`);
  console.log('='.repeat(70));
  console.log('');

  try {
    const trip = await Trip.findById(tripId);
    if (!trip) {
      console.log('❌ Trip not found');
      socket.emit('trip:complete_error', { message: 'Trip not found' });
      return;
    }

    console.log(`📋 Trip found with status: ${trip.status}`);

    if (trip.status !== 'ride_started') {
      console.log(`❌ Invalid trip status: ${trip.status}`);
      socket.emit('trip:complete_error', { message: 'Ride has not started yet' });
      return;
    }

    // Calculate fare
    const fare = trip.estimatedFare || trip.fare || 100;

    // ✅ Update trip status to completed
   await Trip.findByIdAndUpdate(tripId, {
    $set: { 
      status: 'completed',
      rideStatus: 'completed',
      rideEndTime: new Date(),
      finalFare: fare,
      paymentCollected: false,  // ✅ ADD THIS LINE
      paymentCollectedAt: null  // ✅ ADD THIS LINE
    }
  });
    console.log(`✅ Trip ${tripId} status updated to completed with fare: ₹${fare}`);

    // ✅ CRITICAL: Keep driver BUSY until cash collected
    await User.findByIdAndUpdate(driverId, {
      $set: {
        currentTripId: tripId,  // ✅ KEEP trip ID
        isBusy: true,            // ✅ KEEP busy
        canReceiveNewRequests: false,
        awaitingCashCollection: true, // ✅ NEW flag
        lastTripCompletedAt: new Date()
      }
    });

    console.log('');
    console.log('⏳ DRIVER AWAITING CASH COLLECTION');
    console.log('   currentTripId:', tripId);
    console.log('   isBusy: true');
    console.log('   awaitingCashCollection: true');
    console.log('   Driver MUST click "Confirm Cash Collected" to accept new trips');
    console.log('');

    // Find customer socket
    const customerIdStr = trip.customerId.toString();
    let customerSocketId = null;

    console.log(`🔍 Looking for customer socket: ${customerIdStr}`);

    for (const [socketId, custId] of connectedCustomers.entries()) {
      if (custId === customerIdStr) {
        customerSocketId = socketId;
        console.log(`✅ Found customer socket: ${socketId}`);
        break;
      }
    }

    // Prepare the payload
    const rideCompletedPayload = {
      tripId: tripId.toString(),
      fare: fare,
      message: 'Ride completed',
      timestamp: new Date().toISOString()
    };

    // Emit to customer
    if (customerSocketId) {
      io.to(customerSocketId).emit('trip:completed', rideCompletedPayload);
      console.log('');
      console.log('📢 ✅ EMITTED trip:completed TO CUSTOMER');
      console.log(`   Socket ID: ${customerSocketId}`);
      console.log(`   Payload:`, rideCompletedPayload);
      console.log('');
    } else {
      console.log('');
      console.log('⚠️ WARNING: No socket found for customer');
      console.log(`   Customer ID: ${customerIdStr}`);
      console.log('');
    }

    // Confirm to driver - emphasize cash collection
    socket.emit('trip:completed', {
      ...rideCompletedPayload,
      message: 'Ride completed. Please collect ₹' + fare.toFixed(2) + ' from customer.',
      awaitingCashCollection: true // ✅ Tell Flutter to show cash screen
    });
    console.log(`📢 ✅ Confirmed trip:completed to driver ${driverId}`);
    console.log(`   ⚠️ Driver must confirm cash collection to continue`);

    console.log('='.repeat(70));
    console.log('');

  } catch (e) {
    console.error('❌ driver:complete_ride error:', e);
    console.error('Stack:', e.stack);
    socket.emit('trip:complete_error', { message: 'Failed to complete ride: ' + e.message });
  }
});
    // ========================================
    // 🔹 DRIVER GOING TO PICKUP
    // ========================================
    socket.on('driver:going_to_pickup', async ({ tripId, driverId }) => {
      console.log(`🚗 Driver ${driverId} going to pickup for trip ${tripId}`);

      try {
        await Trip.findByIdAndUpdate(tripId, {
          $set: { status: 'driver_going_to_pickup' }
        });

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
          io.to(customerSocketId).emit('trip:driver_going_to_pickup', {
            tripId: tripId.toString(),
            message: 'Driver is on the way to pickup'
          });
          console.log(`📢 Emitted driver_going_to_pickup to customer`);
        }

        socket.emit('trip:status_updated', { success: true });
      } catch (e) {
        console.error('❌ driver:going_to_pickup error:', e);
      }
    });

    // ========================================
    // 🔹 DRIVER ARRIVED AT PICKUP
    // ========================================
    socket.on('trip:arrived_at_pickup', async ({ tripId, driverId }) => {
      try {
        console.log(`📍 Driver ${driverId} arrived at pickup for trip ${tripId}`);

        await Trip.findByIdAndUpdate(tripId, {
          $set: { status: 'driver_at_pickup' }
        });

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
          io.to(customerSocketId).emit('trip:driver_arrived', {
            tripId: tripId.toString(),
            message: 'Driver has arrived at pickup location'
          });
        }

        socket.emit('trip:status_updated', { success: true });
      } catch (e) {
        console.error('❌ trip:arrived_at_pickup error:', e);
      }
    });

    // ========================================
    // 🔹 DRIVER LOCATION UPDATE (LIVE TRACKING)
    // ========================================
    socket.on('driver:location', async ({ tripId, latitude, longitude }) => {
      try {
        if (!tripId || !latitude || !longitude) return;

        const trip = await Trip.findById(tripId).lean();
        if (!trip) return;

        // Calculate distance to drop location
        const dropLat = trip.drop.coordinates[1];
        const dropLng = trip.drop.coordinates[0];
        
        const distance = calculateDistance(latitude, longitude, dropLat, dropLng);
        const distanceInMeters = distance * 1000;
        
        // Update driver status based on proximity
        if (distanceInMeters <= 500 && trip.status === 'ride_started') {
          await User.findByIdAndUpdate(trip.assignedDriver, {
            $set: { canReceiveNewRequests: true }
          });
          console.log(`✅ Driver ${trip.assignedDriver} within 500m - can receive new requests (${distanceInMeters.toFixed(0)}m away)`);
        } else {
          await User.findByIdAndUpdate(trip.assignedDriver, {
            $set: { canReceiveNewRequests: false }
          });
        }
        
        // Forward location to customer
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
            latitude,
            longitude,
            distanceToDestination: Math.round(distanceInMeters),
            timestamp: new Date().toISOString()
          });
        }
        
      } catch (e) {
        console.error('❌ driver:location error:', e);
      }
    });

    // ========================================
    // 🔹 DRIVER HEARTBEAT (CRASH DETECTION)
    // ========================================
    socket.on('driver:heartbeat', async ({ tripId, driverId, timestamp }) => {
      try {
        if (!tripId || !driverId) return;

        await Trip.findByIdAndUpdate(tripId, {
          $set: { lastDriverHeartbeat: new Date(timestamp) }
        });

        console.log(`💓 Heartbeat received from driver ${driverId} for trip ${tripId}`);
      } catch (e) {
        console.error('❌ driver:heartbeat error:', e);
      }
    });

    // ========================================
    // 🔹 CHAT MESSAGE HANDLER
    // ========================================
    socket.on('chat:send_message', async ({ tripId, fromId, toId, message }) => {
      try {
        console.log(`💬 Chat message from ${fromId} to ${toId} for trip ${tripId}`);
        
        let recipientSocketId = null;

        // Find recipient in either connected map
        for (const [socketId, userId] of connectedCustomers.entries()) {
          if (userId === toId) {
            recipientSocketId = socketId;
            break;
          }
        }
        
        if (!recipientSocketId) {
          for (const [socketId, userId] of connectedDrivers.entries()) {
            if (userId === toId) {
              recipientSocketId = socketId;
              break;
            }
          }
        }

        if (recipientSocketId) {
          const payload = { tripId, fromId, message, timestamp: new Date().toISOString() };
          io.to(recipientSocketId).emit('chat:receive_message', payload);
          console.log(`   ✓ Delivered message to socket ${recipientSocketId}`);
        } else {
          console.warn(`   ✗ Could not find active socket for user ${toId}. Message not sent.`);
        }
      } catch (e) {
        console.error('❌ chat:send_message error:', e);
      }
    });

    // ========================================
    // 🔹 NEW: MANUAL GO OFFLINE (EXPLICIT)
    // ========================================
    socket.on('driver:go_offline', async ({ driverId }) => {
      try {
        console.log('');
        console.log('='.repeat(70));
        console.log(`🔴 DRIVER MANUAL GO OFFLINE REQUEST`);
        console.log(`   Driver ID: ${driverId}`);
        console.log('='.repeat(70));
        
        const driver = await User.findById(driverId)
          .select('currentTripId isBusy name')
          .lean();
        
        if (!driver) {
          console.log('❌ Driver not found');
          return;
        }
        
        // ✅ BLOCK if there's an active trip
        if (driver.currentTripId || driver.isBusy) {
          console.log('');
          console.log('⚠️ CANNOT GO OFFLINE - ACTIVE TRIP IN PROGRESS');
          console.log(`   Trip ID: ${driver.currentTripId}`);
          console.log(`   Driver: ${driver.name}`);
          console.log('');
          
          socket.emit('driver:offline_blocked', {
            success: false,
            message: 'Cannot go offline during active trip',
            currentTripId: driver.currentTripId
          });
          return;
        }
        
        // ✅ Safe to go offline
        await User.findByIdAndUpdate(driverId, {
          $set: {
            isOnline: false,
            socketId: null,
            canReceiveNewRequests: false
          }
        });
        
        connectedDrivers.delete(socket.id);
        socket.disconnect(true);
        
        console.log(`✅ Driver ${driver.name} (${driverId}) went offline successfully`);
        console.log('='.repeat(70));
        console.log('');
        
      } catch (e) {
        console.error('❌ driver:go_offline error:', e);
      }
    });

    // ========================================
    // 🔹 UPDATED: DISCONNECT HANDLER (PASSIVE)
    // ========================================
    // ============================================================
// 🔧 FIXED DISCONNECT HANDLER - Add to socketHandler.js
// ============================================================

socket.on('disconnect', async () => {
  try {
    const driverId = connectedDrivers.get(socket.id);
    const customerId = connectedCustomers.get(socket.id);

    if (driverId) {
      const driver = await User.findById(driverId)
        .select('currentTripId isBusy isOnline name phone awaitingCashCollection')
        .lean();
      
      if (!driver) {
        connectedDrivers.delete(socket.id);
        return;
      }
      
      console.log('');
      console.log('='.repeat(70));
      console.log(`🔌 DRIVER SOCKET DISCONNECT DETECTED`);
      console.log(`   Driver: ${driver.name} (${driverId})`);
      console.log(`   Phone: ${driver.phone}`);
      console.log(`   Has Active Trip: ${driver.currentTripId ? 'YES' : 'NO'}`);
      console.log(`   Trip ID: ${driver.currentTripId || 'NONE'}`);
      console.log(`   isBusy: ${driver.isBusy}`);
      console.log(`   isOnline: ${driver.isOnline}`);
      console.log(`   awaitingCashCollection: ${driver.awaitingCashCollection}`);
      console.log('='.repeat(70));
      
      // ✅ CRITICAL FIX: Check if trip is truly active
      let hasRealActiveTrip = false;
      
      if (driver.currentTripId) {
        // Verify trip is ACTUALLY active
        const trip = await Trip.findById(driver.currentTripId)
          .select('status paymentCollected')
          .lean();
        
        if (trip) {
          const activeStatuses = ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'];
          
          // ✅ FIXED: Trip is ONLY active if:
          // 1. Status is in active list OR
          // 2. Completed but payment NOT collected (explicitly check !== true)
          hasRealActiveTrip = activeStatuses.includes(trip.status) || 
                            (trip.status === 'completed' && trip.paymentCollected !== true);
          
          console.log(`📋 Trip ${driver.currentTripId} verification:`);
          console.log(`   Status: ${trip.status}`);
          console.log(`   Payment Collected: ${trip.paymentCollected}`);
          console.log(`   Is TRULY Active: ${hasRealActiveTrip}`);
          
          // ✅ Extra check: If payment is collected, this is stale data
          if (trip.paymentCollected === true) {
            console.log('');
            console.log('⚠️ STALE TRIP DATA DETECTED - Payment already collected!');
            console.log('   This trip should have been cleared. Cleaning up now...');
            console.log('');
            hasRealActiveTrip = false; // Force cleanup
          }
        } else {
          console.log(`⚠️ Trip ${driver.currentTripId} not found in database`);
          hasRealActiveTrip = false;
        }
      }
      
      if (hasRealActiveTrip) {
        console.log('');
        console.log('⚠️ DRIVER HAS REAL ACTIVE TRIP - KEEPING ONLINE STATUS');
        console.log('   Actions:');
        console.log('   1. Clear socketId (allow reconnection)');
        console.log('   2. Keep isOnline = true');
        console.log('   3. Keep isBusy = true');
        console.log('   4. Keep currentTripId intact');
        console.log('');
        
        // ✅ Only clear socketId, keep everything else
        await User.findByIdAndUpdate(driverId, {
          $set: {
            socketId: null,
            lastDisconnectedAt: new Date()
          }
          // ⚠️ DO NOT CHANGE: isOnline, isBusy, currentTripId, awaitingCashCollection
        });
        
        console.log('✅ Driver can reconnect and resume trip');
        console.log('='.repeat(70));
        console.log('');
        
      } else {
        console.log('');
        console.log('✅ NO REAL ACTIVE TRIP - CLEANING UP DRIVER STATE');
        console.log('');
        
        // ✅ CRITICAL FIX: Completely free the driver
        const updateResult = await User.findByIdAndUpdate(driverId, {
          $set: {
            isOnline: false,
            isBusy: false,              // ✅ RESET
            socketId: null,
            currentTripId: null,        // ✅ CLEAR
            canReceiveNewRequests: false,
            awaitingCashCollection: false, // ✅ CLEAR
            lastDisconnectedAt: new Date()
          }
        }, { new: true });
        
        if (updateResult) {
          console.log(`🔴 Driver ${driver.name} FULLY FREED on disconnect`);
          console.log('   - isOnline: false');
          console.log('   - isBusy: false');
          console.log('   - currentTripId: null');
          console.log('   - awaitingCashCollection: false');
          
          // ✅ VERIFY the update worked
          const verify = await User.findById(driverId)
            .select('isBusy currentTripId awaitingCashCollection')
            .lean();
          
          console.log('');
          console.log('🔍 VERIFICATION:');
          console.log(`   isBusy: ${verify.isBusy}`);
          console.log(`   currentTripId: ${verify.currentTripId}`);
          console.log(`   awaitingCashCollection: ${verify.awaitingCashCollection}`);
          
          if (verify.isBusy || verify.currentTripId || verify.awaitingCashCollection) {
            console.log('');
            console.log('❌ CRITICAL: Verification FAILED - state not cleared!');
            console.log('   Attempting force clear...');
            console.log('');
            
            // Force clear again
            await User.updateOne(
              { _id: driverId },
              {
                $set: {
                  isBusy: false,
                  currentTripId: null,
                  awaitingCashCollection: false,
                  isOnline: false
                }
              }
            );
            
            console.log('✅ Force clear completed');
          } else {
            console.log('✅ Verification passed - state properly cleared');
          }
        }
        
        console.log('='.repeat(70));
        console.log('');
      }
      
      connectedDrivers.delete(socket.id);
    }

    if (customerId) {
      connectedCustomers.delete(socket.id);
      await User.findByIdAndUpdate(customerId, { 
        $set: { 
          socketId: null,
          lastDisconnectedAt: new Date()
        }
      });
      console.log(`👤 Customer disconnected: ${customerId}`);
    }
    
  } catch (e) {
    console.error('❌ disconnect cleanup error:', e);
    console.error('Stack:', e.stack);
  }
});

  // ========================================
  // 🔹 AUTO-CLEANUP EXPIRED TRIP REQUESTS
  // ========================================
  setInterval(async () => {
    try {
      const now = new Date();
      const expiredTrips = await Trip.find({
        status: 'requested',
        expiresAt: { $lt: now }
      });
      
      if (expiredTrips.length === 0) return;
      
      console.log(`⏰ Found ${expiredTrips.length} expired trip(s)`);
      
      for (const trip of expiredTrips) {
        await Trip.findByIdAndUpdate(trip._id, {
          $set: { status: 'timeout' }
        });
        
        // Notify customer
        const customer = await User.findById(trip.customerId).select('socketId').lean();
        if (customer?.socketId) {
          io.to(customer.socketId).emit('trip:timeout', {
            tripId: trip._id.toString(),
            message: 'No drivers available right now. Please try again.',
            reason: 'timeout'
          });
          console.log(`📢 Notified customer ${trip.customerId} - trip ${trip._id} expired`);
        }
        
        // Notify all online drivers
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
        
        console.log(`⏰ Trip ${trip._id} marked as timeout`);
      }
    } catch (e) {
      console.error('❌ Cleanup job error:', e);
    }
  }, 5000); // Run every 5 seconds

  console.log('⏰ Trip cleanup job started (checks every 5 seconds)');
  startNotificationRetryJob();
  startStaleTripCleanup();
  console.log('🚀 Socket.IO initialized');
});
}
export { io, connectedDrivers, connectedCustomers };