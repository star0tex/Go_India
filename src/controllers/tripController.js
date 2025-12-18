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

// ✅ NEW IMPORTS FOR DISCOUNT FUNCTIONALITY
import RewardSettings from '../models/RewardSettings.js';
import Reward from '../models/Reward.js';

// ✅ CRITICAL FIX: Import Customer model (was missing!)
// If you have a separate Customer model, import it:
// import Customer from '../models/Customer.js';

// If Customer data is in User model, we'll use User with a helper function
const getCustomerModel = async () => {
  try {
    // Try to get Customer model if it exists
    const Customer = mongoose.models.Customer || mongoose.model('Customer');
    return Customer;
  } catch (e) {
    // Fallback to User model if Customer doesn't exist
    console.log('ℹ️ Using User model for customer coin operations');
    return User;
  }
};

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

/**
 * ✅ Award coins to customer after successful ride completion
 * Called internally after cash collection is confirmed
 * ⚠️ THIS IS THE ONLY PLACE WHERE CUSTOMER COINS ARE AWARDED
 */
async function awardCoinsToCustomer(customerId, tripId, distance) {
  try {
    console.log('');
    console.log('🎁 ═══════════════════════════════════════════════════════════');
    console.log('🎁 AWARDING COINS TO CUSTOMER (SINGLE AWARD POINT)');
    console.log('🎁 ═══════════════════════════════════════════════════════════');
    console.log(`   Customer ID: ${customerId}`);
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Distance: ${distance?.toFixed(2) || 'N/A'} km`);

    // Get reward settings
    const settings = await RewardSettings.findOne();
    
    if (!settings) {
      console.log('   ⚠️ No reward settings configured - skipping coin award');
      return { success: true, awarded: false, reason: 'no_settings' };
    }

    // Calculate distance if not provided
    if (!distance || distance <= 0) {
      const trip = await Trip.findById(tripId).lean();
      if (trip?.pickup?.coordinates && trip?.drop?.coordinates) {
        distance = calculateDistanceFromCoords(
          trip.pickup.coordinates[1], 
          trip.pickup.coordinates[0],
          trip.drop.coordinates[1], 
          trip.drop.coordinates[0]
        );
        console.log(`   📏 Calculated distance: ${distance.toFixed(2)} km`);
      } else {
        console.log('   ⚠️ Cannot calculate distance - skipping coin award');
        return { success: true, awarded: false, reason: 'no_distance' };
      }
    }

    // Find appropriate tier
    const tier = settings.getTierByDistance(distance);
    const coinsToAward = tier.coinsPerRide;

    console.log(`   🎯 Tier: ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`);
    console.log(`   💰 Coins to award: ${coinsToAward}`);

    // Get Customer model dynamically
    const CustomerModel = await getCustomerModel();
    
    // Update customer coins
    const customer = await CustomerModel.findByIdAndUpdate(
      customerId,
      { $inc: { coins: coinsToAward } },
      { new: true }
    );

    if (!customer) {
      console.log('   ❌ Customer not found');
      return { success: false, error: 'Customer not found' };
    }

    // Record in rewards history
    await Reward.create({
      customerId,
      tripId,
      coins: coinsToAward,
      type: 'earned',
      description: `Ride completed (${distance.toFixed(1)}km) - ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km tier`,
      createdAt: new Date(),
    });

    console.log('   ✅ Coins awarded successfully:');
    console.log(`      Coins awarded: ${coinsToAward}`);
    console.log(`      New balance: ${customer.coins || 0}`);
    console.log('🎁 ═══════════════════════════════════════════════════════════');
    console.log('');

    // ✅ Emit socket event to notify customer
    const customerUser = await User.findById(customerId).select('socketId').lean();
    if (customerUser?.socketId && io) {
      io.to(customerUser.socketId).emit('coins:awarded', {
        coins: coinsToAward,
        totalCoins: customer.coins || 0,
        message: `You earned ${coinsToAward} coins! 🎉`,
        tier: {
          range: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
          platformFee: tier.platformFee,
        },
        tripDistance: distance.toFixed(1),
      });
      console.log(`📤 Emitted coins:awarded to customer ${customerId}`);
    }

    return {
      success: true,
      awarded: true,
      coinsAwarded: coinsToAward,
      totalCoins: customer.coins || 0,
      tier: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
    };

  } catch (error) {
    console.error('   ❌ Error awarding coins:', error);
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

// ✅ NEW: Helper function to calculate distance from coordinates (for discount tier)
function calculateDistanceFromCoords(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ✅ UPDATED: createShortTrip with atomic discount application and socket notification
const createShortTrip = async (req, res) => {
  // ✅ Declare these at the top for rollback access
  let coinsDeducted = 0;
  let discountCustomerId = null;

  try {
    const { customerId, pickup, drop, vehicleType, fare } = req.body;

    console.log('');
    console.log('='.repeat(70));
    console.log('📥 CREATE SHORT TRIP REQUEST WITH DISCOUNT CHECK');
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

    // Find customer (from User collection)
    const customer = await findUserByIdOrPhone(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    // ✅ STEP 1: Check discount eligibility and apply atomically
    let finalFare = fare;
    let discountApplied = 0;
    let discountDetails = null;
    discountCustomerId = customer._id;

    // Calculate distance for tier determination
    const distance = calculateDistanceFromCoords(
      pickup.coordinates[1], pickup.coordinates[0],
      drop.coordinates[1], drop.coordinates[0]
    );

    console.log(`📏 Trip distance: ${distance.toFixed(2)} km`);

    // ✅ Try to get reward settings and apply discount
    try {
      const settings = await RewardSettings.findOne();
      
      if (settings && settings.getTierByDistance) {
        const tier = settings.getTierByDistance(distance);
        const coinsRequired = tier.coinsRequiredForDiscount;
        const discountAmount = tier.discountAmount;

        console.log(`🎯 Tier: ${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`);
        console.log(`   Required: ${coinsRequired} coins for ₹${discountAmount} off`);

        // ✅ Get Customer model dynamically
        const CustomerModel = await getCustomerModel();
        
        // ✅ Try to find customer record for coins
        const customerRecord = await CustomerModel.findById(customerId);
        
        if (customerRecord) {
          const customerCoins = customerRecord.coins || 0;
          console.log(`   Customer has: ${customerCoins} coins`);

          // ✅ ATOMIC OPERATION: Check and deduct coins in ONE database operation
          if (customerCoins >= coinsRequired) {
            const updatedCustomer = await CustomerModel.findOneAndUpdate(
              {
                _id: customerId,
                coins: { $gte: coinsRequired }
              },
              {
                $inc: { coins: -coinsRequired },
                $set: {
                  hasRedeemableDiscount: false,
                  discountTierDistance: null,
                  lastDiscountUsedAt: new Date()
                }
              },
              {
                new: true,
                returnOriginal: false
              }
            );

            if (updatedCustomer) {
              // ✅ Discount successfully applied
              finalFare = Math.max(0, fare - discountAmount);
              discountApplied = discountAmount;
              coinsDeducted = coinsRequired;

              discountDetails = {
                originalFare: fare,
                discountAmount,
                finalFare,
                coinsDeducted,
                tier: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`,
                remainingCoins: updatedCustomer.coins || 0
              };

              // ✅ Record the discount redemption
              await Reward.create({
                customerId,
                coins: -coinsDeducted,
                type: 'redeemed',
                description: `₹${discountAmount} discount applied for ${distance.toFixed(1)}km trip`,
                createdAt: new Date(),
              });

              // ✅ NEW: Emit socket event to notify customer of coin deduction
              const customerUser = await User.findById(customerId).select('socketId').lean();
              if (customerUser?.socketId && io) {
                io.to(customerUser.socketId).emit('coins:redeemed', {
                  coinsUsed: coinsDeducted,
                  discountAmount: discountAmount,
                  remainingCoins: updatedCustomer.coins || 0,
                  message: `${coinsDeducted} coins used for ₹${discountAmount} discount!`,
                  tripDistance: distance.toFixed(1),
                  tier: `${tier.minDistance}-${tier.maxDistance === Infinity ? '10+' : tier.maxDistance}km`
                });
                console.log(`📤 Emitted coins:redeemed to customer ${customerId}`);
              }

              console.log(`✅ Discount applied atomically:`);
              console.log(`   Original fare: ₹${fare}`);
              console.log(`   Discount: ₹${discountAmount}`);
              console.log(`   Final fare: ₹${finalFare}`);
              console.log(`   Coins deducted: ${coinsDeducted}`);
              console.log(`   Remaining coins: ${updatedCustomer.coins || 0}`);
            } else {
              console.log(`⚠️ Atomic update failed - coins may have been spent elsewhere`);
            }
          } else {
            console.log(`⚠️ Customer doesn't have enough coins (${customerCoins} < ${coinsRequired})`);
          }
        } else {
          console.log(`⚠️ Customer not found in Customer collection - skipping discount`);
        }
      } else {
        console.log(`⚠️ No reward settings found or getTierByDistance not available - skipping discount`);
      }
    } catch (discountError) {
      // ✅ Don't fail the trip creation if discount check fails
      console.log(`⚠️ Discount check failed (non-critical): ${discountError.message}`);
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

    // ✅ Create trip with FINAL FARE (after discount)
    const trip = await Trip.create({
      customerId: customer._id,
      pickup,
      drop,
      vehicleType: sanitizedVehicleType,
      type: 'short',
      status: 'requested',
      fare: finalFare,              // ✅ Using discounted fare
      originalFare: fare,           // ✅ Store original for reference
      discountApplied,              // ✅ Store discount amount
      coinsUsed: coinsDeducted,     // ✅ Store coins used
      discountDetails               // ✅ Store full discount details
    });

    console.log('✅ Trip created in database:');
    console.log(`   Trip ID: ${trip._id}`);
    console.log(`   Original Fare: ₹${fare}`);
    console.log(`   Final Fare: ₹${trip.fare}`);
    console.log(`   Discount Applied: ₹${discountApplied}`);

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
      fare: trip.fare,  // ✅ Drivers see final fare
      discountApplied: discountApplied > 0,
    };

    if (!nearbyDrivers.length) {
      console.warn(`⚠️ No '${sanitizedVehicleType}' drivers found for short trip ${trip._id}`);
      return res.status(200).json({ 
        success: true, 
        tripId: trip._id, 
        drivers: 0,
        fareDetails: {
          originalFare: fare,
          discountApplied,
          finalFare,
          coinsUsed: coinsDeducted,
          remainingCoins: discountDetails?.remainingCoins || null
        }
      });
    }

    // Broadcast to available drivers
    broadcastToDrivers(nearbyDrivers, payload);
    
    console.log(`✅ Short Trip ${trip._id} created with fare ₹${trip.fare}`);
    console.log(`   Found ${nearbyDrivers.length} '${sanitizedVehicleType}' drivers`);
    console.log('='.repeat(70));
    
    res.status(200).json({ 
      success: true, 
      tripId: trip._id, 
      drivers: nearbyDrivers.length,
      fareDetails: {
        originalFare: fare,
        discountApplied,
        finalFare,
        coinsUsed: coinsDeducted,
        remainingCoins: discountDetails?.remainingCoins || null
      }
    });

  } catch (err) {
    console.error('🔥 createShortTrip error:', err);

    // ✅ ROLLBACK: If trip creation fails, restore coins
    if (discountCustomerId && coinsDeducted > 0) {
      try {
        const CustomerModel = await getCustomerModel();
        await CustomerModel.findByIdAndUpdate(discountCustomerId, {
          $inc: { coins: coinsDeducted }
        });
        console.log(`✅ Rolled back ${coinsDeducted} coins to customer ${discountCustomerId}`);
        
        // Also remove the reward record if it was created
        await Reward.deleteOne({
          customerId: discountCustomerId,
          coins: -coinsDeducted,
          type: 'redeemed',
          createdAt: { $gte: new Date(Date.now() - 5000) } // Within last 5 seconds
        });
        console.log(`✅ Rolled back reward record`);
      } catch (rollbackErr) {
        console.error('❌ Failed to rollback coins:', rollbackErr);
      }
    }

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
      isBusy: { $ne: true },
      $or: [
        { currentTripId: null },
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
      fare: fare,
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
      isBusy: { $ne: true },
      $or: [
        { currentTripId: null },
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
      fare: fare
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

// ✅ ENHANCED FIX: Atomic driver + trip reservation with cancellation check
const acceptTrip = async (req, res) => {
  try {
    const { driverId, tripId } = req.body;

    console.log('');
    console.log('='.repeat(70));
    console.log(`🎯 Driver ${driverId} attempting to accept trip ${tripId}`);
    console.log('='.repeat(70));

    if (!driverId || !tripId) {
      return res.status(400).json({
        success: false,
        message: 'driverId and tripId are required'
      });
    }

    const rideCode = generateOTP();

    // ✅ ATOMIC STEP 1: Reserve driver (check availability + mark busy in ONE operation)
    const driver = await User.findOneAndUpdate(
      {
        _id: driverId,
        // ✅ CRITICAL: Only update if driver is truly available
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
      console.log(`⚠️ Driver ${driverId} is already on another trip or not found`);
      return res.status(400).json({
        success: false,
        message: 'You are already on another trip or cannot accept this trip',
        reason: 'driver_busy'
      });
    }

    console.log(`✅ Driver ${driverId} atomically reserved`);
    console.log(`   - isBusy: true`);
    console.log(`   - currentTripId: ${tripId}`);

    // ✅ ATOMIC STEP 2: Reserve trip (check status + cancellation + assign driver in ONE operation)
    const trip = await Trip.findOneAndUpdate(
      { 
        _id: tripId, 
        status: 'requested',
        // ✅ ENHANCED: Ensure no cancellation in progress
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
          acceptedAt: new Date(),
          otp: rideCode
        }
      },
      { new: true }
    ).lean();

    // ❌ Trip already taken, cancelled, or not found - ROLLBACK DRIVER
    if (!trip) {
      console.log(`⚠️ Trip ${tripId} is no longer available (taken/cancelled) - ROLLING BACK`);
      
      // ✅ ROLLBACK: Free the driver
      await User.findByIdAndUpdate(driverId, {
        $set: { 
          isBusy: false, 
          currentTripId: null,
          canReceiveNewRequests: false
        }
      });
      
      console.log(`✅ Driver ${driverId} rolled back to available state`);
      
      return res.status(400).json({
        success: false,
        message: 'This trip is no longer available (already accepted or cancelled)',
        reason: 'trip_unavailable'
      });
    }

    console.log(`✅ Trip ${tripId} atomically assigned to driver ${driverId}`);
    console.log(`   - Status: driver_assigned`);
    console.log(`   - OTP: ${rideCode}`);

    // ✅ STEP 3: Notify customer via socket
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
          originalFare: trip.originalFare || null,
          discountApplied: trip.discountApplied || 0,
          coinsUsed: trip.coinsUsed || 0
        },
        driver: {
          id: driver._id.toString(),
          name: driver.name || 'N/A',
          phone: driver.phone || 'N/A',
          photoUrl: driver.photoUrl || null,
          rating: driver.rating || 4.8,
          vehicleBrand: driver.vehicleBrand || 'Bike',
          vehicleNumber: driver.vehicleNumber || 'N/A',
          location: driver.location ? { 
            lat: driver.location.coordinates[1], 
            lng: driver.location.coordinates[0] 
          } : null
        }
      };
      
      io.to(customer.socketId).emit('trip:accepted', payload);
      console.log(`✅ Customer ${customer.name} notified via socket`);
    }

    // ✅ STEP 4: Notify ALL other drivers that this trip is taken
    const otherDrivers = await User.find({
      isDriver: true,
      isOnline: true,
      _id: { $ne: driverId },
      socketId: { $exists: true, $ne: null }
    }).select('socketId name').lean();

    console.log(`📡 Notifying ${otherDrivers.length} other drivers that trip is taken`);

    otherDrivers.forEach(otherDriver => {
      if (otherDriver.socketId) {
        io.to(otherDriver.socketId).emit('trip:taken', {
          tripId: tripId,
          acceptedBy: driver.name || 'Another driver',
        });
      }
    });

    console.log('='.repeat(70));
    console.log(`✅ SUCCESS: Trip ${tripId} assigned to ${driver.name}`);
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
    
    // ✅ CRITICAL: Rollback on any error
    try {
      if (req.body?.driverId && req.body?.tripId) {
        const { driverId, tripId } = req.body;
        
        // Rollback driver
        await User.findByIdAndUpdate(driverId, {
          $set: { isBusy: false, currentTripId: null, canReceiveNewRequests: false }
        });
        
        // Rollback trip
        await Trip.findByIdAndUpdate(tripId, {
          $unset: { assignedDriver: 1, otp: 1 },
          $set: { status: 'requested', acceptedAt: null }
        });
        
        console.log(`✅ Emergency rollback completed for driver ${driverId} and trip ${tripId}`);
      }
    } catch (rollbackError) {
      console.error('❌ Rollback failed:', rollbackError);
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to accept trip',
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
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

// ✅ UPDATED: cancelTrip with coin refund functionality and socket notification
const cancelTrip = async (req, res) => {
  try {
    const { tripId, cancelledBy, reason } = req.body;
    
    console.log('');
    console.log('='.repeat(70));
    console.log('🚫 CANCEL TRIP REQUEST WITH COIN REFUND');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Cancelled By: ${cancelledBy}`);
    console.log(`   Reason: ${reason || 'No reason provided'}`);
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

    // ✅ REFUND COINS if discount was applied and trip is cancelled
    let coinsRefunded = 0;
    let newBalance = null;
    
    if (trip.coinsUsed && trip.coinsUsed > 0) {
      try {
        const customerId = trip.customerId._id || trip.customerId;
        const CustomerModel = await getCustomerModel();
        
        const refundResult = await CustomerModel.findByIdAndUpdate(
          customerId,
          {
            $inc: { coins: trip.coinsUsed }
          },
          { new: true }
        );

        if (refundResult) {
          coinsRefunded = trip.coinsUsed;
          newBalance = refundResult.coins || 0;

          // Record the refund
          await Reward.create({
            customerId: customerId,
            tripId: trip._id,
            coins: coinsRefunded,
            type: 'earned',
            description: `Refund: Trip cancelled (${reason || 'No reason'})`,
            createdAt: new Date(),
          });

          // ✅ NEW: Emit socket event for coin refund
          const customerUser = await User.findById(customerId).select('socketId').lean();
          if (customerUser?.socketId && io) {
            io.to(customerUser.socketId).emit('coins:refunded', {
              coinsRefunded: coinsRefunded,
              newBalance: newBalance,
              message: `${coinsRefunded} coins refunded due to trip cancellation`,
              reason: reason || 'Trip cancelled'
            });
            console.log(`📤 Emitted coins:refunded to customer ${customerId}`);
          }

          console.log(`✅ Refunded ${coinsRefunded} coins to customer`);
          console.log(`   New balance: ${newBalance} coins`);
        }
      } catch (refundError) {
        console.error('⚠️ Failed to refund coins (non-critical):', refundError.message);
      }
    }

    // Update trip status
    trip.status = 'cancelled';
    trip.cancelledBy = cancelledBy;
    trip.cancelledAt = new Date();
    trip.cancellationReason = reason;
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
      if (driver?.socketId && io) {
        io.to(driver.socketId).emit('trip:cancelled', {
          tripId: tripId,
          message: isCustomer ? 'Customer cancelled the trip' : 'Trip cancelled',
          cancelledBy: isCustomer ? 'customer' : 'driver',
          timestamp: new Date().toISOString(),
          shouldClearTrip: true,
          coinsRefunded
        });
        console.log(`📢 Notified driver via socket`);
      }
    }

    // Notify customer
    const customer = trip.customerId;
    if (customer?.socketId && io) {
      io.to(customer.socketId).emit('trip:cancelled', {
        tripId: tripId,
        message: isDriver ? 'Driver cancelled the trip' : 'Trip cancelled',
        cancelledBy: isDriver ? 'driver' : 'customer',
        timestamp: new Date().toISOString(),
        shouldClearTrip: true,
        coinsRefunded,
        newBalance
      });
      console.log(`📢 Notified customer via socket`);
    }

    console.log('='.repeat(70));
    console.log('✅ Trip cancellation complete');
    if (coinsRefunded > 0) {
      console.log(`   💰 Coins refunded: ${coinsRefunded}`);
    }
    console.log('='.repeat(70));
    console.log('');

    res.status(200).json({ 
      success: true, 
      message: 'Trip cancelled successfully',
      tripId: tripId,
      cancelledBy: isCustomer ? 'customer' : 'driver',
      driverFreed: !!trip.assignedDriver,
      coinsRefunded,
      newBalance
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
        {
          $or: [
            { 
              status: { $in: ['driver_assigned', 'driver_going_to_pickup', 'driver_at_pickup', 'ride_started'] } 
            },
            { 
              status: 'completed',
              $or: [
                { paymentCollected: { $ne: true } },
                { paymentCollected: { $exists: false } }
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
        console.log('✅ Driver state cleared - ready for new trips');
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

    if (trip.status === 'completed' && trip.paymentCollected === true) {
      console.log('⚠️ Found completed trip with payment - clearing driver');
      
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
        message: 'Trip completed and paid',
        driverFreed: true
      });
    }

    console.log('⚠️ ACTIVE TRIP FOUND:');
    console.log(`   Trip ID: ${trip._id}`);
    console.log(`   Status: ${trip.status}`);
    console.log(`   Payment Collected: ${trip.paymentCollected || false}`);

    let ridePhase = 'going_to_pickup';
    
    if (trip.rideStatus === 'ride_started' || trip.status === 'ride_started') {
      ridePhase = 'going_to_drop';
    } else if (trip.rideStatus === 'arrived_at_pickup' || trip.status === 'driver_at_pickup') {
      ridePhase = 'at_pickup';
    } else if ((trip.rideStatus === 'completed' || trip.status === 'completed') && trip.paymentCollected !== true) {
      ridePhase = 'completed';
    }

    console.log(`   Phase: ${ridePhase}`);

    const response = {
      success: true,
      hasActiveTrip: true,
      trip: {
        tripId: trip._id.toString(),
        rideCode: trip.otp,
        status: trip.status,
        ridePhase: ridePhase,
        fare: trip.fare || trip.finalFare || 0,
        originalFare: trip.originalFare || null,
        discountApplied: trip.discountApplied || 0,
        coinsUsed: trip.coinsUsed || 0,
        paymentCollected: trip.paymentCollected || false,
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

    trip.rideStatus = 'ride_started';
    trip.status = 'ride_started';
    trip.startTime = new Date();
    
    await trip.save();
    console.log(`✅ Ride started for trip ${tripId}`);

    const customer = await User.findById(trip.customerId);
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:ride_started', {
        tripId: trip._id.toString(),
        startTime: trip.startTime,
        fare: trip.fare,
        originalFare: trip.originalFare || null,
        discountApplied: trip.discountApplied || 0,
        coinsUsed: trip.coinsUsed || 0
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

// ✅ UPDATED: completeRideWithVerification with discount info in socket event
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

    trip.status = 'completed';
    trip.rideStatus = 'completed';
    trip.endTime = new Date();
    trip.finalFare = trip.fare || 0;
    trip.completedAt = new Date();
    trip.paymentCollected = false;
    trip.paymentCollectedAt = null;
    
    await trip.save();

    console.log(`✅ Trip ${tripId} marked as completed`);
    console.log(`   Final Fare: ₹${trip.finalFare}`);
    console.log(`   Original Fare: ₹${trip.originalFare || 'N/A'}`);
    console.log(`   Discount Applied: ₹${trip.discountApplied || 0}`);
    console.log(`   Coins Used: ${trip.coinsUsed || 0}`);

    await saveToRideHistory(trip, 'Completed');

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

    // ✅ UPDATED: Include discount info in trip:completed event
    const customer = trip.customerId;
    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:completed', {
        tripId: tripId,
        endTime: trip.endTime,
        fare: trip.finalFare,
        originalFare: trip.originalFare || null,
        discountApplied: trip.discountApplied || 0,
        coinsUsed: trip.coinsUsed || 0,
        awaitingPayment: true
      });
      console.log(`📢 Emitted trip:completed to customer with discount info`);
    }

    console.log('='.repeat(70));
    console.log('');

    res.status(200).json({
      success: true,
      message: 'Ride completed. Please collect cash from customer.',
      fare: trip.finalFare,
      originalFare: trip.originalFare || null,
      discountApplied: trip.discountApplied || 0,
      coinsUsed: trip.coinsUsed || 0,
      duration: Math.round((trip.endTime - trip.startTime) / 60000),
      awaitingCashCollection: true,
      paymentCollected: false
    });

  } catch (err) {
    console.error('🔥 completeRideWithVerification error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

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

    console.log(`✅ Trip found: ${trip.status}`);

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
        originalFare: trip.originalFare || null,
        discountApplied: trip.discountApplied || 0,
        coinsUsed: trip.coinsUsed || 0,
        discountDetails: trip.discountDetails || null,
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

// ============================================================
// ✅ FIXED: confirmCashCollection with SINGLE coin award
// ⚠️ THIS IS THE ONLY PLACE WHERE CUSTOMER COINS ARE AWARDED
// ============================================================
const confirmCashCollection = async (req, res) => {
  try {
    const { tripId, driverId, fare } = req.body;

    // ✅ DEBUG: Log call origin
    console.log('');
    console.log('🔍 ═══════════════════════════════════════════════════════════════');
    console.log('🔍 DEBUG: confirmCashCollection called');
    console.log('🔍 ═══════════════════════════════════════════════════════════════');
    console.log('='.repeat(70));
    console.log('💰 CONFIRM CASH COLLECTION REQUEST');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log('='.repeat(70));

    if (!tripId || !driverId) {
      return res.status(400).json({
        success: false,
        message: 'tripId and driverId are required'
      });
    }

    const trip = await Trip.findById(tripId).lean();
    if (!trip) {
      console.log('❌ Trip not found');
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      console.log('❌ Driver not authorized');
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.status !== 'completed') {
      console.log(`❌ Trip not completed yet: ${trip.status}`);
      return res.status(400).json({
        success: false,
        message: 'Trip must be completed before collecting cash'
      });
    }

    if (trip.paymentCollected === true) {
      console.log('⚠️ Cash already collected!');
      return res.status(400).json({
        success: false,
        message: 'Cash already collected for this trip'
      });
    }

    const fareAmount = fare || trip.finalFare || trip.fare || 0;
    
    if (fareAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid fare amount'
      });
    }

    // ============================================================
    // STEP 1: Process wallet transaction (NO coin award in walletController)
    // ============================================================
    console.log('📦 STEP 1: Processing wallet transaction...');
    
    const mockReq = {
      body: {
        tripId,
        driverId,
        fare: fareAmount
      }
    };

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

    console.log('✅ STEP 1 COMPLETE: Wallet transaction successful');

    // ============================================================
    // STEP 2: Award coins to customer (ONLY ONCE, ONLY HERE)
    // ⚠️ THIS IS THE SINGLE POINT OF COIN AWARD
    // ============================================================
    console.log('');
    console.log('📦 STEP 2: Awarding coins to customer (SINGLE AWARD)...');
    
    let coinReward = null;
    
    try {
      // Calculate distance for coin award
      let distance = null;
      if (trip.pickup?.coordinates && trip.drop?.coordinates) {
        distance = calculateDistanceFromCoords(
          trip.pickup.coordinates[1], 
          trip.pickup.coordinates[0],
          trip.drop.coordinates[1], 
          trip.drop.coordinates[0]
        );
        console.log(`   📏 Calculated distance: ${distance.toFixed(2)} km`);
      }

      // ✅ SINGLE COIN AWARD - This is the ONLY place coins are awarded
      coinReward = await awardCoinsToCustomer(
        trip.customerId,
        tripId,
        distance
      );

      if (coinReward.success && coinReward.awarded) {
        console.log(`✅ STEP 2 COMPLETE: Coins awarded ONCE: ${coinReward.coinsAwarded}`);
        console.log(`   New balance: ${coinReward.totalCoins}`);
      } else {
        console.log('ℹ️ STEP 2 COMPLETE: Coins not awarded:', coinReward.reason || 'unknown');
      }
    } catch (coinError) {
      // Don't fail the payment if coin award fails
      console.error('⚠️ Coin award failed (non-critical):', coinError.message);
    }

    console.log('');
    console.log('✅ ═══════════════════════════════════════════════════════════════');
    console.log('✅ CASH COLLECTION COMPLETE');
    console.log('✅ ═══════════════════════════════════════════════════════════════');
    console.log('');

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
      },
      // ✅ Include coin reward info in response (awarded ONLY HERE)
      coinReward: coinReward?.awarded ? {
        coinsAwarded: coinReward.coinsAwarded,
        totalCoins: coinReward.totalCoins,
        tier: coinReward.tier
      } : null
    });

  } catch (err) {
    console.error('🔥 confirmCashCollection error:', err);
    
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

const getActiveRide = async (req, res) => {
  try {
    const { customerId } = req.params;

    console.log(`🔍 Checking active ride for customer: ${customerId}`);

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

    console.log(`✅ Found active ride: ${trip._id}`);

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
        originalFare: trip.originalFare || null,
        discountApplied: trip.discountApplied || 0,
        coinsUsed: trip.coinsUsed || 0,
      },
      driver: trip.assignedDriver ? {
        id: trip.assignedDriver._id.toString(),
        name: trip.assignedDriver.name || 'Driver',
        phone: trip.assignedDriver.phone || 'N/A',
        photoUrl: trip.assignedDriver.photoUrl || null,
        rating: trip.assignedDriver.rating || 4.8,
        vehicleBrand: trip.assignedDriver.vehicleBrand || 'Vehicle',
        vehicleNumber: trip.assignedDriver.vehicleNumber || 'N/A',
        location: trip.assignedDriver.location ? {
          lat: trip.assignedDriver.location.coordinates[1],
          lng: trip.assignedDriver.location.coordinates[0]
        } : null
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

// ✅ UPDATED EXPORTS: Added awardCoinsToCustomer
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
  getDriverActiveTrip,
  getTripByIdWithPayment,
  getActiveRide,
  // ✅ NEW EXPORT:
  awardCoinsToCustomer,
};