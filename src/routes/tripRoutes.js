// src/routes/tripRoutes.js

import express from 'express';
import {
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
  confirmCashCollection,} from '../controllers/tripController.js';

const router = express.Router();

/**
 * @route   POST /api/trips/short
 * @desc    Create a short city ride
 */
router.post('/short', createShortTrip);

/**
 * @route   POST /api/trips/parcel
 * @desc    Create a parcel delivery ride
 */
router.post('/parcel', createParcelTrip);

/**
 * @route   POST /api/trips/long
 * @desc    Create a long intercity ride (same-day or scheduled)
 */
router.post('/long', createLongTrip);

/**
 * @route   POST /api/trips/:id/accept
 * @desc    Driver accepts the trip
 */
router.post('/:id/accept', acceptTrip);

/**
 * @route   POST /api/trips/:id/reject
 * @desc    Driver rejects the trip
 */
router.post('/:id/reject', rejectTrip);
router.post('/complete', completeTrip);
router.post('/cancel', cancelTrip);
/**
 * @route   GET /api/trips/:id
 * @desc    Get trip details by ID
 */
router.get('/:id', getTripById);
router.post('/going-to-pickup', goingToPickup);
router.post('/start-ride', startRide);
router.post('/complete-ride', completeRideWithVerification);
router.post('/confirm-cash', confirmCashCollection);

// Add this to your tripRoutes.js for debugging
router.get('/debug/drivers', async (req, res) => {
  try {
    const { lat, lng, maxDistance = 10000, vehicleType = 'bike' } = req.query;
    
    const drivers = await User.find({
      isDriver: true,
      vehicleType,
      isOnline: true,
      location: {
        $near: {
          $geometry: { 
            type: 'Point', 
            coordinates: [parseFloat(lng), parseFloat(lat)] 
          },
          $maxDistance: parseInt(maxDistance),
        },
      },
    }).select('name phone vehicleType location isOnline');

    res.json({ success: true, drivers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
