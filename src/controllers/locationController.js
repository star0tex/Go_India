// src/controllers/locationController.js
import User from '../models/User.js';

/**
 * Update live location of a driver
 * @route POST /api/location/driver
 */
const updateDriverLocation = async (req, res) => {
  try {
    const { driverId, coordinates } = req.body;

    await User.findByIdAndUpdate(driverId, {
      location: {
        type: 'Point',
        coordinates,
      },
    });

    res.status(200).json({ success: true, message: 'Driver location updated.' });
  } catch (err) {
    console.error(`❌ Error in updateDriverLocation: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to update driver location.' });
  }
};

/**
 * Update live location of a customer
 * @route POST /api/location/customer
 */
const updateCustomerLocation = async (req, res) => {
  try {
    const { customerId, coordinates } = req.body;

    await User.findByIdAndUpdate(customerId, {
      location: {
        type: 'Point',
        coordinates,
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
 * @route GET /api/location/driver/:driverId
 */
const getDriverLocation = async (req, res) => {
  try {
    const { driverId } = req.params;

    const driver = await User.findById(driverId).select('location');
    if (!driver) {
      return res.status(404).json({ success: false, message: 'Driver not found.' });
    }

    res.status(200).json({ success: true, location: driver.location });
  } catch (err) {
    console.error(`❌ Error in getDriverLocation: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch driver location.' });
  }
};

/**
 * Get latest customer location
 * @route GET /api/location/customer/:customerId
 */
const getCustomerLocation = async (req, res) => {
  try {
    const { customerId } = req.params;

    const customer = await User.findById(customerId).select('location');
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    res.status(200).json({ success: true, location: customer.location });
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
