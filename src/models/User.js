// src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    // =====================================================
    // 📞 BASIC INFO
    // =====================================================
    phone: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
    },
    gender: {
      type: String,
    },
    email: {
      type: String,
    },
    dateOfBirth: {
      type: String,
    },
    emergencyContact: {
      type: String,
    },

    // =====================================================
    // 🔑 ROLE SYSTEM
    // =====================================================
    role: {
      type: String,
      enum: ["customer", "driver"],
      default: "customer",
    },

    // =====================================================
    // 🎁 REWARD SYSTEM FIELDS (Customer)
    // =====================================================
    coins: {
      type: Number,
      default: 0,
      min: 0,
    },
    hasRedeemableDiscount: {
      type: Boolean,
      default: false,
    },
    totalCoinsEarned: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCoinsRedeemed: {
      type: Number,
      default: 0,
      min: 0,
    },

    // =====================================================
    // 🚗 DRIVER-SPECIFIC FIELDS
    // =====================================================
    isDriver: {
      type: Boolean,
      default: false,
      index: true,
    },
    vehicleType: {
      type: String,
      enum: ["bike", "auto", "car", "premium", "xl"],
      default: null,
      index: true,
    },
    city: {
      type: String,
    },

    // =====================================================
    // 📍 LOCATION & STATUS
    // =====================================================
    location: {
      type: {
        type: String,
        enum: ["Point"],
        required: true,
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
        default: undefined, // ✅ No default location
      },
    },

    // ✅ Location sequence tracking (prevents out-of-order updates)
    locationSequence: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },

    // ✅ Last location update timestamp
    lastLocationUpdate: {
      type: Date,
      default: null,
      index: true,
    },

    isOnline: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ✅ Current active trip reference
    currentTripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
      index: true,
    },

    // ✅ Driver availability status
    isBusy: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ✅ Proximity-based requests
    canReceiveNewRequests: {
      type: Boolean,
      default: false,
    },

    // ✅ Cash collection tracking
    awaitingCashCollection: {
      type: Boolean,
      default: false,
      index: true,
    },

    // =====================================================
    // 🔌 SOCKET & REAL-TIME
    // =====================================================
    socketId: {
      type: String,
      default: null,
    },

    // =====================================================
    // 👤 DRIVER PROFILE
    // =====================================================
    rating: {
      type: Number,
      default: 4.8,
      min: 0,
      max: 5,
    },
    vehicleBrand: {
      type: String,
      default: null,
    },
    vehicleNumber: {
      type: String,
      default: null,
    },
    photoUrl: {
      type: String,
      default: null,
    },
    profilePhotoUrl: {
      type: String,
    },

    // =====================================================
    // ✅ VERIFICATION & DOCUMENTS
    // =====================================================
    documentStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    firebaseUid: {
      type: String,
      unique: true,
      sparse: true, // Allows null but ensures uniqueness for non-null
    },

    // =====================================================
    // 🔔 NOTIFICATIONS
    // =====================================================
    fcmToken: {
      type: String,
    },

    // =====================================================
    // ⏰ TIMESTAMP TRACKING
    // =====================================================
    lastTripAcceptedAt: {
      type: Date,
      default: null,
    },
    lastTripCompletedAt: {
      type: Date,
      default: null,
    },
    lastTripCancelledAt: {
      type: Date,
      default: null,
    },
    lastCashCollectedAt: {
      type: Date,
      default: null,
    },
    lastDisconnectedAt: {
      type: Date,
      default: null,
    },

    // =====================================================
    // 💰 INCENTIVE SYSTEM FIELDS (Driver)
    // =====================================================
    totalCoinsCollected: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalIncentiveEarned: {
      type: Number,
      default: 0.0,
      min: 0,
    },
    totalRidesCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastRideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      default: null,
    },
    lastIncentiveAwardedAt: {
      type: Date,
      default: null,
    },
    lastWithdrawal: {
      type: Date,
      default: null,
    },
    wallet: {
      type: Number,
      default: 0.0,
      min: 0,
    },
  },
  {
    timestamps: true,
    minimize: false, // ✅ Keep empty objects
  }
);

// =====================================================
// 📇 INDEXES
// =====================================================

// ✅ Geospatial index for location-based queries
userSchema.index({ location: "2dsphere" });

// ✅ CRITICAL: Compound index for driver availability queries
userSchema.index({
  isDriver: 1,
  isOnline: 1,
  isBusy: 1,
  vehicleType: 1,
  location: "2dsphere",
});

// ✅ Trip assignment index
userSchema.index({
  isDriver: 1,
  currentTripId: 1,
});

// ✅ Cash collection queries
userSchema.index({
  awaitingCashCollection: 1,
  currentTripId: 1,
  lastTripCompletedAt: 1,
});

// ✅ Stale cash collection monitoring
userSchema.index({
  awaitingCashCollection: 1,
  lastTripCompletedAt: 1,
});

// ✅ Customer reward queries
userSchema.index({
  role: 1,
  coins: 1,
  hasRedeemableDiscount: 1,
});

// ✅ Location tracking performance
userSchema.index({
  isDriver: 1,
  isOnline: 1,
  locationSequence: 1,
  lastLocationUpdate: 1,
});

// ✅ Stale location data detection
userSchema.index({
  isOnline: 1,
  lastLocationUpdate: 1,
});

// ✅ Prevent OverwriteModelError in dev
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;