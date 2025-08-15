// src/controllers/locationController.js
import User from '../models/User.js';

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
 * Update driver location
 * Accepts body:
 * - { driverId, coordinates: [lng,lat] }
 * - OR { driverId, latitude, longitude }
 */
const updateDriverLocation = async (req, res) => {
  try {
    const { driverId, coordinates, latitude, longitude } = req.body;

    const user = await resolveUserByIdOrPhone(driverId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Driver not found.' });
    }

    const coords = buildCoordinates(coordinates, latitude, longitude);
    if (!coords) {
      return res.status(400).json({ success: false, message: 'Coordinates or latitude/longitude required.' });
    }

    await User.findByIdAndUpdate(user._id, {
      location: {
        type: 'Point',
        coordinates: coords,
      },
      updatedAt: new Date(), // optional: track when location updated
    });

    return res.status(200).json({ success: true, message: 'Driver location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateDriverLocation: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to update driver location.' });
  }
};

/**
 * Update customer location
 * Accepts body:
 * - { customerId, coordinates: [lng,lat] }
 * - OR { customerId, latitude, longitude }
 */
const updateCustomerLocation = async (req, res) => {
  try {
    const { customerId, coordinates, latitude, longitude } = req.body;

    const user = await resolveUserByIdOrPhone(customerId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    const coords = buildCoordinates(coordinates, latitude, longitude);
    if (!coords) {
      return res.status(400).json({ success: false, message: 'Coordinates or latitude/longitude required.' });
    }

    await User.findByIdAndUpdate(user._id, {
      location: {
        type: 'Point',
        coordinates: coords,
      },
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, message: 'Customer location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateCustomerLocation: ${err.stack}`);
    return res.status(500).json({ success: false, message: 'Failed to update customer location.' });
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
const getCustomerLocation = async (req, res) => {
  try {
    const { customerId } = req.params;
    const user = await resolveUserByIdOrPhone(customerId);

    if (!user || !user.location) {
      return res.status(404).json({ success: false, message: 'Customer not found or location missing.' });
    }

    const [lng, lat] = user.location.coordinates || [null, null];
    return res.status(200).json({
      success: true,
      location: user.location,
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
