// src/controllers/locationController.js
import User from '../models/User.js';

// Helper to resolve by id or phone
const resolveUserByIdOrPhone = async (idOrPhone) => {
  if (!idOrPhone) return null;
  if (typeof idOrPhone === 'string' && /^[0-9a-fA-F]{24}$/.test(idOrPhone)) {
    const byId = await User.findById(idOrPhone);
    if (byId) return byId;
  }
  return await User.findOne({ phone: idOrPhone });
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
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });

    const coords = coordinates && Array.isArray(coordinates) && coordinates.length === 2
      ? coordinates
      : (typeof latitude === 'number' && typeof longitude === 'number' ? [longitude, latitude] : null);

    if (!coords) {
      return res.status(400).json({ success: false, message: 'coordinates or latitude/longitude required.' });
    }

    await User.findByIdAndUpdate(user._id, {
      location: {
        type: 'Point',
        coordinates: coords,
      },
    });

    res.status(200).json({ success: true, message: 'Driver location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateDriverLocation: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to update driver location.' });
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
    if (!user) return res.status(404).json({ success: false, message: 'Customer not found.' });

    const coords = coordinates && Array.isArray(coordinates) && coordinates.length === 2
      ? coordinates
      : (typeof latitude === 'number' && typeof longitude === 'number' ? [longitude, latitude] : null);

    if (!coords) {
      return res.status(400).json({ success: false, message: 'coordinates or latitude/longitude required.' });
    }

    await User.findByIdAndUpdate(user._id, {
      location: {
        type: 'Point',
        coordinates: coords,
      },
    });

    res.status(200).json({ success: true, message: 'Customer location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateCustomerLocation: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to update customer location.' });
  }
};

/**
 * Get latest driver location
 * returns: { success:true, location: geojson, latitude: ..., longitude: ... }
 */
const getDriverLocation = async (req, res) => {
  try {
    const { driverId } = req.params;
    const user = await resolveUserByIdOrPhone(driverId);
    if (!user || !user.location) {
      return res.status(404).json({ success: false, message: 'Driver not found or location missing.' });
    }

    const [lng, lat] = user.location.coordinates || [null, null];
    res.status(200).json({ success: true, location: user.location, latitude: lat, longitude: lng });
  } catch (err) {
    console.error(`❌ Error in getDriverLocation: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch driver location.' });
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
    res.status(200).json({ success: true, location: user.location, latitude: lat, longitude: lng });
  } catch (err) {
    console.error(`❌ Error in getCustomerLocation: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch customer location.' });
  }
};

export {
  updateDriverLocation,
  updateCustomerLocation,
  getDriverLocation,
  getCustomerLocation,
};
