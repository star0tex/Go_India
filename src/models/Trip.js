// src/models/Trip.js
import mongoose from 'mongoose';

const tripSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 10000),  // 10 seconds from creation
    index: true,
  },
  assignedDriver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  standbyDrivers: [
    {
      driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      status: {
        type: String,
        enum: ['pending', 'promoted', 'rejected'],
        default: 'pending',
      },
    },
  ],
  status: {
    type: String,
    enum: [
      'requested',
      'driver_assigned',
      'driver_going_to_pickup',
      'driver_at_pickup',
      'ride_started',
      'in_progress',
      'completed',
      'cancelled',
      'timeout',
    ],
    default: 'requested',
  },
  type: {
    type: String,
    enum: ['short', 'parcel', 'long'],
    required: true,
  },
  
  // ✅ FIXED: Make vehicleType conditionally required
  vehicleType: {
    type: String,
    required: function() {
      // Only required if status is not cancelled or timeout
      return !['cancelled', 'timeout'].includes(this.status);
    }
  },

  // Canonical GeoJSON fields used across controllers
  pickup: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number], // [lng, lat]
      required: true,
    },
    address: String,
  },
  drop: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number], // [lng, lat]
      required: true,
    },
    address: String,
  },

  // Legacy/compat fields (optional)
  pickupLocation: {
    lat: Number,
    lng: Number,
    address: String,
  },
  dropLocation: {
    lat: Number,
    lng: Number,
    address: String,
  },

  distance: Number, // in km
  duration: Number, // in mins
  tripTime: Date, // for scheduled trips (long)
  
  // ✅ FIXED: Make fare conditionally required
  fare: {
    type: Number,
    required: function() {
      // Only required if status is not cancelled or timeout
      return !['cancelled', 'timeout'].includes(this.status);
    },
    min: 0,
  },
  estimatedFare: {
    type: Number,
    min: 0,
  },
  finalFare: {
    type: Number,
    default: null,
    min: 0,
  },

  otp: {
    type: String,
    default: null,
  },
  
  rideStatus: {
    type: String,
    enum: [
      'driver_assigned',
      'going_to_pickup',
      'arrived_at_pickup',
      'ride_started',
      'going_to_drop',
      'arrived_at_drop',
      'completed',
    ],
    default: 'driver_assigned',
  },
  
  startTime: {
    type: Date,
    default: null,
  },
  endTime: {
    type: Date,
    default: null,
  },
  completedAt: {
    type: Date,
    default: null,
  },
  
  acceptedAt: {
    type: Date,
    default: null,
  },
  rideStartTime: {
    type: Date,
    default: null,
  },
  rideEndTime: {
    type: Date,
    default: null,
  },
  
  // Payment fields
  paymentCollected: {
    type: Boolean,
    default: false,
  },
  paymentCollectedAt: {
  type: Date,
  default: null
},
  paymentMethod: {
    type: String,
    enum: ['Cash', 'Online', 'Wallet'],
    default: 'Cash',
  },
  
  // Parcel fields (for parcel trips)
  parcelDetails: {
    weight: String,
    dimensions: String,
    description: String,
  },
  
  // Long trip fields
  isSameDay: {
    type: Boolean,
    default: false,
  },
  returnTrip: {
    type: Boolean,
    default: false,
  },
  tripDays: {
    type: Number,
    min: 1,
  },
  
  // ✅ ADD cancellation timestamp
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  cancelledAt: {
    type: Date,
    default: null,
  },
  
  // Notification tracking (for retry system)
  customerNotified: {
    type: Boolean,
    default: false,
  },
  notificationRetries: {
    type: Number,
    default: 0,
  },
  lastNotificationAttempt: {
    type: Date,
    default: null,
  },
  
  // Driver heartbeat tracking (crash detection)
  lastDriverHeartbeat: {
    type: Date,
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
});

// ✅ ADD: Pre-save hook to handle cancellation gracefully
tripSchema.pre('save', function(next) {
  // If trip is being cancelled, don't validate fare and vehicleType
  if (this.isModified('status') && ['cancelled', 'timeout'].includes(this.status)) {
    // Mark these fields as not requiring validation
    this.$__.skipValidation = this.$__.skipValidation || {};
    this.$__.skipValidation.fare = true;
    this.$__.skipValidation.vehicleType = true;
  }
  next();
});

// Ensure geospatial indexes
tripSchema.index({ 'pickup.coordinates': '2dsphere' });
tripSchema.index({ 'drop.coordinates': '2dsphere' });

// Add indexes for faster queries
tripSchema.index({ status: 1 });
tripSchema.index({ customerId: 1 });
tripSchema.index({ assignedDriver: 1 });
tripSchema.index({ customerId: 1, status: 1 });
tripSchema.index({ assignedDriver: 1, status: 1 });
tripSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Trip', tripSchema);