// src/models/Trip.js
import mongoose from 'mongoose';

const tripSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
  
  // ✅ ADD vehicleType field
  vehicleType: {
    type: String,
    required: true,
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
  
  // ✅ ADD FARE FIELDS
  fare: {
    type: Number,
    required: true,
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
  
  // ✅ ADD TIMESTAMPS
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
  
  // ✅ ADD PAYMENT FIELDS
  paymentCollected: {
    type: Boolean,
    default: false,
  },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'Online', 'Wallet'],
    default: 'Cash',
  },
  
  // ✅ ADD PARCEL FIELDS (for parcel trips)
  parcelDetails: {
    weight: String,
    dimensions: String,
    description: String,
  },
  
  // ✅ ADD LONG TRIP FIELDS
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
  
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
});

// Ensure geospatial indexes
tripSchema.index({ 'pickup.coordinates': '2dsphere' });
tripSchema.index({ 'drop.coordinates': '2dsphere' });

// Add index for status queries
tripSchema.index({ status: 1 });
tripSchema.index({ customerId: 1 });
tripSchema.index({ assignedDriver: 1 });

export default mongoose.model('Trip', tripSchema);