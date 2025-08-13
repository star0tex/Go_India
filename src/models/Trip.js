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
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Ensure geospatial indexes
tripSchema.index({ 'pickup.coordinates': '2dsphere' });
tripSchema.index({ 'drop.coordinates': '2dsphere' });

export default mongoose.model('Trip', tripSchema);
