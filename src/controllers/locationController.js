// src/controllers/locationController.js
import User from '../models/User.js';
import Trip from '../models/Trip.js';
import { io } from '../server.js'; 

/**
 * Resolve a user by MongoDB ObjectId or phone number
 */
const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;

  // If it's a valid Mongo ObjectId
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }

  // Else try finding by phone
  return await User.findOne({ phone: idOrPhone });
};

/**
 * Common function to build coordinates
 */
const buildCoordinates = (coordinates, latitude, longitude) => {
  if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
    return coordinates;
  }
  if (typeof latitude === 'number' && typeof longitude === 'number') {
    return [longitude, latitude]; // GeoJSON expects [lng, lat]
  }
  return null;
};

/**
 * Update driver location + emit socket event
 */
const updateDriverLocation = async (req, res) => {
  try {
    const { driverId, tripId, coordinates, latitude, longitude } = req.body;

    const user = await resolveUserByIdOrPhone(driverId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Driver not found.' });
    }

    const coords = buildCoordinates(coordinates, latitude, longitude);
    if (!coords) {
      return res.status(400).json({ success: false, message: 'Coordinates required.' });
    }

    // Save in DB
    await User.findByIdAndUpdate(user._id, {
      location: { type: 'Point', coordinates: coords },
      updatedAt: new Date(),
    });

    // ✅ Broadcast live driver location to customer of this trip
    if (tripId) {
      const trip = await Trip.findById(tripId);
      if (trip && trip.customerId) {
        const customer = await User.findById(trip.customerId);
        if (customer?.socketId) {
          io.to(customer.socketId).emit('location:update_driver', {
            tripId,
            driverId,
            latitude: coords[1],
            longitude: coords[0],
          });
        }
      }
    }

    return res.status(200).json({ success: true, message: 'Driver location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateDriverLocation: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to update driver location.' });
  }
};

/**
 * Update customer location & broadcast to driver
 */
const updateCustomerLocation = async (req, res) => {
  try {
    const { customerId, tripId, coordinates, latitude, longitude } = req.body;

    // 🔹 Resolve customer (either by _id or phone)
    const user = await resolveUserByIdOrPhone(customerId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    // 🔹 Normalize coordinates
    const coords = buildCoordinates(coordinates, latitude, longitude);
    if (!coords) {
      return res.status(400).json({ success: false, message: 'Coordinates required.' });
    }

    // 🔹 Save current location in DB
    await User.findByIdAndUpdate(user._id, {
      location: { type: 'Point', coordinates: coords },
      updatedAt: new Date(),
    });

    // 🔹 Broadcast to driver if trip is active
    if (tripId) {
      const trip = await Trip.findById(tripId);
      if (trip && trip.assignedDriver) {
        const driver = await User.findById(trip.assignedDriver);
        if (driver?.socketId) {
          io.to(driver.socketId).emit('location:update_customer', {
            tripId,
            customerId: user._id,
            latitude: coords[1],
            longitude: coords[0],
          });
          console.log(
            `📡 Sent customer ${user._id} live location to driver ${trip.assignedDriver}`
          );
        } else {
          console.warn(`⚠️ No active socket found for driver ${trip.assignedDriver}`);
        }
      }
    }

    return res
      .status(200)
      .json({ success: true, message: 'Customer location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateCustomerLocation: ${err.stack}`);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to update customer location.' });
  }
};

/**
 * Get latest driver location
 */
const getDriverLocation = async (req, res) => {
  try {
    const { driverId } = req.params;
    const user = await resolveUserByIdOrPhone(driverId);

    if (!user || !user.location) {
      return res.status(404).json({ success: false, message: 'Driver not found or location missing.' });
    }

    const [lng, lat] = user.location.coordinates || [null, null];
    return res.status(200).json({
      success: true,
      location: user.location,
      latitude: lat,
      longitude: lng,
    });
  } catch (err) {
    console.error(`❌ Error in getDriverLocation: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch driver location.' });
  }
};

/**
 * Get latest customer location
 */
/**
 * Get latest customer location
 */
/**
 * Get latest customer location
 */
const getCustomerLocation = async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🔍 Looking up customer location for ID: ${id}`);
    
    const user = await resolveUserByIdOrPhone(id);
    console.log(`🔍 User found: ${user ? user._id : 'None'}`);

    if (!user) {
      console.log(`❌ Customer not found: ${id}`);
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    if (!user.location || !user.location.coordinates) {
      console.log(`⚠️ Customer found but no location data: ${user._id}`);
      return res.status(200).json({
        success: true,
        message: 'Customer location not available',
        location: null,
        latitude: null,
        longitude: null
      });
    }

    const [lng, lat] = user.location.coordinates;
    console.log(`✅ Customer location found: ${lat}, ${lng}`);
    
    return res.status(200).json({
      success: true,
      customerId: user._id,
      latitude: lat,
      longitude: lng,
    });
  } catch (err) {
    console.error(`❌ Error in getCustomerLocation: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch customer location.' });
  }
};
export {
  updateDriverLocation,
  updateCustomerLocation,
  getDriverLocation,
  getCustomerLocation,
};