// models/Wallet.js
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  tripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
  },
  type: {
    type: String,
    enum: ['credit', 'debit', 'commission'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  description: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const walletSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  // ✅ ADD THIS FIELD
  availableBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  balance: {
    type: Number,
    default: 0,
    min: 0
  },
  totalEarnings: {
    type: Number,
    default: 0
  },
  totalCommission: {
    type: Number,
    default: 0
  },
  pendingAmount: {
    type: Number,
    default: 0
  },
  transactions: [transactionSchema],
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for faster queries
walletSchema.index({ driverId: 1 });
walletSchema.index({ 'transactions.tripId': 1 });

export default mongoose.model('Wallet', walletSchema);