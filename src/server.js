// src/server.js
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { cleanupStuckDrivers } from './jobs/driverCleanup.js';
import User from './models/User.js'
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import connectDB from './config/db.js';
import { Server } from "socket.io";
import userRoutes from './routes/userRoutes.js';
import authRoutes from './routes/authRoutes.js';
import driverRoutes from './routes/driverRoutes.js';
import fareRoutes from './routes/fareRoutes.js';
import parcelRoutes from './routes/parcelRoutes.js';
import rateRoutes from './routes/rateRoutes.js';
import locationRoutes from './routes/locationRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import tripRoutes from './routes/tripRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import chatRoutes from './routes/chatRoutes.js'; // 📨 NEW: Import chat routes
import rideHistoryRoutes from './routes/rideHistory.js';
import driverRideHistoryRoutes from './routes/driverRideHistory.js';

import standbyReassignCron from './cron/standbyReassignCron.js';
import { initSocket } from './socket/socketHandler.js';

dotenv.config();
await connectDB();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// middleware to attach io in every request
app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

app.get('/', (_req, res) => {
  res.send('🌐 Go India backend live 🚀');
});
initSocket(io);

// ✅ API Routes
app.use('/api/user', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/fares', fareRoutes);
app.use('/api/parcels', parcelRoutes);
app.use('/api/rates', rateRoutes);
app.use('/api', rideHistoryRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trip', tripRoutes);
app.use('/api', healthRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/chat', chatRoutes); // 📨 NEW: Add chat routes
app.use(rideHistoryRoutes);
app.use('/api/driver', driverRideHistoryRoutes);

// ✅ Start Cron (every 2 minutes)
setInterval(() => {
  standbyReassignCron().catch((err) =>
    console.error('❌ Unhandled cron error:', err)
  );
}, 2 * 60 * 1000);

// ✅ 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: '🔍 Route not found' });
});

// ✅ Error Handler
app.use((err, req, res, _next) => {
  console.error('❌ Server error:', err);
  res.status(err.status || 500).json({
    message: err.message || '🚨 Internal Server Error',
  });
});

// Cleanup stuck drivers every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    console.log('🔍 Running driver availability cleanup...');
    
    // Find drivers who are marked busy but have no active trip
    const stuckDrivers = await User.find({
      isDriver: true,
      isBusy: true,
      $or: [
        { currentTripId: null },
        { currentTripId: { $exists: false } }
      ]
    });
    
    if (stuckDrivers.length > 0) {
      console.log(`⚠️ Found ${stuckDrivers.length} drivers stuck in busy state`);
      
      for (const driver of stuckDrivers) {
        // Check if they have any active trips
        const activeTrip = await Trip.findOne({
          assignedDriver: driver._id,
          status: { $in: ['driver_assigned', 'ride_started'] }
        });
        
        if (!activeTrip) {
          // Safe to reset
          await User.findByIdAndUpdate(driver._id, {
            $set: {
              isBusy: false,
              currentTripId: null,
              canReceiveNewRequests: false
            }
          });
          console.log(`✅ Reset stuck driver: ${driver.name} (${driver._id})`);
        }
      }
    } else {
      console.log('✅ All drivers have correct availability status');
    }
    
  } catch (error) {
    console.error('❌ Cleanup job error:', error);
  }
});

cron.schedule('*/5 * * * *', cleanupStuckDrivers);

// ✅ Start Server
const PORT = process.env.PORT || 5002;
httpServer.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(70));
  console.log(`🚀 Go India server running on port ${PORT}`);
  console.log('');
  console.log('📨 Chat system enabled');
  console.log('   - WebSocket: Active');
  console.log('   - REST API: /api/chat/*');
  console.log('='.repeat(70));
  console.log('');
});

export { io, httpServer };