import express from "express";
import { uploadDriverProfilePhoto } from "../controllers/driverProfileController.js";
import { uploadDriverDocument, getDriverDocuments, getDriverById } from "../controllers/documentController.js";
import { protect } from "../middlewares/authMiddleware.js";
import { uploadDocument, uploadProfilePhoto } from "../middlewares/multer.js";
import { updateDriverVehicleType } from "../controllers/driverController.js";
import User from "../models/User.js"; // ✅ Import User model for nearby drivers query

const router = express.Router();

/**
 * @route   GET /api/driver/nearby
 * @desc    Get nearby online drivers within specified radius
 * @access  Protected
 * @query   lat (required) - Latitude
 * @query   lng (required) - Longitude  
 * @query   radius (optional) - Search radius in km (default: 2)
 */
router.get("/nearby", protect, async (req, res) => {
  try {
    const { lat, lng, radius = 2 } = req.query;

    // Validate required parameters
    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude are required',
      });
    }

    // Parse and validate numeric values
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm = parseFloat(radius);

    if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusKm)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid coordinate or radius values',
      });
    }

    // Validate coordinate ranges
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({
        success: false,
        message: 'Coordinates out of valid range',
      });
    }

    console.log(`🔍 Searching for drivers near: [${latitude}, ${longitude}] within ${radiusKm}km`);

    // Find nearby online drivers using geospatial query
    const drivers = await User.find({
      isDriver: true,
      isOnline: true,
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [longitude, latitude], // GeoJSON format: [lng, lat]
          },
          $maxDistance: radiusKm * 1000, // Convert km to meters
        },
      },
    })
    .select('name phone vehicleType location rating vehicleBrand vehicleNumber')
    .limit(50) // Limit to 50 nearest drivers
    .lean();

    console.log(`✅ Found ${drivers.length} nearby drivers`);

    // Format response for Flutter app
    const formattedDrivers = drivers.map(driver => ({
      id: driver._id.toString(),
      name: driver.name || 'Driver',
      phone: driver.phone || '',
      vehicleType: driver.vehicleType || 'bike',
      lat: driver.location.coordinates[1], // Convert to [lat, lng] for Flutter
      lng: driver.location.coordinates[0],
      rating: driver.rating || 4.5,
      vehicleBrand: driver.vehicleBrand || '',
      vehicleNumber: driver.vehicleNumber || '',
    }));

    return res.status(200).json(formattedDrivers);

  } catch (error) {
    console.error('❌ Error in /api/driver/nearby:', error);
    
    // Handle specific MongoDB errors
    if (error.name === 'MongoError' && error.code === 27) {
      return res.status(500).json({
        success: false,
        message: 'Geospatial index not found. Please ensure location field has a 2dsphere index.',
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch nearby drivers',
      error: error.message,
    });
  }
});

/**
 * @route   POST /api/driver/setVehicleType
 * @desc    Update driver's vehicle type
 * @access  Protected
 */
router.post("/setVehicleType", protect, updateDriverVehicleType);

/**
 * @route   GET /api/driver/:driverId
 * @desc    Get driver details by ID
 * @access  Protected
 */
router.get("/:driverId", protect, getDriverById);

/**
 * @route   GET /api/driver/documents/:driverId
 * @desc    Get driver documents by driver ID
 * @access  Protected
 */
router.get("/documents/:driverId", protect, getDriverDocuments);

/**
 * @route   POST /api/driver/uploadProfilePhoto
 * @desc    Upload driver profile photo
 * @access  Protected
 */
router.post(
  "/uploadProfilePhoto",
  protect,
  uploadProfilePhoto.single("image"),
  uploadDriverProfilePhoto
);

/**
 * @route   POST /api/driver/uploadDocument
 * @desc    Upload driver verification document
 * @access  Protected
 */
router.post(
  "/uploadDocument",
  protect,
  uploadDocument.single("document"),
  uploadDriverDocument
);

export default router;