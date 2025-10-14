// src/socket/socketHandler.js
import User from '../models/User.js';
import Trip from '../models/Trip.js';
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

/**
 * Initialize socket.io handlers
 */
export const initSocket = (ioInstance) => {
  io = ioInstance;

  io.on('connection', (socket) => {
    console.log(`🟢 New connection: ${socket.id}`);

    // 🔹 Driver status update
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

    // 🔹 Customer register - COMPLETE UPDATED VERSION
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

    // 🔹 Customer request trip
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

    // 🔹 Driver accepts trip
    // IMPORTANT: Add this INSIDE your driver:accept_trip handler
// Replace the ENTIRE driver:accept_trip handler with this:

socket.on('driver:accept_trip', async ({ tripId, driverId }) => {
  try {
    console.log(`🚗 Driver ${driverId} accepting trip ${tripId}`);

    const trip = await Trip.findById(tripId).lean();
    if (!trip || trip.status !== 'requested') {
      emitTripError({ socket, tripId, message: 'Trip not available' });
      return;
    }

    const driver = await User.findById(driverId)
      .select('name phone photoUrl rating vehicleBrand vehicleNumber location')
      .lean();
    if (!driver) {
      emitTripError({ socket, tripId, message: 'Driver not found' });
      return;
    }

    const customer = await User.findById(trip.customerId)
      .select('name phone photoUrl rating')
      .lean();
    if (!customer) {
        emitTripError({ socket, tripId, message: 'Customer for this trip not found' });
        return;
    }

    // ✅ GENERATE OTP
    const { generateOTP } = await import('../utils/otpGeneration.js');
    const rideCode = generateOTP();
    console.log(`🎲 Generated OTP: ${rideCode}`);

    // ✅ UPDATE TRIP WITH OTP AND DRIVER
    await Trip.findByIdAndUpdate(tripId, {
      $set: { 
        assignedDriver: driverId, 
        status: 'driver_assigned',
        otp: rideCode
      },
    });

    // Find customer socket by MongoDB _id
    let customerSocketId = null;
    const customerIdStr = trip.customerId.toString();

    for (const [socketId, custId] of connectedCustomers.entries()) {
      if (custId === customerIdStr) {
        customerSocketId = socketId;
        console.log(`✅ Found customer socket: ${socketId} for customer ${custId}`);
        break;
      }
    }

    // EMIT TO CUSTOMER
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
      console.log(`📢 trip:accepted emitted to customer ${customerIdStr} with OTP: ${rideCode}`);
    } else {
      console.log(`❌ No socketId found for customer ${customerIdStr}`);
    }

    // EMIT TO DRIVER
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
    console.log(`📢 trip:confirmed_for_driver emitted to driver ${driverId}`);

  } catch (e) {
    console.error('❌ driver:accept_trip error:', e);
    emitTripError({ socket, tripId, message: 'Failed to accept trip.' });
  }
});
// ADD THESE HANDLERS TO YOUR socketHandler.js
// Place them after the driver:accept_trip handler and before disconnect

// 🔹 Driver starts the ride after OTP verification
socket.on('trip:start_ride', async ({ tripId, driverId, otp }) => {
  try {
    console.log(`🚗 Driver ${driverId} attempting to start ride ${tripId} with OTP: ${otp}`);

    const trip = await Trip.findById(tripId);
    if (!trip) {
      socket.emit('trip:start_error', { message: 'Trip not found' });
      return;
    }

    // Verify OTP
    if (trip.otp !== otp) {
      console.log(`❌ Invalid OTP. Expected: ${trip.otp}, Got: ${otp}`);
      socket.emit('trip:start_error', { message: 'Invalid OTP' });
      return;
    }

    // Verify trip status
    if (trip.status !== 'driver_assigned') {
      socket.emit('trip:start_error', { message: 'Trip not in correct status' });
      return;
    }

    // Update trip status to ride_started
    await Trip.findByIdAndUpdate(tripId, {
  $set: { rideStatus: 'ride_started', rideStartTime: new Date() }
});


    console.log(`✅ Ride started for trip ${tripId}`);

    // Find customer socket
    const customerIdStr = trip.customerId.toString();
    let customerSocketId = null;

    for (const [socketId, custId] of connectedCustomers.entries()) {
      if (custId === customerIdStr) {
        customerSocketId = socketId;
        break;
      }
    }

    // Emit to customer that ride has started
    if (customerSocketId) {
      io.to(customerSocketId).emit('trip:ride_started', {
        tripId: tripId.toString(),
        message: 'Ride has started',
        timestamp: new Date().toISOString()
      });
      console.log(`📢 trip:ride_started emitted to customer ${customerIdStr}`);
    }

    // Confirm to driver
    socket.emit('trip:ride_started', {
      tripId: tripId.toString(),
      message: 'Ride started successfully',
      timestamp: new Date().toISOString()
    });
    console.log(`📢 trip:ride_started confirmed to driver ${driverId}`);

  } catch (e) {
    console.error('❌ trip:start_ride error:', e);
    socket.emit('trip:start_error', { message: 'Failed to start ride' });
  }
});

// 🔹 Driver completes the ride
socket.on('trip:complete_ride', async ({ tripId, driverId }) => {
  try {
    console.log(`✅ Driver ${driverId} completing trip ${tripId}`);

    const trip = await Trip.findById(tripId);
    if (!trip) {
      socket.emit('trip:complete_error', { message: 'Trip not found' });
      return;
    }

    if (trip.status !== 'ride_started') {
      socket.emit('trip:complete_error', { message: 'Ride has not started yet' });
      return;
    }

    // Calculate fare (you can implement your own fare calculation logic)
    const fare = trip.estimatedFare || 100; // Use estimated fare or calculate

    // Update trip status to completed
    await Trip.findByIdAndUpdate(tripId, {
      $set: { 
        status: 'completed',
        rideEndTime: new Date(),
        finalFare: fare
      }
    });

    console.log(`✅ Ride completed for trip ${tripId} with fare: ₹${trip.finalFare}`);

    // Find customer socket
    const customerIdStr = trip.customerId.toString();
    let customerSocketId = null;

    for (const [socketId, custId] of connectedCustomers.entries()) {
      if (custId === customerIdStr) {
        customerSocketId = socketId;
        break;
      }
    }

    // Emit to customer that ride is completed
    if (customerSocketId) {
      io.to(customerSocketId).emit('trip:completed', {
        tripId: tripId.toString(),
        fare: fare,
        message: 'Ride completed',
        timestamp: new Date().toISOString()
      });
      console.log(`📢 trip:completed emitted to customer ${customerIdStr} with fare: ₹${fare}`);
    }

    // Confirm to driver
    socket.emit('trip:completed', {
      tripId: tripId.toString(),
      fare: fare,
      message: 'Ride completed successfully',
      timestamp: new Date().toISOString()
    });
    console.log(`📢 trip:completed confirmed to driver ${driverId}`);

  } catch (e) {
    console.error('❌ trip:complete_ride error:', e);
    socket.emit('trip:complete_error', { message: 'Failed to complete ride' });
  }
});

// 🔹 Driver going to pickup (optional - for status tracking)
socket.on('trip:going_to_pickup', async ({ tripId, driverId }) => {
  try {
    console.log(`🚗 Driver ${driverId} going to pickup for trip ${tripId}`);

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
    }

    socket.emit('trip:status_updated', { success: true });
  } catch (e) {
    console.error('❌ trip:going_to_pickup error:', e);
  }
});

// 🔹 Driver arrived at pickup (optional - for status tracking)
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
// ADD THESE HANDLERS TO YOUR socketHandler.js AFTER driver:accept_trip
// Replace any existing handlers with these exact names

// 🔹 Driver starts the ride after OTP verification
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

// 🔹 Driver completes the ride
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

    // Calculate fare (use your own logic)
    const fare = trip.estimatedFare || 100;

    // Update trip status to completed
    await Trip.findByIdAndUpdate(tripId, {
      $set: { 
        status: 'completed',
        rideEndTime: new Date(),
        finalFare: fare
      }
    });

    console.log(`✅ Trip ${tripId} status updated to completed with fare: ₹${fare}`);

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

    // Confirm to driver
    socket.emit('trip:completed', {
      tripId: tripId.toString(),
      fare: fare,
      message: 'Ride completed successfully',
      timestamp: new Date().toISOString()
    });
    console.log(`📢 ✅ Confirmed trip:completed to driver ${driverId}`);

    console.log('='.repeat(70));
    console.log('');

  } catch (e) {
    console.error('❌ driver:complete_ride error:', e);
    console.error('Stack:', e.stack);
    socket.emit('trip:complete_error', { message: 'Failed to complete ride: ' + e.message });
  }
});

// 🔹 Driver going to pickup (optional)
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
// 🔹 Listen for driver location updates during active ride
socket.on('driver:location', async ({ tripId, latitude, longitude }) => {
  try {
    if (!tripId || !latitude || !longitude) return;

    const trip = await Trip.findById(tripId).lean();
    if (!trip) return;

    // Find customer socket and emit location update
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
        timestamp: new Date().toISOString()
      });
    }
  } catch (e) {
    console.error('❌ driver:location error:', e);
  }
});

    // Add this to your existing socketHandler.js after the driver:accept_trip handler

// 🔹 Listen for driver location updates during active ride
    // --- ⬇️ NEW: Add chat message handler ---
    socket.on('chat:send_message', async ({ tripId, fromId, toId, message }) => {
        try {
            console.log(`💬 Chat message from ${fromId} to ${toId} for trip ${tripId}`);
            
            let recipientSocketId = null;

            // Find recipient in either connected map by iterating over them
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
                console.log(`    L Delivered message to socket ${recipientSocketId}`);
            } else {
                console.warn(`    L Could not find active socket for user ${toId}. Message not sent.`);
                // Here you could add logic to send a push notification as a fallback
            }
        } catch(e) {
            console.error('❌ chat:send_message error:', e);
        }
    });
    // --- ⬆️ END NEW SECTION ---

    // 🔹 Disconnect handler
    socket.on('disconnect', async () => {
      try {
        const driverId = connectedDrivers.get(socket.id);
        const customerId = connectedCustomers.get(socket.id);

        if (driverId) {
          await User.findByIdAndUpdate(driverId, { isOnline: false, socketId: null });
          connectedDrivers.delete(socket.id);
          console.log(`🔴 Driver disconnected: ${driverId}`);
        }

        if (customerId) {
          connectedCustomers.delete(socket.id);
          await User.findByIdAndUpdate(customerId, { socketId: null });
          console.log(`👤 Customer disconnected: ${customerId}`);
        }
      } catch (e) {
        console.error('❌ disconnect cleanup error:', e);
      }
    });
  });

  console.log('🚀 Socket.IO initialized');
};

export { io, connectedDrivers, connectedCustomers };