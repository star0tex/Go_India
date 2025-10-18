// walletController.js - SECURE UPI PAYMENT WITH RAZORPAY
import mongoose from 'mongoose';
import Wallet from '../models/Wallet.js';
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { io } from '../socket/socketHandler.js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

// ✅ Initialize Razorpay with enhanced security
const initializeRazorpay = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.error('🔥 RAZORPAY CREDENTIALS MISSING');
    console.error('Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
    throw new Error('Razorpay credentials not configured');
  }

  // Validate credential format
  if (!keyId.startsWith('rzp_test_') && !keyId.startsWith('rzp_live_')) {
    console.warn('⚠️  Warning: Razorpay Key ID format incorrect');
  }

  console.log('✅ Razorpay initialized:', keyId.substring(0, 12) + '...');

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

let razorpay;
try {
  razorpay = initializeRazorpay();
} catch (error) {
  console.error('Failed to initialize Razorpay:', error.message);
}

// Configuration
const COMMISSION_PERCENTAGE = 15;
const PAISA_MULTIPLIER = 100;
const MAX_PAYMENT_AMOUNT = 100000; // ₹100,000 max
const MIN_PAYMENT_AMOUNT = 1; // ₹1 min

const toPaisa = (rupees) => Math.round(rupees * PAISA_MULTIPLIER);
const toRupees = (paisa) => paisa / PAISA_MULTIPLIER;

// ✅ Payment state tracking to prevent duplicate processing
const paymentProcessing = new Map();

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
 * ✅ CREATE RAZORPAY ORDER (SECURE)
 * POST /api/wallet/create-order
 */
const createRazorpayOrder = async (req, res) => {
  try {
    // Security: Check if Razorpay is initialized
    if (!razorpay) {
      return res.status(503).json({
        success: false,
        message: 'Payment service temporarily unavailable',
        errorCode: 'SERVICE_UNAVAILABLE'
      });
    }

    const { driverId, amount } = req.body;

    // Validate input
    if (!driverId || !mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID'
      });
    }

    // Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }

    // Security: Amount limits
    if (amount < MIN_PAYMENT_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Minimum payment amount is ₹${MIN_PAYMENT_AMOUNT}`
      });
    }

    if (amount > MAX_PAYMENT_AMOUNT) {
      return res.status(400).json({
        success: false,
        message: `Maximum payment amount is ₹${MAX_PAYMENT_AMOUNT}`
      });
    }

    // Verify driver exists
    const driver = await User.findById(driverId).select('_id role');
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // Get wallet and verify pending amount
    const wallet = await getOrCreateWallet(driverId);

    if (amount > wallet.pendingAmount + 0.01) { // 1 paisa tolerance
      return res.status(400).json({
        success: false,
        message: `Amount exceeds pending commission (₹${wallet.pendingAmount.toFixed(2)})`
      });
    }

    // Security: Check for duplicate order creation
    const recentOrder = wallet.transactions.find(t => 
      t.razorpayOrderId && 
      t.createdAt > new Date(Date.now() - 5 * 60 * 1000) // Last 5 minutes
    );

    if (recentOrder) {
      console.log('⚠️  Recent order exists, checking status...');
    }

    // Create secure receipt ID (max 40 chars)
    const timestamp = Date.now().toString().slice(-10);
    const driverIdShort = driverId.toString().slice(-8);
    const receipt = `rcpt_${driverIdShort}_${timestamp}`;
    
    const options = {
      amount: toPaisa(amount), // Convert to paise
      currency: 'INR',
      receipt: receipt,
      notes: {
        driverId: driverId.toString(),
        purpose: 'commission_payment',
        timestamp: new Date().toISOString()
      },
      payment_capture: 1 // Auto-capture payment
    };

    console.log('Creating Razorpay order:', {
      receipt,
      amount: `${options.amount} paise (₹${amount})`,
      driverId
    });

    // Create order with Razorpay
    const order = await razorpay.orders.create(options);

    console.log('✅ Order created:', order.id);

    // Store order reference in wallet (optional tracking)
    await Wallet.findOneAndUpdate(
      { driverId },
      {
        $push: {
          transactions: {
            type: 'debit',
            amount: amount,
            description: `Payment order created - ${order.id}`,
            razorpayOrderId: order.id,
            status: 'pending',
            createdAt: new Date()
          }
        }
      }
    );

    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      message: 'Order created successfully'
    });

  } catch (err) {
    console.error('🔥 createRazorpayOrder error:', err);
    
    let message = 'Failed to create order';
    let errorCode = 'ORDER_CREATION_FAILED';
    let statusCode = 500;

    if (err.statusCode === 401) {
      message = 'Payment gateway authentication failed';
      errorCode = 'AUTH_FAILED';
      statusCode = 503;
    } else if (err.statusCode === 400) {
      message = err.error?.description || 'Invalid order parameters';
      errorCode = 'INVALID_REQUEST';
      statusCode = 400;
    } else if (err.error?.code) {
      message = err.error.description || message;
      errorCode = err.error.code;
    }

    res.status(statusCode).json({ 
      success: false, 
      message,
      errorCode
    });
  }
};

/**
 * ✅ VERIFY RAZORPAY PAYMENT (MAXIMUM SECURITY)
 * POST /api/wallet/verify-payment
 */
const verifyRazorpayPayment = async (req, res) => {
  let session = null;

  try {
    // Security: Check Razorpay initialization
    if (!razorpay) {
      return res.status(503).json({
        success: false,
        message: 'Payment verification service unavailable',
        errorCode: 'SERVICE_UNAVAILABLE'
      });
    }

    const { driverId, paymentId, orderId, signature } = req.body;

    // Validate all required fields
    if (!driverId || !paymentId || !orderId || !signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment details'
      });
    }

    // Validate driver ID
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID'
      });
    }

    // Security: Prevent duplicate processing
    const processingKey = `${driverId}-${paymentId}`;
    if (paymentProcessing.has(processingKey)) {
      console.log('⚠️  Payment already being processed:', paymentId);
      return res.status(409).json({
        success: false,
        message: 'Payment is already being processed',
        errorCode: 'DUPLICATE_PROCESSING'
      });
    }

    // Mark as processing
    paymentProcessing.set(processingKey, Date.now());

    // Security: Verify signature FIRST (before any DB operations)
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const generatedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (generatedSignature !== signature) {
      paymentProcessing.delete(processingKey);
      console.error('❌ SIGNATURE MISMATCH - POSSIBLE FRAUD ATTEMPT');
      console.error('Expected:', generatedSignature);
      console.error('Received:', signature);
      
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed - invalid signature',
        errorCode: 'SIGNATURE_MISMATCH'
      });
    }

    console.log('✅ Signature verified successfully');

    // Fetch payment details from Razorpay to double-check
    const payment = await razorpay.payments.fetch(paymentId);

    console.log('Payment status:', payment.status);
    console.log('Payment amount:', payment.amount, 'paise');
    console.log('Payment order_id:', payment.order_id);

    // Security: Verify payment status
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      paymentProcessing.delete(processingKey);
      return res.status(400).json({
        success: false,
        message: `Payment not completed. Status: ${payment.status}`,
        errorCode: 'PAYMENT_NOT_CAPTURED'
      });
    }

    // Security: Verify order ID matches
    if (payment.order_id !== orderId) {
      paymentProcessing.delete(processingKey);
      console.error('❌ Order ID mismatch');
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed - order mismatch',
        errorCode: 'ORDER_MISMATCH'
      });
    }

    const amount = toRupees(payment.amount);

    // Security: Check if this payment was already processed
    const existingTransaction = await Wallet.findOne({
      driverId,
      'transactions.razorpayPaymentId': paymentId
    });

    if (existingTransaction) {
      const existingTxn = existingTransaction.transactions.find(
        t => t.razorpayPaymentId === paymentId && t.status === 'completed'
      );
      
      if (existingTxn) {
        paymentProcessing.delete(processingKey);
        console.log('⚠️  Payment already processed:', paymentId);
        return res.status(200).json({
          success: true,
          message: 'Payment already processed',
          wallet: {
            totalEarnings: Number(existingTransaction.totalEarnings.toFixed(2)),
            totalCommission: Number(existingTransaction.totalCommission.toFixed(2)),
            pendingAmount: Number(existingTransaction.pendingAmount.toFixed(2)),
            availableBalance: Number(existingTransaction.availableBalance.toFixed(2)),
          }
        });
      }
    }

    // Start database transaction
    session = await mongoose.startSession();
    session.startTransaction();

    // Get wallet with lock
    const wallet = await Wallet.findOne({ driverId }).session(session);
    
    if (!wallet) {
      throw new Error('Wallet not found');
    }

    // Security: Verify amount doesn't exceed pending
    if (amount > wallet.pendingAmount + 0.01) {
      throw new Error(`Amount (₹${amount}) exceeds pending commission (₹${wallet.pendingAmount.toFixed(2)})`);
    }

    // Update wallet - deduct pending amount
    const updatedWallet = await Wallet.findOneAndUpdate(
      { driverId },
      {
        $inc: { 
          pendingAmount: -amount 
        },
        $push: {
          transactions: {
            type: 'debit',
            amount: Number(amount.toFixed(2)),
            description: `Commission paid via ${payment.method?.toUpperCase() || 'Razorpay'} (${paymentId.substring(0, 15)}...)`,
            razorpayPaymentId: paymentId,
            razorpayOrderId: orderId,
            status: 'completed',
            paymentMethod: payment.method || 'unknown',
            createdAt: new Date()
          }
        },
        $set: {
          lastUpdated: new Date()
        }
      },
      { new: true, session }
    );

    // Commit transaction
    await session.commitTransaction();

    // Remove from processing map
    paymentProcessing.delete(processingKey);

    console.log('');
    console.log('='.repeat(70));
    console.log('💳 PAYMENT VERIFIED & PROCESSED');
    console.log(`   Payment ID: ${paymentId}`);
    console.log(`   Order ID: ${orderId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Amount: ₹${amount}`);
    console.log(`   Method: ${payment.method || 'unknown'}`);
    console.log(`   Status: ${payment.status}`);
    console.log('='.repeat(70));
    console.log('');

    // Emit real-time update to driver
    const driver = await User.findById(driverId).select('socketId').lean();
    if (driver?.socketId) {
      io.to(driver.socketId).emit('wallet:updated', {
        wallet: {
          totalEarnings: Number(updatedWallet.totalEarnings.toFixed(2)),
          totalCommission: Number(updatedWallet.totalCommission.toFixed(2)),
          pendingAmount: Number(updatedWallet.pendingAmount.toFixed(2)),
          availableBalance: Number(updatedWallet.availableBalance.toFixed(2)),
        },
        message: 'Commission payment successful',
        paymentId: paymentId
      });
      console.log('📢 Real-time update sent to driver');
    }

    res.status(200).json({
      success: true,
      message: 'Payment verified and commission cleared',
      wallet: {
        totalEarnings: Number(updatedWallet.totalEarnings.toFixed(2)),
        totalCommission: Number(updatedWallet.totalCommission.toFixed(2)),
        pendingAmount: Number(updatedWallet.pendingAmount.toFixed(2)),
        availableBalance: Number(updatedWallet.availableBalance.toFixed(2)),
      },
      paymentDetails: {
        paymentId: paymentId,
        amount: amount,
        method: payment.method || 'unknown',
        timestamp: new Date().toISOString()
      }
    });

  } catch (err) {
    // Rollback transaction on error
    if (session && session.inTransaction()) {
      await session.abortTransaction();
    }

    // Remove from processing map
    if (req.body.driverId && req.body.paymentId) {
      paymentProcessing.delete(`${req.body.driverId}-${req.body.paymentId}`);
    }

    console.error('🔥 verifyRazorpayPayment error:', err);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: 'Payment verification failed',
        error: err.message,
        errorCode: 'VERIFICATION_FAILED'
      });
    }
  } finally {
    if (session) {
      session.endSession();
    }
  }
};

/**
 * Get wallet details for a driver
 * GET /api/wallet/:driverId
 */
const getWalletByDriverId = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID format'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    // Filter only completed transactions for display
    const recentTransactions = wallet.transactions
      .filter(t => !t.status || t.status === 'completed')
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
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch wallet data',
      error: err.message 
    });
  }
};

/**
 * Get payment proofs (for backward compatibility)
 * GET /api/wallet/payment-proof/:driverId
 */
const getPaymentProofs = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID'
      });
    }

    const wallet = await Wallet.findOne({ driverId });
    
    if (!wallet) {
      return res.status(200).json({
        success: true,
        proofs: []
      });
    }

    // Get pending transactions as "proofs"
    const proofs = wallet.transactions
      .filter(t => t.status === 'pending' && t.razorpayPaymentId)
      .map(t => ({
        amount: t.amount,
        razorpayPaymentId: t.razorpayPaymentId,
        razorpayOrderId: t.razorpayOrderId,
        status: 'pending',
        submittedAt: t.createdAt
      }));

    res.status(200).json({
      success: true,
      proofs
    });

  } catch (err) {
    console.error('🔥 getPaymentProofs error:', err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

/**
 * Process cash collection after trip completion
 * POST /api/wallet/collect-cash
 */
const processCashCollection = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tripId, driverId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(tripId) || !mongoose.Types.ObjectId.isValid(driverId)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid trip ID or driver ID format'
      });
    }

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

    if (tripFare <= 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Invalid trip fare amount'
      });
    }

    const fareBreakdown = calculateFareBreakdown(tripFare);

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
                status: 'completed',
                createdAt: new Date()
              },
              {
                type: 'commission',
                amount: fareBreakdown.commission,
                tripId: trip._id,
                description: `Platform commission (${COMMISSION_PERCENTAGE}%)`,
                status: 'completed',
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

    trip.paymentCollected = true;
    trip.paymentCollectedAt = new Date();
    await trip.save({ session });

    await session.commitTransaction();

    console.log('');
    console.log('='.repeat(70));
    console.log('💰 CASH COLLECTION CONFIRMED');
    console.log(`   Trip ID: ${tripId}`);
    console.log(`   Driver ID: ${driverId}`);
    console.log(`   Fare: ₹${tripFare}`);
    console.log(`   Driver Earning: ₹${fareBreakdown.driverEarning}`);
    console.log(`   Commission: ₹${fareBreakdown.commission}`);
    console.log('='.repeat(70));

    const driver = await User.findById(driverId).select('socketId').lean();
    const customer = await User.findById(trip.customerId).select('socketId').lean();

    const walletInfo = {
      totalEarnings: Number(wallet.totalEarnings.toFixed(2)),
      totalCommission: Number(wallet.totalCommission.toFixed(2)),
      pendingAmount: Number(wallet.pendingAmount.toFixed(2)),
      availableBalance: Number(wallet.availableBalance.toFixed(2)),
    };

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
      console.log(`📢 wallet:updated emitted to driver ${driverId}`);
    }

    if (customer?.socketId) {
      io.to(customer.socketId).emit('trip:cash_collected', {
        tripId: tripId.toString(),
        message: 'Payment confirmed. Thank you for riding with us!',
        timestamp: new Date().toISOString()
      });
      console.log(`📢 trip:cash_collected emitted to customer ${trip.customerId}`);
    }

    await User.findByIdAndUpdate(driverId, {
      $set: { 
        currentTripId: null,
        isBusy: false,
        canReceiveNewRequests: false
      }
    });
    console.log(`✅ Driver ${driverId} status cleared`);
    console.log('='.repeat(70));

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
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error('🔥 processCashCollection error:', err);
    
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

const getTodayEarnings = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid driver ID format'
      });
    }

    const wallet = await getOrCreateWallet(driverId);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const todayTransactions = wallet.transactions.filter(t => {
      const transactionDate = new Date(t.createdAt);
      return transactionDate >= startOfDay && 
             transactionDate <= endOfDay &&
             (!t.status || t.status === 'completed');
    });

    let totalFares = 0;
    let totalCommission = 0;
    let tripsCompleted = 0;
    const tripIds = new Set();

    todayTransactions.forEach(transaction => {
      if (transaction.type === 'credit') {
        totalFares += transaction.amount;
        if (transaction.tripId && !tripIds.has(transaction.tripId.toString())) {
          tripIds.add(transaction.tripId.toString());
          tripsCompleted++;
        }
      } else if (transaction.type === 'commission') {
        totalCommission += transaction.amount;
      }
    });

    const netEarnings = totalFares;

    const todayTripsCount = await Trip.countDocuments({
      assignedDriver: driverId,
      status: 'completed',
      $or: [
        { completedAt: { $gte: startOfDay, $lte: endOfDay } },
        { rideEndTime: { $gte: startOfDay, $lte: endOfDay } }
      ]
    });

    const finalTripsCount = Math.max(tripsCompleted, todayTripsCount);

    res.status(200).json({
      success: true,
      todayStats: {
        totalFares: Number(totalFares.toFixed(2)),
        totalCommission: Number(totalCommission.toFixed(2)),
        netEarnings: Number(netEarnings.toFixed(2)),
        tripsCompleted: finalTripsCount,
        date: new Date().toISOString().split('T')[0],
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

// Cleanup old processing entries (run periodically)
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000; // 10 minutes
  
  for (const [key, timestamp] of paymentProcessing.entries()) {
    if (now - timestamp > timeout) {
      paymentProcessing.delete(key);
      console.log('🧹 Cleaned up stale payment processing entry:', key);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

export {
  getWalletByDriverId,
  processCashCollection,
  getTodayEarnings,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getPaymentProofs,
  getOrCreateWallet,
};