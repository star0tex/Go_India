import express from 'express';
import { 
  processCashCollection, 
  getWalletByDriverId,
  getTodayEarnings // ✅ ADD THIS
} from '../controllers/walletController.js';

const router = express.Router();

// @route   POST /api/wallet/collect-cash
// @desc    Process cash collection after a trip
router.post('/collect-cash', processCashCollection);
router.get('/today/:driverId', getTodayEarnings);

// @route   GET /api/wallet/:driverId
// @desc    Get wallet details for a driver
router.get('/:driverId', getWalletByDriverId);

// @route   GET /api/wallet/:driverId/today
// @desc    Get today's earnings breakdown for driver dashboard
// ✅ ADD THIS ROUTE (MUST be before /:driverId to avoid route conflict)

export default router;