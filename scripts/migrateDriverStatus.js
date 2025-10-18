import mongoose from 'mongoose';
import User from '../models/User.js';

const migrateDriverStatus = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    
    console.log('🔄 Starting driver status migration...');
    
    // Update all drivers who don't have the new fields
    const result = await User.updateMany(
      { 
        isDriver: true,
        $or: [
          { currentTripId: { $exists: false } },
          { isBusy: { $exists: false } },
          { canReceiveNewRequests: { $exists: false } }
        ]
      },
      { 
        $set: { 
          currentTripId: null,
          isBusy: false,
          canReceiveNewRequests: false
        } 
      }
    );
    
    console.log(`✅ Migrated ${result.modifiedCount} drivers`);
    console.log('✅ All drivers now have proper availability fields');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
};

migrateDriverStatus();