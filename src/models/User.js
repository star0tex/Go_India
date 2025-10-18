// src/models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    // 📞 Basic Info
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

    // 🔑 Role system
    role: {
      type: String,
      enum: ["customer", "driver"],
      default: "customer",
    },

    // 🚗 Driver-specific
    isDriver: {
      type: Boolean,
      default: false,
      index: true, // ✅ Index for driver queries
    },
    vehicleType: {
      type: String,
      enum: ["bike", "auto", "car", "premium", "xl"],
      default: null,
      index: true, // ✅ Index for vehicle type filtering
    },
    city: {
      type: String,
    },

    // 📍 Location & Status
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: true,
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },

    isOnline: {
      type: Boolean,
      default: false,
      index: true, // ✅ Index for online/offline queries
    },

    // ✅ FIXED: Single definition of currentTripId with all features
    currentTripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trip',
      default: null,
      index: true, // ✅ Important for query performance
    },

    // ✅ Driver availability status
    isBusy: {
      type: Boolean,
      default: false,
      index: true, // ✅ Index for availability queries
    },

    // ✅ Proximity-based requests (Requirement #6)
    canReceiveNewRequests: {
      type: Boolean,
      default: false,
    },

    // ✅ NEW: Cash collection tracking
    awaitingCashCollection: {
      type: Boolean,
      default: false,
      index: true, // ✅ Important for disconnect handler queries
    },

    // ✅ Socket and real-time
    socketId: {
      type: String,
      default: null,
    },

    // ✅ Driver profile
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

    // ✅ Verification & Documents
    documentStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    firebaseUid: {
      type: String,
      unique: true,
      sparse: true, // Allows null values but ensures uniqueness for non-null
    },

    // 🔔 Notifications
    fcmToken: {
      type: String,
    },

    // ✅ Timestamps for debugging and cash collection tracking
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
      default: null, // ✅ NEW: Track when cash was last collected
    },
    lastDisconnectedAt: {
      type: Date,
      default: null, // ✅ Track socket disconnections
    },
  },
  { 
    timestamps: true,
    // ✅ Optimize for updates
    minimize: false, // Keep empty objects
  }
);

// ✅ CRITICAL: Compound index for driver availability queries
userSchema.index({ 
  isDriver: 1, 
  isOnline: 1, 
  isBusy: 1, 
  vehicleType: 1, 
  location: '2dsphere' 
});

// ✅ Additional index for trip assignment
userSchema.index({ 
  isDriver: 1, 
  currentTripId: 1 
});

// ✅ NEW: Index for cash collection queries (performance optimization)
userSchema.index({ 
  awaitingCashCollection: 1, 
  currentTripId: 1,
  lastTripCompletedAt: 1
});

// ✅ Index for finding drivers with stale cash collection (monitoring)
userSchema.index({
  awaitingCashCollection: 1,
  lastTripCompletedAt: 1
});

// ✅ Prevent OverwriteModelError in dev
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;