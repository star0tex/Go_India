// scripts/createIndexes.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const createIndexes = async () => {
  try {
    console.log('📊 Creating production indexes...');
    await mongoose.connect(process.env.MONGO_URI);
    
    const db = mongoose.connection.db;
    
    // User indexes for driver queries
    await db.collection('users').createIndex(
      { 
        isDriver: 1, 
        vehicleType: 1, 
        isOnline: 1, 
        currentTripId: 1,
        location: '2dsphere' 
      },
      { name: 'driver_availability_geo' }
    );
    
    console.log('✅ Created driver_availability_geo index');
    
    // Trip indexes for status queries
    await db.collection('trips').createIndex(
      { status: 1, expiresAt: 1 },
      { name: 'trip_status_expiry' }
    );
    
    console.log('✅ Created trip_status_expiry index');
    
    // Trip heartbeat index
    await db.collection('trips').createIndex(
      { status: 1, lastDriverHeartbeat: 1, acceptedAt: 1 },
      { name: 'trip_heartbeat_check' }
    );
    
    console.log('✅ Created trip_heartbeat_check index');
    
    // Notification retry index
    await db.collection('trips').createIndex(
      { 
        status: 1, 
        customerNotified: 1, 
        notificationRetries: 1, 
        lastNotificationAttempt: 1 
      },
      { name: 'notification_retry' }
    );
    
    console.log('✅ Created notification_retry index');
    
    // List all indexes
    const userIndexes = await db.collection('users').indexes();
    const tripIndexes = await db.collection('trips').indexes();
    
    console.log('');
    console.log('📊 User Collection Indexes:', userIndexes.length);
    userIndexes.forEach(idx => console.log(`   - ${idx.name}`));
    
    console.log('');
    console.log('📊 Trip Collection Indexes:', tripIndexes.length);
    tripIndexes.forEach(idx => console.log(`   - ${idx.name}`));
    
    console.log('');
    console.log('✅ All indexes created successfully!');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Index creation failed:', err);
    process.exit(1);
  }
};

createIndexes();