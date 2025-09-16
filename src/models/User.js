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
    },
    vehicleType: {
      type: String,
      enum: ["bike", "auto", "car", "premium", "xl"],
      default: null,
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
    },

    // ✅ Verification & Profile
    profilePhotoUrl: {
      type: String,
    },
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
    sparse: true // Allows null values but ensures uniqueness for non-null values
  },

    // 🔔 Notifications
    fcmToken: {
      type: String,
    },
  },
  { timestamps: true }
);
userSchema.index({ location: '2dsphere' });

// ✅ Prevent OverwriteModelError in dev
const User = mongoose.models.User || mongoose.model("User", userSchema);
export default User;
