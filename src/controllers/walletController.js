// src/controllers/walletController.js - PRODUCTION-READY VERSION
import mongoose from 'mongoose';
import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';

// Configuration
const COMMISSION_PERCENTAGE = 15;
const PAISA_MULTIPLIER = 100; // Store amounts in paisa for precision

/**
 * Convert rupees to paisa (integer)
 */
const toPaisa = (rupees) => Math.round(rupees * PAISA_MULTIPLIER);

/**
 * Convert paisa to rupees (decimal)
 */
const toRupees = (paisa) => paisa / PAISA_MULTIPLIER;

/**
 * Calculate fare breakdown with precision
 */
const calculateFareBreakdown = (tripFare) => {
  const tripFareInPaisa = toPaisa(tripFare);
  const commissionInPaisa = Math.round((tripFareInPaisa * COMMISSION_PERCENTAGE) / 100);
  const driverEarningInPaisa = tripFareInPaisa - commissionInPaisa;

  return {
    tripFare: toRupees(tripFareInPaisa),
    commission: toRupees(commissionInPaisa),
    driverEarning: toRupees(driverEarningInPaisa),
    commissionPercentage: COMMISSION_PERCENTAGE
  };
};

/**
 * Get or create wallet for a driver (with atomic upsert)
 */
const getOrCreateWallet = async (driverId, session = null) => {
  const wallet = await Wallet.findOneAndUpdate(
    { driverId },
    {
      $setOnInsert: {
        driverId,
        totalEarnings: 0,
        totalCommission: 0,
        pendingAmount: 0,
        availableBalance: 0,
        transactions: []
      }
    },
    { 
      upsert: true, 
      new: true,
      session 
    }
  );
  
  return wallet;
};

/**
 * Get wallet details for a driver
 * GET /api/wallet/:driverId
 */
const getWalletByDriverId = async (req, res) => {
  try {
    const { driverId } = req.params;

    // Validate driver ID format
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID format'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    // Get recent transactions (last 20)
    const recentTransactions = wallet.transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);

    res.status(200).json({
      success: true,
      wallet: {
        totalEarnings: Number(wallet.totalEarnings.toFixed(2)),
        totalCommission: Number(wallet.totalCommission.toFixed(2)),
        pendingAmount: Number(wallet.pendingAmount.toFixed(2)),
        availableBalance: Number(wallet.availableBalance.toFixed(2)),
      },
      recentTransactions,
    });
  } catch (err) {
    console.error('🔥 getWalletByDriverId error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Process cash collection after trip completion (with transactions)
 * POST /api/wallet/collect-cash
 */
const processCashCollection = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, driverId } = req.body;

    // Validate input
    if (!mongoose.Types.ObjectId.isValid(tripId) || !mongoose.Types.ObjectId.isValid(driverId)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid trip ID or driver ID format'
      });
    }

    // Validate trip
    const trip = await Trip.findById(tripId).session(session);
    if (!trip) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    if (trip.assignedDriver?.toString() !== driverId) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (trip.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Trip must be completed before collecting cash'
      });
    }

    if (trip.paymentCollected) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Cash already collected for this trip'
      });
    }

    const tripFare = trip.fare || trip.finalFare || 0;

    // Validate fare
    if (tripFare <= 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid trip fare amount'
      });
    }

    // Calculate breakdown with precision
    const fareBreakdown = calculateFareBreakdown(tripFare);

    // Update wallet atomically
    const wallet = await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: {
          totalEarnings: fareBreakdown.driverEarning,
          totalCommission: fareBreakdown.commission,
          pendingAmount: fareBreakdown.commission,
          availableBalance: fareBreakdown.driverEarning
        },
        $push: {
          transactions: {
            $each: [
              {
                type: 'credit',
                amount: fareBreakdown.driverEarning,
                tripId: trip._id,
                description: `Trip earning from ${trip.pickup.address?.substring(0, 30) || 'customer'}`,
                createdAt: new Date()
              },
              {
                type: 'commission',
                amount: fareBreakdown.commission,
                tripId: trip._id,
                description: `Platform commission (${COMMISSION_PERCENTAGE}%)`,
                createdAt: new Date()
              }
            ]
          }
        }
      },
      { 
        new: true, 
        upsert: true,
        session 
      }
    );

    // Mark payment as collected in trip
    trip.paymentCollected = true;
    trip.paymentCollectedAt = new Date();
    await trip.save({ session });

    // Commit transaction
    await session.commitTransaction();

    // Get driver details for socket notification (outside transaction)
    const driver = await User.findById(driverId).select('socketId').lean();

    const walletInfo = {
      totalEarnings: Number(wallet.totalEarnings.toFixed(2)),
      totalCommission: Number(wallet.totalCommission.toFixed(2)),
      pendingAmount: Number(wallet.pendingAmount.toFixed(2)),
      availableBalance: Number(wallet.availableBalance.toFixed(2)),
    };

    // Notify driver via socket
    if (driver?.socketId) {
      io.to(driver.socketId).emit('wallet:updated', {
        fareBreakdown: {
          tripFare: Number(fareBreakdown.tripFare.toFixed(2)),
          commission: Number(fareBreakdown.commission.toFixed(2)),
          commissionPercentage: fareBreakdown.commissionPercentage,
          driverEarning: Number(fareBreakdown.driverEarning.toFixed(2))
        },
        wallet: walletInfo,
        message: 'Cash collected successfully',
      });
    }

    console.log(`✅ Cash collected for trip ${tripId}: ₹${tripFare} (Driver: ₹${fareBreakdown.driverEarning}, Commission: ₹${fareBreakdown.commission})`);

    res.status(200).json({
      success: true,
      message: 'Cash collection confirmed',
      fareBreakdown: {
        tripFare: Number(fareBreakdown.tripFare.toFixed(2)),
        commission: Number(fareBreakdown.commission.toFixed(2)),
        commissionPercentage: fareBreakdown.commissionPercentage,
        driverEarning: Number(fareBreakdown.driverEarning.toFixed(2))
      },
      wallet: walletInfo,
    });
  } catch (err) {
    // Only abort if transaction is still active
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('🔥 processCashCollection error:', err);
    
    // Only send response if not already sent
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to process cash collection',
        error: err.message 
      });
    }
  } finally {
    session.endSession();
  }
};
/**
 * Add manual transaction (for admin/testing)
 * POST /api/wallet/add-transaction
 */
const addTransaction = async (req, res) => {
  try {
    const { driverId, type, amount, description } = req.body;

    if (!['credit', 'debit', 'commission'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid transaction type'
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than zero'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    // Check balance for debit
    if (type === 'debit' && wallet.availableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance'
      });
    }

    // Prepare update operations
    const updateOps = {
      $push: {
        transactions: {
          type,
          amount: Number(amount.toFixed(2)),
          description: description || `${type} transaction`,
          createdAt: new Date()
        }
      }
    };

    // Update balances based on type
    if (type === 'credit') {
      updateOps.$inc = {
        totalEarnings: amount,
        availableBalance: amount
      };
    } else if (type === 'debit') {
      updateOps.$inc = {
        availableBalance: -amount
      };
    } else if (type === 'commission') {
      updateOps.$inc = {
        totalCommission: amount,
        pendingAmount: amount
      };
    }

    const updatedWallet = await Wallet.findOneAndUpdate(
      { driverId },
      updateOps,
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: 'Transaction added successfully',
      wallet: {
        totalEarnings: Number(updatedWallet.totalEarnings.toFixed(2)),
        totalCommission: Number(updatedWallet.totalCommission.toFixed(2)),
        pendingAmount: Number(updatedWallet.pendingAmount.toFixed(2)),
        availableBalance: Number(updatedWallet.availableBalance.toFixed(2)),
      },
    });
  } catch (err) {
    console.error('🔥 addTransaction error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Get transaction history with pagination
 * GET /api/wallet/:driverId/transactions?page=1&limit=20
 */
const getTransactionHistory = async (req, res) => {
  try {
    const { driverId } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const wallet = await getOrCreateWallet(driverId);

    const transactions = wallet.transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(skip, skip + limit);

    const totalTransactions = wallet.transactions.length;
    const totalPages = Math.ceil(totalTransactions / limit);

    res.status(200).json({
      success: true,
      transactions,
      pagination: {
        currentPage: page,
        totalPages,
        totalTransactions,
        hasMore: page < totalPages,
      },
    });
  } catch (err) {
    console.error('🔥 getTransactionHistory error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Pay pending commission (admin/settlement)
 * POST /api/wallet/settle-commission
 */
const settleCommission = async (req, res) => {
  try {
    const { driverId, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than zero'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    if (amount > wallet.pendingAmount) {
      return res.status(400).json({
        success: false,
        message: `Amount exceeds pending commission (₹${wallet.pendingAmount.toFixed(2)})`
      });
    }

    const updatedWallet = await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: { pendingAmount: -amount },
        $push: {
          transactions: {
            type: 'debit',
            amount: Number(amount.toFixed(2)),
            description: 'Commission settlement',
            createdAt: new Date()
          }
        }
      },
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: 'Commission settled successfully',
      wallet: {
        totalEarnings: Number(updatedWallet.totalEarnings.toFixed(2)),
        totalCommission: Number(updatedWallet.totalCommission.toFixed(2)),
        pendingAmount: Number(updatedWallet.pendingAmount.toFixed(2)),
        availableBalance: Number(updatedWallet.availableBalance.toFixed(2)),
      },
    });
  } catch (err) {
    console.error('🔥 settleCommission error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Get wallet statistics
 * GET /api/wallet/:driverId/stats
 */
const getWalletStats = async (req, res) => {
  try {
    const { driverId } = req.params;

    const wallet = await getOrCreateWallet(driverId);

    // Calculate stats from transactions
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const thisWeek = new Date();
    thisWeek.setDate(thisWeek.getDate() - 7);

    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);

    const todayEarnings = wallet.transactions
      .filter(t => t.type === 'credit' && new Date(t.createdAt) >= today)
      .reduce((sum, t) => sum + t.amount, 0);

    const weekEarnings = wallet.transactions
      .filter(t => t.type === 'credit' && new Date(t.createdAt) >= thisWeek)
      .reduce((sum, t) => sum + t.amount, 0);

    const monthEarnings = wallet.transactions
      .filter(t => t.type === 'credit' && new Date(t.createdAt) >= thisMonth)
      .reduce((sum, t) => sum + t.amount, 0);

    const completedTrips = await Trip.countDocuments({
      assignedDriver: driverId,
      status: 'completed',
    });

    res.status(200).json({
      success: true,
      stats: {
        totalEarnings: Number(wallet.totalEarnings.toFixed(2)),
        totalCommission: Number(wallet.totalCommission.toFixed(2)),
        pendingAmount: Number(wallet.pendingAmount.toFixed(2)),
        availableBalance: Number(wallet.availableBalance.toFixed(2)),
        todayEarnings: Number(todayEarnings.toFixed(2)),
        weekEarnings: Number(weekEarnings.toFixed(2)),
        monthEarnings: Number(monthEarnings.toFixed(2)),
        completedTrips,
      },
    });
  } catch (err) {
    console.error('🔥 getWalletStats error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
/**
 * Get today's earnings breakdown for driver dashboard
 * GET /api/wallet/:driverId/today
 */
/**
 * Get today's earnings breakdown for driver dashboard
 * GET /api/wallet/today/:driverId
 */
const getTodayEarnings = async (req, res) => {
  try {
    const { driverId } = req.params;

    // Validate driver ID format
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID format'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    // Get start and end of today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Filter today's transactions
    const todayTransactions = wallet.transactions.filter(t => {
      const transactionDate = new Date(t.createdAt);
      return transactionDate >= startOfDay && transactionDate <= endOfDay;
    });

    // Calculate today's totals
    let totalFares = 0;
    let totalCommission = 0;
    let tripsCompleted = 0;
    const tripIds = new Set();

    todayTransactions.forEach(transaction => {
      if (transaction.type === 'credit') {
        totalFares += transaction.amount;
        // Count unique trips
        if (transaction.tripId && !tripIds.has(transaction.tripId.toString())) {
          tripIds.add(transaction.tripId.toString());
          tripsCompleted++;
        }
      } else if (transaction.type === 'commission') {
        totalCommission += transaction.amount;
      }
    });

    const netEarnings = totalFares; // Total fares already has commission deducted

    // Get today's completed trips count from database (more accurate)
    // ✅ UPDATED QUERY - Uses completedAt OR rideEndTime
    const todayTripsCount = await Trip.countDocuments({
      assignedDriver: driverId,
      status: 'completed',
      $or: [
        { completedAt: { $gte: startOfDay, $lte: endOfDay } },
        { rideEndTime: { $gte: startOfDay, $lte: endOfDay } }
      ]
    });

    // Use the higher count (in case of data inconsistency)
    const finalTripsCount = Math.max(tripsCompleted, todayTripsCount);

    res.status(200).json({
      success: true,
      todayStats: {
        totalFares: Number(totalFares.toFixed(2)),
        totalCommission: Number(totalCommission.toFixed(2)),
        netEarnings: Number(netEarnings.toFixed(2)),
        tripsCompleted: finalTripsCount,
        date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
        breakdown: {
          commissionPercentage: COMMISSION_PERCENTAGE,
          averagePerTrip: finalTripsCount > 0 
            ? Number((totalFares / finalTripsCount).toFixed(2)) 
            : 0
        }
      }
    });
  } catch (err) {
    console.error('🔥 getTodayEarnings error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch today\'s earnings',
      error: err.message 
    });
  }
};
export {
  getWalletByDriverId,
  processCashCollection,
  addTransaction,
  getTransactionHistory,
  settleCommission,
  getWalletStats,
  getOrCreateWallet,
    getTodayEarnings, // ✅ ADD THIS

};
